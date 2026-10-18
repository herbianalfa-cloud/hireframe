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
  new RegExp(String.raw`\bless\b[^.;!?,]{1,40},\s*more\b`, 'i'),
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

const INTENSIFIER =
  /\b(?:successfully|effectively|significantly|substantially|dramatically|remarkably|tremendously|extremely|highly|greatly|truly|really)\b/i;

const WEAK_OPENER =
  /^\s*(?:responsible for|worked on|tasked with|helped to|helped with|assisted with|duties included|in charge of)\b/i;

const FIRST_PERSON = /\b(?:I|I'm|I've|I'd|I'll|me|my|myself)\b/;

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
const NEGATION_BEFORE = /(?:\b(?:not|never|no|without|neither|nor|cannot)|n't)\s+(?:[a-z]+\s+)?$/i;

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
 * Whether `pattern` claims something in `value`: a match that is neither a word of the job's
 * title ("Product Manager": saying which job it is for is not claiming its seniority) nor
 * denied in the words just before it ("not managed"). "Managed" is not "manager", so a claim
 * beyond the title is still found.
 */
function claims(pattern: RegExp, value: string, title: ReadonlySet<string>): boolean {
  const every = new RegExp(pattern.source, 'gi');
  for (const match of value.matchAll(every)) {
    if (title.has(match[0].toLowerCase())) continue;
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
  if (text.part === 'cv' && FIRST_PERSON.test(value)) codes.add('first_person');
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
