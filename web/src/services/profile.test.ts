import { describe, expect, it } from 'vitest';

import { callableErrorMessage, cvKindOf, writeErrorMessage } from './profile';

const file = (name: string, size = 1024) => ({ name, size, type: '' });

describe('cvKindOf', () => {
  it('accepts PDF and DOCX files by extension', () => {
    expect(cvKindOf(file('CV.PDF'))).toBe('pdf');
    expect(cvKindOf(file('my-cv.docx'))).toBe('docx');
  });

  it.each([
    ['another type', file('cv.doc'), 'Choose a PDF or Word (.docx) file.'],
    ['an empty file', file('cv.pdf', 0), 'That file is empty.'],
    ['a file over 5 MB', file('cv.pdf', 5 * 1024 * 1024 + 1), 'The file is larger than 5 MB.'],
  ])('rejects %s', (_name, picked, message) => {
    expect(() => cvKindOf(picked)).toThrow(message);
  });
});

describe('error messages', () => {
  it('shows user-safe callable messages and hides internal ones', () => {
    const userFacing = Object.assign(new Error('The monthly AI spend cap has been reached.'), {
      code: 'functions/resource-exhausted',
    });
    expect(callableErrorMessage(userFacing)).toBe('The monthly AI spend cap has been reached.');
    const internal = Object.assign(new Error('INTERNAL'), { code: 'functions/internal' });
    expect(callableErrorMessage(internal)).toBe('Something went wrong. Try again.');
    expect(
      callableErrorMessage(Object.assign(new Error('x'), { code: 'functions/deadline-exceeded' })),
    ).toContain('longer than usual');
  });

  it('explains a rejected edit as a stale fact', () => {
    expect(writeErrorMessage({ code: 'permission-denied' })).toContain(
      'changed since you opened it',
    );
    expect(writeErrorMessage(new Error('offline'))).toContain('Check your connection');
  });
});
