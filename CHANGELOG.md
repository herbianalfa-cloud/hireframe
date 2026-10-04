# Changelog

All notable changes. Format: Keep a Changelog, SemVer.

## [0.5.2]
### Fixed
- **Events can no longer describe a change that didn't happen** (ADR-038). The rules now require a status event to move between two different statuses with the job's own verdict, and a rating event to match a rating written in the same batch (verdict, answer and expected verdict). Before, a standalone event matching the job's current state was accepted.
- **A note of only spaces is rejected** by the rules, as the schema already did. One would have made the job fail to parse and drop out of the lists.
- **Pressing `s` on an applied job no longer un-applies it.** It cleared the applied stamps and lowered "Applied this week" and agreement. Skip stays unavailable on applied jobs, as in the detail sheet.
- **Job actions always show their error.** `setJobStatus` and `rateJob` reject instead of throwing synchronously, so a refused change reaches the list's error message.

### Changed
- Today's applied tile uses `todayKpis`, which now keeps a failed count unknown (null) instead of guessing.

### Added
- Rules tests for the cases above, and for every status move and rating the app can produce (judged and unjudged jobs).
- Every event the builders produce is parsed with `EventSchema` in a test.

## [0.5.1]
### Fixed
- **Today's tiles showed "Couldn't load the numbers" in production.** "Judged today" and "applied this week" scanned ascending, but the indexes are descending, so Firestore rejected both counts (`failed-precondition`). Both now order descending and use the existing indexes. The emulator doesn't enforce indexes, which is why tests passed.
- **Jobs filtered to "needs review" together with a verdict and/or status** would have failed the same way. Three composite indexes cover those combinations (they build after deploy; wait for **Enabled** under Firestore → Indexes).
- **One failed count no longer blanks the tiles.** Each tile shows its own number or its own "Couldn't load this number" note.

### Added
- A unit test that checks every dashboard query and every Jobs filter combination against `firestore.indexes.json`, including sort direction (ADR-040).

## [0.5.0]
### Added
- **M5 Dashboard** (ADR-038, ADR-025 addendum). The screens that turn M4's verdicts into the product:
  - **Today:** four tiles (to apply, to review, applied this week against the criteria target, AI spend against the cap) and the Apply, Near miss and Wildcard lists. Each row has the title, company, location, age, fit and luck, and the one-line reason. Every list has loading, empty and error states, and a truncated list links to the full Jobs view. `hf:usable` marks the first render with the numbers and the Apply list filled (the R7 measure).
  - **Jobs:** filter by verdict and status (or just the jobs waiting for review), newest judged first, Load more, filters kept in the URL, and the verdict-agreement line with its split.
  - **Job detail:** a right-hand sheet (full screen on phones, `?job=` so it can be linked) with the verdict, reason, what fell short, the skip rule, review and queued explanations, flags, requirements with the profile facts cited, matched facts, gaps, talking points, the plain-text description on demand, sources, attribution and actions: Open posting, Mark applied (with Undo), Save, Skip, 👍/👎 with a note and an expected verdict. Generate CV is shown disabled until M7. Job text is always shown as plain text.
  - **Keyboard:** in a job list, `j`/`k` move, `a` marks applied, `s` skips and `o` opens the posting. They work only while focus is inside the list (WCAG 2.1.4).
  - **System:** the spend meter (amber from 80%), the agreement line and a "Needs attention" list built from failing sources, the latest run's outcome and the spend flags.
  - **Attribution:** Adzuna jobs show "Jobs by Adzuna" with the official logo, self-hosted and linked to adzuna.co.uk; Reed jobs show a "via Reed" link to their listing.
  - All three screens load lazily.
- **Data and services behind them:**
  - The owner can set a job's status (`new`, `saved`, `applied`, `skipped`), stamp it applied (server time and the verdict it was applied on) and rate a verdict 👍/👎 with a note and an expected verdict. The rules allow exactly those fields; ratings name the verdict they judged, so one made after a re-score is rejected.
  - Create-only `events` record each action in the same batch.
  - Shared metrics: verdict agreement over 14 days, London day and week boundaries, the Today tile counts and the spend meter. `DEFAULT_MONTHLY_CAP_PENCE` moved to `packages/shared`.
  - Six `jobs` indexes for the dashboard queries. They build after deploy, so wait for **Enabled** under Firestore → Indexes before using the screens.
  - `npm run dev` seeds twelve fake judged jobs, this month's usage, one rating and one applied job.
  - `check:bundle` prints each initial file's gzip size.

### Changed
- The spend meter takes its cap from `config/app.monthlyCapPence` first (the override the functions enforce), then the month's stored cap, then the default.
- The initial-JS budget in `check:bundle` is 300 kB gzip (was 310 kB); it is 299.4 kB.
- System's scan card no longer says verdicts are coming.

## [0.4.1]
### Fixed
- **Funnel throughput** (ADR-039). The first production run judged only 30 jobs in S2 and 5 of 8 in S3:
  - Dated model IDs such as `claude-haiku-4-5-20251001` were priced at the top rate, so every Haiku call settled at about 0.30p instead of 0.15p. `priceFor` now strips a trailing `-YYYYMMDD`; a truly unknown model still gets the top rate and logs an error once per process.
  - S2 and S3 no longer stop on the first refused reservation. They wait for in-flight calls to settle and stop only when the next call can't fit with nothing in flight, or at the deadline. Expect about 55–60 S2 calls and 8–10 S3 calls per 24p run when the queues are that long.
  - A cached prompt reserves its input at the cache-write rate, so the worst-case bound can't be exceeded.
  - A deep read that back-pressure leaves queued no longer uses an `s3MaxJobs` slot, and a job that can't be sent no longer spends a Reed details call first.
- The System scan-once test no longer flakes on a loaded runner.

### Added
- Each run records why Triage and Deep reads each stopped (`budget.stops`), and System shows both.
- RUNBOOK Recovery: a new scheduled function with no schedule after its first deploy, and Part E step 68 binds `hireframe-fns` explicitly (ADR-037 addendum).

### Known
- **Monthly spend is overstated.** Every Haiku call (S2 triage since v0.4.0, Add fact since v0.2.0) was charged at twice its cost in `usage/{month}`, in `byPurpose`, in each run's `costPence` and in the eval's reported cost. Reservations were always right, and the error is in the safe direction. It isn't hand-corrected (ADR-039); October corrects itself going forward. To compute it exactly, price `tokens['claude-haiku-4-5-20251001']` at Haiku's rates and compare with the top rate it was charged at. The replayed eval now reports 20.9p instead of 25.4p for the same recordings; agreement and `evals/baseline.json` are unchanged.
### Added
- **M4 Funnel:**
  - **S1–S3 on every scan** (FUNNEL.md, ADR-032–037). `scanNow` and the new `scheduledScan` (07:30 and 17:30 on weekdays, Europe/London) fetch, dedupe, then judge:
    - **S1**, free rules with a rule ID on every skip: excluded titles, companies and keywords; non-UK office jobs; freshness; SC/DV clearance and driving licence; right-to-work wording that excludes your work rights; required experience above the cap. Unknown titles always pass.
    - **S2**, Haiku 4.5 triage: lane, seniority, explicit blockers, a score for queue order.
    - **S3**, Sonnet 5.5 deep read: requirements matched to profile facts (cited by ID; an unsupported "met" counts as missing), gaps, talking points.
    - **Fit, luck and the verdict are computed in code** from the deep read, with thresholds and lane points from criteria; the model's own scores only flag drift above 2.
  - **Spend control** (ADR-032): each run reserves a lease on `usage/{month}` (default 75% of the monthly cap over 46 scheduled runs, 24p at £15) and settles it once. S2 may use 40% of the lease. Per-run caps S1 ≤ 2,000, S2 ≤ 300, S3 ≤ 25. At 80% of the monthly cap a run is flagged; from 90% deep reads pause. Rate pacing stays under Anthropic's limits. Overrides in `config/app.funnel`, no deploy needed.
  - **Queues and backlog:** S2 takes the newest jobs first, S3 the best triage scores; leftovers wait for the next run, and a queued job that goes stale is skipped for free. The first run works through the M3 `s0` backlog.
  - **Reed full text:** jobs about to get a deep read swap their Reed snippet for the full description (≤ 20 calls a run, inside Reed's quotas). Adzuna-only jobs are flagged as snippets.
  - **Prompt caching** on the S3 system prompt (profile facts, lanes, wildcards, company preferences); S2's prompt is below Haiku's 4,096-token minimum.
  - **Injection safety:** every job-derived field sits inside a `<job_posting>` tag it can't close; no tools; fixed schemas; writes limited to verdict fields on that job; five injection cases in the golden set.
  - **`rescore`** callable and a **Re-score last 14 days** button on Criteria: S1 runs again, verdicts are recomputed in code wherever the prompts haven't changed (free for threshold, lane-point and rule changes), and only jobs whose prompt inputs changed go back to the model. Old verdicts stay until replaced.
  - **Work rights** on Profile (no restrictions, time-limited with an optional end date, needs sponsorship), saved to `profile/main`. Reset profile deletes it.
  - **Lane points** in criteria (wildcard 2, so wildcard verdicts are reachable), editable on Criteria.
  - **System screen:** each run shows its trigger, S1/S2/S3 counts, queued and review counts, cost, spend warnings and why it stopped early.
  - **Evals:** `evals/golden.jsonl` (40 fake postings, labelled by the owner), `npm run eval` (replays recorded answers, so CI needs no key; `LIVE=1` refreshes them), and `node scripts/eval-labels.ts export|import` for labelling in a spreadsheet.
  - **ADRs 032–037.**

### Changed
- The scan fetch budget drops from 360 s to 300 s to leave room for the funnel; Workable rotates 36 boards a scan instead of 43.
- `scanNow` mounts the Anthropic key.
- Run records gain per-stage counts, the lease and flags; jobs gain the verdict fields, `next`, `sortAt` and fingerprints.
- `npm run dev` seeds the fake CV's facts and a work-rights setting, so Scan now runs the whole funnel on the fake model.

## [0.3.0] - 2026-10-03
### Added
- **M3 Sources:**
  - **Seven source modules:**
    - Greenhouse, Lever (global and EU), Ashby and Workable job boards for watchlist companies;
    - Reed and Adzuna searches built from your lane titles;
    - the latest HN "Who is hiring?" thread, filtered to UK, London and remote-UK/Europe postings.

    Every response is zod-checked, and each posting is validated on its own, so one odd posting never loses a board.
  - **One HTTP client for every source** (ADR-029): `HireframeBot` User-Agent, at least 1 s between requests per host (robots `Crawl-delay` honoured), robots.txt for web pages and unkeyed endpoints, a timeout per request and a run deadline, at most 3 attempts with backoff on 429/5xx. Logs carry a host and a label, never a URL.
  - **Reed and Adzuna follow their developer terms** (ADR-025): the keys live in Secret Manager and are mounted only on `scanNow`. Persisted call quotas keep Adzuna under 25/min, 250/day, 1,000/week and 2,500/month; Reed has a conservative budget until its terms are cited.
  - **Normalise and dedupe (S0)** (ADR-030), pure code in `packages/shared`:
    - jobs share `keys[]` (a company/title/city hash, source keys and keys from linked job URLs);
    - level words are normalised, never stripped, so Senior and Junior roles at one company stay apart;
    - location, work-mode, salary, contract and gender noise is ignored for matching.

    Fixtures cover the PRD R5 case: a LinkedIn alert and the Greenhouse listing of the same role become one job with both sources.
  - **`scanNow`**, ingest-only until M4 (ADR-029):
    - fetches every source in parallel, writes new jobs at stage `s0` and adds new sources to known jobs. An unchanged job costs no write;
    - records run, source and company health. A failing source never fails the run (PRD R4);
    - a lock in `locks/scan` and a 5-minute cooldown, so a double tap never scans twice;
    - `config/app.disabledSources` turns a source off without a deploy;
    - a host with more ATS boards than fit in the fetch budget rotates them across scans, least recently scanned first (Workable, spaced 5 s apart, takes 43 a scan).

    No schedule until M4.
  - **System screen** (pulled forward from M5): Scan now, a card per source (status, counts, why it isn't OK, Adzuna calls today with "Jobs by Adzuna"), broken job boards, the job count and the last five runs.
  - **Watchlist seed:** 204 London/UK companies, 94 with a verified job board. Detection matches names exactly, never confirms an empty board, marks rate-limited probes `unchecked`, and `--recheck` re-detects only those rows. Workable is spaced 5 s apart.
  - **Company watchlist** (ADR-031): `node scripts/detect-ats.ts` finds each candidate's job board through the official board APIs only (or a careers URL you paste). It never fetches careers pages. It writes a review CSV, and `--write` turns your reviewed CSV into `packages/shared/src/watchlist-seed.ts`. `scanNow` creates missing seed companies and never overwrites existing ones.
  - **ADRs 025–031:**
    - robots.txt vs keyed APIs;
    - YC/Work at a Startup and Escape the City: their terms forbid automated access, so email alerts only;
    - Workable's public endpoint;
    - the ingest pipeline, dedupe and watchlist sourcing.
  - **Rules:** `sources/{id}` is owner-read, Admin-only write. Rules tests and emulator tests cover the scan (no job writes on a second run, the R5 merge, lock takeover, cooldown).
  - **Local dev:** fake job APIs, a fake watchlist and one seeded LinkedIn-alert job, so the first local scan shows the merge. `LIVE=1` uses the real APIs.

### Changed
- **M3 review fixes (PR #8):**
  - CI audits production dependencies at high and the full tree at critical; braces (via firebase-tools, dev only) has no patched version (ADR-013 addendum).
  - A scan killed at the timeout is marked failed by the next scan, and the System screen shows it as "Timed out" at once.
  - Reed and Adzuna calls count against the quota even if the run fails later.
  - A failed write batch is retried write by write, so one bad write never loses the others; failed company updates are counted instead of failing the run.
  - **Paused hosts:** a site that answers with a long Retry-After (Workable's was about 23 hours) gets no more requests until then, in this scan or later ones. It's logged once per host, and the System card shows "Paused until <time>".
  - Workable is called on `apply.workable.com` directly, so its robots.txt and 5 s spacing apply (ADR-027 amendment).
  - Stored jobs read during dedupe are zod-checked; job keys are capped without dropping a posting's own source key.
  - Production functions bundles no longer contain the emulator's fixtures (ADR-017 addendum).
  - Scan tuning numbers moved into `functions/src/config.ts`.
  - SECURITY: the "Delete all my data" wipe of jobs, runs, sources and companies (and Adzuna data removal) is deferred to M8.
- CLAUDE.md hard rule: robots.txt applies to web pages and unkeyed public endpoints; keyed official APIs follow their developer terms (ADR-025). SECURITY is updated to match.
- ROADMAP:
  - M3 adds Workable and the Sources panel;
  - M4 adds the funnel to `scanNow`, the schedule, the `s0` backlog and Reed full text;
  - M5 adds Adzuna (and, if required, Reed) attribution;
  - M6 adds alert dedupe through `keys[]` and watchlist auto-growth.
- RUNBOOK Part D (M3 manual steps); `scanNow` joins the invoker list in step 28.
- Shared callable options moved to `functions/src/callable.ts`.
- CHANGELOG: the v0.2.2 and v0.2.3 entries now sit under their release headings (both were tagged while still listed as Unreleased).

## [0.2.3] - 2026-10-01
### Fixed
- **Evidence on Profile fact cards looked empty.** The quote was stored and rendered, but it sits in a collapsed disclosure whose summary had no marker, so "Evidence" read as a heading with nothing under it. It now has a chevron that turns when open. A component test covers CV and manual facts.

### Added
- **Upload rows show the original file name** (truncated, full name in a tooltip). `parseCv` takes a required `fileName` (1–200 characters, validated with zod) and saves it on the upload document. It is never logged (a test checks). Uploads made before this have no name and show none. The immutable-fields rules test now covers `fileName`.

## [0.2.2] - 2026-10-01
### Fixed
- **Re-uploading the same CV is stable** (ADR-022). Uploading the .docx and then the .pdf gave "Added 64, unchanged 77, flagged 53", because the model words facts differently on every read.
  - The merge now matches on the fact's evidence quote (normalised for PDF/DOCX extraction noise) before falling back to text similarity. An archived fact is never re-added under new wording.
  - parseCv stores a SHA-256 of each upload and doesn't read the same file twice: no model call, nothing changes.
  - Tests reproduce the bug with two differently worded fake reads of the same CV.

### Added
- **Remove upload** on each upload row (ADR-023). It archives the facts that upload added and that were never edited, drops its pending proposed changes, keeps (and counts) facts you edited, and marks the upload Removed. It uses versioned client writes, with one new rule: the owner may set `removedAt` once on a finished upload.
- **Reset profile** in a Profile Danger zone (ADR-023). You type RESET, and the owner-only `resetProfile` callable hard-deletes every fact, version, upload and uploaded file; criteria and spend are kept. It refuses while a CV is being read.
- **Evidence link** on facts (ADR-024): an optional https-only `evidenceUrl`, editable and versioned. A model can never set one. Rules and rules tests are updated.

### Changed
- RUNBOOK: "Functions setup (M2)" is now **Part C**.
  - It covers every manual step from the v0.2.x deploys: the extra APIs (and why); the deployer's `serviceAccountUser` on the App Engine default and the default compute accounts; a one-time `allUsers` invoker binding per new callable; a check of the Storage service agent's `firebaserules.firestoreServiceAgent` role.
  - Upgrade steps for v0.2.2 and new Recovery entries.
- The functions runtime account needs `storage.objectUser` instead of `storage.objectViewer` on the bucket (to delete uploads on reset).
- Only the model callables mount the Anthropic key.
- Security: scoped npm overrides under firebase-tools: `basic-ftp` 6.2.1 (GHSA-c475-qrg2-pj4r, high; fixes the CI `audit` job) and `uuid` 11.1.1 (GHSA-w5hq-g745-h8pq, Dependabot alert #1). See the ADR-013 addendum.
- ROADMAP: M8 adds a dedicated Cloud Build account and removes Editor from the default compute account; "file attachments as evidence" is parked.

## [0.2.1] - 2026-10-01
### Fixed
- The v0.2.0 deploy failed with "Invalid service account (hireframe-fns@)" from Secret Manager. The runtime account is now the full email, from one constant in `functions/src/config.ts`, with a test that it stays a full email.

### Changed
- RUNBOOK Functions setup: step 2 also enables `eventarc`, `firebaseextensions` and `cloudbilling`; step 7 also grants the deployer `roles/iam.serviceAccountUser` on the App Engine default account (the Firebase CLI pre-check).

## [0.2.0] - 2026-10-01
### Added
- M2 Profile brain:
  - **CV → facts:** `parseCv` reads an uploaded PDF or DOCX (up to 5 MB), extracts the text and asks a Sonnet-class model for atomic facts (one claim each, multi-claim bullets split), each with a verbatim evidence quote checked against the CV. See ADR-018.
  - **Re-upload merge:** new facts are added, changed facts are flagged for review, archived facts aren't revived, nothing is overwritten.
  - **Profile screen:** view, search, edit, archive and restore facts; every fact shows its source; accept or keep proposed changes; version history; add a fact from a note (`addFact`, Haiku-class model).
  - **Criteria:** v1 seeded from FUNNEL.md (with structured excluded titles), an editable Criteria screen, immutable versions with a `criteria/current` pointer, and history. See ADR-019.
  - **Spend cap from day one:** a minimal `llm.call()` reserves each call's worst case against the monthly cap before it runs and records the actual cost in `usage/{yyyy-mm}`. See ADR-016.
  - **Rules:** the first client writes (versioned fact edits, criteria versions, CV uploads), each tested for owner allow, anon deny and other-user deny.
  - **Functions:** first Cloud Functions in europe-west2 on a dedicated runtime account, App Check enforced and consumed, bundled with esbuild; fake model in the emulator. See ADR-017.
  - **Docs:** RUNBOOK Functions setup (M2) and local-dev steps; `node scripts/make-cv-fixtures.ts` for fake CVs.
  - **Title rules:** `checkTitle` applies excluded titles as "immediately preceded by", whole words, with lanes winning over every rule except seniority. See ADR-020.
  - **Checks:** `npm run check:bundle` (web bundle budget) and a static guard listing every client-writable rules path; the CI smoke test now checks every function is in europe-west2.

### Changed
- `npm run dev` also runs the Functions emulator and seeds criteria v1; `npm run test:rules` also runs emulator integration tests; `npm run deploy` includes functions.
- Web: Profile and Criteria load on first visit, the Functions and Storage SDKs on first use, and vendors split into cached chunks; initial JS down from 1.08 MB to about 0.97 MB with no chunk over 500 kB (ADR-021).
- The region and callable timeouts are shared by functions and web (`packages/shared/src/callables.ts`).
- The emulator's fake model records `fake:<model id>`, so fake spend can't be mistaken for real spend.

### Fixed
- PR #4 review:
  - streamed model calls now have a hard time limit (the SDK timeout stopped at the response headers), and each `llm.call()` has a budget inside its callable timeout;
  - a call killed mid-flight is charged its worst case instead of vanishing from the month's spend (ADR-016);
  - the Anthropic SDK logger and pdf.js warnings can no longer print CV text to the function logs;
  - a CV whose parse was abandoned shows "Timed out" instead of "Reading" forever;
  - the CSP allows the callables host.
- RUNBOOK M1 setup:
  - enable the Firebase Storage API and create the bucket from the Firebase console;
  - add the `web.app` origin and `/__/auth/handler` redirect URI to the OAuth web client;
  - close sign-ups and account deletion under User actions, with no Identity Platform upgrade (ADR-015).
- New recovery entries, and the SECURITY checklist is updated.

## [0.1.0] - 2026-09-30
### Added
- M1 Firebase foundation:
  - **Owner-only access:**
    - Firestore and Storage rules, owner-only and fail-closed until `config/app` exists, with no client writes in M1.
    - Rules tests for every collection, including bootstrap attacks (`npm run test:rules`, CI `rules` job). See ADR-011.
  - **Web shell:**
    - Vite, React 19, Tailwind v4, shadcn/ui and react-router, dark by default with Light and System themes.
    - Sidebar on desktop, bottom tabs on phone, and empty states for Today, Jobs, Lookup, Profile, Criteria and System. See ADR-012.
  - **Auth gate:** Google sign-in, then "No access" for anyone but the owner. `config/app` Timestamps are converted before the zod parse.
  - **App Check** with reCAPTCHA Enterprise. Firebase config is read from Hosting's `init.json`, so none is in the repo.
  - **Local dev:** `npm run dev` runs the emulators on `demo-hireframe` with a seeded fake owner. See ADR-013.
  - **Deploy:** a tag-only workflow with keyless Workload Identity Federation and `production` environment approval, in region europe-west2. See ADR-014.
  - **Security:** an npm override forces `@grpc/grpc-js` 1.14.5 under the Firebase SDK, fixing two high advisories (ADR-013).
  - **Docs:** RUNBOOK Firebase setup, owner bootstrap and recovery; `AppConfigSchema` and Firestore path constants in `packages/shared`.

### Changed
- Renamed product Shortlist → Hireframe (repo, Gmail labels, docs). See ADR-007.
- Spec clarifications: Firestore paths, `locks/scan`, cost cap in pence with USD→GBP rate, verdict precedence, experience rule `> cap`, freshness in S1 only, digest in-progress notice, recorded-only evals in CI. See ADR-009.
- Docs describe the user generically; personal details live in the Firebase profile only. See ADR-010.

### Added
- Wave 1 documentation pack (PRD, architecture, funnel, security, design, roadmap, ADRs, runbook).
- M0 repo + guardrails: npm workspaces (`packages/shared`, `functions`, `web`), strict TypeScript, ESLint (typescript-eslint strict, type-aware) + Prettier, Vitest projects, `npm run check`. See ADR-008.
- Fail-closed gitleaks pre-commit hook; PII scan (`npm run scan:pii`) for emails/phone numbers.
- CI (GitHub Actions, pinned by SHA): `check`, `gitleaks` (full history), `audit` (`npm audit`, high). Required on `main`.
- Dependabot (npm + Actions) and a PR template mirroring the definition of done.
