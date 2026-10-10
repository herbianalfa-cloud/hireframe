import { httpsCallable } from 'firebase/functions';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  answerQuestion,
  applicationErrorMessage,
  cvFileName,
  PIPELINE_STAGES,
  regenerateApplication,
  retryApplication,
  skipAllQuestions,
  skipQuestion,
  stageSpec,
  startApplication,
  withdrawApplication,
} from './applications';

const invoke = vi.fn();
vi.mock('firebase/functions', () => ({ httpsCallable: vi.fn(() => invoke) }));
vi.mock('./firebase', () => ({
  getFunctionsClient: () => Promise.resolve({}),
  getFirebase: () => Promise.resolve({}),
  getStorageClient: () => Promise.resolve({}),
}));

const QUESTION_ID = 'q-02a7bdc3c99a';

beforeEach(() => {
  invoke.mockReset();
  vi.mocked(httpsCallable).mockClear();
});

describe('stageSpec', () => {
  it('is one stage, newest move first (the (stage, stageAt desc) composite)', () => {
    for (const stage of PIPELINE_STAGES) {
      expect(stageSpec(stage)).toEqual({
        collection: 'applications',
        filters: [{ field: 'stage', op: '==', value: stage }],
        orderBy: [{ field: 'stageAt', direction: 'desc' }],
      });
    }
  });

  it('never lists withdrawn applications', () => {
    expect(PIPELINE_STAGES).not.toContain('withdrawn');
  });
});

describe('the application callable', () => {
  it('sends each action with its job and parses the result', async () => {
    invoke.mockResolvedValue({ data: { jobId: 'job1', stage: 'generating', unanswered: 0 } });
    await startApplication('job1');
    await answerQuestion('job1', QUESTION_ID, 'I ran the dbt migration');
    await skipQuestion('job1', QUESTION_ID);
    await skipAllQuestions('job1');
    await retryApplication('job1');
    await regenerateApplication('job1', '  shorter please ');
    await regenerateApplication('job1', '   ');
    await withdrawApplication('job1', true);
    expect(invoke.mock.calls.map((call: unknown[]) => call[0])).toEqual([
      { action: 'start', jobId: 'job1' },
      { action: 'answer', jobId: 'job1', questionId: QUESTION_ID, text: 'I ran the dbt migration' },
      { action: 'skip', jobId: 'job1', questionId: QUESTION_ID },
      { action: 'skipAll', jobId: 'job1' },
      { action: 'retry', jobId: 'job1' },
      { action: 'regenerate', jobId: 'job1', notes: 'shorter please' },
      { action: 'regenerate', jobId: 'job1' },
      { action: 'withdraw', jobId: 'job1', deleteFiles: true },
    ]);
  });

  it('uses a limited-use App Check token and the shared client timeout', async () => {
    invoke.mockResolvedValue({ data: { jobId: 'job1', stage: 'chosen', unanswered: 0 } });
    await startApplication('job1');
    expect(httpsCallable).toHaveBeenCalledWith({}, 'application', {
      timeout: 140_000,
      limitedUseAppCheckTokens: true,
    });
  });

  it('refuses input the shared schema refuses, before any call', async () => {
    await expect(answerQuestion('job1', QUESTION_ID, 'x'.repeat(2_001))).rejects.toThrow();
    await expect(answerQuestion('job1', 'not-a-question', 'text')).rejects.toThrow();
    await expect(regenerateApplication('job1', 'x'.repeat(501))).rejects.toThrow();
    expect(invoke).not.toHaveBeenCalled();
  });

  it('rejects a result that does not match the schema', async () => {
    invoke.mockResolvedValue({ data: { jobId: 'job1', stage: 'bogus', unanswered: 0 } });
    await expect(startApplication('job1')).rejects.toThrow();
    invoke.mockResolvedValue({
      data: { jobId: 'job1', stage: 'ready', unanswered: 0, extra: true },
    });
    await expect(startApplication('job1')).rejects.toThrow();
  });

  it.each(['functions/unavailable', 'functions/deadline-exceeded', 'functions/internal'])(
    'is invoked once and rethrown on %s (an answer can cost a model call)',
    async (code) => {
      invoke.mockRejectedValue(Object.assign(new Error('failed'), { code }));
      await expect(answerQuestion('job1', QUESTION_ID, 'text')).rejects.toMatchObject({ code });
      expect(invoke).toHaveBeenCalledTimes(1);
    },
  );
});

describe('applicationErrorMessage', () => {
  const failure = (code: string, message = 'server words') =>
    Object.assign(new Error(message), { code });

  it('words each code the callable uses', () => {
    expect(applicationErrorMessage(failure('functions/not-found'))).toMatch(/no longer exists/);
    expect(applicationErrorMessage(failure('functions/aborted'))).toMatch(/Reload/);
    expect(applicationErrorMessage(failure('functions/resource-exhausted'))).toMatch(/budget/);
    expect(applicationErrorMessage(failure('functions/unavailable'))).toMatch(/couldn't be used/);
    expect(applicationErrorMessage(failure('functions/deadline-exceeded'))).toMatch(
      /longer than usual/,
    );
  });

  it("shows the server's own words for a rejected answer or a wrong stage", () => {
    const text = "Couldn't turn that into a fact: rephrase it or skip";
    expect(applicationErrorMessage(failure('functions/invalid-argument', text))).toBe(text);
    expect(applicationErrorMessage(failure('functions/failed-precondition', 'Add a header'))).toBe(
      'Add a header',
    );
  });

  it('never shows an internal error or an unknown one verbatim', () => {
    expect(applicationErrorMessage(failure('functions/internal', 'stack trace'))).toBe(
      'Something went wrong. Check your connection and try again.',
    );
    expect(applicationErrorMessage(new Error('boom'))).not.toMatch(/boom/);
  });
});

describe('cvFileName', () => {
  it('is <name> - CV - <company>.<format>', () => {
    expect(cvFileName('Alex Example', 'cv', 'Acme Ltd', 'pdf')).toBe(
      'Alex Example - CV - Acme Ltd.pdf',
    );
    expect(cvFileName('Alex Example', 'cover-note', 'Acme Ltd', 'docx')).toBe(
      'Alex Example - Cover note - Acme Ltd.docx',
    );
  });

  it('drops path and control characters, and leaves out a missing part', () => {
    expect(cvFileName('Alex/Example', 'cv', 'A:B*C?"<>|\\Co\u0007', 'pdf')).toBe(
      'AlexExample - CV - ABCCo.pdf',
    );
    expect(cvFileName(undefined, 'cv', 'Acme', 'pdf')).toBe('CV - Acme.pdf');
    expect(cvFileName('Alex', 'cv', '///', 'pdf')).toBe('Alex - CV.pdf');
  });

  it('keeps a long company name to a sane length', () => {
    const name = cvFileName('Alex', 'cv', 'x'.repeat(300), 'pdf');
    expect(name.length).toBeLessThan(100);
  });
});
