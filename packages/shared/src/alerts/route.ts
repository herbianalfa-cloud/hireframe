/**
 * Alert routing (ADR-047), pure. The parser is chosen by the exact `From` address and nothing
 * else: the subject is never read, and the owner's own addresses are never needed (a forwarded
 * alert keeps the original `From`, so it routes like a direct one). Routing picks a parser; it is
 * not trust: anyone can email the inbox something alert-shaped, and the worst case is a fake job
 * that goes through the funnel as untrusted text.
 */

export const LINKEDIN_ALERT_SENDER = 'jobalerts-noreply@linkedin.com';

export type AlertParser = 'linkedin' | 'model';

const ADDRESS = /^[^\s@<>"',;]+@[^\s@<>"',;]+\.[^\s@<>"',;]+$/;

/** The lower-case address in a `From` header (`Name <a@b.c>` or bare), or '' if it has none. */
export function senderAddress(from: string): string {
  const angle = /<([^<>]*)>\s*$/.exec(from.trim());
  const candidate = (angle ? (angle[1] ?? '') : from).trim().toLowerCase();
  return ADDRESS.test(candidate) ? candidate : '';
}

/** The sender's domain for per-sender counts; `unknown` when there is no usable address. */
export function senderDomain(from: string): string {
  const address = senderAddress(from);
  return address === '' ? 'unknown' : address.slice(address.lastIndexOf('@') + 1);
}

export function routeAlert(from: string): AlertParser {
  return senderAddress(from) === LINKEDIN_ALERT_SENDER ? 'linkedin' : 'model';
}
