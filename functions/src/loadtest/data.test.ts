import { dedupeBatch, normaliseRawJob, type RawJob } from '@hireframe/shared';
import { describe, expect, it } from 'vitest';

import { fakeTriage } from '../funnel/fake-answers.js';
import { buildFunnelContext } from '../funnel/steps.js';
import { TEST_FACTS, testCriteria, testJob } from '../funnel/testing.js';
import { greenhouseToRawJob, GreenhouseJobSchema } from '../sources/greenhouse.js';
import { buildLoadData, LOAD_DEFAULTS, prng, type LoadData } from './data.js';

const NOW = new Date('2026-10-05T08:00:00Z');
const options = { ...LOAD_DEFAULTS, now: NOW };

function boardRaw(data: LoadData): RawJob[] {
  const companies = new Map(data.companies.map((c) => [c.ats.token, c]));
  const out: RawJob[] = [];
  for (const [token, board] of data.boards) {
    const company = companies.get(token);
    if (!company) throw new Error(`no company for ${token}`);
    for (const posting of board.jobs) {
      out.push(
        greenhouseToRawJob(GreenhouseJobSchema.parse(posting), {
          id: company.id,
          name: company.name,
          ats: company.ats,
        }),
      );
    }
  }
  return out;
}

describe('buildLoadData', () => {
  const data = buildLoadData(options);
  const raws = boardRaw(data);

  it('is the same for the same seed and differs for another', () => {
    expect(buildLoadData(options)).toEqual(data);
    expect(buildLoadData({ ...options, seed: 1 }).boards).not.toEqual(data.boards);
    const a = prng(5);
    const b = prng(5);
    expect([a(), a()]).toEqual([b(), b()]);
  });

  it('has 1,000 board jobs on 20 boards, 12 alerts and 300 stale queued jobs', () => {
    expect(data.companies).toHaveLength(20);
    expect(data.boards.size).toBe(20);
    // Six alerts also have a matching posting on their board.
    expect(raws).toHaveLength(1_000 + 6);
    expect(data.alerts).toHaveLength(12);
    expect(new Set(data.alerts.map((a) => a.companyId)).size).toBe(12);
    expect(data.stale).toHaveLength(300);
    expect(new Set(data.stale.map((s) => s.state))).toEqual(new Set(['s2', 's3', 'description']));
  });

  it('passes S1 for 105 postings and S2 for about 30% of them, by the real rules', () => {
    const criteria = testCriteria();
    const steps = buildFunnelContext(criteria, TEST_FACTS, { workRights: 'time_limited' });
    const boardOnly = raws.filter((raw) => !raw.title.startsWith('Customer Success'));
    let s1 = 0;
    let s2 = 0;
    for (const raw of boardOnly) {
      const n = normaliseRawJob(raw);
      expect(n).not.toBeNull();
      const job = testJob({
        title: raw.title,
        company: raw.company,
        location: n?.location ?? '',
        city: n?.city ?? '',
        country: n?.country ?? 'GB',
        postedAt: raw.postedAt ?? NOW,
        firstSeenAt: NOW,
      });
      const text = n?.description.text ?? '';
      if (!steps.rules(job, text, NOW).pass) continue;
      s1 += 1;
      if (fakeTriage(`Title: ${raw.title}`).pass) s2 += 1;
    }
    expect(s1).toBe(105);
    expect(s2).toBe(32);
    expect(data.expected).toMatchObject({ s1Passes: 105, s2Passes: 32 });
  });

  it('gives every posting its own dedupe key, so ingest merges nothing', () => {
    const all = [...raws, ...data.alerts, ...data.stale.map((s) => s.raw)]
      .map((raw) => normaliseRawJob(raw))
      .filter((n) => n !== null);
    expect(dedupeBatch(all)).toHaveLength(all.length);
  });

  it('stresses the peak with --s1-passes', () => {
    const more = buildLoadData({ ...options, s1Passes: 210 });
    expect(more.expected.s1Passes).toBe(210);
    expect(more.expected.s2Passes).toBe(63);
  });

  it('puts stale jobs well past freshness_days (14)', () => {
    for (const { raw } of data.stale) {
      expect(NOW.getTime() - (raw.postedAt?.getTime() ?? 0)).toBeGreaterThan(29 * 86_400_000);
    }
  });
});
