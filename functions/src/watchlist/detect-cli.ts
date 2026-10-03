import { copyFileSync, readFileSync, writeFileSync } from 'node:fs';

import { CompanySeedSchema } from '@hireframe/shared';

import { hostPolicy, SCAN } from '../config.js';
import { createHttpClient } from '../http/client.js';
import {
  detectCandidate,
  mergeRechecked,
  parseCsv,
  REVIEW_HEADER,
  reviewRow,
  seedFromReview,
  seedModule,
  toCsv,
  type Candidate,
  nonEmpty,
  type Detection,
} from './detect.js';

/**
 * `node scripts/detect-ats.ts <candidates.csv>` → `tmp/watchlist-review.csv`
 * `node scripts/detect-ats.ts --write <review.csv>` → `packages/shared/src/watchlist-seed.ts`
 * (ADR-031). Runs locally against the official job-board APIs only, through the scan's HTTP
 * client (User-Agent, robots.txt, 1 request per second per host, retries).
 */
const REVIEW_PATH = 'tmp/watchlist-review.csv';
const SEED_PATH = 'packages/shared/src/watchlist-seed.ts';

function candidatesFrom(path: string): Candidate[] {
  return parseCsv(readFileSync(path, 'utf8'))
    .filter((row) => row.name && row.domain)
    .map((row) => {
      const careersUrl = nonEmpty(row.careersurl) ?? nonEmpty(row.careers_url);
      return {
        name: row.name ?? '',
        domain: (row.domain ?? '').toLowerCase(),
        hq: nonEmpty(row.hq) ?? 'London',
        ...(careersUrl ? { careersUrl } : {}),
      };
    });
}

function client() {
  return createHttpClient({
    fetch,
    now: Date.now,
    sleep: (ms) =>
      new Promise((resolve) => {
        setTimeout(resolve, ms);
      }),
    random: Math.random,
    userAgent: SCAN.userAgent,
    productToken: SCAN.productToken,
    hostPolicy,
    maxAttempts: SCAN.maxAttempts,
    backoffBaseMs: SCAN.backoffBaseMs,
    retryAfterCapMs: SCAN.retryAfterCapMs,
    maxBodyBytes: SCAN.maxBodyBytes,
    log: (level, event, fields) => {
      // Probing guessed tokens 404s most of the time; only real problems are worth showing.
      if (level !== 'info' && fields.code !== 'not_found') {
        console.error(JSON.stringify({ level, event, ...fields }));
      }
    },
  });
}

async function detectAll(candidates: readonly Candidate[], http: ReturnType<typeof client>) {
  const detections: Detection[] = [];
  // A few companies at a time: each host is still spaced to its interval.
  const queue = [...candidates];
  await Promise.all(
    Array.from({ length: SCAN.detectWorkers }, async () => {
      for (let next = queue.shift(); next; next = queue.shift()) {
        const detection = await detectCandidate(http, next);
        detections.push(detection);
        console.log(
          `  ${detection.status.padEnd(9)} ${next.name}${detection.hit ? ` → ${detection.hit.type}:${detection.hit.token}` : ''}`,
        );
      }
    }),
  );
  return detections;
}

/** Re-detects only the `unchecked` rows of a review file and merges them in place. */
async function recheck(path: string): Promise<void> {
  const rows = parseCsv(readFileSync(path, 'utf8'));
  const candidates: Candidate[] = rows
    .filter((row) => row.status === 'unchecked')
    .map((row) => ({
      name: row.name ?? '',
      domain: row.domain ?? '',
      hq: nonEmpty(row.hq) ?? 'London',
    }));
  if (candidates.length === 0) {
    console.log('detect-ats: no unchecked rows.');
    return;
  }
  console.log(`detect-ats: rechecking ${String(candidates.length)} unchecked rows…`);
  const http = client();
  const detections = await detectAll(candidates, http);
  const merged = mergeRechecked(rows, detections);
  copyFileSync(path, `${path}.bak`);
  writeFileSync(
    path,
    toCsv(
      merged.header,
      merged.rows.map((row) => merged.header.map((key) => row[key] ?? '')),
    ),
  );
  const count = (status: string) => detections.filter((d) => d.status === status).length;
  console.log(
    `detect-ats: ${String(count('confirmed'))} confirmed, ${String(count('review'))} to review, ` +
      `${String(count('not-found'))} not found, ${String(count('unchecked'))} still unchecked → merged into ${path} ` +
      `(previous copy: ${path}.bak). ${String(http.requests())} requests.`,
  );
}

async function detect(path: string): Promise<void> {
  const candidates = candidatesFrom(path);
  const http = client();
  console.log(`detect-ats: ${String(candidates.length)} candidates, 1 request/s per job board…`);
  const detections = await detectAll(candidates, http);
  const order = new Map(candidates.map((candidate, index) => [candidate.name, index]));
  detections.sort(
    (a, b) => (order.get(a.candidate.name) ?? 0) - (order.get(b.candidate.name) ?? 0),
  );
  writeFileSync(REVIEW_PATH, toCsv(REVIEW_HEADER, detections.map(reviewRow)));
  const count = (status: string) => detections.filter((d) => d.status === status).length;
  console.log(
    `detect-ats: ${String(count('confirmed'))} confirmed, ${String(count('review'))} to review, ` +
      `${String(count('not-found'))} not found, ${String(count('unchecked'))} unchecked (a probe failed; ` +
      `run again later) → ${REVIEW_PATH}. ${String(http.requests())} requests.`,
  );
}

function write(path: string): void {
  const { seed, undecided } = seedFromReview(parseCsv(readFileSync(path, 'utf8')));
  if (undecided.length > 0) {
    console.error(
      `detect-ats: these rows need a decision (keep, keep-none or drop): ${undecided.join(', ')}`,
    );
    process.exitCode = 1;
    return;
  }
  for (const company of seed) CompanySeedSchema.parse(company);
  const ids = new Set(seed.map((company) => company.id));
  if (ids.size !== seed.length) {
    console.error('detect-ats: two companies slugify to the same ID; rename one in the CSV.');
    process.exitCode = 1;
    return;
  }
  writeFileSync(SEED_PATH, seedModule(seed));
  const boards = seed.filter((company) => company.ats.type !== 'none').length;
  console.log(
    `detect-ats: wrote ${String(seed.length)} companies (${String(boards)} with a board) → ${SEED_PATH}`,
  );
}

export async function main(args: readonly string[]): Promise<void> {
  const [first, second] = args;
  if (first === '--write' && second) write(second);
  else if (first === '--recheck' && second) await recheck(second);
  else if (first && first !== '--write') await detect(first);
  else {
    console.error(
      'Usage: node scripts/detect-ats.ts <candidates.csv> | --recheck <review.csv> | --write <review.csv>',
    );
    process.exitCode = 1;
  }
}
