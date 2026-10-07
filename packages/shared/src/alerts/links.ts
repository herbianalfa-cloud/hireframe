import { decodeEntities, htmlToText } from '../html.js';
import { canonicalUrl, keysFromUrl } from '../normalise.js';

/**
 * Links in alert emails (ADR-047), pure. They are read from the HTML in code, so a model can
 * point at one by index but never write a URL of its own.
 */

export interface AlertLink {
  href: string;
  text: string;
  /** Offsets of the whole `<a …>…</a>` in the source HTML. */
  start: number;
  end: number;
}

const ANCHOR = /<a\b([^>]*)>([\s\S]*?)<\/a\s*>/gi;
const HREF = /\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i;

/** Every anchor with an http(s) `href`, in document order. */
export function extractLinks(html: string): AlertLink[] {
  const links: AlertLink[] = [];
  for (const match of html.matchAll(ANCHOR)) {
    const attributes = match[1] ?? '';
    const href = HREF.exec(attributes);
    const raw = decodeEntities((href?.[1] ?? href?.[2] ?? href?.[3] ?? '').trim());
    if (!/^https?:\/\//i.test(raw)) continue;
    links.push({
      href: raw,
      text: htmlToText(match[2] ?? '', { maxLength: 300 }),
      start: match.index,
      end: match.index + match[0].length,
    });
  }
  return links;
}

/** Whether `url`'s host is one of `hosts` or a subdomain of one. */
export function hostAllowed(url: string, hosts: readonly string[]): boolean {
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return false;
  }
  return hosts.some((allowed) => host === allowed || host.endsWith(`.${allowed}`));
}

/** The LinkedIn job ID in a `/jobs/view/…` link (tracking or canonical form), if it is one. */
export function linkedInJobId(url: string): string | undefined {
  let pathname: string;
  try {
    pathname = new URL(url).pathname;
  } catch {
    return undefined;
  }
  if (!pathname.includes('/jobs/view/')) return undefined;
  const key = keysFromUrl(url).find((candidate) => candidate.startsWith('linkedin:'));
  return key?.slice('linkedin:'.length);
}

export function canonicalLinkedInJobUrl(id: string): string {
  return `https://www.linkedin.com/jobs/view/${id}`;
}

/**
 * A link as stored: tracking parameters dropped, and a LinkedIn job link reduced to its canonical
 * form (its tracking URL can carry per-recipient tokens). Null if it isn't an http(s) URL.
 */
export function canonicalAlertUrl(url: string): string | null {
  const id = linkedInJobId(url);
  if (id) return canonicalLinkedInJobUrl(id);
  return canonicalUrl(url);
}
