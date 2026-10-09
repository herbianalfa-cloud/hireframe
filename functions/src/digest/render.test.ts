import { describe, expect, it } from 'vitest';

import { APP_ORIGIN } from '../config.js';
import {
  cleanText,
  escapeHtml,
  renderDigest,
  type DigestInput,
  type DigestJobLine,
  type DigestRunSummary,
} from './render.js';

const job = (id: string, overrides: Partial<DigestJobLine> = {}): DigestJobLine => ({
  id,
  title: `Analyst ${id}`,
  company: 'Acme Analytics',
  fitScore: 8,
  luckScore: 6.5,
  reason: 'Strong match on SQL and dashboards.',
  shortfall: 'Asks for 5 years; has 3.',
  ...overrides,
});

const EMPTY = { jobs: [], total: 0 } as const;

const RUN: DigestRunSummary = {
  status: 'succeeded',
  startedAt: new Date('2026-10-07T06:30:00Z'),
  s2: { in: 40, passed: 12, skipped: 28, queued: 0 },
  s3: { in: 12, apply: 2, near_miss: 1, wildcard: 1, skip: 8, queued: 0 },
  errors: [],
};

function input(overrides: Partial<DigestInput> = {}): DigestInput {
  return {
    state: 'ready',
    day: '2026-10-07',
    partial: false,
    run: RUN,
    apply: { jobs: [job('a1'), job('a2')], total: 2 },
    nearMiss: { jobs: [job('n1')], total: 1 },
    wildcard: { jobs: [job('w1')], total: 1 },
    sources: [{ id: 'reed', status: 'ok' }],
    waitingForDescription: 3,
    spend: { spendPence: 500, capPence: 1500 },
    ...overrides,
  };
}

function withoutRun(state: DigestInput['state']): DigestInput {
  const rest: Partial<DigestInput> = input();
  delete rest.run;
  return { ...(rest as DigestInput), state };
}

/** Every href in the HTML. */
const hrefs = (html: string) => [...html.matchAll(/href="([^"]*)"/g)].map((m) => m[1] ?? '');

describe('renderDigest: ready', () => {
  const out = renderDigest(input());

  it('has every R9 section, in order, in html and text', () => {
    const titles = ['Apply', 'Near misses', 'Wildcards', 'Run health', 'Spend', 'Errors'];
    let at = 0;
    for (const title of titles) {
      const next = out.html.indexOf(`>${title}</h2>`, at);
      expect(next, title).toBeGreaterThanOrEqual(at);
      at = next;
    }
    let textAt = 0;
    for (const title of titles) {
      const next = out.text.indexOf(title.toUpperCase(), textAt);
      expect(next, title).toBeGreaterThanOrEqual(textAt);
      textAt = next;
    }
  });

  it('puts fit, luck and the reason on Apply lines, and the shortfall on near misses', () => {
    expect(out.text).toContain('Analyst a1 · Acme Analytics (fit 8 · luck 6.5 — Strong match');
    expect(out.text).toContain('Analyst n1 · Acme Analytics (fit 8 · luck 6.5 — Asks for 5 years');
    expect(out.text).not.toContain('Asks for 5 years; has 3.'.repeat(2));
  });

  it('has a subject with counts only', () => {
    expect(out.subject).toBe('Hireframe Wed 7 Oct: 2 apply, 1 near miss, 1 wildcard');
  });

  it('says what the run did', () => {
    expect(out.text).toContain('Run: succeeded, started 07:30');
    expect(out.text).toContain('S2 (title and company check): 40 in, 12 passed, 28 skipped');
    expect(out.text).toContain('S3 (deep read): 12 in, 2 apply');
    expect(out.text).toContain('3 waiting for a description');
    expect(out.text).toContain('All sources healthy');
  });

  it('adds "+n more" past the listed jobs', () => {
    const more = renderDigest(input({ apply: { jobs: [job('a1')], total: 14 } }));
    expect(more.text).toContain('+13 more in the app');
  });

  it('adds the pipeline line only when given', () => {
    expect(out.text).not.toContain('PIPELINE');
    const withPipeline = renderDigest(
      input({
        pipeline: { needsInput: 2, generating: 1, ready: 3, appliedThisWeek: 4, weeklyTarget: 10 },
      }),
    );
    expect(withPipeline.text).toContain(
      '2 need your input · 1 generating · 3 ready to send · 4 applied this week of 10',
    );
    expect(hrefs(withPipeline.html)).toContain(`${APP_ORIGIN}/pipeline`);
  });
});

describe('renderDigest: empty sections', () => {
  it('says "None today" for each of the empty sections', () => {
    const out = renderDigest(input({ apply: EMPTY, nearMiss: EMPTY, wildcard: EMPTY }));
    expect(out.html.match(/None today/g)?.length).toBe(4); // three lists and Errors
    expect(out.text.match(/None today/g)?.length).toBe(4);
    expect(out.subject).toContain('0 apply, 0 near miss, 0 wildcard');
  });
});

describe('renderDigest: escaping and links', () => {
  const nasty = input({
    apply: {
      jobs: [
        job('a<1>"x', {
          title: '<script>alert(1)</script>',
          company: 'Evil & "Co" <b>',
          reason: 'Go to https://evil.example/apply or www.evil.example now',
        }),
      ],
      total: 1,
    },
  });
  const out = renderDigest(nasty);

  it('leaves <script> in a title as text', () => {
    expect(out.html).not.toContain('<script>');
    expect(out.html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(out.html).toContain('Evil &amp; &quot;Co&quot; &lt;b&gt;');
  });

  it('links only to the app, with the job id encoded', () => {
    const links = hrefs(out.html);
    expect(links.length).toBeGreaterThan(0);
    for (const link of links) expect(link.startsWith(APP_ORIGIN), link).toBe(true);
    expect(links).toContain(`${APP_ORIGIN}/?job=a%3C1%3E%22x`);
  });

  it('carries no posting URL, in html or text', () => {
    for (const text of [out.html, out.text]) {
      expect(text).not.toContain('evil.example');
    }
    expect(out.text).toContain('[link removed]');
    const urls = [...(out.html + out.text).matchAll(/https?:\/\/[^\s"<]+/g)].map((m) => m[0]);
    for (const url of urls) expect(url.startsWith(APP_ORIGIN), url).toBe(true);
  });

  it('has no images and no tracking', () => {
    expect(out.html).not.toMatch(/<img|<script|<iframe|<link|<style/i);
  });

  it('keeps a title with a newline from breaking the subject or a line', () => {
    const multi = renderDigest(
      input({ apply: { jobs: [job('x', { title: 'a\nb\r\nc' })], total: 1 } }),
    );
    expect(multi.subject).not.toMatch(/[\r\n]/);
    expect(multi.text).toContain('a b c');
  });
});

describe('cleanText and escapeHtml', () => {
  it('strips URLs and control characters, and collapses space', () => {
    expect(cleanText('see  http://a.test/x?y=1  and\u0007 more')).toBe(
      'see [link removed] and more',
    );
    expect(cleanText('https://a.test, www.b.test.')).toBe('[link removed] [link removed]');
  });
  it('escapes the five HTML characters', () => {
    expect(escapeHtml(`<a href="x">'&'</a>`)).toBe(
      '&lt;a href=&quot;x&quot;&gt;&#39;&amp;&#39;&lt;/a&gt;',
    );
  });
});

describe('renderDigest: spend (R11)', () => {
  const spend = (spendPence: number) =>
    renderDigest(input({ spend: { spendPence, capPence: 100 } }));

  it('shows the pence and percentage, with no warning at 79%', () => {
    const out = spend(79);
    expect(out.text).toContain('79p of 100p this month (79%)');
    expect(out.text).not.toContain('Warning');
    expect(out.text).not.toContain('paused');
  });

  it('warns at 80%', () => {
    const out = spend(80);
    expect(out.text).toContain('Warning: 80% of the monthly cap is used');
    expect(out.html).toContain('Warning: 80% of the monthly cap is used');
    expect(out.text).not.toContain('Deep reads are paused');
  });

  it('says deep reads are paused from 90%', () => {
    expect(spend(89).text).not.toContain('Deep reads are paused');
    expect(spend(90).text).toContain('Deep reads are paused');
  });

  it('says the cap is reached at 100%', () => {
    const out = spend(100);
    expect(out.text).toContain('Monthly cap reached');
    expect(out.text).toContain('Deep reads are paused');
    expect(out.text).not.toContain('Warning: 80%');
  });

  it('does not divide by a zero cap', () => {
    const out = renderDigest(input({ spend: { spendPence: 0, capPence: 0 } }));
    expect(out.text).toContain('0p of 0p this month (100%)');
  });
});

describe('renderDigest: run health and errors (R12)', () => {
  it('adds the partial-run notice', () => {
    const out = renderDigest(input({ partial: true }));
    expect(out.text).toContain('Some sources failed in this run.');
    expect(renderDigest(input()).text).not.toContain('Some sources failed');
  });

  it('lists failing sources by code, not message', () => {
    const out = renderDigest(
      input({
        sources: [
          { id: 'reed', status: 'failing', errorCode: 'http_429' },
          { id: 'adzuna', status: 'ok' },
          { id: 'greenhouse', status: 'degraded' },
        ],
      }),
    );
    expect(out.text).toContain('Source reed: failing (http_429)');
    expect(out.text).toContain('Source greenhouse: degraded');
    expect(out.text).not.toContain('Source adzuna');
    expect(out.text).not.toContain('All sources healthy');
  });

  it('lists the run’s error codes and caps the list', () => {
    const errors = Array.from({ length: 13 }, (_, i) => ({
      sourceId: 'reed',
      code: `code_${String(i)}`,
    }));
    const out = renderDigest(input({ run: { ...RUN, errors } }));
    expect(out.text).toContain('reed: code_0');
    expect(out.text).toContain('reed: code_9');
    expect(out.text).not.toContain('code_10');
    expect(out.text).toContain('+3 more on the System screen');
  });
});

describe('renderDigest: the other states', () => {
  it('in_progress has an explicit notice and no job sections', () => {
    const out = renderDigest(withoutRun('in_progress'));
    expect(out.subject).toBe('Hireframe Wed 7 Oct: scan still running');
    expect(out.text).toContain("Today's scan has not finished yet");
    expect(out.text).not.toContain('APPLY');
    expect(out.text).toContain('SPEND');
  });

  it('failed says so, and still shows run health, spend and errors', () => {
    const out = renderDigest(
      input({
        state: 'failed',
        run: { ...RUN, status: 'failed', errors: [{ code: 'timeout' }] },
      }),
    );
    expect(out.subject).toContain('scan failed');
    expect(out.text).toContain('failed or was cut off');
    expect(out.text).toContain('RUN HEALTH');
    expect(out.text).toContain('- timeout');
    expect(out.text).not.toContain('NEAR MISSES');
  });

  it('missing says no scan started', () => {
    const out = renderDigest(withoutRun('missing'));
    expect(out.subject).toContain('no scan this morning');
    expect(out.text).toContain('No scan started this morning');
  });
});
