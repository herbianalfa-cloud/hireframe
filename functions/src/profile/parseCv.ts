import { createHash } from 'node:crypto';

import {
  countCompound,
  CvExtractionSchema,
  MAX_CV_BYTES,
  mergeFacts,
  ParseCvInputSchema,
  STORAGE_PATHS,
  verifyEvidence,
  type CvExtraction,
  type CvKind,
  type ParseErrorCode,
  type ParseCvResult,
  type ParseSummary,
} from '@hireframe/shared';
import { HttpsError, type FunctionsErrorCode } from 'firebase-functions/https';

import { MERGE, MIN_CV_TEXT_CHARS } from '../config.js';
import { detectKind } from '../cv/extract.js';
import { PARSE_CV_SYSTEM, PROMPT_VERSION, wrapUntrusted } from '../cv/prompt.js';
import type { LlmCallInput, LlmCallResult } from '../llm/call.js';
import { LlmOutputError, SpendCapExceededError } from '../llm/errors.js';
import { errorFields, log } from '../log.js';
import type { NewFact, ProfileStore } from './store.js';

/**
 * parseCv (PRD R2): uploaded CV → atomic facts, merged into the profile without overwriting
 * anything (ADR-018). The document at `profile/main/documents/{docId}` records progress, so a
 * client that times out still sees the result.
 */
export interface ParseCvDeps {
  store: ProfileStore;
  /** Returns the object's bytes, or null if it doesn't exist. */
  readFile: (path: string) => Promise<Uint8Array | null>;
  extract: (bytes: Uint8Array, kind: CvKind) => Promise<string>;
  llm: (input: LlmCallInput<CvExtraction>) => Promise<LlmCallResult<CvExtraction>>;
  now: () => Date;
}

const USER_ERRORS: Record<Exclude<ParseErrorCode, 'internal'>, [FunctionsErrorCode, string]> = {
  file_missing: ['not-found', 'Upload the CV first.'],
  file_too_large: ['invalid-argument', 'The file is larger than 5 MB.'],
  file_type: ['invalid-argument', "That file isn't a PDF or Word (.docx) document."],
  no_text: [
    'failed-precondition',
    "No text was found in this file. If it's a scanned PDF, upload the .docx instead.",
  ],
  spend_cap: ['resource-exhausted', 'The monthly AI spend cap has been reached.'],
  model_failed: ['unavailable', "The CV couldn't be read right now. Try again in a few minutes."],
};

const EMPTY_SUMMARY: ParseSummary = {
  factsExtracted: 0,
  added: 0,
  unchanged: 0,
  flagged: 0,
  skippedArchived: 0,
  duplicatesInCv: 0,
  unverified: 0,
  missingFromCv: 0,
};

class ParseFailure extends Error {
  override name = 'ParseFailure';
  readonly code: ParseErrorCode;
  readonly costPence: number | undefined;

  constructor(code: ParseErrorCode, costPence?: number) {
    super(code);
    this.code = code;
    this.costPence = costPence;
  }
}

async function findUpload(
  docId: string,
  readFile: ParseCvDeps['readFile'],
): Promise<{ kind: CvKind; path: string; bytes: Uint8Array } | null> {
  for (const kind of ['pdf', 'docx'] as const) {
    const path = STORAGE_PATHS.profileDocument(docId, kind);
    const bytes = await readFile(path);
    if (bytes) return { kind, path, bytes };
  }
  return null;
}

export async function parseCvHandler(data: unknown, deps: ParseCvDeps): Promise<ParseCvResult> {
  const input = ParseCvInputSchema.safeParse(data);
  if (!input.success) throw new HttpsError('invalid-argument', 'Invalid request.');
  const { docId, fileName } = input.data;

  const upload = await findUpload(docId, deps.readFile);
  if (!upload) throw new HttpsError(...USER_ERRORS.file_missing);
  const sha256 = createHash('sha256').update(upload.bytes).digest('hex');

  await deps.store.beginParse(
    docId,
    { kind: upload.kind, storagePath: upload.path, sha256, fileName },
    deps.now(),
  );
  log.info('parse_cv.started', { docId, kind: upload.kind, bytes: upload.bytes.length });

  try {
    if (upload.bytes.length > MAX_CV_BYTES) throw new ParseFailure('file_too_large');
    // The first bytes must match the extension; the client's content type isn't trusted.
    if (detectKind(upload.bytes) !== upload.kind) throw new ParseFailure('file_type');

    // The same file read again would only cost money and reword facts (ADR-022).
    const duplicateOf = await deps.store.findParsedDuplicate(sha256, docId);
    if (duplicateOf) {
      await deps.store.markDuplicate(docId, duplicateOf, deps.now());
      log.info('parse_cv.duplicate', { docId, duplicateOf });
      return { docId, summary: EMPTY_SUMMARY, duplicateOf };
    }

    const text = await deps.extract(upload.bytes, upload.kind);
    if (text.replace(/\s+/g, '').length < MIN_CV_TEXT_CHARS) throw new ParseFailure('no_text');

    let result: LlmCallResult<CvExtraction>;
    try {
      result = await deps.llm({
        purpose: 'parseCv',
        system: PARSE_CV_SYSTEM,
        user: wrapUntrusted('cv_text', text),
        schema: CvExtractionSchema,
      });
    } catch (error) {
      if (error instanceof SpendCapExceededError) throw new ParseFailure('spend_cap');
      if (error instanceof LlmOutputError) throw new ParseFailure('model_failed', error.costPence);
      log.error('parse_cv.failed', { docId, stage: 'llm', ...errorFields(error) });
      throw new ParseFailure('model_failed');
    }

    const drafts = result.data.facts;
    const verified = drafts.map((draft) => verifyEvidence(draft.evidence, text));
    const plan = mergeFacts(await deps.store.listFacts(), drafts, MERGE);
    const add: NewFact[] = plan.add.map((draft) => ({
      draft,
      evidenceVerified: verified[drafts.indexOf(draft)] ?? false,
    }));
    const summary: ParseSummary = {
      factsExtracted: drafts.length,
      added: plan.add.length,
      unchanged: plan.unchanged,
      flagged: plan.flag.length,
      skippedArchived: plan.skippedArchived,
      duplicatesInCv: plan.duplicatesInCv,
      unverified: verified.filter((ok) => !ok).length,
      missingFromCv: plan.missingFromCv,
    };

    await deps.store.applyParse({
      docId,
      add,
      flag: plan.flag,
      summary,
      model: result.model,
      promptVersion: PROMPT_VERSION,
      costPence: result.costPence,
      now: deps.now(),
    });
    log.info('parse_cv.done', {
      docId,
      ...summary,
      compoundHints: countCompound(drafts.map((draft) => draft.text)),
      costPence: result.costPence,
    });
    return { docId, summary };
  } catch (error) {
    const code = error instanceof ParseFailure ? error.code : 'internal';
    const costPence = error instanceof ParseFailure ? error.costPence : undefined;
    await deps.store.failParse(docId, code, costPence, deps.now());
    log.warn('parse_cv.failed', { docId, code });
    if (code === 'internal') throw error;
    throw new HttpsError(...USER_ERRORS[code]);
  }
}
