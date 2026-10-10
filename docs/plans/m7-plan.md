# M7 Application pipeline + digest: plan

**Changed from the ROADMAP.** M7 used to be "Digest + CV tailoring". It is now an application pipeline plus the digest. The ROADMAP M7 row, PRD R7, R9 and R10, ARCHITECTURE, DESIGN and FUNNEL S4 are updated in the PRs that change them, listed per PR below.

**Four PRs. Each branches from `main` after the previous one merges (never stacked) and gets its own tag.**

| PR | Branch | Tag | What | Sessions |
|---|---|---|---|---|
| 7A | `feat/m7a-today-bar` | v0.7.0 | Today summary bar, loaded after `hf:usable` | 1 |
| 7B | `feat/m7b-digest` | v0.7.1 | `getDigest` and the Apps Script mailer (no Pipeline line yet) | 2 |
| 7C | `feat/m7c-cv-engine` | v0.7.2 | Server only: CV schema, validator, renderer, the `cvWrite` purpose | 2 |
| 7D | `feat/m7d-pipeline` | v0.7.3 (M7 done) | `application` callable, the scheduled CV worker, Pipeline screen, badge, the digest's Pipeline line | 4 |

**Every session:**
- is sized for Sonnet · Medium: one area, a short file list, tests written alongside the code;
- ends with `npm run check`, `npm run test:rules`, `npm run build`, `npm run check:bundle`, `node scripts/smoke-functions-bundle.ts`, and a list of deviations from this plan;
- uses small Conventional Commits.

The last session of each PR also adds the CHANGELOG entry and the ADRs.

## Context
Today a job has one disabled **Generate CV** button (`JobDetail.tsx`, "Arrives with CV tailoring (M7)"). Nothing in the repo generates a CV or sends a digest. What exists already:
- `COLLECTIONS.cvs`;
- owner-read rules on `cvs/{cvId}` and Storage `cvs/**`;
- the `cvs/{cvId}` shape in ARCHITECTURE.

The owner wants three things:
- **An application pipeline per job.** It runs Chosen → Needs your input → Generating → Ready to send → Applied, and each job moves on its own.
- **One-page CVs and cover notes.** Every claim cites a profile fact (ADR-006, PRD R10), delivered as .docx and PDF. A scheduled worker generates them in the background with a realtime `llm.call()`.
- **A morning digest (PRD R9).** Apps Script sends it at 07:50 on weekdays.

Today's four tiles also become a summary bar that loads after `hf:usable`. That takes the counts off the critical path: v0.6.2 measured `hf:usable` at 2,891 ms against a 2,000 ms limit, and the counts were part of the gate.

**Decisions from the plan questions:**
1. **Chosen auto-advances.** Start application checks the job at once and moves it on. A job stays in Chosen only while it is blocked (cap, error, no CV header), and Chosen offers Retry there.
2. **Questions come from the job's stored S3 requirements**, computed in code, with no model call. Each question can be skipped on its own, and **Skip all** skips the rest.
3. **The summary bar replaces the four tiles**, with spend shown as a chip inside it. Everything in the bar mounts after `hf:usable`.
4. **The CV header** (name, email, phone, location, links) is a new owner setting on Profile, stored in `profile/cvHeader` and written under rules. Code inserts it into the CV; the model never sees or writes it.

**Decisions from the plan review:**
5. **No Message Batches in M7.** Generation is a realtime `llm.call()` from a scheduled worker. Batches would save about £1 a month and add a wait of up to 24 h, so they go to the ROADMAP parking lot (ADR-053).
6. **PR order:** Today bar, digest, CV engine, pipeline. The digest ships without the Pipeline line, and the pipeline PR adds it.
7. **In the CV prompt, the S3 requirements and talking points are untrusted text**, wrapped like the posting.

**What we build on:**
- **LLM layer:** `llmCall` (`functions/src/llm/call.ts`: count tokens → reserve the worst case → send → settle), `firestoreUsageStore` and `dailyCapped` (`usage-store.ts`, `DAILY_CAP_KEYS`), `wrapUntrusted`.
- **Facts and requirements:** `factAliases` / `FACT_ALIAS_PATTERN` (`shared/score.ts`) and `loadProfile` (`funnel/store.ts`). The S3 output `JobDeepSchema.requirements` (`shared/funnel.ts`) is `{text, level, type, match, gap, factIds}`.
- **Adding facts:** the core of `addFactHandler` (`profile/addFact.ts`) and `store.addManualFacts`.
- **HMAC:** `verifyRequest` / `signRequest` (`ingest/hmac.ts`), `firestoreNonceStore`, `signing.ts` (shared with Apps Script), `createSigner` (`apps-script/src/sign.ts`), and the `runBridge` pattern of a pure core with injected dependencies.
- **Runs:** `SCHEDULE` (`functions/src/config.ts`), `RunSchema`, `isRunStalled`.
- **Today and the web:**
  - Today: `kpiSpecs` / `loadTodayCounts` (`web/src/services/dashboard.ts`), `todayKpis` (`shared/metrics.ts`), `SpendMeter`, `markOnce` (`web/src/lib/perf.ts`), and the AddedByYou mount pattern (`{usable ? … : null}`).
  - Job writes: `performJobAction` and `buildJobStatusWrite` (`services/job-writes.ts`), and `commitAction`, a batch of the job and its event (`services/jobs.ts`).
  - Queries and screens: `indexServes` and the specs in `indexes.test.ts`; `listen()`/`LiveState`; the callable client pattern (`services/lookup.ts`: zod in and out, never retried); `NAV_ITEMS` + the lazy `PAGES`.
  - Dev and tests: `scripts/dev-seed.ts`; mammoth and unpdf, already dependencies, to read CVs back in tests.

ADR numbering: **ADR-050 stays reserved** for the `hf:usable` prefetch (hf-usable plan step 2). M7 uses **ADR-051 to ADR-055**, in PR order.

---

## PR 7A: Today summary bar (`feat/m7a-today-bar`, v0.7.0)

### Session 7A.1 (web + shared)
- **`hf:usable` is redefined:** the first render with the Apply list's first snapshot. The four counts no longer gate it. The measure stays a `performance.measure` from 0, and the RUNBOOK step 89 conditions are unchanged.
- **`SummaryBar`** (`web/src/features/today/SummaryBar.tsx`) replaces `Tiles`. It mounts only after `usable`, like AddedByYou, and shows a skeleton row until then. Every item is a label, number and icon (never colour alone):
  - **Open Apply / Near miss / Wildcard:** three separate counts, `verdict == X`, `status in [new, saved]`, in the verdict colours. Each links to `/jobs?verdict=…&status=new`.
  - **Things to do:** hidden in 7A. The slot is wired in 7D.
  - **Applied this week n / weekly_target.**
  - **Last run:** the newest `runs` doc by `startedAt desc`, limit 1 (single-field index): its time and status, with "timed out" when `isRunStalled`.
  - **Next run:** from `nextScheduledRun(now, SCHEDULE)`.
  - **Spend chip:** `SpendMeter` in a compact form (amber from 80%), linking to System.
- **Shared:**
  - `SCHEDULE` (cron and time zone) moves to `packages/shared/src/schedule.ts`; `functions/src/config.ts` re-exports it.
  - `nextScheduledRun(now, schedule)` is pure and supports only the `M H1,H2 * * D1-D5` form the app uses, in Europe/London.
  - `todayKpis` → `summaryCounts`: `judgedToday` is dropped (the digest carries it), and near miss and wildcard are split.
- **Services:**
  - `dashboard.ts`: `summarySpecs(now)` replaces `kpiSpecs`. These are four counts, each settling on its own (`Promise.allSettled`, ADR-040).
  - `lastRunSpec`, and `watchLastRun` (live, limit 1).
  - The marks `hf:count:*` and `hf:counts` stay, now after `hf:usable`.
- **Indexes:** the near miss and wildcard counts are served by `(verdict, status, judgedAt desc)`. `indexes.test.ts` covers `summarySpecs` and `lastRunSpec`.
- **Docs:**
  - ADR-051.
  - PRD R7: the Today line becomes "summary bar"; the R7 measure wording changes.
  - DESIGN.md: Today.
  - ARCHITECTURE: Today line.
  - RUNBOOK step 89 notes that the definition changed and that v0.6.3 measures aren't comparable.
  - The ROADMAP M7 row is rewritten.
  - CHANGELOG 0.7.0.

### Tests (7A)
- `nextScheduledRun`, table-tested with a fake clock:
  - Mon 07:29 → 07:30; 07:30 → 17:30; Fri 17:31 → Mon 07:30; Sat → Mon;
  - the March and October clock changes (the 29 Mar 2026 and 25 Oct 2026 Sundays and the Monday after each);
  - a cron form it doesn't support throws.
- `summaryCounts` (pure).
- `TodayPage.test.tsx`:
  - `hf:usable` is marked with the counts still pending (a deferred promise);
  - no count query starts before the mark (spy on `loadSummaryCounts`);
  - the bar shows a skeleton, then the numbers;
  - one failing count shows "–" and leaves the others intact;
  - the marks come in order `today-mount` < `list:apply` < `usable` < `counts`.
- `SummaryBar` role tests: links and accessible names that don't rely on colour.
- `indexes.test.ts` for the new specs.
- `check:bundle`: the initial JS doesn't grow. The bar lives in the lazy Today chunk.

### PRD acceptance (7A)
- **R7:** Today is still usable in < 2 s on 4G, under the new definition (RUNBOOK step 89: 3 repeat visits, median ≤ 2,000 ms), and Lighthouse a11y is ≥ 95.
- **R11:** the live spend meter stays on Today.
- **R12:** the last run's status is visible on Today as well as System.

### ADR (7A)
- **ADR-051 Today summary bar, loaded after `hf:usable`.**
  - It replaces the four tiles.
  - It amends ADR-038's R7 measure: `hf:usable` now waits only for the Apply list. The counts are secondary information, and every count read grows with the number of jobs (hf-usable plan §3).
  - Last and next run, and the shared `SCHEDULE`.
  - Consequences: the hf-usable plan's step 2 (prefetch, ADR-050) is re-judged on the v0.7.0 numbers. If the median is ≤ 2,000 ms, step 2 is parked.

---

## PR 7B: digest (`feat/m7b-digest`, v0.7.1)

The digest ships without a Pipeline section; 7D adds it.

### Session 7B.1: `getDigest` (`functions/src/digest/`)
- **`endpoint.ts`:** `onRequest`, publicly invocable (the HMAC is the authentication), 60 s, 512 MiB, `maxInstances: 1`, `concurrency: 1`, `cors: false`. It mounts **only** `INGEST_HMAC_SECRET`. No model call is made.
- **Signing:** POST with the JSON body `{ kind: 'morning' | 'fallback', day: 'YYYY-MM-DD' }`, signed like ingest but with the prefix **`digest.v1.`** for domain separation, so a signed ingest request can never be valid here, or the reverse.
  - `signing.ts`: `signingString(…, purpose)`. Ingest keeps `v1.` unchanged.
  - `verifyRequest` takes the prefix.
  - The nonce store is shared.
  - Errors are uniform 401 / 400 / 413, the same as ingest.
- **`store.ts`** (reads only):
  - the newest 10 runs by `startedAt desc`, filtered in code to `trigger == 'schedule'`, today in London, started before 12:00;
  - jobs per verdict judged since the previous morning run started, with `status in [new, saved]`: `(verdict, judgedAt desc)`, limit 11, so "+n more";
  - `usage/{month}`;
  - `sources/*` health;
  - the waiting-for-description count.
- **`state.ts`** (pure) picks the digest's state:
  - `ready`: the run `succeeded` or was `partial` (partial adds a "some sources failed" notice);
  - `failed`: the run `failed` or `isRunStalled`;
  - `in_progress`: the run is still `running`, or there is no run yet before 08:15;
  - `missing`: no morning run by 08:15.
- **`render.ts`** (pure) → `{ subject, html, text }`. The sections follow R9:
  - Apply (fit, luck, reason);
  - Near misses (shortfall);
  - Wildcards;
  - Run health (status, failing sources by code, S2/S3 counts, waiting for a description);
  - Spend (pence of the cap, the **80% warning**, deep reads paused);
  - Errors (the run's error codes).

  It takes an optional `pipeline` section that 7D fills in.

  **Escaping and links:**
  - Every job-derived string is HTML-escaped.
  - Links point only to the app (`APP_ORIGIN/?job=<id>`, Today's existing sheet link), never to a posting URL.
  - No tracking and no images.
- **Shared:** `DigestRequestSchema`, `DigestResponseSchema`, `CALLABLE_TIMEOUT_SECONDS.getDigest = 60`; `APP_ORIGIN` in functions config.
- **Tests:**
  - HMAC: the ingest tests reused with the digest prefix, plus an ingest-signed request refused here and a digest-signed one refused by ingest; replay; skew.
  - `state.ts` on a fake clock: every state, around 08:15, and a stalled run.
  - `render.ts`: escaping (`<script>` in a title stays text); every section present or "None today"; the 80% warning at 79/80/100%; partial-run notice; no posting URLs in the output.
  - `index.test.ts`: options and secrets.
  - Emulator: a signed request against seeded runs returns `ready`.
  - Logs hold no job text.

### Session 7B.2: Apps Script mailer (`apps-script/src/digest.ts`, `main.ts`)
- **`digest.ts`** is a pure core with injected `{ now, props, post, signer, uuid, sendMail, lock }`.
  - **`digestMorning()`:** on a weekday in London only, and if the property `lastDigestDay` isn't today, it POSTs `kind: 'morning'`.
    - `ready`, `failed` or `missing` → send, and set `lastDigestDay`;
    - `in_progress` → send nothing, so the fallback handles it.
  - **`digestFallback()`:** if not yet sent today, it POSTs `kind: 'fallback'` and sends whatever comes back, including the explicit in-progress notice. If the request itself fails (network, non-2xx, bad response), it sends a plain "Hireframe digest unavailable (code)" email itself. **The digest is never silently absent.**
  - Both run under `LockService.getScriptLock()`, so the two triggers' ±15 min windows can't double-send.
- **`main.ts`:**
  - `sendMail` is `MailApp.sendEmail({ to: Session.getEffectiveUser().getEmail(), subject, htmlBody, body })`: the owner's own address, with no address in code or properties;
  - `setup()` deletes and recreates the triggers by handler name: `run` every 30 min, `digestMorning` daily at `atHour(7).nearMinute(50)`, and `digestFallback` daily at `atHour(8).nearMinute(20)`;
  - `digestNow()` for a manual test.
  - The build footer gains the new global handlers.
- **`appsscript.json` scopes:** adds `script.send_mail` and `userinfo.email` (for the effective user's address).
- **Script Property** `HIREFRAME_DIGEST_URL`.
- **Tests (`digest.test.ts`):**
  - weekend → nothing;
  - morning sends on `ready`, `failed` and `missing`, and not on `in_progress`;
  - the fallback sends after a skipped morning and does nothing after a sent one;
  - the fallback's network failure sends the "unavailable" email;
  - the lock prevents a double send;
  - the body is signed with the digest prefix and verifies on the server (`bridge-compat.test.ts` gains a digest vector);
  - `setup()` keeps exactly three triggers after running twice;
  - `scripts/apps-script-tooling.test.ts` checks the scopes.
- **Docs (end of 7B):**
  - ADR-052;
  - PRD R9 (07:50 weekdays, the fallback at 08:20);
  - ARCHITECTURE (`getDigest` row, Gmail bridge section: digest half, scopes);
  - SECURITY (Gmail over-access row: `send_mail` and `userinfo.email`, sending only to the effective user; the HMAC row: the digest prefix);
  - RUNBOOK Part I digest steps;
  - CHANGELOG 0.7.1;
  - CLAUDE.md commands (`sign-test-alert.ts` digest mode).

### PRD acceptance (7B)
- **R9 AC:** sent only if the run succeeded, or with an explicit failure or in-progress notice; never silently absent. Covered by the morning/fallback pair and the "unavailable" email, with each path tested.
- **R11:** the 80% warning appears in the digest.
- **R12:** error alerts appear in the digest.

---

## PR 7C: CV engine, server only (`feat/m7c-cv-engine`, v0.7.2)

There is nothing for the owner to see yet. 7C ships the parts 7D wires together, each fully unit-tested.

### Session 7C.1: shared schemas, pure logic, the `cvWrite` purpose

**Shared** (`packages/shared/src/applications.ts`, `cv.ts`):

**`APPLICATION_STAGES`:** `chosen | needs_input | generating | ready | applied | withdrawn`.

**`ApplicationSchema`**, stored at `applications/{jobId}`:
```ts
{ jobId,
  job: { title, company, verdict },     // snapshot for lists
  stage, stageBefore?,                  // stageBefore: only while stage is 'applied'
  stageAt, startedAt, updatedAt,
  blocked?: { code: 'cap' | 'daily_cap' | 'no_deep_read' | 'cv_header_missing' | 'invalid_output' | 'attempts_exhausted' | 'error', at },
  questions: [{ id, requirement ≤200, level, type, match,
                answer?: { kind: 'fact', factIds[] } | { kind: 'skipped' } }],
  attempt: 0 | 1 | 2, lastIssues?: string[],   // issue codes from the last invalid output
  notes? ≤500, cvIds[], currentCvId?, schemaVersion }
```

**`questionsFromRequirements(deep)`:**
- takes requirements where `match !== 'met'` and `type !== 'logistics'`;
- orders must before nice, missing before partial;
- returns at most 5;
- gives each a stable `id` from a hash of the requirement text.

**`CvContentSchema`** is the model's output schema, with every citation an F-alias:
```ts
{ summary: { text ≤300, factRefs ≥1 },
  experience: [{ heading: { role ≤80, org ≤80, factRef }, bullets: [{ text ≤220, factRefs ≥1 }] ≤5 }] ≤4,
  projects:   [ same shape ] ≤3,
  education:  [{ line ≤160, factRef }] ≤3,
  skills:     [{ label ≤40, factRefs ≥1 }] ≤16,
  coverNote:  { paragraphs: [{ text ≤600, factRefs ≥1 }] 2–4 } }
```

**`validateCv(content, aliases, facts)`** returns `{ ok } | { issues: [{ path, code }] }`. It is pure, and the codes are:
- `uncited`: a citation is missing;
- `unknown_fact`: an alias that isn't in `aliases`, or a fact that is now archived;
- `wrong_fact_type`: an experience heading cites an `experience` fact, a project heading a `project` or `experience` fact, an education line an `education` fact, a skill `skill` facts; nothing cites a `preference` fact, and only the summary and the note may cite a `constraint` fact;
- `unsupported_text`: the words of a heading, education line or skill label are in the cited fact (ADR-054);
- `unsupported_number`: every figure (number, number word, `%`, currency amount, `k`/`m`/`b`, multiplier, ordinal, plural, fraction, `10+`) in a text must appear, by value and kind, in the text or evidence of a fact it cites;
- `contact_in_text`: an email, phone number or URL in model text (contact details come only from the header);
- `too_long`: past the length limits.

**Dates are never model text:** code takes them from the cited heading fact's `dates`.

**`trimOrder(content)`** is a pure, deterministic list of removals for the one-page fit. In order:
1. the last bullet of the longest experience entry, repeated;
2. then projects;
3. then skills over 10;
4. then the summary;
5. never the headings or education.

`COLLECTIONS.applications`, `PATHS.application`, `PATHS.cv`, `STORAGE_PATHS.cvFile(cvId, 'cv' | 'cover-note', 'pdf' | 'docx')`.

**`CvHeaderSchema`**, stored at `profile/cvHeader`: `{ name ≤80, email (zod email) ≤120, phone? ≤40, location? ≤80, links? https ≤200 ×3, createdAt, updatedAt, schemaVersion }`.

`CvDocSchema` for `cvs/{cvId}`: `{ jobId, applicationVersion n, content, aliases, factIds[], storagePaths { cvPdf, cvDocx, notePdf, noteDocx }, trimmed, notes?, model, costPence, createdAt, schemaVersion }`. The `cvId` is `<jobId>-v<n>`.

`EventSchema` gains `application_stage { jobId, from, to, at }`, written by the server only; the rules don't let a client create it.

**Functions config** (`functions/src/config.ts`):
- purpose `cvWrite`: `claude-sonnet-5-5`, effort `medium`, `maxTokens` 8,000, `timeoutMs` 150 s, `budgetMs` 300 s (the call plus its invalid-output retry), bounded by the worker's 540 s timeout (`CALLABLE_TIMEOUT_SECONDS.generateCvs = 540`; the timeout table is where budgets are checked, as for `ingestEmailJobs`);
- purpose `answerFact`: Haiku, the `addFact` prompt, under the `application` callable;
- `DAILY_CAP_KEYS` gains `application`;
- `APPLICATIONS = { dailyCapPence: 60, maxQuestions: 5, maxAttempts: 2, workerMaxPerRun: 10, workerStartDeadlineMs: 210_000 }` (it was 300_000 in the first plan; 300 + 300 + 30 s is 630 s and cannot fit the worker's 540 s, so the deadline is 540 − `budgetMs` 300 − margin 30 = 210 s; ADR-053);
- overrides from `config/app.applications` (an `unknown` parsed on its own, like `lookup`);
- `config.test.ts`: `budgetMs + callableMarginMs ≤ 540 s`, and `workerStartDeadlineMs + budgetMs + margin ≤ 540 s`, so a call started at the deadline still settles before the function is killed.
- **Daily cap sizing (realtime prices):**
  - Sonnet 5.5 costs $2/$10 per MTok, FX 0.85.
  - A typical CV is about 10k tokens in and 3k out: about 4.3p.
  - The worst-case reservation is about 12k in and 8k out: about 8.8p, so about 17.7p with the retry.
  - The **60p** daily cap allows at least 3 jobs a day even if every one needs its retry at worst-case reservation, and about 14 typical CVs.
  - At 10 applications a week, typical spend is about £1.85 a month.

**Tests:**
- questions: met excluded, logistics excluded, ordering, cap of 5, stable IDs;
- `validateCv` against a valid fixture, plus one fixture per issue code. This includes "led a team of 12" citing a fact without 12, and a bullet citing an archived fact;
- `trimOrder` is deterministic;
- the schemas reject extra keys;
- `config.test.ts` budget checks.

All fixtures use the fake candidate's facts.

### Session 7C.2: renderer (`functions/src/cv/render/`)
- **PDF uses `pdf-lib`** (pure JS), not `@react-pdf/renderer` (ADR-054):
  - A4, a single column, standard Helvetica (no font files), 10/10.5 pt, 15 mm margins;
  - our own word-wrap using `font.widthOfTextAtSize`, so the page count is exact.
  - `renderCvPdf(header, content, facts)` → `{ bytes, pages }`, and `renderNotePdf`.
  - Text outside WinAnsi (Helvetica's encoding) is a validation issue (`unsupported_char`), never dropped silently.
- **DOCX uses `docx`** (npm): the same content and the same spacing, Arial (metric-compatible with Helvetica), real headings and bullets, and no tables, text boxes or images (ATS-safe). `renderCvDocx`, `renderNoteDocx`.
- **`fitOnePage`:** render, and while the PDF has more than 1 page apply the next `trimOrder` step, up to 12 times. It returns the content used and `trimmed: n`. If it still doesn't fit, `too_long`: a real outcome (headings and education are never trimmed; ADR-054), so the worker retries with the code.
- **Tests:**
  - the fake CV renders to exactly 1 page;
  - the maximum-size content fits after trimming;
  - **ATS checks:** the PDF read back with `unpdf` and the DOCX with `mammoth` contain every heading and bullet, in order;
  - the header comes from `CvHeader` only;
  - a non-WinAnsi character gives `unsupported_char`;
  - the note is at most one page and at most 250 words.
  - `smoke-functions-bundle.ts` prints the bundle size before and after; record the delta in the PR.
- **Docs (end of 7C):**
  - ADR-053 and ADR-054;
  - ARCHITECTURE stack row ("CV output": pdf-lib + docx; Message Batches not used);
  - FUNNEL S4 row (Sonnet 5.5 realtime, about 4.3p typical, about 8.8p worst-case reservation);
  - ROADMAP parking lot: **CV via Message Batches** (50% cheaper, about £1 a month at 10 a week; costs a wait of up to 24 h and a reservation that outlives the 15-minute stale rule);
  - CHANGELOG 0.7.2.

### PRD acceptance (7C)
- **R10 AC:** the validator rejects any bullet without a `factId` (and any unsupported number); the output fits one page (render tests).

---

## PR 7D: the pipeline (`feat/m7d-pipeline`, v0.7.3, M7 done)

### Stage machine (all server-side except the Applied mirror)

| From | Event | To |
|---|---|---|
| none / withdrawn | `start` | needs_input if there are questions; else generating; blocked → chosen |
| needs_input | `answer` / `skip` / `skipAll` | stays until every question is handled, then generating |
| chosen (blocked) | `retry` | runs the `start` logic again (questions already answered are kept, `attempt` reset) |
| generating | worker: valid output | ready (new `cvs/{cvId}`, files in Storage) |
| generating | worker: invalid output, first attempt | generating, with `lastIssues` (the next call has the issue codes appended) |
| generating | worker: second invalid output, refusal, `max_tokens`, cap or daily cap | chosen with `blocked` |
| generating | worker: `attempt` already at the maximum (e.g. after a killed run) | chosen with `blocked: attempts_exhausted`, no call |
| ready | `regenerate {notes}` | generating (the previous CV is kept as a version) |
| any but applied | `withdraw {deleteFiles}` | withdrawn (files and `cvs` docs deleted if asked) |
| any but withdrawn | client: Mark applied | applied (`stageBefore` kept) |
| applied | client: Undo applied | `stageBefore` |

**Generation details (the worker):**
- **CV header:** a job can't move to generating until `profile/cvHeader` exists (`cv_header_missing`).
- **No deep read:** a job without `deep` can't start (`no_deep_read`); the button explains why.
- **Facts:** read when the call is made, and the alias list is stored on the `cvs` doc.
- **What the model sees:**
  - the system prompt holds the instructions, the facts as `[F12] type: text (dates)`, and the line that tagged text is data, not instructions;
  - **untrusted, each in a tag it can't close (`wrapUntrusted`):** the posting in `<job_posting>`, and the S3 requirements and talking points in a new `<job_analysis>` tag (model output derived from the posting, so as untrusted as the posting);
  - the owner's notes in `<owner_notes>`, labelled preferences that can't add facts.
- **Never in the prompt:** the header and criteria.

**Answers become facts:** the answer text goes through the `addFact` core (purpose `answerFact`, `<note>` tag, evidence verified against the answer) and is written by `addManualFacts` with `source: 'manual'` and a new optional `answerFor: { jobId }`. The answers are then on Profile, versioned like any fact. An answer that yields no fact is refused ("Couldn't turn that into a fact: rephrase it or skip"). The requirement text is shown to the owner but never put into a prompt.

### Session 7D.1: the `application` callable (`functions/src/applications/`)
- **`callable.ts`:** owner only, App Check enforced and consumed (`ownerOptions`), 120 s, `maxInstances: 1` stated, mounts the Anthropic key (for `answerFact` only). Input is a zod discriminated union: `start | answer {questionId, text ≤2000} | skip {questionId} | skipAll | retry | regenerate {notes ≤500} | withdraw {deleteFiles}`.
- **The callable never writes a CV.** It moves the stage, and the worker picks up `generating` jobs.
- **`run.ts`:** the stage machine, dependency-injected like `lookup/run.ts`. **`store.ts`:** each transition is a transaction with a precondition on `stage` (and `attempt`), and appends an `application_stage` event.
- **Shared:** `CALLABLE_TIMEOUT_SECONDS.application = 120`.
- **Rules:**
  - `applications/{jobId}`: the owner reads; a client may update only the Applied mirror (keys `stage`, `stageBefore`, `updatedAt`). `stage == 'applied'` requires `getAfter(jobs/{jobId}).data.status == 'applied'`, and leaving it requires `stage == resource.data.stageBefore` with the job no longer applied.
  - `profile/cvHeader`: exact keys, https links, server time, `createdAt` fixed, as `validProfileSettings` does.
  - `scripts/rules-writes.test.ts` allowlist updated.
- **`resetProfile`** also deletes `profile/cvHeader`.
- **Tests:**
  - `run.test.ts` (fakes): every callable row of the stage table; skip one / skip all; an answer → facts with `answerFor`; header missing → blocked; a precondition lost to a concurrent call → refused, nothing written; a withdrawn job can start again.
  - `index.test.ts`: options, secrets table, `maxInstances`.
  - Rules: the mirror allowed only beside the job change, other-user and anon denied, and the cvHeader rules.
  - Emulator: start → answer → generating under concurrency.

### Session 7D.2: the CV worker (`functions/src/applications/worker.ts`, `prompt.ts`)
- **`generateCvs`:** `onSchedule('*/10 7-23 * * *', Europe/London)`, 540 s, 1 GiB, `maxInstances: 1`, `retryCount: 0`, mounts the Anthropic key.
- **Each run:**
  1. reads `applications where stage == 'generating'` (limit `workerMaxPerRun` 10, oldest `stageAt` first, sorted in code, so no composite index);
  2. one at a time, oldest first, and **no new call starts after `workerStartDeadlineMs` (210 s, `APPLICATIONS` in `functions/src/config.ts`)**:
     - first, a transaction checks that the job is still `stage == 'generating'` and increments `attempt`. That happens **before** the model call.
     - A job whose `attempt` is already at `maxAttempts` (2) is not called again. It moves to chosen with `blocked: attempts_exhausted`.
     - Only then: a realtime `llmCall` (purpose `cvWrite`, under the monthly cap and the `application` daily cap, with the issue codes appended when `attempt` is 1). The output then goes through alias resolution, `validateCv`, `fitOnePage`, and the render of the four files;
  3. uploads them to `cvs/{cvId}/{cv|cover-note}.{pdf|docx}` and writes `cvs/{cvId}` plus `stage: 'ready'` in one precondition transaction (`stage == 'generating'` and the same `attempt`). The files go first, so a lost transaction leaves orphans that the next attempt overwrites;
  4. a failure follows the stage table. A cap refusal blocks that job and stops the run, because the next job would be refused too.
- **No self-triggering:** scheduled only, never re-enqueued, at most 10 applications a run, a fixed start deadline, no Firestore or Storage trigger.
- **A worker killed mid-call** leaves the job at `generating`, with the attempt already counted, and its reservation charged at the worst case after 15 minutes (ADR-016). The next run calls it again only if attempts remain, so **one job costs at most 2 model calls**, kills included.
- **`prompt.ts`:** the CV system prompt and the message builder, with the untrusted tags above.
- **Dev:** `node scripts/dev-worker.ts` runs one pass against the emulator. It refuses any project that isn't `demo-*`, because the emulator doesn't fire schedules. The dev seed gains:
  - a CV header for the fake owner;
  - applications in `needs_input` (two questions), `generating`, `ready` (a `cvs` doc and the four files rendered by the real renderer from the fake content, uploaded to the Storage emulator) and `applied`;
  - a `cvWrite` branch in `fakeTransport` that returns the fake candidate's CV content.
- **Tests:**
  - every outcome (ready / retry with issue codes / blocked);
  - **the killed-worker case:**
    - a run increments `attempt` and then dies before settling (the fake transport never returns, and the run is abandoned);
    - the next run makes the second call;
    - a third run that finds `attempt == 2` makes no call (spy) and moves the job to chosen with `attempts_exhausted`;
    - two kills in a row → exactly 2 calls in total;
  - the increment happens before the call (call order on the spy);
  - the start deadline: no call starts after `APPLICATIONS.workerStartDeadlineMs` (210 s) on a fake clock, and the remaining jobs are untouched;
  - at most 10 a run, oldest first;
  - a cap refusal stops the run;
  - the transaction loses when the owner withdrew in between (files deleted);
  - **R11:** a simulated overspend stops the call before any API request;
  - **injection:** the injection fixture as a posting, and injected text in a requirement and a talking point, all stay inside their tags; only facts are cited and the validator still gates;
  - logs hold no CV text;
  - `index.test.ts` checks the schedule, time zone and options.
- **Emulator:** a full path from start to ready with the fake transport, the four Storage objects, and an owner-readable `cvs` doc.

### Session 7D.3: Pipeline screen, Profile CV header, Start application (web)
- **`services/applications.ts`:**
  - `watchStage(stage, limit 20)` uses `applications where stage == X orderBy stageAt desc`, a new composite `(stage, stageAt desc)`;
  - `stageCountsSpec`;
  - `callApplication` (zod in and out, limited-use App Check token, never retried);
  - `downloadCvFile` (Storage `getBlob`, lazy, named `<header.name> - CV - <company>.pdf`).
- **`services/profile.ts`:** `watchCvHeader` and `buildCvHeaderWrite`.
- **`features/pipeline/PipelinePage.tsx`** (lazy, route `/pipeline`):
  - a coloured count per stage: Chosen, Needs your input, Generating, Ready to send, Applied this week;
  - sections per stage. Withdrawn is hidden.
  - A Needs your input row shows its question cards: the requirement as text, **Answer** (textarea → `answer`), **Skip**, and **Skip all**.
  - A Generating row shows "Usually within 15 minutes".
  - A Ready row has **CV .pdf / .docx** and **Cover note .pdf / .docx** downloads, **Regenerate with notes**, **Mark applied** and **Withdraw**.
  - A Chosen row shows the blocked reason in words, with **Retry**, or **Add CV header** linking to Profile.
  - Empty, loading and error states throughout.
- **Stage tokens:** `--stage-chosen/input/generating/ready/applied` in `styles.css`, for dark and light. The colours don't reuse the verdict ones, and every stage has a label and an icon.
- **Profile:** a `CvHeaderCard` after `WorkRightsCard`. A fact with `answerFor` shows "From an application answer".
- **JobDetail:** **Generate CV** becomes **Start application**. It is disabled without a deep read (with a reason), shows the stage once started, and has a link to Pipeline. It is a separate button from Mark applied.
- **Nav:** a `Pipeline` item (`inTabBar: true`, so the phone tab bar becomes 5 columns: Today, Jobs, Pipeline, Lookup, More).
- **Tests:** role tests for each section and action; question answer, skip and skip-all flows; downloads called with the right paths; blocked reasons in words; `indexes.test.ts` for the new specs; the Pipeline route is lazy.

### Session 7D.4: Applied mirror, badge, summary bar slot, digest Pipeline line
- **`buildJobStatusWrite`** gains an optional application part. When an `applications/{jobId}` doc exists (one `getDoc` before the batch, in `performJobAction`), the batch also sets `stage: 'applied'` with `stageBefore`, or restores it on undo.
  - Undo is optimistic, as in ADR-041.
  - Mark applied on a job with no application is unchanged.
- **Badge:** `whenUsable()` in `lib/perf.ts` resolves when Today marks `hf:usable`, or at first idle on any other route (`requestIdleCallback`, falling back to 1.5 s).
  - `usePipelineBadge` starts a live count listener on `stage in [needs_input, ready]` only after that.
  - It shows "n" on the sidebar and tab items (`aria-label` "Pipeline, n to do"), and nothing at 0.
- **Summary bar:** a **Things to do** item (the same count, linking to `/pipeline`), also after usable.
- **Digest:** `getDigest`'s store reads pipeline counts per stage, and `render.ts` fills the Pipeline line ("2 need your input · 1 generating · 3 ready to send · 4 applied this week of 10", linking to `/pipeline`). Render tests cover the line.
- **Docs (end of 7D):**
  - ADR-055;
  - PRD: R7 screens list gains Pipeline, and the job actions change; R9 gains the Pipeline line; R10 gains the pipeline stages and "Needs your input";
  - ARCHITECTURE: Functions table (`application` and `generateCvs` replace `generateCv`), data model (`applications`, `cvs`, `profile/cvHeader`, fact `answerFor`, the `application_stage` event), indexes;
  - DESIGN.md: Pipeline screen, stage tokens, tab bar;
  - SECURITY: client-writes row, the CV threat row (validator details, untrusted tags), and data retention (CVs kept until withdrawn with delete);
  - RUNBOOK Part I pipeline steps;
  - ROADMAP: M7 **done**;
  - CHANGELOG 0.7.3;
  - CLAUDE.md commands (`dev-worker`, dev seed contents).
- **Tests:** rules run the real builders (`tests/rules/jobs.rules.test.ts`): applied with the mirror, undo, the mirror without a job change refused. The badge doesn't query before the mark (spy). Tab bar layout at 360 px.

### PRD acceptance (7D)
- **R10:** for a chosen job, a one-page tailored CV and a short cover note, built only from profile facts, as ATS-safe .docx and PDF, stored with a version (`cvs/<jobId>-v<n>`) and linked to the job. **AC:**
  - the validator rejects any bullet without a `factId` (7C, and used here);
  - the output fits one page (fit loop plus a test on the rendered PDF);
  - the owner can regenerate with notes.
- **R2:** an answered question becomes a versioned fact that shows its source.
- **R7:** job actions (Start application replaces Generate CV); the Pipeline screen; keyboard-accessible; Lighthouse a11y ≥ 95 on Pipeline; `hf:usable` unaffected (badge and bar after the mark).
- **R9:** the digest gains the Pipeline line.
- **R11:** CV spend is under the monthly cap plus a 60p daily cap, and the meter includes it. A simulated overspend stops a call before any request.

---

## ADRs
- **ADR-051 Today summary bar after `hf:usable`** (7A). Amends ADR-038's R7 measure.
- **ADR-052 Digest** (7B):
  - `getDigest` on the shared secret with a `digest.v1.` prefix and the shared nonce store;
  - choosing the morning run, and the four states;
  - two fixed Apps Script triggers (07:50 and 08:20) plus a self-sent "unavailable" email, in place of a retry trigger that would reschedule itself;
  - MailApp to the effective user only; the new scopes; escaping, and links to the app only;
  - the Pipeline line arrives with 7D.
- **ADR-053 CV generation: realtime `llm.call()` from a scheduled worker; batch rejected for now** (7C):
  - `cvWrite` is a normal realtime call under the monthly cap and a 60p daily `application` cap, sized for realtime prices;
  - one retry with the validator's issue codes;
  - a scheduled worker every 10 minutes (07:00–23:50), oldest first, with no new call after its start deadline (210 s, so a call started at the deadline settles inside the 540 s timeout), at most 10 a run, `maxInstances: 1`, `retryCount: 0`, never re-enqueued (the no-self-triggering rule);
  - **Message Batches rejected for now:** they save about £1 a month at 10 applications a week, and they add a wait of up to 24 hours, a reservation that outlives ADR-016's 15-minute stale rule, and a second delivery path in `llm.call()`. Parked on the ROADMAP.
- **ADR-054 CV content, citation validator and rendering** (7C):
  - the alias-cited content schema, and dates and contact details from code;
  - validator rules, including numbers and contact data;
  - pdf-lib + docx instead of `@react-pdf/renderer` (it supersedes ARCHITECTURE's stack row: no React or yoga in the shared functions bundle, exact text measurement for the one-page fit, no font files);
  - Helvetica/Arial metric match, the deterministic trim order, and ATS checks through unpdf and mammoth.
- **ADR-055 Application pipeline** (7D):
  - `applications/{jobId}` and its stages; auto-advance, with Chosen as the blocked state;
  - questions from the stored S3 requirements (code, no model call), each skippable, plus Skip all;
  - answers saved as versioned manual facts with `answerFor`;
  - transitions as precondition transactions with `application_stage` events;
  - the Applied stage mirrored in the client's Mark applied batch under rules (`getAfter` on the job);
  - in the CV prompt, the S3 requirements and talking points wrapped as untrusted (`<job_analysis>`), like the posting;
  - withdraw, and the CV header as a separate owner setting.

## Data model changes (summary)
- `applications/{jobId}` (new), described above. Client writes are limited to the Applied mirror.
- `cvs/{cvId}` (shape filled in), with Storage `cvs/{cvId}/{cv|cover-note}.{pdf|docx}`, server-written and owner-read (rules already exist).
- `profile/cvHeader` (new, an owner write under rules, deleted by Reset profile).
- Facts: optional `answerFor: { jobId }`.
- `events`: `application_stage` (server only).
- `usage/{month}`: `daily.application`, `byPurpose.cvWrite` / `answerFact`.
- `config/app.applications?: { dailyCapPence }`.
- Index `applications (stage, stageAt desc)`.

## Risks
- **Worker throughput.** At most 10 a run and no new call after 210 s (`workerStartDeadlineMs`); sequential calls of about 30–90 s each mean about 3–7 CVs a run (7 at 30 s, 5 at 50 s, 3 at 90 s), which is still well above 10 a week. Jobs left over wait at most 10 minutes. A job started after 23:50 waits until 07:00, and the UI says "usually within 15 minutes" (accurate in the day).
- **Daily caps can add up past the 25% manual share.** Lookup 25p, alerts 10p and applications 60p a day could together pass the 800p manual share in a worst-case month. The monthly cap (3200p) still holds in `llm.call()`, but scheduled runs could find less lease room late in the month. Typical CV spend is about 4.3p × 10 a week, roughly £1.85 a month. The digest's 80% warning surfaces it.
- **One page in Word versus PDF.** The fit is measured in the PDF; Arial and Helvetica are metric-compatible, but Word's line breaking can differ slightly. RUNBOOK I-step: open one .docx in Word or Google Docs and check that it is one page. The fallback is smaller limits in `trimOrder`.
- **pdf-lib standard fonts are WinAnsi only.** A name or fact with characters outside it gives `unsupported_char` and blocks with a message. The fallback is embedding Arimo (Apache 2.0, metric-compatible) with fontkit, decided only if it happens.
- **Functions bundle growth** (pdf-lib, docx) adds cold-start time to every function. The size is measured in 7C.2; if it grows by more than about 1.5 MB, load the renderer through a dynamic `import()` in the worker only.
- **New function deploys:**
  - `getDigest` (onRequest) needs the temporary `cloudfunctions.admin` grant and an `allUsers` invoker (RUNBOOK step 80 pattern).
  - The worker's Cloud Scheduler job needs its invoker to be exactly `hireframe-fns` (ADR-037 addendum), or the deploy fails before the job exists.
  - `application` needs the step-28 binding.
  - This is the second Cloud Scheduler job of the three that are free.
- **Answers turned into facts by the model can be wrong.** Their evidence is verified against the answer text, they are shown on Profile with their source, and they can be edited or archived.
- **The `hf:usable` redefinition** makes v0.7.0 numbers incomparable with v0.6.x. RUNBOOK records both.
- **The digest can arrive before the run finishes:** the 07:30 run can wait 4 min and take 9 min, and triggers fire ±15 min. The 08:20 fallback and the explicit in-progress notice cover it.
- **There is no eval for CV writing.** The validator is the gate. A CV eval on the fake candidate goes to the parking lot.

## Post-deploy steps (RUNBOOK Part I)
- **I1 (each tag).** The G2 invoker check on `scheduledScan`.
- **I2 (after v0.7.0).** Step 89 with the new definition. Paste the marks table, then decide whether hf-usable step 2 is parked.
- **I3 (before and after v0.7.1).** Temporary `cloudfunctions.admin` for the deploy account (step 80 pattern), deploy, `allUsers` invoker on `getDigest`, then remove the grant.
- **I4.**
  - `npm run build:apps-script`, then clasp push.
  - Add the Script Property `HIREFRAME_DIGEST_URL`.
  - Run `setup` once and accept the new scopes (send mail, your email address).
  - Run `digestNow` and check that the email arrives and isn't filtered.
- **I5.** The next weekday: the 07:50 digest arrives (or the 08:20 one with the in-progress notice).
- **I6 (after v0.7.3).**
  - Add `application` to step 28's loop.
  - Bind the `generateCvs` scheduler invoker to exactly `hireframe-fns` (Part E step 68 pattern), and check that the scheduler job exists (`*/10 7-23 * * *`, Europe/London).
  - The index `applications (stage, stageAt desc)` is Enabled.
- **I7.** On Profile, set the CV header. Then Start application on a real Apply job → answer or skip → Ready within about 15 minutes → download all four files. Open the .docx in Word or Google Docs and check it is one page, and paste the PDF's text into a plain editor to check the reading order. The next digest shows the Pipeline line.

## Verification
- **Per session:** the gate in the header. **Per PR:** CI green and the PRD ACs listed for that PR.
- **Locally:**
  - 7A: `npm run dev`; the console's `hfMarks()` shows `hf:usable` before `hf:counts`.
  - 7B: post a signed digest request to the emulator (`scripts/sign-test-alert.ts` gains a `digest` mode) → see `ready` HTML.
  - 7D: `npm run dev` → Start application on `dev-job-apply-1` → answer one question, skip the other → `node scripts/dev-worker.ts` → Ready → download the four files and open them; the digest request now shows the Pipeline line.
- **Live:** RUNBOOK Part I.

On approval: save this plan to docs/plans/m7-plan.md on a new branch m7-plan, commit (docs:), push, stop.
