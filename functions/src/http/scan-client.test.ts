import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import { FORBIDDEN_FETCH_HOSTS } from '../config.js';
import { HttpError } from './client.js';
import { scanHttpClient } from './scan-client.js';

describe('scanHttpClient', () => {
  it.each([
    'https://www.linkedin.com/jobs/view/4012345678/',
    'https://uk.linkedin.com/jobs/search/?keywords=analyst',
    'https://www.indeed.com/viewjob?jk=abc',
    'https://wellfound.com/jobs',
    'https://www.glassdoor.co.uk/job-listing/x',
  ])('never calls fetch for %s (CLAUDE.md hard rule)', async (url) => {
    const fetchSpy = vi.fn();
    const client = scanHttpClient(fetchSpy, Date.now() + 60_000, []);
    const error = await client
      .getJson(url, z.unknown(), { label: 'test' })
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(HttpError);
    expect(error).toMatchObject({ code: 'forbidden_host' });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('lists LinkedIn, Indeed, Wellfound and Glassdoor', () => {
    expect(FORBIDDEN_FETCH_HOSTS).toEqual(
      expect.arrayContaining(['linkedin.com', 'indeed.com', 'wellfound.com', 'glassdoor.com']),
    );
  });
});
