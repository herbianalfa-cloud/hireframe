import { describe, expect, it } from 'vitest';

import { normaliseRawJob } from '../dedupe.js';
import { WAAS_ALERT, WAAS_MODEL_ANSWER } from '../fixtures/alerts.js';
import { extractLinks } from './links.js';
import { alertExternalId, AlertParseOutputSchema, modelAlertJobs } from './model.js';

const HOSTS = ['ashbyhq.com', 'greenhouse.io', 'linkedin.com'];
const links = extractLinks(WAAS_ALERT.html);

describe('modelAlertJobs', () => {
  const { jobs, unverifiedLinks } = modelAlertJobs(
    AlertParseOutputSchema.parse(WAAS_MODEL_ANSWER),
    links,
    HOSTS,
  );

  it('uses an allowlisted link as the job URL, canonicalised, and reads its keys', () => {
    const job = jobs[0];
    expect(job?.url).toBe(
      'https://jobs.ashbyhq.com/pylon-labs/0b1c2d3e-0000-4000-8000-0000000000a1',
    );
    expect(job?.unverifiedUrl).toBeUndefined();
    expect(job?.searchLink).toBeUndefined();
    const normalised = job ? normaliseRawJob(job) : null;
    expect(normalised?.keys).toContain('ashby:0b1c2d3e-0000-4000-8000-0000000000a1');
  });

  it('keeps a job whose link is off the allowlist: link on the source only, search link as URL', () => {
    const job = jobs[1];
    expect(unverifiedLinks).toBe(1);
    expect(job?.unverifiedUrl).toBe('https://click.example.net/c/9f8e7d?u=quill');
    expect(job?.url).toMatch(/^https:\/\/www\.linkedin\.com\/jobs\/search\/\?keywords=/);
    expect(job?.searchLink).toBe(true);
    const normalised = job ? normaliseRawJob(job) : null;
    // No key comes from the unverified link.
    expect(normalised?.keys.filter((key) => !key.startsWith('d:'))).toEqual([
      `email:${job?.externalId ?? ''}`,
    ]);
  });

  it('gives a job with no link a search link and no unverified link', () => {
    const job = jobs[2];
    expect(job?.unverifiedUrl).toBeUndefined();
    expect(job?.searchLink).toBe(true);
    expect(job?.url).toContain('Operations%20Analyst%20Ridge%20Labs');
  });

  it('builds the external ID from company, title and city, not from a link', () => {
    expect(
      alertExternalId('Pylon Labs Ltd', 'Founding Product Analyst (Hybrid)', 'London, UK'),
    ).toBe(alertExternalId('Pylon Labs', 'Founding Product Analyst', 'London'));
    expect(jobs.map((job) => job.externalId)).toHaveLength(3);
    expect(jobs[0]?.externalId).toMatch(/^[0-9a-f]{16}$/);
  });

  it('drops an index out of range, and a non-https link counts as no link', () => {
    const out = modelAlertJobs(
      {
        jobs: [
          { title: 'A', company: 'B', location: 'London', linkIndex: 99 },
          { title: 'C', company: 'D', location: 'London', linkIndex: 0 },
        ],
      },
      [{ href: 'http://plain.example.net/x', text: '', start: 0, end: 1 }],
      HOSTS,
    );
    expect(out.unverifiedLinks).toBe(0);
    expect(out.jobs.every((job) => job.unverifiedUrl === undefined && job.searchLink)).toBe(true);
  });

  it('collapses repeats of the same role', () => {
    const row = { title: 'A', company: 'B', location: 'London', linkIndex: null };
    expect(modelAlertJobs({ jobs: [row, { ...row }] }, [], HOSTS).jobs).toHaveLength(1);
  });

  it('rejects output past the caps', () => {
    const row = { title: 'A', company: 'B', location: '', linkIndex: null };
    expect(AlertParseOutputSchema.safeParse({ jobs: Array(31).fill(row) }).success).toBe(false);
    expect(AlertParseOutputSchema.safeParse({ jobs: [{ ...row, linkIndex: -1 }] }).success).toBe(
      false,
    );
  });
});
