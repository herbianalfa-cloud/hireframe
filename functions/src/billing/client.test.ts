import { describe, expect, it } from 'vitest';

import { createBillingClient } from './client.js';
import { fakeGoogle, okRoutes, PROJECT, timeoutError, TOKEN } from './testing.js';

describe('billing client (ADR-059)', () => {
  it('reads the project from the metadata server, sending Metadata-Flavor: Google', async () => {
    const g = fakeGoogle(okRoutes(true));
    await expect(createBillingClient(g.deps).projectId()).resolves.toBe(PROJECT);
    expect(g.calls).toHaveLength(1);
    expect(g.calls[0]?.url).toBe(
      'http://metadata.google.internal/computeMetadata/v1/project/?recursive=true',
    );
    expect(g.calls[0]?.headers['Metadata-Flavor']).toBe('Google');
  });

  it('asks the metadata server for the token with the same header, once', async () => {
    const g = fakeGoogle(okRoutes(true));
    const client = createBillingClient(g.deps);
    await client.billingEnabled(PROJECT);
    await client.billingEnabled(PROJECT);
    const tokenCalls = g.calls.filter((call) =>
      call.url.includes('/service-accounts/default/token'),
    );
    expect(tokenCalls).toHaveLength(1);
    expect(tokenCalls[0]?.headers['Metadata-Flavor']).toBe('Google');
  });

  it('sends the token only to Cloud Billing, never to the metadata server', async () => {
    const g = fakeGoogle(okRoutes(true));
    await createBillingClient(g.deps).billingEnabled(PROJECT);
    for (const call of g.calls) {
      const sent = call.headers.Authorization;
      if (call.url.startsWith('https://cloudbilling.googleapis.com/')) {
        expect(sent).toBe(`Bearer ${TOKEN}`);
      } else {
        expect(sent).toBeUndefined();
      }
    }
  });

  it('PUTs an empty billingAccountName on the project it was given', async () => {
    const g = fakeGoogle(okRoutes(true));
    await expect(createBillingClient(g.deps).disableBilling(PROJECT)).resolves.toEqual({
      stillEnabled: false,
    });
    expect(g.puts()).toHaveLength(1);
    expect(g.puts()[0]?.url).toBe(
      `https://cloudbilling.googleapis.com/v1/projects/${PROJECT}/billingInfo`,
    );
    expect(g.puts()[0]?.body).toBe('{"billingAccountName":""}');
  });

  it('reads billingEnabled false and missing as not enabled', async () => {
    const off = fakeGoogle(okRoutes(false));
    await expect(createBillingClient(off.deps).billingEnabled(PROJECT)).resolves.toBe(false);
  });

  it.each(['', 'a', 'UPPER-case-1234', 'x/../y-1234', 'proj ect-1234', 'p'.repeat(40)])(
    'refuses a project ID that is not a project ID (%j) before any request',
    async (id) => {
      const g = fakeGoogle(okRoutes(true));
      await expect(createBillingClient(g.deps).disableBilling(id)).rejects.toMatchObject({
        code: 'bad_project_id',
      });
      expect(g.calls).toHaveLength(0);
    },
  );

  it('refuses a metadata answer whose project ID is not a project ID', async () => {
    const routes = okRoutes(true);
    routes['GET metadata.google.internal/computeMetadata/v1/project/'] = new Response(
      JSON.stringify({ projectId: '../../etc' }),
    );
    const g = fakeGoogle(routes);
    await expect(createBillingClient(g.deps).projectId()).rejects.toMatchObject({
      code: 'bad_project_id',
    });
  });

  it('retries a 5xx on the PUT 3 times, then fails with the status', async () => {
    const routes = okRoutes(true);
    routes[`PUT cloudbilling.googleapis.com/v1/projects/${PROJECT}/billingInfo`] = new Response(
      '',
      {
        status: 503,
      },
    );
    const g = fakeGoogle(routes);
    await expect(createBillingClient(g.deps).disableBilling(PROJECT)).rejects.toMatchObject({
      code: 'http_status',
      status: 503,
    });
    expect(g.puts()).toHaveLength(3);
  });

  it('retries a timeout 3 times, then fails with code timeout', async () => {
    const routes = okRoutes(true);
    routes[`GET cloudbilling.googleapis.com/v1/projects/${PROJECT}/billingInfo`] = timeoutError();
    const g = fakeGoogle(routes);
    await expect(createBillingClient(g.deps).billingEnabled(PROJECT)).rejects.toMatchObject({
      code: 'timeout',
    });
    expect(
      g.calls.filter((call) => call.url.includes('/billingInfo') && call.method === 'GET'),
    ).toHaveLength(3);
  });

  it('starts no request once the deadline has passed (fake clock)', async () => {
    const g = fakeGoogle(okRoutes(true));
    g.advance(45_001);
    await expect(createBillingClient(g.deps).projectId()).rejects.toMatchObject({
      code: 'deadline',
    });
    expect(g.calls).toHaveLength(0);
  });

  it('keeps the access token out of the logs and the error of a failed PUT', async () => {
    const routes = okRoutes(true);
    routes[`PUT cloudbilling.googleapis.com/v1/projects/${PROJECT}/billingInfo`] = new Response(
      JSON.stringify({ error: { message: `bad token ${TOKEN}` } }),
      { status: 500 },
    );
    const g = fakeGoogle(routes);
    let caught: unknown;
    try {
      await createBillingClient(g.deps).disableBilling(PROJECT);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(Error);
    const error = caught as Error;
    const everything = JSON.stringify({
      logs: g.logs,
      name: error.name,
      message: error.message,
      stack: error.stack,
      error,
    });
    expect(g.logs.length).toBeGreaterThan(0);
    expect(everything).not.toContain(TOKEN);
    expect(everything).not.toContain('ya29');
    expect(everything).not.toContain('Bearer');
  });
});
