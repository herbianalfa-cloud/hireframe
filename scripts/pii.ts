/**
 * Pure detection of personal data (emails, phone numbers) in text.
 * Used by scripts/check-pii.ts; kept free of I/O so it is unit-testable. The patterns live in
 * packages/shared so the functions logger redacts the same things.
 */
import { EMAIL, isPhoneLike, PHONE } from '../packages/shared/src/pii.ts';

export type PiiKind = 'email' | 'phone';

export interface PiiFinding {
  kind: PiiKind;
  line: number;
  /** Never the full value: findings end up in public CI logs. */
  redacted: string;
}

export interface Allowlist {
  exact: Set<string>;
  domains: Set<string>;
}

/** Parses one entry per line: an exact address or `*@domain`. `#` starts a comment. */
export function parseAllowlist(text: string): Allowlist {
  const allowlist: Allowlist = { exact: new Set(), domains: new Set() };
  for (const raw of text.split('\n')) {
    const entry = raw.replace(/#.*/, '').trim().toLowerCase();
    if (entry === '') continue;
    if (entry.startsWith('*@')) allowlist.domains.add(entry.slice(2));
    else allowlist.exact.add(entry);
  }
  return allowlist;
}

export function isAllowedEmail(email: string, allowlist: Allowlist): boolean {
  const normalised = email.toLowerCase();
  const domain = normalised.slice(normalised.lastIndexOf('@') + 1);
  return allowlist.exact.has(normalised) || allowlist.domains.has(domain);
}

export function redact(value: string): string {
  return `${value.slice(0, 1)}***(${String(value.length)} chars)`;
}

export function findPii(text: string, allowlist: Allowlist): PiiFinding[] {
  const findings: PiiFinding[] = [];
  text.split('\n').forEach((content, index) => {
    const line = index + 1;
    for (const [email] of content.matchAll(EMAIL)) {
      if (!isAllowedEmail(email, allowlist)) {
        findings.push({ kind: 'email', line, redacted: redact(email) });
      }
    }
    for (const [phone] of content.matchAll(PHONE)) {
      if (isPhoneLike(phone)) {
        findings.push({ kind: 'phone', line, redacted: redact(phone) });
      }
    }
  });
  return findings;
}
