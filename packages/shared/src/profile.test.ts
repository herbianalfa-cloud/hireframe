import { describe, expect, it } from 'vitest';

import { redactPii } from './pii.js';
import {
  AddFactInputSchema,
  CvExtractionSchema,
  FactDraftSchema,
  FactSchema,
  ParseCvInputSchema,
  type FactDraft,
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
  it('accepts only Firestore-style document IDs', () => {
    expect(ParseCvInputSchema.safeParse({ docId: 'abcdefghij0123456789' }).success).toBe(true);
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
