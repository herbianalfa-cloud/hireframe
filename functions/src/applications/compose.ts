import {
  CV_CRITERIA,
  CvContentSchema,
  FILL_FULL_BAND,
  citedFactIds,
  clampCvCounts,
  dropUnsupportedSkills,
  issueCodes,
  normaliseCvText,
  orderEntries,
  scoreCv,
  scrubDashes,
  validateCv,
  type CvContent,
  type CvFact,
  type CvHeader,
  type CvIssue,
  type CvIssueCode,
  type CvQuality,
  type CvScore,
  type ExistingFact,
  type RevisionSkipped,
} from '@hireframe/shared';

import type * as Render from '../cv/render/index.js';
import type { LlmCallResult } from '../llm/call.js';
import { DailyCapExceededError, LlmOutputError, SpendCapExceededError } from '../llm/errors.js';
import { errorFields, log } from '../log.js';
import { BULLET_FACT_TYPES, cvReviseUser, type CvReviseInput } from './prompt.js';
import type { JobForCv } from './store.js';

/**
 * The CV loop (CV quality plan §3): write → scrub → validate → order → fit → lint → score →
 * (one revision, only when it can help) → ship the best valid candidate. Pure of Firebase: the
 * renderer, the facts, the attempt count and the revision call are injected, so the worker and
 * the eval run the same path and every branch is testable without a network.
 *
 * Bounds (CLAUDE.md "No self-triggering code"): at most one model call (`revise`), made only
 * when `attempt < maxAttempts`, only before the start deadline, and only after `countAttempt`
 * recorded it. Nothing here loops over external calls, reschedules or re-enqueues.
 *
 * Every failure of the revision ships the draft and records why in `revisionSkipped`. A candidate
 * ships only after `validateCv` passed on its final text, against facts re-read after the call,
 * so a revision can never add an uncited claim.
 */

export type ComposeRenderer = Pick<
  typeof Render,
  'fitPage' | 'makeDateOf' | 'makeEndKeyOf' | 'makeHasEndOf' | 'CvRenderError'
>;
type FitOk = Extract<Awaited<ReturnType<ComposeRenderer['fitPage']>>, { ok: true }>;

/** Underfill is worth a revision only when this many unused bullet facts could fill it. */
const MIN_UNUSED_FOR_FILL = 2;
/** Aliases of unused facts sent back to the model. */
const MAX_UNUSED_SHOWN = 12;
/** Findings kept on the `cvs` doc (`CvQualitySchema`). */
const MAX_STORED_FINDINGS = 20;

export const validatorFacts = (facts: readonly ExistingFact[]): CvFact[] =>
  facts.map((fact) => ({
    id: fact.id,
    type: fact.content.type,
    text: fact.content.text,
    evidence: fact.content.evidence,
    status: fact.status,
  }));

export interface ComposeDeps {
  render: ComposeRenderer;
  /** Every fact, archived ones included; read again after the revision call. */
  facts(): Promise<ExistingFact[]>;
  /**
   * Counts one model call before it is made (the worker's precondition transaction). False when
   * the owner moved the application meanwhile: nothing may be called then.
   */
  countAttempt(): Promise<boolean>;
  /** The revision call: `user` is the whole user message; the worker binds the system prompt. */
  revise(user: string): Promise<LlmCallResult<CvContent>>;
  /** False once the run is past `workerStartDeadlineMs`. */
  beforeDeadline(): boolean;
}

export interface ComposeInput {
  /** The model's first answer, parsed with `CvContentShapeSchema`. */
  draft: CvContent;
  header: CvHeader;
  job: JobForCv;
  notes?: string | undefined;
  /** Facts as read before the write call. */
  facts: readonly ExistingFact[];
  toAlias: ReadonlyMap<string, string>;
  toId: ReadonlyMap<string, string>;
  /** Calls already counted for this job, the write included. */
  attempt: number;
  maxAttempts: number;
  scoreTarget: number;
  /** What the write cost, in pence. */
  writeCostPence: number;
}

export interface Shipped {
  fit: FitOk;
  /** The validated content before the trim: the citations to record. */
  cited: CvContent;
  /** Every fact ID `cited` rests on. */
  factIds: string[];
  quality: CvQuality;
  /** Write and revision together. */
  costPence: number;
  /** The facts the shipped candidate was validated against (dates for the files). */
  facts: readonly ExistingFact[];
}

export type ComposeResult =
  | { kind: 'invalid'; issues: CvIssueCode[]; where: CvIssue[]; skillsDropped: number }
  /** The owner moved the application before the revision was counted. */
  | { kind: 'lost' }
  | {
      kind: 'composed';
      shipped: Shipped;
      /** The first draft's score and findings (the eval reports them; they are not stored). */
      draft: { total: number; hard: number; soft: number; skillsDropped: number };
      /** Set when the revision's failure ends the run, after the draft ships. */
      stop?: 'cap' | 'error';
    };

interface Candidate {
  fit: FitOk;
  cited: CvContent;
  score: CvScore;
  dashesReplaced: number;
  /** Skills removed before validating: uncited, or citing a fact that is not a skill. */
  skillsDropped: number;
  facts: readonly ExistingFact[];
}

type Prepared =
  | { ok: true; candidate: Candidate }
  | { ok: false; issues: CvIssueCode[]; where: CvIssue[]; skillsDropped: number };

/** Scrub, validate, order, fit and score one model output. */
async function prepare(
  deps: ComposeDeps,
  input: ComposeInput,
  raw: CvContent,
  facts: readonly ExistingFact[],
): Promise<Prepared> {
  // NFC first: the validator checks printability after NFC, the renderer does not.
  // Counts next: a sixth bullet on one entry loses that bullet, not the whole output.
  const clamped = clampCvCounts(normaliseCvText(raw));
  const kept = dropUnsupportedSkills(clamped, input.toId, validatorFacts(facts));
  const scrubbed = scrubDashes(kept.content);
  const verdict = validateCv(scrubbed.content, input.toId, validatorFacts(facts));
  if (!verdict.ok)
    return {
      ok: false,
      issues: issueCodes(verdict.issues),
      where: verdict.issues,
      skillsDropped: kept.dropped,
    };
  const strict = CvContentSchema.safeParse(scrubbed.content);
  if (!strict.success)
    return { ok: false, issues: ['too_long'], where: [], skillsDropped: kept.dropped };

  const { render } = deps;
  const dated = facts.map((fact) => ({ id: fact.id, dates: fact.content.dates }));
  const ordered = orderEntries(
    strict.data,
    render.makeEndKeyOf(input.toId, dated),
    render.makeHasEndOf(input.toId, dated),
  );
  try {
    const fit = await render.fitPage(input.header, ordered, render.makeDateOf(input.toId, dated));
    if (!fit.ok) return { ok: false, issues: [fit.code], where: [], skillsDropped: kept.dropped };
    const score = scoreCv({
      content: fit.content,
      facts: validatorFacts(facts),
      aliases: input.toId,
      requirements: input.job.requirements,
      company: input.job.company,
      jobTitle: input.job.title,
      layout: {
        fill: fit.fill,
        bulletLines: fit.lines.bullets,
        headingWraps: fit.lines.headingWraps,
      },
      target: input.scoreTarget,
    });
    return {
      ok: true,
      candidate: {
        fit,
        cited: ordered,
        score,
        dashesReplaced: scrubbed.replaced,
        skillsDropped: kept.dropped,
        facts,
      },
    };
  } catch (error) {
    if (error instanceof render.CvRenderError)
      return { ok: false, issues: [error.code], where: [], skillsDropped: kept.dropped };
    throw error;
  }
}

/** Active facts a bullet could rest on that the draft doesn't cite. */
function unusedBulletFacts(
  facts: readonly ExistingFact[],
  citedIds: ReadonlySet<string>,
): ExistingFact[] {
  return facts.filter(
    (fact) =>
      fact.status === 'active' &&
      BULLET_FACT_TYPES.has(fact.content.type) &&
      !citedIds.has(fact.id),
  );
}

/** Whether a revision could raise this draft's score, and what it would be told. */
function revisionPlan(
  input: ComposeInput,
  draft: Candidate,
): { fixable: true; unusedAliases: string[] } | { fixable: false } {
  const unused = unusedBulletFacts(input.facts, new Set(citedFactIds(draft.cited, input.toId)));
  const underfilled = 1 - draft.fit.fill > FILL_FULL_BAND;
  const fixable =
    draft.score.findings.some((finding) => finding.fixable) ||
    (underfilled && unused.length >= MIN_UNUSED_FOR_FILL);
  if (!fixable) return { fixable: false };
  // The ones the job asks for come first.
  const wanted = new Set(input.job.requirements.flatMap((requirement) => requirement.factIds));
  const unusedAliases = [...unused]
    .sort((a, b) => Number(wanted.has(b.id)) - Number(wanted.has(a.id)))
    .flatMap((fact) => input.toAlias.get(fact.id) ?? [])
    .slice(0, MAX_UNUSED_SHOWN);
  return { fixable: true, unusedAliases };
}

const hardCount = (score: CvScore): number =>
  score.findings.filter((finding) => finding.severity === 'hard').length;

/** The better candidate: fewest hard findings, then the higher total; the draft wins a tie. */
function better(draft: Candidate, revision: Candidate): Candidate {
  const hardDraft = hardCount(draft.score);
  const hardRevision = hardCount(revision.score);
  if (hardRevision !== hardDraft) return hardRevision < hardDraft ? revision : draft;
  return revision.score.total > draft.score.total ? revision : draft;
}

function qualityOf(
  chosen: Candidate,
  extra: { revised: boolean; revisionSkipped?: RevisionSkipped; draftTotal?: number },
): CvQuality {
  const { score, fit } = chosen;
  return {
    rubric: score.rubric,
    total: score.total,
    criteria: Object.fromEntries(
      CV_CRITERIA.map((name) => [name, score.criteria[name]]),
    ) as CvQuality['criteria'],
    findings: score.findings
      .slice(0, MAX_STORED_FINDINGS)
      .map((finding) => ({ code: finding.code, path: finding.path })),
    revised: extra.revised,
    ...(extra.revisionSkipped ? { revisionSkipped: extra.revisionSkipped } : {}),
    ...(extra.draftTotal !== undefined ? { draftTotal: extra.draftTotal } : {}),
    dashesReplaced: chosen.dashesReplaced,
    layout: { bodySize: fit.spec.bodySize, fill: fit.fill },
  };
}

function shippedOf(
  input: ComposeInput,
  chosen: Candidate,
  quality: CvQuality,
  costPence: number,
): Shipped {
  return {
    fit: chosen.fit,
    cited: chosen.cited,
    factIds: citedFactIds(chosen.cited, input.toId),
    quality,
    costPence,
    facts: chosen.facts,
  };
}

/** What a failed revision call means: why it was skipped, and whether it ends the run. */
function revisionFailure(error: unknown): {
  skipped: RevisionSkipped;
  stop?: 'cap' | 'error';
  costPence: number;
} {
  if (error instanceof DailyCapExceededError || error instanceof SpendCapExceededError) {
    return { skipped: 'cap', stop: 'cap', costPence: 0 };
  }
  // A refusal, invalid JSON, a cut-off answer or a schema miss: the draft stands.
  if (error instanceof LlmOutputError) {
    return { skipped: 'output', costPence: error.costPence };
  }
  log.error('cv_worker.failed', errorFields(error));
  return { skipped: 'error', stop: 'error', costPence: 0 };
}

export async function composeCv(deps: ComposeDeps, input: ComposeInput): Promise<ComposeResult> {
  const first = await prepare(deps, input, input.draft, input.facts);
  if (!first.ok) {
    const { issues, where, skillsDropped } = first;
    return { kind: 'invalid', issues, where, skillsDropped };
  }
  const { score } = first.candidate;
  const hard = hardCount(score);
  const result = await reviseAndShip(deps, input, first.candidate);
  if (result.kind !== 'composed') return result;
  return {
    ...result,
    draft: {
      total: score.total,
      hard,
      soft: score.findings.length - hard,
      skillsDropped: first.candidate.skillsDropped,
    },
  };
}

type Composed = Extract<ComposeResult, { kind: 'composed' }>;
type Shipping = Exclude<ComposeResult, Composed> | Omit<Composed, 'draft'>;

/** The rest of the loop for a valid draft: revise when it can help, then ship the best. */
async function reviseAndShip(
  deps: ComposeDeps,
  input: ComposeInput,
  draft: Candidate,
): Promise<Shipping> {
  const ship = (quality: Parameters<typeof qualityOf>[1], cost = input.writeCostPence) =>
    ({
      kind: 'composed',
      shipped: shippedOf(input, draft, qualityOf(draft, quality), cost),
    }) as const;

  if (draft.score.gatePassed) return ship({ revised: false });
  const plan = revisionPlan(input, draft);
  if (!plan.fixable) return ship({ revised: false, revisionSkipped: 'not_fixable' });
  if (input.attempt >= input.maxAttempts) {
    return ship({ revised: false, revisionSkipped: 'attempts' });
  }
  if (!deps.beforeDeadline()) return ship({ revised: false, revisionSkipped: 'deadline' });

  // The revision is a model call: it is counted first, so a run killed from here on has used it.
  let counted: boolean;
  try {
    counted = await deps.countAttempt();
  } catch (error) {
    log.error('cv_worker.failed', { step: 'count', ...errorFields(error) });
    return { ...ship({ revised: false, revisionSkipped: 'error' }), stop: 'error' };
  }
  if (!counted) return { kind: 'lost' };

  const request: CvReviseInput = {
    job: input.job,
    notes: input.notes,
    toAlias: input.toAlias,
    draft: draft.cited,
    findings: draft.score.findings,
    fill: draft.fit.fill,
    unusedAliases: plan.unusedAliases,
  };
  let raw: LlmCallResult<CvContent>;
  try {
    raw = await deps.revise(cvReviseUser(request));
  } catch (error) {
    const failure = revisionFailure(error);
    // The call can take minutes: the draft is checked again against the facts as they are now.
    const fresh = await deps.facts();
    const again = await prepare(deps, input, input.draft, fresh);
    if (!again.ok) {
      return {
        kind: 'invalid',
        issues: again.issues,
        where: again.where,
        skillsDropped: again.skillsDropped,
      };
    }
    return {
      kind: 'composed',
      shipped: shippedOf(
        input,
        again.candidate,
        qualityOf(again.candidate, { revised: false, revisionSkipped: failure.skipped }),
        input.writeCostPence + failure.costPence,
      ),
      ...(failure.stop ? { stop: failure.stop } : {}),
    };
  }
  const cost = input.writeCostPence + raw.costPence;

  // Both candidates are checked again against the facts as they are now: one archived while the
  // model wrote fails here, not after publishing.
  const fresh = await deps.facts();
  const again = await prepare(deps, input, input.draft, fresh);
  const revised = await prepare(deps, input, raw.data, fresh);
  const revisedOk = revised.ok ? revised.candidate : null;

  const extra = { draftTotal: draft.score.total };
  if (!again.ok) {
    // The draft no longer validates; the revision may still.
    if (revisedOk) {
      return {
        kind: 'composed',
        shipped: shippedOf(
          input,
          revisedOk,
          qualityOf(revisedOk, { revised: true, ...extra }),
          cost,
        ),
      };
    }
    return {
      kind: 'invalid',
      issues: again.issues,
      where: again.where,
      skillsDropped: again.skillsDropped,
    };
  }
  if (!revisedOk) {
    // The revision parsed but does not validate: the codes say why, the draft ships.
    if (!revised.ok) {
      log.warn('cv_worker.revision_invalid', { issues: revised.issues.join(',') });
    }
    return {
      kind: 'composed',
      shipped: shippedOf(
        input,
        again.candidate,
        qualityOf(again.candidate, { revised: false, revisionSkipped: 'invalid', ...extra }),
        cost,
      ),
    };
  }
  const chosen = better(again.candidate, revisedOk);
  return {
    kind: 'composed',
    shipped: shippedOf(
      input,
      chosen,
      qualityOf(chosen, { revised: chosen === revisedOk, ...extra }),
      cost,
    ),
  };
}
