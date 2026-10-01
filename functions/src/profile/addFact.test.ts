import Anthropic from '@anthropic-ai/sdk';
import type { AddFactExtraction, FactDraft } from '@hireframe/shared';
import type { HttpsError } from 'firebase-functions/https';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { safeHandler } from '../errors.js';
import type { LlmCallInput, LlmCallResult } from '../llm/call.js';
import { LlmOutputError } from '../llm/errors.js';
import { setLogSink, type LogFields } from '../log.js';
import { addFactHandler } from './addFact.js';
import { memoryProfileStore } from './testing.js';

const NOTE = 'Finished the Olist SQL project; the live dashboard is at example.com/olist.';

let logs: LogFields[];

beforeEach(() => {
  logs = [];
  setLogSink((_level, event, fields) => logs.push({ event, ...fields }));
});

afterEach(() => {
  setLogSink();
});

function llm(extraction: AddFactExtraction) {
  const calls: LlmCallInput<AddFactExtraction>[] = [];
  const fn = (
    input: LlmCallInput<AddFactExtraction>,
  ): Promise<LlmCallResult<AddFactExtraction>> => {
    calls.push(input);
    return Promise.resolve({ data: extraction, model: 'claude-haiku-4-5', costPence: 0.2 });
  };
  return { fn, calls };
}

const projectFact: FactDraft = {
  type: 'project',
  text: 'Finished the Olist SQL project',
  evidence: 'Finished the Olist SQL project',
  dates: {},
  tags: ['sql'],
  lanes: ['primary'],
};

const extraction: AddFactExtraction = {
  facts: [
    projectFact,
    {
      type: 'achievement',
      text: 'Published a live dashboard for the Olist project',
      evidence: 'the live dashboard is at example.com/olist',
      dates: {},
      tags: ['dashboard'],
      lanes: ['primary'],
    },
  ],
};

describe('addFactHandler', () => {
  it('structures a note into manual facts with verified evidence', async () => {
    const { store, state } = memoryProfileStore();
    const { fn, calls } = llm(extraction);
    const result = await addFactHandler(
      { text: `  ${NOTE}  ` },
      { store, llm: fn, now: () => new Date() },
    );
    expect(result).toEqual({ added: ['m1', 'm2'], skippedDuplicates: 0 });
    expect(state.manual.map((fact) => fact.evidenceVerified)).toEqual([true, true]);
    expect(calls[0]?.purpose).toBe('addFact');
    expect(calls[0]?.user).toBe(`<note>\n${NOTE}\n</note>`);
  });

  it('skips facts whose type and text already exist', async () => {
    const { store } = memoryProfileStore([
      { id: 'f1', content: projectFact, status: 'archived', source: 'cv' },
    ]);
    const result = await addFactHandler(
      { text: NOTE },
      { store, llm: llm(extraction).fn, now: () => new Date() },
    );
    expect(result).toEqual({ added: ['m1'], skippedDuplicates: 1 });
  });

  it('rejects empty or oversized notes without calling the model', async () => {
    const { store } = memoryProfileStore();
    const { fn, calls } = llm(extraction);
    for (const text of ['   ', 'x'.repeat(2001)]) {
      const error: unknown = await addFactHandler(
        { text },
        { store, llm: fn, now: () => new Date() },
      ).catch((caught: unknown) => caught);
      expect((error as HttpsError).code).toBe('invalid-argument');
    }
    expect(calls).toHaveLength(0);
  });

  it('never logs the note', async () => {
    const { store } = memoryProfileStore();
    await addFactHandler({ text: NOTE }, { store, llm: llm(extraction).fn, now: () => new Date() });
    expect(JSON.stringify(logs)).not.toContain('Olist');
  });

  it.each([
    ['unusable model output', new LlmOutputError('schema', 0.1)],
    ['a timed-out model call', new Anthropic.APIConnectionTimeoutError()],
    ['an error whose message echoes the note', new Error(NOTE)],
  ])('never logs the note when the model step fails: %s', async (_name, failure) => {
    const { store } = memoryProfileStore();
    const failing = () => Promise.reject(failure);
    const run = safeHandler('addFact', (data: unknown) =>
      addFactHandler(data, { store, llm: failing, now: () => new Date() }),
    );
    await expect(run({ text: NOTE })).rejects.toThrow();
    expect(JSON.stringify(logs)).not.toContain('Olist');
  });
});
