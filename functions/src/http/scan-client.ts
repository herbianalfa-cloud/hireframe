import { hostPolicy, SCAN } from '../config.js';
import { log } from '../log.js';
import { createHttpClient, type HostPause, type HttpClient } from './client.js';

/**
 * The HTTP client scans use (ADR-029): HireframeBot User-Agent, per-host spacing, robots.txt,
 * retries, a run deadline and pauses carried over from earlier runs. Shared by the source fetch
 * and the funnel's Reed hydration.
 */
export function scanHttpClient(
  fetchImpl: typeof fetch,
  deadline: number,
  paused: readonly HostPause[],
): HttpClient {
  return createHttpClient({
    fetch: fetchImpl,
    now: Date.now,
    sleep: (ms) =>
      new Promise((resolve) => {
        setTimeout(resolve, ms);
      }),
    random: Math.random,
    userAgent: SCAN.userAgent,
    productToken: SCAN.productToken,
    hostPolicy,
    maxAttempts: SCAN.maxAttempts,
    backoffBaseMs: SCAN.backoffBaseMs,
    retryAfterCapMs: SCAN.retryAfterCapMs,
    maxBodyBytes: SCAN.maxBodyBytes,
    deadline,
    paused,
    log: (level, event, fields) => {
      log[level](event, fields);
    },
  });
}
