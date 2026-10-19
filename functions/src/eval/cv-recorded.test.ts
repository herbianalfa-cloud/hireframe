import { readFileSync } from 'node:fs';

import {
  CV_LIMITS,
  CvContentShapeSchema,
  factAliases,
  lintCv,
  type CvContent,
} from '@hireframe/shared';
import { describe, expect, it } from 'vitest';

import { composeCv, validatorFacts, type ComposeResult } from '../applications/compose.js';
import { FAKE_HEADER } from '../cv/render/fixtures.js';
import * as render from '../cv/render/index.js';
import { RECORDED } from '../fixtures/cv-recorded.js';
import { parseGolden } from './cases.js';
import { cvCaseFacts, cvCaseJob, parseCvCases } from './cv-cases.js';

/**
 * The first LIVE CV eval's c04 and c05 answers (functions/src/fixtures/cv-recorded.ts), put back
 * through the worker's loop as fake model output: what the lint and the clamp do with real text.
 * No recording is replayed, so a prompt change doesn't make these stale.
 */
const golden = parseGolden(readFileSync('evals/golden.jsonl', 'utf8'));
const cases = parseCvCases(readFileSync('evals/cv-cases.jsonl', 'utf8'), golden);

function setup(id: 'c04' | 'c05') {
  const entry = cases.find((c) => c.id === id);
  if (entry === undefined) throw new Error(`no case ${id}`);
  const facts = cvCaseFacts(entry);
  const { toAlias, toId } = factAliases(
    facts.filter((fact) => fact.content.type !== 'preference').map((fact) => fact.id),
  );
  return { entry, facts, toAlias, toId, job: cvCaseJob(entry, golden) };
}

const shape = (raw: unknown): CvContent => CvContentShapeSchema.parse(raw);

async function compose(id: 'c04' | 'c05', draft: unknown, revision?: unknown) {
  const { entry, facts, toAlias, toId, job } = setup(id);
  const revisions: string[] = [];
  const result: ComposeResult = await composeCv(
    {
      render,
      facts: () => Promise.resolve(facts),
      countAttempt: () => Promise.resolve(true),
      revise: (user) => {
        revisions.push(user);
        if (revision === undefined) throw new Error('unexpected revision');
        return Promise.resolve({ data: shape(revision), model: 'fake', costPence: 3 });
      },
      beforeDeadline: () => true,
    },
    {
      draft: shape(draft),
      header: FAKE_HEADER,
      job,
      notes: entry.notes,
      facts,
      toAlias,
      toId,
      attempt: 1,
      maxAttempts: 3,
      scoreTarget: 8,
      writeCostPence: 2,
    },
  );
  if (result.kind !== 'composed') throw new Error(`expected composed: ${JSON.stringify(result)}`);
  return { ...result, revisions };
}

describe('inflated_claim on the recorded c04 (job: Technical Account Manager)', () => {
  it('flagged the cover note for the title’s own word before the title phrase was ignored', () => {
    const { facts, toId } = setup('c04');
    // Without the title, "Manager" in the note reads as a claimed seniority.
    const findings = lintCv(shape(RECORDED.c04.draft), validatorFacts(facts), toId);
    expect(findings.map((f) => `${f.code} at ${f.path}`)).toContain(
      'inflated_claim at coverNote.paragraphs[0]',
    );
  });

  it('re-scores the draft with no hard finding', async () => {
    const result = await compose('c04', RECORDED.c04.draft);
    expect(result.draft.hard).toBe(0);
    expect(result.shipped.quality.findings.map((f) => f.code)).not.toContain('inflated_claim');
    // It scored 6.23 with two hard findings in the first LIVE run. Under rubric v2 its note costs
    // it points, so it may ask for a revision; this test is about the findings, not the total.
    expect(result.draft.total).toBeGreaterThan(7);
  });

  it('re-scores the revision with no hard finding either (its sixth bullet is clamped)', async () => {
    const result = await compose('c04', RECORDED.c04.revision);
    expect(result.draft.hard).toBe(0);
    expect(result.shipped.quality.findings.map((f) => f.code)).not.toContain('inflated_claim');
    for (const entry of [...result.shipped.cited.experience, ...result.shipped.cited.projects]) {
      expect(entry.bullets.length).toBeLessThanOrEqual(CV_LIMITS.bulletsPerEntry);
    }
  });
});

describe('a recorded revision over the bullet limit', () => {
  it('c05: the revision used to be refused for a sixth bullet; clamped, it validates and ships', async () => {
    const revised = shape(RECORDED.c05.revision);
    expect(revised.experience.some((e) => e.bullets.length > CV_LIMITS.bulletsPerEntry)).toBe(true);
    const result = await compose('c05', RECORDED.c05.draft, RECORDED.c05.revision);
    expect(result.revisions).toHaveLength(1);
    expect(result.shipped.quality.revised).toBe(true);
    expect(result.shipped.quality.revisionSkipped).toBeUndefined();
    expect(result.shipped.quality.total).toBeGreaterThan(result.shipped.quality.draftTotal ?? 10);
    for (const entry of result.shipped.cited.experience) {
      expect(entry.bullets.length).toBeLessThanOrEqual(CV_LIMITS.bulletsPerEntry);
    }
  });

  it('c05: a draft with a sixth bullet is clamped, not refused as too_long', async () => {
    const result = await compose('c05', RECORDED.c05.revision);
    expect(result.shipped.cited.experience.every((e) => e.bullets.length <= 5)).toBe(true);
  });
});
