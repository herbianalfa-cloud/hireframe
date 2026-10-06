import { describe, expect, it } from 'vitest';

import { makeJob, NOW } from './fixtures';
import {
  ageText,
  agreementText,
  isSearchLink,
  linkHost,
  postedText,
  salaryText,
  scoreText,
  skipText,
} from './labels';

describe('job labels', () => {
  it('ages from the posting date, else first seen', () => {
    expect(ageText(makeJob({ postedAt: new Date('2026-10-14T01:00:00Z') }), NOW)).toBe('today');
    expect(ageText(makeJob({ postedAt: new Date('2026-10-13T01:00:00Z') }), NOW)).toBe('1 day');
    expect(ageText(makeJob({ postedAt: new Date('2026-10-09T09:00:00Z') }), NOW)).toBe('5 days');
    expect(ageText(makeJob({ postedAt: new Date('2026-09-23T09:00:00Z') }), NOW)).toBe('3 weeks');
    expect(ageText(makeJob({ postedAt: new Date('2026-07-01T09:00:00Z') }), NOW)).toBe('3 months');
    expect(postedText({ firstSeenAt: makeJob().firstSeenAt }, NOW)).toBe('first seen 2 days ago');
    expect(postedText(makeJob({ postedAt: NOW }), NOW)).toBe('posted today');
  });

  it('names the stage and the rule that skipped a job', () => {
    expect(skipText({ stage: 's1', ruleId: 'title:exclude' })).toBe('Rules (rule title:exclude)');
    expect(skipText({ stage: 's2', note: 'wrong lane' })).toBe('Triage: wrong lane');
  });

  it('formats salary and scores', () => {
    expect(
      salaryText({ salary: { min: 40000, max: 50000, currency: 'GBP', period: 'year' } }),
    ).toBe('£40,000–£50,000 per year');
    expect(salaryText({})).toBeNull();
    expect(scoreText(7)).toBe('7.0');
    expect(scoreText(undefined)).toBe('–');
  });

  it('shows the agreement split, and a hint before there is any', () => {
    const none = {
      ratedAgree: 0,
      ratedDisagree: 0,
      appliedAgree: 0,
      agree: 0,
      disagree: 0,
      total: 0,
      rate: null,
    };
    expect(agreementText(none)).toMatch(/No ratings yet/);
    expect(
      agreementText({
        ratedAgree: 2,
        ratedDisagree: 1,
        appliedAgree: 1,
        agree: 3,
        disagree: 1,
        total: 4,
        rate: 0.75,
      }),
    ).toBe(
      'Verdict agreement, last 14 days: 75% (target 85%) · 2 rated right, 1 rated wrong, 1 applied on Apply',
    );
  });
});

describe('alert link labels (M6)', () => {
  it('recognises a LinkedIn search URL, and nothing that is a posting', () => {
    expect(isSearchLink('https://www.linkedin.com/jobs/search?keywords=a%20b')).toBe(true);
    expect(isSearchLink('https://www.linkedin.com/jobs/search/?keywords=a')).toBe(true);
    expect(isSearchLink('https://www.linkedin.com/jobs/view/4012345678')).toBe(false);
    expect(isSearchLink('https://jobs.example.com/jobs/search')).toBe(false);
    expect(isSearchLink('not a url')).toBe(false);
  });

  it('shows the host of a link without www', () => {
    expect(linkHost('https://www.click.example.net/c/1?u=2')).toBe('click.example.net');
    expect(linkHost('nope')).toBe('unknown host');
  });
});
