import type { CallableOptions } from 'firebase-functions/https';

import { CALLABLE, REGION } from './config.js';

/**
 * The emulator runs without App Check (local dev has no reCAPTCHA) and with fakes for the model
 * and the job sources unless LIVE=1. Deployed functions never see FUNCTIONS_EMULATOR, so
 * production always enforces App Check, consumes the token (replay protection for calls that
 * spend money or hit external APIs) and calls the real services.
 */
export const inEmulator = process.env.FUNCTIONS_EMULATOR === 'true';
export const useFakes = inEmulator && process.env.LIVE !== '1';

/** Options every owner callable shares (ADR-017). */
export const ownerOptions: CallableOptions = {
  region: REGION, // also set globally; stated here so a callable can never land elsewhere
  enforceAppCheck: !inEmulator,
  consumeAppCheckToken: !inEmulator,
  memory: CALLABLE.memory,
};
