import {
  AddFactExtractionSchema,
  AddFactInputSchema,
  factKey,
  verifyEvidence,
  type AddFactExtraction,
  type AddFactResult,
} from '@hireframe/shared';
import { HttpsError } from 'firebase-functions/https';

import { ADD_FACT_SYSTEM, wrapUntrusted } from '../cv/prompt.js';
import type { LlmCallInput, LlmCallResult } from '../llm/call.js';
import { LlmOutputError } from '../llm/errors.js';
import { log } from '../log.js';
import type { NewFact, ProfileStore } from './store.js';

/**
 * addFact (PRD R2): the owner's free-text note → 1–5 atomic facts with `source: 'manual'`.
 * Facts whose type and text already exist (active or archived) are skipped, not duplicated.
 */
export interface AddFactDeps {
  store: ProfileStore;
  llm: (input: LlmCallInput<AddFactExtraction>) => Promise<LlmCallResult<AddFactExtraction>>;
  now: () => Date;
}

export async function addFactHandler(data: unknown, deps: AddFactDeps): Promise<AddFactResult> {
  const input = AddFactInputSchema.safeParse(data);
  if (!input.success)
    throw new HttpsError('invalid-argument', 'Write between 1 and 2,000 characters.');
  const { text } = input.data;

  let result: LlmCallResult<AddFactExtraction>;
  try {
    result = await deps.llm({
      purpose: 'addFact',
      system: ADD_FACT_SYSTEM,
      user: wrapUntrusted('note', text),
      schema: AddFactExtractionSchema,
    });
  } catch (error) {
    if (error instanceof LlmOutputError) {
      throw new HttpsError(
        'unavailable',
        "That note couldn't be turned into facts. Try rewording it.",
      );
    }
    throw error;
  }

  const known = new Set((await deps.store.listFacts()).map((fact) => factKey(fact.content)));
  const facts: NewFact[] = [];
  let skippedDuplicates = 0;
  for (const draft of result.data.facts) {
    const key = factKey(draft);
    if (known.has(key)) {
      skippedDuplicates++;
      continue;
    }
    known.add(key);
    facts.push({ draft, evidenceVerified: verifyEvidence(draft.evidence, text) });
  }

  const added = facts.length > 0 ? await deps.store.addManualFacts(facts, deps.now()) : [];
  log.info('add_fact.done', {
    added: added.length,
    skippedDuplicates,
    costPence: result.costPence,
  });
  return { added, skippedDuplicates };
}
