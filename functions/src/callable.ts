import type { CallableOptions } from 'firebase-functions/https';

import { CALLABLE, REGION } from './config.js';
import type * as DevFakesModule from './dev-fakes.js';

/**
 * The emulator runs without App Check (local dev has no reCAPTCHA) and with fakes for the model
 * and the job sources unless LIVE=1. Deployed functions never see FUNCTIONS_EMULATOR, so
 * production always enforces App Check, consumes the token (replay protection for calls that
 * spend money or hit external APIs) and calls the real services.
 */
export const inEmulator = process.env.FUNCTIONS_EMULATOR === 'true';
export const useFakes = inEmulator && process.env.LIVE !== '1';

type DevFakes = typeof DevFakesModule;

/**
 * The emulator's fakes. `process.env.HIREFRAME_DEV_BUNDLE` is replaced at build time
 * (scripts/build-functions.ts): only `npm run dev` sets it, so in production bundles this branch
 * is dead code and esbuild leaves the fixtures out (the bundle smoke test checks).
 */
export function loadDevFakes(): Promise<DevFakes> {
  if (process.env.HIREFRAME_DEV_BUNDLE) return import('./dev-fakes.js');
  return Promise.reject(
    new Error('This functions bundle has no dev fakes. Run the emulator with `npm run dev`.'),
  );
}

/** Options every owner callable shares (ADR-017). */
export const ownerOptions: CallableOptions = {
  region: REGION, // also set globally; stated here so a callable can never land elsewhere
  enforceAppCheck: !inEmulator,
  consumeAppCheckToken: !inEmulator,
  memory: CALLABLE.memory,
};
