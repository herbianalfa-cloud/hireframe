import { describe, expect, it } from 'vitest';

import { assertLoadTestEnvironment } from './environment.js';

const GOOD: NodeJS.ProcessEnv = {
  GCLOUD_PROJECT: 'demo-hireframe-load',
  FIRESTORE_EMULATOR_HOST: '127.0.0.1:8080',
  FIREBASE_STORAGE_EMULATOR_HOST: '127.0.0.1:9199',
};

describe('assertLoadTestEnvironment', () => {
  it('accepts a demo project with both emulators', () => {
    expect(assertLoadTestEnvironment(GOOD)).toBe('demo-hireframe-load');
    expect(
      assertLoadTestEnvironment({
        ...GOOD,
        GOOGLE_CLOUD_PROJECT: 'demo-hireframe-load',
        FIREBASE_CONFIG: JSON.stringify({ projectId: 'demo-hireframe-load' }),
      }),
    ).toBe('demo-hireframe-load');
  });

  it.each([
    ['a real GCLOUD_PROJECT', { GCLOUD_PROJECT: 'real-project' }],
    ['an unset GCLOUD_PROJECT', { GCLOUD_PROJECT: undefined }],
    ['a real GOOGLE_CLOUD_PROJECT', { GOOGLE_CLOUD_PROJECT: 'real-project' }],
    ['a real FIREBASE_CONFIG', { FIREBASE_CONFIG: JSON.stringify({ projectId: 'real-project' }) }],
    ['an unreadable FIREBASE_CONFIG', { FIREBASE_CONFIG: 'not json' }],
    ['LIVE=1', { LIVE: '1' }],
    ['a missing Firestore emulator', { FIRESTORE_EMULATOR_HOST: undefined }],
    ['a missing Storage emulator', { FIREBASE_STORAGE_EMULATOR_HOST: undefined }],
  ])('refuses %s', (_name, override) => {
    expect(() => assertLoadTestEnvironment({ ...GOOD, ...override })).toThrow();
  });
});
