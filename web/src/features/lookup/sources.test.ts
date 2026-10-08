// @vitest-environment node
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const dir = fileURLToPath(new URL('.', import.meta.url));
const sources = readdirSync(dir)
  .filter((name) => /\.(ts|tsx)$/.test(name) && !/\.test\.(ts|tsx)$/.test(name))
  .map((name) => ({ name, text: readFileSync(`${dir}${name}`, 'utf8') }));

describe('features/lookup', () => {
  it('never puts pasted HTML into the page', () => {
    expect(sources.length).toBeGreaterThan(5);
    for (const { name, text } of sources) {
      expect(text, name).not.toMatch(
        /innerHTML|outerHTML|dangerouslySetInnerHTML|insertAdjacentHTML/,
      );
      expect(text, name).not.toMatch(
        /document\.write|createContextualFragment|importNode|adoptNode/,
      );
    }
  });

  it('reads pasted HTML with DOMParser only, in one place', () => {
    const users = sources.filter(({ text }) => text.includes('DOMParser'));
    expect(users.map(({ name }) => name)).toEqual(['pasteAnchors.ts']);
  });
});
