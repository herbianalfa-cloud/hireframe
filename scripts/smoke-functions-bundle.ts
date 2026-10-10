/**
 * CI smoke test for the functions deploy bundle (ADR-017), run after `npm run build`: the
 * bundle imports cleanly and every function it exports is deployed to europe-west2 only.
 */
const REGION = 'europe-west2';

// A computed specifier: the bundle is a build output with no type declarations.
const { readdirSync, readFileSync, statSync } = await import('node:fs');
const deployDir = new URL('../functions/deploy/', import.meta.url);
const bundleUrl = new URL('index.js', deployDir).href;
const bundle = (await import(bundleUrl)) as Record<string, unknown>;
const names = Object.keys(bundle);
if (names.length === 0) throw new Error('smoke-functions-bundle: the bundle exports nothing');

const wrong = names.filter((name) => {
  const endpoint = (bundle[name] as { __endpoint?: { region?: string[] } }).__endpoint;
  return JSON.stringify(endpoint?.region) !== JSON.stringify([REGION]);
});
if (wrong.length > 0) {
  throw new Error(`smoke-functions-bundle: not in ${REGION} only: ${wrong.join(', ')}`);
}
// Production bundles never carry the emulator's fixtures (callable.ts `loadDevFakes`).
// index.js and the chunks it loads on demand (build-functions.ts splits dynamic imports out).
const bundleFiles = [
  'index.js',
  ...readdirSync(new URL('chunks/', deployDir)).map((f) => `chunks/${f}`),
].filter((file) => file.endsWith('.js'));

// Every file loads, the lazy chunks (render-*, pdfjs-*) included: a chunk that only fails when
// the worker first needs it would otherwise be found in production.
const unloadable: string[] = [];
for (const file of bundleFiles) {
  try {
    await import(new URL(file, deployDir).href);
  } catch (error) {
    unloadable.push(`${file} (${error instanceof Error ? error.message : String(error)})`);
  }
}
if (unloadable.length > 0) {
  throw new Error(`smoke-functions-bundle: does not load: ${unloadable.join('; ')}`);
}

// The renderer and the PDF reader are for the worker and parseCv only. index.js and every file it
// imports statically are loaded by every function's cold start, so neither may be among them.
const LAZY = /^chunks\/(render|pdfjs)-/;
const STATIC_IMPORT = /\b(?:import|export)\s+(?:[^'"()]*?\s+from\s+)?["']([^"']+)["']/g;
const reached = new Set<string>(['index.js']);
const pending = ['index.js'];
for (let file = pending.pop(); file !== undefined; file = pending.pop()) {
  const from = new URL(file, deployDir);
  for (const match of readFileSync(from, 'utf8').matchAll(STATIC_IMPORT)) {
    const specifier = match[1] ?? '';
    if (!specifier.startsWith('.')) continue;
    const target = new URL(specifier, from).href.slice(deployDir.href.length);
    if (!reached.has(target)) {
      reached.add(target);
      pending.push(target);
    }
  }
}
const lazyReached = [...reached].filter((file) => LAZY.test(file));
if (lazyReached.length > 0) {
  throw new Error(`smoke-functions-bundle: index.js imports statically: ${lazyReached.join(', ')}`);
}
// pdf-lib and docx code, by names only they define; each must exist in the render chunk, so a
// renamed marker fails here instead of passing for the wrong reason.
const renderFile = bundleFiles.find((file) => file.startsWith('chunks/render-'));
if (!renderFile) throw new Error('smoke-functions-bundle: no chunks/render-* file in the bundle');
const renderSource = readFileSync(new URL(renderFile, deployDir), 'utf8');
const indexSource = readFileSync(new URL('index.js', deployDir), 'utf8');
for (const marker of ['PDFRawStream', 'PDFPageLeaf', 'DocumentAttributeNamespaces']) {
  if (!renderSource.includes(marker)) {
    throw new Error(`smoke-functions-bundle: marker ${marker} is not in ${renderFile}`);
  }
  if (indexSource.includes(marker)) {
    throw new Error(`smoke-functions-bundle: pdf-lib or docx code (${marker}) is in index.js`);
  }
}

const source = bundleFiles.map((file) => readFileSync(new URL(file, deployDir), 'utf8')).join('\n');
const kib = (bytes: number) => `${(bytes / 1024).toFixed(0)} KiB`;
const indexBytes = statSync(new URL('index.js', deployDir)).size;
const totalBytes = bundleFiles.reduce((sum, f) => sum + statSync(new URL(f, deployDir)).size, 0);
console.log(
  `smoke-functions-bundle: index.js ${kib(indexBytes)}, ${String(bundleFiles.length)} files ${kib(totalBytes)} in all`,
);
// Acme and Alex: the fake watchlist and CV. The rest: the fake alert emails (M6).
const fixtureMarkers = [
  'Acme Analytics',
  'Alex Example',
  'Pylon Labs',
  'Mallory Systems',
  'Founding Product Analyst',
  'Bramble Software',
  'Meridian Logistics',
  'Roles I noted this week',
  'Larkspur Data',
];
const leaked = fixtureMarkers.filter((marker) => source.includes(marker));
if (leaked.length > 0 && process.env.HIREFRAME_DEV_BUNDLE !== '1') {
  throw new Error(`smoke-functions-bundle: fixture data in the bundle: ${leaked.join(', ')}`);
}
console.log(`smoke-functions-bundle: ${names.join(', ')} in ${REGION}, no fixtures`);
