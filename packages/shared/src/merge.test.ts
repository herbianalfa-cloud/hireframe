import { describe, expect, it } from 'vitest';

import { evidenceKey, jaccard, mergeFacts, normaliseText, type ExistingFact } from './merge.js';
import type { FactDraft } from './profile.js';

const OPTIONS = { similar: 0.6 };

function draft(overrides: Partial<FactDraft> = {}): FactDraft {
  return {
    type: 'experience',
    text: 'Ran onboarding for new B2B clients at Example Ltd',
    evidence: 'Ran onboarding for new B2B clients',
    dates: { start: '2024-01', end: '2025-06' },
    tags: ['onboarding'],
    lanes: ['secondary'],
    ...overrides,
  };
}

/** The same bullet edited in the CV: both the fact and its quote change. */
function reworded12(): FactDraft {
  return draft({
    text: 'Ran onboarding for 12 new B2B clients at Example Ltd',
    evidence: 'Ran onboarding for 12 new B2B clients',
  });
}

function existing(
  id: string,
  overrides: Partial<ExistingFact> = {},
  content = draft(),
): ExistingFact {
  return { id, content, status: 'active', source: 'cv', ...overrides };
}

describe('normaliseText / jaccard', () => {
  it('ignores case, accents, punctuation and spacing', () => {
    expect(normaliseText('  Café — Ran   ONBOARDING!! ')).toBe('cafe ran onboarding');
  });

  it('scores token overlap', () => {
    expect(jaccard('a b c d', 'a b c d')).toBe(1);
    expect(jaccard('a b', 'c d')).toBe(0);
    expect(jaccard('a b c', 'a b d')).toBeCloseTo(0.5);
  });
});

describe('evidenceKey', () => {
  it('agrees across PDF and DOCX extraction noise', () => {
    const docx = evidenceKey({ type: 'skill', evidence: 'Identified “key” self-serve flows' });
    const pdf = evidenceKey({ type: 'skill', evidence: '• Identiﬁed  "key" self-\nserve ﬂows' });
    expect(pdf).toBe(docx);
  });

  it('keeps types apart and is empty without letters or digits', () => {
    expect(evidenceKey({ type: 'skill', evidence: 'SQL' })).not.toBe(
      evidenceKey({ type: 'metric', evidence: 'SQL' }),
    );
    expect(evidenceKey({ type: 'skill', evidence: ' — ' })).toBe('');
  });
});

describe('mergeFacts', () => {
  it('adds every draft when the profile is empty', () => {
    const plan = mergeFacts([], [draft(), draft({ type: 'skill', text: 'SQL' })], OPTIONS);
    expect(plan.add).toHaveLength(2);
    expect(plan).toMatchObject({ unchanged: 0, flag: [], missingFromCv: 0 });
  });

  it('counts an identical re-upload as unchanged: nothing added, nothing flagged', () => {
    const facts = [existing('f1'), existing('f2', {}, draft({ type: 'skill', text: 'SQL' }))];
    const plan = mergeFacts(facts, [draft(), draft({ type: 'skill', text: 'sql.' })], OPTIONS);
    expect(plan).toEqual({
      add: [],
      flag: [],
      unchanged: 2,
      skippedArchived: 0,
      duplicatesInCv: 0,
      missingFromCv: 0,
    });
  });

  it('flags a reworded fact for review and never overwrites it', () => {
    const facts = [existing('f1')];
    const reworded = reworded12();
    const plan = mergeFacts(facts, [reworded], OPTIONS);
    expect(plan.flag).toEqual([{ id: 'f1', proposed: reworded }]);
    expect(plan.add).toEqual([]);
    expect(facts[0]?.content.text).toBe('Ran onboarding for new B2B clients at Example Ltd');
  });

  it('flags the same text with changed dates', () => {
    const plan = mergeFacts(
      [existing('f1')],
      [draft({ dates: { start: '2024-01', end: 'present' } })],
      OPTIONS,
    );
    expect(plan.flag.map((entry) => entry.id)).toEqual(['f1']);
  });

  it('adds a dissimilar fact and does not match across types', () => {
    const facts = [existing('f1')];
    const plan = mergeFacts(
      facts,
      [draft({ type: 'achievement', text: 'Ran onboarding for new B2B clients at Example Ltd' })],
      OPTIONS,
    );
    expect(plan.add).toHaveLength(1);
    expect(plan.missingFromCv).toBe(1);
  });

  it('skips a draft that matches an archived fact instead of reviving it', () => {
    const plan = mergeFacts([existing('f1', { status: 'archived' })], [draft()], OPTIONS);
    expect(plan).toMatchObject({ add: [], flag: [], skippedArchived: 1, missingFromCv: 0 });
  });

  it('prefers an active fact over an archived one with the same text', () => {
    const facts = [existing('old', { status: 'archived' }), existing('new')];
    expect(mergeFacts(facts, [draft()], OPTIONS)).toMatchObject({
      unchanged: 1,
      skippedArchived: 0,
    });
  });

  it('never flags an archived fact for a similar draft; it adds instead', () => {
    const plan = mergeFacts([existing('f1', { status: 'archived' })], [reworded12()], OPTIONS);
    expect(plan.flag).toEqual([]);
    expect(plan.add).toHaveLength(1);
  });

  it('treats a manual fact with the same text as unchanged, so it is not duplicated', () => {
    const plan = mergeFacts([existing('m1', { source: 'manual' })], [draft()], OPTIONS);
    expect(plan).toMatchObject({ add: [], unchanged: 1 });
  });

  it('counts only active CV facts as missing from the new CV', () => {
    const facts = [
      existing('cv', {}, draft({ type: 'skill', text: 'Figma' })),
      existing('manual', { source: 'manual' }, draft({ type: 'skill', text: 'Unity' })),
      existing('archived', { status: 'archived' }, draft({ type: 'skill', text: 'Excel' })),
    ];
    expect(mergeFacts(facts, [], OPTIONS).missingFromCv).toBe(1);
  });

  it('collapses duplicate drafts within one CV', () => {
    const plan = mergeFacts(
      [],
      [draft(), draft({ text: 'ran onboarding for new B2B clients at Example Ltd.' })],
      OPTIONS,
    );
    expect(plan.add).toHaveLength(1);
    expect(plan.duplicatesInCv).toBe(1);
  });

  it('matches each existing fact at most once: exact matches win over similar ones', () => {
    const facts = [existing('f1')];
    const similar = reworded12();
    const plan = mergeFacts(facts, [similar, draft()], OPTIONS);
    expect(plan.unchanged).toBe(1);
    expect(plan.flag).toEqual([]);
    expect(plan.add).toEqual([similar]);
  });
});

/**
 * Two reads of the same fake CV (first the .docx, then the .pdf). The model words every claim
 * differently each time, and PDF extraction adds noise to the quotes: ligatures, curly quotes,
 * dashes, bullets, doubled spaces and words hyphenated across a line break. The CV itself is
 * unchanged, so a re-upload must add nothing and flag nothing.
 */
describe('mergeFacts: the same CV read twice with different wording', () => {
  const job = { start: '2024-01', end: '2025-06' };
  const skills = 'Skills: SQL, Python, Figma, “customer journey” mapping';

  function fact(
    type: FactDraft['type'],
    text: string,
    evidence: string,
    dates: FactDraft['dates'] = {},
  ): FactDraft {
    return { type, text, evidence, dates, tags: [], lanes: [] };
  }

  const docxRole = fact(
    'experience',
    'Customer Success Associate at Example Ltd',
    'Customer Success Associate, Example Ltd',
    job,
  );
  const docxAvailable = fact(
    'constraint',
    'Available to start immediately',
    'Available to start immediately',
  );
  const pdfAvailable = fact(
    'constraint',
    'Can start straight away',
    'Available to start immediately',
  );

  const docxRead: FactDraft[] = [
    docxRole,
    fact(
      'achievement',
      'Cut client onboarding from 6 weeks to 3',
      'Cut client onboarding from 6 weeks to 3 weeks by rebuilding the kick-off playbook',
      job,
    ),
    fact(
      'metric',
      'Onboarding time reduced by 50%',
      'Cut client onboarding from 6 weeks to 3 weeks by rebuilding the kick-off playbook',
      job,
    ),
    fact(
      'experience',
      'Rebuilt the client kick-off playbook',
      'Cut client onboarding from 6 weeks to 3 weeks by rebuilding the kick-off playbook',
      job,
    ),
    fact('skill', 'SQL', skills),
    fact('skill', 'Python', skills),
    fact('skill', 'Figma', skills),
    fact('skill', 'Customer journey mapping', skills),
    fact(
      'education',
      'BSc Computer Science, University of Example',
      'BSc Computer Science — University of Example',
      { start: '2020', end: '2023' },
    ),
    fact(
      'project',
      'Built a churn dashboard in Looker Studio for 40 accounts',
      'Built a churn-risk dashboard in Looker Studio covering 40 accounts',
    ),
    fact(
      'achievement',
      'Identified 30 upsell opportunities worth £45k',
      'Identified 30 upsell opportunities worth £45k in the first year',
      job,
    ),
    fact(
      'metric',
      'Resolved 95% of tickets within SLA',
      'Resolved 95% of tickets within SLA across a 120-account book',
      job,
    ),
    fact(
      'metric',
      'Managed a book of 120 accounts',
      'Resolved 95% of tickets within SLA across a 120-account book',
      job,
    ),
    docxAvailable,
  ];

  const pdfSkills = 'Skills:  SQL, Python, Figma, "customer journey" mapping';
  const pdfRead: FactDraft[] = [
    fact(
      'experience',
      'Worked as a Customer Success Associate for Example Ltd',
      'Customer Success Associate,  Example Ltd',
      job,
    ),
    fact(
      'achievement',
      'Halved client onboarding time from six weeks to three',
      'Cut client onboarding from 6 weeks to 3 weeks by rebuilding the kick-\noff playbook',
      job,
    ),
    fact(
      'metric',
      '50% reduction in onboarding time',
      'Cut client onboarding from 6 weeks to 3 weeks by rebuilding the kick-\noff playbook',
      job,
    ),
    fact(
      'experience',
      'Redesigned the kick-off playbook for new clients',
      'Cut client onboarding from 6 weeks to 3 weeks by rebuilding the kick-\noff playbook',
      job,
    ),
    fact('skill', 'SQL querying', pdfSkills),
    fact('skill', 'Python scripting', pdfSkills),
    fact('skill', 'Figma prototyping', pdfSkills),
    fact('skill', 'Mapping customer journeys', pdfSkills),
    fact(
      'education',
      'Computer Science BSc from the University of Example',
      'BSc Computer Science – University of Example',
      { start: '2020', end: '2023' },
    ),
    fact(
      'project',
      'Created a Looker Studio churn-risk dashboard',
      'Built a churn‐risk dashboard in Looker Studio covering 40 accounts',
    ),
    fact(
      'achievement',
      'Found 30 upsell opportunities (£45k)',
      'Identiﬁed 30 upsell opportunities worth £45k in the ﬁrst year',
      job,
    ),
    fact(
      'metric',
      '95% of tickets resolved inside the SLA',
      '• Resolved 95% of tickets within SLA across a 120-account book',
      job,
    ),
    fact(
      'metric',
      'Looked after 120 accounts',
      '• Resolved 95% of tickets within SLA across a 120-account book',
      job,
    ),
    pdfAvailable,
  ];

  function profileFrom(drafts: readonly FactDraft[]): ExistingFact[] {
    return drafts.map((content, index) => existing(`f${String(index + 1)}`, {}, content));
  }

  it('adds nothing and flags nothing on a re-upload with new wording', () => {
    const plan = mergeFacts(profileFrom(docxRead), pdfRead, OPTIONS);
    expect(plan).toEqual({
      add: [],
      flag: [],
      unchanged: docxRead.length,
      skippedArchived: 0,
      duplicatesInCv: 0,
      missingFromCv: 0,
    });
  });

  it('is stable in the other direction too', () => {
    const plan = mergeFacts(profileFrom(pdfRead), docxRead, OPTIONS);
    expect(plan).toMatchObject({ add: [], flag: [], unchanged: pdfRead.length });
  });

  it('still flags the one bullet that really changed', () => {
    const changed = fact(
      'project',
      'Built a churn dashboard in Looker Studio for 60 accounts',
      'Built a churn-risk dashboard in Looker Studio covering 60 accounts',
    );
    const reread = pdfRead.map((draft) => (draft.type === 'project' ? changed : draft));
    const plan = mergeFacts(profileFrom(docxRead), reread, OPTIONS);
    expect(plan.add).toEqual([]);
    expect(plan.flag).toEqual([{ id: 'f10', proposed: changed }]);
    expect(plan.unchanged).toBe(docxRead.length - 1);
  });

  it('matches facts that share one quote to the closest wording', () => {
    const plan = mergeFacts(
      profileFrom(docxRead),
      [fact('skill', 'Figma prototyping', pdfSkills), fact('skill', 'SQL querying', pdfSkills)],
      OPTIONS,
    );
    expect(plan).toMatchObject({ add: [], flag: [], unchanged: 2 });
  });

  it('leaves an ambiguous shared quote to the similarity step', () => {
    // Neither draft shares a word with either fact behind the quote, so neither can be paired.
    const facts = profileFrom([fact('skill', 'SQL', skills), fact('skill', 'Python', skills)]);
    const plan = mergeFacts(facts, [fact('skill', 'Databases', pdfSkills)], OPTIONS);
    expect(plan.add).toHaveLength(1);
    expect(plan.unchanged).toBe(0);
  });

  it('pairs the last unmatched fact behind a quote even with no shared words', () => {
    const facts = profileFrom([
      fact('constraint', 'Available to start immediately', 'Available to start immediately'),
    ]);
    const plan = mergeFacts(
      facts,
      [fact('constraint', 'Can start straight away', 'Available to start immediately')],
      OPTIONS,
    );
    expect(plan).toMatchObject({ add: [], flag: [], unchanged: 1 });
  });

  it('flags a change of dates behind the same quote', () => {
    const facts = profileFrom([docxRole]);
    const moved = fact(
      'experience',
      'Worked as a Customer Success Associate for Example Ltd',
      'Customer Success Associate, Example Ltd',
      { start: '2024-01', end: 'present' },
    );
    const plan = mergeFacts(facts, [moved], OPTIONS);
    expect(plan.flag).toEqual([{ id: 'f1', proposed: moved }]);
  });

  it('does not re-add an archived fact under new wording', () => {
    const facts = [existing('f1', { status: 'archived' }, docxAvailable)];
    const plan = mergeFacts(facts, [pdfAvailable], OPTIONS);
    expect(plan).toMatchObject({ add: [], flag: [], skippedArchived: 1 });
  });

  it('prefers the active fact when an archived one has the same quote', () => {
    const constraint = docxAvailable;
    const facts = [
      existing('old', { status: 'archived' }, constraint),
      existing('new', {}, constraint),
    ];
    const plan = mergeFacts(facts, [pdfAvailable], OPTIONS);
    expect(plan).toMatchObject({ add: [], unchanged: 1, skippedArchived: 0 });
  });

  it('skips the archived claim of a split bullet instead of pairing it with an active one', () => {
    const facts = [
      existing('sql', {}, fact('skill', 'SQL', skills)),
      existing('python', { status: 'archived' }, fact('skill', 'Python', skills)),
    ];
    const plan = mergeFacts(
      facts,
      [fact('skill', 'Python scripting', pdfSkills), fact('skill', 'SQL querying', pdfSkills)],
      OPTIONS,
    );
    expect(plan).toMatchObject({ add: [], flag: [], unchanged: 1, skippedArchived: 1 });
  });

  it('never groups quotes with no letters or digits', () => {
    const facts = profileFrom([fact('skill', 'SQL', '—')]);
    const plan = mergeFacts(facts, [fact('skill', 'Spreadsheets', '–')], OPTIONS);
    expect(plan.add).toHaveLength(1);
  });

  it('matches each fact at most once when a CV repeats a quote', () => {
    const facts = profileFrom([docxAvailable]);
    const twice = [
      pdfAvailable,
      fact('constraint', 'Free to start now', 'Available to start immediately'),
    ];
    const plan = mergeFacts(facts, twice, OPTIONS);
    expect(plan.unchanged).toBe(1);
    expect(plan.add).toHaveLength(1);
  });
});
