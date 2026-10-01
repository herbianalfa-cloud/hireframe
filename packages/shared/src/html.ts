import { JOB_LIMITS } from './jobs.js';

/**
 * Job description HTML → plain text (ADR-029). The output is stored and later read by the
 * funnel as untrusted data, and the web app renders it as text, so this only has to be readable,
 * not a sanitiser: it never produces markup.
 */

const NAMED_ENTITIES: Readonly<Record<string, string>> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  ndash: '–',
  mdash: '—',
  lsquo: '‘',
  rsquo: '’',
  ldquo: '“',
  rdquo: '”',
  hellip: '…',
  bull: '•',
  middot: '·',
  pound: '£',
  euro: '€',
  copy: '©',
  reg: '®',
  trade: '™',
};

function codePoint(value: number): string {
  return Number.isInteger(value) &&
    value > 0 &&
    value <= 0x10ffff &&
    !(value >= 0xd800 && value <= 0xdfff)
    ? String.fromCodePoint(value)
    : '';
}

/** Decodes named (the common ones) and numeric character references; unknown ones stay. */
export function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, ref: string) => {
    if (ref.startsWith('#x') || ref.startsWith('#X')) return codePoint(parseInt(ref.slice(2), 16));
    if (ref.startsWith('#')) return codePoint(parseInt(ref.slice(1), 10));
    return NAMED_ENTITIES[ref.toLowerCase()] ?? whole;
  });
}

export interface HtmlToTextOptions {
  /**
   * The HTML itself is entity-escaped (`&lt;p&gt;…`), as in Greenhouse's `content` field, so it
   * is decoded once before the tags are read.
   */
  escaped?: boolean;
  maxLength?: number;
}

export function htmlToText(html: string, options: HtmlToTextOptions = {}): string {
  const source = options.escaped ? decodeEntities(html) : html;
  const text = source
    .replace(/<(script|style|template)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<li\b[^>]*>/gi, '\n• ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|ul|ol|h[1-6]|tr|table|section|blockquote)\s*>/gi, '\n')
    .replace(/<(p|div|h[1-6]|ul|ol|table|section|blockquote)\b[^>]*>/gi, '\n')
    .replace(/<[^>]*>/g, ' ');
  return tidyText(decodeEntities(text), options.maxLength ?? JOB_LIMITS.description);
}

/** Collapses spaces within lines and runs of blank lines, trims, and caps the length. */
export function tidyText(text: string, maxLength: number = JOB_LIMITS.description): string {
  return text
    .replace(/\r\n?/g, '\n')
    .replace(/[\t\f\v \u00a0\u2000-\u200b\u202f\u205f\u3000]+/g, ' ')
    .split('\n')
    .map((line) => line.trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .slice(0, maxLength);
}
