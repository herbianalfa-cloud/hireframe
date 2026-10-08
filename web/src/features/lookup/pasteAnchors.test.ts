import { describe, expect, it } from 'vitest';

import { extractJobAnchors, MAX_JOB_ANCHORS } from './pasteAnchors';

const HOSTILE = `
  <div>
    <script>window.__pwned = true; document.title = 'pwned';</script>
    <img src="https://tracker.example.test/pixel.png" onerror="window.__pwned = true">
    <iframe src="https://evil.example.test/frame"></iframe>
    <a href="https://www.linkedin.com/jobs/view/4020000100/?trackingId=abc" onclick="window.__pwned = true">
      Product Analyst   <b>Product Analyst</b>
    </a>
    <a href="/jobs/view/4020000101/">Relative link</a>
    <a href="https://www.linkedin.com/company/123/">Company page</a>
    <a href="javascript:window.__pwned=true">Script link</a>
    <a href="https://www.linkedin.com/jobs/view/4020000102/" id="x">Third <img src=x onerror="window.__pwned=true"></a>
  </div>`;

describe('extractJobAnchors', () => {
  it('returns only href and text strings for LinkedIn job views', () => {
    const links = extractJobAnchors(HOSTILE);
    expect(links).toEqual([
      {
        href: 'https://www.linkedin.com/jobs/view/4020000100/?trackingId=abc',
        text: 'Product Analyst Product Analyst',
      },
      { href: 'https://www.linkedin.com/jobs/view/4020000101/', text: 'Relative link' },
      { href: 'https://www.linkedin.com/jobs/view/4020000102/', text: 'Third' },
    ]);
    for (const link of links) expect(Object.keys(link).sort()).toEqual(['href', 'text']);
  });

  it('runs nothing and adds nothing to the page', () => {
    const before = document.documentElement.outerHTML;
    const title = document.title;
    extractJobAnchors(HOSTILE);
    expect((window as unknown as { __pwned?: boolean }).__pwned).toBeUndefined();
    expect(document.title).toBe(title);
    expect(document.documentElement.outerHTML).toBe(before);
    expect(document.querySelector('script, iframe, img')).toBeNull();
  });

  it('copes with empty, broken and huge input', () => {
    expect(extractJobAnchors('')).toEqual([]);
    expect(extractJobAnchors('   ')).toEqual([]);
    expect(extractJobAnchors('<a href="https://www.linkedin.com/jobs/view/4020000100/"')).toEqual(
      [],
    );
    const many = Array.from(
      { length: MAX_JOB_ANCHORS + 20 },
      (_, i) => `<a href="https://www.linkedin.com/jobs/view/${String(4_030_000_000 + i)}/">J</a>`,
    ).join('');
    expect(extractJobAnchors(many)).toHaveLength(MAX_JOB_ANCHORS);
  });
});
