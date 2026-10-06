import { describe, expect, it } from 'vitest';

import { routeAlert, senderAddress, senderDomain } from './route.js';

describe('routeAlert', () => {
  it('routes only the exact LinkedIn alert address to the deterministic parser', () => {
    expect(routeAlert('LinkedIn Job Alerts <jobalerts-noreply@linkedin.com>')).toBe('linkedin');
    expect(routeAlert('jobalerts-noreply@linkedin.com')).toBe('linkedin');
    expect(routeAlert('"LinkedIn" <JobAlerts-NoReply@LinkedIn.com>')).toBe('linkedin');
  });

  it('sends everything else, lookalikes included, to the model fallback', () => {
    for (const from of [
      'Work at a Startup <jobs@example.com>',
      'jobalerts-noreply@linkedin.com.evil.example',
      'xjobalerts-noreply@linkedin.com',
      'jobalerts-noreply@mail.linkedin.com',
      'LinkedIn <jobalerts-noreply@linkedin.com> via someone <a@example.com>',
      'jobalerts-noreply@linkedin.com, other@example.com',
      '',
    ]) {
      expect(routeAlert(from), from).toBe('model');
    }
  });
});

describe('senderAddress and senderDomain', () => {
  it('reads the address and the domain', () => {
    expect(senderAddress('Name <A@B.example>')).toBe('a@b.example');
    expect(senderDomain('Name <a@b.example>')).toBe('b.example');
    expect(senderDomain('no address here')).toBe('unknown');
  });
});
