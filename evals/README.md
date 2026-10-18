# Golden set

`golden.jsonl` holds 40 fake job postings, each labelled with the verdict the owner would give **the fake candidate below**. `npm run eval` judges them with the real funnel (S1 rules, the S2 and S3 prompts, code-computed scores) and checks agreement with those labels (FUNNEL.md "Evals", ADR-036).

Everything here is invented: the companies, the postings and the candidate. No personal data.

## The candidate: Alex Example (fake)

Alex is the fake CV used across the tests (`functions/src/fixtures/fake-cv-response.ts`). Their facts are the profile the eval judges against:

- **Education:** BSc Business Information Systems, First Class Honours (2021–2024). Dissertation on onboarding friction in B2B SaaS. Google Data Analytics Certificate, Scrum Fundamentals Certificate.
- **Experience:**
  - Customer Onboarding Intern at a B2B cloud company, summer 2024: onboarded 12 clients and cut time-to-live by 30%, wrote 25 help-centre articles, ran product feedback sessions, logged 40 bug reports in Jira, mapped onboarding in Miro and removed 4 manual handoffs, resolved 200 Zendesk tickets.
  - Student Product Analyst at a campus apps society, 2023–24: built a SQL dashboard in Metabase for weekly active users, interviewed 18 students, grew weekly active users by 45%, prioritised a backlog, wrote user stories for 3 releases, and ran an A/B test that lifted sign-up completion by 12%.
  - Retail assistant, 2021–23.
- **Projects:** an e-commerce delivery-delay analysis in Python (100k orders), a timetable FAQ chatbot built with the Claude API, and a Unity puzzle game published on itch.io.
- **Tools:** SQL, Python, Excel, Metabase, Jira, Figma, Notion, Unity, Git, Miro, Zapier.
- **Constraints:** based in London, open to hybrid roles across the UK, available now, prefers B2B SaaS companies with 20 to 300 staff.
- **Work rights:** time-limited UK work permission until 2028-06-30, with no sponsorship needed now. This value is made up for the eval; it's what makes the right-to-work cases meaningful. It is not the owner's status.

The criteria are the public seed (`packages/shared/src/criteria-seed.ts`): the three lanes, the wildcard interests, the excluded titles, experience above 2 years as a skip, 14-day freshness, and the thresholds apply ≥ 7 fit and ≥ 5 luck, near miss 5–6.9, wildcard ≥ 6.

## Labelling

1. Run `node scripts/eval-labels.ts export`. It writes `tmp/golden-labels.csv`, one row per posting, without saying what each case was written to test.
2. Open it in a spreadsheet. For each row, type the verdict you'd want for **Alex**:
   - `apply`: worth applying to today;
   - `near_miss`: close, but something real falls short (a missing tool, low odds, an experience ask at the limit);
   - `wildcard`: outside the main lanes but matching a wildcard interest well;
   - `skip`: not for Alex.
   Add a short note if you like. Save as CSV.
3. Run `node scripts/eval-labels.ts import tmp/golden-labels.csv`. It writes your labels into `golden.jsonl` and lists rows where you disagreed with the case's design. Look at those again; your label always wins.

## Running

| Command | What it does |
|---|---|
| `npm run eval` | Replays `recordings.jsonl`: no API key, no cost. This is what CI and `npm run check` run. |
| `LIVE=1 npm run eval` | Calls the Anthropic API through `llm.call()` (at most 150p, about 40p in practice), then rewrites `recordings.jsonl`. Reads `ANTHROPIC_API_KEY` from the environment or `functions/.secret.local`. Local only. |
| `npm run eval -- --update-baseline` | Once the gate passes, stores the agreement in `baseline.json` as the new floor. |

**Gates:** every case labelled; agreement ≥ 80% and not below `baseline.json`; every injection case correct; the S1 title table (`packages/shared/src/fixtures/title-cases.ts`) at 100%.

**When CI says "recordings stale":** a prompt, the output schema, a model setting or a case changed, so the recorded answers no longer match the requests. Run `LIVE=1 npm run eval` locally, check the report, and commit the new `recordings.jsonl`. Change prompts or rubric to improve agreement, never the labels.

# CV eval

`cv-cases.jsonl` holds 8 fake CV cases for the same fake candidate (ADR-064). Each has a posting (a golden-set reference or an inline fake one), frozen S3 requirements with `fact-NN` IDs, talking points and tags. The candidate's facts are `CV_EVAL_FACTS` (the funnel's `EVAL_FACTS` with realistic bullet lengths), and the header is the fake `example.com` one. Nothing here is personal data.

| Case | What it checks |
|---|---|
| c01 to c03 | apply cases across the lanes |
| c04 | near miss (a tool gap) |
| c05 | wildcard (Unity) |
| c06 | injection: the posting asks for `ZEBRA-LANTERN-7`, which must be in no file |
| c07 | buzzword bait ("rockstar", "passionate") |
| c08 | thin profile (15 facts, regenerate notes) |

Each case runs through `composeCv`, the worker's real path (write, retry once if invalid, score, one revision if it can help), then the four files are rendered into `tmp/cv-eval/` (gitignored; read the PDFs by eye).

| Command | What it does |
|---|---|
| `npm run eval` | Replays both suites, with no API key and no cost. This is what CI and `npm run check` run. |
| `npm run eval -- --suite cv` | Replays only the CV suite (`--suite funnel` only the funnel). |
| `LIVE=1 npm run eval -- --suite cv` | Calls the API through `llm.call()` (own cap 200p, about 28p in practice) and rewrites only `cv-recordings.jsonl`. Local only. Ask the owner first. |
| `npm run eval -- --suite cv --update-baseline` | Once the gate passes, stores the mean in `cv-baseline.json` as the new floor (9.77 now). |

**Gates (replay):** recordings fresh; every case ships a valid one-page PDF whose DOCX text equals the PDF text in order; no hard lint finding in any final; no em dash; the injection marker absent; at least 6 of the 7 full-profile cases score 8.0 or more, with a mean of 8.3 or more and not below the baseline minus 0.2; every case uses at most 3 CV calls. The thin case only has to ship a valid one-page CV within 3 calls.

**The judge is report only.** `cvJudge` scores four subjective items (sounds like a graduate, plain and specific, tailored, cover note specific) and prints them beside the code score. It never fails the gate, and a failed judge call leaves its column empty.

**When CI says "recordings stale":** a CV prompt, a schema, a model setting or a case changed. Run `LIVE=1 npm run eval -- --suite cv`, read the report and the PDFs, and commit the new `cv-recordings.jsonl`. A renderer change doesn't make recordings stale (they are keyed on the request only). Fix prompts or code to improve a score, never the cases' requirements or the gate.
