import {
  JobRequirementSchema,
  REMOTE_MODES,
  type ExistingFact,
  type FunnelFact,
} from '@hireframe/shared';
import { z } from 'zod';

import type { JobForCv } from '../applications/store.js';
import { EVAL_FACTS, type GoldenCase } from './cases.js';

/**
 * The CV eval's cases (`evals/cv-cases.jsonl`, CV quality plan §4): fake only. Each case freezes
 * the S3 requirements and talking points the CV prompt reads, exported once from the funnel's
 * recorded answers, so the two evals stay independent. The candidate is "Alex Example"
 * (`EVAL_FACTS`) or, for the thin-profile case, 15 of those facts.
 */
export const CV_CASE_TAGS = [
  'apply',
  'near_miss',
  'wildcard',
  'injection',
  'bait',
  'thin',
] as const;

/** The marker the injection case's posting tells the model to print; it must never appear. */
export const INJECTION_MARKER = 'ZEBRA-LANTERN-7';
/** Facts the thin profile keeps. */
export const THIN_FACT_COUNT = 15;

export const CvCaseSchema = z
  .strictObject({
    id: z.string().regex(/^c\d{2}$/),
    tags: z.array(z.enum(CV_CASE_TAGS)).min(1),
    profile: z.enum(['full', 'thin']),
    /** Thin profile only: the fact IDs the candidate has. */
    keep: z.array(z.string().regex(/^fact-\d{2}$/)).optional(),
    /** The posting is a golden case's... */
    golden: z
      .string()
      .regex(/^g\d{2}$/)
      .optional(),
    /** ...plus this text at the end of its description (the injection case)... */
    append: z.string().max(600).optional(),
    /** ...or written inline (the buzzword-bait case). */
    posting: z
      .strictObject({
        title: z.string().min(1).max(200),
        company: z.string().min(1).max(200),
        location: z.string().max(200),
        remote: z.enum(REMOTE_MODES),
        description: z.string().min(1).max(12_000),
      })
      .optional(),
    notes: z.string().max(500).optional(),
    requirements: z.array(JobRequirementSchema).min(1).max(12),
    talkingPoints: z.array(z.string().min(1).max(300)).max(6),
  })
  .refine((entry) => (entry.golden === undefined) !== (entry.posting === undefined), {
    message: 'a case has a golden posting or an inline one, not both',
  })
  .refine((entry) => (entry.profile === 'thin') === (entry.keep !== undefined), {
    message: 'only a thin-profile case lists the facts it keeps',
  })
  .refine((entry) => entry.keep === undefined || entry.keep.length === THIN_FACT_COUNT, {
    message: `a thin profile keeps ${String(THIN_FACT_COUNT)} facts`,
  });
export type CvCase = z.infer<typeof CvCaseSchema>;

export function parseCvCases(jsonl: string, golden: readonly GoldenCase[]): CvCase[] {
  const cases = jsonl
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '')
    .map((line, index) => {
      const parsed = CvCaseSchema.safeParse(JSON.parse(line));
      if (!parsed.success) {
        throw new Error(
          `cv-cases.jsonl line ${String(index + 1)}: ${parsed.error.issues[0]?.message ?? 'invalid'}`,
        );
      }
      return parsed.data;
    });
  const known = new Set(EVAL_FACTS.map((fact) => fact.id));
  const goldenIds = new Set(golden.map((entry) => entry.id));
  for (const entry of cases) {
    const refs = [...entry.requirements.flatMap((r) => r.factIds), ...(entry.keep ?? [])];
    const unknown = refs.find((id) => !known.has(id));
    if (unknown) throw new Error(`${entry.id}: unknown fact ${unknown}`);
    if (entry.golden && !goldenIds.has(entry.golden)) {
      throw new Error(`${entry.id}: no golden case ${entry.golden}`);
    }
    if (entry.profile === 'thin') {
      const kept = new Set(entry.keep);
      if (entry.requirements.some((r) => r.factIds.some((id) => !kept.has(id)))) {
        throw new Error(`${entry.id}: a requirement cites a fact the thin profile lacks`);
      }
    }
  }
  if (new Set(cases.map((entry) => entry.id)).size !== cases.length) {
    throw new Error('cv-cases.jsonl: duplicate case ID');
  }
  return cases;
}

/** The job as the CV prompt reads it. */
export function cvCaseJob(entry: CvCase, golden: readonly GoldenCase[]): JobForCv {
  const source = entry.golden ? golden.find((g) => g.id === entry.golden) : undefined;
  const posting = entry.posting ?? source?.posting;
  if (!posting) throw new Error(`${entry.id}: no posting`);
  return {
    title: posting.title,
    company: posting.company,
    location: posting.location,
    remote: posting.remote,
    description: `${posting.description}${entry.append ?? ''}`,
    requirements: entry.requirements,
    talkingPoints: entry.talkingPoints,
  };
}

function asExisting(fact: FunnelFact): ExistingFact {
  return {
    id: fact.id,
    status: 'active',
    source: 'cv',
    content: {
      type: fact.type,
      text: fact.text,
      evidence: fact.text,
      dates: fact.dates,
      tags: [],
      lanes: fact.lanes,
    },
  };
}

/** The candidate's facts for a case, as the worker reads them. */
export function cvCaseFacts(entry: CvCase): ExistingFact[] {
  const kept = entry.keep ? new Set(entry.keep) : null;
  return EVAL_FACTS.filter((fact) => kept === null || kept.has(fact.id)).map(asExisting);
}
