/**
 * The emulator's fake model for `pasteParse` (ADR-017): reads lines shaped like "- <title> at
 * <company> in <place>." and answers with those rows, so `npm run dev` shows the fallback without
 * calling Anthropic. Only `npm run dev` bundles this.
 */
export function fakePasteParse(user: string): unknown {
  const rows = user
    .split('\n')
    .flatMap((line) => {
      const match = /^- (.+?) at (.+?) in (.+?)\.$/.exec(line.trim());
      if (!match?.[1] || !match[2] || !match[3]) return [];
      return [
        { title: match[1], company: match[2], location: match[3], age: null, linkIndex: null },
      ];
    })
    .slice(0, 50);
  return { rows };
}
