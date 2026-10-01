import { htmlToText, tidyText } from './html.js';
import {
  JOB_LIMITS,
  type Country,
  type DescriptionKind,
  type Job,
  type JobDescription,
  type JobSourceId,
  type JobSourceRef,
  type RawJob,
  type RemoteMode,
  type S0Counts,
  type Salary,
} from './jobs.js';
import {
  canonicalUrl,
  keysFromUrl,
  normaliseCompany,
  normaliseTitle,
  parseLocation,
  sourceKey,
} from './normalise.js';

/**
 * S0 dedupe (PRD R5, ADR-030), pure. A job carries `keys[]`: its dedupe key
 * (`d:` + hash of company|title|city), every source key, and keys derived from job URLs.
 * Jobs that share any key are the same job.
 */

export interface NormalisedJob {
  sourceId: JobSourceId;
  externalId: string;
  sourceKey: string;
  url: string;
  title: string;
  company: string;
  companyId?: string;
  location: string;
  city: string;
  country: Country;
  remote: RemoteMode;
  postedAt?: Date;
  salary?: Salary;
  description: { kind: DescriptionKind; text: string };
  /** `d:` key, or null when the company or title has no comparison form. */
  dedupeKey: string | null;
  /** Every key, deduplicated and sorted. */
  keys: string[];
}

/** 64-bit FNV-1a over UTF-8, as 16 hex digits. Synchronous, so dedupe stays pure. */
export function fnv1a64(text: string): string {
  let hash = 0xcbf29ce484222325n;
  for (const byte of new TextEncoder().encode(text)) {
    hash ^= BigInt(byte);
    hash = (hash * 0x100000001b3n) & 0xffffffffffffffffn;
  }
  return hash.toString(16).padStart(16, '0');
}

export function dedupeKey(company: string, title: string, city: string): string | null {
  const normCompany = normaliseCompany(company);
  const normTitle = normaliseTitle(title);
  if (!normCompany || !normTitle) return null;
  return `d:${fnv1a64(`${normCompany}|${normTitle}|${city}`)}`;
}

/** RawJob → comparison-ready job. Null when its URL isn't a usable http(s) URL. */
export function normaliseRawJob(raw: RawJob): NormalisedJob | null {
  const url = canonicalUrl(raw.url);
  if (!url) return null;
  const location = parseLocation(raw.locationText, raw.remoteHint);
  const ownKey = sourceKey(raw.sourceId, raw.externalId);
  const key = dedupeKey(raw.company, raw.title, location.city);
  const keys = new Set([ownKey, ...keysFromUrl(url)]);
  for (const extra of raw.extraUrls ?? []) for (const k of keysFromUrl(extra)) keys.add(k);
  if (key) keys.add(key);
  const text =
    raw.description.format === 'html'
      ? htmlToText(raw.description.body)
      : tidyText(raw.description.body);
  return {
    sourceId: raw.sourceId,
    externalId: raw.externalId,
    sourceKey: ownKey,
    url,
    title: raw.title.trim(),
    company: raw.company.trim(),
    ...(raw.companyId ? { companyId: raw.companyId } : {}),
    location: raw.locationText.trim(),
    ...location,
    ...(raw.postedAt ? { postedAt: raw.postedAt } : {}),
    ...(raw.salary ? { salary: raw.salary } : {}),
    description: { kind: raw.description.kind, text },
    dedupeKey: key,
    keys: [...keys].sort(),
  };
}

/** Which member's title, link and text a merged job shows: ATS boards first (full text). */
const SOURCE_PRIORITY: readonly JobSourceId[] = [
  'greenhouse',
  'lever',
  'ashby',
  'workable',
  'reed',
  'linkedin-alert',
  'adzuna',
  'hn',
];

function rank(job: NormalisedJob): number {
  return (job.description.kind === 'full' ? 0 : 100) + SOURCE_PRIORITY.indexOf(job.sourceId);
}

export interface BatchGroup {
  /** The primary member first, then the rest in input order. */
  jobs: NormalisedJob[];
  keys: string[];
}

/** Collapses one run's jobs: any shared key joins two jobs (union-find over keys). */
export function dedupeBatch(jobs: readonly NormalisedJob[]): BatchGroup[] {
  const parent = jobs.map((_, index) => index);
  const find = (index: number): number => {
    let root = index;
    while (parent[root] !== root) root = parent[root] ?? root;
    let node = index;
    while (parent[node] !== root) {
      const next = parent[node] ?? root;
      parent[node] = root;
      node = next;
    }
    return root;
  };
  const owner = new Map<string, number>();
  jobs.forEach((job, index) => {
    for (const key of job.keys) {
      const seen = owner.get(key);
      if (seen === undefined) owner.set(key, index);
      else {
        const [a, b] = [find(seen), find(index)];
        if (a !== b) parent[Math.max(a, b)] = Math.min(a, b);
      }
    }
  });
  const groups = new Map<number, NormalisedJob[]>();
  jobs.forEach((job, index) => {
    const root = find(index);
    groups.set(root, [...(groups.get(root) ?? []), job]);
  });
  return [...groups.values()].map((members) => {
    const primary = members.reduce((best, job) => (rank(job) < rank(best) ? job : best));
    return {
      jobs: [primary, ...members.filter((job) => job !== primary)],
      keys: [...new Set(members.flatMap((job) => job.keys))].sort(),
    };
  });
}

export interface ExistingJobKeys {
  id: string;
  keys: readonly string[];
  firstSeenAt: Date;
  /** Sources already on the job, so merges stay within `JOB_LIMITS.sources`. */
  sourceCount: number;
}

export type IngestOutcome = 'new' | 'merged' | 'duplicate';

export interface JobUpdate {
  jobId: string;
  /** Members whose source isn't on the job yet. */
  addSources: NormalisedJob[];
  addKeys: string[];
}

export interface IngestPlan {
  creates: BatchGroup[];
  updates: JobUpdate[];
  /** One per incoming job, for the per-source counts (PRD R4). */
  outcomes: { sourceId: JobSourceId; outcome: IngestOutcome }[];
  counts: S0Counts;
}

/**
 * Decides what each batch group does against the jobs already stored (ADR-030):
 * - no stored job shares a key → create it; its first member is `new`, the rest `merged`;
 * - otherwise it joins the matching job seen first (ties: lowest ID). Matching more than one
 *   stored job is a conflict, counted. Members whose source key the job already has (or that
 *   would pass the source limit) are `duplicate`; the others are added (`merged`). A job gets no
 *   write unless a source is added.
 */
export function planIngest(
  groups: readonly BatchGroup[],
  existing: readonly ExistingJobKeys[],
): IngestPlan {
  const byKey = new Map<string, ExistingJobKeys[]>();
  for (const job of existing) {
    for (const key of job.keys) byKey.set(key, [...(byKey.get(key) ?? []), job]);
  }
  const knownKeys = new Map(existing.map((job) => [job.id, new Set(job.keys)]));
  const sourceCounts = new Map(existing.map((job) => [job.id, job.sourceCount]));
  const updates = new Map<string, JobUpdate>();
  const plan: IngestPlan = {
    creates: [],
    updates: [],
    outcomes: [],
    counts: { in: 0, new: 0, merged: 0, duplicate: 0, conflicts: 0 },
  };
  const record = (sourceId: JobSourceId, outcome: IngestOutcome) => {
    plan.outcomes.push({ sourceId, outcome });
    plan.counts[outcome] += 1;
    plan.counts.in += 1;
  };

  for (const group of groups) {
    const matches = [
      ...new Map(group.keys.flatMap((key) => byKey.get(key) ?? []).map((j) => [j.id, j])).values(),
    ].sort((a, b) => a.firstSeenAt.getTime() - b.firstSeenAt.getTime() || a.id.localeCompare(b.id));
    const target = matches[0];

    if (!target) {
      plan.creates.push(group);
      const seen = new Set<string>();
      group.jobs.forEach((job, index) => {
        record(
          job.sourceId,
          index === 0 ? 'new' : seen.has(job.sourceKey) ? 'duplicate' : 'merged',
        );
        seen.add(job.sourceKey);
      });
      continue;
    }

    if (matches.length > 1) plan.counts.conflicts += 1;
    const known = knownKeys.get(target.id) ?? new Set<string>();
    knownKeys.set(target.id, known);
    for (const job of group.jobs) {
      const sources = sourceCounts.get(target.id) ?? 0;
      // A job already at its source limit keeps what it has (Firestore arrays are capped).
      if (known.has(job.sourceKey) || sources >= JOB_LIMITS.sources) {
        record(job.sourceId, 'duplicate');
        continue;
      }
      const update = updates.get(target.id) ?? { jobId: target.id, addSources: [], addKeys: [] };
      updates.set(target.id, update);
      update.addSources.push(job);
      sourceCounts.set(target.id, sources + 1);
      for (const key of job.keys) {
        if (!known.has(key) && known.size < JOB_LIMITS.keys) {
          known.add(key);
          update.addKeys.push(key);
        }
      }
      record(job.sourceId, 'merged');
    }
  }
  plan.updates = [...updates.values()];
  return plan;
}

export function sourceRef(job: NormalisedJob, seenAt: Date): JobSourceRef {
  return { id: job.sourceId, url: job.url, externalId: job.externalId, seenAt };
}

/** The `jobs/{jobId}` document and its description for a new batch group. */
export function buildNewJob(
  group: BatchGroup,
  descriptionRef: string,
  now: Date,
): { job: Job; description: JobDescription } {
  const [primary] = group.jobs;
  if (!primary) throw new Error('empty batch group');
  const sources = [...new Map(group.jobs.map((job) => [job.sourceKey, job])).values()]
    .slice(0, JOB_LIMITS.sources)
    .map((job) => sourceRef(job, now));
  const fullText = group.jobs.find((job) => job.description.kind === 'full') ?? primary;
  const companyId = group.jobs.find((job) => job.companyId)?.companyId;
  const salary = group.jobs.find((job) => job.salary)?.salary;
  const postedAt = group.jobs
    .map((job) => job.postedAt)
    .filter((date): date is Date => date !== undefined)
    .sort((a, b) => a.getTime() - b.getTime())[0];
  return {
    job: {
      dedupeKey: primary.dedupeKey ?? primary.sourceKey,
      keys: group.keys.slice(0, JOB_LIMITS.keys),
      title: primary.title.slice(0, JOB_LIMITS.title),
      company: primary.company.slice(0, JOB_LIMITS.company),
      ...(companyId ? { companyId } : {}),
      location: primary.location,
      city: primary.city,
      country: primary.country,
      remote: primary.remote,
      url: primary.url,
      sources,
      ...(postedAt ? { postedAt } : {}),
      firstSeenAt: now,
      descriptionRef,
      descriptionKind: fullText.description.kind,
      ...(salary ? { salary } : {}),
      stage: 's0',
      status: 'new',
      createdAt: now,
      updatedAt: now,
      schemaVersion: 1,
    },
    description: {
      text: fullText.description.text,
      kind: fullText.description.kind,
      sourceId: fullText.sourceId,
      fetchedAt: now,
      schemaVersion: 1,
    },
  };
}
