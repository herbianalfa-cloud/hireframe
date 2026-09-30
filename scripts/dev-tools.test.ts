import { describe, expect, it } from 'vitest';

import { isCiDeploy } from './assert-ci.ts';
import { appConfigDocument, assertDemoProject, DEV_OWNER, ownerAccountBody } from './dev-seed.ts';

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
