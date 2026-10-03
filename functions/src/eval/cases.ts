import {
  COUNTRIES,
  REMOTE_MODES,
  SalarySchema,
  VERDICTS,
  type FunnelFact,
  type Job,
  type WorkRightsSetting,
} from '@hireframe/shared';
import { z } from 'zod';

import { FAKE_CV_EXTRACTION } from '../fixtures/fake-cv-response.js';

/**
 * The golden set (`evals/golden.jsonl`, ADR-036): fake postings, each labelled by the owner with
 * the verdict they'd give a candidate like them, judged against a fake profile and the public seed
 * criteria. Nothing here is personal data.
 */

/** The date every eval runs "at", so posting ages, prompts and recordings never drift. */
export const EVAL_NOW = new Date('2026-10-05T08:00:00Z');

export const CASE_TAGS = ['tricky', 'injection', 'title'] as const;

export const GoldenCaseSchema = z.object({
  id: z.string().regex(/^g\d{2}$/),
  /** What the case was written to test; the owner's `label` is what counts. */
  designedAs: z.enum(VERDICTS),
  /** The owner's verdict, or null until they label it. */
  label: z.enum(VERDICTS).nullable(),
  note: z.string().max(300).default(''),
  tags: z.array(z.enum(CASE_TAGS)).default([]),
  posting: z.object({
    title: z.string().min(1).max(200),
    company: z.string().min(1).max(200),
    location: z.string().max(200),
    country: z.enum(COUNTRIES),
    remote: z.enum(REMOTE_MODES),
    postedDaysAgo: z.int().min(0).max(120).nullable(),
    salary: SalarySchema.optional(),
    companySize: z.string().max(40).optional(),
    companyStage: z.string().max(40).optional(),
    description: z.string().min(1).max(12_000),
  }),
});
export type GoldenCase = z.infer<typeof GoldenCaseSchema>;

export function parseGolden(jsonl: string): GoldenCase[] {
  return jsonl
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '')
    .map((line, index) => {
      const parsed = GoldenCaseSchema.safeParse(JSON.parse(line));
      if (!parsed.success) {
        throw new Error(
          `golden.jsonl line ${String(index + 1)}: ${parsed.error.issues[0]?.message ?? 'invalid'}`,
        );
      }
      return parsed.data;
    });
}

/** The job the funnel sees for a case. */
export function caseJob(entry: GoldenCase): Job {
  const { posting } = entry;
  const day = 24 * 60 * 60 * 1000;
  const url = `https://jobs.example.com/eval/${entry.id}`;
  const postedAt =
    posting.postedDaysAgo === null
      ? undefined
      : new Date(EVAL_NOW.getTime() - posting.postedDaysAgo * day);
  return {
    dedupeKey: `d:${entry.id}`,
    keys: [`d:${entry.id}`],
    title: posting.title,
    company: posting.company,
    location: posting.location,
    city: '',
    country: posting.country,
    remote: posting.remote,
    url,
    sources: [{ id: 'greenhouse', url, externalId: entry.id, seenAt: EVAL_NOW }],
    ...(postedAt ? { postedAt } : {}),
    firstSeenAt: new Date(EVAL_NOW.getTime() - day),
    descriptionRef: `jobs/${entry.id}/description/raw`,
    descriptionKind: 'full',
    ...(posting.salary ? { salary: posting.salary } : {}),
    stage: 's0',
    status: 'new',
    createdAt: EVAL_NOW,
    updatedAt: EVAL_NOW,
    schemaVersion: 1,
  };
}

/**
 * The fake candidate, "Alex Example": the fake CV's facts with stable IDs, and invented work
 * rights chosen so the right-to-work cases mean something. Not the owner's.
 */
export const EVAL_FACTS: FunnelFact[] = FAKE_CV_EXTRACTION.facts.map((fact, index) => ({
  id: `fact-${String(index + 1).padStart(2, '0')}`,
  type: fact.type,
  text: fact.text,
  dates: fact.dates,
  lanes: fact.lanes,
}));

export const EVAL_WORK_RIGHTS: WorkRightsSetting = {
  workRights: 'time_limited',
  validUntil: '2028-06-30',
};
