# PR 8B: data lifecycle (v0.9.0): plan

## Context
M8 closes Wave 1. 8A (v0.8.0, v0.8.1) is merged. 8B adds the data-lifecycle pieces that are so far only described in the docs:
- **"Delete all my data"**, deferred from M3. SECURITY promises it, and ADR-025 needs Adzuna data to be removable.
- **The 60-day purge** of skip-job descriptions (SECURITY "Data retention"; no code exists today).
- **Backups.** The documented `weeklyBackup` was never built. It is replaced by managed Firestore backups plus a restore drill.
- **A 1,000-job load test.** It answers ADR-032's open question ("do 32 S3 calls fit inside 450 s?") and sizes the wipe loop.

Also in this PR:
- Fresha moved to Teamtailor, which we don't support. Its seed row becomes `keep-none` (your answer).
- A ROADMAP parking-lot line for a Teamtailor source.

Branch `feat/m8b-data-lifecycle` from `main` (48cfe99). One PR, tag v0.9.0. The self-review, the security review and their fixes are **not** part of the build sessions: you run them in separate Opus sessions on the open PR.

**Conflicts found and settled with you:**
1. You said to set `watch: false` in the seed, but the seed has no `watch` field. Settled: Fresha is marked `keep-none` in `tmp/watchlist-review.csv`, then `--write`.
2. Your gate had 3 steps; m8-plan's has 7. Settled: the full m8-plan gate (below), which includes your three.

**Notes (no conflict):**
- The m8-plan test "`backups/` survives" covers a Storage prefix nothing writes any more (B3 drops the JSON export). It stays as a guard that the wipe touches only `cvs/` (and `profile/documents/` when ticked).
- `alertMessages` can't be read by the client, so the preview shows that line without a count.

## Sessions: 4, one branch, one PR
| Session | Scope | Ends with |
|---|---|---|
| **1. Wipe server** | Fresha seed, parking-lot line, shared schemas and the `wipe` lock holder, the `application` callable's wipe refusal, Reset profile core refactor, source docs that keep only quota and pauses, `deleteAllData` (plan, run, store, callable), unit and emulator tests, the worker's lost-path clean-up check | `docs/plans/m8b-handoff-1.md` |
| **2. Wipe UI + retention** | System → Danger zone → `DeleteAllData.tsx`, `services/wipe.ts`, `purgeOldData`, the new index, `descriptionPurgedAt` and the job sheet line, unit and emulator tests | `docs/plans/m8b-handoff-2.md` |
| **3. Load test** | The funnel probe hook, `scripts/load-test.ts`, running it and recording the table, the ADR-032 addendum | `docs/plans/m8b-handoff-3.md` |
| **4. Docs + PR** | ADR-057, ADR-058, ARCHITECTURE, SECURITY, RUNBOOK Part J and Recovery, ROADMAP, CHANGELOG 0.9.0, CLAUDE.md; the full gate; then open the PR with the deviations list | PR |

Each handoff note holds: commits so far, decisions taken in the session, deviations from this plan, open items, and the gate state at the end of the session.

---

## B0. Housekeeping (session 1, first commits)
- **Fresha:** in `tmp/watchlist-review.csv` (gitignored), set the Fresha row to `decision=keep-none` and `decisionReason="moved to Teamtailor (careers.fresha.com), not supported"`. Then run `node scripts/detect-ats.ts --write tmp/watchlist-review.csv`.
  - **Check:** `git diff packages/shared/src/watchlist-seed.ts` may only change the Fresha row (`ats: { type: 'none' }`). If any other row changes, stop and report: the CSV has drifted from the seed.
  - The live `companies/fresha` (`watch: false`) is untouched: the seed never overwrites prod.
  - `watchlist-seed.test.ts` stays green.
- **ROADMAP parking lot:** add "Teamtailor source (verify a public endpoint and ToS first)."
- Commits: `fix(watchlist): Fresha has no supported board (keep-none)` and `docs(roadmap): park a Teamtailor source`.

## B1. Delete all my data (ADR-057)

### Function
| | |
|---|---|
| Name | `deleteAllData` (**new callable**, flagged: needs **C10** after deploy) |
| Trigger | `onCall`, `ownerOptions` (App Check **enforced and consumed**) |
| Limits | `maxInstances: 1`, **`concurrency: 1`** (a second call waits for the first), `timeoutSeconds: 120`, `memory: '512MiB'`, no secrets |
| Invoker | `allUsers` (C10). Safe for the same reason as every callable: App Check plus the owner check |

### Order inside each call
1. **`requireOwner(request)` first.** This is the owner UID check, then refusal of a consumed or replayed App Check token, using the existing `auth.ts`.
2. **Validate the input** with zod (`DeleteAllDataInputSchema`, shared): `{ confirm: 'DELETE', resetProfile: boolean }`, strict. Anything else is `invalid-argument`, and nothing is touched.
3. **Refusals, before any delete:**
   - `locks/scan` is held (not stale) by `scan`, `rescore`, `email` or `lookup` → `failed-precondition` with the holder's wording.
   - Any `applications` doc is at `stage == 'generating'` → "Wait for the CV being written."
   - `resetProfile: true` and a CV is being read → Reset profile's own wording. This is checked on every call, so a partial wipe never starts.
4. **Take or refresh the lock** as holder `wipe`, with the fixed `runId` `'wipe'`, `staleAt = now + 3 min`, and `lastFinishedAt` kept. This is a new `acquireOrRefreshWipe` in `scan/store.ts`. A stale lock left by a dead scan is taken over (its run is marked failed, as today).
5. **Run the steps in a fixed order, starting again at step 1 on every call.** Each step re-queries and deletes what is there now. **`done: true` only when one call's pass finds steps 1 to 9 all empty, with nothing deleted in that pass** (a doc written mid-wipe is caught by the next call). A last empty-check pass costs reads only (`limit(1)` per collection, one Storage listing with `maxResults: 1`) and counts against the 90 s:
   1. `applications` (first, so the worker and Pipeline stop seeing work)
   2. Storage `cvs/`: one listing page of 200 at a time (`autoPaginate: false`), each file deleted with `ignoreNotFound`
   3. `cvs`
   4. `jobs`: each job and its `description/raw` go in the same batch
   5. `runs`
   6. `events`
   7. `alertMessages`
   8. `companies`
   9. `sources`: a doc with `quota` or `pausedHosts` is rewritten to just those fields plus `updatedAt` and `schemaVersion`; every other source doc is deleted
   10. **Only if ticked, and only once steps 1 to 9 are empty:** `resetProfileCore`, which is Reset profile's core extracted from `profile/reset.ts`. Its own parse check stays.
6. **Bounds (`WIPE` in `functions/src/config.ts`):**
   - at most 3,000 documents per call (a description subdoc counts as one);
   - at most 20 Storage listing pages of 200;
   - batches of at most 400 ops;
   - **no new page or step starts after 90 s** (`deps.now()`, so the tests use a fake clock).
7. **Result:** `{ done, deleted: { documents, files }, remaining: WipeStep[], profile? }`.
   - `remaining` lists the steps not confirmed empty in this call's pass. A call that deleted anything, or ran out of budget or time, returns `done: false`.
   - Done: the lock is released (as a short holder, so no scan cooldown starts).
   - Not done: the lock is kept and refreshed.
   - The function **never calls itself**. The client repeats the call.

**Safe to rerun after a partial failure:** no step depends on stored progress. Every call re-reads what is left, deletes are idempotent, and a job and its description go in one batch, so a failed batch leaves both or neither.

**Deleted:** `applications`, `cvs`, Storage `cvs/`, `jobs` with `description/raw`, `runs`, `events`, `alertMessages`, `companies`, and `sources` apart from `quota` and `pausedHosts`. When ticked, also every fact with its versions, every upload doc, `profile/main`, `profile/cvHeader` and Storage `profile/documents/`.

**Kept:** `config`, `criteria`, `usage` (the spend cap), `locks` (including `locks/retention`), `nonces`, each source's `quota` and `pausedHosts`, and the profile unless ticked. Managed backups keep data for up to 8 weeks; the dialog says so and points to the RUNBOOK full-erase step (C20b).

### Changes elsewhere for the `wipe` holder
- `packages/shared/src/jobs.ts`: add `wipe` to `LOCK_HOLDERS` and `SHORT_LOCK_HOLDERS`. A scheduled scan then waits up to 4 min, then skips.
- `scan/store.ts`: `isShortHolder` reads `SHORT_LOCK_HOLDERS`; `lockStaleMs('wipe')` is 3 min.
- `scan/handler.ts` `busyMessage`: "Deleting your data, try again when it has finished."
- `config.ts` `LOOKUP.busyRetrySeconds.wipe`: 60.
- Ingest already answers `busy` (503) to any holder. A test pins that for `wipe`.
- **The `application` callable refuses while `wipe` holds the lock** (not stale), with `failed-precondition` and `busyMessage('wipe')`. Every action is covered, because each one creates a document:
  - `start` creates `applications/{jobId}` and an `application_stage` event;
  - `answer` creates a fact;
  - `retry`, `skip`, `skipAll`, `regenerate` and `withdraw` each append an event.
  
  The check is one read of `locks/scan` in `applications/run.ts`, before anything else, through a new `ApplicationDeps.lockHolder()`. It isn't a transaction precondition: the wipe's own `generating` refusal and its `applications`-first order cover the race in which a start lands in the instant before the wipe takes the lock.
- **Client Pipeline writes need no refusal.** These are the Applied mirror batch (job + event + `applications/{jobId}`) and job actions (job + event).
  - The wipe deletes `applications` first and `jobs` before `events`.
  - A batch on a deleted job or application fails as a whole (an update needs the doc), and so writes nothing.
  - A batch that lands earlier is swept by the later steps.
  - So no rules change is needed. The UI shows the write's normal error.
- **`generateCvs`** needs no change: the wipe refuses while anything is `generating`, and `application` can't move anything to `generating` while the lock is held.
- **Kept source docs:** today `sourceStates()` carries `pausedHosts` through a full `SourceHealthSchema` parse, so a quota-only doc would lose its pauses. Fix:
  - `scan/store.ts` reads `pausedHosts` field by field, as `quotas()` already does;
  - `web/src/services/system.ts` shows a kept-only doc as "No scan since your data was deleted", not as invalid;
  - `functions/src/sources/ats-pauses.ts` gets checked the same way.

### Files
- **New:** `functions/src/wipe/{plan,run,store,callable}.ts`
- **Changed:**
  - `functions/src/index.ts` (export)
  - `functions/src/config.ts` (`WIPE`)
  - `functions/src/profile/{reset,callables}.ts` (`resetProfileCore`)
  - `functions/src/scan/{store,handler}.ts`
  - `packages/shared/src/wipe.ts` (new), plus `jobs.ts`, `callables.ts` (`deleteAllData: 120`) and `index.ts`
- **Web (session 2):**
  - `web/src/services/wipe.ts`: `previewCounts()` runs one `getCountFromServer` per readable collection, each settling on its own; `deleteAllData()` uses `callOwnerCallable` with a limited-use token and never retries;
  - `web/src/features/system/DeleteAllData.tsx`, plus a Danger zone section on `SystemPage.tsx`.

### UI (session 2)
- System → **Danger zone** → "Delete all my data" opens a dialog with:
  - the preview counts, each with its own skeleton and "unavailable" on failure;
  - what is kept;
  - **Also reset profile** (off by default);
  - "the next scan re-creates the watchlist from the seed, so console edits are lost";
  - "backups keep data for up to 8 weeks";
  - a typed `DELETE`.
- **Progress loop:** up to 20 calls with a progress line ("Deleted n documents and n files so far · still to do: jobs, runs"). Then it stops and shows **Continue** (20 more). An error or refusal stops the loop and shows the message, with no automatic retry. When done: a summary, plus the profile counts if ticked.

### Tests
**Unit (`functions/src/wipe/run.test.ts`, in-memory store, fake clock):**
- wrong or missing confirm, or a missing `resetProfile` → `invalid-argument`, with zero store calls;
- a non-owner and a replayed token are refused before the input is read (`requireOwner` order);
- refused on each live holder, on a `generating` application, and on ticked-while-parsing; nothing is deleted;
- a stale lock is taken;
- the cap: 5,000 docs → the first call deletes ≤ 3,000 with `done: false`, and the second finishes;
- 20 Storage pages per call;
- **the deadline:** the clock moves past 90 s mid-step, and no new page starts;
- a store that throws mid-`jobs` → a second call completes, and a third returns `done: true` with 0 deleted;
- `events` and `alertMessages` are in the plan;
- `quota` and `pausedHosts` are kept, and a source doc with neither is deleted;
- the fake store records that `config`, `criteria`, `usage`, `locks/retention` and `nonces` are never touched;
- the profile step runs only when ticked and only on the call where 1 to 9 are empty;
- the lock is refreshed per call and released only when done.

**Also:**
- `scan/handler.test.ts`, the Lookup and ingest tests: busy wording for `wipe`;
- `applications/run.test.ts`:
  - each of the 7 actions refuses with the wipe wording while `wipe` holds the lock, and writes nothing (no application, event or fact doc, and no model call for `answer`);
  - a stale `wipe` lock doesn't block;
  - a `scan`, `email` or `lookup` holder doesn't block (today's behaviour is unchanged);
- `applications/callable.test.ts`: the refusal reaches the client as `failed-precondition` with the wording;
- `tests/emulator/applications.test.ts`: with `locks/scan` held by `wipe`, `start` leaves no `applications` doc and no event;
- `scan/run.test.ts`: pauses on a kept-only doc survive a scan;
- `index.test.ts`: `deleteAllData` has `maxInstances` 1, concurrency 1, 120 s, 512 MiB and europe-west2;
- `config.test.ts`: 90 s plus one page's worst case fits in 120 s.

**Emulator (`tests/emulator/wipe.test.ts`):**
- Seed every collection, Storage `cvs/…`, `profile/documents/…` and `backups/x`.
- After the loop, every listed collection is empty, including `events`, `alertMessages` and every `description` doc (collection-group read in the test).
- `usage`, `config`, `criteria`, `locks/retention`, `nonces` and Storage `backups/x` survive.
- Unticked: `profile/**` and `profile/documents/` survive. Ticked: they are gone and `criteria` survives.
- The loop ends with a call whose pass found steps 1 to 9 empty and deleted nothing (`done: true`); a further call is also `done: true` with 0 deleted.
- **Unit (`wipe/run.test.ts`):** an `applications` doc appears after step 1 has finished (once step 4 is running): that call returns `done: false` with `applications` in `remaining`, the next deletes it, and the wipe ends with `applications` empty and `done: true`. A call that deleted anything is never `done: true`. Ticked, the profile step runs only in the call whose pass found steps 1 to 9 empty.
- With small injected limits, the wipe finishes over several calls.
- A fake scan after the wipe still honours Adzuna's quota and a paused host.

**Worker (`tests/emulator/worker.test.ts`):** an application deleted while its CV is being written ends `lost`, and its uploaded files are removed (`removeIfUnrecorded` with a missing application). If it doesn't remove them, fix it in session 1 and note the fix.

**Web (session 2):**
- `DeleteAllData.test.tsx`:
  - the preview, including one failed count;
  - the checkbox off by default;
  - `resetProfile` sent as `true` only when ticked;
  - the button disabled until exactly `DELETE` is typed;
  - the loop ends on `done`;
  - it stops at 20 and shows Continue, which runs 20 more;
  - an error stops it and nothing retries.
- `services/wipe.test.ts`: input validated before the call, result parsed, never retried.
- `SystemPage.test.tsx`: the Danger zone and the kept-only source card.
- `indexes.test.ts`: the preview specs.

## B2. Retention job (ADR-057)

### Function
| | |
|---|---|
| Name | `purgeOldData` (**new scheduled function**, flagged: needs **C11, C12, C13**, and C13b if the deploy says "Failed to set invoker") |
| Trigger | `onSchedule('30 3 * * *', Europe/London)`. This is the third and last free Cloud Scheduler job |
| Limits | `maxInstances: 1`, `timeoutSeconds: 300`, `memory: '512MiB'`, `retryCount: 0`, no secrets |
| Invoker | `serviceAccount:hireframe-fns` only (C11) |

### What it does
1. **Read the cursor** `locks/retention`, which is `{ purgedThrough: Timestamp, lastId, lastRunAt, schemaVersion }`.
2. **Query (newest index, see the table):** `jobs` where `verdict == 'skip'` and `judgedAt < now − 60 d`, ordered by `judgedAt` ascending then by doc ID, starting after the cursor, limit 500.
   - The cursor is `(judgedAt, id)` because one run stamps one `judgedAt` on hundreds of S1 skips. A time-only cursor would skip ties at a page boundary.
3. **For each job, purge only when all of these hold:**
   - `status` is `new` or `skipped`. `saved`, `applied`, `interview`, `offer` and `rejected` are never purged;
   - **there is no `applications/{jobId}` doc.** A job links to its application by ID: `PATHS.application(jobId)` is `applications/{jobId}`, so the check is one `getAll` of the page's application refs;
   - no `descriptionPurgedAt` yet;
   - `descriptionKind` isn't `none`.
   
   A job that fails any check is left alone, and **the cursor still moves past it.**
4. **Writes are a transaction per chunk of 100 jobs** (in place of a batch with a precondition, so the application check can't race a Start):
   - read the 100 jobs and their 100 `applications/{jobId}` refs;
   - re-check every condition above on the fresh reads;
   - delete `description/raw` and set `descriptionPurgedAt` and `updatedAt` on each job that still qualifies.
   
   That is at most 200 writes, inside the 400-op limit. A job that changed since the page read (a re-score, a status change, a new application, a wipe) is left alone.
5. **Bounds (`RETENTION` in config):**
   - at most 500 jobs a run;
   - transactions of 100 jobs (at most 200 writes);
   - **no new transaction after 240 s** (`deps.now()`);
   - the cursor is saved after each committed transaction;
   - a store error stops the run and logs `retention.failed`, and the cursor stays at the last commit.
6. **Log:** `retention.done { read, purged, skippedKept, skippedApplication, full }`. `full: true` every day means a backlog (see Risks).
- **No self-triggering:** it runs only on its schedule, has no event trigger, and never re-enqueues itself. No function in the project has a Firestore trigger.
- **S3 and Lookup:** S3 already treats a missing description doc as "no text" (`loadTexts`), which sends the job to the hydrator or `description`. A test pins this for a purged job. Lookup only describes `next: 'description'` jobs; a purged skip job never is one.
- **`JobSchema`** gains an optional `descriptionPurgedAt`; old docs still parse, and no rules change (server field). The job sheet shows "Description deleted after 60 days (skipped job)" instead of "No description stored."

### Files
- **New:** `functions/src/retention/{run,store,queries,schedule}.ts`
- **Changed:**
  - `functions/src/index.ts`
  - `functions/src/config.ts` (`RETENTION`)
  - `packages/shared/src/{jobs,callables,firestore}.ts` (`descriptionPurgedAt`, `purgeOldData: 300`, `DOCS.retentionCursor`)
  - `firestore.indexes.json`
  - `web/src/features/jobs/JobDetail.tsx`

### Tests
- **`retention/run.test.ts` (fake clock):**
  - at 59 days nothing is purged; at 61 it is;
  - `new` and `skipped` jobs are purged;
  - `saved`, `applied`, **`interview`, `offer` and `rejected`** jobs are untouched (one case each), and the cursor moves past them;
  - **a `new` or `skipped` job with an `applications/{jobId}` doc** is untouched (at any stage, `withdrawn` included), and the cursor moves past it;
  - an application created between the page read and the transaction → the job is untouched;
  - a status change between the page read and the transaction (`skipped` → `saved`) → the job is untouched;
  - already-purged and `none` jobs are skipped;
  - 500 per run;
  - the 240 s stop;
  - ties at a page boundary: no job is skipped across two runs;
  - the cursor is saved per transaction;
  - a store error keeps the cursor;
  - every transaction is ≤ 200 writes.
- **`retention/queries.test.ts`:** the spec is served by `firestore.indexes.json` (ADR-040 pattern).
- **`index.test.ts`:** `maxInstances` 1, 300 s, 512 MiB, `retryCount` 0, the schedule string and the time zone.
- **`config.test.ts`:** 240 s plus one batch fits in 300 s.
- **`funnel/run.test.ts`:** a purged job at S3 is routed as no text.
- **`tests/emulator/retention.test.ts`:** old and new skips; every status (`new`, `skipped`, `saved`, `applied`, `interview`, `offer`, `rejected`); an old `skipped` job with an `applications` doc; other verdicts. After a run with an injected `now`, only the eligible raw docs are gone, they are stamped, and the cursor is saved. A second run purges nothing new.
- **`JobDetail.test.tsx`:** the purged line.

## B3. Backups (ADR-058; replaces `weeklyBackup`)
- **Firestore managed scheduled backups:** weekly on Sunday, kept 8 weeks. No code, no function, no Storage path.
- **Storage is not backed up:** the master CV is your own file, and generated CVs can be regenerated. Storage soft delete (7 days by default, read with C20c) covers mistakes.
- **Accepted risk:** backups live in the project, so a project deleted after billing is cut loses them too. No off-project export. The 8C kill switch ships in dry run, and the restore drill comes first.

**Commands for you to run** (Cloud Shell, `P=hireframe-f6b03`, `R=europe-west2`; each is checked in chat first). The restore goes into a **scratch database, never over `(default)`**:

- **Before the drill:** run `gcloud firestore databases restore --help` once, to confirm the flags in Cloud Shell's gcloud.
- **C15** (once, after the deploy) `gcloud firestore backups schedules create --database='(default)' --recurrence=weekly --day-of-week=SUN --retention=8w --project=$P`
- **C16** `gcloud firestore backups schedules list --database='(default)' --project=$P`. It must show one weekly schedule on SUNDAY with 8 weeks' retention.
- **C17** (after the first Sunday) `gcloud firestore backups list --location=$R --project=$P`. Note the newest `<BACKUP_ID>` (the last part of its name) and that its state is READY.
- **Restore drill** (once, on a quiet weekend afternoon, 10:00 to 18:00):
  - **C18** `gcloud firestore databases restore --source-backup=projects/$P/locations/$R/backups/<BACKUP_ID> --destination-database=restore-drill --project=$P`
  - **C18a** (read, repeat until done) `gcloud firestore operations list --database=restore-drill --project=$P`
  - **C19** `gcloud firestore databases describe --database=restore-drill --project=$P`. Then, in the Firebase console, pick database `restore-drill`:
    - **Rules** must deny everything. If not, publish `allow read, write: if false;` there before going on;
    - **Data:** spot-check that `jobs`, `runs`, `profile/main/facts` and `criteria` have documents, and compare a couple of counts with `(default)`.
  - **C20** `gcloud firestore databases delete --database=restore-drill --project=$P`, then `gcloud firestore databases list --project=$P --format='value(name)'`. Only `(default)` may be listed.
- **C20b** (only if you ask for a full erase after a wipe; one per backup) `gcloud firestore backups delete --location=$R --backup=<BACKUP_ID> --project=$P`
- **C20c** (read) `gcloud storage buckets describe gs://hireframe-f6b03.firebasestorage.app --format='value(soft_delete_policy)'`

The RUNBOOK Recovery entry "Data lost" says to restore into a new `restore-<date>` database (C18 with that name), read what is needed there, and then stop and decide with Claude how to bring it back. No automated path back is built.

## B4. Load test of a 1,000-job run (session 3)
**Emulator only, fake data. No live LLM and no network:** the script refuses `LIVE=1` and any project not named `demo-*`.

- **`scripts/load-test.ts [--jobs 1000] [--s1-passes 105]`:**
  - bundles `functions/src/loadtest/run.ts` with esbuild (the `dev-worker` pattern);
  - starts its own `firebase emulators:exec --only firestore,storage --project demo-hireframe-load` (needs Java 21);
  - refuses if the emulator ports are busy (stop `npm run dev` first), so it never touches dev data;
  - takes about 10 minutes in real time, because the deadlines are real.
- **Production code change (one small hook):** `FunnelDeps.probe?` and `FunnelWiring.probe?` are an optional `mark(name, detail)`, called at: S1, sweep and S2/S3 start and end, and each `hydrator.hydrate` start and end. Production passes nothing. It is unit-tested with a fake clock: the marks arrive in order, and the funnel is identical when it is absent.
- **`functions/src/loadtest/`** (never imported by `index.ts`, so not in the deploy bundle; the smoke test already checks fixtures stay out):
  - **`data.ts`** (pure, seeded PRNG):
    - 1,000 jobs on 20 fake Greenhouse boards, mixed so about 105 pass S1 and about 30% pass S2. That is the approved peak (FUNNEL: f·P = 105, n₂ = 99, n₃ = 32 at the 52p lease), and `--s1-passes` stresses it.
    - 12 alert jobs (description `none`, triage score 9) at 12 different watched companies, half with a unique title match on their board (location differs, so ingest doesn't merge them) and half with none.
    - About 300 stale queued jobs across `s2`, `s3` and `description`.
    - `config/app` with `monthlyCapPence: 3200` (prod's approved figure).
    - Criteria v1, the fake CV's facts and work rights.
  - **`transport.ts`:** wraps `fakeTransport`. Latency is S2 about 1.2 s, S3 about 8 s and `countTokens` about 150 ms, with seeded jitter and an injected sleep. **Token counts are calibrated to the real unit costs** (S2 0.151p, S3 1.0p), so the lease binds as it does in prod. The fake's own counts leave out the system prompt.
  - **`fetch.ts`:** the fake Greenhouse API, with robots.txt answering 404, through the **real HTTP client and its 1 s per-host spacing**. It records every request with its time and status.
  - **`counting.ts`:** a Proxy around the Admin Firestore that counts documents read, documents written and the size of each batch (it unwraps proxied refs passed back in). If it proves brittle, reads are reported as "not measured" and the PR says so.
  - **`report.ts`** (pure): evaluates the criteria and prints the table.
  - **`run.ts`:** seeds; run 1 (`trigger: 'schedule'`, cooldown 0); run 2 (identical); then the wipe core in a loop, timed per call.
- **Pass criteria (exit 1 on a miss):**
  - the run is inside 540 s;
  - no fetch after 300 s, no S2 call after 400 s, no S3 call after 450 s;
  - S2 ≤ 300 and S3 ≤ 32;
  - `budget.usedPence ≤ leasePence`, and no reservations left;
  - every batch ≤ 400 ops;
  - peak RSS < 512 MiB;
  - run 2: 0 new, and writes limited to the run doc, sources and company `lastScan`.
- **Reported, never tuned away:** "32 S3 calls + 12 board reads inside 450 s: yes or no", with S3's start and end (s from invocation), `stops.s3`, the S3 call count, the hydrator's 12 reads with outcomes and total time.
- **Table:**
  - stage times: ingest, S1, sweep, S2, hydrate, S3;
  - sweep counts per stage;
  - S2 and S3 calls and stops;
  - reads, writes and the largest batch;
  - peak RSS and the lease;
  - run 2's counts;
  - the wipe: number of calls and documents per call for about 2,000 documents.
- **Unit tests (fake clock):** the data mix counts, the transport's latency and token calibration (injected sleep), the report's evaluation for each criterion (pass and fail), and the counting wrapper (against a fake).
- Results go in an **ADR-032 addendum** ("load test, M8 8B"). Anything changed to make it pass goes in the PR deviations.

---

## New Firestore queries and indexes
| Query | Where | Index |
|---|---|---|
| `jobs` `verdict == 'skip'`, `judgedAt < cutoff`, `orderBy judgedAt asc` (doc ID tie-break), `startAfter`, `limit 500` | `retention/queries.ts` | **New:** `jobs (verdict ASC, judgedAt ASC)`. The existing `(verdict, judgedAt DESC)` can't serve an ascending order (ADR-040). Added to `firestore.indexes.json` and checked by `retention/queries.test.ts` |
| `applications` `stage == 'generating'` `limit 1` | wipe refusal | None (single field, equality) |
| `profile/main/documents` `status == 'parsing'` | wipe refusal (existing Reset query) | None (existing) |
| `<collection>.select().limit(n)` for `applications`, `cvs`, `jobs`, `runs`, `events`, `alertMessages`, `companies`; `sources` get-all | wipe steps | None (document-ID order) |
| `getCountFromServer(collection(x))` for jobs, runs, events, companies, applications, cvs, sources, facts, documents | web preview | None (no filter) |
| `locks/retention` get/set | retention | None (doc read) |

The load test adds no query.

## New functions: manual steps after deploy
| Function | Kind | maxInstances | Timeout | Memory | Invoker | Manual step |
|---|---|---|---|---|---|---|
| `deleteAllData` | **callable** | 1 (concurrency 1) | 120 s | 512 MiB | `allUsers` | **C10** |
| `purgeOldData` | **scheduled** `30 3 * * *` Europe/London, `retryCount: 0` | 1 | 300 s | 512 MiB | `hireframe-fns` only | **C11, C12, C13** (C13b if no job) |

There is **no new non-callable HTTPS function**, so no temporary `cloudfunctions.admin` grant is needed. Both functions are checked with C14. C3 must then list exactly three scheduler jobs.

## PRD acceptance criteria and m8-plan checks met
| Item | Meets |
|---|---|
| B1 wipe | SECURITY "Data retention" ("Delete all my data wipes collections + Storage"); ADR-025 (Adzuna data removable); R1 (owner-only; refusals tested); m8-plan B1 tests and C10 |
| B2 retention | SECURITY "skip descriptions purged after 60 days (metadata kept for metrics)"; CLAUDE.md no-self-triggering (bounded, scheduled only); m8-plan B2 tests and C11 to C13 |
| B3 backups | SECURITY "Data loss" row (rewritten); m8-plan C15 to C20; the 8C checklist item "restore drill done" |
| B4 load test | R4 (a run completes with per-source counts at volume); R11 (the lease is never exceeded); R12 (run timings); the PRD scan reliability metric (≥ 95%, headroom shown); ADR-032's open question; m8-plan B4 criteria |
| Fresha | ADR-056 data-fix step 4 (seed in step with the console) |

## ADRs and docs (session 4; the ADR-032 addendum is written in session 3)
- **ADR-057, Data lifecycle: Delete all my data and the 60-day purge.**
  - The step list, bounds and lock holder; the kept fields.
  - **Deleting `events` is deliberate**, overriding "never deleted" (ADR-038) for a wipe only.
  - `companies` comes back from the seed.
  - Retention purges only `new` or `skipped` jobs with no `applications/{jobId}` doc; the `(judgedAt, id)` cursor and its index; transactions of 100 jobs.
  - `application` refuses while the wipe holds the lock, and client Pipeline writes need no refusal (the step order).
  - The kept source docs and the field-level pauses read.
- **ADR-058, Managed Firestore backups and a restore drill.** It supersedes the `weeklyBackup` JSON export and ADR-023's "no backup until M8's weekly export" line. It records the accepted in-project risk.
- **ADR-032 addendum** (written in session 3): the load-test table and answer.
- **ARCHITECTURE:**
  - functions table: add the two functions, drop `weeklyBackup`, add the backups line;
  - data model: `descriptionPurgedAt`, the `wipe` holder, `locks/retention`, kept source docs;
  - indexes: the new one.
- **SECURITY:**
  - Data retention: built, with the deleted and kept lists, and the backups' 8 weeks;
  - Data loss row;
  - a threat row for the destructive callable.
- **RUNBOOK Part J:**
  - J1: before the tag, step 77 (C1, C2) and the release timing;
  - J2: C10;
  - J3: C11, C12, C13 (C13b);
  - J4: C3, C14 for both functions, and the new index **Enabled** before the first 03:30 run;
  - J5: C15 to C17;
  - J6: the restore drill C18 to C20, plus C20c.
- **RUNBOOK Recovery:**
  - "purgeOldData has no schedule" (the `generateCvs` pattern, `30 3 * * *`, attempt deadline 300 s);
  - "Delete all my data stopped part-way" (press Continue; safe to rerun);
  - "Full erase after a wipe" (C20b);
  - "Data lost" (restore into a new database).
- **Also:**
  - ROADMAP: M8 8B done, plus the Teamtailor parking-lot line (session 1);
  - CHANGELOG 0.9.0;
  - CLAUDE.md Commands: `node scripts/load-test.ts [--jobs N] [--s1-passes N]` (`npm run dev` seed unchanged).

## Risks
- **A wipe can't be undone** apart from the backups. Mitigations: typed DELETE, preview counts, the lock, refusing while a CV is being written, `concurrency: 1`.
- **Writes during a wipe:**
  - Lookup's post-model writes, `application` and the worker are precondition transactions, so on a deleted doc they are dropped;
  - the worker's lost path must remove its files (checked in session 1);
  - scans, re-scores, ingest and Lookup `add` are blocked by the lock.
- **The `application` lock read isn't atomic with the wipe.** A Start can land in the instant before the wipe takes the lock. The wipe's `generating` refusal and its `applications`-first order mean such a doc is refused or deleted, never left behind. The emulator test covers the held-lock case, and the clean-pass rule catches any doc written mid-wipe. (The Applied mirror itself only updates, never creates, an applications doc, so it can't leave one behind.)
- **Kept source docs** would drop paused hosts without the field-level read. It is fixed and tested (B1).
- **Retention backlog.** 500 a day can fall behind if more than about 3,500 skips are judged in a week. The `full` log flag shows it; the fix is to raise `RETENTION.maxJobsPerRun` (it fits 300 s). Re-check a month after the first purge (early Dec).
- **The index isn't built at the first 03:30 run.** The query fails, `retention.failed` is logged, and the next day retries. J4 checks for Enabled.
- **First deploy of a scheduled function.** "Failed to set invoker" leaves no job; C13b fixes it.
- **Load test realism.** Emulator latency isn't prod; it runs in-process (no cold start); the tokens are calibrated. A miss is reported, not tuned. The read counter may be brittle (fallback above).
- **`--write` could change other seed rows** if the CSV drifted. Checked by the diff in B0.
- **Reset profile's core still uses unbounded `recursiveDelete`.** This is existing code, and the profile is a few hundred documents. m8-plan keeps the core as it is; noted in the PR.
- **Deleting `alertMessages`:** an alert still under `hireframe/alerts` would be ingested again. Done ones are not re-sent.
- **The restore drill makes a second database** for minutes (pennies). Its rules are checked in C19.

## Gate after the last commit (full m8-plan order)
1. `npm run check`
2. `npm run format:check`
3. `npm run test:rules` (includes `tests/emulator/wipe.test.ts` and `retention.test.ts`)
4. `npm run build`
5. `npm run check:bundle`
6. `node scripts/smoke-functions-bundle.ts` (both new functions in europe-west2; the load-test code isn't in the bundle)
7. `npm run audit`

Session 4 runs the gate, then opens the PR with its list of deviations. The self-review, the security review and any fixes happen afterwards, in your separate Opus sessions on the open PR. A fix there re-runs the gate before merge.

## Verification
- The gate passes.
- `node scripts/load-test.ts` passes its criteria and prints the table, including the "32 S3 + 12 reads inside 450 s" line.
- The emulator wipe and retention tests pass.
- With `npm run dev`, System → Danger zone shows the preview; a wipe empties Today, Jobs and Pipeline; Profile survives unticked; the next Scan now re-creates the watchlist without Fresha's board.
- **Live, after v0.9.0** (in a release window, nothing Generating):
  - C10 to C14, C3 (exactly 3 jobs: `scheduledScan`, `generateCvs`, `purgeOldData`), the index Enabled;
  - the preview counts look right (you decide whether to actually wipe);
  - C15 to C17, then the restore drill C18 to C20 on a quiet weekend afternoon.
