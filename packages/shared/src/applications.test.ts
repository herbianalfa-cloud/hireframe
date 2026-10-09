import { describe, expect, it } from 'vitest';

import {
  APPLICATION_LIMITS,
  APPLICATION_STAGES,
  ApplicationSchema,
  QuestionSchema,
  questionId,
  questionsFromRequirements,
} from './applications.js';
import { at, requirement } from './fixtures/cv.js';
import { COLLECTIONS, DOCS, PATHS, STORAGE_PATHS } from './firestore.js';
import { EventSchema } from './events.js';
import { DAILY_CAP_KEYS } from './usage.js';
import { CALLABLE_TIMEOUT_SECONDS } from './callables.js';
import { AppConfigSchema } from './config.js';

const deep = (...requirements: ReturnType<typeof requirement>[]) => ({ requirements });

describe('questionsFromRequirements', () => {
  it('leaves out requirements already met', () => {
    expect(
      questionsFromRequirements(deep(requirement('Uses SQL', { match: 'met', gap: null }))),
    ).toEqual([]);
  });

  it('leaves out logistics, however they match', () => {
    expect(
      questionsFromRequirements(
        deep(
          requirement('Right to work in the UK', { type: 'logistics', match: 'missing' }),
          requirement('Based in Leeds', { type: 'logistics', match: 'partial', gap: 'sector' }),
        ),
      ),
    ).toEqual([]);
  });

  it("puts must before nice, then missing before partial, then the job's own order", () => {
    const questions = questionsFromRequirements(
      deep(
        requirement('Nice partial A', { level: 'nice', match: 'partial' }),
        requirement('Must partial B', { match: 'partial' }),
        requirement('Nice missing C', { level: 'nice' }),
        requirement('Must missing D'),
        requirement('Must missing E'),
      ),
    );
    expect(questions.map((q) => q.requirement)).toEqual([
      'Must missing D',
      'Must missing E',
      'Must partial B',
      'Nice missing C',
      'Nice partial A',
    ]);
  });

  it('asks at most five by default, and keeps the best five', () => {
    const many = Array.from({ length: 8 }, (_, i) =>
      requirement(`Requirement ${String(i)}`, { level: i < 6 ? 'nice' : 'must' }),
    );
    const questions = questionsFromRequirements(deep(...many));
    expect(questions).toHaveLength(APPLICATION_LIMITS.maxQuestions);
    expect(questions.slice(0, 2).map((q) => q.requirement)).toEqual([
      'Requirement 6',
      'Requirement 7',
    ]);
    expect(questionsFromRequirements(deep(...many), 2)).toHaveLength(2);
  });

  it('gives each question a stable id that depends on the text and nothing else', () => {
    const [first] = questionsFromRequirements(deep(requirement('Three years of Python')));
    const [again] = questionsFromRequirements(
      deep(requirement('  three YEARS of   python ', { level: 'nice', match: 'partial' })),
    );
    expect(first?.id).toMatch(/^q-[0-9a-f]{12}$/);
    expect(again?.id).toBe(first?.id);
    expect(questionId('Three years of Python')).toBe(first?.id);
    expect(questionId('Four years of Python')).not.toBe(first?.id);
  });

  it('asks a repeated requirement once', () => {
    expect(
      questionsFromRequirements(deep(requirement('Uses dbt'), requirement('uses  DBT'))),
    ).toHaveLength(1);
  });

  it('produces questions the schema accepts, with no answer yet', () => {
    for (const question of questionsFromRequirements(deep(requirement('Uses dbt')))) {
      expect(QuestionSchema.safeParse(question).success).toBe(true);
      expect('answer' in question).toBe(false);
    }
  });
});

const now = new Date('2026-10-12T09:00:00Z');
function application(overrides: Record<string, unknown> = {}) {
  return {
    jobId: 'job-1',
    job: { title: 'Product Analyst', company: 'Acme Analytics', verdict: 'apply' },
    stage: 'needs_input',
    stageAt: now,
    startedAt: now,
    updatedAt: now,
    questions: [
      {
        ...at(questionsFromRequirements(deep(requirement('Uses dbt'))), 0),
        answer: { kind: 'skipped' },
      },
    ],
    attempt: 0,
    cvIds: [],
    schemaVersion: 1,
    ...overrides,
  };
}

describe('ApplicationSchema', () => {
  it('accepts an application in every stage', () => {
    for (const stage of APPLICATION_STAGES) {
      const extra = stage === 'applied' ? { stageBefore: 'ready' } : {};
      expect(ApplicationSchema.safeParse(application({ stage, ...extra })).success).toBe(true);
    }
  });

  it('keeps stageBefore for the applied stage only', () => {
    expect(ApplicationSchema.safeParse(application({ stage: 'applied' })).success).toBe(false);
    expect(ApplicationSchema.safeParse(application({ stageBefore: 'ready' })).success).toBe(false);
    expect(
      ApplicationSchema.safeParse(application({ stage: 'applied', stageBefore: 'applied' }))
        .success,
    ).toBe(false);
  });

  it('accepts a blocked chosen job with its issue codes', () => {
    const parsed = ApplicationSchema.safeParse(
      application({
        stage: 'chosen',
        blocked: { code: 'invalid_output', at: now },
        attempt: 2,
        lastIssues: ['unsupported_number', 'uncited'],
      }),
    );
    expect(parsed.success).toBe(true);
  });

  it('bounds attempts, questions, notes and the blocked code', () => {
    expect(ApplicationSchema.safeParse(application({ attempt: 3 })).success).toBe(false);
    expect(ApplicationSchema.safeParse(application({ notes: 'x'.repeat(501) })).success).toBe(
      false,
    );
    expect(
      ApplicationSchema.safeParse(application({ blocked: { code: 'other', at: now } })).success,
    ).toBe(false);
    expect(ApplicationSchema.safeParse(application({ lastIssues: ['made_up'] })).success).toBe(
      false,
    );
    const six = Array.from({ length: 6 }, (_, i) => ({
      ...at(questionsFromRequirements(deep(requirement(`R${String(i)}`))), 0),
    }));
    expect(ApplicationSchema.safeParse(application({ questions: six })).success).toBe(false);
  });

  it('rejects extra keys on the application and on what is nested in it', () => {
    expect(ApplicationSchema.safeParse(application({ cvText: 'x' })).success).toBe(false);
    expect(
      ApplicationSchema.safeParse(
        application({
          job: { title: 'a', company: 'b', verdict: 'apply', url: 'https://x.example' },
        }),
      ).success,
    ).toBe(false);
    expect(
      ApplicationSchema.safeParse(application({ blocked: { code: 'cap', at: now, why: 'x' } }))
        .success,
    ).toBe(false);
    const q = at(questionsFromRequirements(deep(requirement('Uses dbt'))), 0);
    expect(QuestionSchema.safeParse({ ...q, hint: 'x' }).success).toBe(false);
    expect(
      QuestionSchema.safeParse({ ...q, answer: { kind: 'fact', factIds: ['f'], text: 'raw' } })
        .success,
    ).toBe(false);
  });

  it('needs a fact id in a fact answer', () => {
    const q = at(questionsFromRequirements(deep(requirement('Uses dbt'))), 0);
    expect(QuestionSchema.safeParse({ ...q, answer: { kind: 'fact', factIds: [] } }).success).toBe(
      false,
    );
  });
});

describe('paths, events and config for M7', () => {
  it('names the collections and storage paths', () => {
    expect(COLLECTIONS.applications).toBe('applications');
    expect(PATHS.application('job-1')).toBe('applications/job-1');
    expect(PATHS.cv('job-1-v2')).toBe('cvs/job-1-v2');
    expect(DOCS.cvHeader).toBe('profile/cvHeader');
    expect(STORAGE_PATHS.cvFile('job-1-v2', 'cv', 'pdf')).toBe('cvs/job-1-v2/cv.pdf');
    expect(STORAGE_PATHS.cvFile('job-1-v2', 'cover-note', 'docx')).toBe(
      'cvs/job-1-v2/cover-note.docx',
    );
  });

  it('has an application_stage event, with no from when an application starts', () => {
    const base = { type: 'application_stage', jobId: 'job-1', at: now, schemaVersion: 1 };
    expect(EventSchema.safeParse({ ...base, from: null, to: 'chosen' }).success).toBe(true);
    expect(EventSchema.safeParse({ ...base, from: 'ready', to: 'applied' }).success).toBe(true);
    expect(EventSchema.safeParse({ ...base, from: 'ready', to: 'done' }).success).toBe(false);
  });

  it('caps application spend daily and times the new functions', () => {
    expect(DAILY_CAP_KEYS).toContain('application');
    expect(CALLABLE_TIMEOUT_SECONDS.application).toBe(120);
    expect(CALLABLE_TIMEOUT_SECONDS.generateCvs).toBe(540);
  });

  it('lets config/app carry an applications override, parsed elsewhere', () => {
    const app = {
      ownerUid: 'owner',
      schemaVersion: 1,
      createdAt: now,
      updatedAt: now,
      applications: { dailyCapPence: 'whatever' },
    };
    expect(AppConfigSchema.safeParse(app).success).toBe(true);
  });
});
