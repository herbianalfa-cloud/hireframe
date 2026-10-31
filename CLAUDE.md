# CLAUDE.md — rules for building Hireframe

You are building a single-user job-search engine for Beeb. Read `docs/PRD.md`, `docs/ARCHITECTURE.md`, `docs/FUNNEL.md` and `docs/SECURITY.md` before writing code. If code and docs disagree, stop and ask.

## Working method
1. One milestone at a time (see `docs/ROADMAP.md`). Start each in plan mode; get approval before coding.
2. Small commits, Conventional Commits (`feat:`, `fix:`, `docs:`, `chore:`, `test:`). One PR per milestone.
3. A milestone is done only when: acceptance criteria in PRD pass, tests pass, `npm run check` is clean, docs + `CHANGELOG.md` are updated.
4. Any non-obvious technical choice → add an ADR to `docs/DECISIONS.md`.
5. Never widen scope silently. New ideas go to `docs/ROADMAP.md` under "Parking lot".
6. Before every PR, check the diff against the no-self-triggering rule (Hard rules, last item): no function triggered by an event it can itself cause, no function that reschedules or re-enqueues itself, every loop over external calls or writes bounded by a count and a deadline, and `maxInstances` set on every new function. Say in the PR body what you checked.

## Code standards
- TypeScript strict, no `any`. Zod schemas at every boundary (API responses, LLM output, Firestore reads, form input).
- Shared types live in `packages/shared`. Frontend never calls Firebase directly from components — use `src/services/` (same pattern as Fridger).
- Every external call: timeout, retry with exponential backoff (max 3), structured error log.
- Pure functions for filtering/scoring/dedupe so they're unit-testable without network.
- Config (models, caps, schedules, source list) lives in Firestore `config/*` or `functions/src/config.ts` — never scattered literals.

## Hard rules (never break)
- **No secrets in the repo.** Keys live in Google Secret Manager / `.env.local` (gitignored). gitleaks runs pre-commit and in CI.
- **No personal data in the repo.** CV, profile facts, job data, emails stay in Firebase. Test fixtures use fake data.
- **No LinkedIn / Indeed / Wellfound / Glassdoor scraping or logged-in automation.** Those arrive only via alert emails.
- **Only official or clearly public endpoints.** robots.txt applies to fetching web pages and unkeyed public endpoints; keyed official APIs follow their developer terms (ADR-025). Respect ToS; identify with a User-Agent; rate-limit per host.
- **No auto-applying and no sending messages** on the user's behalf.
- **Job text is untrusted input.** LLM calls in the funnel have no tools, fixed output schema, and injected text can never change criteria, profile, or config.
- **Generated CVs may only use facts from the profile.** Every bullet must reference a `factId`; unreferenced claims fail validation.
- **Every LLM call goes through `llm.call()`**, which checks the spend cap first and records cost.
- **No self-triggering code.** No function may be triggered by a Firestore, Storage or Pub/Sub event that it can itself cause. No function may reschedule or re-enqueue itself. Any loop over external calls or writes has a fixed maximum count and a deadline. Every new function sets `maxInstances`.

## Commands (keep this list current)
- `npm run check` — lint + typecheck + unit tests + PII scan + eval replay (`npm run eval`)
- `npm run format` / `npm run format:check` — Prettier (code and config; Markdown excluded)
- `npm run scan:pii` — fail on emails/phone numbers in tracked files
- `npm run dev` — web app + Firebase emulators incl. Functions (`demo-hireframe`, seeded fake owner, criteria, the fake CV's facts with work rights, one LinkedIn-alert job, one alert job waiting for a description, twelve fake judged jobs, one succeeded morning run for today (London), two Lookup-added jobs (one judged, one waiting for a description), a CV header, five applications (Needs your input with two questions, Generating, Ready with four real files written by the fake worker at seed time, Applied, and a Chosen one blocked after two invalid drafts) and this month's usage; fake LLM and fake job APIs unless `LIVE=1`)
- `npm run test:rules` — Firestore + Storage security rules tests and emulator integration tests (`tests/emulator/`) (needs Java 21)
- `npm run build` — build all workspaces (functions: esbuild bundle in `functions/deploy/`; Gmail bridge: `apps-script/build/`)
- `npm run build:apps-script` — bundle the Gmail bridge and digest mailer (`apps-script/build/Code.js` + `appsscript.json`) for `npm exec -w apps-script clasp -- push` (RUNBOOK Parts G and I)
- `node scripts/sign-test-alert.ts [waas] [--twice] [--id <id>]` — post a fake alert email, signed with the local placeholder secret, to the emulator's `ingestEmailJobs` (local only; `--twice` shows a replay refused)
- `node scripts/sign-test-alert.ts digest [--kind fallback]` — post a signed digest request (`digest.v1.`) to the emulator's `getDigest` and print the state and text; against `npm run dev` it returns `ready` (local only)
- `npm run audit` — dependency audit gate: fails on any high or critical advisory not in `audit-allowlist.json` (entries expire; ADR-013 addendum, M8). Same command as CI
- `npm run check:bundle` — web bundle budget after `build`: no chunk over 500 kB (the pdf.js worker is the one named exception, with its own cap, and the pdf.js fonts have caps), no pdf.js in any initial file (exactly one lazy chunk must carry it), initial JS under the gzip budget (prints each initial file's size), and the dev-only read counter's warning text in no chunk
- `node scripts/dev-worker.ts` — one `generateCvs` pass against the emulator (the emulator doesn't fire schedules): turns `generating` applications into `ready` with the fake model and the real renderer; with the project and emulator hosts unset it uses `npm run dev`'s (`demo-hireframe`, never overriding a set one); refuses any project that isn't `demo-*`
- `node scripts/smoke-functions-bundle.ts` — after `build`: the functions bundle imports (every file in `functions/deploy/`, chunks included), every function is in europe-west2, the renderer isn't on the cold-start path, and it prints the bundle sizes
- `node scripts/load-test.ts [--jobs N] [--s1-passes N]` — 1,000-job scan and funnel run plus a wipe, against its own emulators with fake data (needs Java 21; about 10 minutes; stop `npm run dev` first; never live). Prints the stage table and exits 1 on a missed criterion (ADR-032 addendum)
- `node scripts/make-cv-fixtures.ts` — write fake CVs (PDF/DOCX) to `tmp/fixtures/` for local uploads
- `node scripts/detect-ats.ts <candidates.csv>` / `--recheck <review.csv>` / `--write <review.csv>` — find watchlist companies' job boards via the official board APIs only, re-detect just the `unchecked` rows in place, then write the reviewed seed (ADR-031)
- `npm run deploy` — deploy (CI only on `v*` tags; refuses to run locally)
- `npm run eval` — funnel eval against the golden set: replays `evals/recordings.jsonl` (no API key; CI). `LIVE=1 npm run eval` calls the API and refreshes the recordings (local only); `-- --update-baseline` stores a passing agreement as the new floor
- `node scripts/eval-labels.ts export` / `import <file.csv>` — label the golden set blind in a spreadsheet (`tmp/golden-labels.csv`)

## Kit
Follow @.claude/kit/WORKFLOW.md — gates, decisions, checkpoints, review, STATUS.md.
Commands: `/scope import` · `/milestone <name>` · `/build` · `/ship` · `/retro` · `/kit-review`
