import { z } from 'zod';

import { fnv1a64 } from '../dedupe.js';
import { JOB_LIMITS, type RawJob } from '../jobs.js';
import { normaliseCompany, normaliseTitle, parseLocation } from '../normalise.js';
import { canonicalAlertUrl, hostAllowed, type AlertLink } from './links.js';

/**
 * Jobs from an alert whose sender has no deterministic parser (ADR-047), pure. The model returns
 * `{ title, company, location, linkIndex }` rows; the links themselves were read from the email's
 * HTML in code, so the model can point at one by index but never plant a URL of its own.
 */

export const ALERT_PARSE_MAX_JOBS = 30;

export const AlertParseOutputSchema = z.object({
  jobs: z
    .array(
      z.object({
        title: z.string().trim().min(1).max(JOB_LIMITS.title),
        company: z.string().trim().min(1).max(JOB_LIMITS.company),
        location: z.string().trim().max(JOB_LIMITS.location),
        /** Index into the numbered links the model was shown, or null when none fits. */
        linkIndex: z.int().min(0).nullable(),
      }),
    )
    .max(ALERT_PARSE_MAX_JOBS),
});
export type AlertParseOutput = z.infer<typeof AlertParseOutputSchema>;

/** A 64-bit hash of company|title|city (normalised, as the `d:` key): no link needed. */
export function alertExternalId(company: string, title: string, locationText: string): string {
  const { city } = parseLocation(locationText);
  return fnv1a64(`${normaliseCompany(company)}|${normaliseTitle(title)}|${city}`);
}

/** A LinkedIn search for the role: clickable by the owner, never fetched. */
export function searchLinkFor(title: string, company: string): string {
  const keywords = `${title} ${company}`.replace(/\s+/g, ' ').trim().slice(0, 200);
  return `https://www.linkedin.com/jobs/search/?keywords=${encodeURIComponent(keywords)}`;
}

export interface ModelAlertJobs {
  jobs: RawJob[];
  /** Jobs whose only link is on a host off the allowlist (kept, but stored unverified). */
  unverifiedLinks: number;
}

export function modelAlertJobs(
  output: AlertParseOutput,
  links: readonly AlertLink[],
  allowedHosts: readonly string[],
): ModelAlertJobs {
  const jobs: RawJob[] = [];
  const seen = new Set<string>();
  let unverifiedLinks = 0;
  for (const row of output.jobs.slice(0, ALERT_PARSE_MAX_JOBS)) {
    const externalId = alertExternalId(row.company, row.title, row.location);
    if (seen.has(externalId)) continue;
    seen.add(externalId);
    // An index out of range is dropped, never guessed.
    const link = row.linkIndex === null ? undefined : links[row.linkIndex];
    const canonical = link ? canonicalAlertUrl(link.href) : null;
    const trusted = canonical !== null && hostAllowed(canonical, allowedHosts);
    // `canonicalUrl` upgrades http to https; only a link that was https to begin with is kept.
    const untrusted = canonical !== null && !trusted && /^https:\/\//i.test(link?.href ?? '');
    if (untrusted) unverifiedLinks += 1;
    jobs.push({
      sourceId: 'email-alert',
      externalId,
      url: trusted ? canonical : searchLinkFor(row.title, row.company),
      title: row.title,
      company: row.company,
      locationText: row.location,
      description: { kind: 'none', format: 'text', body: '' },
      ...(trusted ? {} : { searchLink: true as const }),
      ...(untrusted ? { unverifiedUrl: canonical } : {}),
    });
  }
  return { jobs, unverifiedLinks };
}
