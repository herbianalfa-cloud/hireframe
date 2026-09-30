import type { AppConfig } from '@hireframe/shared';
import { onCall, type CallableOptions } from 'firebase-functions/https';
import { defineSecret } from 'firebase-functions/params';

import { bucket, db } from '../admin.js';
import { requireOwner } from '../auth.js';
import {
  ANTHROPIC_SECRET_NAME,
  CALLABLE,
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
import { firestoreProfileStore } from './store.js';

const anthropicApiKey = defineSecret(ANTHROPIC_SECRET_NAME);

/**
 * The emulator runs without App Check (local dev has no reCAPTCHA) and with the fake LLM unless
 * LIVE=1. Deployed functions never see FUNCTIONS_EMULATOR, so production always enforces App
 * Check, consumes the token (replay protection for calls that spend money) and calls Anthropic.
 */
const inEmulator = process.env.FUNCTIONS_EMULATOR === 'true';
const useFakeLlm = inEmulator && process.env.LIVE !== '1';

function llmFor(config: AppConfig) {
  const deps: LlmCallDeps = {
    transport: useFakeLlm ? fakeTransport() : anthropicTransport(anthropicApiKey.value()),
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

const baseOptions: CallableOptions = {
  enforceAppCheck: !inEmulator,
  consumeAppCheckToken: !inEmulator,
  secrets: [anthropicApiKey],
  memory: CALLABLE.memory,
};

export const parseCv = onCall(
  { ...baseOptions, timeoutSeconds: CALLABLE.parseCvTimeoutSeconds },
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
  { ...baseOptions, timeoutSeconds: CALLABLE.addFactTimeoutSeconds },
  safeHandler('addFact', async (request) => {
    const config = await requireOwner(request);
    return addFactHandler(request.data, {
      store: firestoreProfileStore(db()),
      llm: llmFor(config),
      now: () => new Date(),
    });
  }),
);
