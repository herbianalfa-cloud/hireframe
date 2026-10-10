import { describe, expect, it } from 'vitest';

import { sourceLabel } from './labels';

describe('sourceLabel', () => {
  it('says where a fact came from, including an application answer', () => {
    expect(sourceLabel({ source: 'cv' })).toBe('From your CV');
    expect(sourceLabel({ source: 'manual' })).toBe('Added by you');
    expect(sourceLabel({ source: 'manual', answerFor: { jobId: 'job1' } })).toBe(
      'From an application answer',
    );
  });
});
