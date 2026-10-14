/**
 * Callable deployment facts shared by functions and web (ADR-017), so the two can't drift.
 * The client waits a margin longer than the server timeout, so a slow call ends with the
 * server's answer (or its timeout), never a client-side give-up while the server still runs.
 */
export { FUNCTIONS_REGION } from './firestore.js';

export const CALLABLE_TIMEOUT_SECONDS = {
  parseCv: 540,
  addFact: 120,
  resetProfile: 120,
  /** Delete all my data: one bounded pass per call; the client repeats it (ADR-057). */
  deleteAllData: 120,
  scanNow: 540,
  rescore: 540,
  /** Lookup judges a paste of up to 50 jobs on the spot (ADR-049). */
  lookup: 300,
  /** An HTTPS function, not a callable: the table is where timeout budgets are checked. */
  ingestEmailJobs: 120,
  /** An HTTPS function: the digest reads Firestore and renders; no model call. */
  getDigest: 60,
  /** The owner's pipeline actions; answers go through the `answerFact` model call (M7). */
  application: 120,
  /** The scheduled CV worker; an `onSchedule` function, so the table is where budgets are checked. */
  generateCvs: 540,
} as const;

export type CallableName = keyof typeof CALLABLE_TIMEOUT_SECONDS;

export const CLIENT_TIMEOUT_MARGIN_MS = 20_000;

export function clientTimeoutMs(name: CallableName): number {
  return CALLABLE_TIMEOUT_SECONDS[name] * 1000 + CLIENT_TIMEOUT_MARGIN_MS;
}

/**
 * What the owner reads when the server refuses an App Check token it has already consumed. The
 * first delivery may have run, so the words say to check the page, not to send it again. The
 * code stays `permission-denied`; only the words change, so the replay check is as strict as before.
 */
export const APP_CHECK_REPLAY_MESSAGE =
  'This request may already have gone through. Check the page before you try again.';
