import { describe, expect, it } from 'vitest';

import type { CvContent } from './cv.js';
import { FINDING_CODES, FINDING_INFO, findingLabel } from './cv-findings.js';
import { lintCv } from './cv-lint.js';
import { aliasOf, CV_ALIASES, CV_FACTS, validCv } from './fixtures/cv.js';

const lint = (content: CvContent) => lintCv(content, CV_FACTS, CV_ALIASES);

/** The valid CV with one bullet's text (citing `fact-articles`, which has no leadership words). */
function withBullet(text: string, fact = 'fact-articles'): CvContent {
  const cv = structuredClone(validCv());
  const entry = cv.experience[0];
  if (entry === undefined) throw new Error('fixture');
  entry.bullets = [{ text, factRefs: [aliasOf(fact)] }];
  return cv;
}

const BULLET = 'experience[0].bullets[0]';

function codesOf(text: string, fact?: string): string[] {
  return lint(withBullet(text, fact))
    .filter((finding) => finding.path === BULLET)
    .map((finding) => finding.code);
}

function withNote(paragraphs: string[]): CvContent {
  const cv = structuredClone(validCv());
  cv.coverNote.paragraphs = paragraphs.map((text) => ({
    text,
    factRefs: [aliasOf('fact-clients')],
  }));
  return cv;
}

describe('lintCv on the valid fixture', () => {
  it('finds nothing in the valid CV, including a fact-backed "Led"', () => {
    expect(lint(validCv())).toEqual([]);
  });

  it('reads a trimmed CV with no summary', () => {
    const cv = { ...validCv(), summary: null };
    expect(lintCv(cv, CV_FACTS, CV_ALIASES)).toEqual([]);
  });
});

describe('contrast_pattern (hard)', () => {
  it.each([
    'Not just a tidy dataset, but a clear story for the team.',
    'It was not only faster but also easier to read.',
    "This isn't about reports, it's about decisions.",
    "It's not a spreadsheet. It's a way of working.",
    'Built a tool that is not a dashboard, but a habit.',
    'Wrote less code, more tests.',
    'Not merely cleaned data; it is the base for every report.',
    'It’s not the tooling. It’s the habit.',
    "Good onboarding isn't paperwork, it's trust.",
    'Built the dashboard not for show but for weekly decisions.',
    "It wasn't luck. It was a weekly check.",
    'The goal was not speed, it was accuracy.',
    'Not speed but accuracy.',
    "The report wasn't a summary; it was a plan.",
  ])('flags: %s', (text) => {
    expect(codesOf(text)).toContain('contrast_pattern');
  });

  it.each([
    'Did not exceed the budget in any month.',
    'Wrote 25 help-centre articles, but none went out of date.',
    'Not applicable to the role.',
    'Tested the form and fixed the bugs found.',
    'Wrote less than a page for each report.',
    'Cut setup to less than 2 weeks, more than halving it.',
    'The report was not late, and the team read it.',
    'Did not exceed the budget in any month but the first.',
    'It was not clear who owned the rota, so I asked.',
    'Wrote a lot, but not all of it shipped.',
  ])('does not flag: %s', (text) => {
    expect(codesOf(text)).not.toContain('contrast_pattern');
  });

  it('is hard and fixable', () => {
    const finding = lint(withBullet('Not just a report, but a plan.')).find(
      (item) => item.code === 'contrast_pattern',
    );
    expect(finding).toMatchObject({ path: BULLET, severity: 'hard', fixable: true });
  });
});

describe('cliche (hard)', () => {
  it.each([
    'Passionate about customer success.',
    'A proven track record of onboarding clients.',
    'Results-driven analyst.',
    'A team player who writes clear notes.',
    'Used to a fast-paced environment.',
    'Ready to hit the ground running.',
  ])('flags: %s', (text) => {
    expect(codesOf(text)).toContain('cliche');
  });

  it('flags "I am writing to apply" in the note', () => {
    const cv = withNote([
      'I am writing to apply for the role.',
      'I led onboarding for 12 clients.',
    ]);
    expect(lint(cv).map((f) => f.code)).toContain('cliche');
  });

  it('does not flag plain wording', () => {
    expect(codesOf('Wrote 25 help-centre articles for the setup flow.')).toEqual([]);
    expect(codesOf('Worked in a team of four on the setup flow.')).toEqual([]);
  });
});

describe('buzzword_stack (hard) and buzzword (soft)', () => {
  it('flags two buzzwords in one sentence', () => {
    expect(codesOf('Leveraged innovative tooling for reports.')).toContain('buzzword_stack');
    expect(codesOf('Leveraged innovative tooling for reports.')).not.toContain('buzzword');
  });

  it('flags a chain of three vague adjectives', () => {
    expect(codesOf('A motivated, dedicated and proactive analyst.')).toContain('buzzword_stack');
    expect(codesOf('Dependable, versatile, resourceful.')).toContain('buzzword_stack');
  });

  it('flags one buzzword as soft', () => {
    expect(codesOf('Leveraged SQL to write reports.')).toEqual(['buzzword']);
    expect(lint(withBullet('Leveraged SQL to write reports.'))[0]).toMatchObject({
      severity: 'soft',
    });
  });

  it('counts buzzwords per sentence, not per text', () => {
    expect(codesOf('Leveraged SQL for reports. Used dynamic filters in them.')).toEqual([
      'buzzword',
    ]);
  });

  it('allows a buzzword a cited fact uses itself', () => {
    const cv = withBullet('Built dynamic filters in SQL.', 'fact-sql');
    const facts = CV_FACTS.map((fact) =>
      fact.id === 'fact-sql' ? { ...fact, text: 'Dynamic SQL', evidence: 'Dynamic SQL' } : fact,
    );
    expect(lintCv(cv, facts, CV_ALIASES).filter((f) => f.path === BULLET)).toEqual([]);
    expect(codesOf('Built dynamic filters in SQL.', 'fact-sql')).toEqual(['buzzword']);
  });

  it('does not flag two adjectives or ordinary words', () => {
    expect(codesOf('A reliable and organised analyst.')).toEqual([]);
  });
});

describe('inflated_claim (hard)', () => {
  it.each([
    'Spearheaded the help-centre rewrite.',
    'Pioneered a new setup flow.',
    'Orchestrated 25 help-centre articles.',
    'Architected the setup flow.',
    'Championed clear writing.',
    'An expert in setup flows.',
    'Seasoned analyst with extensive reporting experience.',
    'World-class documentation.',
    'Led the help-centre rewrite.',
    'Managed 25 help-centre articles.',
    'Oversaw the setup flow.',
    'Strategic planning for documentation.',
  ])('flags when no cited fact has the word: %s', (text) => {
    expect(codesOf(text)).toContain('inflated_claim');
  });

  it('allows the word when a cited fact has the same stem', () => {
    // fact-clients says "Led onboarding for 12 clients".
    expect(codesOf('Led onboarding for 12 clients.', 'fact-clients')).toEqual([]);
    expect(codesOf('Led onboarding for 12 clients.')).toContain('inflated_claim');
  });

  it('does not take a different word of the same fact', () => {
    expect(codesOf('Managed onboarding for 12 clients.', 'fact-clients')).toContain(
      'inflated_claim',
    );
  });

  it.each([
    'Misled readers were corrected.',
    'Wrote the lead paragraph of each article.',
    'Edited a model of the flow.',
  ])('does not flag a lookalike: %s', (text) => {
    expect(codesOf(text)).not.toContain('inflated_claim');
  });
});

describe('inflated_claim ignores the job title and denied uses', () => {
  const codesWith = (text: string, jobTitle?: string, fact?: string): string[] =>
    lintCv(withBullet(text, fact), CV_FACTS, CV_ALIASES, { jobTitle })
      .filter((finding) => finding.path === BULLET)
      .map((finding) => finding.code);

  it("ignores a word inside the job's title phrase", () => {
    const text = 'Applying for the Product Manager role with SQL.';
    expect(codesWith(text)).toContain('inflated_claim');
    expect(codesWith(text, 'Product Manager')).not.toContain('inflated_claim');
    expect(codesWith(text, 'Associate Product Manager')).not.toContain('inflated_claim');
    expect(codesWith(text, 'Product Manager (Graduate Scheme)')).not.toContain('inflated_claim');
    expect(codesWith(text, 'Graduate Scheme, Product Manager - London')).not.toContain(
      'inflated_claim',
    );
    expect(codesWith('Applying for the product MANAGER role.', 'Product Manager')).toEqual([]);
  });

  it('exempts a title word only next to another title word (L7)', () => {
    const title = 'Strategic Partnerships Associate';
    expect(codesWith('Strategic thinker who ran onboarding for 12 clients.', title)).toContain(
      'inflated_claim',
    );
    expect(
      codesWith('Applying for the Strategic Partnerships Associate role.', title),
    ).not.toContain('inflated_claim');
    // A title of one inflated word excuses nothing, and neither does a lone word of a longer one.
    expect(codesWith('Expert in setup flows.', 'Expert')).toContain('inflated_claim');
    expect(codesWith('A manager of rotas.', 'Associate Product Manager')).toContain(
      'inflated_claim',
    );
  });

  it('still flags the word outside the title phrase', () => {
    expect(codesWith('Managed a team of 4 analysts.', 'Product Manager')).toContain(
      'inflated_claim',
    );
    // The title is in the text, and so is a claim beyond it.
    expect(codesWith('Product Manager role: managed a team of 4.', 'Product Manager')).toContain(
      'inflated_claim',
    );
    // A different title does not excuse the word.
    expect(codesWith('Applying for the Product Manager role.', 'Data Analyst')).toContain(
      'inflated_claim',
    );
    // Whole words only: a title of "Lead" does not excuse "led".
    expect(codesWith('Led the rewrite.', 'Lead')).toContain('inflated_claim');
  });

  it('exempts only the exact title word, with no stemming', () => {
    const title = 'Associate Product Manager';
    expect(codesWith('Applying for the Product Manager role.', title)).not.toContain(
      'inflated_claim',
    );
    expect(codesWith('Applying for the PRODUCT MANAGER role.', title)).not.toContain(
      'inflated_claim',
    );
    expect(codesWith('Managed a team of 4 analysts.', title)).toContain('inflated_claim');
    expect(codesWith('Led the team through the rewrite.', title)).toContain('inflated_claim');
    // Other forms of the title's word are claims, not the title.
    expect(codesWith('Took on management of the rota.', title)).toContain('inflated_claim');
    expect(codesWith('Managing the rota.', title)).toContain('inflated_claim');
  });

  it.each([
    'I have not managed a team.',
    'Never led a project on my own.',
    'Did not oversee any budget.',
    "I haven't managed people.",
    'Worked without managing anyone.',
    'No leadership experience yet.',
    'Was not the leader of the team.',
  ])('allows a denied use: %s', (text) => {
    expect(codesWith(text)).not.toContain('inflated_claim');
  });

  it.each([
    'Managed a team of 4 analysts.',
    'I managed a team, not just a project.',
    'Led a team and never missed a deadline.',
    'Not only wrote the guides but led the rewrite.',
  ])('still flags a claim: %s', (text) => {
    expect(codesWith(text)).toContain('inflated_claim');
  });

  it.each([
    'Not only wrote the guides, also led the rewrite.',
    'Not just led onboarding for 12 clients, also wrote guides.',
    'Not merely managed the rota.',
  ])('does not read "not only/just/merely" as a denial: %s', (text) => {
    expect(codesWith(text)).toContain('inflated_claim');
  });

  it.each([
    'Lead weekly onboarding calls for 12 clients.',
    'Leads the weekly onboarding calls.',
    'Manage the onboarding queue.',
    'Manages the onboarding queue.',
    'Oversees setup for new clients.',
  ])('flags a present-tense claim as the opening verb (M5): %s', (text) => {
    expect(codesWith(text)).toContain('inflated_claim');
  });

  it.each([
    'Wrote the lead paragraph of each article.',
    'Cut lead time for setup from 5 to 2 days.',
    'Lead time for setup fell to 2 days.',
    'Wrote guides on how a team manages onboarding.',
    'Wrote the guide for people who manage rotas.',
  ])('does not flag lead, manage or oversees away from the opening verb: %s', (text) => {
    expect(codesWith(text)).not.toContain('inflated_claim');
  });

  it('lets a cited fact own a present-tense opening verb', () => {
    // fact-clients says "Led onboarding for 12 clients".
    expect(codesWith('Lead onboarding for 12 clients.', 'Data Analyst', 'fact-clients')).toEqual(
      [],
    );
  });

  it.each([
    'Wrote guides which led to fewer tickets.',
    'Managed to cut setup time by half.',
    'Cleared outstanding tickets each week.',
    'Closed outstanding issues from the backlog.',
    'Example is a leading retailer of garden tools.',
    'Ran expert interviews with five users.',
    'Did an expert review of the help centre.',
  ])('does not flag a false friend (L1): %s', (text) => {
    expect(codesWith(text)).not.toContain('inflated_claim');
  });

  it('still flags the real uses beside the false friends', () => {
    expect(codesWith('Led the rewrite, which led to fewer tickets.')).toContain('inflated_claim');
    expect(codesWith('Took a leading role in the rewrite.')).toContain('inflated_claim');
    expect(codesWith('An expert in setup flows.')).toContain('inflated_claim');
    expect(codesWith('Outstanding results.')).toContain('inflated_claim');
  });

  it('flags a denied use next to a real one in the same text', () => {
    expect(codesWith('Never led a team, but managed a rota.')).toContain('inflated_claim');
  });

  it('keeps the fact-owned word allowed whatever the title', () => {
    expect(codesWith('Led onboarding for 12 clients.', 'Data Analyst', 'fact-clients')).toEqual([]);
  });
});

describe('soft findings', () => {
  it.each([
    ['intensifier', 'Successfully wrote 25 help-centre articles.'],
    ['intensifier', 'Wrote articles that significantly cut tickets.'],
    ['weak_opener', 'Responsible for the help-centre articles.'],
    ['weak_opener', 'Worked on the setup flow.'],
    ['weak_opener', 'Tasked with writing articles.'],
    ['weak_opener', 'Helped to write articles.'],
    ['first_person', 'I wrote 25 help-centre articles.'],
    ['first_person', 'Wrote articles for my team.'],
    ['first_person', 'My onboarding work covered 12 clients.'],
    ['first_person', 'Wrote the guides for ME and the team.'],
    ['first_person', 'Then I wrote 25 help-centre articles.'],
    ['exclamation', 'Wrote 25 help-centre articles!'],
    [
      'long_sentence',
      'Wrote help-centre articles for the setup flow and then reviewed them with the support team and the product owner and rewrote them again after feedback from three customers and two colleagues.',
    ],
  ])('%s: %s', (code, text) => {
    const found = lint(withBullet(text)).filter((f) => f.path === BULLET);
    expect(found.map((f) => f.code)).toContain(code);
    expect(found.find((f) => f.code === code)).toMatchObject({ severity: 'soft', fixable: true });
  });

  it.each([
    'Wrote 25 help-centre articles for the setup flow.',
    'Worked with the support team on the setup flow.',
    'Edited the highlights of each article.',
    'Wrote a short summary. Added a second one for the setup flow.',
    'Ran Phase I onboarding for the new clients.',
    'Wrote Part I of the guide.',
  ])('is quiet on: %s', (text) => {
    expect(codesOf(text)).toEqual([]);
  });

  it('allows first person in the cover note and not in the summary', () => {
    expect(lint(withNote(['I would like to apply.', 'I led onboarding for 12 clients.']))).toEqual(
      [],
    );
    const cv = structuredClone(validCv());
    cv.summary = { text: 'I am an analyst who writes clearly.', factRefs: [aliasOf('fact-ttl')] };
    expect(lint(cv)).toEqual([
      { code: 'first_person', path: 'summary', severity: 'soft', fixable: true },
    ]);
  });

  it('flags a greeting at the top and a sign-off at the end of the note, not elsewhere', () => {
    const greeted = lint(
      withNote(['Dear hiring team, I would like to apply.', 'I led onboarding.']),
    );
    expect(greeted).toEqual([
      { code: 'note_greeting', path: 'coverNote.paragraphs[0]', severity: 'soft', fixable: true },
    ]);
    const signed = lint(
      withNote(['I would like to apply.', 'I led onboarding. Kind regards, Alex Example']),
    );
    expect(signed.map((f) => f.code)).toEqual(['note_greeting']);
    expect(
      lint(
        withNote([
          'I would like to apply.',
          'I led onboarding and send my regards to the team lead.',
        ]),
      ).filter((f) => f.code === 'note_greeting'),
    ).toEqual([]);
  });

  it('checks sentence length in the note too', () => {
    const long = `${Array.from({ length: 32 }, () => 'word').join(' ')}.`;
    expect(lint(withNote(['I would like to apply.', long])).map((f) => f.code)).toEqual([
      'long_sentence',
    ]);
  });
});

describe('findings', () => {
  it('never hold the text they found', () => {
    const marker = 'Zqxjv';
    const cv = withBullet(`Spearheaded ${marker} not just for me, but for all! Successfully.`);
    const findings = lint(cv);
    expect(findings.length).toBeGreaterThan(2);
    expect(JSON.stringify(findings)).not.toContain(marker);
    expect(Object.keys(findings[0] ?? {}).sort()).toEqual(['code', 'fixable', 'path', 'severity']);
  });

  it('are listed once per code and place, in document order', () => {
    const cv = withBullet('Successfully and effectively wrote articles.');
    expect(lint(cv).filter((f) => f.code === 'intensifier')).toHaveLength(1);
    const two = structuredClone(cv);
    two.summary = { text: 'Successfully cut tickets by 30%.', factRefs: [aliasOf('fact-ttl')] };
    expect(lint(two).map((f) => f.path)).toEqual(['summary', BULLET]);
  });

  it('are not changed by curly quotes or the case of the text', () => {
    expect(codesOf('IT’S NOT A SPREADSHEET. IT’S A WAY OF WORKING.')).toContain('contrast_pattern');
  });
});

describe('cv-findings', () => {
  it('gives every code a severity, a label in words and a fixed guidance line', () => {
    for (const code of FINDING_CODES) {
      const info = FINDING_INFO[code];
      expect(['hard', 'soft']).toContain(info.severity);
      expect(findingLabel(code)).toBe(info.label);
      expect(info.label.length).toBeGreaterThan(10);
      expect(info.guidance.length).toBeGreaterThan(10);
    }
  });

  it('has the four hard codes the plan names', () => {
    expect(FINDING_CODES.filter((code) => FINDING_INFO[code].severity === 'hard')).toEqual([
      'contrast_pattern',
      'buzzword_stack',
      'inflated_claim',
      'cliche',
    ]);
  });
});
