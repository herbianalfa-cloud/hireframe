import type { CvExtraction, FactDraft } from '@hireframe/shared';

/**
 * A recorded-style parseCv output for the fake CV (fake-cv-text.ts): 63 atomic facts, every
 * evidence span a verbatim quote, every multi-claim bullet split. Used by tests and by the
 * emulator's fake transport, so local dev never calls Anthropic.
 */
type Lane = FactDraft['lanes'][number];

function fact(
  type: FactDraft['type'],
  text: string,
  evidence: string,
  options: { start?: string; end?: string; tags?: string[]; lanes?: Lane[] } = {},
): FactDraft {
  const dates: FactDraft['dates'] = {};
  if (options.start) dates.start = options.start;
  if (options.end) dates.end = options.end;
  return { type, text, evidence, dates, tags: options.tags ?? [], lanes: options.lanes ?? [] };
}

const intern = { start: '2024-06', end: '2024-09' };
const analyst = { start: '2023-10', end: '2024-05' };
const retail = { start: '2021-09', end: '2023-06' };

const skill = (name: string, lanes: Lane[] = []) =>
  fact('skill', name, name, { tags: [name.toLowerCase()], lanes });

export const FAKE_CV_FACTS: readonly FactDraft[] = [
  fact(
    'preference',
    'Interested in product and customer-facing SaaS roles',
    'interested in product and customer-facing SaaS roles',
    { tags: ['saas'], lanes: ['primary', 'secondary'] },
  ),
  fact(
    'experience',
    'Customer Onboarding Intern at Example Cloud Ltd',
    'Customer Onboarding Intern, Example Cloud Ltd, London',
    { ...intern, tags: ['onboarding', 'internship'], lanes: ['secondary'] },
  ),
  fact('experience', 'Led onboarding for 12 clients', 'Led onboarding for 12 clients', {
    ...intern,
    tags: ['onboarding'],
    lanes: ['secondary'],
  }),
  fact('metric', 'Cut client time-to-live by 30%', 'cut time-to-live by 30%', {
    ...intern,
    tags: ['onboarding', 'time-to-live'],
    lanes: ['secondary'],
  }),
  fact(
    'metric',
    'Wrote 25 help-centre articles for the self-serve setup flow',
    'Wrote 25 help-centre articles for the self-serve setup flow',
    { ...intern, tags: ['documentation'], lanes: ['secondary'] },
  ),
  fact(
    'experience',
    'Ran weekly product feedback sessions with the support team',
    'Ran weekly product feedback sessions with the support team',
    { ...intern, tags: ['feedback'], lanes: ['primary'] },
  ),
  fact('metric', 'Logged 40 bug reports in Jira', 'Logged 40 bug reports in Jira', {
    ...intern,
    tags: ['qa', 'jira'],
    lanes: ['primary', 'secondary'],
  }),
  fact('experience', 'Tracked bug reports through to release', 'tracked them to release', {
    ...intern,
    tags: ['qa'],
    lanes: ['primary'],
  }),
  fact(
    'experience',
    'Mapped the onboarding process in Miro',
    'Mapped the onboarding process in Miro',
    { ...intern, tags: ['process mapping'], lanes: ['secondary'] },
  ),
  fact('metric', 'Removed 4 manual handoffs from onboarding', 'removed 4 manual handoffs', {
    ...intern,
    tags: ['process improvement'],
    lanes: ['secondary'],
  }),
  fact(
    'experience',
    'Presented a monthly churn-risk summary to the head of customer success',
    'Presented a churn-risk summary to the head of customer success each month',
    { ...intern, tags: ['churn', 'reporting'], lanes: ['secondary'] },
  ),
  fact('metric', 'Resolved 200 support tickets', 'Resolved 200 support tickets', {
    ...intern,
    tags: ['support'],
    lanes: ['secondary'],
  }),
  fact(
    'experience',
    'Student Product Analyst (part-time) at Campus Apps Society',
    'Student Product Analyst (part-time), Campus Apps Society',
    { ...analyst, tags: ['product analytics'], lanes: ['primary'] },
  ),
  fact('achievement', 'Built a SQL dashboard in Metabase', 'Built a SQL dashboard in Metabase', {
    ...analyst,
    tags: ['sql', 'dashboard'],
    lanes: ['primary'],
  }),
  fact('achievement', 'The dashboard tracked weekly active users', 'tracked weekly active users', {
    ...analyst,
    tags: ['metrics'],
    lanes: ['primary'],
  }),
  fact(
    'metric',
    'Interviewed 18 students to shape the timetable app roadmap',
    'Interviewed 18 students to shape the timetable app roadmap',
    { ...analyst, tags: ['user research', 'roadmap'], lanes: ['primary'] },
  ),
  fact('metric', 'Grew weekly active users by 45%', 'grew weekly active users by 45%', {
    ...analyst,
    tags: ['growth'],
    lanes: ['primary'],
  }),
  fact(
    'experience',
    'Prioritised the backlog with the student developers every sprint',
    'Prioritised the backlog with the student developers every sprint',
    { ...analyst, tags: ['backlog', 'agile'], lanes: ['primary'] },
  ),
  fact(
    'experience',
    'Wrote user stories and acceptance criteria',
    'Wrote user stories and acceptance criteria',
    { ...analyst, tags: ['requirements'], lanes: ['primary', 'secondary'] },
  ),
  fact('metric', 'Specified requirements for 3 releases', 'for 3 releases', {
    ...analyst,
    tags: ['releases'],
    lanes: ['primary'],
  }),
  fact(
    'experience',
    'Ran an A/B test on the sign-up screen',
    'Ran an A/B test on the sign-up screen',
    { ...analyst, tags: ['experimentation'], lanes: ['primary'] },
  ),
  fact('metric', 'Lifted sign-up completion by 12%', 'lifted completion by 12%', {
    ...analyst,
    tags: ['conversion'],
    lanes: ['primary'],
  }),
  fact(
    'experience',
    'Retail Assistant at Example Books',
    'Retail Assistant, Example Books, London',
    { ...retail, tags: ['retail'], lanes: [] },
  ),
  fact(
    'experience',
    'Handled customer queries on the shop floor',
    'Handled customer queries on the shop floor',
    { ...retail, tags: ['customer service'], lanes: ['secondary'] },
  ),
  fact('experience', 'Handled customer queries by phone', 'and by phone', {
    ...retail,
    tags: ['customer service'],
    lanes: ['secondary'],
  }),
  fact(
    'metric',
    'Trained 3 new starters on the till system',
    'Trained 3 new starters on the till system',
    { ...retail, tags: ['training'], lanes: [] },
  ),
  fact('project', 'Olist e-commerce analysis', 'Olist e-commerce analysis (2024)', {
    start: '2024',
    tags: ['analytics'],
    lanes: ['primary', 'opportunistic'],
  }),
  fact('metric', 'Cleaned 100k orders in Python', 'cleaned 100k orders in Python', {
    start: '2024',
    tags: ['python', 'data cleaning'],
    lanes: ['primary'],
  }),
  fact(
    'achievement',
    'Presented delivery-delay findings from the Olist analysis',
    'presented delivery-delay findings',
    { start: '2024', tags: ['insight'], lanes: ['primary', 'opportunistic'] },
  ),
  fact('project', 'Timetable chatbot prototype', 'Timetable chatbot prototype (2023)', {
    start: '2023',
    tags: ['chatbot'],
    lanes: ['wildcard'],
  }),
  fact(
    'achievement',
    'Built a prompt-based FAQ bot with the Claude API',
    'built a prompt-based FAQ bot with the Claude API',
    { start: '2023', tags: ['llm', 'prompting'], lanes: ['wildcard'] },
  ),
  fact('project', 'Unity puzzle game', 'Unity puzzle game (2022)', {
    start: '2022',
    tags: ['game dev'],
    lanes: ['wildcard'],
  }),
  fact('achievement', 'Designed a small puzzle game in Unity', 'designed a small puzzle game', {
    start: '2022',
    tags: ['game design'],
    lanes: ['wildcard'],
  }),
  fact('achievement', 'Shipped a Unity game to itch.io', 'shipped it to itch.io', {
    start: '2022',
    tags: ['release'],
    lanes: ['wildcard'],
  }),
  fact(
    'education',
    'BSc Business Information Systems, Example University',
    'BSc Business Information Systems, Example University',
    { start: '2021', end: '2024', tags: ['degree'], lanes: ['primary', 'secondary'] },
  ),
  fact('achievement', 'Graduated with First Class Honours', 'First Class Honours', {
    end: '2024',
    tags: ['degree'],
    lanes: [],
  }),
  fact(
    'education',
    'Dissertation on onboarding friction in B2B SaaS products',
    'Dissertation: onboarding friction in B2B SaaS products',
    { tags: ['research', 'onboarding'], lanes: ['secondary'] },
  ),
  fact(
    'education',
    'Google Data Analytics Certificate',
    'Google Data Analytics Certificate (2023)',
    { start: '2023', tags: ['analytics'], lanes: ['primary', 'opportunistic'] },
  ),
  fact('education', 'Scrum Fundamentals Certificate', 'Scrum Fundamentals Certificate (2024)', {
    start: '2024',
    tags: ['agile'],
    lanes: ['primary'],
  }),
  skill('SQL', ['primary']),
  skill('Python', ['primary']),
  skill('Excel', ['primary', 'opportunistic']),
  skill('Metabase', ['primary']),
  skill('Jira', ['primary', 'secondary']),
  skill('Figma', ['wildcard']),
  skill('Notion'),
  skill('Unity', ['wildcard']),
  skill('Git'),
  skill('Miro', ['secondary']),
  skill('Zapier', ['secondary']),
  fact('skill', 'User interviews', 'user interviews', {
    tags: ['user research'],
    lanes: ['primary', 'opportunistic'],
  }),
  fact('skill', 'A/B test analysis', 'A/B test analysis', {
    tags: ['experimentation'],
    lanes: ['primary'],
  }),
  fact('skill', 'Process mapping', 'process mapping', { tags: ['process'], lanes: ['secondary'] }),
  fact('skill', 'Requirements writing', 'requirements writing', {
    tags: ['requirements'],
    lanes: ['primary', 'secondary'],
  }),
  fact('skill', 'English (native)', 'English (native)', { tags: ['language'] }),
  fact('skill', 'Spanish (conversational)', 'Spanish (conversational)', { tags: ['language'] }),
  fact('constraint', 'Based in London', 'Based in London', { tags: ['location'] }),
  fact('preference', 'Open to hybrid roles across the UK', 'open to hybrid roles across the UK', {
    tags: ['hybrid', 'location'],
  }),
  fact('constraint', 'Available to start immediately', 'Available to start immediately', {
    tags: ['availability'],
  }),
  fact(
    'preference',
    'Prefers B2B SaaS companies with 20 to 300 staff',
    'Prefers B2B SaaS companies with 20 to 300 staff',
    { tags: ['company size', 'b2b saas'] },
  ),
  fact(
    'experience',
    'Volunteer mentor at a local coding club for teenagers',
    'mentor at a local coding club for teenagers',
    { start: '2022', end: '2024', tags: ['mentoring'], lanes: [] },
  ),
  fact(
    'metric',
    'Organised a 60-person product hackathon at university',
    'Organised a 60-person product hackathon at university',
    { tags: ['events', 'hackathon'], lanes: ['primary'] },
  ),
  fact('experience', 'Used Zendesk for customer support', 'support tickets in Zendesk', {
    ...intern,
    tags: ['zendesk'],
    lanes: ['secondary'],
  }),
];

export const FAKE_CV_EXTRACTION: CvExtraction = { facts: [...FAKE_CV_FACTS] };

/** The revised CV's extraction: identical except one reworded claim (12 → 14 clients). */
export const FAKE_CV_REVISED_EXTRACTION: CvExtraction = {
  facts: FAKE_CV_FACTS.map((draft) =>
    draft.text === 'Led onboarding for 12 clients'
      ? {
          ...draft,
          text: 'Led onboarding for 14 clients',
          evidence: 'Led onboarding for 14 clients',
        }
      : draft,
  ),
};
