import { describe, expect, it } from 'vitest';

import { isCiDeploy } from './assert-ci.ts';
import {
  appConfigDocument,
  assertDemoProject,
  criteriaSeedDocuments,
  DEV_OWNER,
  ownerAccountBody,
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
