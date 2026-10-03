/**
 * Spaces request starts to at most `perMinute` (Anthropic's rate limits, ADR-035). Shared by the
 * workers of one stage, so concurrency never raises the start rate.
 */
export interface Pacer {
  wait(): Promise<void>;
}

export function createPacer(
  perMinute: number,
  clock: () => number,
  sleep: (ms: number) => Promise<void>,
): Pacer {
  const intervalMs = 60_000 / Math.max(1, perMinute);
  let nextAt = 0;
  return {
    async wait() {
      const now = clock();
      const at = Math.max(now, nextAt);
      nextAt = at + intervalMs;
      if (at > now) await sleep(at - now);
    },
  };
}
