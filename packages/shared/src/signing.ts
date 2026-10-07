/**
 * The Gmail bridge's wire format and request signing (ADR-046). Pure and import-free, so the
 * Apps Script bundle can include it without pulling in zod: the script and the server build the
 * signed string from the same function, and both trim the secret the same way.
 */

export const SIGNATURE_VERSION = 'v1';

export const INGEST_HEADERS = {
  timestamp: 'X-Hireframe-Timestamp',
  nonce: 'X-Hireframe-Nonce',
  signature: 'X-Hireframe-Signature',
} as const;

/** Limits both sides know (the script truncates and batches; the server re-checks). */
export const INGEST_WIRE = {
  /** The server refuses a body over this (Cloud Functions allows 10 MB; this is the contract). */
  serverMaxBytes: 1_000_000,
  /** The script keeps each POST body under this (UTF-8 bytes), leaving room for the envelope. */
  maxPostBytes: 900_000,
  messagesPerRequest: 5,
  messagesPerRun: 20,
  textChars: 100_000,
  htmlChars: 300_000,
  /** Gmail message IDs are 16 hex digits; thread-style IDs are longer. */
  idChars: 64,
  fromChars: 320,
} as const;

/** A secret as stored (Secret Manager, Script Properties): whitespace around it is never part of it. */
export function trimSecret(secret: string): string {
  return secret.trim();
}

/** `v1.<timestamp>.<nonce>.`: what precedes the raw body in the signed bytes. */
export function signingPrefix(timestamp: string, nonce: string): string {
  return `${SIGNATURE_VERSION}.${timestamp}.${nonce}.`;
}

/** `v1.<timestamp>.<nonce>.<raw body>`: covers the body, the time and the nonce. */
export function signingString(timestamp: string, nonce: string, body: string): string {
  return `${signingPrefix(timestamp, nonce)}${body}`;
}

/** UTF-8 bytes (0..255) of a string, without TextEncoder (Apps Script's V8 has none). */
export function utf8Bytes(text: string): number[] {
  const bytes: number[] = [];
  for (let i = 0; i < text.length; i++) {
    let code = text.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff && i + 1 < text.length) {
      const next = text.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        code = 0x10000 + ((code - 0xd800) << 10) + (next - 0xdc00);
        i += 1;
      }
    }
    // A lone surrogate is encoded as U+FFFD, as TextEncoder and Buffer do (3 bytes).
    if (code >= 0xd800 && code <= 0xdfff) code = 0xfffd;
    if (code < 0x80) bytes.push(code);
    else if (code < 0x800) bytes.push(0xc0 | (code >> 6), 0x80 | (code & 0x3f));
    else if (code < 0x10000) {
      bytes.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f));
    } else {
      bytes.push(
        0xf0 | (code >> 18),
        0x80 | ((code >> 12) & 0x3f),
        0x80 | ((code >> 6) & 0x3f),
        0x80 | (code & 0x3f),
      );
    }
  }
  return bytes;
}

/** Apps Script's byte arrays are signed (-128..127); this maps unsigned bytes to them. */
export function toSignedBytes(bytes: readonly number[]): number[] {
  return bytes.map((byte) => (byte > 127 ? byte - 256 : byte));
}

/** Apps Script's HMAC returns signed bytes (-128..127); this maps them to unsigned hex. */
export function signedBytesToHex(bytes: readonly number[]): string {
  return bytes.map((byte) => ((byte + 256) % 256).toString(16).padStart(2, '0')).join('');
}

/** UTF-8 length of a string, without TextEncoder (Apps Script's V8 has none). */
export function utf8Length(text: string): number {
  let bytes = 0;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff && i + 1 < text.length) {
      const next = text.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4;
        i += 1;
      } else bytes += 3;
    } else bytes += 3;
  }
  return bytes;
}

/** Cuts `text` to at most `maxBytes` UTF-8 bytes without splitting a character. */
export function truncateUtf8(text: string, maxBytes: number): string {
  if (maxBytes <= 0) return '';
  if (utf8Length(text) <= maxBytes) return text;
  let low = 0;
  let high = text.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (utf8Length(text.slice(0, mid)) <= maxBytes) low = mid;
    else high = mid - 1;
  }
  // Never end on half of a surrogate pair.
  const end = text.charCodeAt(low - 1);
  return text.slice(0, end >= 0xd800 && end <= 0xdbff ? low - 1 : low);
}
