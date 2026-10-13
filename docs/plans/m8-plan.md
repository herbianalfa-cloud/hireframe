# M8 Hardening: plan

## Context
M7 is done (v0.7.4). M8 closes Wave 1 with v1.0.0. The scope is the ROADMAP M8 row plus six items that came up in use:
- Every run since 13 Oct 07:30 is **Partial** because one Lever board is gone. The 9 Oct 17:30 run was also Partial, cause unknown.
- `hf:usable` is about 2,350 ms on v0.7.3 under RUNBOOK step 89 conditions. PRD R7's limit is 2,000 ms.
- The billing guards in `docs/plans/m8-billing-guards.md`.
- A local `npm audit` shows 5 highs while CI is green.
- "Delete all my data" (deferred from M3).
- A dedicated Cloud Build account, and Editor removed from the default compute account.

**What the code and live probes show (13 Oct, read-only)**

**Dead boards: one found.**
- I probed every Greenhouse and Lever token in `WATCHLIST_SEED` through the official board APIs (HireframeBot UA, 1 request/s, status codes only).
- **Lever `fresha` returns 404** on both `api.lever.co` and `api.eu.lever.co`.
- Fresha is not on Greenhouse or Ashby. A Workable account named "Fresha" exists but has 0 open jobs.
- **All 29 Greenhouse seed tokens return 200 with jobs.** So the dead Greenhouse board is either a prod-only edit of a `companies` doc, or it was a transient 404. That needs prod data (see the end of this plan).

**Why one dead board marks the whole run Partial:**
- `client.ts:322` maps 404/410 to `not_found`.
- `ats.ts:129-146` counts it as a board failure, so `statusFrom` (`sources/types.ts:77`) returns `degraded`.
- `runStatus` (`scan/run.ts:180-190`) returns `partial` if any active source isn't `ok`.
- `lastScan.broken` (after 3 `not_found` runs) is display-only. The board is still fetched every run and keeps the source degraded until someone edits the console.
- `report.errorCode` is "last board to fail wins", so it isn't deterministic.
- System's run rows never say *why* a run was Partial.

**Speed:**
- Marks exist (`web/src/lib/perf.ts`). No prefetch exists, and ADR-050 is reserved but unwritten.
- Since ADR-051, only the Apply list's first snapshot gates `hf:usable`. So step 2 of the hf-usable plan shrinks to the **Apply listener plus the Today chunk**; the counts no longer need prefetching.
- Today's critical path is serial: auth → `checkAccess` `getDoc(config/app)` (`AuthGate.tsx:21`) → render → `lazy(TodayPage)` import → `onSnapshot(apply)`.

**Audit gap (by design, but it leaves a hole):**
- The CI `audit` job (`ci.yml:85-102`) runs two steps: `--omit=dev --audit-level=high`, then the full tree at `--audit-level=critical` (ADR-013 M3 addendum).
- All 5 local highs are one advisory, `braces` GHSA-vfj7-8cjw-p6xm (≤ 3.0.3, no patched version). It is dev-only, through two routes:
  - `firebase-tools → chokidar@3`;
  - `@google/clasp → micromatch`. This second route isn't documented.
- **The hole:** any *new* dev-only high also passes CI silently.
- `sprintf-js` (mammoth → argparse) is moderate and prod. Dependabot #4 stays open.
- Local `node_modules` also has firebase-tools 15.32.0 while the lockfile has 15.32.1, so `npm ci` is needed.

**Functions:**
- There are 11 functions, all with `maxInstances: 1` from `setGlobalOptions` (`functions/src/options.ts:10`).
- 7 of them don't state it themselves: `parseCv`, `addFact`, `resetProfile`, `rescore`, `lookup`, `scanNow`, `scheduledScan`.
- No test checks `maxInstances` or memory for every function.
- `weeklyBackup` and the 60-day purge exist only in the docs. There is no backup or retention code.
- `resetProfile` (`profile/store.ts:246-281`) uses unbounded `recursiveDelete` and `deleteFiles({prefix})`. The bounded pattern to copy is `withdraw {deleteFiles}` (`applications/run.ts:236-294`).

**Cloud Build:**
- firebase-tools 15.32 has no way to name a functions **build** service account. Only `gcloud functions deploy --build-service-account` does.
- On this project, builds run as the default compute account. Google's documented minimum for a build account is `logging.logWriter`, `artifactregistry.writer` and `storage.objectViewer`.

**Kill switch (Google doc, checked today):**
- The pattern is budget → Pub/Sub → function → `updateProjectBillingInfo` with an empty account.
- The doc grants `roles/billing.admin` on the billing account. I propose the narrower project-level `roles/billing.projectManager`, to be verified in the throwaway project.
- The doc warns: "Resources might be irretrievably deleted."

**`PLAYBOOK.md` is not in the repo.** The billing plan says to add the no-self-triggering rule to it (open question 6).

## Shape: 3 PRs, one build session each, each branched from `main` after the previous merge

| PR | Branch | Tag | What | Opus self-review | Opus Max security review |
|---|---|---|---|---|---|
| 8A | `fix/m8a-run-health` | v0.8.0 | Dead boards, `hf:usable` prefetch (ADR-050), audit gate | **Yes** | No (no new endpoint, IAM or write path; the prefetch reads only under the existing rules) |
| 8B | `feat/m8b-data-lifecycle` | v0.9.0 | Delete all my data, retention job, backups, 1,000-job load test | **Yes** | **Yes** (a destructive callable, a scheduled deleter, data retention) |
| 8C | `feat/m8c-billing-iam` | **v1.0.0** | Billing guards, kill switch, Cloud Build account and Editor removal, security checklist, runbook complete | **Yes** | **Yes** (IAM, a new service account with a billing role, an event-triggered function) |

**Every PR gate**, after the last commit, in this order:
1. `npm run check`
2. `npm run format:check`
3. `npm run test:rules`
4. `npm run build`
5. `npm run check:bundle`
6. `node scripts/smoke-functions-bundle.ts`
7. `npm run audit` (new in 8A)

Then the self-review and, where marked, the security review, with the findings fixed and the gate re-run. Only then: CHANGELOG, ROADMAP, ADRs and a PR with a list of deviations.

**Release timing:**
- Tag and deploy only on a **weekday between 10:00 and 16:00 London**, or a **weekend between 10:00 and 18:00**.
- Never after 21:00.
- Never between 06:30 and 08:30 or between 16:30 and 18:30 on weekdays (scans at 07:30 and 17:30, digests at 07:50 and 08:20).
- Before tagging, Pipeline must show nothing **Generating** (`generateCvs` runs every 10 min, 07:00–23:50).
- Clocks go back on Sun 25 Oct. The schedules are in London time, so nothing changes, but don't tag that morning.

**The first build session (8A) saves this approved plan to `docs/plans/m8-plan.md`** as its first commit (`docs: M8 plan`).

---

## PR 8A: run health (v0.8.0)

### A1. Dead boards (ADR-056)
**Proposal: a 404 board is a watchlist fact, not a source failure.**
- **Classify:** in `functions/src/sources/ats.ts`, a board result of `not_found` counts as `gone`, not as a failure.
  - `statusFrom(attempts, failures)` excludes gone boards from both numbers, the same way `host_paused` is excluded today.
  - A source whose only problem is gone boards is `ok`.
  - `perSource[id]` gains `gone: n`. `errors` keeps real errors only.
- **Run status:** `runStatus` is unchanged in logic. It still returns `partial` for a degraded or failing source, failed writes or a failed funnel. Gone boards simply no longer make a source degraded.
- **Stop fetching dead boards:**
  - `lastScan` gains `board: 'type:token:host'`.
  - A company with `lastScan.broken` and the same `board` key is skipped by `ats.ts` (counted as `skippedGone`, not an attempt).
  - It is re-probed once its `lastScannedAt` is 7 days old, so a board that comes back recovers on its own.
  - A token changed in the console no longer matches the key, so it is probed on the next run. This saves requests.
- **Deterministic `errorCode`:** the most frequent real error code; on a tie, a fixed order. Gone boards never set it.
- **System:**
  - "Broken job boards" becomes **"Job boards that no longer exist"**. It lists every company whose `lastScan.status == 'not_found'` (a single-field query, so no new index), with the number of scans in a row and the existing fix advice.
  - Each Recent runs row gains a **"Partial because"** line built from `perSource` (status and code) and `errors`, so the next unexplained Partial explains itself (R12).
  - The source card shows "n boards no longer exist" as neutral text, not a warning.
- **Digest:** the run health line adds "n job boards no longer exist" as information, not an error.
- **Data fix (owner, console, not code):**
  1. Open Fresha's careers page in a browser. If it links to a job board, put that URL in a one-row CSV and run `node scripts/detect-ats.ts` on it (official APIs only, ADR-031).
  2. Edit `companies/fresha` `ats` in the Firestore console, or set `watch: false`.
  3. Do the same for the Greenhouse board once the prod read names it.
  4. Update the matching row in `tmp/watchlist-review.csv` and run `--write`, so the seed in the repo agrees. The seed never overwrites prod, so the console edit is what fixes prod.
- **Files:**
  - `functions/src/sources/ats.ts`, `sources/types.ts`, `scan/run.ts`, `scan/store.ts` (`companyScanUpdate`, `watchedCompanies`)
  - `packages/shared/src/jobs.ts` (`CompanySchema.lastScan.board`, `RunSchema.perSource.gone`, the source counts)
  - `functions/src/digest/render.ts`
  - `web/src/services/system.ts` (`watchGoneBoards`), `web/src/features/system/SystemPage.tsx`, `labels.ts`, `hooks.ts`
- **Tests:**
  - `sources.test.ts`: `echo-gone` makes the source `ok` with `gone: 1`.
  - `run.test.ts`: `runStatus` is `succeeded` with only gone boards and `partial` with a 5xx board; a broken board is skipped, re-probed at 7 days (fake clock), and re-probed at once after a token change; the deterministic `errorCode`.
  - `tests/emulator/scan.test.ts`: the fake-seed run is now `succeeded`.
  - `SystemPage.test.tsx`: the gone-boards panel and the "Partial because" line.
  - The digest render test.
- **PRD:** R4 ("one source failing never fails the run", per-source counts), R12 (failed run visible, source health panel), and the PRD scan reliability metric (≥ 95% of runs succeed).

### A2. `hf:usable` prefetch (ADR-050, hf-usable plan step 2, updated for ADR-051)
- `web/src/services/dashboard.ts`: `prefetchToday()` opens an `onSnapshot` on exactly `todayListSpec('apply')` with `limit(TODAY_LIST_SIZE)`. The SDK shares one target per identical query, so TodayPage's listener gets the snapshot as soon as it is current.
  - It unsubscribes on `whenUsable()`, after 30 s, or on sign-out, whichever comes first.
  - Errors are swallowed and logged once (`dashboard.prefetch_failed`, code only).
  - The counts are **not** prefetched (they mount after `hf:usable`).
- `web/src/app/App.tsx`: export `loadTodayPage`, which `lazy()` and the prefetch share, so there is one import promise.
- `web/src/app/AuthGate.tsx`: when `uid` first becomes non-null and `location.pathname === '/'`, call `prefetchToday()` and `loadTodayPage()` once. This runs in parallel with `checkAccess`.
- Add a mark, `hf:prefetch`.
- **Safety (ADR-050, SECURITY row):** nothing renders before the owner check. A non-owner's listener gets `permission-denied` from the rules (ADR-011). The cost is one limited query per page load, for signed-in users only.
- **Tests:**
  - No prefetch when signed out or off `/`.
  - The listener is cleaned up on usable, at 30 s (fake timers) and on sign-out.
  - A prefetch error doesn't surface.
  - A non-owner renders `NoAccessScreen` and no data.
  - The import promise is shared.
- **No marks table exists for v0.7.3**, so the step 2 gate is judged after the fact: the v0.8.0 step 89 run records the marks table. If the median is over 2,000 ms, **stop and report** with the table (whether `hf:appcheck`, `hf:auth` or `hf:owner` dominates). No persistent cache, no further lever.
- **PRD:** R7 ("usable in < 2 s on 4G").

### A3. Audit gate (ADR-013 addendum, M8)
- New `scripts/audit.ts` wraps a pure `evaluateAudit(json, allowlist, today)`:
  - It runs `npm audit --json` on the full tree. **npm exits non-zero whenever it finds anything, so the script ignores the exit code and parses stdout as JSON.** It fails only on a parse error (or empty output) or on the allowlist rules below.
  - It fails on any high or critical advisory not in `audit-allowlist.json`.
  - Each allowlist entry has a GHSA id, the allowed root packages (`firebase-tools`, `@google/clasp`), a reason, and a `reviewBy` date of 2027-01-13.
  - It also fails on an expired entry, or one that no longer matches anything.
- In `.github/workflows/ci.yml`, the job keeps its name `audit` (so the ruleset's required check is unchanged and no `gh api` is needed). It keeps step 1 (`--omit=dev --audit-level=high`). Step 2 becomes `npm run audit`.
- `package.json` gets `"audit": "node scripts/audit.ts"`, so a local run matches CI.
- Moderates still don't fail, so Dependabot #4 (sprintf-js) stays open and is noted in the addendum.
- **Tests:** `scripts/audit.test.ts` covers an allowed path, a new dev high (fails), an allowed GHSA through a different root (fails), an expired entry (fails), and an unused entry (fails). The runner is tested with an injected exec: a non-zero exit with valid JSON is evaluated normally, and unparsable or empty output fails with `audit_parse_error`.
- **CLAUDE.md:** add `npm run audit` to Commands.
- **Owner, local:** run `npm ci` (stale firebase-tools).

### 8A docs
- ADR-050, ADR-056, ADR-013 addendum.
- ARCHITECTURE: the `companies.lastScan` and `runs.perSource` shapes, the Today line.
- SECURITY: a prefetch row, and a supply-chain row for the allowlist.
- RUNBOOK: Recovery "Degraded / a board no longer exists", rewritten for gone boards; step 89 unchanged.
- CHANGELOG 0.8.0; `docs/plans/m8-plan.md`.

### 8A risks
- Treating 404 as "gone" could hide a real outage that returns 404 for every board. Guard: if **every** attempted board on a host is `not_found`, the source stays `failing`.
- The prefetch might not reach 2,000 ms. The App Check exchange and the WebChannel open are shared, not removed. **If the live median is over 2,000 ms, stop and report it with the marks table.** No persistent cache and no other lever without a new decision.
- Skipping broken boards: a console fix of `watch` alone (same token) waits up to 7 days. The RUNBOOK says to clear `lastScan` to force a re-probe.

### 8A deploy checks (v0.8.0)
- **No new function, no new index, no IAM change.** Before the tag: RUNBOOK step 77 (C1, C2). After the deploy: C3, then step 89 (3 repeat visits, median ≤ 2,000 ms, plus the marks table).
- After the next scheduled scan: System shows the run as Succeeded, and Fresha is listed under "no longer exist" (until the console edit).
- **Owner steps, both needed before v1.0.0:**
  - Lighthouse (Mobile, Accessibility only, Clear storage off) on **Pipeline**: ≥ 95, alongside the step 89 Lookup, Today and Jobs runs.
  - On a real phone at 360 px width (or the closest real device; note its width): the 5-column tab bar fits with no overflow or wrapping, every target is tappable without hitting its neighbour, and the Pipeline badge sits over the icon without widening its column.

---

## PR 8B: data lifecycle (v0.9.0)

### B1. Delete all my data (ADR-057)
- **New callable `deleteAllData`:**
  - Owner only. App Check is enforced and consumed.
  - Input: `{ confirm: 'DELETE' }` (zod, shared).
  - `maxInstances: 1`, `timeoutSeconds: 120`, `memory: 512MiB`.
- **What it deletes:**
  - `applications`, `cvs` and Storage `cvs/`;
  - `jobs` (with `description/raw`), `runs`, `events`, `alertMessages`, `companies`;
  - `sources`, **keeping each doc's `quota` and `pausedHosts`** (resetting Adzuna's or Reed's counters mid-day would break their API terms).
- **What it keeps:**
  - `config`, `criteria`, `usage` (deleting it would reset the spend cap), `locks`, `nonces`;
  - the profile, unless the owner ticks **"Also reset profile"** (off by default). Ticked, the last wipe call runs the existing Reset profile core (facts, versions, uploads, `profile/main`, `profile/cvHeader`, uploaded files), and keeps Reset profile's own refusal while a CV is being read;
  - `backups`.
- **Bounds (hard rule):** each call deletes at most 3,000 documents and 20 Storage listing pages of 200, starts nothing after 90 s, and returns `{ done, remaining }`.
  - The client repeats up to 20 calls with a progress line, then shows **Continue**.
  - The function never re-invokes itself.
- **Concurrency:**
  - It takes `locks/scan` as a new holder `wipe` (stale after 3 min, refreshed each call).
  - It refuses while a scan, re-score, ingest or Lookup holds the lock, or while any application is `generating` ("Wait for the CV being written").
  - `generateCvs` already loses its precondition transaction if the application is gone. The session checks that it then removes its uploaded files.
- **Effect on the watchlist (accepted):** the next scan re-creates `companies` from `WATCHLIST_SEED`, so console edits such as the Fresha fix are lost. The dialog says so, and the seed is kept in step with console fixes (8A data fix step 4).
- **UI:** System → **Danger zone** → "Delete all my data". A preview dialog shows counts (from `count()`), what is kept, the **Also reset profile** checkbox (off), that Firestore backups keep data for up to 8 weeks (RUNBOOK step for a full erase), and a typed DELETE.
- **Files:**
  - `functions/src/wipe/{callable,run,store}.ts`, `functions/src/index.ts`, `functions/src/config.ts` (`WIPE` limits)
  - `packages/shared/src/callables.ts`, `packages/shared/src/wipe.ts`
  - `web/src/services/wipe.ts`, `web/src/features/system/DeleteAllData.tsx`
- **Tests:**
  - Unit: the plan and bounds; the deadline (fake clock); refusing on the lock or a generating application; that quota is kept; `events` and `alertMessages` are in the plan.
  - Emulator `tests/emulator/wipe.test.ts`: after seeding, every listed collection is empty, `events` and `alertMessages` included; `usage`, `config`, `criteria` and `backups/` survive. Unticked, `profile/**` and `profile/documents/` survive. Ticked, they are gone too and `criteria` still survives. A second call is safe.
  - Web: preview, the checkbox off by default and sent only when ticked, typed confirm, the progress loop stopping at 20, Continue.
- **PRD/SECURITY:** SECURITY "Data retention" ("Delete all my data wipes collections + Storage"); ADR-025 (Adzuna data removable).

### B2. Retention job (ADR-057)
- **New scheduled `purgeOldData`:**
  - Daily at 03:30 Europe/London.
  - `maxInstances: 1`, `timeoutSeconds: 300`, `memory: 512MiB`, `retryCount: 0`.
  - At most 500 jobs a run, and nothing new after 240 s.
- **What it does:** deletes `jobs/{id}/description/raw` for `verdict == 'skip'` jobs judged more than 60 days ago whose status isn't `saved` or `applied`, and stamps `descriptionPurgedAt`.
  - A cursor in `locks/retention` (`purgedThrough`) keeps reads flat.
  - If the query needs `jobs (verdict, judgedAt asc)`, it is added to `firestore.indexes.json` and `indexes.test.ts`.
  - S3 and Lookup treat `descriptionPurgedAt` like "no text".
- It is scheduled, not event-triggered, and never re-enqueues itself.
- **Tests:** a fake clock at 59 and 61 days, the bounds, the cursor, saved and applied jobs untouched, and an emulator test.

### B3. Backups (ADR-058; replaces the documented `weeklyBackup` JSON export)
- Firestore **managed scheduled backups**: weekly on Sunday, kept 8 weeks, no code. A function, a scheduler job and a Storage path would add no safety over this.
- Storage (CV files) is not backed up. The master CV is the owner's own file, and generated CVs can be regenerated. Storage soft delete (7 days by default) covers mistakes.
- **A restore drill** into a scratch database, then that database is deleted (RUNBOOK).
- **Accepted risk (ADR-058):** managed backups live in the project, so a project deleted after billing is cut loses them too. No off-project export. The kill switch ships dry run, and the restore drill comes before any arming.
- Docs: ARCHITECTURE functions table (drop `weeklyBackup`), SECURITY "Data loss" row.

### B4. Load test of a 1,000-job run
- `scripts/load-test.ts` refuses any non-`demo-*` project.
- It runs against the emulator with a dev-fake source that yields N jobs (default 1,000) and a fake model with realistic latency (S2 about 1.2 s, S3 about 8 s, with jitter).
- **The run includes the ATS hydrator and the expiry sweep:**
  - The seed includes at least 12 description-less alert jobs at watched companies that reach S3, so the hydrator makes its full **12 board reads**. They go through the fake board API with the real HTTP client and per-host spacing (1 s), so the spacing counts in the time.
  - It also includes stale queued jobs past `freshness_days` (a few hundred across S2, S3 and `description`), so the **expiry sweep** runs with real reads and writes before the lease.
- **Pass criteria:**
  - the run finishes inside 540 s with every stage deadline respected;
  - **the report says whether 32 S3 calls plus the 12 hydrator board reads finish inside the 450 s S3 deadline**, with the S3 stage's start time, end time, `stops.s3` and the hydrator's time. A miss is reported with the numbers, not tuned away in this PR;
  - S2 ≤ 300 and S3 ≤ 32;
  - the lease is never exceeded;
  - every batch is ≤ 400 ops;
  - peak RSS is under 512 MiB;
  - a second identical run reports 0 new and close to 0 writes.
- It prints a table: stage times (sweep, S1, S2, hydrate, S3), sweep counts, hydrator reads and outcomes, reads, writes, peak RSS.
- It then times **Delete all my data** on the result: the number of calls needed for about 2,000 docs.
- CLAUDE.md Commands entry.
- Nothing is changed to "make it pass" without a note in the PR.

### 8B docs
- ADR-057, ADR-058.
- ARCHITECTURE: functions, the data model (`descriptionPurgedAt`, the `wipe` holder, `locks/retention`), indexes.
- SECURITY: retention, Data loss.
- RUNBOOK: Part J (steps J1 to J6) and Recovery.
- CHANGELOG 0.9.0; CLAUDE.md commands (`npm run dev` seed unchanged).

### 8B risks
- A wipe is irreversible apart from the backups. Mitigations: typed confirm, preview counts, the lock, and refusing while generating.
- The retention cursor could skip a job that was re-scored with an older `judgedAt`. Not possible: a re-score only restamps forward.
- Retention needs the third Cloud Scheduler job. Three are free per billing account, so this uses the last free one.

### 8B deploy checks (v0.9.0)
- Before the tag: step 77 (C1, C2).
- After the deploy:
  - C10 (invoker for `deleteAllData`);
  - C11 (`purgeOldData`'s scheduler invoker), C12 and C13 (its job and policy);
  - C3 (`scheduler jobs list` shows exactly three: `scheduledScan`, `generateCvs`, `purgeOldData`);
  - C14 (new functions: `maxInstances` and timeout);
  - the new index **Enabled**, if one was added (Firestore → Indexes).
- Then backups C15 to C17, and the restore drill C18 to C20 (once, on a quiet weekend afternoon).

---

## PR 8C: billing guards, IAM, v1.0.0 (v1.0.0)

The session starts with a **throwaway-project spike** (C21 to C31). Its two results decide C1 and C3 below.

### C1. Cloud Build account (ADR-060)
- **Spike:**
  1. Does `gcloud functions deploy --build-service-account` on one function survive a later `firebase deploy` (read `buildConfig.serviceAccount` back)?
  2. Does Cloud Build have a project-level default build account setting that Functions honours?
- **Path D (dedicated), if either works:**
  - create `hireframe-build`;
  - grant it only `logging.logWriter`, `artifactregistry.writer` on `gcf-artifacts`, and `storage.objectViewer` (conditioned on the `gcf-v2-sources-*` and `gcf-v2-uploads-*` buckets);
  - move the deployer's `serviceAccountUser` from the compute account to `hireframe-build`;
  - remove Editor from the compute account.
- **Before Path F (and before C39 on either path):** list every Eventarc trigger (C39a) and every function's runtime account (C39b), and confirm none uses the compute account. `billingGuard`'s trigger must show `hireframe-billing-guard`. If anything uses the compute account, stop and report.
- **Path F (fallback, accepted), if neither works:** the compute account *becomes* the build-only account. Nothing runs as it: every function runs as `hireframe-fns` (`billingGuard` as `hireframe-billing-guard`), every scheduler job uses `hireframe-fns`, and no Eventarc trigger uses it (C39a).
  - Replace its Editor with the same three roles.
  - The deployer keeps `serviceAccountUser` on it (needed to act as the build account).
  - ROADMAP's "drop the deployer's serviceAccountUser" is then not possible, and the ADR says why.
- **Either way:** take an IAM snapshot before and a diff after (C35a, in the Cloud Shell home folder), then a **proving deploy** (a re-run of the v1.0.0 deploy job) right after the change, and keep a rollback command ready (C40).

### C2. Instance and timeout audit
- Add explicit `maxInstances: 1` to the 7 functions that only inherit it. Callables stay at 1, not the 2 the billing plan proposes: single-flight logic assumes 1. Recorded in the ADR.
- `functions/src/index.test.ts` gets one table test: every export's `__endpoint` has `maxInstances`, `timeoutSeconds` and `availableMemoryMb`, and scheduled and event functions have `retry` false or `retryCount: 0`.
- A source scan test fails if any `onCall`, `onRequest`, `onSchedule` or `onMessagePublished` in `functions/src` lacks a literal `maxInstances`.

### C3. Billing kill switch (ADR-059)
- **New `billingGuard`:**
  - `onMessagePublished('billing-guard')`;
  - its own service account `hireframe-billing-guard` (per-function `serviceAccount`), the only account with `roles/billing.projectManager` on `hireframe-f6b03` (narrower than the doc's `billing.admin`; the spike verifies it);
  - **its Eventarc trigger runs as `hireframe-billing-guard`, never the compute account.** In code, the function's `serviceAccount` is the trigger account in the deployed manifest. `index.test.ts` asserts `__endpoint.serviceAccountEmail` is `hireframe-billing-guard@…`, and the spike (C28) checks that a Firebase deploy really sets `eventTrigger.serviceAccountEmail` from it. If it doesn't, the session stops and reports before the prod deploy. Live, C14b reads the trigger account, and C38 grants `run.invoker` to that account only;
  - `maxInstances: 1`, `timeoutSeconds: 60`, `memory: 256MiB`, `retry: false`;
  - it mounts no secrets and has no Firestore access.
- **Behaviour:**
  - It zod-parses the budget message.
  - It acts only when `budgetDisplayName === 'hireframe-kill'` and `costAmount >= budgetAmount` (actual cost; forecast is ignored).
  - It is idempotent: when billing is already off it logs and stops.
  - A mode param `BILLING_GUARD_MODE=dry_run|armed`: v1.0.0 ships **dry_run**. **Arming is a separate approved step after C35:** a one-line `chore:` PR that sets `armed`, tagged `v1.0.1`, in a release window (C42). **If the spike shows `billing.projectManager` is not enough and `billing.admin` is needed, arming moves out of M8** (ROADMAP parking lot). `billingGuard` then stays in dry run and no billing-account role is granted.
  - Logs: `billing_guard.below`, `.would_disable`, `.disabled`, `.failed`, codes only.
- **Hard rule check:** the function is triggered by budget messages it cannot cause, and it never re-enqueues itself.
- **Threshold £25 actual** (approved).
- **ADR-059 states plainly:** budget notifications lag actual spend by hours, so spend can pass £25 well before the switch fires. The kill switch is a **backstop**. The real limits are the spend caps in `llm.call()` and the run leases, `maxInstances: 1` on every function, the single-flight locks, and the card's monthly limit.
- **Tests:** a pure decide function (below, at, above, the wrong budget, forecast only, malformed); the handler with a fake billing client (dry run never calls update; armed calls it once; billing already off).

### C4. Time-dependent tests
- Audit the existing tests and fill the gaps with fake-clock tests that cross each boundary and assert the code stops or does bounded work:
  - the expiry sweep; the describe-claim release (10 min); the nonce store (10 min);
  - the lease and the month rollover (London); reservations stale at 15 min; the scan lock at 12 min, and the short holders (3 min and 2 min);
  - `freshness_days`; the 60-day purge (8B); the worker start deadline (210 s); the broken-board re-probe (8A).
- The PR lists each item with its test file.

### C5. Client read loops
- Audit every `onSnapshot` and query inside an effect for unstable dependencies, and check `refetchInterval` (unset, or ≥ 60 s).
- Add a dev-only counter in `web/src/services/` that warns in the console above 200 reads a minute (tree-shaken from prod; `check:bundle` proves it).
- **Tests:** the counter warns at 201 and never in prod builds.

### C6. Stolen-account guards and payment limit (mostly owner steps)
- Read the enabled APIs (C32), and propose a disable list in the PR for approval one by one (C33).
- If the Compute Engine API is enabled, set its CPU and GPU quotas to 0 in the console, after the spike confirms Cloud Build and Functions v2 don't draw on them.
- Owner tasks with no command:
  - a passkey or hardware key on the Google account; check the recovery phone and email;
  - a virtual card with a £50 monthly limit on the billing account;
  - budgets at £2, £5 and £10, actual and forecast, plus the `hireframe-kill` £25 budget connected to the `billing-guard` topic (console: Billing → Budgets & alerts);
  - `gcloud auth revoke` on the laptop when done (C41).
- **Park** "GCP spend on System and the digest": it needs a BigQuery billing export, which isn't cheap to set up.

### C7. Security checklist, runbook, release
- **SECURITY.md:**
  - The checklist becomes "Before v1.0.0". Tick the open secrets item with evidence (C34).
  - Add items with evidence: the IAM snapshot reviewed; Editor gone; the kill switch tested in the throwaway project; the restore drill done (8B); a wipe tested (8B); the audit allowlist; the `maxInstances` test; no self-triggering functions; APIs and quotas.
  - New threat row: billing (the kill switch, its account and role).
- **RUNBOOK:**
  - Part K: the M8C steps.
  - A single **"Every release"** checklist: step 77, invoker bindings for new functions, `scheduler jobs list`, indexes Enabled, `maxInstances` and timeout on new functions, step 89, release timing.
  - Recovery: **"Billing was disabled"** (re-link in the console, check functions, scheduler and Firestore, check the backups), **"Project suspended (card declined)"**, and **"Rollback the Editor removal"**.
  - Remove the stale `weeklyBackup` text.
- **ROADMAP:** M8 done; v1.0.0. Parking lot: **the App Engine default account's Editor role** (`hireframe-f6b03@appspot.gserviceaccount.com`; the deployer's `serviceAccountUser` on it is for the Firebase CLI's pre-check); and **arming the kill switch**, only if the spike needs `billing.admin`. CHANGELOG 1.0.0.
- **CLAUDE.md working method:** a new step, "Before every PR, check the diff against the no-self-triggering rule: no function triggered by an event it can cause; no self-rescheduling or re-enqueueing; every loop over external calls or writes has a fixed maximum and a deadline; every new function sets `maxInstances`." (PLAYBOOK is updated by the owner, outside the repo.)
- **`.gitignore`:** add `iam-*.json`, as a guard in case an IAM snapshot ever lands in the repo folder (C35a runs in the Cloud Shell home folder).
- **v1.0.0** only after all of these:
  - the 8A and 8B checks have passed on live;
  - one full weekday (two scheduled scans plus the digest) has run cleanly on v0.9.0;
  - the owner's **Lighthouse accessibility on Pipeline ≥ 95**;
  - the owner's **360 px phone check of the 5-column tab bar** (8A deploy checks).

### 8C docs
- ADR-059 (with the notification-lag statement), ADR-060, ADR-017 addendum (build account), ARCHITECTURE (functions table, environments), SECURITY, RUNBOOK, CLAUDE.md (the working-method step), ROADMAP (parking lot), `.gitignore`, CHANGELOG.

### 8C risks
- **Removing Editor can break deploys or a Google-managed flow.** Mitigations: snapshot and diff, the proving deploy straight after, and rollback C40 ready. It is done in a release window, never late.
- **The kill switch can delete resources.** Mitigations: dry run first, arming as a separate approved step, a threshold well above normal spend, and the restore drill done before arming.
- **The kill switch fires hours late** (budget notification lag). It is a backstop, not the limit (ADR-059).
- **Eventarc may need the deployer to have extra roles** (`eventarc.developer`, C38b, conditional). The trigger must run as `hireframe-billing-guard`, with `run.invoker` on it alone (C38). A trigger left on the compute account would break silently once Editor goes, so C14b and C39a check it before C39.
- **The throwaway project creates billable resources.** Keep it to one afternoon and delete it (C31).
- C28b: the throwaway project may need Firebase added (`npx firebase projects:addfirebase $T`) before `firebase deploy` works. Show that command for approval if needed.
- C35: before the at-threshold publish in prod, read the deployed mode with `gcloud functions describe billingGuard --region=$R --gen2 --format='value(serviceConfig.environmentVariables)'`. Publish at the threshold only if it shows BILLING_GUARD_MODE=dry_run.

### 8C deploy checks (v1.0.0)
- Before the tag: step 77 (C1, C2), plus C36 to C37c done and C3 run.
- **Order around Editor:** first deploy v1.0.0 with `billingGuard`, then C14b and C38 (the trigger runs as `hireframe-billing-guard`), then C39a and C39b (nothing uses the compute account), then C35a, C39 and the diff. Then a **proving deploy**: re-run the v1.0.0 deploy job from Actions, which rebuilds the functions under the new build account (the deploy job's re-run, not a new tag). If the build fails, run C40 and re-run.
- After the deploy:
  - C14 for `billingGuard` (`maxInstances` 1, timeout 60, service account `hireframe-billing-guard`), and **C14b, whose `eventTrigger.serviceAccountEmail` must be `hireframe-billing-guard@…`**, plus the trigger topic;
  - **no `allUsers` invoker**: C38 binds only `hireframe-billing-guard`;
  - C3 (still exactly three scheduler jobs);
  - no new index;
  - C35 (a dry-run message below the threshold, then one at the threshold, which logs `would_disable`).
- **Arming (separate, later, approved on its own):** after C35 passes, the `chore:` PR setting `armed`, merged, then tag `v1.0.1` (C4), C14b again, and C35 below the threshold only. Never publish at or above the threshold once armed.

---

## Commands for approval (each one checked in chat before it runs)
`P=hireframe-f6b03`, `R=europe-west2`, `FNS=hireframe-fns@hireframe-f6b03.iam.gserviceaccount.com`, `SA=github-deployer@hireframe-f6b03.iam.gserviceaccount.com`. Owner runs these in Cloud Shell unless marked local.

**Every release (step 77 and the scheduler list):**
- C1 `gcloud scheduler jobs describe firebase-schedule-scheduledScan-europe-west2 --location=europe-west2 --format='value(schedule,timeZone,httpTarget.oidcToken.serviceAccountEmail)'`
- C2 `gcloud run services get-iam-policy scheduledscan --region=europe-west2 --flatten='bindings[].members' --filter='bindings.role:roles/run.invoker' --format='value(bindings.members)'`
- C3 `gcloud scheduler jobs list --location=europe-west2 --format='table(name,schedule,timeZone,state,httpTarget.oidcToken.serviceAccountEmail)'`
- C4 (tag, local, **only after the PR is merged**, in a release window) `git checkout main && git pull && git tag v0.8.0 && git push origin v0.8.0`, then approve the deploy. Likewise `v0.9.0`, `v1.0.0` and (arming) `v1.0.1`. Before tagging, `git log -1` must show the PR's merge commit.

**8B:**
- C10 `gcloud functions add-invoker-policy-binding deleteAllData --region=$R --member=allUsers --project=$P`
- C11 `gcloud functions add-invoker-policy-binding purgeOldData --region=$R --member=serviceAccount:$FNS --project=$P`
- C12 `gcloud scheduler jobs describe firebase-schedule-purgeOldData-europe-west2 --location=$R --format='value(schedule,timeZone,httpTarget.oidcToken.serviceAccountEmail)'`
- C13 `gcloud run services get-iam-policy purgeolddata --region=$R --flatten='bindings[].members' --filter='bindings.role:roles/run.invoker' --format='value(bindings.members)'`
- C13b (only if the deploy said "Failed to set invoker" and C12 finds no job) `gcloud scheduler jobs create http firebase-schedule-purgeOldData-europe-west2 --location=$R --schedule='30 3 * * *' --time-zone='Europe/London' --uri="$(gcloud functions describe purgeOldData --region=$R --gen2 --format='value(serviceConfig.uri)')" --http-method=POST --oidc-service-account-email=$FNS --attempt-deadline=300s --max-retry-attempts=0`
- C14 (each new function) `gcloud functions describe <fn> --region=$R --gen2 --format='value(serviceConfig.maxInstanceCount,serviceConfig.timeoutSeconds,serviceConfig.availableMemory,serviceConfig.serviceAccountEmail)'`
- C14b (`billingGuard`, 8C) `gcloud functions describe billingGuard --region=$R --gen2 --format='value(serviceConfig.maxInstanceCount,serviceConfig.timeoutSeconds,serviceConfig.availableMemory,serviceConfig.serviceAccountEmail,eventTrigger.serviceAccountEmail,eventTrigger.pubsubTopic,eventTrigger.retryPolicy)'`. It must show `hireframe-billing-guard@…` twice, the topic `billing-guard` and no retry.
- C15 `gcloud firestore backups schedules create --database='(default)' --recurrence=weekly --day-of-week=SUN --retention=8w --project=$P`
- C16 `gcloud firestore backups schedules list --database='(default)' --project=$P`
- C17 (after the first Sunday) `gcloud firestore backups list --location=$R --project=$P`
- C18 `gcloud firestore databases restore --source-backup=projects/$P/locations/$R/backups/<BACKUP_ID> --destination-database=restore-drill --project=$P`
- C19 `gcloud firestore databases describe --database=restore-drill --project=$P` (then spot-check counts in the console)
- C20 `gcloud firestore databases delete --database=restore-drill --project=$P`
- C20b (full erase after a wipe, per backup, only if asked) `gcloud firestore backups delete --location=$R --backup=<BACKUP_ID> --project=$P`
- C20c (read) `gcloud storage buckets describe gs://hireframe-f6b03.firebasestorage.app --format='value(soft_delete_policy)'`

**8C, throwaway project (spike and kill-switch test). `T=hireframe-guard-test-<4 digits>`:**
- C21 `gcloud projects create $T`
- C22 `gcloud billing accounts list` (read, to get `<BILLING_ID>`)
- C23 `gcloud billing projects link $T --billing-account=<BILLING_ID>`
- C24 `gcloud services enable cloudfunctions.googleapis.com run.googleapis.com cloudbuild.googleapis.com artifactregistry.googleapis.com pubsub.googleapis.com eventarc.googleapis.com cloudbilling.googleapis.com --project=$T`
- C25 `gcloud iam service-accounts create guard --project=$T`
- C26 `gcloud projects add-iam-policy-binding $T --member=serviceAccount:guard@$T.iam.gserviceaccount.com --role=roles/billing.projectManager --condition=None`
- C27 `gcloud pubsub topics create billing-guard --project=$T`
- C28 (local, a test deploy of the built `billingGuard` and the build-account probe) `gcloud functions deploy billingGuard --gen2 --project=$T --region=$R --runtime=nodejs22 --source=functions/deploy --entry-point=billingGuard --trigger-topic=billing-guard --service-account=guard@$T.iam.gserviceaccount.com --set-env-vars=BILLING_GUARD_MODE=armed --max-instances=1 --timeout=60s` (plus the `--build-service-account` probe for C1's spike: a separate variant, shown in the session)
- C28b (local, **throwaway project only**) `npx firebase deploy --only functions:billingGuard --project=$T`, from a scratch copy of `firebase.json` pointing at `functions/deploy`. It answers both spike questions: does a Firebase deploy keep the `--build-service-account` from C28, and does it set `eventTrigger.serviceAccountEmail` to the function's `serviceAccount`? Read back with C14b's command and `--project=$T`. `npm run deploy` still refuses locally; this never touches prod.
- C29 `gcloud pubsub topics publish billing-guard --project=$T --message='{"budgetDisplayName":"hireframe-kill","costAmount":30,"budgetAmount":25,"currencyCode":"GBP","costIntervalStart":"2026-10-01T00:00:00Z"}'`
- C30 `gcloud billing projects describe $T --format='value(billingEnabled)'` (must print `False`)
- C31 `gcloud projects delete $T`

**8C, production IAM and billing:**
- C32 (read) `gcloud services list --enabled --project=$P --format='value(config.name)'`
- C33 (one per API, each approved separately) `gcloud services disable <api> --project=$P`
- C34 (read, checklist evidence) `gcloud secrets list --project=$P --format='value(name)'`, then per secret `gcloud secrets get-iam-policy <name> --project=$P`
- C35a (in the **Cloud Shell home folder, never in the repo**: `cd ~` first) `cd ~ && gcloud projects get-iam-policy $P --format=json > ~/iam-before.json && gcloud iam service-accounts list --project=$P`. This is the snapshot; paste the roles summary, not the file, in chat. After C39: `cd ~ && gcloud projects get-iam-policy $P --format=json > ~/iam-after.json && diff ~/iam-before.json ~/iam-after.json`.
- C36 `gcloud pubsub topics create billing-guard --project=$P`
- C37 `gcloud iam service-accounts create hireframe-billing-guard --display-name="Hireframe billing guard" --project=$P`
- C37b `gcloud projects add-iam-policy-binding $P --member=serviceAccount:hireframe-billing-guard@$P.iam.gserviceaccount.com --role=roles/billing.projectManager --condition=None`
- C37c `gcloud iam service-accounts add-iam-policy-binding hireframe-billing-guard@$P.iam.gserviceaccount.com --member=serviceAccount:$SA --role=roles/iam.serviceAccountUser --project=$P`
- C38 (after the deploy) `gcloud functions add-invoker-policy-binding billingGuard --region=$R --member=serviceAccount:hireframe-billing-guard@$P.iam.gserviceaccount.com --project=$P`
- C38b (only if the deploy fails on Eventarc permissions) `gcloud projects add-iam-policy-binding $P --member=serviceAccount:$SA --role=roles/eventarc.developer --condition=None`
- C39a (read, before C39 on either path) `gcloud eventarc triggers list --location=$R --project=$P --format='table(name,serviceAccount,destination.cloudRun.service,transport.pubsub.topic)'`, and the same with `--location=global`. No row may show `<NUM>-compute@developer.gserviceaccount.com`. `billingGuard`'s must show `hireframe-billing-guard@…`.
- C39b (read) `gcloud functions list --regions=$R --project=$P --format='table(name,serviceConfig.serviceAccountEmail,eventTrigger.serviceAccountEmail)'`. Every function shows `hireframe-fns@…`, except `billingGuard`, which shows `hireframe-billing-guard@…`.
- C39, the build account. **Path D:**
  - `gcloud iam service-accounts create hireframe-build --display-name="Hireframe functions build" --project=$P`
  - `gcloud projects add-iam-policy-binding $P --member=serviceAccount:hireframe-build@$P.iam.gserviceaccount.com --role=roles/logging.logWriter --condition=None`
  - `gcloud artifacts repositories add-iam-policy-binding gcf-artifacts --location=$R --member=serviceAccount:hireframe-build@$P.iam.gserviceaccount.com --role=roles/artifactregistry.writer --project=$P`
  - `gcloud projects add-iam-policy-binding $P --member=serviceAccount:hireframe-build@$P.iam.gserviceaccount.com --role=roles/storage.objectViewer --condition='expression=resource.name.startsWith("projects/_/buckets/gcf-v2-"),title=gcf-sources'`
  - `gcloud iam service-accounts add-iam-policy-binding hireframe-build@$P.iam.gserviceaccount.com --member=serviceAccount:$SA --role=roles/iam.serviceAccountUser --project=$P`
  - the build-account setting the spike found;
  - then `gcloud iam service-accounts remove-iam-policy-binding <NUM>-compute@developer.gserviceaccount.com --member=serviceAccount:$SA --role=roles/iam.serviceAccountUser --project=$P`.
- C39, **Path F:** the same three grants to `<NUM>-compute@developer.gserviceaccount.com` instead.
- C39, **both paths:** `gcloud projects remove-iam-policy-binding $P --member=serviceAccount:<NUM>-compute@developer.gserviceaccount.com --role=roles/editor --condition=None`, then C35a's `iam-after.json` and `diff`.
- C40 (rollback only) `gcloud projects add-iam-policy-binding $P --member=serviceAccount:<NUM>-compute@developer.gserviceaccount.com --role=roles/editor --condition=None`
- C35 (dry-run verify)
  - Below the threshold: `gcloud pubsub topics publish billing-guard --project=$P --message='{"budgetDisplayName":"hireframe-kill","costAmount":1,"budgetAmount":25,"currencyCode":"GBP"}'`, which must log `billing_guard.below`.
  - At the threshold, **only while dry_run**, which must log `would_disable`.
- C42 (arming, a separate approval after C35, and only if C26/C30 proved `billing.projectManager` is enough) merge the `chore:` PR that sets `BILLING_GUARD_MODE=armed`, then C4 with `v1.0.1`, then C14b, then C35 below the threshold only.
- C41 (laptop) `gcloud auth revoke`
- **No `gh api` writes in M8.** The CI job keeps the name `audit`, so the ruleset is unchanged. Read only: `gh api repos/herbianalfa-cloud/hireframe/dependabot/alerts/4 --jq '.state'`.

## Verification
- **8A:** the gate; the emulator scan is `succeeded` with `echo-gone` listed as no longer existing; `npm run dev` Today with `hfMarks()` shows `hf:prefetch` before `hf:owner`; live step 89 median ≤ 2,000 ms (otherwise stop and report with the marks table); the next live scheduled run is Succeeded; `npm run audit` passes locally and in CI, and fails on a planted fixture. Owner steps: **Lighthouse accessibility on Pipeline ≥ 95**, and the **360 px real-phone check of the 5-column tab bar**. Both are required before v1.0.0.
- **8B:** the gate; `node scripts/load-test.ts` passes its criteria and prints its table, including the sweep, the 12 hydrator reads, and whether 32 S3 calls plus the 12 reads finished inside 450 s; emulator wipe and retention tests; on live, the preview counts look right (the owner decides whether to actually wipe); the restore drill succeeds; three scheduler jobs.
- **8C:** the gate; the throwaway kill-switch test unlinks billing (C30); the trigger account is `hireframe-billing-guard` (C14b) and no trigger or function uses the compute account (C39a, C39b); the IAM diff shows only the intended changes; the v1.0.0 deploy builds with Editor removed; dry-run logs; the SECURITY checklist is fully ticked with evidence.

## Production data I need (8A, before or at the start of the session)
The System screen can't show it all. Source cards show only the latest status, "Broken job boards" appears only after 3 misses in a row, and run rows don't say why a run was Partial (8A fixes that). Please read:
1. **System → Sources → Greenhouse and Lever cards:** the "Why" line and the counts (fetched, errors).
2. **System → Broken job boards** (if shown): each row's `type:token`.
3. **Firestore console → `companies` → Filter `lastScan.status` `==` `not_found`:** for each doc, the doc ID, `ats.type`, `ats.token`, `ats.host`, `lastScan.consecutiveFailures` and `lastScannedAt`. These are public facts only.
4. **Firestore console → `runs`:** the doc whose `startedAt` is 9 Oct around 17:30. Its `status`, `trigger`, each `perSource.<id>.status` and `.errorCode`, the `errors` array (codes only), and whether `perStage` has every stage. Then the same for the 13 Oct 07:30 run.
There is no v0.7.3 marks table. 8A's first step 89 run after v0.8.0 records one.

## Decisions (plan review, 13 Oct)
1. Skip broken boards, re-probe weekly; 404 boards no longer make runs Partial (ADR-056).
2. Kill switch: £25 actual, ships dry run, arming is a separate approved step after C35 (C42). `billing.projectManager` if the spike proves it is enough; otherwise arming leaves M8.
3. No marks table. If the prefetch misses 2,000 ms: stop and report. No persistent cache.
4. The wipe includes `events` and `alertMessages`; "Also reset profile" checkbox, off by default; on System; `companies` returning from the seed is accepted.
5. Managed Firestore backups; no off-project export.
6. The no-self-triggering check goes in CLAUDE.md's working method; the owner updates PLAYBOOK.
7. Path F is accepted if the spike fails.
8. The App Engine default account goes to the ROADMAP parking lot.

## Moves out of M8
- **GCP spend on System and the digest** (billing plan item 4): parked. It needs a BigQuery billing export.
- **Kill switch arming:** in M8 as C42 only if `billing.projectManager` suffices; otherwise parked, and `billingGuard` stays in dry run.
- **App Engine default account's Editor:** parked.
- **Passkey, recovery check, virtual card, budget emails:** owner tasks with no code. Track them in the SECURITY checklist, not in a PR.
- **Load test:** stays in M8 (8B) because it sizes the wipe loop, but if 8B runs long it can be cut to its own small PR before v1.0.0.
- **Not proposed:** the speed fix and the audit gate stay in M8. R7 is a PRD acceptance criterion, and the audit hole is small.
