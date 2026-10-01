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
console.log(`smoke-functions-bundle: ${names.join(', ')} in ${REGION}`);
