import { STORAGE_PATHS, type CvExtraction } from '@hireframe/shared';
import { HttpsError } from 'firebase-functions/https';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { extractText } from '../cv/extract.js';
import { makeDocx, makePdf } from '../fixtures/fake-cv-files.js';
import { FAKE_CV_EXTRACTION, FAKE_CV_REVISED_EXTRACTION } from '../fixtures/fake-cv-response.js';
import { FAKE_CV_LINES, FAKE_CV_REVISED_LINES } from '../fixtures/fake-cv-text.js';
import type { LlmCallInput, LlmCallResult } from '../llm/call.js';
import { LlmOutputError, SpendCapExceededError } from '../llm/errors.js';
import { setLogSink, type LogFields } from '../log.js';
import { parseCvHandler, type ParseCvDeps } from './parseCv.js';
import { memoryProfileStore } from './testing.js';

const DOC_ID = 'abcdefghij0123456789';
const NOW = new Date('2026-10-01T09:00:00Z');

let logs: LogFields[];

beforeEach(() => {
  logs = [];
  setLogSink((level, event, fields) => logs.push({ level, event, ...fields }));
});

afterEach(() => {
  setLogSink();
});

function llmReturning(extraction: CvExtraction | Error) {
  const calls: LlmCallInput<CvExtraction>[] = [];
  const llm = (input: LlmCallInput<CvExtraction>): Promise<LlmCallResult<CvExtraction>> => {
    calls.push(input);
    return extraction instanceof Error
      ? Promise.reject(extraction)
      : Promise.resolve({ data: extraction, model: 'claude-sonnet-5-5', costPence: 4.2 });
  };
  return { llm, calls };
}

function deps(
  files: Record<string, Uint8Array>,
  llm: ParseCvDeps['llm'],
  store = memoryProfileStore().store,
): ParseCvDeps {
  return {
    store,
    readFile: (path) => Promise.resolve(files[path] ?? null),
    extract: extractText,
    llm,
    now: () => NOW,
  };
}

const pdfPath = STORAGE_PATHS.profileDocument(DOC_ID, 'pdf');
const docxPath = STORAGE_PATHS.profileDocument(DOC_ID, 'docx');

async function expectHttpsError(promise: Promise<unknown>, code: string): Promise<void> {
  const error: unknown = await promise.catch((caught: unknown) => caught);
  expect(error).toBeInstanceOf(HttpsError);
  expect((error as HttpsError).code).toBe(code);
}

describe('parseCvHandler', () => {
  it('parses a PDF CV into atomic facts and records the summary', async () => {
    const { store, state } = memoryProfileStore();
    const { llm, calls } = llmReturning(FAKE_CV_EXTRACTION);
    const result = await parseCvHandler(
      { docId: DOC_ID },
      deps({ [pdfPath]: makePdf(FAKE_CV_LINES) }, llm, store),
    );

    expect(result.summary).toMatchObject({
      factsExtracted: FAKE_CV_EXTRACTION.facts.length,
      added: FAKE_CV_EXTRACTION.facts.length,
      flagged: 0,
      unverified: 0,
    });
    expect(result.summary.added).toBeGreaterThanOrEqual(60);
    expect(state.documents.get(DOC_ID)?.status).toBe('parsed');
    expect(state.applied[0]).toMatchObject({ model: 'claude-sonnet-5-5', costPence: 4.2 });
    expect(state.applied[0]?.add.every((fact) => fact.evidenceVerified)).toBe(true);
    // The CV reaches the model only as tagged data, with the atomic-fact prompt.
    expect(calls[0]?.user.startsWith('<cv_text>')).toBe(true);
    expect(calls[0]?.system).toContain('exactly one claim');
  });

  it('parses a DOCX CV', async () => {
    const { llm } = llmReturning(FAKE_CV_EXTRACTION);
    const result = await parseCvHandler(
      { docId: DOC_ID },
      deps({ [docxPath]: await makeDocx(FAKE_CV_LINES) }, llm),
    );
    expect(result.summary.unverified).toBe(0);
  });

  it('merges a re-upload: nothing new, one reworded fact flagged, nothing overwritten', async () => {
    const { store, state } = memoryProfileStore();
    await parseCvHandler(
      { docId: DOC_ID },
      deps({ [pdfPath]: makePdf(FAKE_CV_LINES) }, llmReturning(FAKE_CV_EXTRACTION).llm, store),
    );
    const secondId = 'zyxwvutsrq9876543210';
    const second = await parseCvHandler(
      { docId: secondId },
      deps(
        { [STORAGE_PATHS.profileDocument(secondId, 'pdf')]: makePdf(FAKE_CV_REVISED_LINES) },
        llmReturning(FAKE_CV_REVISED_EXTRACTION).llm,
        store,
      ),
    );
    expect(second.summary).toMatchObject({ added: 0, flagged: 1, unverified: 0 });
    expect(state.applied[1]?.flag[0]?.proposed.text).toBe('Led onboarding for 14 clients');
    expect(state.facts.some((fact) => fact.content.text === 'Led onboarding for 12 clients')).toBe(
      true,
    );
  });

  it('marks evidence that is not in the CV as unverified instead of dropping the fact', async () => {
    const invented = {
      facts: FAKE_CV_EXTRACTION.facts
        .slice(0, 1)
        .map((draft) => ({ ...draft, evidence: 'Managed a team of 40 engineers' })),
    };
    const { store, state } = memoryProfileStore();
    const result = await parseCvHandler(
      { docId: DOC_ID },
      deps({ [pdfPath]: makePdf(FAKE_CV_LINES) }, llmReturning(invented).llm, store),
    );
    expect(result.summary).toMatchObject({ added: 1, unverified: 1 });
    expect(state.applied[0]?.add[0]?.evidenceVerified).toBe(false);
  });

  it.each([
    ['a missing upload', {}, 'not-found', undefined],
    [
      'a file that is not really a PDF',
      { [pdfPath]: new TextEncoder().encode('<html>hi</html>') },
      'invalid-argument',
      'file_type',
    ],
    [
      'an oversized file',
      { [pdfPath]: new Uint8Array(5 * 1024 * 1024 + 1) },
      'invalid-argument',
      'file_too_large',
    ],
    ['a PDF with no text', { [pdfPath]: makePdf(['Scan']) }, 'failed-precondition', 'no_text'],
  ])('rejects %s', async (_name, files, code, errorCode) => {
    const { store, state } = memoryProfileStore();
    const { llm, calls } = llmReturning(FAKE_CV_EXTRACTION);
    await expectHttpsError(parseCvHandler({ docId: DOC_ID }, deps(files, llm, store)), code);
    expect(calls).toHaveLength(0);
    if (errorCode)
      expect(state.documents.get(DOC_ID)).toMatchObject({ status: 'failed', errorCode });
  });

  it('rejects a malformed document ID before touching storage', async () => {
    await expectHttpsError(
      parseCvHandler({ docId: '../../config/app' }, deps({}, llmReturning(FAKE_CV_EXTRACTION).llm)),
      'invalid-argument',
    );
  });

  it('records spend-cap and model failures on the document', async () => {
    const files = { [pdfPath]: makePdf(FAKE_CV_LINES) };
    const capped = memoryProfileStore();
    await expectHttpsError(
      parseCvHandler(
        { docId: DOC_ID },
        deps(files, llmReturning(new SpendCapExceededError()).llm, capped.store),
      ),
      'resource-exhausted',
    );
    expect(capped.state.documents.get(DOC_ID)).toMatchObject({ errorCode: 'spend_cap' });

    const failed = memoryProfileStore();
    await expectHttpsError(
      parseCvHandler(
        { docId: DOC_ID },
        deps(files, llmReturning(new LlmOutputError('schema', 3.1)).llm, failed.store),
      ),
      'unavailable',
    );
    expect(failed.state.documents.get(DOC_ID)).toMatchObject({
      errorCode: 'model_failed',
      costPence: 3.1,
    });
  });

  it('never logs CV text', async () => {
    const { llm } = llmReturning(FAKE_CV_EXTRACTION);
    await parseCvHandler({ docId: DOC_ID }, deps({ [pdfPath]: makePdf(FAKE_CV_LINES) }, llm));
    await parseCvHandler(
      { docId: DOC_ID },
      deps({ [pdfPath]: makePdf(['Alex Example', 'too short']) }, llm),
    ).catch(() => undefined);
    const logged = JSON.stringify(logs);
    for (const line of FAKE_CV_LINES) expect(logged).not.toContain(line);
    for (const draft of FAKE_CV_EXTRACTION.facts.filter((f) => f.text.length > 12)) {
      expect(logged).not.toContain(draft.text);
    }
    expect(logs.map((line) => line.event)).toContain('parse_cv.done');
  });
});
