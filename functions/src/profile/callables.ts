// Must stay the first import: global options apply only to functions defined after it.
import '../options.js';

import { CALLABLE_TIMEOUT_SECONDS, type AppConfig } from '@hireframe/shared';
import { onCall, type CallableOptions } from 'firebase-functions/https';
import { defineSecret } from 'firebase-functions/params';

import { bucket, db } from '../admin.js';
import { requireOwner } from '../auth.js';
import { ownerOptions, useFakes } from '../callable.js';
import {
  ANTHROPIC_SECRET_NAME,
  DEFAULT_FX_USD_TO_GBP,
  DEFAULT_MONTHLY_CAP_PENCE,
} from '../config.js';
import { extractText } from '../cv/extract.js';
import { safeHandler } from '../errors.js';
import { llmCall, type LlmCallDeps, type LlmCallInput } from '../llm/call.js';
import { fakeTransport } from '../llm/fake-transport.js';
import { anthropicTransport } from '../llm/transport.js';
import { firestoreUsageStore } from '../llm/usage-store.js';
import { addFactHandler } from './addFact.js';
import { parseCvHandler } from './parseCv.js';
import { resetProfileHandler } from './reset.js';
import { bucketFileDeleter, firestoreProfileStore, firestoreResetStore } from './store.js';

const anthropicApiKey = defineSecret(ANTHROPIC_SECRET_NAME);

function llmFor(config: AppConfig) {
  const deps: LlmCallDeps = {
    transport: useFakes ? fakeTransport() : anthropicTransport(anthropicApiKey.value()),
    usage: firestoreUsageStore(db()),
    capPence: config.monthlyCapPence ?? DEFAULT_MONTHLY_CAP_PENCE,
    fxUsdToGbp: config.fxUsdToGbp ?? DEFAULT_FX_USD_TO_GBP,
  };
  return <T>(input: LlmCallInput<T>) => llmCall(deps, input);
}

async function readFile(path: string): Promise<Uint8Array | null> {
  const file = bucket().file(path);
  const [exists] = await file.exists();
  if (!exists) return null;
  const [contents] = await file.download();
  return new Uint8Array(contents);
}

/** Only callables that call the model mount the Anthropic key. */
const llmOptions: CallableOptions = { ...ownerOptions, secrets: [anthropicApiKey] };

export const parseCv = onCall(
  { ...llmOptions, timeoutSeconds: CALLABLE_TIMEOUT_SECONDS.parseCv },
  safeHandler('parseCv', async (request) => {
    const config = await requireOwner(request);
    return parseCvHandler(request.data, {
      store: firestoreProfileStore(db()),
      readFile,
      extract: extractText,
      llm: llmFor(config),
      now: () => new Date(),
    });
  }),
);

export const addFact = onCall(
  { ...llmOptions, timeoutSeconds: CALLABLE_TIMEOUT_SECONDS.addFact },
  safeHandler('addFact', async (request) => {
    const config = await requireOwner(request);
    return addFactHandler(request.data, {
      store: firestoreProfileStore(db()),
      llm: llmFor(config),
      now: () => new Date(),
    });
  }),
);

export const resetProfile = onCall(
  { ...ownerOptions, timeoutSeconds: CALLABLE_TIMEOUT_SECONDS.resetProfile },
  safeHandler('resetProfile', async (request) => {
    await requireOwner(request);
    return resetProfileHandler(request.data, {
      store: firestoreResetStore(db()),
      deleteFiles: bucketFileDeleter(bucket()),
      now: () => new Date(),
    });
  }),
);
