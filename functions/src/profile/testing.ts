import type { ExistingFact, ParseErrorCode } from '@hireframe/shared';

import type { ApplyParseInput, NewFact, ProfileStore } from './store.js';

/** In-memory ProfileStore for handler tests. */
export function memoryProfileStore(existing: ExistingFact[] = []) {
  const state = {
    facts: [...existing],
    documents: new Map<
      string,
      {
        status: string;
        sha256?: string;
        fileName?: string;
        duplicateOf?: string;
        errorCode?: ParseErrorCode;
        costPence?: number;
      }
    >(),
    applied: [] as ApplyParseInput[],
    manual: [] as NewFact[],
  };
  let nextId = 0;
  const store: ProfileStore = {
    beginParse(docId, { sha256, fileName }) {
      state.documents.set(docId, { status: 'parsing', sha256, fileName });
      return Promise.resolve();
    },
    findParsedDuplicate(sha256, docId) {
      for (const [id, document] of state.documents) {
        if (id !== docId && document.status === 'parsed' && document.sha256 === sha256) {
          return Promise.resolve(id);
        }
      }
      return Promise.resolve(null);
    },
    markDuplicate(docId, duplicateOf) {
      const document = state.documents.get(docId);
      state.documents.set(docId, { ...document, status: 'parsed', duplicateOf });
      return Promise.resolve();
    },
    failParse(docId, code, costPence) {
      state.documents.set(docId, {
        ...state.documents.get(docId),
        status: 'failed',
        errorCode: code,
        ...(costPence === undefined ? {} : { costPence }),
      });
      return Promise.resolve();
    },
    listFacts: () => Promise.resolve([...state.facts]),
    applyParse(input) {
      state.applied.push(input);
      state.documents.set(input.docId, { ...state.documents.get(input.docId), status: 'parsed' });
      for (const fact of input.add) {
        state.facts.push({
          id: `f${String(++nextId)}`,
          content: fact.draft,
          status: 'active',
          source: 'cv',
        });
      }
      return Promise.resolve();
    },
    addManualFacts(facts) {
      state.manual.push(...facts);
      return Promise.resolve(facts.map(() => `m${String(++nextId)}`));
    },
  };
  return { store, state };
}
