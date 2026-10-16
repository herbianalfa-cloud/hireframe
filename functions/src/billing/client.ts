import { z } from 'zod';

import { BILLING_GUARD, PLAIN_HTTP_HOSTS } from '../config.js';
import { createHttpClient, type HttpLog } from '../http/client.js';

/**
 * The billing guard's only network access (ADR-059): the metadata server (project ID and access
 * token) and Cloud Billing's `projects/{id}/billingInfo`.
 * - The target project is always the runtime project the metadata server reports, never a literal,
 *   so a copy of the guard in a throwaway project can only ever touch that project.
 * - The access token lives in this closure. It goes into one `Authorization` header and nowhere
 *   else: the http client logs hosts, labels and codes only, and its errors carry a code, not text.
 * - Every call goes through `createHttpClient`: timeout, at most 3 attempts with backoff, a run
 *   deadline, zod on every answer. Plain http is allowed for the metadata host only,
 *   for this client only, and never through a redirect.
 */

const METADATA = 'http://metadata.google.internal/computeMetadata/v1';
const BILLING_API = 'https://cloudbilling.googleapis.com/v1';

const ProjectSchema = z.object({ projectId: z.string() }).loose();
const TokenSchema = z.object({ access_token: z.string().min(1) }).loose();
const BillingInfoSchema = z
  .object({
    billingAccountName: z.string().optional(),
    billingEnabled: z.boolean().optional(),
  })
  .loose();

/** A GCP project ID: 6 to 30 characters, lower case, digits, hyphens. Checked before it enters a URL. */
const PROJECT_ID = /^[a-z][a-z0-9-]{4,28}[a-z0-9]$/;

export interface BillingClient {
  /** The runtime project, from the metadata server. */
  projectId(): Promise<string>;
  /** Whether billing is linked and enabled for the project. */
  billingEnabled(projectId: string): Promise<boolean>;
  /** Unlinks the billing account (`PUT billingInfo {billingAccountName: ""}`); true if still enabled after. */
  disableBilling(projectId: string): Promise<{ stillEnabled: boolean }>;
}

export interface BillingClientDeps {
  fetch: typeof fetch;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  random: () => number;
  log: HttpLog;
  /** Epoch ms after which no request starts. */
  deadline: number;
}

export class BillingClientError extends Error {
  override name = 'BillingClientError';
  readonly code: 'bad_project_id' | 'no_token';
  constructor(code: 'bad_project_id' | 'no_token') {
    super(code);
    this.code = code;
  }
}

export function createBillingClient(deps: BillingClientDeps): BillingClient {
  const http = createHttpClient({
    fetch: deps.fetch,
    now: deps.now,
    sleep: deps.sleep,
    random: deps.random,
    userAgent: 'HireframeBillingGuard/1',
    productToken: 'HireframeBot',
    hostPolicy: () => ({
      robots: 'api-terms',
      intervalMs: 0,
      timeoutMs: BILLING_GUARD.requestTimeoutMs,
    }),
    maxAttempts: 3,
    backoffBaseMs: 1_000,
    retryAfterCapMs: 10_000,
    maxBodyBytes: 64_000,
    deadline: deps.deadline,
    plainHttpHosts: PLAIN_HTTP_HOSTS,
    log: deps.log,
  });
  const metadata = { 'Metadata-Flavor': 'Google' };
  let token: Promise<string> | undefined;

  function accessToken(): Promise<string> {
    token ??= http
      .getJson(`${METADATA}/instance/service-accounts/default/token`, TokenSchema, {
        label: 'metadata.token',
        headers: metadata,
      })
      .then((answer) => answer.access_token);
    return token;
  }

  async function authorised(): Promise<Record<string, string>> {
    return { Authorization: `Bearer ${await accessToken()}` };
  }

  function billingInfoUrl(projectId: string): string {
    if (!PROJECT_ID.test(projectId)) throw new BillingClientError('bad_project_id');
    return `${BILLING_API}/projects/${encodeURIComponent(projectId)}/billingInfo`;
  }

  return {
    async projectId() {
      const answer = await http.getJson(`${METADATA}/project/?recursive=true`, ProjectSchema, {
        label: 'metadata.project',
        headers: metadata,
      });
      if (!PROJECT_ID.test(answer.projectId)) throw new BillingClientError('bad_project_id');
      return answer.projectId;
    },

    async billingEnabled(projectId) {
      const info = await http.getJson(billingInfoUrl(projectId), BillingInfoSchema, {
        label: 'billing.get',
        headers: await authorised(),
      });
      return info.billingEnabled === true;
    },

    async disableBilling(projectId) {
      // Safe to repeat: the same body leaves the same state, so the client's retries can't do harm.
      const info = await http.putJson(
        billingInfoUrl(projectId),
        { billingAccountName: '' },
        BillingInfoSchema,
        { label: 'billing.put', headers: await authorised() },
      );
      return { stillEnabled: info.billingEnabled === true };
    },
  };
}
