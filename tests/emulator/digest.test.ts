/**
 * getDigest against the Firestore emulator with the real stores (ADR-052). Run with
 * `npm run test:rules`. Proves: a digest-signed request against seeded runs returns `ready` with
 * the jobs judged since the previous morning run and none of the applied or older ones; a replay
 * is refused; an ingest-signed request is refused; the "+n more" count is exact.
 */
import { randomUUID } from 'node:crypto';

import { PATHS } from '@hireframe/shared';
import { deleteApp, initializeApp, type App } from 'firebase-admin/app';
import { getFirestore, type Firestore } from 'firebase-admin/firestore';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { buildDigest } from '../../functions/src/digest/build.js';
import { digestHandler, type DigestHandlerDeps } from '../../functions/src/digest/handler.js';
import { firestoreDigestStore } from '../../functions/src/digest/store.js';
import { signRequest, type SignedRequest } from '../../functions/src/ingest/hmac.js';
import { firestoreNonceStore } from '../../functions/src/ingest/nonces.js';

const SECRET = 'd16e5700'.repeat(8);
// 07:50 in London (BST).
const NOW = new Date('2026-10-07T06:50:00Z');
const BODY = JSON.stringify({ kind: 'morning', day: '2026-10-07' });

let app: App;
let db: Firestore;

beforeAll(() => {
  if (!process.env.FIRESTORE_EMULATOR_HOST) throw new Error('Run with `npm run test:rules`.');
  app = initializeApp({ projectId: 'demo-hireframe' }, 'digest-test');
  db = getFirestore(app);
});

afterAll(async () => {
  await deleteApp(app);
});

beforeEach(async () => {
  for (const path of ['jobs', 'runs', 'sources', 'usage', 'nonces']) {
    await db.recursiveDelete(db.collection(path));
  }
});

const run = (startedAt: string, status = 'succeeded') => ({
  trigger: 'schedule',
  status,
  startedAt: new Date(startedAt),
  finishedAt: new Date(startedAt),
  perSource: {},
  perStage: {
    s3: {
      in: 4,
      apply: 2,
      near_miss: 0,
      wildcard: 0,
      skip: 2,
      expired: 0,
      review: 0,
      queued: 0,
      drift: 0,
      recomputed: 0,
      costPence: 1,
      durationMs: 1000,
    },
  },
  costPence: 2,
  errors: [],
  schemaVersion: 1,
});

const job = (title: string, judgedAt: string, overrides: Record<string, unknown> = {}) => ({
  title,
  company: 'Acme Analytics',
  verdict: 'apply',
  status: 'new',
  fitScore: 8,
  luckScore: 6,
  reason: 'Strong match.',
  judgedAt: new Date(judgedAt),
  ...overrides,
});

async function seed(): Promise<void> {
  await db.doc('runs/yesterday').set(run('2026-10-06T06:30:00Z'));
  await db.doc('runs/today').set(run('2026-10-07T06:30:00Z'));
  await db.doc('runs/yesterday-pm').set(run('2026-10-06T16:30:00Z'));
  await db.doc('jobs/new-today').set(job('Product Analyst', '2026-10-07T06:40:00Z'));
  await db.doc('jobs/new-yesterday-pm').set(job('Data Analyst', '2026-10-06T16:40:00Z'));
  await db.doc('jobs/old').set(job('Old Analyst', '2026-10-05T16:40:00Z'));
  await db
    .doc('jobs/applied')
    .set(job('Applied Analyst', '2026-10-07T06:41:00Z', { status: 'applied' }));
  await db
    .doc('jobs/skipped')
    .set(job('Skipped Analyst', '2026-10-07T06:42:00Z', { status: 'skipped' }));
  await db.doc('jobs/saved-near').set(
    job('Near Analyst', '2026-10-07T06:43:00Z', {
      verdict: 'near_miss',
      status: 'saved',
      shortfall: 'Wants 5 years.',
    }),
  );
  await db.doc('jobs/waiting').set({ title: 'Waiting', next: 'description' });
  await db.doc(PATHS.usage('2026-10')).set({
    spendPence: 1250,
    capPence: 1500,
    reservations: {},
    calls: {},
    tokens: {},
    byPurpose: {},
    createdAt: NOW,
    updatedAt: NOW,
    schemaVersion: 1,
  });
}

function request(
  options: { nonce?: string; purpose?: 'digest' | 'ingest'; body?: string } = {},
): SignedRequest {
  const body = options.body ?? BODY;
  const timestamp = String(Math.floor(NOW.getTime() / 1000));
  const nonce = options.nonce ?? randomUUID();
  const headers: Record<string, string> = {
    'x-hireframe-timestamp': timestamp,
    'x-hireframe-nonce': nonce,
    'x-hireframe-signature': signRequest(
      SECRET,
      timestamp,
      nonce,
      body,
      options.purpose ?? 'digest',
    ),
  };
  return {
    method: 'POST',
    contentType: 'application/json',
    rawBody: Buffer.from(body),
    header: (name) => headers[name],
  };
}

const deps = (): DigestHandlerDeps => ({
  secret: SECRET,
  nonces: firestoreNonceStore(db),
  now: () => NOW,
  build: (digestRequest, now) => buildDigest(firestoreDigestStore(db), digestRequest, now),
});

describe('getDigest against the emulator', () => {
  it('returns a ready digest of the open jobs judged since the previous morning run', async () => {
    await seed();
    const result = await digestHandler(request(), deps());
    expect(result.status).toBe(200);
    const body = result.body as { state: string; subject: string; text: string; html: string };
    expect(body.state).toBe('ready');
    expect(body.subject).toBe('Hireframe Wed 7 Oct: 2 apply, 1 near miss, 0 wildcard');
    expect(body.text).toContain('Product Analyst');
    expect(body.text).toContain('Data Analyst');
    expect(body.text).toContain('Near Analyst · Acme Analytics (fit 8 · luck 6 — Wants 5 years.)');
    for (const excluded of ['Old Analyst', 'Applied Analyst', 'Skipped Analyst']) {
      expect(body.text).not.toContain(excluded);
    }
    expect(body.text).toContain('1250p of 1500p this month (83%)');
    expect(body.text).toContain('Warning: 80% of the monthly cap is used');
    expect(body.text).toContain('1 waiting for a description');
    expect(body.html).toContain('?job=new-today');
  });

  it('counts exactly past the listed jobs', async () => {
    await seed();
    for (let i = 0; i < 12; i += 1) {
      await db.doc(`jobs/bulk-${String(i)}`).set(job(`Bulk ${String(i)}`, '2026-10-07T06:50:00Z'));
    }
    const result = await digestHandler(request(), deps());
    const text = (result.body as { text: string }).text;
    // 12 bulk + new-today + new-yesterday-pm = 14 apply; 10 listed.
    expect(text).toContain('+4 more in the app');
  });

  it('refuses a replay and an ingest-signed request', async () => {
    await seed();
    const nonce = randomUUID();
    expect((await digestHandler(request({ nonce }), deps())).status).toBe(200);
    expect((await digestHandler(request({ nonce }), deps())).status).toBe(401);
    expect((await digestHandler(request({ purpose: 'ingest' }), deps())).status).toBe(401);
    const stored = await db.collection('nonces').get();
    expect(stored.size).toBe(1);
  });

  it('reports a morning run document that fails RunSchema as failed with run_invalid', async () => {
    await seed();
    await db.doc('runs/today').set({ ...run('2026-10-07T06:30:00Z'), costPence: 'a lot' });
    const result = await digestHandler(request(), deps());
    expect(result.status).toBe(200);
    const body = result.body as { state: string; text: string };
    expect(body.state).toBe('failed');
    expect(body.text).toContain('run_invalid');
  });

  it('says the scan is missing when no morning run exists and it is past 08:15', async () => {
    const late = { ...deps(), now: () => new Date('2026-10-07T07:30:00Z') };
    const timestamp = String(Math.floor(new Date('2026-10-07T07:30:00Z').getTime() / 1000));
    const nonce = randomUUID();
    const signed: SignedRequest = {
      ...request(),
      header: (name) =>
        ({
          'x-hireframe-timestamp': timestamp,
          'x-hireframe-nonce': nonce,
          'x-hireframe-signature': signRequest(SECRET, timestamp, nonce, BODY, 'digest'),
        })[name],
    };
    const result = await digestHandler(signed, late);
    expect((result.body as { state: string }).state).toBe('missing');
  });
});
