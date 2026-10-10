import {
  AddFactExtractionSchema,
  AddFactInputSchema,
  factKey,
  verifyEvidence,
  type AddFactExtraction,
  type AddFactResult,
  type ExistingFact,
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

/** What a note became: facts to write, and the active facts it repeated. */
export interface NotePlan {
  fresh: NewFact[];
  /** Active facts the note repeated: an answer links to them instead of adding a copy. */
  knownIds: string[];
  skippedDuplicates: number;
  costPence: number;
}

/**
 * The model call and de-duplication shared by `addFact` and an application answer (M7): the text
 * goes in a `<note>` tag it can't close, evidence is verified against it, and a fact whose type
 * and text already exist (active or archived) is skipped rather than written again. `purpose`
 * only picks the cost line; the prompt and the output schema are the same.
 */
export async function planNoteFacts(
  deps: Pick<AddFactDeps, 'llm'> & { existing: () => Promise<ExistingFact[]> },
  purpose: 'addFact' | 'answerFact',
  text: string,
): Promise<NotePlan> {
  let result: LlmCallResult<AddFactExtraction>;
  try {
    result = await deps.llm({
      purpose,
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

  const known = new Map<string, ExistingFact | null>();
  for (const fact of await deps.existing()) known.set(factKey(fact.content), fact);
  const fresh: NewFact[] = [];
  const knownIds: string[] = [];
  let skippedDuplicates = 0;
  for (const draft of result.data.facts) {
    const key = factKey(draft);
    if (known.has(key)) {
      skippedDuplicates++;
      const existing = known.get(key);
      if (existing?.status === 'active' && !knownIds.includes(existing.id)) {
        knownIds.push(existing.id);
      }
      continue;
    }
    known.set(key, null);
    fresh.push({ draft, evidenceVerified: verifyEvidence(draft.evidence, text) });
  }
  return { fresh, knownIds, skippedDuplicates, costPence: result.costPence };
}

export async function addFactHandler(data: unknown, deps: AddFactDeps): Promise<AddFactResult> {
  const input = AddFactInputSchema.safeParse(data);
  if (!input.success)
    throw new HttpsError('invalid-argument', 'Write between 1 and 2,000 characters.');
  const { text } = input.data;

  const plan = await planNoteFacts(
    { llm: deps.llm, existing: () => deps.store.listFacts() },
    'addFact',
    text,
  );
  const added =
    plan.fresh.length > 0 ? await deps.store.addManualFacts(plan.fresh, deps.now()) : [];
  log.info('add_fact.done', {
    added: added.length,
    skippedDuplicates: plan.skippedDuplicates,
    costPence: plan.costPence,
  });
  return { added, skippedDuplicates: plan.skippedDuplicates };
}
