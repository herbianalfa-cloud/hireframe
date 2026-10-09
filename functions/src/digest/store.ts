import {
  DEFAULT_MONTHLY_CAP_PENCE,
  PATHS,
  RunSchema,
  SourceHealthSchema,
  UsageSchema,
  digestJobsSpec,
  digestRunsSpec,
  digestSourcesSpec,
  digestWaitingSpec,
  monthKey,
  type DigestVerdict,
  type QuerySpec,
} from '@hireframe/shared';
import type { Firestore, Query } from 'firebase-admin/firestore';
import { z } from 'zod';

import { DIGEST } from '../config.js';
import { log } from '../log.js';
import { timestampsToDates } from '../timestamps.js';
import type { DigestJobList, DigestSourceLine } from './render.js';
import type { DigestRun } from './state.js';

/**
 * The digest's Firestore reads (ADR-052). Reads only: nothing here writes. Every query is a
 * shared spec, so `indexes.test.ts` checks it against `firestore.indexes.json`. Invalid documents
 * are skipped and logged as a count; no job text reaches a log.
 */

export type StoredDigestRun = DigestRun & z.infer<typeof RunSchema>;

export interface DigestStore {
  /** The newest runs, newest first. */
  recentRuns(): Promise<StoredDigestRun[]>;
  /** Open jobs of a verdict judged since `since`, newest judged first. */
  jobsSince(verdict: DigestVerdict, since: Date): Promise<DigestJobList>;
  usage(now: Date): Promise<{ spendPence: number; capPence: number }>;
  sources(): Promise<DigestSourceLine[]>;
  waitingForDescription(): Promise<number>;
}

const JOB_FIELDS = ['title', 'company', 'fitScore', 'luckScore', 'reason', 'shortfall'] as const;

const DigestJobDocSchema = z.object({
  title: z.string().min(1),
  company: z.string(),
  fitScore: z.number().exactOptional(),
  luckScore: z.number().exactOptional(),
  reason: z.string().exactOptional(),
  shortfall: z.string().exactOptional(),
});

function toQuery(db: Firestore, spec: QuerySpec): Query {
  let query: Query = db.collection(spec.collection);
  for (const filter of spec.filters) {
    query = query.where(filter.field, filter.op, filter.value);
  }
  for (const order of spec.orderBy) query = query.orderBy(order.field, order.direction);
  return query;
}

export function firestoreDigestStore(db: Firestore): DigestStore {
  return {
    async recentRuns() {
      const snapshot = await toQuery(db, digestRunsSpec).limit(DIGEST.runsRead).get();
      const runs: StoredDigestRun[] = [];
      let invalid = 0;
      for (const doc of snapshot.docs) {
        const parsed = RunSchema.safeParse(timestampsToDates(doc.data()));
        if (parsed.success) runs.push({ ...parsed.data, id: doc.id });
        else invalid += 1;
      }
      if (invalid > 0) log.warn('store.invalid_doc', { collection: 'runs', count: invalid });
      return runs;
    },

    async jobsSince(verdict, since) {
      const query = toQuery(db, digestJobsSpec(verdict, since));
      const snapshot = await query
        .select(...JOB_FIELDS)
        .limit(DIGEST.jobsPerVerdict + 1)
        .get();
      const jobs: DigestJobList['jobs'][number][] = [];
      let invalid = 0;
      for (const doc of snapshot.docs.slice(0, DIGEST.jobsPerVerdict)) {
        const parsed = DigestJobDocSchema.safeParse(doc.data());
        if (parsed.success) jobs.push({ ...parsed.data, id: doc.id });
        else invalid += 1;
      }
      if (invalid > 0) log.warn('store.invalid_doc', { collection: 'jobs', count: invalid });
      let total = snapshot.size;
      // An eleventh row means there are more: count them exactly (the same spec, no limit).
      if (snapshot.size > DIGEST.jobsPerVerdict) {
        total = (await query.count().get()).data().count;
      }
      return { jobs, total };
    },

    async usage(now) {
      const snapshot = await db.doc(PATHS.usage(monthKey(now))).get();
      const parsed = snapshot.exists
        ? UsageSchema.safeParse(timestampsToDates(snapshot.data()))
        : undefined;
      if (parsed?.success) {
        return { spendPence: parsed.data.spendPence, capPence: parsed.data.capPence };
      }
      if (parsed) log.warn('store.invalid_doc', { collection: 'usage', count: 1 });
      return { spendPence: 0, capPence: DEFAULT_MONTHLY_CAP_PENCE };
    },

    async sources() {
      const snapshot = await toQuery(db, digestSourcesSpec).limit(30).get();
      const lines: DigestSourceLine[] = [];
      let invalid = 0;
      for (const doc of snapshot.docs) {
        const parsed = SourceHealthSchema.safeParse(timestampsToDates(doc.data()));
        if (!parsed.success) {
          invalid += 1;
          continue;
        }
        lines.push({
          id: doc.id,
          status: parsed.data.status,
          ...(parsed.data.lastErrorCode === undefined
            ? {}
            : { errorCode: parsed.data.lastErrorCode }),
        });
      }
      if (invalid > 0) log.warn('store.invalid_doc', { collection: 'sources', count: invalid });
      return lines;
    },

    async waitingForDescription() {
      const count = await toQuery(db, digestWaitingSpec).count().get();
      return count.data().count;
    },
  };
}
