import { CvContentShapeSchema, type CvContent, type ExistingFact } from '@hireframe/shared';
import { describe, expect, it, onTestFinished } from 'vitest';

import {
  aliasOf,
  at,
  CV_ALIASES,
  CV_FACTS,
  requirement,
  validCv,
} from '../../../packages/shared/src/fixtures/cv.js';
import { FAKE_HEADER } from '../cv/render/fixtures.js';
import * as realRender from '../cv/render/index.js';
import type { LlmCallResult } from '../llm/call.js';
import { DailyCapExceededError, LlmOutputError, SpendCapExceededError } from '../llm/errors.js';
import {
  composeCv,
  type ComposeDeps,
  type ComposeInput,
  type ComposeRenderer,
  type ComposeResult,
} from './compose.js';
import { setLogSink } from '../log.js';
import type { JobForCv } from './store.js';

const a = aliasOf;

const sentences = (count: number) =>
  Array.from({ length: count }, () => 'I wrote clear help text.').join(' ');

/** About 180 words in short sentences that name the company, so the note scores in full. */
const NOTE = (opener = 'I am applying to Northwind Analytics'): CvContent['coverNote'] => ({
  paragraphs: [
    { text: `${opener}.`, factRefs: [a('fact-clients')] },
    { text: sentences(20), factRefs: [a('fact-ttl')] },
    { text: sentences(15), factRefs: [a('fact-articles')] },
  ],
});

/** `validCv` made to pass the gate at a full page: four bullets, six skills, a real note. */
function goodCv(): CvContent {
  const cv = structuredClone(validCv());
  cv.skills = [0, 1, 2, 3, 4, 5].map((i) => ({
    label: i % 2 === 0 ? 'SQL' : 'Python',
    factRefs: [a(i % 2 === 0 ? 'fact-sql' : 'fact-python')],
  }));
  cv.coverNote = NOTE();
  at(cv.experience, 0).bullets = [
    { text: 'Led onboarding for 12 clients across the setup flow.', factRefs: [a('fact-clients')] },
    { text: 'Cut client time-to-live by 30% with clearer setup steps.', factRefs: [a('fact-ttl')] },
    {
      text: 'Wrote 25 help-centre articles for the self-serve setup flow.',
      factRefs: [a('fact-articles')],
    },
  ];
  at(cv.projects, 0).bullets = [
    {
      text: 'Analysed an e-commerce dataset with SQL to find late orders.',
      factRefs: [a('fact-olist')],
    },
  ];
  return cv;
}

/**
 * A draft that leaves the page 60% full and cites only the newest experience fact: three bullet
 * facts (time-to-live, articles, the project) are unused.
 */
function thinCv(): CvContent {
  const cv = goodCv();
  at(cv.experience, 0).bullets = [at(at(cv.experience, 0).bullets, 0)];
  cv.projects = [];
  cv.summary = {
    text: 'Customer-facing analyst who led onboarding for 12 clients.',
    factRefs: [a('fact-clients')],
  };
  for (const paragraph of cv.coverNote.paragraphs) paragraph.factRefs = [a('fact-clients')];
  return cv;
}

const archive = (...ids: string[]) =>
  existing((fact) => (ids.includes(fact.id) ? { status: 'archived' as const } : {}));

const withBullet = (cv: CvContent, text: string): CvContent => {
  const copy = structuredClone(cv);
  at(copy.experience, 0).bullets[0] = { text, factRefs: [a('fact-clients')] };
  return copy;
};
const CONTRAST = 'Not just ran onboarding, but also wrote the setup guides.';
const withContrast = (cv: CvContent): CvContent => withBullet(cv, CONTRAST);

const existing = (
  override: (fact: (typeof CV_FACTS)[number]) => Partial<ExistingFact> = () => ({}),
): ExistingFact[] =>
  CV_FACTS.map((fact) => ({
    id: fact.id,
    status: fact.status,
    source: 'cv' as const,
    content: {
      type: fact.type,
      text: fact.text,
      evidence: fact.evidence,
      dates: {},
      tags: [],
      lanes: [],
    },
    ...override(fact),
  }));

const toAlias = new Map([...CV_ALIASES].map(([alias, id]) => [id, alias]));

const JOB: JobForCv = {
  title: 'Data Analyst',
  company: 'Northwind Analytics',
  location: 'London',
  remote: 'hybrid',
  description: 'Analyse customer data.',
  requirements: [
    requirement('Client onboarding', { factIds: ['fact-clients'], match: 'met', gap: null }),
    requirement('SQL', { factIds: ['fact-sql'], level: 'nice', match: 'met', gap: null }),
  ],
  talkingPoints: ['Onboarding'],
};

/** Fills a page from four bullets up; fewer leave it 60% full. Everything else is the real thing. */
const renderer: ComposeRenderer = {
  ...realRender,
  fitPage(_header, content) {
    const bullets = [...content.experience, ...content.projects].flatMap((entry) =>
      entry.bullets.map(() => 2),
    );
    return Promise.resolve({
      ok: true,
      content,
      trimmed: 0,
      spec: realRender.BASE_SPEC,
      fill: bullets.length >= 4 ? 0.97 : 0.6,
      bytes: new Uint8Array(),
      lines: { bullets, headingWraps: 0 },
    });
  },
};

interface Probe {
  deps: ComposeDeps;
  counted: number;
  revisions: string[];
  facts: number;
}

function probe(
  revise: (user: string) => CvContent | Error = (user) => {
    throw new Error(`unexpected revision call: ${user.slice(0, 20)}`);
  },
  over: Partial<ComposeDeps> & { factsAfter?: ExistingFact[] } = {},
): Probe {
  const state: Probe = {
    counted: 0,
    revisions: [],
    facts: 0,
    deps: {
      render: renderer,
      facts: () => {
        state.facts += 1;
        return Promise.resolve(over.factsAfter ?? existing());
      },
      countAttempt: () => {
        state.counted += 1;
        return Promise.resolve(true);
      },
      revise: (user) => {
        state.revisions.push(user);
        const next = revise(user);
        if (next instanceof Error) return Promise.reject(next);
        return Promise.resolve<LlmCallResult<CvContent>>({
          data: next,
          model: 'claude-sonnet-5-5',
          costPence: 3,
        });
      },
      beforeDeadline: () => true,
      ...over,
    },
  };
  if (over.facts) state.deps.facts = over.facts;
  return state;
}

function input(draft: CvContent, over: Partial<ComposeInput> = {}): ComposeInput {
  return {
    draft,
    header: FAKE_HEADER,
    job: JOB,
    facts: existing(),
    toAlias,
    toId: CV_ALIASES,
    attempt: 1,
    maxAttempts: 3,
    scoreTarget: 8,
    writeCostPence: 4,
    ...over,
  };
}

function composed(result: ComposeResult) {
  if (result.kind !== 'composed')
    throw new Error(`expected composed, got ${JSON.stringify(result)}`);
  return result;
}

describe('composeCv: a draft that passes', () => {
  it('ships it without a revision, a count or a second read of the facts', async () => {
    const p = probe();
    const { shipped, stop } = composed(await composeCv(p.deps, input(goodCv())));
    expect(stop).toBeUndefined();
    expect(shipped.quality).toMatchObject({ revised: false, dashesReplaced: 0 });
    expect(shipped.quality.total).toBeGreaterThanOrEqual(8);
    expect(shipped.quality.revisionSkipped).toBeUndefined();
    expect(shipped.quality.draftTotal).toBeUndefined();
    expect(shipped.quality.layout).toEqual({ bodySize: realRender.BASE_SPEC.bodySize, fill: 0.97 });
    expect(shipped.costPence).toBe(4);
    expect(p.counted).toBe(0);
    expect(p.revisions).toEqual([]);
    expect(p.facts).toBe(0);
  });

  it('records the facts the content cites and the ones it validated against', async () => {
    const { shipped } = composed(await composeCv(probe().deps, input(goodCv())));
    expect(shipped.factIds).toEqual(
      expect.arrayContaining(['fact-clients', 'fact-ttl', 'fact-olist', 'fact-sql']),
    );
    expect(shipped.factIds).toEqual([...shipped.factIds].sort());
    expect(shipped.facts).toHaveLength(CV_FACTS.length);
  });
});

describe('composeCv: before the loop', () => {
  it('scrubs dashes before validating and stores how many', async () => {
    const draft = withBullet(goodCv(), 'Led onboarding for 12 clients — across the setup flow.');
    const { shipped } = composed(await composeCv(probe().deps, input(draft)));
    expect(shipped.quality.dashesReplaced).toBe(1);
    expect(JSON.stringify(shipped.fit.content)).not.toMatch(/[–—]/);
  });

  it('orders the entries newest first before the fit', async () => {
    const draft = goodCv();
    const older = {
      heading: { role: 'Onboarding', org: 'Clients', factRef: a('fact-clients') },
      bullets: [{ text: 'Led onboarding for 12 clients.', factRefs: [a('fact-clients')] }],
    };
    draft.experience = [older, at(draft.experience, 0)];
    const dates: Record<string, ExistingFact['content']['dates']> = {
      'fact-clients': { start: '2021-01', end: '2021-06' },
      'fact-intern': { start: '2023-10', end: '2024-05' },
    };
    const facts = existing().map((fact) => ({
      ...fact,
      content: { ...fact.content, dates: dates[fact.id] ?? {} },
    }));
    const { shipped } = composed(await composeCv(probe().deps, input(draft, { facts })));
    expect(shipped.fit.content.experience.map((entry) => entry.heading.org)).toEqual([
      'Example Cloud Ltd',
      'Clients',
    ]);
  });

  it('refuses an invalid draft with its codes and calls nothing', async () => {
    const bad = withBullet(goodCv(), 'Saved 99% of costs for clients.');
    const p = probe();
    const result = await composeCv(p.deps, input(bad));
    expect(result).toEqual({
      kind: 'invalid',
      issues: ['unsupported_number'],
      where: [{ path: 'experience[0].bullets[0]', code: 'unsupported_number' }],
    });
    expect(p.counted).toBe(0);
    expect(p.revisions).toEqual([]);
  });

  it('clamps a draft over the count limits instead of refusing it', async () => {
    const long = goodCv();
    at(long.experience, 0).bullets = Array.from({ length: 6 }, (_, i) => ({
      text: `Led onboarding for 12 clients, part ${'abcdef'[i] ?? ''}.`,
      factRefs: [a('fact-clients')],
    }));
    expect(CvContentShapeSchema.safeParse(long).success).toBe(true);
    const { shipped } = composed(await composeCv(probe().deps, input(long)));
    expect(at(shipped.cited.experience, 0).bullets).toHaveLength(5);
    // The sixth went, the first five stayed in the model's order.
    expect(at(at(shipped.cited.experience, 0).bullets, 4).text).toContain('part e');
  });

  it('still refuses a draft that is too long in its text', async () => {
    const long = goodCv();
    at(at(long.experience, 0).bullets, 0).text = `Led onboarding. ${'x'.repeat(230)}`;
    const result = await composeCv(probe().deps, input(long));
    expect(result).toEqual({
      kind: 'invalid',
      issues: ['too_long'],
      where: [{ path: 'experience[0].bullets[0]', code: 'too_long' }],
    });
  });

  it('turns a fit that cannot fit, and a renderer refusal, into issue codes', async () => {
    const tooLong: ComposeRenderer = {
      ...renderer,
      fitPage: () => Promise.resolve({ ok: false, code: 'too_long' }),
    };
    expect(await composeCv(probe(undefined, { render: tooLong }).deps, input(goodCv()))).toEqual({
      kind: 'invalid',
      issues: ['too_long'],
      where: [],
    });
    const refusing: ComposeRenderer = {
      ...renderer,
      fitPage: () => Promise.reject(new realRender.CvRenderError('unsupported_char')),
    };
    expect(await composeCv(probe(undefined, { render: refusing }).deps, input(goodCv()))).toEqual({
      kind: 'invalid',
      issues: ['unsupported_char'],
      where: [],
    });
  });

  it('lets any other renderer failure through', async () => {
    const broken: ComposeRenderer = {
      ...renderer,
      fitPage: () => Promise.reject(new Error('pdf-lib exploded')),
    };
    await expect(
      composeCv(probe(undefined, { render: broken }).deps, input(goodCv())),
    ).rejects.toThrow('pdf-lib exploded');
  });

  it('stores at most 20 findings', async () => {
    const draft = goodCv();
    const entry = at(draft.experience, 0);
    entry.bullets = Array.from({ length: 5 }, () => ({
      text: 'Successfully led onboarding for 12 clients.',
      factRefs: [a('fact-clients')],
    }));
    draft.experience = [entry, entry, entry, entry];
    const result = composed(await composeCv(probe().deps, input(draft, { attempt: 3 })));
    expect(result.shipped.quality.findings.length).toBe(20);
    expect(result.shipped.quality.revisionSkipped).toBe('attempts');
  });
});

describe('composeCv: whether to revise', () => {
  it('skips a draft that cannot be helped: below target, no finding, nothing unused to add', async () => {
    const p = probe();
    const facts = archive('fact-ttl', 'fact-articles', 'fact-olist');
    const { shipped } = composed(await composeCv(p.deps, input(thinCv(), { facts })));
    expect(shipped.quality).toMatchObject({ revised: false, revisionSkipped: 'not_fixable' });
    expect(shipped.quality.total).toBeLessThan(8);
    expect(p.counted).toBe(0);
  });

  it('does not revise an underfilled draft with one unused fact', async () => {
    const p = probe();
    const facts = archive('fact-ttl', 'fact-articles');
    const { shipped } = composed(await composeCv(p.deps, input(thinCv(), { facts })));
    expect(shipped.quality.revisionSkipped).toBe('not_fixable');
    expect(p.counted).toBe(0);
  });

  it('revises an underfilled draft when two or more unused facts could fill it', async () => {
    const p = probe(() => goodCv());
    const { shipped } = composed(await composeCv(p.deps, input(thinCv())));
    expect(p.revisions).toHaveLength(1);
    expect(p.counted).toBe(1);
    expect(shipped.quality).toMatchObject({ revised: true });
    expect(shipped.quality.draftTotal).toBeLessThan(shipped.quality.total);
    expect(p.revisions[0]).toMatch(/is 60% full/);
  });

  it('revises a hard finding even on a full page', async () => {
    const p = probe(() => goodCv());
    const { shipped } = composed(await composeCv(p.deps, input(withContrast(goodCv()))));
    expect(shipped.quality).toMatchObject({ revised: true });
    expect(shipped.quality.findings).toEqual([]);
  });

  it('makes no revision when no attempt is left, and counts nothing', async () => {
    const p = probe();
    const { shipped } = composed(
      await composeCv(p.deps, input(withContrast(goodCv()), { attempt: 3 })),
    );
    expect(shipped.quality).toMatchObject({ revised: false, revisionSkipped: 'attempts' });
    expect(p.counted).toBe(0);
  });

  it('makes no revision after the start deadline, and counts nothing', async () => {
    const p = probe(undefined, { beforeDeadline: () => false });
    const { shipped } = composed(await composeCv(p.deps, input(withContrast(goodCv()))));
    expect(shipped.quality).toMatchObject({ revised: false, revisionSkipped: 'deadline' });
    expect(p.counted).toBe(0);
  });

  it('returns lost, and calls nothing, when the owner moved the application', async () => {
    const p = probe(undefined, { countAttempt: () => Promise.resolve(false) });
    expect(await composeCv(p.deps, input(withContrast(goodCv())))).toEqual({ kind: 'lost' });
    expect(p.revisions).toEqual([]);
  });

  it('ships the draft, and ends the run, when the count itself fails', async () => {
    const p = probe(undefined, { countAttempt: () => Promise.reject(new Error('firestore 503')) });
    const result = composed(await composeCv(p.deps, input(withContrast(goodCv()))));
    expect(result.stop).toBe('error');
    expect(result.shipped.quality.revisionSkipped).toBe('error');
    expect(p.revisions).toEqual([]);
  });

  it('counts the attempt before it sends the revision', async () => {
    const log: string[] = [];
    const p = probe(
      () => {
        log.push('send');
        return goodCv();
      },
      {
        countAttempt: () => {
          log.push('count');
          return Promise.resolve(true);
        },
      },
    );
    await composeCv(p.deps, input(withContrast(goodCv())));
    expect(log).toEqual(['count', 'send']);
  });
});

describe('composeCv: the revision request', () => {
  it('carries the draft, the findings as codes, the fill and the unused facts', async () => {
    const p = probe(() => goodCv());
    await composeCv(p.deps, input(withContrast(thinCv())));
    const user = p.revisions[0] ?? '';
    expect(user.match(/<draft_cv>/g)).toHaveLength(1);
    expect(user).toContain('contrast_pattern');
    expect(user).toContain('% full');
    // Unused bullet facts are named by alias: ttl, articles and olist are not cited by thinCv.
    expect(user).toContain(a('fact-ttl'));
    expect(user).toContain(a('fact-articles'));
    // The requirement mapping is live: toAlias is passed through.
    expect(user).toContain(`Client onboarding (facts: ${a('fact-clients')})`);
    // A finding never carries the text it found.
    expect(user.split('</draft_cv>')[1]).not.toContain('setup guides');
  });
});

describe('composeCv: choosing between the candidates', () => {
  it('ships the revision when it scores higher', async () => {
    const { shipped } = composed(await composeCv(probe(() => goodCv()).deps, input(thinCv())));
    expect(shipped.quality.revised).toBe(true);
    expect(shipped.fit.content.projects).toHaveLength(1);
    expect(shipped.costPence).toBe(7);
  });

  it('ships the draft when the revision has more hard findings', async () => {
    const twice = withContrast(goodCv());
    at(twice.experience, 0).bullets[1] = {
      text: 'Not only cut time-to-live by 30%, but also helped clients.',
      factRefs: [a('fact-ttl')],
    };
    const { shipped } = composed(
      await composeCv(probe(() => twice).deps, input(withContrast(goodCv()))),
    );
    expect(shipped.quality.revised).toBe(false);
    expect(shipped.quality.revisionSkipped).toBeUndefined();
    expect(shipped.quality.draftTotal).toBe(shipped.quality.total);
    expect(shipped.cited).toEqual(withContrast(goodCv()));
  });

  it('ships the revision when it has fewer hard findings even at a lower score', async () => {
    // No hard finding, but 60% full and two soft findings.
    const worse = withBullet(thinCv(), 'Successfully led onboarding for 12 clients.');
    worse.summary = { text: 'Significantly useful analyst.', factRefs: [a('fact-clients')] };
    const { shipped } = composed(
      await composeCv(probe(() => worse).deps, input(withContrast(goodCv()))),
    );
    expect(shipped.quality.revised).toBe(true);
    expect(shipped.quality.total).toBeLessThan(shipped.quality.draftTotal ?? 0);
    expect(shipped.quality.findings.some((f) => f.code === 'contrast_pattern')).toBe(false);
  });

  it('ships the draft on a tie', async () => {
    const draft = withContrast(goodCv());
    const { shipped } = composed(await composeCv(probe(() => draft).deps, input(draft)));
    expect(shipped.quality.revised).toBe(false);
  });

  it('drops an invalid revision and ships the draft, saying why', async () => {
    const logs: Record<string, unknown>[] = [];
    setLogSink((_level, event, fields) => logs.push({ event, ...fields }));
    onTestFinished(() => {
      setLogSink();
    });
    const bad = withBullet(goodCv(), 'Saved 99% of costs for clients.');
    const { shipped } = composed(
      await composeCv(probe(() => bad).deps, input(withContrast(goodCv()))),
    );
    expect(shipped.quality).toMatchObject({ revised: false, revisionSkipped: 'invalid' });
    expect(logs).toContainEqual({
      event: 'cv_worker.revision_invalid',
      issues: 'unsupported_number',
    });
    expect(shipped.quality.draftTotal).toBeDefined();
    expect(shipped.cited).toEqual(withContrast(goodCv()));
  });

  it('reads the facts again after the call and checks both candidates against them', async () => {
    const p = probe(() => goodCv(), {
      factsAfter: existing((f) => (f.id === 'fact-sql' ? { status: 'archived' as const } : {})),
    });
    const result = await composeCv(p.deps, input(withContrast(goodCv())));
    // Both candidates cite SQL (a skill): neither validates any more.
    expect(result.kind).toBe('invalid');
    expect(p.facts).toBe(1);
  });

  it('ships the revision when only the draft cites a fact archived meanwhile', async () => {
    const revision = goodCv();
    // The draft's contrast bullet cites fact-clients; the revision's cites fact-ttl instead.
    at(revision.experience, 0).bullets[0] = {
      text: 'Cut client time-to-live by 30%.',
      factRefs: [a('fact-ttl')],
    };
    const archived = existing((f) =>
      f.id === 'fact-clients' ? { status: 'archived' as const } : {},
    );
    const draft = withContrast(goodCv());
    at(revision.coverNote.paragraphs, 0).factRefs = [a('fact-ttl')];
    revision.education = draft.education;
    const result = composed(
      await composeCv(probe(() => revision, { factsAfter: archived }).deps, input(draft)),
    );
    expect(result.shipped.quality.revised).toBe(true);
    expect(result.shipped.facts.find((f) => f.id === 'fact-clients')?.status).toBe('archived');
  });
});

describe('composeCv: when the revision call fails', () => {
  const run = (error: Error) => composeCv(probe(() => error).deps, input(withContrast(goodCv())));

  it('a monthly cap ships the draft and ends the run', async () => {
    const result = composed(await run(new SpendCapExceededError()));
    expect(result.stop).toBe('cap');
    expect(result.shipped.quality).toMatchObject({ revised: false, revisionSkipped: 'cap' });
    expect(result.shipped.costPence).toBe(4);
  });

  it('a daily cap ships the draft and ends the run', async () => {
    const result = composed(await run(new DailyCapExceededError()));
    expect(result.stop).toBe('cap');
    expect(result.shipped.quality.revisionSkipped).toBe('cap');
  });

  it('an API error ships the draft and ends the run', async () => {
    const result = composed(await run(new Error('upstream 529')));
    expect(result.stop).toBe('error');
    expect(result.shipped.quality.revisionSkipped).toBe('error');
  });

  it.each(['refusal', 'max_tokens', 'invalid_json', 'schema', 'no_text'] as const)(
    'a %s ships the draft, pays for the call and goes on',
    async (failure) => {
      const result = composed(await run(new LlmOutputError(failure, 2.5)));
      expect(result.stop).toBeUndefined();
      expect(result.shipped.quality).toMatchObject({ revised: false, revisionSkipped: 'output' });
      expect(result.shipped.costPence).toBe(6.5);
    },
  );
});
