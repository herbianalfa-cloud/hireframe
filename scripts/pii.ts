/**
 * Pure detection of personal data (emails, phone numbers) in text.
 * Used by scripts/check-pii.ts; kept free of I/O so it is unit-testable.
 */

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

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g;

// International (+CC …) or UK national (01…, 02…, 03…, 07…) numbers, not embedded in a longer token.
const PHONE =
  /(?<![\w+])(?:\+\d{1,3}[\s-]?\(?\d{1,4}\)?(?:[\s-]?\d{2,4}){2,4}|0[1237]\d{2,3}[\s-]?\d{3}[\s-]?\d{3,4})(?!\w)/g;

const MIN_PHONE_DIGITS = 9;
const MAX_PHONE_DIGITS = 15;

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
      const digits = phone.replace(/\D/g, '').length;
      if (digits >= MIN_PHONE_DIGITS && digits <= MAX_PHONE_DIGITS) {
        findings.push({ kind: 'phone', line, redacted: redact(phone) });
      }
    }
  });
  return findings;
}
