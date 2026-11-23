import { CvContentShapeSchema, factAliases, scoreCv, type CvFact } from '@hireframe/shared';
import { describe, expect, it } from 'vitest';

import { CV_FACTS } from '../../../packages/shared/src/fixtures/cv.js';
import { MODELS } from '../config.js';
import { FAKE_HEADER } from '../cv/render/fixtures.js';
import * as render from '../cv/render/index.js';
import { FAKE_CV_EXTRACTION } from '../fixtures/fake-cv-response.js';
import { fakeTransport } from '../llm/fake-transport.js';
import { fakeCvRevise, fakeCvWrite } from './fake-answers.js';
import { cvSystem, cvReviseUser, type PromptFact } from './prompt.js';

/** The facts `npm run dev` seeds: the fake CV's extraction, as the worker shows them. */
const seeded: PromptFact[] = FAKE_CV_EXTRACTION.facts
  .filter((draft) => draft.type !== 'preference')
  .map((draft, index) => ({
    id: `dev-fact-${String(index + 1).padStart(3, '0')}`,
    type: draft.type,
    text: draft.text,
    dates: draft.dates,
  }));

describe('fakeCvWrite', () => {
  it('fills a page for the seeded profile: 3 entries, 3 projects, about 12 bullets', async () => {
    const { toAlias, toId } = factAliases(seeded.map((fact) => fact.id));
    const content = fakeCvWrite(cvSystem(seeded, toAlias));
    expect(content.experience.length).toBeGreaterThanOrEqual(2);
    const bullets = [...content.experience, ...content.projects].flatMap((e) => e.bullets);
    expect(bullets.length).toBeGreaterThanOrEqual(8);

    const dated = seeded.map((fact) => ({ id: fact.id, dates: fact.dates }));
    const fit = await render.fitPage(FAKE_HEADER, content, render.makeDateOf(toId, dated));
    if (!fit.ok) throw new Error('the fake CV does not fit');
    // The old fake filled about 40% of the page.
    expect(fit.fill).toBeGreaterThanOrEqual(0.7);
    const facts: CvFact[] = seeded.map((fact) => ({
      id: fact.id,
      type: fact.type as CvFact['type'],
      text: fact.text,
      evidence: fact.text,
      status: 'active',
    }));
    const score = scoreCv({
      content: fit.content,
      facts,
      aliases: toId,
      requirements: [],
      company: 'Northwind Analytics',
      layout: {
        fill: fit.fill,
        bulletLines: fit.lines.bullets,
        headingWraps: fit.lines.headingWraps,
      },
    });
    expect(score.total).toBeGreaterThan(0);
  });

  it('never repeats a bullet within one entry, even with few facts', () => {
    const { toAlias } = factAliases(CV_FACTS.map((fact) => fact.id));
    const facts: PromptFact[] = CV_FACTS.map((fact) => ({
      id: fact.id,
      type: fact.type,
      text: fact.text,
      dates: {},
    }));
    const content = fakeCvWrite(cvSystem(facts, toAlias));
    for (const entry of content.experience) {
      const texts = entry.bullets.map((bullet) => bullet.text);
      expect(new Set(texts).size).toBe(texts.length);
    }
  });
});

describe('fakeCvRevise', () => {
  it('returns the draft in the request, whatever the findings', () => {
    const { toAlias } = factAliases(seeded.map((fact) => fact.id));
    const draft = fakeCvWrite(cvSystem(seeded, toAlias));
    const user = cvReviseUser({
      job: {
        title: 'Analyst',
        company: 'Northwind Analytics',
        location: 'London',
        remote: 'hybrid',
        description: 'Analyse data.',
        requirements: [],
        talkingPoints: [],
      },
      draft,
      findings: [],
      fill: 0.6,
      unusedAliases: [],
    });
    expect(fakeCvRevise(user)).toEqual(draft);
    expect(() => fakeCvRevise('no draft here')).toThrow('no <draft_cv>');
  });

  it('answers a cvRevise request through the fake transport', async () => {
    const { toAlias } = factAliases(seeded.map((fact) => fact.id));
    const system = cvSystem(seeded, toAlias);
    const draft = fakeCvWrite(system);
    const user = cvReviseUser({
      job: {
        title: 'Analyst',
        company: 'Northwind Analytics',
        location: 'London',
        remote: 'hybrid',
        description: '',
        requirements: [],
        talkingPoints: [],
      },
      draft,
      findings: [],
      fill: 0.6,
      unusedAliases: [],
    });
    const response = await fakeTransport().send({
      purpose: 'cvRevise',
      model: MODELS.cvRevise,
      system,
      messages: [{ role: 'user', content: user }],
      schema: CvContentShapeSchema,
      timeoutMs: 1_000,
    });
    expect(JSON.parse(response.text ?? '')).toEqual(draft);
    expect(response.model).toMatch(/^fake:/);
  });
});
