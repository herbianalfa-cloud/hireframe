import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

// Each case builds a small fake `web/dist` and runs the real script against it, so the failure
// branches (worker count, fonts folder, marker, caps) are exercised without a Vite build.
const HTML = `<!doctype html><html><head>
<link rel="preload" href="/__/firebase/init.json" as="fetch" crossorigin>
<script type="module" src="/assets/index-a.js"></script>
</head><body></body></html>`;

interface Fixture {
  html: string;
  files: Record<string, string | Buffer>;
}

function healthy(): Fixture {
  return {
    html: HTML,
    files: {
      'assets/index-a.js': 'export const app = 1;',
      'assets/pdf-a.js': 'class PDFWorker {} export { PDFWorker };',
      'assets/pdf.worker.min-a.mjs': 'export const worker = 1;',
      'assets/pdfjs-6.4.299/standard_fonts/Font.ttf': 'font',
    },
  };
}

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

function without(fixture: Fixture, path: string): Fixture {
  const files = Object.entries(fixture.files).filter(([name]) => name !== path);
  return { ...fixture, files: Object.fromEntries(files) };
}

describe('check-bundle', () => {
  it('passes a healthy dist', () => {
    const result = run(healthy());
    expect(result.out).toContain('check-bundle:');
    expect(result.code).toBe(0);
  });

  it('fails when there is no pdf.js worker, or two', () => {
    const none = run(without(healthy(), 'assets/pdf.worker.min-a.mjs'));
    expect(none.code).toBe(1);
    expect(none.out).toContain('expected exactly one pdf.js worker asset, found 0');
    const two = healthy();
    two.files['assets/pdf.worker.min-b.mjs'] = 'export const worker = 2;';
    expect(run(two).out).toContain('found 2');
  });

  it('fails when the worker is over its cap', () => {
    const fixture = healthy();
    fixture.files['assets/pdf.worker.min-a.mjs'] = Buffer.alloc(1400 * 1000 + 1, 'a');
    const result = run(fixture);
    expect(result.code).toBe(1);
    expect(result.out).toMatch(/pdf\.worker\.min-a\.mjs is 1400\.0 kB/);
  });

  it('fails when there is no fonts folder, or two', () => {
    const none = run(without(healthy(), 'assets/pdfjs-6.4.299/standard_fonts/Font.ttf'));
    expect(none.code).toBe(1);
    expect(none.out).toContain('expected exactly one pdf.js fonts folder, found 0');
    const two = healthy();
    two.files['assets/pdfjs-6.5.0/standard_fonts/Font.ttf'] = 'font';
    expect(run(two).out).toContain('expected exactly one pdf.js fonts folder, found 2');
  });

  it('names a fonts folder without standard_fonts instead of throwing', () => {
    const fixture = without(healthy(), 'assets/pdfjs-6.4.299/standard_fonts/Font.ttf');
    fixture.files['assets/pdfjs-6.4.299/other.txt'] = 'x';
    const result = run(fixture);
    expect(result.code).toBe(1);
    expect(result.out).toContain('pdfjs-6.4.299 has no standard_fonts folder');
    expect(result.out).not.toContain('ENOENT');
  });

  it('fails when a font is over its cap, or the fonts are over the total', () => {
    const big = healthy();
    big.files['assets/pdfjs-6.4.299/standard_fonts/Big.ttf'] = Buffer.alloc(200 * 1000 + 1, 'a');
    expect(run(big).out).toContain('pdfjs-6.4.299/Big.ttf is 200.0 kB');
    const many = healthy();
    for (let i = 0; i < 5; i += 1) {
      many.files[`assets/pdfjs-6.4.299/standard_fonts/F${String(i)}.ttf`] = Buffer.alloc(
        190 * 1000,
        'a',
      );
    }
    expect(run(many).out).toContain('pdf.js fonts total');
  });

  it('fails when pdf.js is in an initial file, .js or .mjs', () => {
    const inEntry = healthy();
    inEntry.files['assets/index-a.js'] = 'class PDFWorker {}';
    const entry = run(inEntry);
    expect(entry.code).toBe(1);
    expect(entry.out).toContain('assets/index-a.js contains pdf.js');
    const inModule = healthy();
    inModule.html = HTML.replace(
      '</head>',
      '<link rel="modulepreload" href="/assets/vendor-a.mjs"></head>',
    );
    inModule.files['assets/vendor-a.mjs'] = 'class PDFWorker {}';
    expect(run(inModule).out).toContain('assets/vendor-a.mjs contains pdf.js');
  });

  it('fails when no lazy chunk carries the marker, or two do', () => {
    const none = run(without(healthy(), 'assets/pdf-a.js'));
    expect(none.code).toBe(1);
    expect(none.out).toContain('expected exactly one lazy chunk with the pdf.js marker');
    const two = healthy();
    two.files['assets/pdf-b.js'] = 'class PDFWorker {}';
    expect(run(two).out).toContain('found 2');
  });

  it('says it is the pdf.js chunk, and points at ADR-065, when that chunk is over the cap', () => {
    const fixture = healthy();
    fixture.files['assets/pdf-a.js'] = `class PDFWorker {}${' '.repeat(500 * 1000)}`;
    const result = run(fixture);
    expect(result.code).toBe(1);
    expect(result.out).toMatch(/pdf-a\.js is 500\.\d kB .*pdf\.js chunk.*ADR-065/);
  });

  it('keeps the generic message for any other chunk over the cap', () => {
    const fixture = healthy();
    fixture.files['assets/Other-a.js'] = 'a'.repeat(500 * 1000 + 1);
    const result = run(fixture);
    expect(result.out).toMatch(/Other-a\.js is 500\.0 kB \(max 500\.0 kB\)\n/);
    expect(result.out).not.toContain('ADR-065');
  });

  it('fails on a missing init.json preload', () => {
    const fixture = healthy();
    fixture.html = HTML.replace(/<link[^>]*>/, '');
    expect(run(fixture).out).toContain('no preload for /__/firebase/init.json');
  });
});
