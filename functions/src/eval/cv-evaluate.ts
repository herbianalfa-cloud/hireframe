import {
  APPLICATION_LIMITS,
  CvContentShapeSchema,
  FINDING_INFO,
  factAliases,
  type CvHeader,
  type CvIssue,
  type CvIssueCode,
  type CvQuality,
  type TrimmedCvContent,
} from '@hireframe/shared';
import { getDocumentProxy } from 'unpdf';

import { composeCv, type ComposeResult } from '../applications/compose.js';
import { cvSystem, cvUser, type PromptFact } from '../applications/prompt.js';
import { APPLICATIONS } from '../config.js';
import * as Render from '../cv/render/index.js';
import { FAKE_HEADER } from '../cv/render/fixtures.js';
import { extractText } from '../cv/extract.js';
import { llmCall, type LlmCallDeps } from '../llm/call.js';
import { LlmOutputError } from '../llm/errors.js';
import type { LlmRequest, LlmResponse } from '../llm/transport.js';
import type { GoldenCase } from './cases.js';
import { cvCaseFacts, cvCaseJob, INJECTION_MARKER, type CvCase } from './cv-cases.js';
import { JUDGE_SYSTEM, JudgeOutputSchema, judgeUser, type JudgeScores } from './cv-judge.js';

/**
 * Runs one CV case through the worker's real path (`composeCv`, ADR-064): `cvWrite` through
 * `llmCall` with the worker's prompt, then the compose loop with its one `cvRevise`, then the four
 * files. Only the transport differs between CI (replayed recordings) and a local live run. A
 * write that fails validation is retried once with its issue codes, as the worker's next run does.
 * The loop is bounded by `APPLICATION_LIMITS` (3 model calls) and nothing here re-enqueues.
 */
export interface CvCaseResult {
  id: string;
  tags: readonly string[];
  profile: 'full' | 'thin';
  /** The first write passed `validateCv`. */
  firstWriteValid: boolean;
  /** A CV shipped. False when every write was invalid or a call failed. */
  shipped: boolean;
  failure?: string;
  /** Model calls the case made: writes, revision and judge. */
  calls: number;
  writeCalls: number;
  reviseCalls: number;
  costPence: number;
  judgeCostPence: number;
  tokens: { input: number; output: number; cacheRead: number; cacheWrite: number };
  /** `tokens` for the write and revision calls only. */
  cvTokens: { input: number; output: number };
  /** The issue codes of each write, in order; an empty list is a write that validated. */
  writeIssues: CvIssueCode[][];
  quality?: CvQuality;
  /** The first draft's hard and soft finding counts (the final's are `hard` and `soft`). */
  draftHard?: number;
  draftSoft?: number;
  coverage?: number;
  hard: number;
  soft: number;
  pages: number;
  notePages: number;
  /** PDF and DOCX hold the same text in the same order. */
  textsMatch: boolean;
  emDash: boolean;
  markerLeaked: boolean;
  judge?: JudgeScores;
}

const PDF_PAGES_OPTIONS = { verbosity: 0 } as const;

async function pageCount(bytes: Uint8Array): Promise<number> {
  const pdf = await getDocumentProxy(new Uint8Array(bytes), PDF_PAGES_OPTIONS);
  return pdf.numPages;
}

const squash = (text: string): string => text.replace(/\s+/g, ' ');

/** Every part appears in `text`, each after the one before. */
function inOrder(text: string, parts: readonly string[]): boolean {
  const flat = squash(text);
  let from = 0;
  for (const part of parts) {
    const needle = squash(part);
    const at = flat.indexOf(needle, from);
    if (at < from) return false;
    from = at + needle.length;
  }
  return true;
}

export function readingOrder(content: TrimmedCvContent): string[] {
  const parts: string[] = [];
  if (content.summary) parts.push(content.summary.text);
  parts.push(...content.education.map((line) => line.line));
  for (const entries of [content.experience, content.projects]) {
    for (const entry of entries) {
      parts.push(
        entry.heading.role,
        ...(entry.heading.org === '' ? [] : [entry.heading.org]),
        ...entry.bullets.map((b) => b.text),
      );
    }
  }
  parts.push(...content.skills.map((skill) => skill.label));
  return parts;
}

function promptFacts(facts: ReturnType<typeof cvCaseFacts>): PromptFact[] {
  return facts
    .filter((fact) => fact.status === 'active' && fact.content.type !== 'preference')
    .map((fact) => ({
      id: fact.id,
      type: fact.content.type,
      text: fact.content.text,
      dates: fact.content.dates,
    }));
}

interface Tally {
  sends: number;
  byPurpose: Record<string, number>;
  tokens: { input: number; output: number; cacheRead: number; cacheWrite: number };
  cvTokens: { input: number; output: number };
}

/** Counts this case's sends and tokens; the shared transport underneath stays the same. */
function tallied(deps: LlmCallDeps): { deps: LlmCallDeps; tally: Tally } {
  const tally: Tally = {
    sends: 0,
    byPurpose: {},
    tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    cvTokens: { input: 0, output: 0 },
  };
  const inner = deps.transport;
  return {
    tally,
    deps: {
      ...deps,
      transport: {
        countTokens: (request: LlmRequest) => inner.countTokens(request),
        async send(request: LlmRequest): Promise<LlmResponse> {
          const response = await inner.send(request);
          tally.sends += 1;
          tally.byPurpose[request.purpose] = (tally.byPurpose[request.purpose] ?? 0) + 1;
          for (const key of ['input', 'output', 'cacheRead', 'cacheWrite'] as const) {
            tally.tokens[key] += response.tokens[key];
          }
          if (request.purpose !== 'cvJudge') {
            tally.cvTokens.input += response.tokens.input + response.tokens.cacheRead;
            tally.cvTokens.output += response.tokens.output;
          }
          return response;
        },
      },
    },
  };
}

const EM_DASH = '—';

/** The four rendered files of a shipped case, for the CLI to write to `tmp/cv-eval/`. */
export type CvCaseFiles = Record<'cv.pdf' | 'cv.docx' | 'note.pdf' | 'note.docx', Uint8Array>;

export async function evaluateCvCase(
  entry: CvCase,
  golden: readonly GoldenCase[],
  shared: LlmCallDeps,
  header: CvHeader = FAKE_HEADER,
): Promise<{ result: CvCaseResult; files?: CvCaseFiles }> {
  const { deps, tally } = tallied(shared);
  const job = cvCaseJob(entry, golden);
  const facts = cvCaseFacts(entry);
  const shown = promptFacts(facts);
  const { toAlias, toId } = factAliases(shown.map((fact) => fact.id));
  const system = cvSystem(shown, toAlias);
  const render = Render;
  const limits = APPLICATION_LIMITS;

  const base = {
    id: entry.id,
    tags: entry.tags,
    profile: entry.profile,
    hard: 0,
    soft: 0,
    pages: 0,
    notePages: 0,
    textsMatch: false,
    emDash: false,
    markerLeaked: false,
  } as const;
  const writeIssues: CvIssueCode[][] = [];
  const finish = (
    extra: Partial<CvCaseResult> & Pick<CvCaseResult, 'firstWriteValid' | 'shipped'>,
    judgeCost: number,
  ): CvCaseResult => ({
    ...base,
    calls: tally.sends,
    writeCalls: tally.byPurpose.cvWrite ?? 0,
    reviseCalls: tally.byPurpose.cvRevise ?? 0,
    writeIssues,
    costPence: 0,
    judgeCostPence: judgeCost,
    tokens: tally.tokens,
    cvTokens: tally.cvTokens,
    ...extra,
  });

  let counted = 0;
  let spent = 0;
  let issues: readonly CvIssueCode[] | undefined;
  let where: readonly CvIssue[] | undefined;
  let firstWriteValid = false;
  let composed: ComposeResult | null = null;
  try {
    for (let attempt = 1; attempt <= limits.maxWrites; attempt += 1) {
      counted = attempt;
      const written = await llmCall(deps, {
        purpose: 'cvWrite',
        system,
        user: cvUser({ job, notes: entry.notes, issues, where, toAlias }),
        schema: CvContentShapeSchema,
        maxSends: 1,
      });
      spent += written.costPence;
      composed = await composeCv(
        {
          render,
          facts: () => Promise.resolve(facts),
          countAttempt: () => {
            counted += 1;
            return Promise.resolve(true);
          },
          revise: async (user) => {
            const revised = await llmCall(deps, {
              purpose: 'cvRevise',
              system,
              user,
              schema: CvContentShapeSchema,
              maxSends: 1,
            });
            spent += revised.costPence;
            return revised;
          },
          beforeDeadline: () => true,
        },
        {
          draft: written.data,
          header,
          job,
          notes: entry.notes,
          facts,
          toAlias,
          toId,
          attempt: counted,
          maxAttempts: limits.maxAttempts,
          scoreTarget: APPLICATIONS.scoreTarget,
          writeCostPence: written.costPence,
        },
      );
      writeIssues.push(composed.kind === 'invalid' ? [...composed.issues] : []);
      if (attempt === 1) firstWriteValid = composed.kind !== 'invalid';
      if (composed.kind !== 'invalid') break;
      issues = composed.issues;
      where = composed.where;
    }
  } catch (error) {
    if (error instanceof LlmOutputError) {
      spent += error.costPence;
      return {
        result: finish(
          { firstWriteValid, shipped: false, failure: 'model_output', costPence: spent },
          0,
        ),
      };
    }
    throw error;
  }
  if (composed?.kind !== 'composed') {
    return {
      result: finish(
        {
          firstWriteValid,
          shipped: false,
          failure: `invalid (${(issues ?? []).join(', ')})`,
          costPence: spent,
        },
        0,
      ),
    };
  }

  const { shipped } = composed;
  const { fit, quality } = shipped;
  const dateOf = render.makeDateOf(
    toId,
    shipped.facts.map((fact) => ({ id: fact.id, dates: fact.content.dates })),
  );
  const note = await render.renderNotePdf(header, fit.content.coverNote);
  const cvDocx = await render.renderCvDocx(header, fit.content, dateOf, fit.spec);
  const noteDocx = await render.renderNoteDocx(header, fit.content.coverNote);
  const pdfText = await extractText(fit.bytes, 'pdf');
  const docxText = await extractText(cvDocx, 'docx');
  const noteText = await extractText(note.bytes, 'pdf');
  const noteDocxText = await extractText(noteDocx, 'docx');
  const parts = readingOrder(fit.content);
  const noteParts = fit.content.coverNote.paragraphs.map((p) => p.text);
  const everything = [pdfText, docxText, noteText, noteDocxText].join('\n');

  const judged = await llmCall(deps, {
    purpose: 'cvJudge',
    system: JUDGE_SYSTEM,
    user: judgeUser(job, fit.content),
    schema: JudgeOutputSchema,
    maxSends: 1,
  }).catch((error: unknown) => {
    // Report-only: a judge that fails leaves its column empty and never fails the case.
    if (error instanceof LlmOutputError) return { error: error.costPence };
    throw error;
  });

  const hard = quality.findings.filter((f) => FINDING_INFO[f.code].severity === 'hard').length;
  const result = finish(
    {
      firstWriteValid,
      shipped: true,
      quality,
      draftHard: composed.draft.hard,
      draftSoft: composed.draft.soft,
      coverage: quality.criteria.tailoring / 2,
      hard,
      soft: quality.findings.length - hard,
      pages: await pageCount(fit.bytes),
      notePages: note.pages,
      textsMatch:
        inOrder(pdfText, parts) && inOrder(docxText, parts) && inOrder(noteDocxText, noteParts),
      emDash: everything.includes(EM_DASH),
      markerLeaked: everything.includes(INJECTION_MARKER),
      ...('data' in judged ? { judge: judged.data } : {}),
      costPence: spent,
    },
    'data' in judged ? judged.costPence : judged.error,
  );
  return {
    result,
    files: {
      'cv.pdf': fit.bytes,
      'cv.docx': cvDocx,
      'note.pdf': note.bytes,
      'note.docx': noteDocx,
    },
  };
}
