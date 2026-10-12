import { AppConfigSchema } from '@hireframe/shared';

import { bucket, db } from '../admin.js';
import { readAppConfigFromFirestore } from '../auth.js';
import { fakeTransport } from '../llm/fake-transport.js';
import { anthropicTransport } from '../llm/transport.js';
import { runCvWorker, type WorkerSummary } from './worker.js';
import { cvWorkerDeps } from './worker-wiring.js';

/**
 * One pass of the CV worker against the emulators (`node scripts/dev-worker.ts`). The Functions
 * emulator does not fire schedules, so this is how `npm run dev` turns a `generating` application
 * into a CV. It refuses any project that isn't `demo-*` (ADR-013) and uses the fake model unless
 * LIVE=1 with `ANTHROPIC_API_KEY` in the environment. Not imported by any function: it is not in
 * the deploy bundle.
 */
export async function runDevWorker(): Promise<WorkerSummary> {
  const project = process.env.GCLOUD_PROJECT ?? '';
  if (!project.startsWith('demo-')) {
    throw new Error(
      `Refusing to run the CV worker against "${project || '(unset)'}": dev-worker only runs against a demo-* emulator project.`,
    );
  }
  if (!process.env.FIRESTORE_EMULATOR_HOST || !process.env.FIREBASE_STORAGE_EMULATOR_HOST) {
    throw new Error('The Firestore and Storage emulators must be running (use `npm run dev`).');
  }
  // The Admin SDK reads its default bucket from here, as it does inside a function.
  process.env.FIREBASE_CONFIG ??= JSON.stringify({
    projectId: project,
    storageBucket: `${project}.appspot.com`,
  });
  const config = AppConfigSchema.parse(await readAppConfigFromFirestore());
  const key = process.env.ANTHROPIC_API_KEY;
  if (process.env.LIVE === '1' && !key) {
    throw new Error('LIVE=1 needs ANTHROPIC_API_KEY in the environment.');
  }
  const transport = process.env.LIVE === '1' && key ? anthropicTransport(key) : fakeTransport();
  return runCvWorker(cvWorkerDeps({ firestore: db(), bucket: bucket(), transport, config }));
}
