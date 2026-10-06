import {
  AlertParseOutputSchema,
  buildNewJob,
  dedupeBatch,
  extractLinks,
  modelAlertJobs,
  normaliseRawJob,
  type IngestMessage,
} from '@hireframe/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { GREENHOUSE_JOB } from '../../../packages/shared/src/fixtures/jobs.js';
import {
  INJECTION_ALERT,
  LINKEDIN_ALERT,
  LINKEDIN_ALERT_FORWARDED,
  WAAS_ALERT,
  WAAS_MODEL_ANSWER,
} from '../../../packages/shared/src/fixtures/alerts.js';
import { ALERT_LINK_HOSTS, ALERTS } from '../config.js';
import { DailyCapExceededError, LlmOutputError, SpendCapExceededError } from '../llm/errors.js';
import { setLogSink, type LogFields } from '../log.js';
import type { ModelParser } from './parse-llm.js';
import { messageHash, runIngest, type IngestDeps } from './run.js';
import { memoryIngestStore } from './testing.js';

const NOW = new Date('2026-10-07T09:00:00Z');
let clock = NOW.getTime();
let logs: { level: string; event: string; fields: LogFields }[] = [];

beforeEach(() => {
  clock = NOW.getTime();
  logs = [];
  setLogSink((level, event, fields) => logs.push({ level, event, fields }));
});
afterEach(() => {
  setLogSink();
});

const msg = (id: string, fixture: { from: string; text: string; html: string }): IngestMessage => ({
  id,
  receivedAt: NOW.toISOString(),
  ...fixture,
});

/** The model, faked: answers the Work at a Startup fixture from its recorded rows. */
const waasParser: ModelParser = (message) => {
  const links = extractLinks(message.html);
  return Promise.resolve(
    modelAlertJobs(AlertParseOutputSchema.parse(WAAS_MODEL_ANSWER), links, ALERT_LINK_HOSTS),
  );
};

function setup(parser: ModelParser = waasParser) {
  const store = memoryIngestStore();
  const calls: string[] = [];
  const deps: IngestDeps = {
    store,
    parseWithModel: (message) => {
      calls.push(message.id);
      return parser(message);
    },
    now: () => new Date(clock),
    clock: () => clock,
  };
  return { store, deps, calls };
}

describe('runIngest: LinkedIn alerts', () => {
  it('creates one job per card at s0, with Easy Apply on the source and no description', async () => {
    const { store, deps } = setup();
    const result = await runIngest(deps, [msg('g1', LINKEDIN_ALERT)]);
    expect(result).toEqual({ status: 'done', results: [{ id: 'g1', status: 'processed' }] });
    expect(store.jobs.size).toBe(5);
    const jobs = [...store.jobs.values()];
    const product = jobs.find((job) => job.title === 'Product Analyst');
    expect(product).toMatchObject({
      stage: 's0',
      descriptionKind: 'none',
      country: 'GB',
      remote: 'hybrid',
      url: 'https://www.linkedin.com/jobs/view/4012345678',
      salary: { min: 35000, max: 45000, currency: 'GBP', period: 'year' },
    });
    expect(product?.keys).toContain('linkedin:4012345678');
    expect(product?.sources[0]).toMatchObject({ id: 'linkedin-alert', easyApply: true });
    expect(product?.next).toBeUndefined();
    expect(
      jobs.find((job) => job.title === 'Associate Product Manager')?.sources[0]?.easyApply,
    ).toBeUndefined();
    expect([...store.descriptions.values()].every((d) => d.kind === 'none' && d.text === '')).toBe(
      true,
    );
  });

  it('records the message by hash with counts only, and updates the email source health', async () => {
    const { store, deps } = setup();
    await runIngest(deps, [msg('gmail-id-1', LINKEDIN_ALERT)]);
    const record = store.messages.get(messageHash('gmail-id-1'));
    expect(record).toMatchObject({
      sender: 'linkedin.com',
      parser: 'deterministic',
      jobs: 5,
      new: 5,
      merged: 0,
      duplicate: 0,
      unverifiedLinks: 0,
      status: 'processed',
    });
    expect(Object.keys(record ?? {}).sort()).toEqual([
      'at',
      'duplicate',
      'expireAt',
      'jobs',
      'merged',
      'new',
      'parser',
      'schemaVersion',
      'sender',
      'status',
      'unverifiedLinks',
    ]);
    expect(record?.expireAt.getTime()).toBe(NOW.getTime() + ALERTS.messageTtlDays * 86_400_000);
    const health = store.health();
    expect(health).toMatchObject({
      status: 'ok',
      lastCounts: { requests: 1, fetched: 5, new: 5, duplicate: 0, merged: 0, invalid: 0 },
      bySender: { 'linkedin.com': { messages: 1, jobs: 5, unparsed: 0 } },
    });
  });

  it('is idempotent by message hash: the same message again is a duplicate and writes nothing', async () => {
    const { store, deps } = setup();
    await runIngest(deps, [msg('g1', LINKEDIN_ALERT)]);
    const jobs = store.jobs.size;
    const second = await runIngest(deps, [msg('g1', LINKEDIN_ALERT)]);
    expect(second).toEqual({ status: 'done', results: [{ id: 'g1', status: 'duplicate' }] });
    expect(store.jobs.size).toBe(jobs);
    expect(store.messages.size).toBe(1);
  });

  it('merges the auto-forwarded copy (another Gmail ID, same LinkedIn jobs) as duplicates', async () => {
    const { store, deps } = setup();
    await runIngest(deps, [msg('direct', LINKEDIN_ALERT)]);
    await runIngest(deps, [msg('forwarded', LINKEDIN_ALERT_FORWARDED)]);
    expect(store.jobs.size).toBe(5);
    expect([...store.jobs.values()].every((job) => job.sources.length === 1)).toBe(true);
    expect(store.messages.get(messageHash('forwarded'))).toMatchObject({ new: 0, duplicate: 5 });
  });

  it('collapses the same alert twice in one request without a second write', async () => {
    const { store, deps } = setup();
    const result = await runIngest(deps, [
      msg('a', LINKEDIN_ALERT),
      msg('b', LINKEDIN_ALERT_FORWARDED),
    ]);
    expect(result).toMatchObject({ status: 'done' });
    expect(store.jobs.size).toBe(5);
  });

  it('matches each job company to the watchlist for companyId', async () => {
    const { store, deps } = setup();
    store.companies.push({ id: 'acme-analytics', name: 'Acme Analytics Ltd' });
    await runIngest(deps, [msg('g1', LINKEDIN_ALERT)]);
    const jobs = [...store.jobs.values()];
    expect(jobs.find((job) => job.company === 'Acme Analytics')?.companyId).toBe('acme-analytics');
    expect(jobs.find((job) => job.company === 'Cobalt Systems')?.companyId).toBeUndefined();
  });

  it('adds only its own source to a job a scan already found (the other order)', async () => {
    const { store, deps } = setup();
    const greenhouse = normaliseRawJob(GREENHOUSE_JOB);
    const [group] = dedupeBatch(greenhouse ? [greenhouse] : []);
    if (!group) throw new Error('no group');
    store.jobs.set('gh', buildNewJob(group, 'jobs/gh/description/raw', NOW).job);
    await runIngest(deps, [msg('g1', LINKEDIN_ALERT)]);
    expect(store.jobs.size).toBe(5); // four new + the merged one
    const merged = store.jobs.get('gh');
    expect(merged?.sources.map((source) => source.id).sort()).toEqual([
      'greenhouse',
      'linkedin-alert',
    ]);
    expect(merged?.keys).toContain('linkedin:4012345678');
    expect(merged?.descriptionKind).toBe('full'); // never enters the needs-description state
    expect(merged?.sources.find((s) => s.id === 'linkedin-alert')?.easyApply).toBe(true);
  });

  it('counts a LinkedIn email with job links but no readable card as unparsed', async () => {
    const { store, deps } = setup();
    const broken = {
      from: LINKEDIN_ALERT.from,
      text: '',
      html: '<a href="https://www.linkedin.com/comm/jobs/view/4999999999/?x=1">A new layout</a>',
    };
    const result = await runIngest(deps, [msg('g1', broken)]);
    expect(result).toMatchObject({ results: [{ id: 'g1', status: 'unparsed' }] });
    expect(store.jobs.size).toBe(0);
    expect(store.messages.get(messageHash('g1'))?.status).toBe('unparsed');
    expect(store.health()).toMatchObject({
      status: 'failing',
      lastCounts: { invalid: 1, errorCode: 'unparsed' },
      bySender: { 'linkedin.com': { unparsed: 1 } },
    });
  });

  it('processes an email with no job links as zero jobs, not unparsed', async () => {
    const { store, deps } = setup();
    const result = await runIngest(deps, [
      msg('g1', { from: LINKEDIN_ALERT.from, text: 'Your alert was paused', html: '' }),
    ]);
    expect(result).toMatchObject({ results: [{ id: 'g1', status: 'processed' }] });
    expect(store.jobs.size).toBe(0);
  });

  it('keeps injection text as data: the job title, nothing else', async () => {
    const { store, deps } = setup();
    await runIngest(deps, [msg('g1', INJECTION_ALERT)]);
    const [job] = [...store.jobs.values()];
    expect(job?.title).toContain('Ignore all previous instructions');
    expect(job?.stage).toBe('s0');
    expect(job?.verdict).toBeUndefined();
  });
});

describe('runIngest: the lock', () => {
  it('answers busy and parses nothing while a scan holds the lock', async () => {
    const { store, deps, calls } = setup();
    store.holdLock('scan');
    const result = await runIngest(deps, [msg('g1', LINKEDIN_ALERT), msg('w1', WAAS_ALERT)]);
    expect(result).toEqual({ status: 'busy', holder: 'scan' });
    expect(store.jobs.size).toBe(0);
    expect(calls).toEqual([]);
    expect(store.messages.size).toBe(0);
    expect(store.lock.holder).toBe('scan'); // not released by a request that never held it
  });

  it('holds the lock as email during the run and releases it after, even on failure', async () => {
    const { store, deps } = setup(() => Promise.reject(new Error('boom')));
    let heldAs: string | null = null;
    const original = store.findJobsByKeys;
    store.findJobsByKeys = (keys) => {
      heldAs = store.lock.holder;
      return original(keys);
    };
    await runIngest(deps, [msg('g1', LINKEDIN_ALERT), msg('w1', WAAS_ALERT)]);
    expect(heldAs).toBe('email');
    expect(store.lock.holder).toBeNull();
  });
});

describe('runIngest: other senders (model fallback)', () => {
  it('parses a Work at a Startup digest, keeping an off-allowlist link as unverified', async () => {
    const { store, deps, calls } = setup();
    const result = await runIngest(deps, [msg('w1', WAAS_ALERT)]);
    expect(result).toMatchObject({ results: [{ id: 'w1', status: 'processed' }] });
    expect(calls).toEqual(['w1']);
    const jobs = [...store.jobs.values()];
    expect(jobs).toHaveLength(3);
    const ashby = jobs.find((job) => job.company === 'Pylon Labs');
    expect(ashby?.keys).toContain('ashby:0b1c2d3e-0000-4000-8000-0000000000a1');
    expect(ashby?.sources[0]).toMatchObject({ id: 'email-alert' });
    const quill = jobs.find((job) => job.company === 'Quill AI');
    expect(quill?.sources[0]).toMatchObject({
      unverified: true,
      url: 'https://click.example.net/c/9f8e7d?u=quill',
    });
    expect(quill?.url).toMatch(/^https:\/\/www\.linkedin\.com\/jobs\/search/);
    expect(quill?.keys.filter((key) => !key.startsWith('d:') && !key.startsWith('email:'))).toEqual(
      [],
    );
    expect(store.messages.get(messageHash('w1'))).toMatchObject({
      sender: 'example.com',
      parser: 'model',
      jobs: 3,
      unverifiedLinks: 1,
    });
    expect(store.health()?.bySender).toMatchObject({
      'example.com': { messages: 1, jobs: 3, unparsed: 0, unverifiedLinks: 1 },
    });
  });

  it('defers a message over the daily cap or the monthly cap: nothing written or recorded', async () => {
    for (const error of [new DailyCapExceededError(), new SpendCapExceededError()]) {
      const { store, deps } = setup(() => Promise.reject(error));
      const result = await runIngest(deps, [msg('w1', WAAS_ALERT)]);
      expect(result).toMatchObject({ results: [{ id: 'w1', status: 'deferred' }] });
      expect(store.jobs.size).toBe(0);
      expect(store.messages.size).toBe(0);
      expect(store.health()).toMatchObject({
        status: 'failing',
        lastCounts: { errors: 1, errorCode: 'deferred' },
      });
    }
  });

  it('marks bad model output unparsed, and defers a service error', async () => {
    const bad = setup(() => Promise.reject(new LlmOutputError('schema', 0.1)));
    expect(await runIngest(bad.deps, [msg('w1', WAAS_ALERT)])).toMatchObject({
      results: [{ status: 'unparsed' }],
    });
    expect(bad.store.messages.get(messageHash('w1'))?.status).toBe('unparsed');

    const down = setup(() => Promise.reject(new Error('503')));
    expect(await runIngest(down.deps, [msg('w1', WAAS_ALERT)])).toMatchObject({
      results: [{ status: 'deferred' }],
    });
    expect(down.store.messages.size).toBe(0);
  });

  it('defers later model messages once 35 s of the request have passed', async () => {
    const slow: ModelParser = (message) => {
      clock += 20_000;
      return waasParser(message);
    };
    const { store, deps, calls } = setup(slow);
    const result = await runIngest(deps, [
      msg('w1', WAAS_ALERT),
      msg('w2', { ...WAAS_ALERT, text: `${WAAS_ALERT.text} 2` }),
      msg('w3', { ...WAAS_ALERT, text: `${WAAS_ALERT.text} 3` }),
      msg('g1', LINKEDIN_ALERT),
    ]);
    expect(calls).toEqual(['w1', 'w2']); // 0 s and 20 s start; at 40 s the window has closed
    expect(result).toMatchObject({
      results: [
        { id: 'w1', status: 'processed' },
        { id: 'w2', status: 'processed' },
        { id: 'w3', status: 'deferred' },
        { id: 'g1', status: 'processed' }, // a LinkedIn parse needs no model
      ],
    });
    expect(store.messages.has(messageHash('w3'))).toBe(false);
  });

  it('defers a message whose job write failed, so a retry can finish it', async () => {
    const { store, deps } = setup();
    store.failWrites = 1;
    const first = await runIngest(deps, [msg('g1', LINKEDIN_ALERT)]);
    expect(first).toMatchObject({ results: [{ status: 'deferred' }] });
    expect(store.messages.size).toBe(0);
    const retry = await runIngest(deps, [msg('g1', LINKEDIN_ALERT)]);
    expect(retry).toMatchObject({ results: [{ status: 'processed' }] });
    expect(store.jobs.size).toBe(5);
  });
});

describe('runIngest: nothing from an email reaches the log', () => {
  const SENSITIVE = [
    'jobalerts-noreply',
    'linkedin.com',
    'Product Analyst',
    'Acme Analytics',
    'Ignore all previous',
    'Pylon Labs',
    'click.example.net',
    'jobs@example.com',
    'trackingId',
    'Subject',
  ];

  const everyLogged = () => JSON.stringify(logs);

  it('on success', async () => {
    const { deps } = setup();
    await runIngest(deps, [
      msg('g1', LINKEDIN_ALERT),
      msg('w1', WAAS_ALERT),
      msg('i1', INJECTION_ALERT),
    ]);
    expect(logs.length).toBeGreaterThan(0);
    for (const word of SENSITIVE) expect(everyLogged()).not.toContain(word);
  });

  it.each([
    ['a model error', new Error('boom: Pylon Labs jobs@example.com')],
    ['a cap', new DailyCapExceededError()],
    ['bad output', new LlmOutputError('schema', 0)],
  ])('on %s', async (_name, error) => {
    const { deps } = setup(() => Promise.reject(error));
    await runIngest(deps, [msg('w1', WAAS_ALERT)]);
    for (const word of SENSITIVE) expect(everyLogged()).not.toContain(word);
  });

  it('on a failed write and an unparsed email', async () => {
    const { store, deps } = setup();
    store.failWrites = 1;
    await runIngest(deps, [
      msg('g1', LINKEDIN_ALERT),
      msg('g2', {
        from: LINKEDIN_ALERT.from,
        text: '',
        html: '<a href="https://www.linkedin.com/comm/jobs/view/4999999999/">x</a>',
      }),
    ]);
    for (const word of SENSITIVE) expect(everyLogged()).not.toContain(word);
  });
});

describe('sender counts on sources/email', () => {
  it('lists at most 20 sender domains and counts the rest under other', async () => {
    const { store, deps } = setup(() => Promise.resolve({ jobs: [], unverifiedLinks: 0 }));
    const messages = Array.from({ length: 5 }, (_, i) =>
      msg(`a${String(i)}`, { from: `x <a@d${String(i)}.example>`, text: 't', html: '' }),
    );
    for (let round = 0; round < 5; round++) {
      await runIngest(
        deps,
        messages.map((m) => ({
          ...m,
          id: `${m.id}-${String(round)}`,
          from: `x <a@d${String(round * 5 + Number(m.id.slice(1)))}.example>`,
        })),
      );
    }
    const senders = Object.keys(store.health()?.bySender ?? {});
    expect(senders.filter((s) => s !== 'other')).toHaveLength(ALERTS.maxSenderDomains);
    expect(store.health()?.bySender?.other?.messages).toBe(5);
  });
});
