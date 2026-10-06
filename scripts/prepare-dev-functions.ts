/**
 * `npm run dev` step after the functions build: gives the Functions emulator a value for every
 * secret (ANTHROPIC_API_KEY, REED_API_KEY, ADZUNA_APP_ID, ADZUNA_APP_KEY, INGEST_HMAC_SECRET) so it never tries
 * Secret Manager (a demo-* project can't reach it).
 * - Default: placeholders. The emulator uses the fake LLM and fake job APIs.
 * - LIVE=1: copies your keys from `functions/.secret.local` (gitignored) for real calls. A key
 *   missing there gets the placeholder, and that source shows as "API key missing".
 * The file lands in `functions/deploy/`, which is gitignored and whose `*.local` files are
 * excluded from deploys (firebase.json).
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';

const SOURCE = 'functions/.secret.local';
const TARGET = 'functions/deploy/.secret.local';

const SECRETS = [
  'ANTHROPIC_API_KEY',
  'REED_API_KEY',
  'ADZUNA_APP_ID',
  'ADZUNA_APP_KEY',
  'INGEST_HMAC_SECRET',
];

if (process.env.LIVE === '1') {
  if (!existsSync(SOURCE)) {
    throw new Error(`LIVE=1 needs ${SOURCE} with a line ANTHROPIC_API_KEY=<your key>.`);
  }
  const lines = readFileSync(SOURCE, 'utf8').split(/\r?\n/).filter(Boolean);
  const present = new Set(lines.map((line) => line.split('=')[0]));
  const missing = SECRETS.filter((name) => !present.has(name)).map(
    (name) => `${name}=emulator-placeholder`,
  );
  writeFileSync(TARGET, [...lines, ...missing].join('\n') + '\n');
  console.log('prepare-dev-functions: LIVE=1, using your keys from functions/.secret.local');
} else {
  writeFileSync(TARGET, SECRETS.map((name) => `${name}=emulator-placeholder`).join('\n') + '\n');
}
