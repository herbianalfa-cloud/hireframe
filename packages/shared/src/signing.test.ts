import { createHmac } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
  signedBytesToHex,
  signingPrefix,
  signingString,
  toSignedBytes,
  trimSecret,
  truncateUtf8,
  utf8Bytes,
  utf8Length,
} from './signing.js';

describe('signingString', () => {
  it('covers the version, timestamp, nonce and raw body', () => {
    expect(signingString('1760000000', 'n-1', '{"a":1}')).toBe('v1.1760000000.n-1.{"a":1}');
  });
});

describe('signature purposes (domain separation)', () => {
  it('keeps ingest on v1. and gives the digest digest.v1.', () => {
    expect(signingPrefix('1760000000', 'n-1')).toBe('v1.1760000000.n-1.');
    expect(signingPrefix('1760000000', 'n-1', 'ingest')).toBe('v1.1760000000.n-1.');
    expect(signingString('1760000000', 'n-1', '{"a":1}', 'digest')).toBe(
      'digest.v1.1760000000.n-1.{"a":1}',
    );
  });

  it('never lets one purpose’s signed bytes be a prefix of, or equal to, the other’s', () => {
    const a = signingString('1760000000', 'n-1', '{}', 'ingest');
    const b = signingString('1760000000', 'n-1', '{}', 'digest');
    expect(a).not.toBe(b);
    expect(a.startsWith('digest.')).toBe(false);
    expect(b.startsWith('v1.')).toBe(false);
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

describe('utf8Bytes', () => {
  const samples = [
    '',
    'abc',
    'é',
    'Product Analyst · London · £45K',
    '€5',
    '日本語',
    'a😀b',
    '\ud800x',
    'x\udc00',
  ];
  it.each(samples)('encodes %j like Buffer', (text) => {
    expect(utf8Bytes(text)).toEqual([...Buffer.from(text, 'utf8')]);
    expect(utf8Bytes(text)).toHaveLength(utf8Length(text));
  });

  it('is the signed prefix plus the body, byte for byte', () => {
    const body = '{"text":"· £"}';
    expect(
      Buffer.from([...utf8Bytes(signingPrefix('1760000000', 'n-1')), ...utf8Bytes(body)]).toString(
        'utf8',
      ),
    ).toBe(signingString('1760000000', 'n-1', body));
  });
});

describe('toSignedBytes', () => {
  it("maps unsigned bytes to Apps Script's -128..127", () => {
    expect(toSignedBytes([0, 127, 128, 255])).toEqual([0, 127, -128, -1]);
  });
});
