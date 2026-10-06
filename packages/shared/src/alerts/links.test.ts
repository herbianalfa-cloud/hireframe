import { describe, expect, it } from 'vitest';

import { canonicalAlertUrl, extractLinks, hostAllowed, linkedInJobId } from './links.js';

describe('extractLinks', () => {
  it('reads http(s) anchors with their text, in order, decoding entities', () => {
    const html =
      '<p><a class="x" href="https://a.example/x?p=1&amp;q=2"><b>One</b></a> <a href=\'http://b.example/\'>Two</a>' +
      '<a href="mailto:a@example.com">Mail</a><a href="javascript:alert(1)">No</a><a name="n">None</a></p>';
    const links = extractLinks(html);
    expect(links.map((link) => [link.href, link.text])).toEqual([
      ['https://a.example/x?p=1&q=2', 'One'],
      ['http://b.example/', 'Two'],
    ]);
    expect(html.slice(links[0]?.start, links[0]?.end)).toMatch(/^<a class/);
  });
});

describe('hostAllowed', () => {
  const hosts = ['greenhouse.io', 'lever.co'];
  it('accepts the host and its subdomains only', () => {
    expect(hostAllowed('https://boards.greenhouse.io/x', hosts)).toBe(true);
    expect(hostAllowed('https://greenhouse.io/x', hosts)).toBe(true);
    expect(hostAllowed('https://greenhouse.io.evil.example/x', hosts)).toBe(false);
    expect(hostAllowed('https://evilgreenhouse.io/x', hosts)).toBe(false);
    expect(hostAllowed('not a url', hosts)).toBe(false);
  });
});

describe('LinkedIn job links', () => {
  it.each([
    ['https://www.linkedin.com/jobs/view/4012345678', '4012345678'],
    ['https://www.linkedin.com/jobs/view/4012345678/?trackingId=a&refId=b', '4012345678'],
    ['https://www.linkedin.com/comm/jobs/view/4012345678/?trackingId=a', '4012345678'],
    ['https://www.linkedin.com/jobs/view/product-analyst-at-acme-4012345678?trk=x', '4012345678'],
  ])('finds the ID in %s', (url, id) => {
    expect(linkedInJobId(url)).toBe(id);
    expect(canonicalAlertUrl(url)).toBe('https://www.linkedin.com/jobs/view/4012345678');
  });

  it('does not treat search or settings links as jobs', () => {
    expect(
      linkedInJobId('https://www.linkedin.com/jobs/search/?currentJobId=4012345678'),
    ).toBeUndefined();
    expect(
      linkedInJobId('https://www.linkedin.com/comm/psettings/email-unsubscribe?x=1'),
    ).toBeUndefined();
  });

  it('drops tracking parameters from other links', () => {
    expect(canonicalAlertUrl('https://jobs.ashbyhq.com/x/y?utm_source=waas&ref=a')).toBe(
      'https://jobs.ashbyhq.com/x/y',
    );
    expect(canonicalAlertUrl('ftp://x')).toBeNull();
  });
});
