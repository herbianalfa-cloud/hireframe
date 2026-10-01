/**
 * `npm run dev`: runs inside `firebase emulators:exec --project demo-hireframe`, seeds a
 * fake owner (Auth user + `config/app`) and criteria v1, then starts the Vite dev server.
 * Callables run in the Functions emulator with a fake LLM unless LIVE=1 (ADR-017).
 * Stopping Vite (Ctrl+C) stops the emulators too.
 */
import { spawn } from 'node:child_process';

import {
  appConfigDocument,
  assertDemoProject,
  criteriaSeedDocuments,
  DEV_LINKEDIN_JOB_ID,
  DEV_OWNER,
  linkedInJobDocuments,
  ownerAccountBody,
} from './dev-seed.ts';

const projectId = assertDemoProject(process.env.GCLOUD_PROJECT);
const authHost = process.env.FIREBASE_AUTH_EMULATOR_HOST;
const firestoreHost = process.env.FIRESTORE_EMULATOR_HOST;
if (!authHost || !firestoreHost) {
  throw new Error('Auth and Firestore emulators must be running (use `npm run dev`).');
}

// Emulator REST calls with `Bearer owner` bypass security rules (emulator only).
async function emulatorRequest(method: string, url: string, body: unknown): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    try {
      const res = await fetch(url, {
        method,
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer owner' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(5000),
      });
      if (!res.ok) throw new Error(`${method} ${url} -> ${String(res.status)} ${await res.text()}`);
      return;
    } catch (error) {
      if (attempt >= 3) throw error;
      console.error(JSON.stringify({ level: 'warn', event: 'dev.seed_retry', attempt }));
      await new Promise((resolve) => setTimeout(resolve, 250 * 2 ** (attempt - 1)));
    }
  }
}

await emulatorRequest(
  'POST',
  `http://${authHost}/identitytoolkit.googleapis.com/v1/projects/${projectId}/accounts:batchCreate`,
  ownerAccountBody(),
);
const documents = `http://${firestoreHost}/v1/projects/${projectId}/databases/(default)/documents`;
const now = new Date();
await emulatorRequest('PATCH', `${documents}/config/app`, appConfigDocument(now));
const criteria = criteriaSeedDocuments(now);
await emulatorRequest('PATCH', `${documents}/criteria/v1`, criteria.v1);
await emulatorRequest('PATCH', `${documents}/criteria/current`, criteria.current);
const linkedIn = linkedInJobDocuments(now);
await emulatorRequest('PATCH', `${documents}/jobs/${DEV_LINKEDIN_JOB_ID}`, linkedIn.job);
await emulatorRequest(
  'PATCH',
  `${documents}/jobs/${DEV_LINKEDIN_JOB_ID}/description/raw`,
  linkedIn.description,
);

console.log(
  `dev: seeded owner "${DEV_OWNER.displayName}" (${DEV_OWNER.email}), criteria v1 and one fake ` +
    'LinkedIn-alert job. ' +
    'In the sign-in pop-up pick that account; "Add new account" gives a non-owner. ' +
    `CV and note parsing use ${process.env.LIVE === '1' ? 'the real Anthropic API (LIVE=1)' : 'a fake model'}; ` +
    'run `node scripts/make-cv-fixtures.ts` for fake CVs to upload. ' +
    `System → Scan now uses ${process.env.LIVE === '1' ? 'the real job APIs (LIVE=1)' : 'fake job APIs'}.`,
);

const vite = spawn('npm', ['run', 'dev', '-w', '@hireframe/web'], { stdio: 'inherit' });
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => vite.kill(signal));
}
vite.on('exit', (code) => {
  process.exit(code ?? 0);
});
