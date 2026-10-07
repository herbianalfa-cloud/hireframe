import { htmlToText } from '../html.js';
import { JOB_LIMITS, type RawJob, type RemoteMode } from '../jobs.js';
import { foldText } from '../normalise.js';
import { canonicalLinkedInJobUrl, extractLinks, linkedInJobId, type AlertLink } from './links.js';
import { parseSalaryText } from './salary.js';

/**
 * The LinkedIn job-alert parser (ADR-047), pure and deterministic: one job per card. An alert
 * carries no description and no posting date, so jobs come out with description kind `none`
 * and the funnel's needs-description state takes over (ADR-048).
 *
 * A card is a title link (`/jobs/view/{id}`, tracking or slugged) followed by
 * `Company · Location (Work mode)`, an optional salary line and badges. The tracking URL is
 * never kept: the job's URL is the canonical `https://www.linkedin.com/jobs/view/{id}`.
 */

export const LINKEDIN_ALERT_MAX_JOBS = 30;

export interface LinkedInAlertResult {
  jobs: RawJob[];
  /** Distinct job IDs the email links to, parsed or not. Links without a card mean `unparsed`. */
  jobLinks: number;
  /** The alert's country from its "N new jobs in <country>" line, when it has one. */
  country?: string;
}

const CTA_LABELS = new Set([
  'view job',
  'view jobs',
  'see job',
  'apply',
  'easy apply',
  'apply now',
  'view',
]);

const HEADER = /\b\d+\s+new\s+jobs?\s+in\s+([^\n]+)/i;
const WORK_MODE = /\s*\((hybrid|remote|on-?site)\)\s*$/i;

function remoteMode(label: string): RemoteMode {
  const lower = label.toLowerCase();
  if (lower === 'hybrid') return 'hybrid';
  if (lower === 'remote') return 'remote';
  return 'onsite';
}

/** "United Kingdom", or the last segment of "London, England, United Kingdom". */
function headerCountry(text: string): string | undefined {
  const rest = HEADER.exec(text)?.[1];
  const country = rest
    ?.split(',')
    .at(-1)
    ?.replace(/[.:!]+$/, '')
    .trim();
  return country ? country.slice(0, 80) : undefined;
}

interface Card {
  id: string;
  title: string;
  /** The lines after the title, in order. */
  lines: string[];
}

function cardJob(card: Card, country: string | undefined): RawJob | null {
  const companyAt = card.lines.findIndex((line) => line.includes(' · '));
  if (companyAt < 0) return null;
  const line = card.lines[companyAt] ?? '';
  const split = line.indexOf(' · ');
  const company = line.slice(0, split).trim();
  let location = line.slice(split + 3).trim();
  let remoteHint: RemoteMode | undefined;
  const mode = WORK_MODE.exec(location);
  if (mode) {
    remoteHint = remoteMode(mode[1] ?? '');
    location = location.slice(0, mode.index).trim();
  }
  // A bare town takes the alert's country, so S1 sees `GB` rather than `unknown`.
  if (
    location !== '' &&
    !location.includes(',') &&
    country &&
    foldText(location) !== foldText(country)
  ) {
    location = `${location}, ${country}`;
  }
  const title = card.title.slice(0, JOB_LIMITS.title).trim();
  if (title === '' || company === '') return null;

  // The salary sits right under the company line; badges follow.
  const after = card.lines.slice(companyAt + 1, companyAt + 7);
  const salary = after.map((candidate) => parseSalaryText(candidate)).find((found) => found);
  const easyApply = after.some((candidate) => /^easy apply$/i.test(candidate));

  return {
    sourceId: 'linkedin-alert',
    externalId: card.id,
    url: canonicalLinkedInJobUrl(card.id),
    title,
    company: company.slice(0, JOB_LIMITS.company),
    locationText: location.slice(0, JOB_LIMITS.location),
    ...(remoteHint ? { remoteHint } : {}),
    description: { kind: 'none', format: 'text', body: '' },
    ...(salary ? { salary } : {}),
    ...(easyApply ? { easyApply: true as const } : {}),
  };
}

function isCta(text: string): boolean {
  return text === '' || CTA_LABELS.has(text.toLowerCase());
}

function htmlCards(html: string): { cards: Card[]; ids: Set<string> } {
  const links = extractLinks(html);
  const ids = new Set<string>();
  const titleAnchors: { id: string; link: AlertLink }[] = [];
  const titled = new Set<string>();
  for (const link of links) {
    const id = linkedInJobId(link.href);
    if (!id) continue;
    ids.add(id);
    // The first anchor with real text is the title; image and "View job" anchors repeat the ID.
    if (!titled.has(id) && !isCta(link.text)) {
      titled.add(id);
      titleAnchors.push({ id, link });
    }
  }
  const cards = titleAnchors.map(({ id, link }, index) => {
    const next = titleAnchors[index + 1]?.link.start ?? html.length;
    const body = htmlToText(html.slice(link.end, next), { maxLength: 5_000 });
    return {
      id,
      title: link.text.replace(/\s+/g, ' '),
      lines: body
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean),
    };
  });
  return { cards, ids };
}

const TEXT_URL = /https?:\/\/[^\s<>"')]+/g;

function textCards(text: string): { cards: Card[]; ids: Set<string> } {
  const ids = new Set<string>();
  const cards: Card[] = [];
  let block: string[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    const id = [...line.matchAll(TEXT_URL)]
      .map((match) => linkedInJobId(match[0]))
      .find((found) => found);
    if (!id) {
      if (line !== '') block.push(line);
      continue;
    }
    ids.add(id);
    const companyAt = block.findIndex((candidate) => candidate.includes(' · '));
    const title = companyAt > 0 ? block[companyAt - 1] : undefined;
    if (title && !cards.some((card) => card.id === id)) {
      cards.push({ id, title, lines: block.slice(companyAt) });
    }
    block = [];
  }
  return { cards, ids };
}

export function parseLinkedInAlert(input: { text: string; html: string }): LinkedInAlertResult {
  const fromHtml = input.html.trim() === '' ? null : htmlCards(input.html);
  const fromText = textCards(input.text);
  const country =
    headerCountry(input.html === '' ? input.text : htmlToText(input.html)) ??
    headerCountry(input.text);

  const jobs: RawJob[] = [];
  const seen = new Set<string>();
  const add = (cards: readonly Card[]) => {
    for (const card of cards) {
      if (jobs.length >= LINKEDIN_ALERT_MAX_JOBS) return;
      if (seen.has(card.id)) continue;
      const job = cardJob(card, country);
      if (!job) continue;
      seen.add(card.id);
      jobs.push(job);
    }
  };
  if (fromHtml) add(fromHtml.cards);
  // The text part is the fallback when the HTML yields nothing (a layout change).
  if (jobs.length === 0) add(fromText.cards);

  const ids = new Set([...(fromHtml?.ids ?? []), ...fromText.ids]);
  return { jobs, jobLinks: ids.size, ...(country ? { country } : {}) };
}
