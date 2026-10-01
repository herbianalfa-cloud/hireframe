/**
 * Email and phone patterns shared by the repo PII scan (scripts/pii.ts) and the functions
 * logger, which redacts them from every logged string (docs/SECURITY.md).
 */
export const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g;

// International (+CC …) or UK national (01…, 02…, 03…, 07…) numbers, not embedded in a longer token.
export const PHONE =
  /(?<![\w+])(?:\+\d{1,3}[\s-]?\(?\d{1,4}\)?(?:[\s-]?\d{2,4}){2,4}|0[1237]\d{2,3}[\s-]?\d{3}[\s-]?\d{3,4})(?!\w)/g;

export const MIN_PHONE_DIGITS = 9;
export const MAX_PHONE_DIGITS = 15;

export function isPhoneLike(candidate: string): boolean {
  const digits = candidate.replace(/\D/g, '').length;
  return digits >= MIN_PHONE_DIGITS && digits <= MAX_PHONE_DIGITS;
}

/** Replaces emails and phone numbers with placeholders. */
export function redactPii(text: string): string {
  return text
    .replace(EMAIL, '[email]')
    .replace(PHONE, (match) => (isPhoneLike(match) ? '[phone]' : match));
}
