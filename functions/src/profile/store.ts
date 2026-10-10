import {
  DOCS,
  FactSchema,
  isParseStalled,
  PATHS,
  ProfileDocumentSchema,
  type CvKind,
  type ExistingFact,
  type FactContent,
  type FactDraft,
  type ParseErrorCode,
  type ParseSummary,
} from '@hireframe/shared';
import type { Firestore, WriteBatch } from 'firebase-admin/firestore';
import type { Storage } from 'firebase-admin/storage';
import { HttpsError } from 'firebase-functions/https';

import { log } from '../log.js';
import { timestampsToDates } from '../timestamps.js';
import type { ResetStore } from './reset.js';

/**
 * Admin SDK writes for the profile brain (ADR-018). New facts are written with their v1
 * snapshot in the same batch; a proposed change only sets `review`, never the content.
 */
export interface NewFact {
  draft: FactDraft;
  evidenceVerified: boolean;
}

export interface ApplyParseInput {
  docId: string;
  add: NewFact[];
  flag: { id: string; proposed: FactContent }[];
  summary: ParseSummary;
  model: string;
  promptVersion: string;
  costPence: number;
  now: Date;
}

export interface ProfileStore {
  /** Marks the document `parsing`; throws if it's already parsed or being parsed. */
  beginParse(
    docId: string,
    upload: { kind: CvKind; storagePath: string; sha256: string; fileName: string },
    now: Date,
  ): Promise<void>;
  /** An earlier parsed upload with the same bytes, if any (ADR-022). */
  findParsedDuplicate(sha256: string, docId: string): Promise<string | null>;
  /** Marks the document parsed as a copy of `duplicateOf`, with no summary. */
  markDuplicate(docId: string, duplicateOf: string, now: Date): Promise<void>;
  failParse(
    docId: string,
    code: ParseErrorCode,
    costPence: number | undefined,
    now: Date,
  ): Promise<void>;
  listFacts(): Promise<ExistingFact[]>;
  applyParse(input: ApplyParseInput): Promise<void>;
  addManualFacts(facts: NewFact[], now: Date): Promise<string[]>;
}

function factDocument(
  fact: NewFact,
  source: 'cv' | 'manual',
  sourceDocId: string | undefined,
  now: Date,
  answerFor?: { jobId: string },
) {
  return {
    ...fact.draft,
    status: 'active' as const,
    source,
    ...(sourceDocId ? { sourceDocId } : {}),
    ...(answerFor ? { answerFor } : {}),
    version: 1,
    evidenceVerified: fact.evidenceVerified,
    createdAt: now,
    updatedAt: now,
    schemaVersion: 1 as const,
  };
}

/** One document to create: a fact, or the v1 snapshot beside it. */
export interface FactWrite {
  path: string;
  data: Record<string, unknown>;
}

/**
 * A manual fact and its v1 snapshot, ready to create in a batch or a transaction. `answerFor`
 * marks a fact that came from an application answer (M7). Returns the new IDs in order.
 */
export function manualFactWrites(
  firestore: Firestore,
  facts: readonly NewFact[],
  now: Date,
  answerFor?: { jobId: string },
): { ids: string[]; writes: FactWrite[] } {
  const ids: string[] = [];
  const writes: FactWrite[] = [];
  for (const fact of facts) {
    const ref = firestore.collection(PATHS.facts).doc();
    const data = factDocument(fact, 'manual', undefined, now, answerFor);
    ids.push(ref.id);
    writes.push({ path: ref.path, data });
    writes.push({
      path: PATHS.factVersion(ref.id, 1),
      data: { snapshot: data, change: 'created', at: now },
    });
  }
  return { ids, writes };
}

export function firestoreProfileStore(firestore: Firestore): ProfileStore {
  function writeNewFacts(
    batch: WriteBatch,
    facts: NewFact[],
    source: 'cv' | 'manual',
    sourceDocId: string | undefined,
    now: Date,
  ): string[] {
    return facts.map((fact) => {
      const ref = firestore.collection(PATHS.facts).doc();
      const data = factDocument(fact, source, sourceDocId, now);
      batch.create(ref, data);
      batch.create(firestore.doc(PATHS.factVersion(ref.id, 1)), {
        snapshot: data,
        change: 'created',
        at: now,
      });
      return ref.id;
    });
  }

  return {
    async beginParse(docId, { kind, storagePath, sha256, fileName }, now) {
      const ref = firestore.doc(PATHS.document(docId));
      await firestore.runTransaction(async (tx) => {
        const snapshot = await tx.get(ref);
        let createdAt = now;
        if (snapshot.exists) {
          const current = ProfileDocumentSchema.safeParse(timestampsToDates(snapshot.data()));
          if (current.success) {
            createdAt = current.data.createdAt;
            if (current.data.status === 'parsed') {
              throw new HttpsError('already-exists', 'This CV has already been read.');
            }
            if (current.data.status === 'parsing' && !isParseStalled(current.data, now)) {
              throw new HttpsError('aborted', 'This CV is already being read.');
            }
          }
        }
        tx.set(ref, {
          kind,
          storagePath,
          sha256,
          fileName,
          status: 'parsing',
          createdAt,
          updatedAt: now,
          schemaVersion: 1,
        });
      });
    },

    async findParsedDuplicate(sha256, docId) {
      // Single-field equality, so no composite index; parsed status is checked here.
      const snapshot = await firestore
        .collection(PATHS.documents)
        .where('sha256', '==', sha256)
        .get();
      const match = snapshot.docs.find((doc) => doc.id !== docId && doc.get('status') === 'parsed');
      return match?.id ?? null;
    },

    async markDuplicate(docId, duplicateOf, now) {
      await firestore.doc(PATHS.document(docId)).update({
        status: 'parsed',
        duplicateOf,
        updatedAt: now,
      });
    },

    async failParse(docId, code, costPence, now) {
      await firestore.doc(PATHS.document(docId)).update({
        status: 'failed',
        errorCode: code,
        ...(costPence === undefined ? {} : { costPence }),
        updatedAt: now,
      });
    },

    async listFacts() {
      const snapshot = await firestore.collection(PATHS.facts).get();
      const facts: ExistingFact[] = [];
      let invalid = 0;
      for (const doc of snapshot.docs) {
        const parsed = FactSchema.safeParse(timestampsToDates(doc.data()));
        if (!parsed.success) {
          invalid++;
          continue;
        }
        const { type, text, evidence, dates, tags, lanes, status, source } = parsed.data;
        facts.push({
          id: doc.id,
          content: { type, text, evidence, dates, tags, lanes },
          status,
          source,
        });
      }
      if (invalid > 0) log.warn('profile.fact_invalid', { count: invalid });
      return facts;
    },

    async applyParse(input) {
      const batch = firestore.batch();
      writeNewFacts(batch, input.add, 'cv', input.docId, input.now);
      for (const { id, proposed } of input.flag) {
        batch.update(firestore.doc(PATHS.fact(id)), {
          review: { kind: 'changed', proposed, docId: input.docId, at: input.now },
        });
      }
      batch.update(firestore.doc(PATHS.document(input.docId)), {
        status: 'parsed',
        summary: input.summary,
        model: input.model,
        promptVersion: input.promptVersion,
        costPence: input.costPence,
        updatedAt: input.now,
      });
      await batch.commit();
    },

    async addManualFacts(facts, now) {
      const batch = firestore.batch();
      const ids = writeNewFacts(batch, facts, 'manual', undefined, now);
      await batch.commit();
      return ids;
    },
  };
}

/** Admin SDK side of resetProfile (ADR-023). */
export function firestoreResetStore(firestore: Firestore): ResetStore {
  return {
    async parsingDocuments() {
      const snapshot = await firestore
        .collection(PATHS.documents)
        .where('status', '==', 'parsing')
        .get();
      return snapshot.docs.map((doc) => timestampsToDates(doc.data()));
    },

    async deleteProfile() {
      const facts = firestore.collection(PATHS.facts);
      const documents = firestore.collection(PATHS.documents);
      const [factCount, documentCount] = await Promise.all([
        facts.count().get(),
        documents.count().get(),
      ]);
      // recursiveDelete also removes each fact's versions subcollection.
      await firestore.recursiveDelete(facts);
      await firestore.recursiveDelete(documents);
      // The work-rights setting (M4) is profile data too.
      await firestore.doc(DOCS.profileMain).delete();
      return { facts: factCount.data().count, documents: documentCount.data().count };
    },
  };
}

/** Deletes every object under a prefix and returns how many there were (resetProfile). */
export function bucketFileDeleter(bucket: ReturnType<Storage['bucket']>) {
  return async (prefix: string): Promise<number> => {
    const [files] = await bucket.getFiles({ prefix });
    await bucket.deleteFiles({ prefix });
    return files.length;
  };
}
