import { describe, expect, it } from 'vitest';

import { decodeEntities, htmlToText, tidyText } from './html.js';

describe('decodeEntities', () => {
  it('decodes named and numeric references and leaves unknown ones', () => {
    expect(decodeEntities('A &amp; B &lt;3 &#163;35k &#x2014; &rsquo;s &bogus;')).toBe(
      'A & B <3 £35k — ’s &bogus;',
    );
  });

  it('drops invalid code points', () => {
    expect(decodeEntities('x&#0;y&#xD800;z&#1114112;')).toBe('xyz');
  });
});

describe('htmlToText', () => {
  it('turns blocks and list items into lines and bullets', () => {
    expect(
      htmlToText('<h2>About</h2><p>We build <b>tools</b>.</p><ul><li>SQL</li><li>Python</li></ul>'),
    ).toBe('About\n\nWe build tools .\n\n• SQL\n• Python');
  });

  it('decodes escaped HTML once first (Greenhouse content)', () => {
    expect(htmlToText('&lt;p&gt;Fish &amp;amp; chips&lt;/p&gt;', { escaped: true })).toBe(
      'Fish & chips',
    );
  });

  it('drops scripts, styles and comments', () => {
    expect(htmlToText('<style>p{}</style><script>alert(1)</script><!-- x --><p>Hi</p>')).toBe('Hi');
  });

  it('keeps escaped markup as literal text (the web app renders text, never HTML)', () => {
    expect(htmlToText('<p>&lt;b&gt;bold&lt;/b&gt;</p>')).toBe('<b>bold</b>');
    expect(htmlToText('<p>text</p>')).not.toContain('<p>');
  });

  it('caps the length', () => {
    expect(htmlToText(`<p>${'a'.repeat(100)}</p>`, { maxLength: 10 })).toHaveLength(10);
  });
});

describe('tidyText', () => {
  it('collapses spaces and blank lines', () => {
    expect(tidyText('  a \t b\r\n\r\n\r\n\r\nc  ')).toBe('a b\n\nc');
  });
});
