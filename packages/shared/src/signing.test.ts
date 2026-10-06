import { createHmac } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
  signedBytesToHex,
  signingString,
  trimSecret,
  truncateUtf8,
  utf8Length,
} from './signing.js';

describe('signingString', () => {
  it('covers the version, timestamp, nonce and raw body', () => {
    expect(signingString('1760000000', 'n-1', '{"a":1}')).toBe('v1.1760000000.n-1.{"a":1}');
  });
});

describe('trimSecret', () => {
  it('drops whitespace around the secret only', () => {
    expect(trimSecret('  ab cd\n')).toBe('ab cd');
    expect(trimSecret('abcd')).toBe('abcd');
  });
});

describe('signedBytesToHex', () => {
  it("matches Node's hex for Apps Script's signed bytes", () => {
    const digest = createHmac('sha256', 'k').update('v1.1.n.body').digest();
    const signed = [...digest].map((byte) => (byte > 127 ? byte - 256 : byte));
    expect(signed.some((byte) => byte < 0)).toBe(true);
    expect(signedBytesToHex(signed)).toBe(digest.toString('hex'));
  });
});

describe('utf8Length and truncateUtf8', () => {
  const samples = ['', 'abc', 'é', '€5', '日本語', 'a😀b', '😀😀'];
  it.each(samples)('counts %j like Buffer', (text) => {
    expect(utf8Length(text)).toBe(Buffer.byteLength(text));
  });

  it('truncates to a byte budget without splitting a character', () => {
    for (const text of samples) {
      for (let max = 0; max <= Buffer.byteLength(text) + 1; max++) {
        const cut = truncateUtf8(text, max);
        expect(Buffer.byteLength(cut)).toBeLessThanOrEqual(max);
        expect(text.startsWith(cut)).toBe(true);
        expect(cut).not.toMatch(/[\ud800-\udbff]$/);
      }
    }
    expect(truncateUtf8('日本語', 7)).toBe('日本');
    expect(truncateUtf8('abc', 100)).toBe('abc');
  });
});
