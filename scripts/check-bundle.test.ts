import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

// Each case builds a small fake `web/dist` and runs the real script against it, so the failure
// branches are exercised without a Vite build.
const HTML = `<!doctype html><html><head>
<link rel="preload" href="/__/firebase/init.json" as="fetch" crossorigin>
<script type="module" src="/assets/index-a.js"></script>
</head><body></body></html>`;

const MARKER = 'google.firestore.v1.Firestore';

interface Fixture {
  html: string;
  files: Record<string, string>;
}

function healthy(): Fixture {
  return {
    html: HTML,
    files: {
      'assets/index-a.js': 'export const app = 1;',
      'assets/firestore-a.js': `export const rpc = "${MARKER}";`,
    },
  };
}

/** Text that gzip can't shrink, so a fixture reaches a size cap with few bytes. */
const incompressible = (bytes: number) => randomBytes(bytes).toString('hex');

const dirs: string[] = [];
function run(fixture: Fixture) {
  const dist = mkdtempSync(join(tmpdir(), 'check-bundle-'));
  dirs.push(dist);
  writeFileSync(join(dist, 'index.html'), fixture.html);
  for (const [path, content] of Object.entries(fixture.files)) {
    mkdirSync(join(dist, path, '..'), { recursive: true });
    writeFileSync(join(dist, path), content);
  }
  const result = spawnSync(process.execPath, ['scripts/check-bundle.ts'], {
    env: { ...process.env, CHECK_BUNDLE_DIST: dist },
    encoding: 'utf8',
  });
  return { code: result.status, out: `${result.stdout}${result.stderr}` };
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('check-bundle: Firestore (ADR-066)', () => {
  it('passes a clean dist and prints the Firestore line', () => {
    const result = run(healthy());
    expect(result.code).toBe(0);
    expect(result.out).toContain('Firestore (loaded after the core)');
  });

  it('fails when the Firestore SDK is in an initial file', () => {
    const fixture = healthy();
    fixture.files['assets/index-a.js'] = `export const rpc = "${MARKER}";`;
    const result = run(fixture);
    expect(result.code).toBe(1);
    expect(result.out).toContain('is initial JS and contains the Firestore SDK');
  });

  it('fails when the marker is in no chunk, or in two', () => {
    const none = healthy();
    delete none.files['assets/firestore-a.js'];
    const noneResult = run(none);
    expect(noneResult.code).toBe(1);
    expect(noneResult.out).toContain('exactly one chunk, found 0');

    const two = healthy();
    two.files['assets/firestore-b.js'] = `export const rpc = "${MARKER}";`;
    const twoResult = run(two);
    expect(twoResult.code).toBe(1);
    expect(twoResult.out).toContain('exactly one chunk, found 2');
  });

  it('fails when the Firestore chunk is over 165 kB gzip', () => {
    const fixture = healthy();

    fixture.files['assets/firestore-a.js'] = `"${MARKER}"${incompressible(170_000)}`;
    const result = run(fixture);
    expect(result.code).toBe(1);
    expect(result.out).toContain('the Firestore chunk is');
  });

  it('fails when the initial JS is over 200 kB gzip', () => {
    const fixture = healthy();
    fixture.files['assets/index-a.js'] = `export const x = "${incompressible(210_000)}";`;
    const result = run(fixture);
    expect(result.code).toBe(1);
    expect(result.out).toContain('initial JS is');
  });
});
