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

export function fakeCvWrite(system: string): CvContent {
  const facts = promptedFacts(system);
  const first = facts[0];
  if (!first) throw new Error('fakeCvWrite: no facts in the prompt');
  const ofType = (type: string) => facts.filter((fact) => fact.type === type);
  const clip = (text: string, max: number) => text.slice(0, max).trim();

  const heading =
    ofType('experience').find((fact) => fact.text.includes(' at ')) ?? ofType('experience')[0];
  const [role, org] = heading?.text.split(' at ') ?? [];
  const bulletFacts = facts
    .filter(
      (fact) =>
        fact !== heading && BULLET_TYPES.has(fact.type) && fact.text.length <= CV_LIMITS.bullet,
    )
    .slice(0, 3);
  const bullets = bulletFacts.map((fact) => ({ text: fact.text, factRefs: [fact.alias] }));
  const project = ofType('project')[0];
  const education = ofType('education')[0];
  const summaryFact = ofType('metric')[0] ?? heading ?? first;
  const noteTexts = [heading, summaryFact, ...bulletFacts]
    .filter((fact): fact is PromptedFact => fact !== undefined)
    .filter((fact, index, all) => all.indexOf(fact) === index)
    .slice(0, 2);

  return {
    summary: { text: clip(summaryFact.text, CV_LIMITS.summary), factRefs: [summaryFact.alias] },
    experience: heading
      ? [
          {
            heading: {
              role: clip(role ?? heading.text, CV_LIMITS.role),
              org: clip(org ?? heading.text, CV_LIMITS.org),
              factRef: heading.alias,
            },
            bullets,
          },
        ]
      : [],
    projects: project
      ? [
          {
            heading: {
              role: clip(project.text, CV_LIMITS.role),
              org: clip(project.text, CV_LIMITS.org),
              factRef: project.alias,
            },
            bullets: [{ text: clip(project.text, CV_LIMITS.bullet), factRefs: [project.alias] }],
          },
        ]
      : [],
    education: education
      ? [{ line: clip(education.text, CV_LIMITS.educationLine), factRef: education.alias }]
      : [],
    skills: ofType('skill')
      .slice(0, 8)
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
