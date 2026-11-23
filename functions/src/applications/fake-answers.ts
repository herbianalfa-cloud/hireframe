import { CV_LIMITS, type CvContent } from '@hireframe/shared';

/**
 * A deterministic `cvWrite` answer for the emulator's fake transport (ADR-017) and the worker's
 * tests: it reads the facts block of the system prompt (`[F12] type: text (dates)`) and writes a
 * CV that passes `validateCv`, by quoting facts word for word and citing each one. No model, no
 * network, and nothing of the posting is used, so an injected posting changes nothing.
 */

interface PromptedFact {
  alias: string;
  type: string;
  text: string;
}

/** Dates the prompt appends to a fact line: `(Oct 2023 – May 2024)`, `(2024)` or `(Present)`. */
const DATES_SUFFIX =
  /\s\((?:(?:[A-Z][a-z]{2} )?\d{4}(?: – (?:Present|(?:[A-Z][a-z]{2} )?\d{4}))?|Present)\)$/;

function promptedFacts(system: string): PromptedFact[] {
  return [...system.matchAll(/^\[(F\d+)\] (\w+): (.*)$/gm)].map((match) => ({
    alias: match[1] ?? 'F1',
    type: match[2] ?? '',
    text: (match[3] ?? '').replace(DATES_SUFFIX, ''),
  }));
}

const BULLET_TYPES = new Set(['experience', 'achievement', 'metric']);

/** How much a fake CV carries: enough to fill a page (the length target, CV_BULLET_BUDGET). */
const FAKE_SHAPE = { entries: 3, bulletsPerEntry: 3, projects: 3, education: 2, skills: 12 };

/**
 * A CV that fills a page: up to three experience entries of three bullets and three projects,
 * every bullet quoting a fact. With fewer facts than bullets a fact is quoted again in another
 * entry (never twice in one), so a thin fake profile still writes a full CV.
 */
export function fakeCvWrite(system: string): CvContent {
  const facts = promptedFacts(system);
  const first = facts[0];
  if (!first) throw new Error('fakeCvWrite: no facts in the prompt');
  const ofType = (type: string) => facts.filter((fact) => fact.type === type);
  const clip = (text: string, max: number) => text.slice(0, max).trim();

  const experience = ofType('experience');
  const headings = [
    ...experience.filter((fact) => fact.text.includes(' at ')),
    ...experience.filter((fact) => !fact.text.includes(' at ')),
  ].slice(0, FAKE_SHAPE.entries);
  const bulletFacts = facts.filter(
    (fact) =>
      !headings.includes(fact) &&
      BULLET_TYPES.has(fact.type) &&
      fact.text.length <= CV_LIMITS.bullet,
  );
  const summaryFact = ofType('metric')[0] ?? headings[0] ?? first;
  const noteTexts = [headings[0], summaryFact, ...bulletFacts]
    .filter((fact): fact is PromptedFact => fact !== undefined)
    .filter((fact, index, all) => all.indexOf(fact) === index)
    .slice(0, 2);

  const perEntry = Math.min(FAKE_SHAPE.bulletsPerEntry, bulletFacts.length);
  const experienceEntries = headings.map((heading, entry) => {
    const [role, org] = heading.text.split(' at ');
    const bullets = Array.from({ length: perEntry }, (_, i) => {
      const fact = bulletFacts[(entry * perEntry + i) % bulletFacts.length] ?? first;
      return { text: fact.text, factRefs: [fact.alias] };
    });
    return {
      heading: {
        role: clip(role ?? heading.text, CV_LIMITS.role),
        org: clip(org ?? heading.text, CV_LIMITS.org),
        factRef: heading.alias,
      },
      // An entry needs a bullet: a thin profile quotes its heading.
      bullets: bullets.length > 0 ? bullets : [{ text: heading.text, factRefs: [heading.alias] }],
    };
  });

  return {
    summary: { text: clip(summaryFact.text, CV_LIMITS.summary), factRefs: [summaryFact.alias] },
    experience: experienceEntries,
    projects: ofType('project')
      .slice(0, FAKE_SHAPE.projects)
      .map((project) => ({
        heading: {
          role: clip(project.text, CV_LIMITS.role),
          org: clip(project.text, CV_LIMITS.org),
          factRef: project.alias,
        },
        bullets: [{ text: clip(project.text, CV_LIMITS.bullet), factRefs: [project.alias] }],
      })),
    education: ofType('education')
      .slice(0, FAKE_SHAPE.education)
      .map((fact) => ({ line: clip(fact.text, CV_LIMITS.educationLine), factRef: fact.alias })),
    skills: ofType('skill')
      .slice(0, FAKE_SHAPE.skills)
      .map((fact) => ({ label: clip(fact.text, CV_LIMITS.skillLabel), factRefs: [fact.alias] })),
    coverNote: {
      paragraphs: [
        ...noteTexts.map((fact) => ({
          text: clip(fact.text, CV_LIMITS.noteParagraph),
          factRefs: [fact.alias],
        })),
        // The note needs two paragraphs at least; repeat the first fact when only one exists.
        ...(noteTexts.length < 2
          ? [{ text: clip(first.text, CV_LIMITS.noteParagraph), factRefs: [first.alias] }]
          : []),
      ],
    },
  };
}

/**
 * A `cvRevise` answer: the draft the request carries, unchanged. The fake model has nothing to
 * improve, so a below-target fake CV is revised into itself (and the draft ships, a tie).
 */
export function fakeCvRevise(user: string): CvContent {
  const body = /<draft_cv>\n([\s\S]*?)\n<\/draft_cv>/.exec(user)?.[1];
  if (body === undefined) throw new Error('fakeCvRevise: no <draft_cv> in the prompt');
  return JSON.parse(body) as CvContent;
}
