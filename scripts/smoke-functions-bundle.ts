/**
 * CI smoke test for the functions deploy bundle (ADR-017), run after `npm run build`: the
 * bundle imports cleanly and every function it exports is deployed to europe-west2 only.
 */
const REGION = 'europe-west2';

// A computed specifier: the bundle is a build output with no type declarations.
const bundleUrl = new URL('../functions/deploy/index.js', import.meta.url).href;
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
const { readdirSync, readFileSync, statSync } = await import('node:fs');
// index.js and the chunks it loads on demand (build-functions.ts splits dynamic imports out).
const deployDir = new URL('../functions/deploy/', import.meta.url);
const bundleFiles = [
  'index.js',
  ...readdirSync(new URL('chunks/', deployDir)).map((f) => `chunks/${f}`),
].filter((file) => file.endsWith('.js'));
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
