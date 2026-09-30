import { describe, expect, it } from 'vitest';

import { findPii, isAllowedEmail, parseAllowlist, redact } from './pii.ts';

// Fake values are assembled at runtime so this file never trips the scan itself.
const fakeEmail = ['jane.doe', 'fake-mail.test'].join('@');
const fakeUkMobile = ['07700', '900', '123'].join(' ');
const fakeIntlPhone = ['+44', '20', '7946', '0958'].join(' ');

const allowlist = parseAllowlist(
  ['# comment', ['bot', 'example.org'].join('@'), '*@example.com  # placeholder domain', ''].join(
    '\n',
  ),
);

describe('parseAllowlist / isAllowedEmail', () => {
  it('matches exact addresses and *@domain entries, case-insensitively', () => {
    expect(isAllowedEmail(['Bot', 'Example.org'].join('@'), allowlist)).toBe(true);
    expect(isAllowedEmail(['anyone', 'example.com'].join('@'), allowlist)).toBe(true);
    expect(isAllowedEmail(fakeEmail, allowlist)).toBe(false);
  });
});

describe('findPii', () => {
  it('finds non-allowlisted emails with their line number', () => {
    expect(findPii(`first line\ncontact: ${fakeEmail}`, allowlist)).toEqual([
      { kind: 'email', line: 2, redacted: redact(fakeEmail) },
    ]);
  });

  it('ignores allowlisted emails', () => {
    expect(findPii(['ok', 'example.com'].join('@'), allowlist)).toEqual([]);
  });

  it('finds UK and international phone numbers', () => {
    const kinds = findPii(`call ${fakeUkMobile} or ${fakeIntlPhone}`, allowlist).map((f) => f.kind);
    expect(kinds).toEqual(['phone', 'phone']);
  });

  it('does not flag times, dates, versions, scores or hashes', () => {
    const text = [
      'Runs at 07:30 and 17:30 Europe/London',
      'created 2026-09-30T00:33:19.168+01:00',
      'gitleaks 8.30.1, node >=22.18',
      '+3 lane match, +0–1 company fit, −2 if posted > 7 days',
      'uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1',
      'sha256 551f6fc83ea457d62a0d98237cbad105af8d557003051f41f3e7ca7b3f2470eb',
    ].join('\n');
    expect(findPii(text, allowlist)).toEqual([]);
  });

  it('never exposes the full value', () => {
    const [finding] = findPii(fakeEmail, allowlist);
    expect(finding?.redacted).not.toContain(fakeEmail);
    expect(finding?.redacted.startsWith('j***')).toBe(true);
  });
});
