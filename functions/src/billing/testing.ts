import type { BillingClientDeps } from './client.js';

/** Test helpers for the billing guard: a scripted Google (metadata + Cloud Billing) and a fake clock. */

export const TOKEN = 'ya29.test-token-value-must-never-be-logged';
export const PROJECT = 'hireframe-test-1234';

export interface FakeCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | undefined;
}

export interface FakeGoogle {
  /** Answers by `METHOD host/path`; a value is used for every call, an array one per call (last repeats). */
  routes: Record<string, Response | Error | (Response | Error)[]>;
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

export function okRoutes(billingEnabled: boolean): FakeGoogle['routes'] {
  return {
    // The documented leaf answers plain text, with a trailing newline some servers add.
    'GET metadata.google.internal/computeMetadata/v1/project/project-id': new Response(
      `${PROJECT}\n`,
      { headers: { 'Content-Type': 'text/plain' } },
    ),
    'GET metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token': json(
      {
        access_token: TOKEN,
        expires_in: 3000,
        token_type: 'Bearer',
      },
    ),
    [`GET cloudbilling.googleapis.com/v1/projects/${PROJECT}/billingInfo`]: json({
      name: `projects/${PROJECT}/billingInfo`,
      billingEnabled,
      ...(billingEnabled ? { billingAccountName: 'billingAccounts/000000-000000-000000' } : {}),
    }),
    [`PUT cloudbilling.googleapis.com/v1/projects/${PROJECT}/billingInfo`]: json({
      name: `projects/${PROJECT}/billingInfo`,
      billingEnabled: false,
    }),
  };
}

export function fakeGoogle(routes: FakeGoogle['routes']) {
  let clock = 1_000_000;
  const calls: FakeCall[] = [];
  const logs: { event: string; fields: Record<string, unknown> }[] = [];
  const counters = new Map<string, number>();
  const fetchFake = (input: URL | string, init?: RequestInit): Promise<Response> => {
    const url = new URL(input.toString());
    const method = init?.method ?? 'GET';
    calls.push({
      url: input.toString(),
      method,
      headers: { ...(init?.headers as Record<string, string>) },
      body: typeof init?.body === 'string' ? init.body : undefined,
    });
    const key = `${method} ${url.host}${url.pathname}`;
    const route = routes[key];
    if (route === undefined) return Promise.resolve(new Response('', { status: 404 }));
    const seen = counters.get(key) ?? 0;
    counters.set(key, seen + 1);
    const reply = Array.isArray(route)
      ? (route[Math.min(seen, route.length - 1)] ?? route[0])
      : route;
    if (reply instanceof Error) return Promise.reject(reply);
    return Promise.resolve(reply?.clone() ?? new Response('', { status: 404 }));
  };
  const deps: BillingClientDeps = {
    fetch: fetchFake as typeof fetch,
    now: () => clock,
    sleep: (ms) => {
      clock += ms;
      return Promise.resolve();
    },
    random: () => 0,
    deadline: clock + 45_000,
    log: (_level, event, fields) => logs.push({ event, fields }),
  };
  return {
    deps,
    calls,
    logs,
    advance: (ms: number) => (clock += ms),
    puts: () => calls.filter((call) => call.method === 'PUT'),
  };
}

export function timeoutError(): Error {
  const error = new Error('timed out');
  error.name = 'TimeoutError';
  return error;
}
