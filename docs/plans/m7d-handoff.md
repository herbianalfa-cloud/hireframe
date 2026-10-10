# M7 PR 7D: handoff from session 7D.1 to 7D.2 and 7D.3

Branch `feat/m7d-pipeline`, from `main` at `86ef51b`. 7D.1 is the `application` callable, its stores and tests, and the rules. Not started, on purpose: the worker and the CV prompt (7D.2), any web code (7D.3, 7D.4), the dev seed, the end-of-7D docs, ADR-055 and the CHANGELOG entry.

## What exists

### `packages/shared`
- `applications.ts` gains:
  - `ApplicationInputSchema`: a `z.discriminatedUnion('action', …)` of strict objects. Every variant carries `jobId`. Variants: `start`, `answer {questionId, text ≤2000}`, `skip {questionId}`, `skipAll`, `retry`, `regenerate {notes? ≤500}`, `withdraw {deleteFiles}`. Type `ApplicationInput`.
  - `ApplicationResultSchema` / `ApplicationResult`: `{ jobId, stage, blocked?: BlockedCode, factIds?: string[], unanswered }`.
- `profile.ts`: `FactSchema.answerFor?: { jobId }` (strict). Fact update rules are unchanged: `answerFor` is never in a client update's changed keys, and the v1 snapshot equals the fact.

### `functions/src/applications/`
| File | What |
|---|---|
| `transitions.ts` | Pure stage machine. `planStart(jobId, current, known, 'start' \| 'retry')`, `planAnswer(current, questionIds, answer, known)`, `planSkipAll`, `planRegenerate(current, notes, now)`, `planWithdraw`, `planClearCvs`, `mergeQuestions`, `unansweredCount`, types `Known`, `JobForApplication`. Each returns the whole replacement `Application`, or `null` when the move isn't allowed from where it is. |
| `store.ts` | `ApplicationStore` and `firestoreApplicationStore(db)`: `getApplication`, `getJob`, `hasCvHeader`, `commit(change)`, `deleteCvDocs`. Types `Change`, `Expect`, `CommitResult`. |
| `run.ts` | `runApplication(deps, input)`, `ApplicationDeps`, `ApplicationRefusal` (codes `not_found`, `wrong_stage`, `lost`, `no_fact`, `header_missing`, `no_verdict`). |
| `handler.ts` | `applicationHandler(data, build)`: zod input, dispatch, refusal → `HttpsError`, daily cap → `resource-exhausted`. |
| `llm.ts` | `applicationLlmDeps({transport, usage, dailyCapPence, capPence, fxUsdToGbp, newId?})`: the usage store wrapped in `dailyCapped(…, 'application', cap)` with `newId` defaulting to `application-<uuid>`. |
| `callable.ts` | `application` (`onCall`): `ownerOptions` (App Check enforced and consumed), timeout from `CALLABLE_TIMEOUT_SECONDS.application` (120), `maxInstances: 1` stated in the options, secrets `[ANTHROPIC_API_KEY]`. Exported from `functions/src/index.ts`. |
| `testing.ts` | Test support: `memoryApplicationStore()` (same precondition rules as the real store, a `beforeCommit` hook to simulate a concurrent write), `testJob`, `requirementOf`, `existingFact`. Not imported by any `src` file. |

### Other `functions/src` changes
- `profile/addFact.ts`: the model call and de-duplication moved into `planNoteFacts(deps, purpose, text)` → `{ fresh, knownIds, skippedDuplicates, costPence }`. `addFactHandler` uses it with identical behaviour. `purpose` is `'addFact' | 'answerFact'`.
- `profile/store.ts`: `manualFactWrites(firestore, facts, now, answerFor?)` → `{ ids, writes }` (a fact and its v1 snapshot), usable in a batch or a transaction. `firestoreResetStore.deleteProfile` also deletes `profile/cvHeader`.
- `log.ts`: events `application.answered`, `application.withdrawn` (counts and cost only, no text).

### Rules (`firestore.rules`)
- `applications/{jobId}`: owner reads; owner `update` only (no create, no delete). `validApplicationMirror` allows only `stage`, `stageBefore`, `updatedAt` to change, with `updatedAt == request.time`, and only beside the job's own change in the same batch:
  - **Mark applied:** `stage: 'applied'`, `stageBefore: <the stage it was in>` (one of chosen, needs_input, generating, ready), job `status != 'applied'` before and `== 'applied'` after.
  - **Undo:** `stage: <stageBefore>`, `stageBefore` deleted, job `== 'applied'` before and `!= 'applied'` after.
- `profile/cvHeader`: owner `create`/`update` via `validCvHeader()`; no delete from a client.
- `scripts/rules-writes.test.ts` allowlist gains `/applications/{jobId}: ['update']` (`profile/cvHeader` rides on the existing `/profile/{profileId}` entry).

### Tests added
`run.test.ts` (every callable row of the stage table through the pure `transitions.ts`) and `handler.test.ts` (40 cases together), `index.test.ts` (options, secrets, `maxInstances`, App Check source check, no schedule or event trigger), `tests/rules/applications.rules.test.ts` (23: owner allow, anon deny, other-user deny on both paths), `tests/emulator/applications.test.ts` (6: end to end, `answerFor` fact and v1, concurrent starts, concurrent answers, header Retry, withdraw with files), `tests/emulator/reset.test.ts` (header deleted).

## Exported names 7D.2 and 7D.3 need

### 7D.2 (worker)
- **Moving a job out of `generating`:** `ApplicationStore.commit({ jobId, expect: { stage: 'generating', attempt }, build, now, facts? })`. `build(current, factIds)` returns the whole replacement document (or `null` to lose). The store validates it with `ApplicationSchema`, writes it, and appends an `application_stage` event only when the stage changes. Incrementing `attempt` with the stage unchanged is a plain write with no event.
- **Not there yet (add in 7D.2):**
  - `ApplicationStore` has no `listGenerating(limit)`. The worker's query is `applications where stage == 'generating'`, oldest `stageAt` first, sorted in code.
  - `Change` can't write the `cvs/{cvId}` doc in the same transaction as `ready`. Extend it (an optional `extraWrites`, the way `facts` rides along) rather than a second transaction.
  - `withStage` in `transitions.ts` is private. Export it or add worker builders (`planReady`, `planRetry`, `planBlocked`, `planAttempt`) beside the others so they are pure and table-tested.
- **Reservation IDs:** use `applicationLlmDeps` for the worker's `llmCall` too. It already sets `newId: application-<uuid>`, and `dailyCapped` throws on any other prefix.
- **What a start or retry leaves on the document the worker will read:** `attempt: 0`, no `lastIssues`, no `blocked`, `questions` all handled, `notes` set only by Regenerate (or kept on Retry), `cvIds` and `currentCvId` kept from earlier versions.
- **`cvId` numbering:** `cvIds` is never cleared except by a `withdraw` that deleted files, so `n = cvIds.length + 1` is safe while files are kept. After a delete-files withdraw and a restart the count starts again at 1, and the old files are gone.
- The 7C handoff's worker sequence, `normaliseCvText`, the retry wording and the bundle task are unchanged and still 7D.2's.

### 7D.3 (web)
- `ApplicationInputSchema`, `ApplicationResultSchema`, `CALLABLE_TIMEOUT_SECONDS.application` (client waits `clientTimeoutMs('application')`), from `@hireframe/shared`.
- Error codes the client should word: `not-found`, `failed-precondition` (wrong stage, header missing, job not judged), `aborted` (the application changed: reload), `invalid-argument` (bad input, or "Couldn't turn that into a fact: rephrase it or skip"), `resource-exhausted` (monthly cap, or today's application budget), `unavailable` (the model's output was unusable).
- The result's `unanswered` and `blocked` let the card update without waiting for the snapshot.
- **`profile/cvHeader` write shape:** exactly `name`, `email`, optional `phone`, `location`, `links` (≤3, https, no whitespace), `createdAt`, `updatedAt` (server time), `schemaVersion: 1`. On create `createdAt == request.time`; on update `createdAt` must equal the stored value. A field left empty must be omitted, not `''`. The email pattern in the rules is looser than zod's `email()`, so validate with `CvHeaderSchema` in the client before writing: the server's `hasCvHeader` parses with the schema and reports `cv_header_missing` for a header that fails it.
- **Mirror shape for 7D.4:** see "Rules" above. The batch is the job's `buildJobStatusWrite` update, its event, and the mirror update on `applications/{jobId}`.

## Differences from the plan

1. **Every input variant carries `jobId`.** The plan's union listed only the per-action fields. `regenerate.notes` is optional; `regenerate` without notes clears any earlier notes.
2. **The result type is new** (`ApplicationResult`); the plan named none.
3. **An answer's facts are written in the same transaction as the application update**, through `manualFactWrites`, not through `store.addManualFacts` (a separate batch). Reason: "a lost precondition writes nothing". With the batch, a lost precondition would leave facts on Profile with no answer pointing to them. `addManualFacts` is unchanged and still what `addFact` uses. Facts keep `source: 'manual'` and get `answerFor: { jobId }`, plus a v1 snapshot, as the plan says.
4. **An answer that repeats an active fact links to it** instead of adding a copy (`knownIds`). The "no fact" refusal applies only when the answer gives nothing new and nothing active to link: an empty extraction can't happen (the schema needs one fact), so in practice it is "every fact it produced already exists as an archived fact". The plan didn't cover duplicates.
5. **No-deep-read start creates the application in `chosen`** with `blocked: no_deep_read`, rather than refusing, so Retry works once a deep read exists (the plan's table: "blocked → chosen"). A job with **no verdict at all** is refused (`failed-precondition`) with nothing written, because the application's job snapshot needs a verdict.
6. **The CV header is checked at start** (blocked → chosen even when there are questions) **and again when the last question is handled**. The plan says only that a job can't reach generating without it. **Regenerate without a header is refused** (`failed-precondition`) and leaves the application at `ready`, rather than moving it to chosen.
7. **Start doesn't check the caps.** It makes no model call. The cap blocks (`cap`, `daily_cap`) come from the worker (7D.2) and from `answer`, which returns `resource-exhausted` and writes nothing.
8. **Withdraw is two steps:** the stage moves first (so the worker can write nothing more for it), then the files under `cvs/{cvId}/` and the `cvs/{cvId}` docs go, then `cvIds` and `currentCvId` are cleared. If the clean-up fails the application stays `withdrawn` with its `cvIds`, and withdrawing again **with `deleteFiles`** finishes it (no stage change, no event). Withdrawing a withdrawn application any other way is refused. A restart that lands inside the clean-up window is not guarded.
9. **Start after a withdraw** resets `startedAt` and drops the notes, and keeps `cvIds` and `currentCvId` (versions are kept unless deleted). Retry keeps notes and `startedAt`.
10. **A Retry that stays blocked** rewrites the document (`blocked.at`, `updatedAt`) and writes no event, because the stage didn't change.
11. **Questions on Retry or restart** are recomputed from the job's current requirements; a question that already had an answer keeps it (matched by ID), and an answered question no longer asked is kept while there is room (max 5). The plan said only "answered kept".
12. **`maxInstances: 1` is stated in the callable's options** and checked in `index.test.ts`; the plan's `memory` and `timeoutSeconds` come from `ownerOptions` and the shared table.
13. **Applied mirror rule is stricter than the plan's text:** Mark applied also requires the job to be *not* applied before the batch (`get`) and applied after (`getAfter`), and the mirror leaves `stageAt` alone (it is not among the three mirror keys). Undo requires the job applied before and not after.
14. **`profile/cvHeader` email is checked with a simple pattern** (`x@y.z`, no spaces) in the rules, since rules have no `z.email()`. The three link slots are checked by index (rules can't loop).
15. **No new Firestore query in 7D.1.** Every read is a document `get` (`applications`, `jobs`, `profile/cvHeader`) or the existing facts collection read, so nothing was added to the query specs or `indexes.test.ts`. `applications (stage, stageAt desc)` stays in 7D.3, the worker's query in 7D.2.
16. **`FactSchema.answerFor` is strict** (`{ jobId }` only). New file `llm.ts` and the two log events are additions, not in the plan.
17. **Fakes and seed untouched.** The emulator's `fakeTransport` already answers `answerFact` through its note branch (the first sentence as one achievement fact), so `npm run dev` can exercise the callable. The dev seed's applications, CV header and the `cvWrite` branch are 7D.2.

## Gate (after the last code change)

| Command | Result |
|---|---|
| `npm run format:check` | passed |
| `npm run check` | passed: lint, typecheck, 141 files and 2,069 tests, PII scan (494 files clean), eval replay (85.0%, 34/40, unchanged) |
| `npm run test:rules` | passed: 15 files, 373 tests |
| `npm run build` | passed |
| `npm run check:bundle` | passed: 35 chunks, initial JS 293.3 kB gzip (unchanged from 7C) |
| `node scripts/smoke-functions-bundle.ts` | passed: `application` is in the list, europe-west2, no fixtures |
