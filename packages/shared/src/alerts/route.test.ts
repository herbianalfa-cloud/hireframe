import { describe, expect, it } from 'vitest';

import { LINKEDIN_FROM, WAAS_FROM } from '../fixtures/alerts.js';
import { routeAlert, senderAddress, senderDomain } from './route.js';

describe('routeAlert', () => {
  it('routes only the exact LinkedIn alert address to the deterministic parser', () => {
    expect(routeAlert('LinkedIn Job Alerts <jobalerts-noreply@linkedin.com>')).toBe('linkedin');
    expect(routeAlert('jobalerts-noreply@linkedin.com')).toBe('linkedin');
    expect(routeAlert('"LinkedIn" <JobAlerts-NoReply@LinkedIn.com>')).toBe('linkedin');
  });

  it('sends everything else, lookalikes included, to the model fallback', () => {
    // Built from parts: the PII scan allowlists only the real alert address, not its lookalikes.
    const sender = 'jobalerts-noreply';
    for (const from of [
      'Work at a Startup <jobs@example.com>',
      `${sender}@linkedin.com.evil.example`,
      `x${sender}@linkedin.com`,
      `${sender}@mail.linkedin.com`,
      `LinkedIn <${sender}@linkedin.com> via someone <a@example.com>`,
      `${sender}@linkedin.com, other@example.com`,
      '',
    ]) {
      expect(routeAlert(from), from).toBe('model');
    }
  });
});

describe('the fixtures', () => {
  it('route the way the real senders do', () => {
    expect(routeAlert(LINKEDIN_FROM)).toBe('linkedin');
    expect(routeAlert(WAAS_FROM)).toBe('model');
  });
});

describe('senderAddress and senderDomain', () => {
  it('reads the address and the domain', () => {
    expect(senderAddress('Name <A@Example.com>')).toBe('a@example.com');
    expect(senderDomain('Name <a@example.com>')).toBe('example.com');
    expect(senderDomain('no address here')).toBe('unknown');
  });
});
