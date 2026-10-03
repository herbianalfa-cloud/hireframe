import { describe, expect, it } from 'vitest';

import { CALLABLE_TIMEOUT_SECONDS } from './callables.js';
import { redactPii } from './pii.js';
import {
  AddFactInputSchema,
  CvExtractionSchema,
  EvidenceUrlSchema,
  FactDraftSchema,
  FactSchema,
  isParseStalled,
  ParseCvInputSchema,
  STALE_PARSE_MS,
  type FactDraft,
  type ProfileDocument,
  ProfileSettingsSchema,
} from './profile.js';

const AT = new Date('2026-10-01T09:00:00Z');

const draft: FactDraft = {
  type: 'metric',
  text: 'Cut client time-to-live by 30%',
  evidence: 'cut time-to-live by 30%',
  dates: { start: '2024-01', end: 'present' },
  tags: ['onboarding'],
  lanes: ['secondary'],
};

describe('fact schemas', () => {
  it('parses a stored fact with a pending review', () => {
    const fact = {
      ...draft,
      source: 'cv',
      sourceDocId: 'abcdefghij0123456789',
      status: 'active',
      version: 1,
      review: { kind: 'changed', proposed: draft, docId: 'abcdefghij0123456789', at: AT },
      evidenceVerified: true,
      createdAt: AT,
      updatedAt: AT,
      schemaVersion: 1,
    };
    expect(FactSchema.parse(fact)).toEqual(fact);
  });

  it.each([
    ['an unknown type', { type: 'hobby' }],
    ['an unknown lane', { lanes: ['dream'] }],
    ['a draft longer than one claim allows', { text: 'x'.repeat(301) }],
    ['a malformed date', { dates: { start: '2024-13' } }],
    ['empty evidence', { evidence: ' ' }],
  ])('rejects a draft with %s', (_name, patch) => {
    expect(FactDraftSchema.safeParse({ ...draft, ...patch }).success).toBe(false);
  });

  it('caps a CV extraction at 200 facts (one batch with their snapshots)', () => {
    expect(
      CvExtractionSchema.safeParse({ facts: Array.from({ length: 200 }, () => draft) }).success,
    ).toBe(true);
    expect(
      CvExtractionSchema.safeParse({ facts: Array.from({ length: 201 }, () => draft) }).success,
    ).toBe(false);
  });
});

describe('callable inputs', () => {
  it('requires a file name of 1 to 200 characters', () => {
    const docId = 'abcdefghij0123456789';
    expect(ParseCvInputSchema.safeParse({ docId }).success).toBe(false);
    expect(ParseCvInputSchema.safeParse({ docId, fileName: '  ' }).success).toBe(false);
    expect(ParseCvInputSchema.safeParse({ docId, fileName: 'a'.repeat(200) }).success).toBe(true);
    expect(ParseCvInputSchema.safeParse({ docId, fileName: 'a'.repeat(201) }).success).toBe(false);
  });

  it('accepts only Firestore-style document IDs', () => {
    expect(
      ParseCvInputSchema.safeParse({ docId: 'abcdefghij0123456789', fileName: 'cv.pdf' }).success,
    ).toBe(true);
    expect(ParseCvInputSchema.safeParse({ docId: '../other' }).success).toBe(false);
  });

  it('trims addFact text and bounds its length', () => {
    expect(AddFactInputSchema.parse({ text: '  Finished a SQL project  ' })).toEqual({
      text: 'Finished a SQL project',
    });
    expect(AddFactInputSchema.safeParse({ text: '   ' }).success).toBe(false);
    expect(AddFactInputSchema.safeParse({ text: 'x'.repeat(2001) }).success).toBe(false);
  });
});

describe('redactPii', () => {
  it('replaces emails and phone numbers', () => {
    const email = ['someone', 'mail.test'].join('@');
    const phone = ['07700', '900', '123'].join(' ');
    expect(redactPii(`mail ${email} or call ${phone}; ref 2024`)).toBe(
      'mail [email] or call [phone]; ref 2024',
    );
  });
});

describe('isParseStalled', () => {
  const at = new Date('2026-10-01T09:00:00Z');
  const parsing: ProfileDocument = {
    kind: 'pdf',
    storagePath: 'profile/documents/abcdefghij0123456789/cv.pdf',
    status: 'parsing',
    createdAt: at,
    updatedAt: at,
    schemaVersion: 1,
  };
  const later = (ms: number) => new Date(at.getTime() + ms);

  it('flags a parse still running after the stale threshold', () => {
    expect(isParseStalled(parsing, later(STALE_PARSE_MS - 1))).toBe(false);
    expect(isParseStalled(parsing, later(STALE_PARSE_MS))).toBe(true);
    expect(isParseStalled({ ...parsing, status: 'failed' }, later(STALE_PARSE_MS))).toBe(false);
  });

  it('outlasts the parseCv callable timeout', () => {
    expect(STALE_PARSE_MS).toBeGreaterThan(CALLABLE_TIMEOUT_SECONDS.parseCv * 1000);
  });
});

describe('EvidenceUrlSchema', () => {
  it.each(['https://example.com', 'https://example.com/a/b?c=d#e'])('accepts %s', (url) => {
    expect(EvidenceUrlSchema.safeParse(url).success).toBe(true);
  });

  it.each([
    'http://example.com',
    'javascript:alert(1)',
    'ftp://example.com/file',
    'example.com',
    'https://example.com/a b',
    `https://example.com/${'a'.repeat(500)}`,
  ])('rejects %s', (url) => {
    expect(EvidenceUrlSchema.safeParse(url).success).toBe(false);
  });
});

describe('evidence links are owner-set only', () => {
  it('a model draft cannot carry one', () => {
    const parsed = FactDraftSchema.safeParse({ ...draft, evidenceUrl: 'https://example.com' });
    expect(parsed.success && 'evidenceUrl' in parsed.data).toBe(false);
  });
});

describe('ProfileSettingsSchema', () => {
  const base = {
    workRights: 'time_limited',
    createdAt: new Date(),
    updatedAt: new Date(),
    schemaVersion: 1,
  };

  it('accepts work rights with or without a valid-until date', () => {
    expect(ProfileSettingsSchema.safeParse(base).success).toBe(true);
    expect(ProfileSettingsSchema.safeParse({ ...base, validUntil: '2028-06-30' }).success).toBe(
      true,
    );
  });

  it.each([
    ['an unknown work-rights value', { workRights: 'citizen' }],
    ['a month-only date', { validUntil: '2028-06' }],
    ['a month 13', { validUntil: '2028-13-01' }],
    ['a timestamp string', { validUntil: '2028-06-30T00:00:00Z' }],
  ])('rejects %s', (_name, patch) => {
    expect(ProfileSettingsSchema.safeParse({ ...base, ...patch }).success).toBe(false);
  });
});
