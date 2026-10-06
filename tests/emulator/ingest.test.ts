/**
 * ingestEmailJobs against the Firestore emulator with the real stores (ADR-046, ADR-047,
 * ADR-048). Run with `npm run test:rules`. Proves: a replayed signed request is refused and
 * writes nothing; the R5 acceptance case through the real email path in both orders; the
 * description upgrade on merge in both orders; the lock's holder, staleAt and cooldown rules;
 * and that what is stored parses against the shared schemas.
 */
import {
  AlertMessageSchema,
  AlertParseOutputSchema,
  COLLECTIONS,
  DOCS,
  extractLinks,
  JobDescriptionSchema,
  JobSchema,
  modelAlertJobs,
  PATHS,
  ScanLockSchema,
  SourceHealthSchema,
  type IngestMessage,
} from '@hireframe/shared';
import { deleteApp, initializeApp, type App } from 'firebase-admin/app';
import { getFirestore, type Firestore } from 'firebase-admin/firestore';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  LINKEDIN_ALERT,
  LINKEDIN_ALERT_FORWARDED,
  WAAS_ALERT,
  WAAS_MODEL_ANSWER,
} from '../../packages/shared/src/fixtures/alerts.js';
import { ALERT_LINK_HOSTS, FUNNEL, SHORT_LOCK } from '../../functions/src/config.js';
import { ingestHandler, type IngestHandlerDeps } from '../../functions/src/ingest/handler.js';
import { signRequest, type SignedRequest } from '../../functions/src/ingest/hmac.js';
import { firestoreNonceStore } from '../../functions/src/ingest/nonces.js';
import { runIngest } from '../../functions/src/ingest/run.js';
import { firestoreIngestStore } from '../../functions/src/ingest/store.js';
import { runScan, type ScanDeps } from '../../functions/src/scan/run.js';
import { firestoreScanStore } from '../../functions/src/scan/store.js';
import { FAKE_SEED } from '../../functions/src/sources/fixtures.js';
import { createSources } from '../../functions/src/sources/index.js';
import { testHttpClient } from '../../functions/src/sources/testing.js';
import { timestampsToDates } from '../../functions/src/timestamps.js';

const T0 = new Date('2026-10-07T08:00:00Z');
const SECRET = 'e2e00000'.repeat(8);

let app: App;
let db: Firestore;

beforeAll(() => {
  if (!process.env.FIRESTORE_EMULATOR_HOST) throw new Error('Run with `npm run test:rules`.');
  app = initializeApp({ projectId: 'demo-hireframe' }, 'ingest-test');
  db = getFirestore(app);
});

afterAll(async () => {
  await deleteApp(app);
});

beforeEach(async () => {
  for (const path of ['jobs', 'runs', 'sources', 'companies', 'locks', 'nonces', 'alertMessages']) {
    await db.recursiveDelete(db.collection(path));
  }
});

const minutes = (n: number) => new Date(T0.getTime() + n * 60_000);

const message = (
  id: string,
  fixture: { from: string; text: string; html: string },
): IngestMessage => ({ id, receivedAt: T0.toISOString(), ...fixture });

function ingestDeps(now: Date) {
  const store = firestoreIngestStore(db);
  return {
    store,
    parseWithModel: (m: IngestMessage) =>
      Promise.resolve(
        modelAlertJobs(
          AlertParseOutputSchema.parse(WAAS_MODEL_ANSWER),
          extractLinks(m.html),
          ALERT_LINK_HOSTS,
        ),
      ),
    now: () => now,
    clock: () => now.getTime(),
  };
}

function scanDeps(now: Date, overrides: Partial<ScanDeps> = {}): ScanDeps {
  return {
    store: firestoreScanStore(db),
    readCriteria: () => Promise.resolve(null),
    createSources,
    httpFor: () => testHttpClient(),
    secrets: { reedApiKey: 'fake', adzunaAppId: 'fake', adzunaAppKey: 'fake' },
    seed: FAKE_SEED,
    disabledSources: [],
    cooldownMs: 5 * 60_000,
    trigger: 'manual',
    now: () => now,
    ...overrides,
  };
}

async function allJobs() {
  const snapshot = await db.collection(COLLECTIONS.jobs).get();
  return snapshot.docs.map((doc) => ({
    id: doc.id,
    job: JobSchema.parse(timestampsToDates(doc.data())),
  }));
}

const acmeJobs = async () =>
  (await allJobs()).filter(
    ({ job }) => job.company.startsWith('Acme') && job.title === 'Product Analyst',
  );

describe('replay protection (ADR-046)', () => {
  const body = JSON.stringify({ messages: [message('replay-1', LINKEDIN_ALERT)] });

  function signed(options: { nonce: string; offsetSeconds?: number }): SignedRequest {
    const timestamp = String(Math.floor(T0.getTime() / 1000) + (options.offsetSeconds ?? 0));
    const headers: Record<string, string> = {
      'x-hireframe-timestamp': timestamp,
      'x-hireframe-nonce': options.nonce,
      'x-hireframe-signature': signRequest(SECRET, timestamp, options.nonce, body),
    };
    return {
      method: 'POST',
      contentType: 'application/json',
      rawBody: Buffer.from(body),
      header: (name) => headers[name],
    };
  }

  const handlerDeps = (): IngestHandlerDeps => ({
    secret: SECRET,
    nonces: firestoreNonceStore(db),
    now: () => T0,
    run: (messages) => runIngest(ingestDeps(T0), messages),
  });

  it('the same signed request twice: the second is 401 and writes nothing', async () => {
    const request = signed({ nonce: '3b241101-e2bb-4255-8caf-4136c566a962' });
    const first = await ingestHandler(request, handlerDeps());
    expect(first.status).toBe(200);
    const jobs = await allJobs();
    const stamp = (await db.collection(COLLECTIONS.alertMessages).get()).docs.map((d) =>
      d.updateTime.toMillis(),
    );

    const second = await ingestHandler(request, handlerDeps());
    expect(second).toEqual({ status: 401, body: { error: 'unauthorized' } });
    expect(await allJobs()).toEqual(jobs);
    expect(
      (await db.collection(COLLECTIONS.alertMessages).get()).docs.map((d) =>
        d.updateTime.toMillis(),
      ),
    ).toEqual(stamp);

    const stored = (await db.doc(PATHS.nonce('3b241101-e2bb-4255-8caf-4136c566a962')).get()).data();
    expect(timestampsToDates(stored)).toEqual({
      expireAt: new Date(T0.getTime() + 600_000),
      schemaVersion: 1,
    });
  });

  it('a fresh nonce on the same body passes (and finds the message already handled)', async () => {
    expect(
      (
        await ingestHandler(
          signed({ nonce: '3b241101-e2bb-4255-8caf-4136c566a962' }),
          handlerDeps(),
        )
      ).status,
    ).toBe(200);
    const again = await ingestHandler(
      signed({ nonce: '4c352212-f3cc-4366-9dbf-5247d677ba73' }),
      handlerDeps(),
    );
    expect(again).toEqual({
      status: 200,
      body: { results: [{ id: 'replay-1', status: 'duplicate' }] },
    });
  });

  it('an old timestamp with a new nonce fails on skew and claims no nonce', async () => {
    const stale = signed({ nonce: '5d463323-04dd-4477-8eac-6358e788cb84', offsetSeconds: -301 });
    expect(await ingestHandler(stale, handlerDeps())).toEqual({
      status: 401,
      body: { error: 'unauthorized' },
    });
    expect((await db.collection(COLLECTIONS.nonces).get()).size).toBe(0);
    expect(await allJobs()).toEqual([]);
  });
});

describe('R5: an alert and an ATS posting of the same role are one job (PRD R5)', () => {
  it('alert first, then a scan', async () => {
    await runIngest(ingestDeps(T0), [message('alert-1', LINKEDIN_ALERT)]);
    expect((await acmeJobs()).length).toBe(1);
    await runScan(scanDeps(minutes(10)));
    const acme = await acmeJobs();
    expect(acme).toHaveLength(1);
    expect(acme[0]?.job.sources.map((s) => s.id)).toEqual(
      expect.arrayContaining(['linkedin-alert', 'greenhouse']),
    );
    expect(acme[0]?.job.keys).toEqual(
      expect.arrayContaining(['linkedin:4012345678', 'greenhouse:5551234']),
    );
  });

  it('scan first, then the alert', async () => {
    await runScan(scanDeps(T0));
    const before = await acmeJobs();
    expect(before).toHaveLength(1);
    await runIngest(ingestDeps(minutes(10)), [message('alert-1', LINKEDIN_ALERT)]);
    const acme = await acmeJobs();
    expect(acme).toHaveLength(1);
    expect(acme[0]?.id).toBe(before[0]?.id);
    expect(acme[0]?.job.sources.map((s) => s.id)).toContain('linkedin-alert');
    expect(acme[0]?.job.keys).toContain('linkedin:4012345678');
    // The ATS job already has full text: it never enters the needs-description state.
    expect(acme[0]?.job.descriptionKind).toBe('full');
    expect(acme[0]?.job.next).toBeUndefined();
  });

  it('the auto-forwarded copy under another Gmail ID adds nothing', async () => {
    await runIngest(ingestDeps(T0), [message('direct', LINKEDIN_ALERT)]);
    const count = (await allJobs()).length;
    await runIngest(ingestDeps(minutes(1)), [message('forwarded', LINKEDIN_ALERT_FORWARDED)]);
    expect((await allJobs()).length).toBe(count);
    const sources = (await allJobs()).map(({ job }) => job.sources.length);
    expect(sources.every((n) => n === 1)).toBe(true);
  });
});

describe('the description upgrade on merge (ADR-048)', () => {
  it('alert first: a job waiting for a description gets the ATS text, its date, and goes to S3', async () => {
    await runIngest(ingestDeps(T0), [message('alert-1', LINKEDIN_ALERT)]);
    const [acme] = await acmeJobs();
    if (!acme) throw new Error('no job');
    expect(acme.job.descriptionKind).toBe('none');
    expect(acme.job.postedAt).toBeUndefined();
    // What S3 does to it (the funnel is tested elsewhere): it waits for a description.
    await db.doc(PATHS.job(acme.id)).update({
      stage: 's2',
      next: 'description',
      flags: ['needs_description', 'freshness_unknown'],
    });

    await runScan(scanDeps(minutes(10)));
    const after = JobSchema.parse(
      timestampsToDates((await db.doc(PATHS.job(acme.id)).get()).data()),
    );
    expect(after.descriptionKind).toBe('full');
    expect(after.next).toBe('s3');
    expect(after.postedAt).toBeDefined();
    expect(after.flags).toEqual(['freshness_unknown']);
    const description = JobDescriptionSchema.parse(
      timestampsToDates((await db.doc(PATHS.jobDescription(acme.id)).get()).data()),
    );
    expect(description).toMatchObject({ kind: 'full', sourceId: 'greenhouse' });
    expect(description.text.length).toBeGreaterThanOrEqual(FUNNEL.minDeepReadChars);
  });

  it.each([
    { snippetChars: 5_000, upgraded: false },
    { snippetChars: 60, upgraded: true },
  ])(
    'a snippet-only job with $snippetChars stored characters: upgraded is $upgraded',
    async ({ snippetChars, upgraded }) => {
      await runIngest(ingestDeps(T0), [message('alert-1', LINKEDIN_ALERT)]);
      const [acme] = await acmeJobs();
      if (!acme) throw new Error('no job');
      await db.doc(PATHS.job(acme.id)).update({ descriptionKind: 'snippet', stage: 's2' });
      await db.doc(PATHS.jobDescription(acme.id)).set({
        text: 'x'.repeat(snippetChars),
        kind: 'snippet',
        sourceId: 'adzuna',
        fetchedAt: T0,
        schemaVersion: 1,
      });

      await runScan(scanDeps(minutes(10)));
      const after = JobSchema.parse(
        timestampsToDates((await db.doc(PATHS.job(acme.id)).get()).data()),
      );
      const description = JobDescriptionSchema.parse(
        timestampsToDates((await db.doc(PATHS.jobDescription(acme.id)).get()).data()),
      );
      expect(after.descriptionKind).toBe(upgraded ? 'full' : 'snippet');
      expect(description.text.length === snippetChars).toBe(!upgraded);
    },
  );

  it('keeps a job waiting when only a snippet-only source merges in', async () => {
    await runIngest(ingestDeps(T0), [message('alert-1', LINKEDIN_ALERT)]);
    const [acme] = await acmeJobs();
    if (!acme) throw new Error('no job');
    await db.doc(PATHS.job(acme.id)).update({ stage: 's2', next: 'description' });
    // Only Adzuna (a snippet) is left to merge in: no full text arrives.
    await runScan(
      scanDeps(minutes(10), {
        disabledSources: ['greenhouse', 'lever', 'ashby', 'workable', 'reed', 'hn'],
      }),
    );
    const after = JobSchema.parse(
      timestampsToDates((await db.doc(PATHS.job(acme.id)).get()).data()),
    );
    expect(after.next).toBe('description');
    expect(after.descriptionKind).toBe('none');
  });
});

describe('the lock (ADR-048)', () => {
  it('holds it as email with a 3 minute staleAt, and releases it without starting the scan cooldown', async () => {
    const finished = minutes(-30);
    await db.doc(DOCS.scanLock).set({ lastFinishedAt: finished, schemaVersion: 1 });
    const deps = ingestDeps(T0);
    let during: unknown;
    const original = deps.store.findJobsByKeys;
    deps.store.findJobsByKeys = async (keys) => {
      during = timestampsToDates((await db.doc(DOCS.scanLock).get()).data());
      return original(keys);
    };
    await runIngest(deps, [message('alert-1', LINKEDIN_ALERT)]);
    expect(during).toMatchObject({
      holder: 'email',
      startedAt: T0,
      staleAt: new Date(T0.getTime() + SHORT_LOCK.emailStaleMs),
      lastFinishedAt: finished,
    });
    const after = ScanLockSchema.parse(
      timestampsToDates((await db.doc(DOCS.scanLock).get()).data()),
    );
    expect(after).toEqual({ lastFinishedAt: finished, schemaVersion: 1 });
    // A manual scan right after an ingest is not in a cooldown: only a scan's finish starts one.
    expect((await runScan(scanDeps(minutes(1)))).status).toBe('completed');
  });

  it('refuses an ingest while a scan holds the lock, and parses nothing', async () => {
    await db.doc(DOCS.scanLock).set({
      runId: 'running-scan',
      startedAt: T0,
      holder: 'scan',
      staleAt: minutes(12),
      schemaVersion: 1,
    });
    const result = await runIngest(ingestDeps(minutes(1)), [message('a', LINKEDIN_ALERT)]);
    expect(result).toEqual({ status: 'busy', holder: 'scan' });
    expect(await allJobs()).toEqual([]);
    expect((await db.collection(COLLECTIONS.alertMessages).get()).size).toBe(0);
  });

  it('a killed ingest blocks a scan for 3 minutes, not 12', async () => {
    await db.doc(DOCS.scanLock).set({
      runId: 'dead-ingest',
      startedAt: T0,
      holder: 'email',
      staleAt: new Date(T0.getTime() + SHORT_LOCK.emailStaleMs),
      schemaVersion: 1,
    });
    await expect(runScan(scanDeps(minutes(2)))).resolves.toEqual({
      status: 'busy',
      holder: 'email',
    });
    expect((await runScan(scanDeps(minutes(4)))).status).toBe('completed');
  });

  it('an old lock with no holder or staleAt still blocks for the scan’s 12 minutes', async () => {
    await db.doc(DOCS.scanLock).set({ runId: 'old', startedAt: T0, schemaVersion: 1 });
    await expect(
      runIngest(ingestDeps(minutes(11)), [message('a', LINKEDIN_ALERT)]),
    ).resolves.toEqual({
      status: 'busy',
      holder: 'scan',
    });
    expect((await runIngest(ingestDeps(minutes(13)), [message('a', LINKEDIN_ALERT)])).status).toBe(
      'done',
    );
  });
});

describe('what is stored', () => {
  it('parses against the shared schemas: message records, email health, the TTL fields', async () => {
    await runIngest(ingestDeps(T0), [
      message('alert-1', LINKEDIN_ALERT),
      message('waas-1', WAAS_ALERT),
    ]);
    const records = await db.collection(COLLECTIONS.alertMessages).get();
    expect(records.size).toBe(2);
    for (const doc of records.docs) {
      const record = AlertMessageSchema.parse(timestampsToDates(doc.data()));
      expect(record.expireAt.getTime() - record.at.getTime()).toBe(30 * 24 * 3600 * 1000);
      expect(JSON.stringify(record)).not.toMatch(/linkedin\.com\/|jobs@|Product Analyst/);
    }
    const health = SourceHealthSchema.parse(
      timestampsToDates((await db.doc(PATHS.source('email')).get()).data()),
    );
    expect(health).toMatchObject({
      status: 'ok',
      lastCounts: { requests: 2, fetched: 8, new: 8, invalid: 0 },
      bySender: {
        'linkedin.com': { messages: 1, jobs: 5 },
        'example.com': { messages: 1, jobs: 3, unverifiedLinks: 1 },
      },
    });
    for (const { job } of await allJobs()) expect(job.stage).toBe('s0');
  });
});
