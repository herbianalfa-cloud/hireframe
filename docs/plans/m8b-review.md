# PR #37 review (self-review + security review): findings and fix plan

## Context
PR #37 `feat/m8b-data-lifecycle` → `main` (head `ff6234c`, 84 files, +5,788/−61), M8 8B v0.9.0. Reviewed read-only against CLAUDE.md hard rules, `docs/SECURITY.md`, `docs/plans/m8b-plan.md` and m8-plan §8B, going through the 10 checklist items in order. No code was changed. This file lists the findings, then the fixes to make once you approve them. The gate runs again after the fixes.

What I checked: I read all of `functions/src/wipe/*`, `functions/src/retention/*`, the lock changes (`scan/store.ts`, `applications/*`, `funnel/rescore.ts`, ingest, Lookup), `profile/reset.ts`, the web dialog and services, the load-test entry points and their tests, and every docs diff. I checked the gcloud syntax against the current Google Cloud reference pages. I did not re-run the gate locally. CI ran all 7 gate steps on this exact tree: `main` hasn't moved since `48cfe99`, and CI covers format:check, check, build, smoke, check:bundle, test:rules and audit, plus gitleaks. All of them are green.

**Security verdict:** no security must-fix. The destructive callable's controls hold: owner first, App Check consumed, strict input, refusals before any delete, bounded passes, it never calls itself, one instance and one request at a time. The retention job is scheduled only, has `retryCount` 0, and re-checks every condition in its transaction. There are no secrets or PII in the diff, and logs carry counts and codes only.

## Checklist results
| # | Item | Result |
|---|---|---|
| 1 | deleteAllData | Pass. `requireOwner` runs before `request.data` is read (`wipe/callable.ts:30`). App Check is enforced and consumed. `z.strictObject`. Refusals (live holder, `generating`, parsing when ticked) all run before `acquire` and any delete. `done` needs remaining empty and 0 deleted. The kept and deleted lists match the plan, and all 14 collections are accounted for. Never self-calls. **But:** S3 (the profile step can start after 90 s), S4 (a call can delete 3,001) and D1 (profile-pass wording). |
| 2 | Wipe lock | Pass. scanNow, rescore, ingest (503), Lookup `add` (60 s) and all 7 application actions refuse. A scheduled scan waits 4 min, then skips. A stale wipe lock doesn't block (emulator test). The lock is released only when done, with no cooldown. **But:** S2 (re-score shows the scan wording). |
| 3 | Kept source docs | Pass. `pausedHosts()` and `quotas()` read field by field. A scan writes both back. The unit scan test covers a pause on a kept-only doc. The emulator test checks the store reads. |
| 4 | purgeOldData | Pass. Every condition is re-checked on fresh reads inside each transaction. The `(judgedAt, id)` cursor uses `startAfter(ts, id)` with a doc-ID tie-break. `judgedAt` is written from a JS Date, so there is no sub-millisecond drift. Limits: 500, 100/tx (≤ 200 writes), 240 s, 300 s, `maxInstances` 1, `retryCount` 0. **But:** S1 (a later scan can bring a purged description back), S6 (no zod on its reads). |
| 5 | Rules, indexes | Pass. `firestore.rules` and `storage.rules` are unchanged (default deny). The new `jobs (verdict ASC, judgedAt ASC)` index is in the file, the deploy ships it (`--only …,firestore,…`), and the spec test passes. |
| 6 | Load test | Pass. It refuses `LIVE=1` (in the outer and inner process), uses a hard-coded `demo-hireframe-load` and requires both emulator hosts. It uses a fake fetch and a fake model. The probe is absent in production and the funnel is identical without it (tested). Load-test code is out of the bundle by construction (nothing in `index.ts` imports it). The smoke test would only catch it indirectly (T7). Hardening: N4. |
| 7 | Web | Pass. No auto-retry (only the read-only preview counts retry). Exact `DELETE`. The box is off by default. Counts are summed across calls and across Continue. **But:** S5 (the dialog can be closed mid-run). |
| 8 | Secrets, PII, logs | Pass. gitleaks and the PII scan are green. New log events: `wipe.refused/pass`, `retention.done/failed`, all counts or error class and code. |
| 9 | RUNBOOK Part J | **Fail** (M1). |
| 10 | Gate, CI | Pass (see above). |

## Must-fix
**M1. RUNBOOK Part J can't be followed as written** (`docs/RUNBOOK.md:446-469, 527`)
- Step 100 gets C12 and C13 wrong. It calls C12 "Run it once" and C13 "read the log for `retention.done`".
  - In the plan, C12 is `gcloud scheduler jobs describe firebase-schedule-purgeOldData-europe-west2 …`, which must print `30 3 * * *`, `Europe/London` and `hireframe-fns@…`.
  - C13 is `gcloud run services get-iam-policy purgeolddata …`, which must print **only** `serviceAccount:hireframe-fns@…`.
  - The invoker-only check is the one that keeps later deploys from failing, and the runbook has no command for it.
- Step 100 has no C11 command. Step 101 cites C3 and C14, whose commands exist only in `m8-plan.md`. Step 94.4, the earlier scheduled-function step, gives the literal commands and the expected output.
- The Recovery entry "purgeOldData has no schedule" is prose only. Its two sibling entries have a command block, and C13b exists in the plan.
- The gcloud syntax itself is current: C10–C14, C13b, C15 (`--retention=8w`, max 14w; `--day-of-week=SUN`), C16–C20, C20b and C20c all match today's reference. Firestore is in europe-west2, so the backup `--location` is right.

## Should-fix
- **S1. A later scan can bring back a purged description, and retention never removes it again.**
  - `packages/shared/src/dedupe.ts:316` `descriptionUpgrade`: a purged job keeps `descriptionKind: 'snippet'`. Its `description/raw` is gone, so `stored` is 0.
  - A later full-text match (another board, or Reed full text) then makes `writePlan` re-create `description/raw` and set `descriptionKind: 'full'`, while `descriptionPurgedAt` stays set.
  - Retention skips it forever: it is already purged and the cursor is past it. That breaks SECURITY's "skip descriptions purged after 60 days" for that job.
- **S2. Re-score shows "A scan is running" while a wipe holds the lock.** `functions/src/funnel/rescore.ts:113` maps only `email` and `lookup` to `busyMessage`.
- **S3. The profile step has no deadline check.** `wipe/run.ts:121` can start the unbounded `resetProfileCore` after 90 s. The plan says no new step starts after 90 s.
- **S4. A call can delete 3,001 documents.** In `wipe/store.ts:30`, `perPage = max(1, floor(limit/2))`. With 1 document left in the cap at the jobs step, it deletes a job and its description.
- **S5. The dialog can be closed mid-wipe.**
  - Escape, an outside click or the X all close it (`DeleteAllData.tsx:268`, `onOpenChange={setOpen}`).
  - The form unmounts, but `runWipe` keeps calling up to 20 times with no visible progress or error.
  - Reopening shows a fresh form, which can start a second loop.
- **S6. Retention reads Firestore without zod** (CLAUDE.md code standard).
  - `retention/store.ts:12-16` checks the cursor by hand, and `:47` casts with `as PurgeCandidate`.
  - A malformed `judgedAt` would throw inside the transaction and pin the cursor, so every night would fail at the same chunk.
- **S7. The erase wording leaves out Storage soft delete.** Wiped CV files, and uploads when ticked, stay restorable for 7 days. SECURITY "Data retention" (`:33`), RUNBOOK "Full erase after a wipe" (`:529`) and the dialog's backups line (`DeleteAllData.tsx:215`) mention only the 8-week Firestore backups.
- **S8. The ARCHITECTURE data model is missing two plan items:** `descriptionPurgedAt` on `jobs/{jobId}` (`:67`), and the kept-only `sources/{id}` shape `{ quota?, pausedHosts?, updatedAt, schemaVersion }` (`:79`).
- **S9. There is no backup between the deploy and the first READY Sunday backup, but the wipe is live from the deploy.** C15 has no code dependency, so it can run at J1, before the tag.

## Nits
- N1. CHANGELOG line 7 says "ADR-057 to be written in session 4". Line 25 says "The lever is `runBudgetPence` 54", which the owner decided against.
- N2. `web/src/services/system.ts:63` duplicates the kept source fields from `functions/src/wipe/plan.ts`. They belong in `packages/shared/src/wipe.ts`.
- N3. `wipe/store.ts:90` uses a literal `20` (delete concurrency). It belongs in `WIPE`.
- N4. The load test's `demo-*` check reads `GCLOUD_PROJECT`, which the script sets itself. The Admin SDK takes its project from `FIREBASE_CONFIG` (`??=` keeps a pre-set value, `loadtest/run.ts:193`). Prod still can't be reached, because both emulator hosts are required, so this is hardening only.
- N5. The done summary counts profile facts and uploads twice: once in "Deleted N documents" and again in the profile line.
- N6. The comment at `tests/emulator/wipe.test.ts:220` doesn't match the assertion under it.
- N7. The first scan after a wipe logs `store.invalid_doc` for each kept-only source doc (from the full parse in `sourceStates()`).

## Your call
- **D1. When the profile step runs.**
  - The code runs `resetProfileCore` on the first pass whose check finds steps 1–9 empty, even if that pass deleted the last jobs. It then re-runs it as a no-op until a clean pass returns `done`.
  - That matches m8b-plan B1 step 10 and ADR-057. Your checklist says "only on that pass" (the clean pass).
  - There is no safety difference, because `done` still needs a clean pass afterwards.
  - **Recommend: keep it and pin it with a test.** The stricter rule would be a one-line condition, a test and ADR wording.

## Missing tests (added with the fixes)
- T1. Callable: a non-owner sending *invalid* input gets `permission-denied`. This proves the owner check runs before the input is read; today's tests send valid input.
- T2. Wipe: `liveLockHolder` says the lock is free but `acquire` refuses (a race) → a refusal, with nothing deleted.
- T3. Wipe: the profile step doesn't start after 90 s, and a ticked call that skipped it is not `done` (S3). The cap is exactly 3,000 with an odd remainder (S4). The D1 behaviour is pinned.
- T4. Re-score shows the wipe wording (S2).
- T5. Retention, on the emulator: ties across a page boundary through the real `startAfter(judgedAt, id)` query, with mixed-case IDs. Call `store.readPage` directly with a small limit; today's unit test uses a fake and lowercase IDs.
- T6. Dedupe: a purged snippet job isn't upgraded. One waiting for a description is upgraded and its stamp cleared (S1).
- T7. Load-test code isn't in `functions/deploy/`. Today the smoke test catches this only indirectly. `loadtest/run.ts` reaches `fakeTransport`, which reaches `ingest/fake-answers.ts` and its "Founding Product Analyst" marker. But `data.ts`, `counting.ts`, `report.ts`, `transport.ts` and `fetch.ts` carry no marker. An explicit import-walk check is cheap.
- T8. Web: closing the dialog mid-run is ignored, and the loop still stops at 20 or on an error (S5).
- T9. Retention: a malformed job or cursor doc is skipped, not thrown (S6).
- T10. A scan after a wipe, with Adzuna's kept quota at its daily limit, makes no Adzuna request and writes the quota back. The plan asked for a fake scan; the PR only checks the store read.

## Risks (no code change unless noted)
- **A second tab may be refused, not queued.** With `maxInstances` 1 and `concurrency` 1, Cloud Run may answer a concurrent call with 429 instead of queueing it. That is safe (the dialog shows an error), but the comment at `wipe/callable.ts:18` and m8b-plan say "two tabs run one after the other". I'll reword the comment.
- **Accepted, with tests:** the application lock read isn't atomic with the wipe; retention never revisits a job it passed while that job was ineligible; the Reset profile core uses an unbounded `recursiveDelete`.
- **Orphaned `description` docs** (no parent job) are invisible to the wipe's collection queries. None should exist, because every writer batches the job with its description or uses a precondition. The emulator test checks them with a collection-group read.
- **Pre-existing, not this PR:** a scan with a source in `config.disabledSources` rewrites that source's doc without `quota` (a full `set`), so a kept quota is lost if the source is disabled on the same day. I'll add it to the ROADMAP parking lot.

## Fix plan (after approval; same branch, small Conventional Commits)
1. **`docs: runbook Part J commands, erase wording, data model`** (M1, S7, S8, S9, N1)
   - Rewrite step 100 on the step 94.4 pattern: the C11/C12/C13 commands with their expected output, plus an optional "run once, read `retention.done`".
   - Step 101 gets the C3 and C14 commands with expected values. For `deleteAllData`, C14 also prints `serviceConfig.maxInstanceRequestConcurrency` = 1.
   - Recovery gets the C13b block.
   - Move C15 and C16 into J1. Step 99 gets: no real wipe until C17 shows a READY backup.
   - Add the soft-delete clause to SECURITY, the RUNBOOK and the dialog.
   - Add the two ARCHITECTURE model lines, the CHANGELOG wording fixes, and the ROADMAP parking-lot line for the disabled-source quota.
2. **`fix(wipe): profile step deadline, exact document cap`** (S3, S4, D1 pin, N3, T2, T3)
   - In `wipe/run.ts`:
     - The profile step runs only while there is time left, and a ticked call that skipped it is never `done`.
     - The jobs step needs at least 2 documents of cap left, otherwise it is marked unfinished.
   - `WIPE.fileDeleteConcurrency` replaces the literal 20.
3. **`fix(rescore): wipe busy wording`** (S2, T4)
   - In `funnel/rescore.ts`, any holder in `SHORT_LOCK_HOLDERS` goes through `busyMessage`.
4. **`fix(scan): never restore a purged description`** (S1, T6)
   - Add `descriptionPurgedAt` to `JOBS_BY_KEYS_SELECT` (`funnel/queries.ts:38`), the projection and `ExistingJobKeys`.
   - `descriptionUpgrade` gives no upgrade for a purged target, unless it is waiting for a description (`next === 'description'`). In that case the update also deletes `descriptionPurgedAt` (`scan/store.ts` `writePlan`); its re-judgement re-stamps `judgedAt`, so retention sees it again.
5. **`fix(retention): parse the cursor and jobs with zod`** (S6, T5, T9)
   - Add schemas in `retention/store.ts`. A failed parse counts as kept and the cursor moves on.
   - Add the emulator ties test.
6. **`fix(system): keep the wipe dialog open while it runs`** (S5, N5, T8)
   - Lift `running` to `DeleteAllData`, and ignore close requests while a pass runs. Add the line "Keep this open until it finishes".
   - The summary shows the profile counts separately from the data counts.
7. **`test/chore: the owner check before input, load-test code out of the bundle, hardening`** (T1, T7, T10, N2, N4, N6, N7)
   - The callable test.
   - A static and dynamic import walk from `functions/src/index.ts` must reach no file under `functions/src/loadtest/`.
   - The scan quota test.
   - Move the kept-fields list to shared.
   - The load test always sets `FIREBASE_CONFIG` and refuses a non-demo `GOOGLE_CLOUD_PROJECT`.
   - Fix the stale comment.
   - `sourceStates()` stops warning about kept-only docs.
8. **Docs, then the gate.**
   - CHANGELOG 0.9.0 "Fixed (review)" lines, the `wipe/callable.ts` comment on two tabs, and ADR-057 wording if D1 changes.
   - The full 7-step gate, push, CI green, and update the PR's deviations list.

## Verification
- The gate, in order: `npm run check`, `npm run format:check`, `npm run test:rules` (wipe, retention, applications and worker emulator tests), `npm run build`, `npm run check:bundle`, `node scripts/smoke-functions-bundle.ts`, `npm run audit`. CI must be green on the PR.
- New and changed unit tests T1–T10 pass. The existing wipe, retention, application and dialog tests stay green.
- Manual, with `npm run dev`: System → Danger zone → start a wipe, then press Escape mid-run. The dialog stays open, and it finishes with a summary. Profile survives unticked.
- Read through RUNBOOK Part J against m8-plan C1–C20c. Every C step has its command and expected output in the RUNBOOK itself.
