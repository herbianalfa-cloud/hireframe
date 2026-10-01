/**
 * Callable deployment facts shared by functions and web (ADR-017), so the two can't drift.
 * The client waits a margin longer than the server timeout, so a slow call ends with the
 * server's answer (or its timeout), never a client-side give-up while the server still runs.
 */
export const FUNCTIONS_REGION = 'europe-west2';

export const CALLABLE_TIMEOUT_SECONDS = {
  parseCv: 540,
  addFact: 120,
} as const;

export type CallableName = keyof typeof CALLABLE_TIMEOUT_SECONDS;

export const CLIENT_TIMEOUT_MARGIN_MS = 20_000;

export function clientTimeoutMs(name: CallableName): number {
  return CALLABLE_TIMEOUT_SECONDS[name] * 1000 + CLIENT_TIMEOUT_MARGIN_MS;
}
