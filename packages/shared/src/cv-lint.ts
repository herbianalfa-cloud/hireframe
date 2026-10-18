import type { CvContent, CvFact, TrimmedCvContent } from './cv.js';
import { makeFinding, type Finding, type FindingCode } from './cv-findings.js';

/**
 * The CV writing check (CV quality plan, §2): pure rule tables over the prose the model wrote.
 * It reads the summary, the bullets and the cover note; headings, education lines and skill
 * labels are checked against their facts by `validateCv`, not here. A finding is a code and a
 * path, never the text found. Words a cited fact uses itself are allowed ("Led onboarding for 12
 * clients" passes when the fact says "Led"), because the fact is the owner's own claim. The words
 * of the job's own title ("Manager" in "Technical Account Manager") and a denied use ("not
 * managed", "never led") are not an inflated claim either.
 */

type Part = 'cv' | 'note';

interface Text {
  path: string;
  value: string;
  part: Part;
  /** Set on a bullet: where the weak-opener check applies. */
  bullet: boolean;
  /** The facts the text cites, lower case, for the words a fact may own. */
  cited: string;
  /** The first and last paragraph of the note, for the greeting and sign-off check. */
  noteEdge: { first: boolean; last: boolean } | null;
}

/** Curly quotes to straight ones, so one pattern covers both. */
function plain(text: string): string {
  return text.replace(/[‘’]/g, "'").replace(/[“”]/g, '"');
}

const GAP = String.raw`[^.;!?]{1,80}?`;

/** "Not X but Y" and its relatives. Each needs the contrast shape, not just the word "not". */
const CONTRAST: readonly RegExp[] = [
  new RegExp(
    String.raw`\bnot (?:just|only|merely|simply)\b${GAP}[,;]?\s*(?:but|it's|it is)\b`,
    'i',
  ),
  new RegExp(String.raw`\bnot only\b${GAP}\bbut also\b`, 'i'),
  new RegExp(
    String.raw`\b(?:isn't|is not|wasn't|was not|aren't|are not|not) (?:just )?about\b${GAP}[,;.]\s*(?:it's|it is|but|this is)\b`,
    'i',
  ),
  new RegExp(
    String.raw`\b(?:it's|it is|this is|that's|that is) not\b${GAP}[.;,]\s*(?:it's|it is|this is|that's|that is|but)\b`,
    'i',
  ),
  new RegExp(String.raw`\bnot an? [^.;!?,]{1,40}, but an?\b`, 'i'),
  // "less X, more Y", but not "less than 2 weeks, more than halving it": a comparison of figures.
  new RegExp(String.raw`\bless\b(?:(?!\bthan\b)[^.;!?,]){1,40},\s*more\b`, 'i'),
  // "isn't X, it's Y" with any subject: "Good onboarding isn't paperwork, it's trust."
  new RegExp(
    String.raw`\b(?:isn't|wasn't|aren't|weren't|is not|was not|are not|were not)\b${GAP}[,;.]\s*(?:it's|it is|it was|that's|that is|that was|this is|they're|they are|they were)\b`,
    'i',
  ),
  // "not for X but for Y": "Built the dashboard not for show but for weekly decisions."
  new RegExp(
    String.raw`\bnot (?:for|to|by|because of|because|as|in|on|with)\b[^.;!?,]{1,40}?\bbut (?:for|to|by|because|as|in|on|with)\b`,
    'i',
  ),
  // A sentence that opens "Not X but Y": "Not speed but accuracy."
  new RegExp(String.raw`(?:^|[.;!?]\s+)not\b[^.;!?,]{1,40}?\sbut\b`, 'i'),
];

/** Stock phrases. Never allowed, whatever the facts say. */
const CLICHE: readonly RegExp[] = [
  /\bpassionate about\b/i,
  /\bproven track record\b/i,
  /\bresults[- ]driven\b/i,
  /\bteam player\b/i,
  /\bfast[- ]paced environment\b/i,
  /\bhit the ground running\b/i,
  /\bi am writing to apply\b/i,
  /\bthink(?:ing)? outside (?:of )?the box\b/i,
  /\bgo(?:ing)? the extra mile\b/i,
  /\bself[- ]starter\b/i,
  /\bdetail[- ]oriented\b/i,
];

/** Buzzwords. One costs a little; two in a sentence is a hard finding. A fact may own its own. */
const BUZZWORDS: readonly RegExp[] = [
  /\bleverag\w*/i,
  /\bsynerg\w*/i,
  /\binnovati\w*/i,
  /\bdynamic\b/i,
  /\bcutting[- ]edge\b/i,
  /\bpassionate\b/i,
  /\brock ?stars?\b/i,
  /\bninjas?\b/i,
  /\bgurus?\b/i,
  /\bseamless\w*/i,
  /\bholistic\w*/i,
  /\bgame[- ]chang\w*/i,
  /\bbest[- ]in[- ]class\b/i,
  /\bimpactful\b/i,
  /\bvisionary\b/i,
  /\bdisruptive\b/i,
  /\btransformative\b/i,
  /\bstate[- ]of[- ]the[- ]art\b/i,
  /\bthought leader\w*/i,
  /\bgo[- ]getter\b/i,
  /\bdeep dive\b/i,
];

/** Vague adjectives: three in a row ("driven, dedicated and proactive") is a stack. */
const ADJECTIVE = String.raw`(?:motivated|driven|dedicated|hard[- ]?working|passionate|dynamic|innovative|proactive|enthusiastic|creative|reliable|versatile|resourceful|adaptable|collaborative|strategic|ambitious|energetic|dependable)`;
const SEP = String.raw`(?:\s*,\s*(?:and\s+)?|\s+and\s+)`;
const ADJECTIVE_CHAIN = new RegExp(
  String.raw`\b${ADJECTIVE}${SEP}${ADJECTIVE}${SEP}${ADJECTIVE}\b`,
  'i',
);

/** Leadership, seniority and superlatives. Allowed only in a word the cited fact uses. */
const INFLATED: readonly RegExp[] = [
  /\bspearhead\w*/i,
  /\bpioneer\w*/i,
  /\borchestrat\w*/i,
  /\barchitect(?:ed|ing)\b/i,
  /\bchampion(?:ed|ing)\b/i,
  /\bexpert\w*/i,
  /\bseasoned\b/i,
  /\bworld[- ]class\b/i,
  /\bextensive\w*/i,
  /\bstrategic\w*/i,
  /\b(?:led|leading|leadership|leader)\b/i,
  /\bmanag(?:ed|ing|er|ement)\b/i,
  /\bovers(?:aw|ee|eeing|een)\b/i,
  /\bmaster(?:ed|y)\b/i,
  /\bunparalleled\b/i,
  /\bexceptional\w*/i,
  /\boutstanding\b/i,
];

/**
 * A present-tense claim as a bullet's opening verb ("Lead weekly calls", "Manages the queue"):
 * `open` finds it, `own` is the word a cited fact may use itself. Only the opening verb counts, so
 * "the lead paragraph" and "lead time" stay clean.
 */
const OPENING_CLAIMS: readonly { open: RegExp; own: RegExp }[] = [
  {
    open: /^\s*leads?\b(?!\s+(?:time|times|paragraph|paragraphs|generation|gen|source|sources|sheet|magnet|capture|qualification|scoring)\b)/i,
    own: /\b(?:lead|leads|led|leading|leadership|leader)\b/i,
  },
  { open: /^\s*manages?\b/i, own: /\bmanag(?:e|es|ed|ing|er|ement)\b/i },
  { open: /^\s*oversees\b/i, own: /\bovers(?:aw|ee|ees|eeing|een)\b/i },
];

const INTENSIFIER =
  /\b(?:successfully|effectively|significantly|substantially|dramatically|remarkably|tremendously|extremely|highly|greatly|truly|really)\b/i;

const WEAK_OPENER =
  /^\s*(?:responsible for|worked on|tasked with|helped to|helped with|assisted with|duties included|in charge of)\b/i;

/** "I" is capital only; "me", "my" and "myself" in any case ("My onboarding work"). */
const FIRST_PERSON_I = /\b(?:I|I'm|I've|I'd|I'll)\b/g;
const FIRST_PERSON_ME = /\b(?:me|my|myself)\b/i;
/** Words that can open a sentence before a real "I" ("Then I ran"); "Phase I" is a numeral. */
const BEFORE_REAL_I =
  /^(?:then|later|now|today|when|while|after|before|since|so|and|but|here|there|next|first|once|yes|as|if|because|although|though|where|whenever|whilst|until|thus|hence|also|still|soon|often|always|never)$/i;

/** Whether the text says "I": not the Roman numeral after a capitalised word ("Phase I"). */
function saysI(value: string): boolean {
  for (const match of value.matchAll(FIRST_PERSON_I)) {
    const before = /([\p{L}][\p{L}'-]*)\s+$/u.exec(value.slice(0, match.index))?.[1];
    if (
      before !== undefined &&
      /^\p{Lu}/u.test(before) &&
      !BEFORE_REAL_I.test(before) &&
      match[0] === 'I'
    ) {
      continue;
    }
    return true;
  }
  return false;
}

const GREETING = /^\s*(?:dear|hi|hello|good (?:morning|afternoon))\b/i;
const SIGN_OFF =
  /\b(?:yours sincerely|yours faithfully|yours truly|kind regards|best regards|best wishes|warm regards|sincerely|regards)[,.!]?\s*(?:[A-Z][\w'-]*(?:\s[A-Z][\w'-]*){0,3})?\s*$/i;

const SENTENCE_BREAK = /(?<=[.!?])\s+(?=["'(\p{Lu}\d])/u;
const MAX_SENTENCE_WORDS = 30;

function sentencesOf(text: string): string[] {
  return text.split(SENTENCE_BREAK).filter((sentence) => sentence.trim() !== '');
}

function words(text: string): number {
  return text.split(/\s+/).filter((word) => word !== '').length;
}

function textsOf(
  content: CvContent | TrimmedCvContent,
  citedOf: (refs: readonly string[]) => string,
): Text[] {
  const out: Text[] = [];
  const add = (
    path: string,
    value: string,
    refs: readonly string[],
    part: Part,
    bullet = false,
    noteEdge: Text['noteEdge'] = null,
  ) => out.push({ path, value: plain(value), part, bullet, cited: citedOf(refs), noteEdge });

  if (content.summary !== null)
    add('summary', content.summary.text, content.summary.factRefs, 'cv');
  for (const section of ['experience', 'projects'] as const) {
    content[section].forEach((entry, i) => {
      entry.bullets.forEach((bullet, j) => {
        add(
          `${section}[${String(i)}].bullets[${String(j)}]`,
          bullet.text,
          bullet.factRefs,
          'cv',
          true,
        );
      });
    });
  }
  const paragraphs = content.coverNote.paragraphs;
  paragraphs.forEach((paragraph, i) => {
    add(`coverNote.paragraphs[${String(i)}]`, paragraph.text, paragraph.factRefs, 'note', false, {
      first: i === 0,
      last: i === paragraphs.length - 1,
    });
  });
  return out;
}

/** Whether the pattern matches in the text of a fact the text cites: the fact's own word. */
const ownedByFact = (pattern: RegExp, text: Text): boolean => pattern.test(text.cited);

/** "not managed", "never led", "didn't lead", "without managing": the word is denied, not claimed. */
const NEGATION_BEFORE =
  /(?:\b(?:not|never|no|without|neither|nor|cannot)|n't)\s+(?:(?!(?:only|just|merely|simply)\b)[a-z]+\s+)?$/i;

/** The words of a job's title, lower case ("Product Manager (Graduate Scheme)" has four). */
function titleWords(title: string | undefined): ReadonlySet<string> {
  return new Set(
    title === undefined
      ? []
      : (plain(title)
          .toLowerCase()
          .match(/[\p{L}]+/gu) ?? []),
  );
}

/**
 * Whether the word at `index` is part of the job's title phrase: a title word sitting next to
 * another title word ("Product Manager", "Strategic Partnerships"). A title word on its own is
 * the posting's text, which could be inflated or planted, so it is no excuse ("Strategic
 * thinker").
 */
function inTitlePhrase(value: string, index: number, word: string, title: ReadonlySet<string>) {
  if (!title.has(word.toLowerCase())) return false;
  const before = /([\p{L}]+)[^\p{L}.;!?]*$/u.exec(value.slice(0, index))?.[1];
  const after = /^[^\p{L}.;!?]*([\p{L}]+)/u.exec(value.slice(index + word.length))?.[1];
  return (
    (before !== undefined && title.has(before.toLowerCase())) ||
    (after !== undefined && title.has(after.toLowerCase()))
  );
}

/** Uses of an inflated word that are not a claim of seniority ("led to", "outstanding tickets"). */
const NOT_A_CLAIM_AFTER: readonly RegExp[] = [
  /^(?:led|managed) to\b/i,
  /^outstanding (?:tickets?|issues?|items?)\b/i,
  /^expert (?:interviews?|reviews?)\b/i,
];
/** "a leading retailer": the adjective before a noun, but not "a leading role". */
const LEADING_NOUN = /\ba leading (?!(?:role|position|part|team|voice|figure)\b)[a-z]+/i;

function notAClaim(value: string, index: number): boolean {
  const from = value.slice(index);
  if (NOT_A_CLAIM_AFTER.some((pattern) => pattern.test(from))) return true;
  const around = value.slice(Math.max(0, index - 2));
  return /^a leading\b/i.test(around) && LEADING_NOUN.test(around);
}

/**
 * Whether `pattern` claims something in `value`: a match that is neither part of the job's title
 * phrase ("Product Manager": saying which job it is for is not claiming its seniority), nor
 * denied in the words just before it ("not managed"), nor one of the false friends above.
 * "Managed" is not "manager", so a claim beyond the title is still found.
 */
function claims(pattern: RegExp, value: string, title: ReadonlySet<string>): boolean {
  const every = new RegExp(pattern.source, 'gi');
  for (const match of value.matchAll(every)) {
    if (inTitlePhrase(value, match.index, match[0], title)) continue;
    if (notAClaim(value, match.index)) continue;
    if (!NEGATION_BEFORE.test(value.slice(Math.max(0, match.index - 24), match.index))) return true;
  }
  return false;
}

function check(text: Text, title: ReadonlySet<string>): FindingCode[] {
  const codes = new Set<FindingCode>();
  const value = text.value;

  if (CONTRAST.some((pattern) => pattern.test(value))) codes.add('contrast_pattern');
  if (CLICHE.some((pattern) => pattern.test(value))) codes.add('cliche');

  if (INFLATED.some((pattern) => claims(pattern, value, title) && !ownedByFact(pattern, text))) {
    codes.add('inflated_claim');
  }

  if (
    text.bullet &&
    OPENING_CLAIMS.some(({ open, own }) => open.test(value) && !own.test(text.cited))
  ) {
    codes.add('inflated_claim');
  }

  // Buzzwords: two in one sentence, or a chain of three vague adjectives, is a stack.
  let buzzSingle = false;
  for (const sentence of sentencesOf(value)) {
    const used = BUZZWORDS.filter(
      (pattern) => pattern.test(sentence) && !ownedByFact(pattern, text),
    );
    if (used.length >= 2) codes.add('buzzword_stack');
    else if (used.length === 1) buzzSingle = true;
    if (ADJECTIVE_CHAIN.test(sentence)) codes.add('buzzword_stack');
  }
  if (buzzSingle && !codes.has('buzzword_stack')) codes.add('buzzword');

  if (INTENSIFIER.test(value)) codes.add('intensifier');
  if (text.bullet && WEAK_OPENER.test(value)) codes.add('weak_opener');
  if (text.part === 'cv' && (saysI(value) || FIRST_PERSON_ME.test(value))) {
    codes.add('first_person');
  }
  if (sentencesOf(value).some((sentence) => words(sentence) > MAX_SENTENCE_WORDS)) {
    codes.add('long_sentence');
  }
  if (value.includes('!')) codes.add('exclamation');
  if (text.noteEdge !== null) {
    if (text.noteEdge.first && GREETING.test(value)) codes.add('note_greeting');
    if (text.noteEdge.last && SIGN_OFF.test(value)) codes.add('note_greeting');
  }
  return [...codes];
}

/**
 * The writing findings for `content`, in document order (summary, experience, projects, the
 * cover note). `aliases` is alias → fact ID, as stored on the `cvs` doc; `facts` are the owner's
 * facts, so a word a cited fact uses itself is allowed. Pure; never throws; the findings hold
 * paths and codes only.
 */
export function lintCv(
  content: CvContent | TrimmedCvContent,
  facts: readonly CvFact[],
  aliases: ReadonlyMap<string, string>,
  job: { jobTitle?: string | undefined } = {},
): Finding[] {
  const byId = new Map(facts.map((fact) => [fact.id, fact]));
  const citedOf = (refs: readonly string[]): string =>
    plain(
      [...new Set(refs)]
        .map((ref) => {
          const id = aliases.get(ref);
          const fact = id === undefined ? undefined : byId.get(id);
          return fact === undefined ? '' : `${fact.text}\n${fact.evidence}`;
        })
        .join('\n'),
    );
  const title = titleWords(job.jobTitle);
  const findings: Finding[] = [];
  for (const text of textsOf(content, citedOf)) {
    for (const code of check(text, title)) findings.push(makeFinding(code, text.path));
  }
  return findings;
}
