/**
 * Toolchain pins (ADR-008 addendum): the toolchain is Node 24, Cloud Functions stays nodejs22,
 * and the lockfile holds one copy of each Firebase web package (a second @firebase/app would give
 * App Check and the Functions SDK a different registry from firebase/app).
 */
import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

const FIREBASE_WEB_PACKAGES = ['app', 'app-check', 'auth', 'firestore', 'functions', 'storage'];

interface Lockfile {
  packages: Record<string, unknown>;
}

const lock = JSON.parse(readFileSync('package-lock.json', 'utf8')) as Lockfile;

describe('package-lock.json', () => {
  it.each(FIREBASE_WEB_PACKAGES)('has exactly one copy of @firebase/%s', (name) => {
    const suffix = `node_modules/@firebase/${name}`;
    const copies = Object.keys(lock.packages).filter(
      (path) => path === suffix || path.endsWith(`/${suffix}`),
    );
    expect(copies).toEqual([suffix]);
  });
});

describe('Node pins', () => {
  const read = (path: string): string => readFileSync(path, 'utf8');

  it('keeps Cloud Functions on nodejs22 in firebase.json, the esbuild target and the deploy engines', () => {
    expect(read('firebase.json')).toMatch(/"runtime":\s*"nodejs22"/);
    const build = read('scripts/build-functions.ts');
    expect(build).toContain("target: 'node22'");
    expect(build).toContain("engines: { node: '22' }");
  });

  it('smokes the functions bundle on the same Node major in ci.yml', () => {
    const ci = read('.github/workflows/ci.yml');
    expect(ci).toMatch(/node-version: '22'\n\s+- name: Smoke the functions bundle on Node 22/);
  });

  it('has an .nvmrc major of at least 24 inside the root engines range', () => {
    const major = Number(read('.nvmrc').trim().split('.')[0]);
    const engines = (JSON.parse(read('package.json')) as { engines: { node: string } }).engines
      .node;
    expect(major).toBeGreaterThanOrEqual(24);
    expect(engines).toBe(`>=24.15 <${major + 1}`);
  });
});
