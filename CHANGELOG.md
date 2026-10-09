# Changelog

All notable changes. Format: Keep a Changelog, SemVer.

## [Unreleased]
### Changed
- Docs: billing-guards plan for M8 (`docs/plans/m8-billing-guards.md`) and a new hard rule against self-triggering code in `CLAUDE.md`.

## [0.7.0] - 2026-10-08
### Changed
- **M7 PR 7A: Today summary bar, loaded after `hf:usable`** (ADR-051; plan `docs/plans/m7-plan.md`).
  - `hf:usable` now marks the first render with the Apply list's first snapshot; the counts no longer gate it. RUNBOOK step 89 notes that v0.7.0 numbers are not comparable with v0.6.x.
  - `SummaryBar` replaces the four tiles and mounts only after `hf:usable` (a skeleton row until then), then renders its row at once: each count has its own skeleton and fails alone, and the last run and the spend chip settle alone. A 60 s interval recomputes now and the next run and is cleared on unmount. An invalid run document shows "Unavailable". Items: open Apply, near miss and wildcard counts (links to Jobs), applied this week against the target, last run (status in words, "Timed out" for a killed run), next run, and the spend meter as a compact chip linking to System. *Judged today* is dropped. *Things to do* stays hidden until the pipeline.
  - Shared: `SCHEDULE` moved to `packages/shared/src/schedule.ts` (re-exported by `functions/src/config.ts`) with the pure `nextScheduledRun` (throws on day 7 and on any time zone other than Europe/London); `todayKpis` became `summaryCounts` with near miss and wildcard split.
  - Services: `summarySpecs`, `loadSummaryCounts` (replaces `kpiSpecs`/`loadTodayCounts`), `lastRunSpec` and `watchLastRun`. No new index.
  - Tests: `nextScheduledRun` with both clock changes, `summaryCounts`, `SummaryBar` roles and names, `TodayPage` (`hf:usable` with the counts pending, no count query before the mark, one failing count, mark order), `indexes.test.ts` for the new specs.
- Docs: ADR-051, PRD R7, DESIGN, ARCHITECTURE, ROADMAP M7 row (now the application pipeline plus the digest), RUNBOOK step 89.

## [0.6.3] - 2026-10-08
### Added
- **Per-step timing marks for Today** (plan: `docs/plans/hf-usable-plan.md`, step 1). `hf:usable` was 2,891 ms median on v0.6.2 against the 2,000 ms limit (ADR-038); these marks show which hop of the load is slow before anything is changed. No behaviour change.
  - `web/src/lib/perf.ts`: `markOnce(name, detail?)` (each name once per page load, never throws, a detail may be a function so a size is computed only for the mark kept) and `hfMarks()` (`[name, ms]` in time order, including the `hf:usable` measure).
  - Marks: `hf:boot`, `hf:firebase`, `hf:appcheck` (hosted only), `hf:auth`, `hf:owner`, `hf:today-mount`, `hf:count:<key>` (`{ok}`), `hf:counts`, `hf:list:<list>` (`{docs, fromCache, bytes}`, first snapshot only). Details are numbers and flags, never job text.
  - RUNBOOK step 89 also prints the marks table after the 3 reloads; `hf:usable` stays the pass/fail.
  - Tests: `perf.test.ts`, the count and list marks in `dashboard.test.ts`, `hf:owner` in `access.test.ts`, `hf:today-mount` before `hf:usable` in `TodayPage.test.tsx`.

### Docs
- Parking lot: limit on the Today counts, the duplicate `config/app` read in SpendMeter, a Firestore persistent cache, counting Today's lazy graph in `check:bundle`, and dedupe across a town and a postcode.

## [0.6.2] - 2026-10-08
### Added
- **M6 PR 6B, session 1: Lookup, the server** (ADR-049). The Lookup screen comes in the web session.
  - **`lookup` callable** (owner only, App Check, 300 s). `add` creates the jobs the owner picked from a pasted LinkedIn results page or a Greenhouse, Lever, Ashby or Workable URL (source `lookup`, `addedAt`, a seen job is never re-created), under the scan lock for the create step only (waits up to 20 s, then answers `busy`). S1 runs at once (a skip is final and free), then S2 on title, company and location, the ATS board search for the full posting, and S3 when there is text, outside the lock. A job with no posting waits for a description (`next: 'description'`). `describe` judges a pasted description (claims the job, re-runs S1 on the text, S2 if there is no triage, then S3; a cap or error sets `next` so the next scan judges it). `parse` reads a pasted page the deterministic parser couldn't, with one cheap-model call (`pasteParse`).
  - **Spend** goes through `llm.call()` under the monthly cap and a **25p daily Lookup cap** (`config/app.lookup.dailyCapPence`). Over a cap, the 200 s deadline or three errors in a row, the rest stays queued and is reported; every write after a model call is a transaction with a precondition, so a scan that moved the job in the meantime wins (`lookup.dropped`).
  - **User-added jobs go first in scans:** S2 and S3 read them (newest `addedAt` first) before the usual order, through the new index `jobs (next, addedAt desc)`; if that read fails the stage logs it and falls back.
  - **ATS board search:** the unique posting of a watched company's board for a job's title (the city decides among several; zero or several is no match), using the scan's modules and HTTP client. It is also a second hydrator in S3, so an alert job waiting for text gets its posting in a scan. The posting's text, source and keys are attached to the job.
  - **No LinkedIn fetch, in code:** the HTTP client refuses LinkedIn, Indeed, Wellfound and Glassdoor (`forbidden_host`) before any request.
  - **Shared:** the funnel steps now live in `funnel/steps.ts` for `runFunnel` and `lookup` (`run.test.ts` and the eval unchanged); `parseLookupInput`, `parseResultsPage`, `parseAtsUrl`, `ageToPostedAt` and the callable schemas in `packages/shared/src/lookup.ts`; source `lookup`, `Job.addedAt`, `Job.describingAt`, the flag `posted_estimated` (an age such as "3 days ago" gives an approximate `postedAt`, kept through a re-score).
  - `npm run dev` seeds two Lookup-added jobs; emulator tests cover the precondition writes, the claim, the attach, the queries, the daily cap under concurrency and the R8 match by ID.
- **M6 PR 6B, session 2: Lookup, the web** (ADR-049). M6 is done.
  - **Lookup screen** (`/lookup`, lazy). Paste job links to see whether each has been seen: **Seen** shows the verdict (or where it waits), the stage it stopped at, first-seen and judged dates, and opens the job; **Not seen yet** offers **Add from the job board** for a Greenhouse, Lever, Ashby or Workable link, or **Add by hand** (title, company, optional description) for any other. Matching is a plain read of your jobs (by source key, then by canonical URL), so it costs nothing and works during a scan.
  - **Results page.** Copy a LinkedIn search results page (select all, copy) and paste it: a preview lists the jobs read, marks the ones already seen, and **Add n jobs** judges the ticked ones at once, with a per-job outcome (verdict, skipped and why, needs a description, queued, review). A scan holding the lock answers "adding will work in about n min"; a cap lists which jobs were queued. A page nothing can read offers **Let the model try** (one small call). The page's HTML is read only for its job links, with `DOMParser`, and never inserted into the page.
  - **Waiting for a description** on Lookup lists the jobs that need one (alert jobs and ones you added): **Open on LinkedIn** (or **Search on LinkedIn**) and **Paste description** → **Judge**. The job sheet has the same paste control for such a job, and marks a job **Added by you**.
  - **Today → Added by you** (newest 5, with each job's state; hidden when empty; read only after `hf:usable`) and **Jobs → Added by you** (a standalone filter, paged, like Needs review). Rows without a verdict show where they stand.
  - **Query specs and indexes:** `lookupKeysSpec`, `lookupUrlSpec`, `needsDescriptionSpec` and `addedByYouSpec`, checked against `firestore.indexes.json` ("serves every Lookup query"). No new client writes, rules or index.
  - **Bundle:** initial JS 292.9 → 293.1 kB gzip (limit 300); Lookup (5.2 kB), its paste control (5.1 kB with the Functions SDK) and the job sheet (5.7 kB, now shared) are lazy chunks.

### Fixed
- **Review of PR 6B.**
  - **The HTTP client checks every redirect.** It follows at most 3 hops by hand and refuses a hop to a forbidden host (`forbidden_host`) before any request. The forbidden list is now the default for every client (the watchlist detector included) and covers `angel.co`, `lnkd.in` and the Indeed and Glassdoor country domains.
  - **Board host pauses are carried and saved** for the scan's ATS hydrator and for Lookup: a Retry-After beyond the cap is honoured by the next scan and Lookup, on the ATS source's health record.
  - **A dead `describe` no longer strands a job.** The expiry sweep returns a claim older than 10 minutes with no verdict to `next: 'description'` (`funnel.describe_released`); `describingAt` joins the funnel fields.
  - Tests: redirects and the default list, the hydrator's wiring and deadline, the sweep, the unretried Lookup call, and the R8 match through the web specs with verdict and dates. Invented title, town and salary replace strings that looked copied from a real paste.

### Changed
- **The results-page parser reads the real LinkedIn copy format.** A card is its title twice on one line (a verified job has ` (Verified job)` between the copies), then the company, the location (a bare town, or with `(Hybrid)` / `(Remote)` / `(On-site)`), badges and alumni lines, a salary such as `27K GBP/yr`, `Viewed`, and an age that is also doubled (`Posted 1 week ago1 week ago`). Cards are found by the doubled title, so bare towns work; the age is read once. The assumed format and its fixture are replaced (fake values only). A copy that begins mid-card loses that card.
- The Lookup nav entry's text no longer says "Coming soon".

## [0.6.1]
### Added
- **Funnel intake PR B (ADR-045).** S1 now skips sales titles (`Sales Executive`, `Sales Representative`, `Sales Development`, `Sales Associate`, `Account Executive`, `Business Development`, `SDR`, `BDR`) after the panel counted 43 S2 skips, no good job and no job waiting for S3 among them; Sales Engineer, Presales and Solutions Consultant still pass, and the Sales Executive, Sales Representative, Sales Development and Sales Associate terms allow a `Pre` prefix (Pre-Sales Associate) while Business Development allows `Solutions Engineer`. C1 to C3 were rejected (they hit good jobs), C5 and C6 are not built. System gets "Recent S1 skips by rule" (the last 7 days, 20 per rule, with a new `(skip.ruleId, judgedAt)` index) for a first-week spot-check. Title-table rows for the new rules.

### Changed
- `s3MaxJobs` default 25 → 32. ADR-032 amendment: the intake-based sizing is approved at `monthlyCapPence` 3200 (lease 52p); set it in the console after deploy.
- Recent runs show expired jobs apart from skips (`S2 3 passed, 4 skipped, 1 expired`).

### Fixed
- **Gmail bridge: "Could not decode string".** The Advanced Gmail service's `payload.body.data` can be a byte array, unpadded base64url or standard base64, not only padded base64url. Decoding now reads bytes as UTF-8 directly, tries `base64DecodeWebSafe`, then standard base64 (`-_` mapped to `+/`, padded), and honours the part's charset (UTF-8 by default). `readMessage` never throws: an undecodable part is skipped, a message with no readable part stays under `hireframe/alerts` and is counted as `unreadable` in the run summary, and the other messages are still sent. Logs carry only a fixed code, `typeof data` and the branch that worked. RUNBOOK G6 uses `--rootDir build` and says to open the project by its script ID, and notes the temporary `roles/cloudfunctions.admin` grant a new non-callable HTTPS function needs on its first deploy.

## [0.6.0]
### Added
- **M6 PR 6A: the Gmail bridge** (ADR-046, ADR-047, ADR-048). LinkedIn, Work at a Startup, Escape the City and the other alert-only boards now reach Hireframe through your own Gmail:
  - **Apps Script** (`/apps-script`, TypeScript, `npm run build:apps-script`, pushed with clasp, pinned in the workspace and run as `npm exec -w apps-script clasp`): every 30 minutes it takes the oldest 20 messages labelled `hireframe/alerts` and sends only `{ id, receivedAt, from, text, html }` (never a subject, recipient or other header) in signed POSTs bounded by bytes (each under about 900 kB, at most 5 messages; one oversize message is cut to fit and sent alone). A message is relabelled `hireframe/done` only when the server says `processed`, `duplicate` or `unparsed` for it; `busy`, `deferred`, an error or a timeout leave the label, so the next trigger retries. Advanced Gmail service with the `gmail.modify` scope, not `GmailApp`.
  - **`ingestEmailJobs`** (an HTTPS function, publicly invocable, one instance serving one request at a time): HMAC-SHA256 over `v1.<timestamp>.<nonce>.<raw body>` verified on the raw bytes, skew at most 300 s, the nonce kept 10 minutes in `nonces/{nonce}` (TTL policy) so a replayed request is a 401, constant-time compare, the same 401 for every signature, skew or replay failure and no body echoed or logged. Both sides trim the secret. A new secret, `INGEST_HMAC_SECRET` (RUNBOOK Part G).
  - **Parsing.** Routing is on the exact `From` address (the subject is never read). `jobalerts-noreply@linkedin.com` goes to a deterministic card parser (job ID from any `/jobs/view` URL form, canonical URL with no tracking, `Company · Location (Hybrid|Remote|On-site)`, a bare town takes the alert's country, optional salary, Easy Apply kept on its source). An auto-forwarded copy parses like a direct one. Anyone else goes through one cheap-model call (`alertParse`, Haiku, 10p a day by default) with the email as untrusted data; the model returns an index into the links read from the HTML, so it can't plant a URL. A link off the host allowlist keeps the job, stored on its source only as an unverified link, and the job's own link is a LinkedIn search link labelled "Search link".
  - **Dedupe.** Alert jobs dedupe through the same `keys[]`, so an alert and a Greenhouse posting of the same role are one job in either order (PRD R5), and `linkedin:{id}` is in `keys` for Lookup (R8). Each message is recorded by hash, so a retry is a `duplicate`.
  - **The lock.** Ingest and scans never write at once: `locks/scan` has a `holder` and a `staleAt`; ingest holds it as `email` for at most 3 minutes and never starts the manual-scan cooldown; `scheduledScan` waits up to 4 minutes (every 15 s) for an `email` holder instead of skipping, and still skips for a scan.
  - **Needs a description.** An alert has no description, so S3 sends such a job (or one with under 200 characters of full text, or no description document; a snippet-only job still gets its deep read) to the new `next: 'description'` state, free: no model call, no slot, flag `needs_description`, counted as `s3.needsDescription`. A merge that brings a full description (an ATS posting arriving in a scan) writes the text, fills `postedAt` and sends the job to S3. The expiry sweep covers the new state.
  - **Screens.** System has a Gmail alerts card (last ingest, counts, a table per sender, and a failing status when emails can't be read) and "Waiting for a description: n". The job sheet shows "Easy Apply on LinkedIn", "unverified link" beside the link's host (linked only over https), "Search link" and a "Needs a description" note.
  - **Review fixes.** Scan and funnel deadlines count from the function's invocation, not from when the lock was taken after a wait. A description upgrade needs full text of at least 200 characters that is longer than what is stored (the longest full member wins). Hydrator calls happen only for a job that will be sent (inside `s3MaxJobs`, the deadline and the lease). The alert model window (15 s) plus its budget (35 s) fit inside 50 s, under Apps Script's 60 s fetch limit. The script signs and sends the same UTF-8 bytes (`·` and `£` verified end to end). Firestore is not touched before the signature verifies.
  - `npm run dev` seeds an alert job waiting for a description, and `node scripts/sign-test-alert.ts` posts a fake alert (`--twice` shows a replay refused).
- A daily cap mechanism for model purposes (`usage/{month}.daily`, optional), shared with Lookup in 6B: checked in the same transaction as the monthly cap, and charged for stale reservations too.
- ADR-046, ADR-047 and ADR-048; ARCHITECTURE, FUNNEL, SECURITY (the HMAC replay test is ticked) and RUNBOOK Part G.

### Changed
- `findJobsByKeys` reads through a query spec (`jobsByKeysSpec`) checked against the index file; `SpecOp` gains `array-contains-any`.
- `locks/scan` documents written before this release still work (no holder means a scan, and the 12 minute stale time applies).
- `CHANGELOG`: the earlier `[Unreleased]` items are filed under the versions they shipped in, `0.5.4` (expiry sweep and S2 skip-reasons panel) and `0.5.5` (sort and filter).

## [0.5.5]
### Added
- **Sort and filter on Today and Jobs** (ADR-044). Sort by Best overall (fit + luck), Fit, Luck or Newest. Jobs also gets a Lane filter (Primary, Secondary, Opportunistic) and, for near misses, a Gap filter (Tool, Domain, Seniority, Tool only: a near miss whose every gap is a tool). On Jobs they live in the URL (`?sort=best&lane=primary&gap=tool`). Newest still pages with **Load more**; any other sort or filter reads the newest 300 matching jobs once, sorts in the browser and shows 25 at a time (**Show more**), with a note when the read hit 300. On Today each list has a Sort select over its 10 rows (Apply defaults to Best overall, the others to Newest, remembered per list in this browser) and Near misses a Gap select; when a list is full the footer links to the same view on Jobs. No new queries or indexes, and Today's first load is unchanged.

### Changed
- **The job sheet's "Mark applied" toggle is now "Apply"**: solid green (the Apply colour) until set, then a hollow green "Applied" with the check icon. Still a pressed toggle; contrast holds in both themes.

## [0.5.4]
### Added
- **Expiry sweep** (ADR-043). Every run, after S1 and before the spend lease, queued jobs older than `freshness_days` (14) leave the S2 and S3 queues as a free `freshness` skip, however deep they sit. Before, only the newest 300 (S2) and top 50 (S3) were ever looked at, so the rest stayed queued for ever and inflated the queue counts. It needs no lease, so it also runs at the monthly cap or with no profile, and counts into `s2.expired` and `s3.expired`. New `FunnelStore.staleQueued`, `expireMaxJobs` in `FunnelLimits` (2,000 per stage; the rest waits for the next run) and `freshnessCutoff` in shared. A sweep error no longer stops the run: it is logged, recorded as `funnel_sweep_failed` (run partial) and the stages carry on. Jobs the sweep reads but keeps are logged as `funnel.sweep_drift`.
- **"S2 skip reasons" panel on System** (ADR-043). Press Load to count, from your own jobs, why S2 skipped jobs (by lane, seniority, lane × seniority and blocker category), what each candidate S1 rule (C1 to C4) would have skipped among S2 skips, good jobs and jobs waiting for S3, and how many queued jobs have no `sortAt`. Counts only: "Copy counts" copies rule IDs, enum values and integers, never job text. Reads no descriptions yet (C1 to C4 are title rules), and sits in an error boundary so a failed lazy chunk shows a reload message. Needs the new `(skip.stage, judgedAt)` index (wait for **Enabled** under Firestore → Indexes; the panel says "Index building" until then).
- Docs: the intake-sizing method for the per-run budget (FUNNEL.md and an ADR-032 amendment draft). **No cap, lease or budget config changes.**

### Changed
- `QuerySpec` and `indexServes` moved to `@hireframe/shared`, and the `<` range op was added (ADR-040 amendment). Functions builds its new stale-queue query from a spec checked against `firestore.indexes.json`.
- `applyHardRules` and `checkTitle` take an optional seniority-ID list (default unchanged), so the panel can try a candidate seniority rule as lane titles can't override it.

## [0.5.3]
### Fixed
- **A job no longer vanishes while its own write is pending** (ADR-041). Pressing 👍 or Save made the local snapshot carry `null` for the server-stamped fields (`updatedAt`, `appliedAt`, `feedback.at`), which failed the schema, so Today's lists dropped the job and the sheet said it couldn't be read (`jobs.invalid` logged twice). All job reads now use estimated server timestamps. The agreement read does too.
- **Actions no longer reload the Jobs list.** The row and the sheet update in place; scroll, keyboard focus and loaded pages stay. If the write is refused, the job goes back to how it was and the error shows. "Load more" can no longer append a job twice, and an edit made while it loads is kept.
- **Rating buttons show the current rating** as filled, and can be changed (👎 reopens the form with the earlier note and expected verdict; pressing the selected 👍 again does nothing).

- **Take a rating back.** Pressing the selected 👍 or 👎 again removes the rating, with no dialog; the other button still switches it. `firestore.rules` lets the owner delete the whole `feedback` field together with `updatedAt` and nothing else, and a new create-only event `job_feedback_removed` records the rating that went (ADR-038). Agreement stops counting a removed rating.
- **Save, Skip and Mark applied are single toggle buttons** in the sheet: same place and icon, `aria-pressed`, selected style while on, label flips (Save/Unsave, Skip/Unskip, Mark applied/Undo applied). The separate Unsave, Unskip and Undo buttons are gone. The `a` and `s` keys toggle the same way (`s` on an applied job still does nothing).

### Changed
- The 👎 form no longer opens with the earlier note: pressing the selected 👎 removes it, so a note is changed by rating 👎 again.
- **Initial JS is 6.7 kB gzip smaller** (300.0 → 293.6 kB; ADR-042). The shell no longer loads every shared schema: `FUNCTIONS_REGION` moved to a pure module and `@hireframe/shared` is marked side-effect-free. Fixes the `check:bundle` failure on this PR; the budget is unchanged.

### Added
- `jobs.invalid` now logs the failing field names (never values).
- Tests: the emulator reproduction of the pending snapshot, `readJob`, the optimistic builders, `performJobAction` (patch, rollback, busy), list focus, in-place Jobs list, rating state.

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
