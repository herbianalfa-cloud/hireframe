import type { RawJob } from '@hireframe/shared';
import { z } from 'zod';

import { boardReader, createAtsSource, keyedEnvelope, optionalText, type AtsSpec } from './ats.js';
import { parseDate, type Source, type WatchedCompany } from './types.js';

/**
 * Greenhouse Job Board API (public): `boards-api.greenhouse.io/v1/boards/{token}/jobs?content=true`.
 * `content` is entity-escaped HTML. `first_published` is preferred over `updated_at`, which
 * moves on every edit.
 */
export const GreenhouseJobSchema = z.object({
  id: z.number().int().positive(),
  title: z.string().min(1),
  absolute_url: z.url(),
  location: z.object({ name: optionalText }).nullish(),
  content: optionalText,
  first_published: optionalText,
  updated_at: optionalText,
  company_name: optionalText,
});
export type GreenhouseJob = z.infer<typeof GreenhouseJobSchema>;

export function greenhouseBoardUrl(token: string): string {
  return `https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(token)}/jobs?content=true`;
}

export function greenhouseToRawJob(job: GreenhouseJob, company: WatchedCompany): RawJob {
  const postedAt = parseDate(job.first_published) ?? parseDate(job.updated_at);
  const locationText = job.location?.name ?? '';
  return {
    sourceId: 'greenhouse',
    externalId: String(job.id),
    url: job.absolute_url,
    title: job.title,
    company: company.name,
    companyId: company.id,
    locationText,
    ...(/\bremote\b/i.test(locationText) ? { remoteHint: 'remote' as const } : {}),
    // Unescaped once here; htmlToText then decodes the entities inside the HTML.
    description: { kind: 'full', format: 'html', body: decodeOnce(job.content ?? '') },
    ...(postedAt ? { postedAt } : {}),
  };
}

/** Greenhouse escapes its HTML once (`&lt;p&gt;`); undo that so the body is plain HTML. */
function decodeOnce(escaped: string): string {
  return escaped
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&');
}

/** One posting: `boards-api.greenhouse.io/v1/boards/{token}/jobs/{id}` (full content included). */
export function greenhouseJobUrl(token: string, id: string): string {
  return `https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(token)}/jobs/${encodeURIComponent(id)}`;
}

const greenhouseSpec: AtsSpec<GreenhouseJob> = {
  id: 'greenhouse',
  boardUrl: (company) => greenhouseBoardUrl(company.ats.token ?? ''),
  envelope: keyedEnvelope('jobs'),
  item: GreenhouseJobSchema,
  toRawJob: greenhouseToRawJob,
};
export const greenhouseBoard = boardReader(greenhouseSpec);

export function createGreenhouseSource(): Source {
  return createAtsSource(greenhouseSpec);
}
