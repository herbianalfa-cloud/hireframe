import { describe, expect, it } from 'vitest';

import { countCompound, looksCompound } from './atomicity.js';
import { verifyEvidence } from './evidence.js';

const CV = `Alex Example
• Led onboarding for 12 clients and cut time-to-live by 30%
Built a “live” SQL dashboard — used weekly`;

describe('verifyEvidence', () => {
  it('accepts a verbatim quote, ignoring case, spacing, bullets and typographic quotes', () => {
    expect(verifyEvidence('led onboarding for 12 clients', CV)).toBe(true);
    expect(verifyEvidence('Built a "live" SQL dashboard - used   weekly', CV)).toBe(true);
  });

  it('rejects text that is not in the source, and empty evidence', () => {
    expect(verifyEvidence('Led onboarding for 20 clients', CV)).toBe(false);
    expect(verifyEvidence('   ', CV)).toBe(false);
  });
});

describe('atomicity hints', () => {
  it('flags drafts that bundle several numbers or long joined clauses', () => {
    expect(looksCompound('Led onboarding for 12 clients and cut time-to-live by 30%')).toBe(true);
    expect(
      looksCompound(
        'Designed the onboarding checklist used by the whole customer team and rewrote the support macros for the help centre',
      ),
    ).toBe(true);
  });

  it('passes single claims', () => {
    expect(looksCompound('Cut client time-to-live by 30%')).toBe(false);
    expect(looksCompound('SQL and Python')).toBe(false);
    expect(countCompound(['SQL', 'Cut time-to-live by 30%', 'Grew revenue 10% in 2 months'])).toBe(
      1,
    );
  });
});
