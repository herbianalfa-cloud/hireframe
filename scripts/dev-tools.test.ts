import {
  ApplicationSchema,
  CvHeaderSchema,
  dedupeKey,
  JobDescriptionSchema,
  JobSchema,
  normaliseRawJob,
  questionId,
  RunSchema,
  UsageSchema,
  verdictAgreement,
} from '@hireframe/shared';
import { describe, expect, it } from 'vitest';

import { LINKEDIN_ALERT_JOB } from '../packages/shared/src/fixtures/jobs.ts';

import { isCiDeploy } from './assert-ci.ts';
import {
  alertWaitingJobDocuments,
  appConfigDocument,
  applicationSeeds,
  cvHeaderSeed,
  DEV_APPLIED_JOB_ID,
  DEV_BLOCKED_JOB_ID,
  DEV_GENERATING_JOB_ID,
  DEV_NEEDS_INPUT_JOB_ID,
  DEV_READY_JOB_ID,
  readyApplicationSeed,
  assertDemoProject,
  criteriaSeedDocuments,
  devJobDocuments,
  DEV_ALERT_WAITING_JOB_KEYS,
  DEV_LINKEDIN_JOB_KEYS,
  DEV_OWNER,
  linkedInJobDocuments,
  ownerAccountBody,
  profileSeedDocuments,
  restDocument,
  toRestValue,
  usageSeedDocument,
  morningRunSeedDocument,
  seedWorkerEnv,
  DEV_EMULATOR_ENV,
  withEmulatorDefaults,
} from './dev-seed.ts';

describe('isCiDeploy', () => {
  it('allows only GitHub Actions runs on a v* tag', () => {
    expect(isCiDeploy({ GITHUB_ACTIONS: 'true', GITHUB_REF: 'refs/tags/v0.1.0' })).toBe(true);
    expect(isCiDeploy({ GITHUB_ACTIONS: 'true', GITHUB_REF: 'refs/heads/main' })).toBe(false);
    expect(isCiDeploy({ GITHUB_REF: 'refs/tags/v0.1.0' })).toBe(false);
    expect(isCiDeploy({})).toBe(false);
  });
});

describe('dev seed', () => {
  it('seeds the fake CV facts as active v1 facts, each with its snapshot, and work rights', () => {
    const now = new Date('2026-10-05T08:00:00Z');
    const { settings, facts } = profileSeedDocuments(now);
    expect(facts.length).toBeGreaterThanOrEqual(60);
    expect(new Set(facts.map((f) => f.id)).size).toBe(facts.length);
    const [first] = facts;
    expect(first?.fact.fields).toMatchObject({
      status: { stringValue: 'active' },
      version: { integerValue: '1' },
      source: { stringValue: 'cv' },
    });
    expect(first?.version.fields.change).toEqual({ stringValue: 'created' });
    expect(settings.fields.workRights).toEqual({ stringValue: 'time_limited' });
  });

  it('refuses any project that is not demo-*', () => {
    expect(assertDemoProject('demo-hireframe')).toBe('demo-hireframe');
    expect(() => assertDemoProject('hireframe-f6b03')).toThrow(/demo-\*/);
    expect(() => assertDemoProject(undefined)).toThrow(/demo-\*/);
  });

  it('seeds a fake owner linked to Google so the emulator pop-up lists it', () => {
    const [account] = ownerAccountBody().users;
    expect(account?.localId).toBe(DEV_OWNER.uid);
    expect(account?.email).toMatch(/@example\.com$/);
    expect(account?.providerUserInfo[0]?.providerId).toBe('google.com');
  });

  it('writes config/app with Timestamps, like a console-created doc', () => {
    const doc = appConfigDocument(new Date('2026-09-30T08:00:00Z'));
    expect(doc.fields.ownerUid.stringValue).toBe(DEV_OWNER.uid);
    expect(doc.fields.createdAt.timestampValue).toBe('2026-09-30T08:00:00.000Z');
  });
});

describe('criteria seed documents', () => {
  it('encodes criteria v1 and the pointer as Firestore REST values', () => {
    const { v1, current } = criteriaSeedDocuments(new Date('2026-10-01T09:00:00Z'));
    expect(v1.fields.version).toEqual({ integerValue: '1' });
    expect(v1.fields.freshness_days).toEqual({ integerValue: '14' });
    expect(v1.fields.createdAt).toEqual({ timestampValue: '2026-10-01T09:00:00.000Z' });
    expect(v1.fields.company_prefs).toMatchObject({
      mapValue: {
        fields: {
          size: { arrayValue: { values: [{ integerValue: '20' }, { integerValue: '300' }] } },
        },
      },
    });
    expect(current.fields).toEqual({
      version: { integerValue: '1' },
      updatedAt: { timestampValue: '2026-10-01T09:00:00.000Z' },
      schemaVersion: { integerValue: '1' },
    });
  });

  it('encodes fractional numbers as doubles', () => {
    expect(toRestValue(0.5)).toEqual({ doubleValue: 0.5 });
  });
});

describe('dev alert job waiting for a description (M6)', () => {
  const decode = (value: unknown): unknown => {
    const v = value as Record<string, unknown>;
    if ('stringValue' in v) return v.stringValue;
    if ('integerValue' in v) return Number(v.integerValue);
    if ('doubleValue' in v) return v.doubleValue;
    if ('booleanValue' in v) return v.booleanValue;
    if ('timestampValue' in v) return new Date(String(v.timestampValue));
    if ('arrayValue' in v) return (v.arrayValue as { values: unknown[] }).values.map(decode);
    if ('mapValue' in v) {
      const fields = (v.mapValue as { fields: Record<string, unknown> }).fields;
      return Object.fromEntries(Object.entries(fields).map(([k, inner]) => [k, decode(inner)]));
    }
    throw new Error('unexpected value');
  };

  it('has the keys the shared dedupe computes for the same card', () => {
    expect(dedupeKey('Cobalt Systems', 'Customer Solutions Engineer', 'manchester')).toBe(
      DEV_ALERT_WAITING_JOB_KEYS[0],
    );
  });

  it('is a valid job at next: description, with an empty description of kind none', () => {
    const { job, description } = alertWaitingJobDocuments(new Date('2026-10-01T08:00:00Z'));
    const parsed = JobSchema.parse(decode({ mapValue: job }));
    expect(parsed).toMatchObject({ next: 'description', descriptionKind: 'none', stage: 's2' });
    expect(parsed.flags).toContain('needs_description');
    expect(JobDescriptionSchema.parse(decode({ mapValue: description }))).toMatchObject({
      kind: 'none',
      text: '',
    });
  });
});

describe('dev LinkedIn-alert job', () => {
  it('has the keys the shared dedupe computes for the same posting', () => {
    expect(normaliseRawJob(LINKEDIN_ALERT_JOB)?.keys).toEqual([...DEV_LINKEDIN_JOB_KEYS]);
    expect(dedupeKey('Acme Analytics Ltd', 'Product Analyst', 'london')).toBe(
      DEV_LINKEDIN_JOB_KEYS[0],
    );
  });

  it('is a valid job once decoded', () => {
    const now = new Date('2026-10-01T08:00:00Z');
    const { job } = linkedInJobDocuments(now);
    const decode = (value: unknown): unknown => {
      const v = value as Record<string, unknown>;
      if ('stringValue' in v) return v.stringValue;
      if ('integerValue' in v) return Number(v.integerValue);
      if ('timestampValue' in v) return new Date(String(v.timestampValue));
      if ('arrayValue' in v) return (v.arrayValue as { values: unknown[] }).values.map(decode);
      if ('mapValue' in v) {
        const fields = (v.mapValue as { fields: Record<string, unknown> }).fields;
        return Object.fromEntries(Object.entries(fields).map(([k, inner]) => [k, decode(inner)]));
      }
      throw new Error('unexpected value');
    };
    expect(JobSchema.safeParse(decode({ mapValue: job })).success).toBe(true);
  });
});

describe('dev dashboard seed (M5)', () => {
  const now = new Date('2026-10-14T08:00:00Z');
  const seeded = devJobDocuments(now);

  it('seeds jobs that parse as jobs, each with a valid description', () => {
    expect(seeded.length).toBeGreaterThanOrEqual(12);
    expect(new Set(seeded.map((item) => item.id)).size).toBe(seeded.length);
    for (const { id, job, description } of seeded) {
      expect(JobSchema.safeParse(job), id).toMatchObject({ success: true });
      expect(JobDescriptionSchema.safeParse(description), id).toMatchObject({ success: true });
    }
  });

  it('covers every verdict, both aggregators, an S1 skip, a review job and a queued job', () => {
    const jobs = seeded.map((item) => JobSchema.parse(item.job));
    for (const verdict of ['apply', 'near_miss', 'wildcard', 'skip']) {
      expect(
        jobs.some((job) => job.verdict === verdict),
        verdict,
      ).toBe(true);
    }
    const sources = new Set(jobs.flatMap((job) => job.sources.map((source) => source.id)));
    expect(sources).toContain('adzuna');
    expect(sources).toContain('reed');
    expect(jobs.some((job) => job.skip?.stage === 's1')).toBe(true);
    expect(jobs.some((job) => job.review !== undefined)).toBe(true);
    expect(jobs.some((job) => job.next === 's2')).toBe(true);
  });

  it('seeds two jobs added from Lookup: one with a verdict, one waiting for a description', () => {
    const jobs = seeded.map((item) => JobSchema.parse(item.job)).filter((job) => job.addedAt);
    expect(jobs).toHaveLength(2);
    expect(jobs.every((job) => job.sources.every((source) => source.id === 'lookup'))).toBe(true);
    expect(jobs.some((job) => job.verdict === 'apply' && job.next === null)).toBe(true);
    expect(jobs.some((job) => job.next === 'description' && job.descriptionKind === 'none')).toBe(
      true,
    );
  });

  it('seeds one rating and one applied-on-Apply that agreement counts', () => {
    const jobs = seeded.map((item) => JobSchema.parse(item.job));
    expect(jobs.filter((job) => job.feedback)).toHaveLength(1);
    expect(verdictAgreement(jobs, now)).toMatchObject({ ratedDisagree: 1, appliedAgree: 1 });
  });

  it.each([
    ['summer (BST)', '2026-10-07T12:00:00Z', '2026-10-07T06:30:00.000Z'],
    ['winter (GMT)', '2026-12-02T12:00:00Z', '2026-12-02T07:30:00.000Z'],
    ['just after midnight London in summer', '2026-10-06T23:30:00Z', '2026-10-07T06:30:00.000Z'],
  ])('seeds a succeeded morning run at 07:30 London today: %s', (_name, nowIso, startedIso) => {
    const { data } = morningRunSeedDocument(new Date(nowIso));
    const run = RunSchema.parse(data);
    expect(run).toMatchObject({ trigger: 'schedule', status: 'succeeded' });
    expect(run.startedAt.toISOString()).toBe(startedIso);
  });

  it('seeds this month’s usage in the shape llm.call() expects', () => {
    const { month, data } = usageSeedDocument(now);
    expect(month).toBe('2026-10');
    expect(UsageSchema.safeParse(data).success).toBe(true);
  });
});

/** Decodes a Firestore REST value back to plain data, the way the emulator reads it. */
function fromRest(value: Record<string, unknown>): unknown {
  const [type, inner] = Object.entries(value)[0] ?? [];
  switch (type) {
    case 'stringValue':
    case 'booleanValue':
    case 'doubleValue':
      return inner;
    case 'nullValue':
      return null;
    case 'integerValue':
      return Number(inner);
    case 'timestampValue':
      return new Date(inner as string);
    case 'arrayValue':
      return ((inner as { values?: Record<string, unknown>[] }).values ?? []).map(fromRest);
    case 'mapValue':
      return fromRestFields((inner as { fields?: Record<string, Record<string, unknown>> }).fields);
    default:
      throw new Error(`unknown REST type ${String(type)}`);
  }
}

function fromRestFields(fields: Record<string, Record<string, unknown>> | undefined) {
  return Object.fromEntries(Object.entries(fields ?? {}).map(([k, v]) => [k, fromRest(v)]));
}

/** Plain data with `undefined` keys dropped, which is what restDocument writes. */
const defined = (value: unknown): unknown =>
  JSON.parse(JSON.stringify(value, (_k, v: unknown) => v)) as unknown;

describe('seed → Firestore REST conversion', () => {
  it('converts null, nested maps, arrays, numbers and timestamps with the right REST types', () => {
    const when = new Date('2026-10-14T08:00:00Z');
    expect(toRestValue(null)).toEqual({ nullValue: null });
    expect(toRestValue(3)).toEqual({ integerValue: '3' });
    expect(toRestValue(2.5)).toEqual({ doubleValue: 2.5 });
    expect(toRestValue(when)).toEqual({ timestampValue: '2026-10-14T08:00:00.000Z' });
    expect(toRestValue([null, { a: [1, { b: null }] }])).toEqual({
      arrayValue: {
        values: [
          { nullValue: null },
          {
            mapValue: {
              fields: {
                a: {
                  arrayValue: {
                    values: [
                      { integerValue: '1' },
                      { mapValue: { fields: { b: { nullValue: null } } } },
                    ],
                  },
                },
              },
            },
          },
        ],
      },
    });
    expect(() => toRestValue(() => 1)).toThrow(/Unsupported seed value/);
    expect(() => toRestValue(undefined)).toThrow(/Unsupported seed value/);
  });

  it('converts every seeded job, description and usage document, and reads back unchanged', () => {
    const now = new Date('2026-10-14T08:00:00Z');
    const documents = [
      ...devJobDocuments(now).flatMap(({ id, job, description }) => [
        { name: `jobs/${id}`, data: job },
        { name: `jobs/${id}/description/raw`, data: description },
      ]),
      { name: 'usage', data: usageSeedDocument(now).data },
    ];
    expect(documents.length).toBeGreaterThan(24);
    for (const { name, data } of documents) {
      const converted = restDocument(data);
      const back = fromRestFields(converted.fields);
      // Dates round-trip as Dates; everything else as plain JSON data.
      expect(JSON.stringify(back), name).toBe(JSON.stringify(defined(data)));
    }
  });

  it('builds every other seed document (config, criteria, profile, LinkedIn job) without throwing', () => {
    const now = new Date('2026-10-14T08:00:00Z');
    expect(() => appConfigDocument(now)).not.toThrow();
    expect(() => criteriaSeedDocuments(now)).not.toThrow();
    expect(() => profileSeedDocuments(now)).not.toThrow();
    expect(() => linkedInJobDocuments(now)).not.toThrow();
  });
});

describe('the seed-time worker environment', () => {
  it('drops LIVE and the API key, so LIVE=1 seeds with the fake model and needs no key', () => {
    const env = seedWorkerEnv({
      LIVE: '1',
      ANTHROPIC_API_KEY: 'sk-fake-key',
      GCLOUD_PROJECT: 'demo-hireframe',
      FIRESTORE_EMULATOR_HOST: '127.0.0.1:8080',
    });
    expect(env).toEqual({
      GCLOUD_PROJECT: 'demo-hireframe',
      FIRESTORE_EMULATOR_HOST: '127.0.0.1:8080',
    });
  });
});

describe('the emulator defaults for a hand-run dev-worker', () => {
  it('fills unset variables with the demo project and emulator hosts', () => {
    const env = withEmulatorDefaults({ PATH: '/bin' });
    expect(env).toMatchObject(DEV_EMULATOR_ENV);
    expect(env.GCLOUD_PROJECT).toMatch(/^demo-/);
    expect(env.PATH).toBe('/bin');
  });

  it('never overrides a variable that is set, so a non-demo project is still refused downstream', () => {
    const env = withEmulatorDefaults({
      GCLOUD_PROJECT: 'hireframe-f6b03',
      FIRESTORE_EMULATOR_HOST: 'localhost:9000',
    });
    expect(env.GCLOUD_PROJECT).toBe('hireframe-f6b03');
    expect(env.FIRESTORE_EMULATOR_HOST).toBe('localhost:9000');
    expect(env.FIREBASE_STORAGE_EMULATOR_HOST).toBe(
      DEV_EMULATOR_ENV.FIREBASE_STORAGE_EMULATOR_HOST,
    );
    expect(() => assertDemoProject(env.GCLOUD_PROJECT)).toThrow(/demo-\*/);
  });
});

describe('application pipeline seed (M7 7D.2)', () => {
  const now = new Date('2026-10-14T08:00:00Z');
  const jobs = new Map(devJobDocuments(now).map((item) => [item.id, JobSchema.parse(item.job)]));

  it('seeds a CV header the schema accepts', () => {
    expect(CvHeaderSchema.safeParse(cvHeaderSeed(now)).success).toBe(true);
  });

  it('seeds one application per stage, each valid and on an existing job', () => {
    const seeded = [readyApplicationSeed(now), ...applicationSeeds(now)];
    expect(seeded.map((item) => ApplicationSchema.parse(item.data).stage).sort()).toEqual([
      'applied',
      'chosen',
      'generating',
      'generating',
      'needs_input',
    ]);
    for (const { jobId, data } of seeded) {
      const job = jobs.get(jobId);
      expect(job, jobId).toBeDefined();
      expect(data.job).toMatchObject({ title: job?.title, company: job?.company });
    }
  });

  it('seeds one Chosen application, blocked after two invalid drafts, on a job with a deep read', () => {
    const seeds = new Map(applicationSeeds(now).map((item) => [item.jobId, item.data]));
    const blocked = ApplicationSchema.parse(seeds.get(DEV_BLOCKED_JOB_ID));
    expect(blocked.stage).toBe('chosen');
    expect(blocked.blocked?.code).toBe('invalid_output');
    expect(blocked.attempt).toBe(2);
    expect(blocked.lastIssues).toEqual(['unsupported_number', 'too_long']);
    // Retry needs a verdict and a deep read to put it back at generating.
    expect(jobs.get(DEV_BLOCKED_JOB_ID)?.deep).toBeDefined();
    expect(jobs.get(DEV_BLOCKED_JOB_ID)?.status).not.toBe('applied');
  });

  it('seeds Needs your input with two open questions and Applied on an applied job', () => {
    const seeds = new Map(applicationSeeds(now).map((item) => [item.jobId, item.data]));
    const needs = ApplicationSchema.parse(seeds.get(DEV_NEEDS_INPUT_JOB_ID));
    expect(needs.questions).toHaveLength(2);
    expect(needs.questions.every((q) => q.answer === undefined)).toBe(true);
    // The seed carries literal IDs (it can't import shared's applications.ts under Node).
    for (const q of needs.questions) expect(q.id).toBe(questionId(q.requirement));
    expect(ApplicationSchema.parse(seeds.get(DEV_GENERATING_JOB_ID)).stage).toBe('generating');
    expect(ApplicationSchema.parse(seeds.get(DEV_APPLIED_JOB_ID)).stage).toBe('applied');
    expect(jobs.get(DEV_APPLIED_JOB_ID)?.status).toBe('applied');
    // The ready one starts at generating: the worker pass writes its CV.
    expect(readyApplicationSeed(now).jobId).toBe(DEV_READY_JOB_ID);
    expect(jobs.get(DEV_READY_JOB_ID)?.deep).toBeDefined();
  });
});
