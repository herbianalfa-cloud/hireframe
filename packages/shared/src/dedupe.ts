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
import type { WaitState } from './funnel.js';
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
  /** A LinkedIn "Easy Apply" badge, kept on this source's ref (ADR-047). */
  easyApply?: true;
  /** An off-allowlist alert link: on the source ref only, no keys (ADR-047). */
  unverifiedUrl?: string;
  /** `url` is a search link, not a posting (ADR-047). */
  searchLink?: true;
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
    ...(raw.easyApply ? { easyApply: true as const } : {}),
    ...(raw.unverifiedUrl ? { unverifiedUrl: raw.unverifiedUrl } : {}),
    ...(raw.searchLink ? { searchLink: true as const } : {}),
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
  'email-alert',
  'adzuna',
  'hn',
  'lookup',
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
  /** For the description upgrade on merge (ADR-048); absent means "nothing to upgrade". */
  descriptionKind?: DescriptionKind;
  /** Length of the stored text of a snippet-only job; absent counts as 0 (nothing to beat). */
  descriptionChars?: number;
  next?: WaitState | null;
  postedAt?: Date;
}

export type IngestOutcome = 'new' | 'merged' | 'duplicate';

/**
 * A merge that brings a full description to a job that has none (or only a snippet): the text
 * replaces it, the posting date fills a gap, and a job waiting for a description goes to S3
 * (ADR-048). Written in the same batch as the new source.
 */
export interface DescriptionUpgrade {
  text: string;
  sourceId: JobSourceId;
  postedAt?: Date;
  /** The job was at `next: 'description'`: it moves on to `s3`. */
  release: boolean;
}

export interface JobUpdate {
  jobId: string;
  /** Members whose source isn't on the job yet. */
  addSources: NormalisedJob[];
  addKeys: string[];
  upgrade?: DescriptionUpgrade;
}

export interface IngestPlan {
  creates: BatchGroup[];
  updates: JobUpdate[];
  /** One per incoming job, for the per-source counts (PRD R4). */
  outcomes: { sourceId: JobSourceId; outcome: IngestOutcome }[];
  counts: S0Counts;
}

export interface IngestPlanOptions {
  /** A description upgrade needs at least this much full text (the deep read's minimum). */
  minUpgradeChars: number;
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
  options: IngestPlanOptions,
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
    const added: NormalisedJob[] = [];
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
      added.push(job);
      // The posting's own source key first, so the cap never drops the key that recognises it.
      for (const key of [job.sourceKey, ...job.keys]) {
        if (!known.has(key) && known.size < JOB_LIMITS.keys) {
          known.add(key);
          update.addKeys.push(key);
        }
      }
      record(job.sourceId, 'merged');
    }
    const upgrade = descriptionUpgrade(target, added, options.minUpgradeChars);
    const update = updates.get(target.id);
    // Two groups can match one stored job: the longer text wins.
    if (upgrade && update && upgrade.text.length > (update.upgrade?.text.length ?? 0)) {
      update.upgrade = upgrade;
    }
  }
  plan.updates = [...updates.values()];
  return plan;
}

/**
 * The upgrade a merge brings, if any: a job with no text or only a snippet takes the longest full
 * description among the members just added, if it has the deep read's minimum and beats what is
 * stored (ADR-048). Fewer characters than that is no description, and a shorter text never
 * replaces a longer one.
 */
function descriptionUpgrade(
  target: ExistingJobKeys,
  added: readonly NormalisedJob[],
  minChars: number,
): DescriptionUpgrade | undefined {
  if (target.descriptionKind !== 'none' && target.descriptionKind !== 'snippet') return undefined;
  const stored = target.descriptionKind === 'none' ? 0 : (target.descriptionChars ?? 0);
  let best: NormalisedJob | undefined;
  for (const job of added) {
    const { kind, text } = job.description;
    if (kind !== 'full' || text.length < minChars || text.length <= stored) continue;
    if (!best || text.length > best.description.text.length) best = job;
  }
  if (!best) return undefined;
  const gap = target.postedAt === undefined && best.postedAt !== undefined;
  return {
    text: best.description.text,
    sourceId: best.sourceId,
    ...(gap && best.postedAt ? { postedAt: best.postedAt } : {}),
    release: target.next === 'description',
  };
}

export function sourceRef(job: NormalisedJob, seenAt: Date): JobSourceRef {
  return {
    id: job.sourceId,
    url: job.unverifiedUrl ?? job.url,
    externalId: job.externalId,
    seenAt,
    ...(job.easyApply ? { easyApply: true as const } : {}),
    ...(job.unverifiedUrl ? { unverified: true as const } : {}),
    ...(job.searchLink ? { searchLink: true as const } : {}),
  };
}

/** The `jobs/{jobId}` document and its description for a new batch group. */
/**
 * A job's keys within `JOB_LIMITS.keys`, most important first: every member's own source key,
 * then dedupe keys, then keys from linked URLs. Truncation never drops a source key a later
 * scan needs to recognise the posting (unless there are more source keys than the cap).
 */
export function cappedKeys(group: BatchGroup): { keys: string[]; dropped: number } {
  const sourceKeys = group.jobs.map((job) => job.sourceKey);
  const dedupeKeys = group.keys.filter((key) => key.startsWith('d:'));
  const ordered = [...new Set([...sourceKeys, ...dedupeKeys, ...group.keys])];
  return {
    keys: ordered.slice(0, JOB_LIMITS.keys),
    dropped: Math.max(0, ordered.length - JOB_LIMITS.keys),
  };
}

export function buildNewJob(
  group: BatchGroup,
  descriptionRef: string,
  now: Date,
): { job: Job; description: JobDescription; droppedKeys: number } {
  const [primary] = group.jobs;
  if (!primary) throw new Error('empty batch group');
  const { keys, dropped } = cappedKeys(group);
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
      keys,
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
    droppedKeys: dropped,
  };
}
