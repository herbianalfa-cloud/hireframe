import { JOB_LIMITS, linkedInJobId, type PasteLink } from '@hireframe/shared';

/** Anchors read from one paste; a results page has about 25 job cards. */
export const MAX_JOB_ANCHORS = 200;
const BASE = 'https://www.linkedin.com/';

/**
 * The job-view anchors of a pasted page's HTML, as `{ href, text }` strings (ADR-049).
 *
 * The HTML is parsed only with `DOMParser`, which builds an inert document: no script runs and
 * no image or frame loads. Nothing from it is ever put into the page. Only these strings leave
 * this function, and they are shown as text. A relative link is resolved against LinkedIn, and
 * only links that are LinkedIn job views are kept (the one place an ID is read from).
 */
export function extractJobAnchors(html: string): PasteLink[] {
  if (!html.trim()) return [];
  let parsed: Document;
  try {
    parsed = new DOMParser().parseFromString(html, 'text/html');
  } catch {
    return [];
  }
  const links: PasteLink[] = [];
  for (const anchor of parsed.querySelectorAll('a[href]')) {
    const raw = anchor.getAttribute('href')?.trim() ?? '';
    let href: string;
    try {
      const url = new URL(raw, BASE);
      if (url.protocol !== 'https:' && url.protocol !== 'http:') continue;
      href = url.href;
    } catch {
      continue;
    }
    if (href.length > JOB_LIMITS.url || !linkedInJobId(href)) continue;
    links.push({
      href,
      text: anchor.textContent.replace(/\s+/g, ' ').trim().slice(0, 300),
    });
    if (links.length >= MAX_JOB_ANCHORS) break;
  }
  return links;
}
