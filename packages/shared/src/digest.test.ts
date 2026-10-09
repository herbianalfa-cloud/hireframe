import { describe, expect, it } from 'vitest';

import { DigestRequestSchema, DigestResponseSchema } from './digest.js';

describe('DigestRequestSchema', () => {
  it('accepts a kind and a real day', () => {
    expect(DigestRequestSchema.safeParse({ kind: 'morning', day: '2026-10-08' }).success).toBe(
      true,
    );
    expect(DigestRequestSchema.safeParse({ kind: 'fallback', day: '2028-02-29' }).success).toBe(
      true,
    );
  });

  it.each([
    { kind: 'evening', day: '2026-10-08' },
    { kind: 'morning', day: '2026-02-30' },
    { kind: 'morning', day: '8 Oct' },
    { kind: 'morning', day: '2026-10-08', extra: 1 },
    { kind: 'morning' },
    {},
  ])('refuses %j', (body) => {
    expect(DigestRequestSchema.safeParse(body).success).toBe(false);
  });
});

describe('DigestResponseSchema', () => {
  it('has exactly state, subject, html and text', () => {
    const ok = { state: 'ready', subject: 's', html: '<p>x</p>', text: 'x' };
    expect(DigestResponseSchema.safeParse(ok).success).toBe(true);
    expect(DigestResponseSchema.safeParse({ ...ok, extra: 1 }).success).toBe(false);
    expect(DigestResponseSchema.safeParse({ ...ok, state: 'sent' }).success).toBe(false);
  });
});
