import type { Country, JobSourceId, RemoteMode } from './jobs.js';

/**
 * Normalisation for matching only (ADR-030). Display text is never changed: these functions
 * return comparison forms. Pure, so dedupe is testable without a network.
 */

/** Lower case, accents folded, `&` → `and`, anything but letters and digits → one space. */
export function foldText(text: string): string {
  return text
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

// ---- Companies ----

const LEGAL_SUFFIXES = new Set(['ltd', 'limited', 'plc', 'inc', 'llc', 'llp', 'gmbh', 'uk']);

/** "Acme Analytics Ltd", "ACME Analytics (UK) Limited" and "Acme Analytics" → "acme analytics". */
export function normaliseCompany(name: string): string {
  const words = foldText(name).split(' ').filter(Boolean);
  if (words[0] === 'the' && words.length > 1) words.shift();
  while (words.length > 1 && LEGAL_SUFFIXES.has(words.at(-1) ?? '')) words.pop();
  return words.join(' ');
}

// ---- Titles ----

/** Level synonyms are mapped, never stripped: "Senior" and "Junior" roles stay distinct. */
const LEVEL_SYNONYMS: Readonly<Record<string, string>> = {
  jr: 'junior',
  jnr: 'junior',
  sr: 'senior',
  snr: 'senior',
  grad: 'graduate',
  assoc: 'associate',
};

/** UK places a job location names most often. Unknown towns fall back to the first segment. */
export const UK_CITIES = [
  'london',
  'manchester',
  'birmingham',
  'leeds',
  'glasgow',
  'edinburgh',
  'bristol',
  'cambridge',
  'oxford',
  'cardiff',
  'belfast',
  'liverpool',
  'newcastle',
  'sheffield',
  'nottingham',
  'leicester',
  'brighton',
  'reading',
  'southampton',
  'milton keynes',
  'bath',
  'aberdeen',
  'dundee',
  'york',
  'exeter',
  'norwich',
  'coventry',
  'guildford',
  'swansea',
  'salford',
  'stockport',
  'slough',
  'watford',
] as const;

const UK_MARKERS = [
  'uk',
  'u k',
  'united kingdom',
  'england',
  'scotland',
  'wales',
  'northern ireland',
  'great britain',
  'gb',
];

/** Places that are clearly not in the UK. Anything unrecognised stays `unknown`, never `other`. */
const NON_UK_MARKERS = [
  'usa',
  'us',
  'united states',
  'canada',
  'ireland',
  'dublin',
  'germany',
  'berlin',
  'munich',
  'france',
  'paris',
  'spain',
  'madrid',
  'barcelona',
  'portugal',
  'lisbon',
  'netherlands',
  'amsterdam',
  'india',
  'bangalore',
  'bengaluru',
  'singapore',
  'australia',
  'sydney',
  'new york',
  'san francisco',
  'boston',
  'chicago',
  'austin',
  'seattle',
  'toronto',
  'new york city',
  'nyc',
  'poland',
  'warsaw',
  'sweden',
  'stockholm',
  'denmark',
  'copenhagen',
  'israel',
  'tel aviv',
  'brazil',
  'mexico',
  'japan',
  'tokyo',
];

const WORK_MODE_WORDS = [
  'remote',
  'hybrid',
  'onsite',
  'on site',
  'office',
  'in office',
  'office based',
  'flexible',
  'wfh',
  'work from home',
  'home based',
  'based',
];

/** Words that make up a noise segment: places, work mode, contract, salary and gender tags. */
const NOISE_WORDS = new Set(
  [
    ...UK_CITIES,
    ...UK_MARKERS,
    ...WORK_MODE_WORDS,
    'emea',
    'europe',
    'eu',
    'anywhere',
    'worldwide',
    'global',
    'or',
    'and',
    'with',
    'in',
    'the',
    'of',
    'days',
    'day',
    'week',
    'per',
    'a',
    'ftc',
    'fixed',
    'term',
    'contract',
    'permanent',
    'perm',
    'full',
    'part',
    'time',
    'month',
    'months',
    'mo',
    'maternity',
    'paternity',
    'parental',
    'leave',
    'cover',
    'temporary',
    'temp',
    'm',
    'f',
    'd',
    'w',
    'x',
    'mfd',
    'all',
    'genders',
    'gender',
    'salary',
    'competitive',
    'up',
    'to',
    'plus',
    'benefits',
    'bonus',
    'equity',
    'ote',
    'annum',
    'year',
    'pa',
    'k',
    'gbp',
  ].flatMap((word) => word.split(' ')),
);

function isNoiseSegment(segment: string): boolean {
  const words = foldText(segment.replace(/£|€|\$/g, ' gbp '))
    .split(' ')
    .filter(Boolean);
  return (
    words.length > 0 && words.every((word) => NOISE_WORDS.has(word) || /^\d+(k|pa|m)?$/.test(word))
  );
}

/**
 * Title comparison form (ADR-030):
 * - bracketed segments and " - ", " | ", " – ", " — ", ", " segments after the first are
 *   dropped when they are only noise (location, work mode, contract, salary, gender tags);
 * - level synonyms are mapped (Jr → junior), and level words are kept.
 * "Product Analyst (Hybrid) - London" and "Product Analyst" match; "Senior Product Analyst" and
 * "Junior Product Analyst" don't; "Product Analyst (Payments)" keeps "payments".
 */
export function normaliseTitle(title: string): string {
  const withoutBrackets = title.replace(/[([]([^()[\]]*)[)\]]/g, (_whole, inner: string) =>
    isNoiseSegment(inner) ? ' ' : ` ${inner} `,
  );
  const [first = '', ...rest] = withoutBrackets.split(/\s+[-–—|]\s+|,\s+/);
  const kept = [first, ...rest.filter((segment) => !isNoiseSegment(segment))];
  return foldText(kept.join(' '))
    .split(' ')
    .filter(Boolean)
    .map((word) => LEVEL_SYNONYMS[word] ?? word)
    .join(' ');
}

// ---- Locations ----

export interface ParsedLocation {
  /** Comparison form of the first recognised city; `remote` for remote-only; '' if unknown. */
  city: string;
  country: Country;
  remote: RemoteMode;
}

function containsPhrase(folded: string, phrase: string): number {
  const match = new RegExp(`(^| )${phrase}( |$)`).exec(folded);
  return match ? match.index : -1;
}

function firstMatch(folded: string, phrases: readonly string[]): string | null {
  let best: { phrase: string; at: number } | null = null;
  for (const phrase of phrases) {
    const at = containsPhrase(folded, phrase);
    if (at >= 0 && (best === null || at < best.at)) best = { phrase, at };
  }
  return best?.phrase ?? null;
}

/** US state codes after a comma ("Cambridge, MA") mark a same-named place outside the UK. */
const US_STATES = new Set(
  (
    'AL AK AZ AR CA CO CT DE DC FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH ' +
    'NJ NM NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY'
  ).split(' '),
);

function inForeignNamesake(text: string, folded: string): boolean {
  const state = /,\s*([A-Z]{2})\b/.exec(text)?.[1];
  return (
    (state !== undefined && US_STATES.has(state)) ||
    firstMatch(folded, ['ontario', 'canada', 'united states', 'usa']) !== null
  );
}

export function parseLocation(text: string, remoteHint?: RemoteMode): ParsedLocation {
  const folded = foldText(text);
  let remote: RemoteMode = remoteHint ?? 'unknown';
  if (containsPhrase(folded, 'hybrid') >= 0) remote = 'hybrid';
  else if (containsPhrase(folded, 'remote') >= 0 || containsPhrase(folded, 'anywhere') >= 0) {
    remote = 'remote';
  } else if (firstMatch(folded, ['on site', 'onsite', 'in office', 'office based'])) {
    remote = 'onsite';
  }

  // "New York" must not read as York; "Cambridge, MA" and "London, Ontario" aren't in the UK.
  const namedCity = firstMatch(folded.replace(/(^| )new york( |$)/g, ' '), UK_CITIES);
  const foreign = inForeignNamesake(text, folded);
  const ukCity = foreign ? null : namedCity;
  const ukMarker = firstMatch(folded, UK_MARKERS);
  const nonUk = firstMatch(folded, NON_UK_MARKERS);
  const country: Country =
    foreign || (!ukCity && !ukMarker && nonUk) ? 'other' : ukCity || ukMarker ? 'GB' : 'unknown';

  let city = ukCity ?? (foreign ? (namedCity ?? '') : '');
  if (!city) {
    const firstSegment = foldText(text.split(/[,;/|(]| - /)[0] ?? '');
    const isPlace =
      firstSegment !== '' &&
      !isNoiseSegment(firstSegment) &&
      !NON_UK_MARKERS.includes(firstSegment) &&
      !UK_MARKERS.includes(firstSegment);
    city = isPlace ? firstSegment : nonUk && !UK_MARKERS.includes(nonUk) ? nonUk : '';
  }
  if (!city && remote === 'remote') city = 'remote';
  return { city, country, remote };
}

// ---- URLs and keys ----

const TRACKING_PARAMS = new Set([
  'gh_src',
  'source',
  'src',
  'ref',
  'referrer',
  'lever-source',
  'lever-origin',
  'trk',
  'trackingid',
  'refid',
  'fbclid',
  'gclid',
  'mc_cid',
  'mc_eid',
  'utm',
]);

/** Lower-case host, no fragment, tracking parameters dropped, other parameters sorted. */
export function canonicalUrl(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return null;
  parsed.protocol = 'https:';
  parsed.hash = '';
  parsed.hostname = parsed.hostname.toLowerCase();
  const params = [...parsed.searchParams.entries()]
    .filter(([key]) => {
      const lower = key.toLowerCase();
      return !TRACKING_PARAMS.has(lower) && !lower.startsWith('utm_');
    })
    .sort(([a], [b]) => a.localeCompare(b));
  parsed.search = new URLSearchParams(params).toString();
  if (parsed.pathname.length > 1) parsed.pathname = parsed.pathname.replace(/\/+$/, '');
  return parsed.toString();
}

/** The key prefix for a source's own job IDs. Alerts share the prefix of the site they mirror. */
export const SOURCE_KEY_PREFIX: Readonly<Record<JobSourceId, string>> = {
  greenhouse: 'greenhouse',
  lever: 'lever',
  ashby: 'ashby',
  workable: 'workable',
  reed: 'reed',
  adzuna: 'adzuna',
  hn: 'hn',
  'linkedin-alert': 'linkedin',
  'email-alert': 'email',
  lookup: 'lookup',
};

export function sourceKey(sourceId: JobSourceId, externalId: string): string {
  return `${SOURCE_KEY_PREFIX[sourceId]}:${externalId.trim().toLowerCase()}`;
}

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';

/**
 * Source keys a job URL identifies, from any site that links to it: an HN comment or an alert
 * that links a Greenhouse posting yields `greenhouse:{id}`. Unknown URLs yield nothing.
 */
export function keysFromUrl(url: string): string[] {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return [];
  }
  const host = parsed.hostname.toLowerCase().replace(/^www\./, '');
  const path = parsed.pathname;
  const param = (name: string) => parsed.searchParams.get(name);
  const keys = new Set<string>();

  const ghJid = param('gh_jid');
  if (ghJid && /^\d+$/.test(ghJid)) keys.add(`greenhouse:${ghJid}`);
  const ashbyJid = param('ashby_jid')?.toLowerCase();
  if (ashbyJid && new RegExp(`^${UUID}$`).test(ashbyJid)) keys.add(`ashby:${ashbyJid}`);

  if (/(^|\.)greenhouse\.io$/.test(host)) {
    const id = /\/jobs\/(\d+)/.exec(path)?.[1];
    if (id) keys.add(`greenhouse:${id}`);
  } else if (/^jobs(\.eu)?\.lever\.co$/.test(host)) {
    const id = new RegExp(`^/[^/]+/(${UUID})`, 'i').exec(path)?.[1];
    if (id) keys.add(`lever:${id.toLowerCase()}`);
  } else if (host === 'jobs.ashbyhq.com') {
    const id = new RegExp(`^/[^/]+/(${UUID})`, 'i').exec(path)?.[1];
    if (id) keys.add(`ashby:${id.toLowerCase()}`);
  } else if (host === 'apply.workable.com') {
    // `apply.workable.com/j/{shortcode}`, or with the account first: `/{account}/j/{shortcode}`.
    const id = /^\/(?:[^/]+\/)?j\/([a-z0-9]+)/i.exec(path)?.[1];
    if (id) keys.add(`workable:${id.toLowerCase()}`);
  } else if (/(^|\.)linkedin\.com$/.test(host)) {
    const id = /\/jobs\/view\/(?:[^/]*?-)?(\d{6,})/.exec(path)?.[1] ?? param('currentJobId');
    if (id && /^\d{6,}$/.test(id)) keys.add(`linkedin:${id}`);
  } else if (host === 'reed.co.uk') {
    const id = /^\/jobs\/[^/]+\/(\d+)/.exec(path)?.[1];
    if (id) keys.add(`reed:${id}`);
  } else if (/(^|\.)adzuna\.co\.uk$/.test(host)) {
    const id = /\/(?:details|ad)\/(\d+)/.exec(path)?.[1];
    if (id) keys.add(`adzuna:${id}`);
  } else if (host === 'news.ycombinator.com' && path === '/item') {
    const id = param('id');
    if (id && /^\d+$/.test(id)) keys.add(`hn:${id}`);
  }
  return [...keys];
}
