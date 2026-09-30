import { describe, expect, it } from 'vitest';

import { assertNever } from './index.js';

type Verdict = 'apply' | 'skip';

function label(verdict: Verdict): string {
  switch (verdict) {
    case 'apply':
      return 'Apply';
    case 'skip':
      return 'Skip';
    default:
      return assertNever(verdict);
  }
}

describe('assertNever', () => {
  it('is unreachable when every case is handled', () => {
    expect(label('apply')).toBe('Apply');
    expect(label('skip')).toBe('Skip');
  });

  it('throws with the unexpected value if an unhandled case slips through at runtime', () => {
    expect(() => label('wildcard' as Verdict)).toThrow('Unhandled case: "wildcard"');
  });
});
