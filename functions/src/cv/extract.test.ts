import { countCompound, FactDraftSchema, verifyEvidence } from '@hireframe/shared';
import { describe, expect, it } from 'vitest';

import { makeDocx, makePdf } from '../fixtures/fake-cv-files.js';
import { FAKE_CV_EXTRACTION, FAKE_CV_REVISED_EXTRACTION } from '../fixtures/fake-cv-response.js';
import {
  FAKE_CV_LINES,
  FAKE_CV_REVISED_TEXT,
  FAKE_CV_TEXT,
  MULTI_CLAIM_BULLETS,
} from '../fixtures/fake-cv-text.js';
import { detectKind, extractText } from './extract.js';

describe('detectKind', () => {
  it('reads the type from the first bytes, not the name', async () => {
    expect(detectKind(makePdf(['x']))).toBe('pdf');
    expect(detectKind(await makeDocx(['x']))).toBe('docx');
    expect(detectKind(new TextEncoder().encode('<html>'))).toBeNull();
    expect(detectKind(new Uint8Array())).toBeNull();
  });
});

describe('extractText', () => {
  it('extracts every line of a multi-page PDF', async () => {
    const lines = [...FAKE_CV_LINES, ...FAKE_CV_LINES.map((line) => `${line} (page two)`)];
    const text = await extractText(makePdf(lines), 'pdf');
    expect(verifyEvidence('Led onboarding for 12 clients and cut time-to-live by 30%', text)).toBe(
      true,
    );
    expect(
      verifyEvidence('Organised a 60-person product hackathon at university (page two)', text),
    ).toBe(true);
  });

  it('extracts the text of a DOCX', async () => {
    const text = await extractText(await makeDocx(FAKE_CV_LINES), 'docx');
    for (const line of FAKE_CV_LINES) expect(verifyEvidence(line, text)).toBe(true);
  });
});

describe('fake CV fixture', () => {
  const facts = FAKE_CV_EXTRACTION.facts;

  it('has at least 60 valid facts, each with verbatim evidence', () => {
    expect(facts.length).toBeGreaterThanOrEqual(60);
    for (const draft of facts) {
      expect(FactDraftSchema.safeParse(draft).success, draft.text).toBe(true);
      expect(verifyEvidence(draft.evidence, FAKE_CV_TEXT), draft.evidence).toBe(true);
    }
  });

  it('splits every multi-claim bullet into at least two facts', () => {
    for (const bullet of MULTI_CLAIM_BULLETS) {
      const fromBullet = facts.filter((draft) => verifyEvidence(draft.evidence, bullet));
      expect(fromBullet.length, bullet).toBeGreaterThanOrEqual(2);
      for (const draft of fromBullet) expect(draft.text.length).toBeLessThan(bullet.length);
    }
  });

  it('has only the one known compound-looking fact (two numbers in a single preference)', () => {
    expect(countCompound(facts.map((draft) => draft.text))).toBe(1);
  });

  it('has a revised variant with exactly one reworded claim that verifies', () => {
    const changed = FAKE_CV_REVISED_EXTRACTION.facts.filter((draft, i) => draft !== facts[i]);
    expect(changed.map((draft) => draft.text)).toEqual(['Led onboarding for 14 clients']);
    expect(verifyEvidence('Led onboarding for 14 clients', FAKE_CV_REVISED_TEXT)).toBe(true);
  });
});
