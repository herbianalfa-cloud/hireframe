/**
 * `npm run dev`: runs inside `firebase emulators:exec --project demo-hireframe`, seeds a
 * fake owner (Auth user + `config/app`), then starts the Vite dev server. Stopping Vite
 * (Ctrl+C) stops the emulators too.
 */
import { spawn } from 'node:child_process';

import { appConfigDocument, assertDemoProject, DEV_OWNER, ownerAccountBody } from './dev-seed.ts';

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
await emulatorRequest(
  'PATCH',
  `http://${firestoreHost}/v1/projects/${projectId}/databases/(default)/documents/config/app`,
  appConfigDocument(new Date()),
);

console.log(
  `dev: seeded owner "${DEV_OWNER.displayName}" (${DEV_OWNER.email}). ` +
    'In the sign-in pop-up pick that account; "Add new account" gives a non-owner.',
);

const vite = spawn('npm', ['run', 'dev', '-w', '@hireframe/web'], { stdio: 'inherit' });
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => vite.kill(signal));
}
vite.on('exit', (code) => {
  process.exit(code ?? 0);
});
