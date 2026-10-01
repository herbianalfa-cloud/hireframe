/**
 * Hosting headers in firebase.json (ADR-014): the CSP must let the web app reach its callables.
 * CSP host wildcards only work as a leading `*.`, so the Functions host is listed exactly.
 */
import { readFileSync } from 'node:fs';

import { FUNCTIONS_REGION } from '@hireframe/shared';
import { describe, expect, it } from 'vitest';

interface HostingHeaders {
  hosting: { headers: { source: string; headers: { key: string; value: string }[] }[] };
}

const config = JSON.parse(readFileSync('firebase.json', 'utf8')) as HostingHeaders;
const csp = config.hosting.headers
  .flatMap((entry) => entry.headers)
  .find((header) => header.key.startsWith('Content-Security-Policy'))?.value;

describe('Content-Security-Policy', () => {
  it('allows the callables host in connect-src', () => {
    const connectSrc = csp?.split(';').find((part) => part.trim().startsWith('connect-src')) ?? '';
    expect(connectSrc).toMatch(
      new RegExp(`\\shttps://${FUNCTIONS_REGION}-[a-z0-9-]+\\.cloudfunctions\\.net(\\s|$)`),
    );
    expect(connectSrc).not.toContain('-*.cloudfunctions.net');
  });
});
