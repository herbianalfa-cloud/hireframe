import { readFileSync } from 'node:fs';

import { CV_CRITERIA, type CvQuality } from '@hireframe/shared';
import { describe, expect, it } from 'vitest';

import { DEFAULT_FX_USD_TO_GBP } from '../config.js';
import { fakeTransport } from '../llm/fake-transport.js';
import type { LlmCallDeps } from '../llm/call.js';
import type { LlmRequest, LlmTransport } from '../llm/transport.js';
import { EVAL_NOW, parseGolden } from './cases.js';
import { selectSuites } from './cli.js';
import { cvCaseFacts, cvCaseJob, INJECTION_MARKER, parseCvCases } from './cv-cases.js';
import { evaluateCvCase, type CvCaseResult } from './cv-evaluate.js';
import { CV_MEAN_GATE, formatCvReport, gateCv, summariseCv, type CvBaseline } from './cv-report.js';
import { RecordingMissingError, replayTransport } from './recordings.js';
import { memoryUsage } from './runtime.js';

const golden = parseGolden(readFileSync('evals/golden.jsonl', 'utf8'));
const jsonl = readFileSync('evals/cv-cases.jsonl', 'utf8');
const cases = parseCvCases(jsonl, golden);

describe('evals/cv-cases.jsonl', () => {
  it('has the eight cases of the plan: three apply, a near miss, a wildcard, injection, bait, thin', () => {
    expect(cases.map((c) => c.id)).toEqual([
      'c01',
      'c02',
      'c03',
      'c04',
      'c05',
      'c06',
      'c07',
      'c08',
    ]);
    const tagged = (tag: string) => cases.filter((c) => c.tags.includes(tag as never));
    expect(tagged('apply')).toHaveLength(6);
    expect(tagged('near_miss')).toHaveLength(1);
    expect(tagged('wildcard')).toHaveLength(1);
    expect(tagged('injection')).toHaveLength(1);
    expect(tagged('bait')).toHaveLength(1);
    expect(tagged('thin')).toHaveLength(1);
    expect(cases.filter((c) => c.profile === 'full')).toHaveLength(7);
  });

  it('the thin profile has 15 facts and carries regenerate notes', () => {
    const thin = cases.find((c) => c.tags.includes('thin'));
    expect(thin && cvCaseFacts(thin)).toHaveLength(15);
    expect(thin?.notes).toBeTruthy();
    expect(cvCaseFacts(cases[0] as never)).toHaveLength(63);
  });

  it('the injection posting asks for the marker and the bait posting is buzzword-heavy', () => {
    const injection = cases.find((c) => c.tags.includes('injection'));
    const bait = cases.find((c) => c.tags.includes('bait'));
    expect(injection && cvCaseJob(injection, golden).description).toContain(INJECTION_MARKER);
    expect(bait && cvCaseJob(bait, golden).description).toMatch(/rockstar[\s\S]*passionate/);
  });

  it('holds no email address or phone number', () => {
    expect(jsonl).not.toMatch(/@[\w-]+\.\w+|\+\d{2}\s?\d{3,}/);
  });

  it.each([
    [
      'an unknown fact',
      (c: Record<string, unknown>) => ({
        ...c,
        keep: undefined,
        requirements: [{ ...(c.requirements as object[])[0], factIds: ['fact-99'] }],
      }),
    ],
    [
      'a golden and an inline posting',
      (c: Record<string, unknown>) => ({
        ...c,
        posting: { title: 't', company: 'c', location: '', remote: 'hybrid', description: 'd' },
      }),
    ],
    [
      'a keep list on a full profile',
      (c: Record<string, unknown>) => ({ ...c, keep: ['fact-02'] }),
    ],
    ['an unknown golden case', (c: Record<string, unknown>) => ({ ...c, golden: 'g99' })],
  ])('refuses %s', (_name, change) => {
    const first = JSON.parse(jsonl.split('\n')[0] ?? '{}') as Record<string, unknown>;
    expect(() => parseCvCases(JSON.stringify(change(first)), golden)).toThrow();
  });

  it('refuses a thin requirement that cites a fact the profile lacks', () => {
    const thin = JSON.parse(jsonl.split('\n')[7] ?? '{}') as Record<string, unknown>;
    const requirements = thin.requirements as { factIds: string[] }[];
    const bad = { ...thin, requirements: [{ ...requirements[0], factIds: ['fact-63'] }] };
    expect(() => parseCvCases(JSON.stringify(bad), golden)).toThrow(/thin profile lacks/);
  });
});

function deps(transport: LlmTransport): LlmCallDeps {
  return {
    transport,
    usage: memoryUsage(10_000),
    capPence: 10_000,
    fxUsdToGbp: DEFAULT_FX_USD_TO_GBP,
    now: () => EVAL_NOW,
  };
}

const JUDGE = { graduate: 7, plain: 8, tailored: 7, note: 6 };

/** The emulator's fake model, plus the judge it doesn't know. `edit` can change a purpose's answer. */
function transport(
  edit: (request: LlmRequest, count: number) => unknown = () => undefined,
): LlmTransport & { purposes: string[] } {
  const inner = fakeTransport();
  const purposes: string[] = [];
  return {
    purposes,
    countTokens: (request) => inner.countTokens(request),
    async send(request) {
      purposes.push(request.purpose);
      const count = purposes.filter((p) => p === request.purpose).length;
      const edited = edit(request, count);
      if (edited !== undefined) {
        return {
          model: 'fake:test',
          stopReason: 'end_turn',
          text: typeof edited === 'string' ? edited : JSON.stringify(edited),
          tokens: { input: 1000, output: 500, cacheRead: 0, cacheWrite: 0 },
        };
      }
      if (request.purpose === 'cvJudge') {
        return {
          model: 'fake:test',
          stopReason: 'end_turn',
          text: JSON.stringify(JUDGE),
          tokens: { input: 800, output: 40, cacheRead: 0, cacheWrite: 0 },
        };
      }
      return await inner.send(request);
    },
  };
}

describe('evaluateCvCase', () => {
  const first = cases[0];
  if (!first) throw new Error('no cases');

  it('runs the worker path: write, one revision, four files, one page, matching texts', async () => {
    const fake = transport();
    const { result, files } = await evaluateCvCase(first, golden, deps(fake));
    expect(result.shipped).toBe(true);
    expect(result.firstWriteValid).toBe(true);
    expect(fake.purposes.filter((p) => p !== 'cvJudge').length).toBeLessThanOrEqual(3);
    expect(result.writeCalls).toBe(1);
    expect(result.pages).toBe(1);
    expect(result.notePages).toBe(1);
    expect(result.textsMatch).toBe(true);
    expect(result.emDash).toBe(false);
    expect(result.markerLeaked).toBe(false);
    expect(result.quality?.rubric).toBe('rubric-v1');
    expect(result.judge).toEqual(JUDGE);
    expect(result.judgeCostPence).toBeGreaterThan(0);
    expect(result.cvTokens.input).toBeGreaterThan(0);
    expect(Object.keys(files ?? {}).sort()).toEqual(['cv.docx', 'cv.pdf', 'note.docx', 'note.pdf']);
  });

  /** The fake model's writes, with the summary citing a fact that doesn't exist (`unknown_fact`). */
  const breaking = (
    breakWrite: (count: number) => boolean,
  ): LlmTransport & { purposes: string[] } => {
    const fake = transport();
    return {
      purposes: fake.purposes,
      countTokens: (request) => fake.countTokens(request),
      async send(request) {
        const response = await fake.send(request);
        if (request.purpose !== 'cvWrite') return response;
        if (!breakWrite(fake.purposes.filter((p) => p === 'cvWrite').length)) return response;
        const content = JSON.parse(response.text ?? '{}') as { summary: unknown };
        content.summary = { text: 'A plain summary.', factRefs: ['F999'] };
        return { ...response, text: JSON.stringify(content) };
      },
    };
  };

  it('retries an invalid first write once, as the worker does on its next run', async () => {
    const { result } = await evaluateCvCase(first, golden, deps(breaking((n) => n === 1)));
    expect(result.firstWriteValid).toBe(false);
    expect(result.writeCalls).toBe(2);
    expect(result.shipped).toBe(true);
    expect(result.writeCalls + result.reviseCalls).toBeLessThanOrEqual(3);
  });

  it('reports a case that never validates, and stops after two writes', async () => {
    const { result, files } = await evaluateCvCase(first, golden, deps(breaking(() => true)));
    expect(result.shipped).toBe(false);
    expect(result.failure).toBe('invalid');
    expect(result.writeCalls).toBe(2);
    expect(result.reviseCalls).toBe(0);
    expect(files).toBeUndefined();
  });

  it('leaves the judge empty when its answer is unusable, and still ships', async () => {
    const fake = transport((request) => (request.purpose === 'cvJudge' ? 'not json' : undefined));
    const { result } = await evaluateCvCase(first, golden, deps(fake));
    expect(result.shipped).toBe(true);
    expect(result.judge).toBeUndefined();
  });

  it('fails with "no recording" when the recordings are stale', async () => {
    await expect(
      evaluateCvCase(first, golden, deps(replayTransport(new Map()))),
    ).rejects.toBeInstanceOf(RecordingMissingError);
  });
});

const quality = (total: number, over: Partial<CvQuality> = {}): CvQuality => ({
  rubric: 'rubric-v1',
  total,
  criteria: Object.fromEntries(CV_CRITERIA.map((name) => [name, 1])) as CvQuality['criteria'],
  findings: [],
  revised: false,
  dashesReplaced: 0,
  layout: { bodySize: 10, fill: 0.97 },
  ...over,
});

function result(id: string, total: number, over: Partial<CvCaseResult> = {}): CvCaseResult {
  return {
    id,
    tags: ['apply'],
    profile: 'full',
    firstWriteValid: true,
    shipped: true,
    calls: 2,
    writeCalls: 1,
    reviseCalls: 0,
    costPence: 4,
    judgeCostPence: 1,
    tokens: { input: 10_000, output: 3_000, cacheRead: 0, cacheWrite: 0 },
    cvTokens: { input: 10_000, output: 3_000 },
    quality: quality(total),
    coverage: 0.9,
    hard: 0,
    soft: 0,
    pages: 1,
    notePages: 1,
    textsMatch: true,
    emDash: false,
    markerLeaked: false,
    ...over,
  };
}

const goodRun = (): CvCaseResult[] => [
  ...['c01', 'c02', 'c03', 'c04', 'c05', 'c06', 'c07'].map((id) => result(id, 8.8)),
  result('c08', 7.4, { profile: 'thin', tags: ['thin'] }),
];

describe('gateCv', () => {
  const baseline: CvBaseline = { mean: 8.8, cases: 8, updatedAt: '2026-10-18' };

  it('passes a good run', () => {
    expect(gateCv(goodRun(), 8, baseline)).toEqual({ ok: true, reasons: [] });
  });

  it('lets one full-profile case miss the target when the mean holds', () => {
    const run = goodRun();
    run[0] = result('c01', 7.9);
    expect(gateCv(run, 8, null).ok).toBe(true);
  });

  it('fails when two full-profile cases miss the target', () => {
    const run = goodRun();
    run[0] = result('c01', 7.9);
    run[1] = result('c02', 7.9);
    expect(gateCv(run, 8, null).reasons.join()).toMatch(/Only 5 of 7/);
  });

  it(`fails a mean under ${String(CV_MEAN_GATE)}`, () => {
    const run = [
      ...['c01', 'c02', 'c03', 'c04', 'c05', 'c06'].map((id) => result(id, 8.0)),
      result('c07', 8.0),
      result('c08', 7, { profile: 'thin', tags: ['thin'] }),
    ];
    expect(gateCv(run, 8, null).reasons.join()).toMatch(/below 8.3/);
  });

  it('fails a mean more than 0.2 under the baseline, and allows 0.2', () => {
    const lower = (total: number) => [
      ...['c01', 'c02', 'c03', 'c04', 'c05', 'c06', 'c07'].map((id) => result(id, total)),
      result('c08', 7, { profile: 'thin', tags: ['thin'] }),
    ];
    expect(gateCv(lower(8.55), 8, baseline).reasons.join()).toMatch(/under the baseline/);
    expect(gateCv(lower(8.6), 8, baseline).ok).toBe(true);
  });

  it.each([
    ['a CV over one page', { pages: 2 }, /CV is 2 pages/],
    ['a note over one page', { notePages: 2 }, /note is 2 pages/],
    ['PDF and DOCX text that differ', { textsMatch: false }, /text differ/],
    ['a hard finding', { hard: 1 }, /hard finding/],
    ['an em dash', { emDash: true }, /em dash/],
    ['the injection marker', { markerLeaked: true }, /injection marker/],
    ['a fourth model call', { writeCalls: 2, reviseCalls: 2 }, /4 model calls/],
    ['a CV that did not ship', { shipped: false, failure: 'invalid' }, /no CV shipped/],
  ])('fails %s', (_name, over, message) => {
    const run = goodRun();
    run[2] = result('c03', 8.8, over);
    const verdict = gateCv(run, 8, null);
    expect(verdict.ok).toBe(false);
    expect(verdict.reasons.join()).toMatch(message);
  });

  it('fails a thin profile that spent a revision, and a run with a case missing', () => {
    const run = goodRun();
    run[7] = result('c08', 7.4, { profile: 'thin', tags: ['thin'], reviseCalls: 1 });
    expect(gateCv(run, 8, null).reasons.join()).toMatch(/thin profile spent a revision/);
    expect(gateCv(goodRun().slice(0, 7), 8, null).reasons.join()).toMatch(/7 of 8 cases ran/);
  });

  it('never gates on the judge', () => {
    const run = goodRun().map((r) => ({
      ...r,
      judge: { graduate: 1, plain: 1, tailored: 1, note: 1 },
    }));
    expect(gateCv(run, 8, null).ok).toBe(true);
  });
});

describe('summariseCv and formatCvReport', () => {
  it('means the full-profile scores only, and counts revisions and the judge', () => {
    const run = goodRun().map((r, i) => ({
      ...r,
      ...(i < 2 ? { reviseCalls: 1 } : {}),
      judge: JUDGE,
    }));
    const summary = summariseCv(run);
    expect(summary.full).toBe(7);
    expect(summary.passing).toBe(7);
    expect(summary.fullMean).toBeCloseTo(8.8);
    expect(summary.revisions).toBe(2);
    expect(summary.revisionRate).toBeCloseTo(0.25);
    expect(summary.judgeMeans?.plain).toBe(8);
    expect(summary.tokens).toEqual({ input: 80_000, output: 24_000 });
  });

  it('prints one row per case and the judge beside the code score', () => {
    const text = formatCvReport(goodRun().map((r) => ({ ...r, judge: JUDGE })));
    expect(text).toContain('c08');
    expect(text).toContain('7/8/7/6');
    expect(text).toMatch(/Judge means \(report only\)/);
  });
});

describe('selectSuites', () => {
  it('runs both by default and one with --suite', () => {
    expect(selectSuites([])).toEqual(['funnel', 'cv']);
    expect(selectSuites(['--suite', 'cv'])).toEqual(['cv']);
    expect(selectSuites(['--update-baseline', '--suite', 'funnel'])).toEqual(['funnel']);
    expect(() => selectSuites(['--suite', 'both'])).toThrow(/--suite/);
    expect(() => selectSuites(['--suite'])).toThrow(/--suite/);
  });
});
