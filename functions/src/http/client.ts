import type { z } from 'zod';

import { FORBIDDEN_FETCH_HOSTS } from '../config.js';
import { ALLOW_ALL, robotsFromResponse, type RobotsPolicy } from './robots.js';

/**
 * The one HTTP client every source uses (ADR-025, ADR-029; CLAUDE.md "Every external call").
 * - Identifies itself with a User-Agent.
 * - Spaces request starts per host by the larger of the host's interval and robots Crawl-delay.
 * - Checks robots.txt once per host per client, except for keyed APIs (`api-terms`).
 * - Times out every request, stops at the run deadline, and makes at most 3 attempts with
 *   exponential backoff on 429/5xx/timeouts/network errors (Retry-After honoured up to a cap).
 * - zod-parses every JSON response. 404s and schema errors are never retried.
 * Logging is injected (fixed event names, host + path label only, never a URL: Adzuna's key is
 * in the query string), so the detect-ats script can use this without Firebase.
 */

export type HttpErrorCode =
  | 'not_found'
  | 'http_status'
  | 'rate_limited'
  | 'timeout'
  | 'network'
  | 'invalid_json'
  | 'schema'
  | 'too_large'
  | 'robots_disallowed'
  | 'deadline'
  /** The host asked us to stay away (a Retry-After beyond the cap); no request was made. */
  | 'host_paused'
  /** A host we never fetch (CLAUDE.md hard rule: LinkedIn and the other alert-only boards). */
  | 'forbidden_host';

export class HttpError extends Error {
  override name = 'HttpError';
  readonly code: HttpErrorCode;
  readonly status: number | undefined;
  readonly issues: number | undefined;
  constructor(code: HttpErrorCode, status?: number, issues?: number) {
    super(code);
    this.code = code;
    this.status = status;
    this.issues = issues;
  }
}

export interface HostPolicy {
  /** `enforce`: obey robots.txt. `api-terms`: a keyed API governed by its developer terms. */
  robots: 'enforce' | 'api-terms';
  intervalMs: number;
  timeoutMs: number;
}

export type HttpLogEvent =
  'http.retry' | 'http.failed' | 'http.robots_blocked' | 'http.host_paused' | 'http.forbidden_host';

/** A host that told us to come back later (epoch ms). */
export interface HostPause {
  host: string;
  until: number;
}
export type HttpLog = (
  level: 'info' | 'warn' | 'error',
  event: HttpLogEvent,
  fields: Record<string, string | number | boolean>,
) => void;

export interface HttpClientDeps {
  fetch: typeof fetch;
  /** Epoch milliseconds. */
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  random: () => number;
  userAgent: string;
  /** The robots.txt product token, e.g. `HireframeBot`. */
  productToken: string;
  hostPolicy: (host: string) => HostPolicy;
  maxAttempts: number;
  backoffBaseMs: number;
  retryAfterCapMs: number;
  maxBodyBytes: number;
  /** Epoch ms after which no request starts. */
  deadline?: number;
  /**
   * Hosts (and their subdomains) this client never requests, redirects included: `getJson`
   * throws `forbidden_host` before any fetch, robots.txt included (ADR-004, ADR-049). Defaults to
   * `FORBIDDEN_FETCH_HOSTS`; a client can only be made laxer by passing a shorter list on purpose.
   */
  forbiddenHosts?: readonly string[];
  /** Pauses carried over from earlier runs: no request goes to these hosts until then. */
  paused?: readonly HostPause[];
  log: HttpLog;
}

export interface RequestOptions {
  /** A fixed label for logs, e.g. `greenhouse.board`. Never a URL. */
  label: string;
  headers?: Record<string, string>;
}

export interface HttpClient {
  getJson<T>(url: string, schema: z.ZodType<T>, options: RequestOptions): Promise<T>;
  /** Requests started through this client (each attempt counts; robots.txt fetches don't). */
  requests(): number;
  /** Hosts still paused, to carry into the next run. */
  pauses(): HostPause[];
}

/** Redirect hops followed by hand, each checked against the forbidden hosts. */
const MAX_REDIRECTS = 3;
const REDIRECT_STATUS = new Set([301, 302, 303, 307, 308]);
const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);

function retryAfterMs(header: string | null, now: number): number | null {
  if (!header) return null;
  const seconds = Number(header);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(header);
  return Number.isNaN(date) ? null : Math.max(0, date - now);
}

export function createHttpClient(deps: HttpClientDeps): HttpClient {
  const lastStart = new Map<string, number>();
  const queues = new Map<string, Promise<void>>();
  const robots = new Map<string, Promise<RobotsPolicy>>();
  const pausedUntil = new Map((deps.paused ?? []).map((pause) => [pause.host, pause.until]));
  const pauseLogged = new Set<string>();
  let requestCount = 0;

  /**
   * A host that answered with a Retry-After beyond the cap gets no more requests until then:
   * not from this run's other boards or queries, and not from later runs (pauses are carried
   * over). Logged once per host per client, i.e. per source per run.
   */
  function pauseHost(host: string, until: number, label: string): void {
    pausedUntil.set(host, Math.max(pausedUntil.get(host) ?? 0, until));
    logPause(host, label);
  }

  function logPause(host: string, label: string): void {
    if (pauseLogged.has(host)) return;
    pauseLogged.add(host);
    const until = pausedUntil.get(host) ?? 0;
    deps.log('warn', 'http.host_paused', {
      host,
      label,
      until: new Date(until).toISOString(),
      seconds: Math.max(0, Math.round((until - deps.now()) / 1000)),
    });
  }

  function remaining(): number {
    return deps.deadline === undefined ? Infinity : deps.deadline - deps.now();
  }

  /** Waits for this host's next slot; slots are handed out one at a time, in order. */
  function slot(host: string, intervalMs: number): Promise<void> {
    const previous = queues.get(host) ?? Promise.resolve();
    const next = previous.then(async () => {
      const wait = (lastStart.get(host) ?? -Infinity) + intervalMs - deps.now();
      if (wait > 0) await deps.sleep(wait);
      lastStart.set(host, deps.now());
    });
    queues.set(
      host,
      next.catch(() => undefined),
    );
    return next;
  }

  async function send(
    url: URL,
    policy: HostPolicy,
    intervalMs: number,
    headers: Record<string, string>,
    counted: boolean,
    label: string,
  ): Promise<Response> {
    if (remaining() <= 0) throw new HttpError('deadline');
    await slot(url.host, intervalMs);
    // Checked again after the wait: requests queued behind the one that got the long
    // Retry-After must not go out either.
    if ((pausedUntil.get(url.host) ?? 0) > deps.now()) {
      logPause(url.host, label);
      throw new HttpError('host_paused');
    }
    // Redirects are followed by hand, a few hops at most, and every hop is checked against the
    // forbidden list: a board API must not be able to send us to LinkedIn (ADR-049).
    let target = url;
    for (let hop = 0; ; hop++) {
      const timeoutMs = Math.min(policy.timeoutMs, remaining());
      if (timeoutMs <= 0) throw new HttpError('deadline');
      if (counted) requestCount += 1;
      let response: Response;
      try {
        response = await deps.fetch(target, {
          headers: { 'User-Agent': deps.userAgent, Accept: 'application/json', ...headers },
          redirect: 'manual',
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (error) {
        const name = error instanceof Error ? error.name : '';
        throw new HttpError(
          name === 'TimeoutError' || name === 'AbortError' ? 'timeout' : 'network',
        );
      }
      if (!REDIRECT_STATUS.has(response.status)) return response;
      void response.body?.cancel().catch(() => undefined);
      const location = response.headers.get('location');
      let next: URL | null = null;
      try {
        next = location ? new URL(location, target) : null;
      } catch {
        next = null;
      }
      if (!next || hop >= MAX_REDIRECTS || !/^https?:$/.test(next.protocol)) {
        throw new HttpError('http_status', response.status);
      }
      if (isForbidden(next.hostname)) {
        deps.log('warn', 'http.forbidden_host', { host: next.host, label });
        throw new HttpError('forbidden_host');
      }
      target = next;
      await slot(target.host, Math.max(intervalMs, deps.hostPolicy(target.host).intervalMs));
    }
  }

  async function readBody(response: Response): Promise<string> {
    const declared = Number(response.headers.get('content-length') ?? '0');
    if (declared > deps.maxBodyBytes) throw new HttpError('too_large', response.status);
    const body = await response.text();
    if (body.length > deps.maxBodyBytes) throw new HttpError('too_large', response.status);
    return body;
  }

  function robotsFor(url: URL, policy: HostPolicy): Promise<RobotsPolicy> {
    if (policy.robots === 'api-terms') return Promise.resolve(ALLOW_ALL);
    const cached = robots.get(url.host);
    if (cached) return cached;
    const loading = (async () => {
      try {
        const response = await send(
          new URL('/robots.txt', url.origin),
          policy,
          policy.intervalMs,
          { Accept: 'text/plain' },
          false,
          'robots',
        );
        return robotsFromResponse(
          { status: response.status, body: response.ok ? await readBody(response) : '' },
          deps.productToken,
        );
      } catch (error) {
        if (
          error instanceof HttpError &&
          (error.code === 'deadline' || error.code === 'host_paused')
        ) {
          throw error;
        }
        return robotsFromResponse(null, deps.productToken);
      }
    })();
    robots.set(url.host, loading);
    return loading;
  }

  function isForbidden(hostname: string): boolean {
    const host = hostname.toLowerCase();
    return (deps.forbiddenHosts ?? FORBIDDEN_FETCH_HOSTS).some(
      (banned) => host === banned || host.endsWith(`.${banned}`),
    );
  }

  async function getJson<T>(rawUrl: string, schema: z.ZodType<T>, options: RequestOptions) {
    const url = new URL(rawUrl);
    const policy = deps.hostPolicy(url.host);
    const fields = { host: url.host, label: options.label };
    if (isForbidden(url.hostname)) {
      deps.log('warn', 'http.forbidden_host', fields);
      throw new HttpError('forbidden_host');
    }
    if ((pausedUntil.get(url.host) ?? 0) > deps.now()) {
      logPause(url.host, options.label);
      throw new HttpError('host_paused');
    }
    const rules = await robotsFor(url, policy);
    if (!rules.allows(`${url.pathname}${url.search}`)) {
      deps.log('warn', 'http.robots_blocked', fields);
      throw new HttpError('robots_disallowed');
    }
    const intervalMs = Math.max(policy.intervalMs, rules.crawlDelayMs ?? 0);

    for (let attempt = 1; ; attempt++) {
      let failure: HttpError;
      let waitMs = deps.backoffBaseMs * 2 ** (attempt - 1) * (1 + deps.random() * 0.25);
      try {
        const response = await send(
          url,
          policy,
          intervalMs,
          options.headers ?? {},
          true,
          options.label,
        );
        if (response.ok) {
          const body = await readBody(response);
          let json: unknown;
          try {
            json = JSON.parse(body);
          } catch {
            throw new HttpError('invalid_json', response.status);
          }
          const parsed = schema.safeParse(json);
          if (!parsed.success) {
            throw new HttpError('schema', response.status, parsed.error.issues.length);
          }
          return parsed.data;
        }
        // Not awaited: a cancelled body we don't need must never hold up the run.
        void response.body?.cancel().catch(() => undefined);
        if (response.status === 404 || response.status === 410) {
          throw new HttpError('not_found', response.status);
        }
        if (!RETRYABLE_STATUS.has(response.status)) {
          throw new HttpError('http_status', response.status);
        }
        const after = retryAfterMs(response.headers.get('retry-after'), deps.now());
        if (after !== null && after > deps.retryAfterCapMs) {
          pauseHost(url.host, deps.now() + after, options.label);
          throw new HttpError('rate_limited', response.status);
        }
        if (after !== null) waitMs = Math.max(waitMs, after);
        failure = new HttpError(
          response.status === 429 ? 'rate_limited' : 'http_status',
          response.status,
        );
      } catch (error) {
        if (!(error instanceof HttpError)) throw error;
        // Already logged once per host (http.host_paused); not a request failure.
        if (error.code === 'host_paused') throw error;
        const retryable = error.code === 'timeout' || error.code === 'network';
        if (!retryable) {
          deps.log('warn', 'http.failed', { ...fields, attempt, ...codeFields(error) });
          throw error;
        }
        failure = error;
      }
      if (attempt >= deps.maxAttempts || remaining() <= waitMs) {
        deps.log('warn', 'http.failed', { ...fields, attempt, ...codeFields(failure) });
        throw failure;
      }
      deps.log('info', 'http.retry', {
        ...fields,
        attempt,
        waitMs: Math.round(waitMs),
        ...codeFields(failure),
      });
      await deps.sleep(waitMs);
    }
  }

  return {
    getJson,
    requests: () => requestCount,
    pauses: () =>
      [...pausedUntil.entries()]
        .filter(([, until]) => until > deps.now())
        .map(([host, until]) => ({ host, until })),
  };
}

function codeFields(error: HttpError): Record<string, string | number> {
  return {
    code: error.code,
    ...(error.status === undefined ? {} : { status: error.status }),
    ...(error.issues === undefined ? {} : { issues: error.issues }),
  };
}

/** `Authorization` header for HTTP Basic auth with the key as the user name (Reed). */
export function basicAuth(user: string, password = ''): string {
  return `Basic ${Buffer.from(`${user}:${password}`).toString('base64')}`;
}
