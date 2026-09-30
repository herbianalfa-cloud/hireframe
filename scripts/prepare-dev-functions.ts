/**
 * `npm run dev` step after the functions build: gives the Functions emulator a value for the
 * ANTHROPIC_API_KEY secret so it never tries Secret Manager (a demo-* project can't reach it).
 * - Default: a placeholder. The emulator uses the fake LLM, which never reads the key.
 * - LIVE=1: copies your key from `functions/.secret.local` (gitignored) for real calls.
 * The file lands in `functions/deploy/`, which is gitignored and whose `*.local` files are
 * excluded from deploys (firebase.json).
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';

const SOURCE = 'functions/.secret.local';
const TARGET = 'functions/deploy/.secret.local';

if (process.env.LIVE === '1') {
  if (!existsSync(SOURCE)) {
    throw new Error(`LIVE=1 needs ${SOURCE} with a line ANTHROPIC_API_KEY=<your key>.`);
  }
  writeFileSync(TARGET, readFileSync(SOURCE));
  console.log('prepare-dev-functions: LIVE=1, using your key from functions/.secret.local');
} else {
  writeFileSync(TARGET, 'ANTHROPIC_API_KEY=emulator-placeholder\n');
}
