/**
 * A fake CV for tests and local dev (CLAUDE.md: fixtures use fake data only). "Alex Example"
 * is invented; employers and schools are placeholders. ASCII only, so the PDF builder can use a
 * standard font. Several bullets make two claims on purpose, to test that facts come out atomic.
 */
export const FAKE_CV_LINES: readonly string[] = [
  'Alex Example',
  'London, UK | alex.example@example.com | portfolio: example.com/alex',
  'PROFILE',
  'Graduate in Business Information Systems, interested in product and customer-facing SaaS roles.',
  'EXPERIENCE',
  'Customer Onboarding Intern, Example Cloud Ltd, London (Jun 2024 - Sep 2024)',
  '- Led onboarding for 12 clients and cut time-to-live by 30%',
  '- Wrote 25 help-centre articles for the self-serve setup flow',
  '- Ran weekly product feedback sessions with the support team',
  '- Logged 40 bug reports in Jira and tracked them to release',
  '- Mapped the onboarding process in Miro and removed 4 manual handoffs',
  '- Presented a churn-risk summary to the head of customer success each month',
  '- Resolved 200 support tickets in Zendesk',
  'Student Product Analyst (part-time), Campus Apps Society (Oct 2023 - May 2024)',
  '- Built a SQL dashboard in Metabase that tracked weekly active users',
  '- Interviewed 18 students to shape the timetable app roadmap and grew weekly active users by 45%',
  '- Prioritised the backlog with the student developers every sprint',
  '- Wrote user stories and acceptance criteria for 3 releases',
  '- Ran an A/B test on the sign-up screen that lifted completion by 12%',
  'Retail Assistant, Example Books, London (Sep 2021 - Jun 2023)',
  '- Handled customer queries on the shop floor and by phone',
  '- Trained 3 new starters on the till system',
  'PROJECTS',
  'Olist e-commerce analysis (2024): cleaned 100k orders in Python and presented delivery-delay findings',
  'Timetable chatbot prototype (2023): built a prompt-based FAQ bot with the Claude API',
  'Unity puzzle game (2022): designed a small puzzle game and shipped it to itch.io',
  'EDUCATION',
  'BSc Business Information Systems, Example University (2021 - 2024), First Class Honours',
  'Dissertation: onboarding friction in B2B SaaS products',
  'Google Data Analytics Certificate (2023)',
  'Scrum Fundamentals Certificate (2024)',
  'SKILLS',
  'Tools: SQL, Python, Excel, Metabase, Jira, Figma, Notion, Unity, Git, Miro, Zapier',
  'Methods: user interviews, A/B test analysis, process mapping, requirements writing',
  'Languages: English (native), Spanish (conversational)',
  'ADDITIONAL',
  'Based in London and open to hybrid roles across the UK',
  'Available to start immediately',
  'Prefers B2B SaaS companies with 20 to 300 staff',
  'Volunteer: mentor at a local coding club for teenagers (2022 - 2024)',
  'Organised a 60-person product hackathon at university',
];

export const FAKE_CV_TEXT = FAKE_CV_LINES.join('\n');

/** Bullets that make two claims; each must come out as at least two facts. */
export const MULTI_CLAIM_BULLETS: readonly string[] = [
  'Led onboarding for 12 clients and cut time-to-live by 30%',
  'Logged 40 bug reports in Jira and tracked them to release',
  'Mapped the onboarding process in Miro and removed 4 manual handoffs',
  'Interviewed 18 students to shape the timetable app roadmap and grew weekly active users by 45%',
  'Ran an A/B test on the sign-up screen that lifted completion by 12%',
];

/** Marker the fake transport looks for to return the revised extraction. */
export const REVISED_MARKER = '(revised)';

/** The same CV with one reworded claim, to exercise the flag-for-review path. */
export const FAKE_CV_REVISED_LINES: readonly string[] = FAKE_CV_LINES.map((line) => {
  if (line === 'Alex Example') return `Alex Example ${REVISED_MARKER}`;
  if (line.startsWith('- Led onboarding for 12 clients')) {
    return '- Led onboarding for 14 clients and cut time-to-live by 30%';
  }
  return line;
});

export const FAKE_CV_REVISED_TEXT = FAKE_CV_REVISED_LINES.join('\n');
