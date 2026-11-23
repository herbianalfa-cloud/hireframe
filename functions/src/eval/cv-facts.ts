import type { FunnelFact } from '@hireframe/shared';

import { EVAL_FACTS } from './cases.js';

/**
 * The fake candidate "Alex Example" as the CV eval sees them: the same 63 fact IDs, types, dates
 * and lanes as `EVAL_FACTS` (which feeds the funnel eval and stays as it is), but with the
 * length of a real master CV. A real fact is a full sentence of 90 to 160 characters, not the
 * five-word atoms of the funnel's fixture, and the CV prompt, its length target and the page fill
 * are only honest on facts that long. Requirements in `evals/cv-cases.jsonl` cite these IDs.
 * Every name and employer is invented.
 */
const LONGER: Readonly<Record<string, string>> = {
  'fact-03':
    "Led onboarding for 12 clients, from the kickoff call through data migration to go-live sign-off, working with each client's operations lead.",
  'fact-04':
    'Cut client time-to-live by 30% by replacing a manual setup checklist with a shared template and a weekly progress check.',
  'fact-05':
    'Wrote 25 help-centre articles for the self-serve setup flow, covering integrations, user roles and common import errors.',
  'fact-06':
    'Ran weekly product feedback sessions with the support team and turned the recurring themes into a prioritised list for the product manager.',
  'fact-07':
    'Logged 40 bug reports in Jira with reproduction steps, screenshots and the affected client, so engineers could triage them quickly.',
  'fact-08':
    'Tracked bug reports through to release and confirmed each fix with the client who had raised it.',
  'fact-09':
    'Mapped the onboarding process in Miro, from signed contract to first live report, and marked every handoff between teams.',
  'fact-10':
    'Removed 4 manual handoffs from onboarding by merging two intake forms and automating the account-setup email.',
  'fact-11':
    'Presented a monthly churn-risk summary to the head of customer success, listing the accounts with falling logins and open tickets.',
  'fact-12':
    'Resolved 200 support tickets, mostly setup questions and report errors from new clients, within the agreed response time.',
  'fact-14':
    "Built a SQL dashboard in Metabase for the society's app team, replacing a weekly spreadsheet export.",
  'fact-15':
    'The dashboard tracked weekly active users by faculty and by feature, and the team opened it at every sprint planning.',
  'fact-16':
    'Interviewed 18 students to shape the timetable app roadmap, and summarised the findings in a one-page brief for the developers.',
  'fact-17':
    'Grew weekly active users by 45% over two terms after shipping the changes that came out of the interviews.',
  'fact-18':
    'Prioritised the backlog with the student developers every sprint, ranking items by how many students had asked for them.',
  'fact-19':
    'Wrote user stories and acceptance criteria for the timetable app, agreed with the developers before each sprint started.',
  'fact-20':
    'Specified requirements for 3 releases, including the notification settings and the exam-week view.',
  'fact-21':
    'Ran an A/B test on the sign-up screen, comparing a shorter form against the existing one for two weeks.',
  'fact-22':
    'Lifted sign-up completion by 12% after the shorter form won the A/B test and was rolled out to all students.',
  'fact-24':
    'Handled customer queries on the shop floor, from stock checks to special orders, during busy weekends.',
  'fact-25': "Handled customer queries by phone and noted each request in the shop's order book.",
  'fact-26':
    'Trained 3 new starters on the till system and wrote a one-page guide for refunds and gift cards.',
  'fact-28':
    'Cleaned 100k orders in Python with pandas, fixing date formats, duplicate rows and missing delivery fields.',
  'fact-29':
    'Presented delivery-delay findings from the Olist analysis to a course group, with charts of delays by region and by seller.',
  'fact-31':
    'Built a prompt-based FAQ bot with the Claude API that answered timetable questions from a short document.',
  'fact-33':
    'Designed a small puzzle game in Unity with 12 levels, a hint button and a simple level editor.',
  'fact-34':
    'Shipped the Unity game to itch.io and collected feedback from players in the comments.',
  'fact-61':
    'Volunteer mentor at a local coding club for teenagers, running a weekly session on HTML and simple games.',
  'fact-62':
    'Organised a 60-person product hackathon at university, from booking the room to recruiting the judges.',
  'fact-63':
    'Used Zendesk for customer support, working the shared queue and tagging tickets by product area.',
};

export const CV_EVAL_FACTS: FunnelFact[] = EVAL_FACTS.map((fact) => ({
  ...fact,
  text: LONGER[fact.id] ?? fact.text,
}));
