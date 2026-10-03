import { dedupeKey, JobSchema, normaliseRawJob } from '@hireframe/shared';
import { describe, expect, it } from 'vitest';

import { LINKEDIN_ALERT_JOB } from '../packages/shared/src/fixtures/jobs.ts';

import { isCiDeploy } from './assert-ci.ts';
import {
  appConfigDocument,
  assertDemoProject,
  criteriaSeedDocuments,
  DEV_LINKEDIN_JOB_KEYS,
  DEV_OWNER,
  linkedInJobDocuments,
  ownerAccountBody,
  profileSeedDocuments,
  toRestValue,
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
