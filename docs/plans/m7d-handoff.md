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

---

# Session 7D.2: the CV worker

Same branch. 7D.2 is `generateCvs`, the CV prompt, the worker's store reads and moves, the bundle task, the dev script and seed, and tests. Not started, on purpose: any web code (7D.3, 7D.4), the end-of-7D docs (including CLAUDE.md's command list and dev seed line, ARCHITECTURE, SECURITY, RUNBOOK), ADR-055 and the CHANGELOG entry.

## What exists

### `functions/src/applications/`
| File | What |
|---|---|
| `worker.ts` | `runCvWorker(deps)`: one pass, pure of Firebase. `CvWorkerDeps`, `CvWorkerLimits`, `WorkerSummary`, `JobOutcome`, `CvRenderer`. |
| `worker-wiring.ts` | `cvWorkerDeps({ firestore, bucket, transport, config, now? })`: the real store, `llmCall` over `applicationLlmDeps`, `bucketCvFiles`, and `loadRenderer: () => import('../cv/render/index.js')`. Limits come from `APPLICATIONS`. |
| `schedule.ts` | `generateCvs` (`onSchedule`). Exported from `functions/src/index.ts`. |
| `prompt.ts` | `cvSystem(facts, toAlias)`, `cvUser({ job, notes?, issues? })`, `cvFactsBlock`, `CV_PROMPT_VERSION`, `PromptFact`. |
| `files.ts` | `bucketCvFiles(bucket)` → `CvFileStore { put(cvId, bytes), remove(cvId) }`, `cvFilePaths(cvId)`, `CvFileBytes`. |
| `fake-answers.ts` | `fakeCvWrite(system)`: a deterministic `cvWrite` answer that quotes the prompt's facts and cites each. Used by `fakeTransport` and the worker tests. |
| `dev-worker.ts` | `runDevWorker()`, for `scripts/dev-worker.ts`. Not imported by any function. |
| `store.ts` (extended) | `ApplicationStore.listGenerating(limit, readLimit)`, `.getCvHeader()`, `.getJobForCv(jobId)`; `Change.cvDoc?: { cvId, doc }`; type `JobForCv`. |
| `transitions.ts` (extended) | `planAttempt`, `planRetry`, `planBlocked`, `planReady`. |
| `testing.ts` (extended) | memory store gains `getCvHeader`, `listGenerating`, `getJobForCv` (`jobTexts`), `cvDocs`, `header.value`, and `TEST_HEADER`. |

### Elsewhere
- `packages/shared/src/applications.ts`: `generatingApplicationsSpec` (the worker's query; no composite index).
- `functions/src/config.ts`: `APPLICATIONS.workerReadLimit` (50), `CV_WORKER_SCHEDULE` (`*/10 7-23 * * *`, Europe/London).
- `functions/src/llm/call.ts`: `LlmCallInput.maxSends?: 1 | 2` (see difference 1).
- `functions/src/llm/untrusted.ts`: tags `job_analysis` and `owner_notes`.
- `functions/src/log.ts`: events `cv_worker.started`, `.job`, `.done`, `.failed` (counts, codes and IDs only).
- `functions/src/llm/fake-transport.ts`: a `cvWrite` branch.
- `scripts/build-functions.ts` and `scripts/smoke-functions-bundle.ts`: the bundle task.
- `scripts/dev-worker.ts`, `scripts/dev-seed.ts` (`cvHeaderSeed`, `readyApplicationSeed`, `applicationSeeds`, `DEV_*_JOB_ID`), `scripts/dev.ts`.
- `.gitignore` and `.prettierignore` gain `.vitest/`.

## How a pass works
1. `listGenerating(10, 50)`: up to 50 `generating` applications read, sorted by `stageAt` in code, the oldest 10 taken.
2. For each, oldest first: if `now - runStart >= workerStartDeadlineMs` (210 s) the run stops and the rest are untouched.
3. Checks that cost no attempt, each ending in a block with no model call:
   - `attempt >= maxAttempts` → `attempts_exhausted`;
   - header missing, invalid under `CvHeaderSchema`, or holding a character the PDF font can't print → `cv_header_missing`;
   - no readable job or no deep read → `no_deep_read`;
   - `cvIds` already at 50 → `error`;
   - no active, non-preference fact → `error`.
4. **`commit({ expect: { generating, attempt }, build: planAttempt })`**: the attempt is counted here, before the call. A lost precondition skips the job.
5. `llm({ purpose: 'cvWrite', maxSends: 1, schema: CvContentShapeSchema })`.
6. `normaliseCvText` → facts re-read → `validateCv` (codes → retry) → `CvContentSchema` → `fitOnePage` (`too_long` → retry) → note PDF `pages === 1` (else `too_long`) → DOCX files → upload four files → `commit` of `planReady` with the `cvs/{cvId}` doc in the same transaction. A lost commit deletes the four files.
7. Outcomes:

| Outcome | Result |
|---|---|
| valid | `ready`, `cvIds + [cvId]`, `currentCvId`, no `blocked`, no `lastIssues` |
| invalid, `attempt < 2` | stays `generating`, `lastIssues` set; the next run's prompt names the codes |
| invalid, `attempt == 2` | `chosen`, `blocked: invalid_output`, `lastIssues` kept |
| refusal or `max_tokens` | `chosen`, `blocked: invalid_output` at once |
| `invalid_json` / `schema` / `no_text` | as invalid, with no codes |
| monthly cap / daily cap | `chosen`, `blocked: cap` / `daily_cap`, **run stops** |
| API, storage or render failure | stays `generating` (attempt counted); on the last attempt `chosen`, `blocked: error`; **run stops** |

## Every path that resets `attempt`
`attempt` goes back to 0 only inside `withStage` in `transitions.ts`, i.e. on the owner's moves through the `application` callable:
1. `start` (from nothing or `withdrawn`), via `planStart` → `settle` → `withStage`;
2. `retry` from `chosen`, the same function;
3. `answer`, `skip` and `skipAll` that settle (`planAnswer` → `settle`), which can only reach `generating` with 0 anyway (they act on `needs_input`, where `attempt` is 0);
4. `regenerate` from `ready` (`planRegenerate`);
5. `withdraw` (`planWithdraw`).

Nothing the worker does resets it: `planAttempt` adds one; `planRetry`, `planBlocked` and `planReady` keep it (a `ready` or `chosen` document keeps the count it ended with, until the next owner move). The client's Applied mirror can't touch it (the rules allow only `stage`, `stageBefore`, `updatedAt`). Two consequences to keep in mind: every owner Retry or Regenerate buys another two calls, bounded by the 60p daily cap; and a kill leaves the count, so an abandoned run can't lower it.

## Exported names 7D.3 and 7D.4 need

### 7D.3 (web)
- Nothing new from `@hireframe/shared` beyond 7D.1's (`ApplicationSchema`, `ApplicationInputSchema`, `ApplicationResultSchema`) and `CvDocSchema` for reading `cvs/{cvId}`.
- **Blocked reasons the worker writes, for the card wording:**
  - `cv_header_missing`: no header, an invalid one, or one with a character outside the PDF font's range (Latin-1 plus the Windows-1252 extras). "Add or fix your CV header".
  - `no_deep_read`: the job has none.
  - `invalid_output`: the model's output was refused twice (or refused/cut off once). `lastIssues` holds the codes (`uncited`, `unknown_fact`, `wrong_fact_type`, `unsupported_number`, `unsupported_text`, `contact_in_text`, `too_long`, `unsupported_char`).
  - `attempts_exhausted`: a run was killed after counting its attempts.
  - `cap` / `daily_cap`: monthly or today's application budget.
  - `error`: an API/storage failure on the last attempt, no readable profile facts, or 50 versions kept.
- `cvs/{cvId}`: `storagePaths` has the four paths; `content` is the trimmed content as rendered; `trimmed` counts steps; `notes` is the regenerate note it was written under.
- `generating` rows can say "usually within 15 minutes": the worker runs every 10 minutes from 07:00 to 23:50 London.
- `applications (stage, stageAt desc)` is still 7D.3's index; the worker uses none.

### 7D.4
- `ApplicationStore.listGenerating`/`getCvHeader` aren't needed by the digest. The digest's pipeline counts are plain `count()` queries by stage.
- The seed's `DEV_*_JOB_ID` constants name the jobs of each stage for web tests against the emulator.
- Pending end-of-7D docs this session left alone: CLAUDE.md commands (`node scripts/dev-worker.ts`, the seed line, `smoke-functions-bundle` now prints sizes), ARCHITECTURE (the worker row, the `chunks/` directory in the deploy bundle), SECURITY (CV threat row: the `<job_analysis>` and `<owner_notes>` tags), RUNBOOK (I6: check the scheduler invoker; the deploy now has a `chunks/` directory), ADR-055.

## Bundle task: size before and after

| | index.js | all files | Loaded on a cold start |
|---|---|---|---|
| Before 7D.2 (single file, renderer not imported) | 5,223,792 B | 5,223,792 B | 5,223,792 B |
| Worker imports the renderer, single file (the 7C caveat) | 7,154,450 B | 7,154,450 B | 7,154,450 B |
| After 7D.2 (`splitting: true`, dynamic imports in chunks) | 985,406 B | 6,710,018 B (9 files) | 2,692,086 B |

- An inlined `import()` doesn't shrink the file, as 7C warned. `splitting: true` with `outdir` does: `functions/deploy/index.js` plus `chunks/`. The renderer (pdf-lib and docx, `render-*.js`, 1.70 MB) and the PDF reader (pdf.js behind `unpdf`, `pdfjs-*.js`, 2.23 MB) now load only when the worker or `parseCv` first uses them.
- A cold start loads `index.js` and three shared chunks (the Anthropic SDK, zod and shared): 2.69 MB, down from 5.22 MB.
- Cold import of the bundle (`await import('./functions/deploy/index.js')`, 6 runs, a warm disk): 0.25 s after; 0.27–0.28 s single-file, with or without the renderer inlined. The gain is small here because esbuild already wraps inlined modules to run on first use; the parse cost is what goes.
- `scripts/smoke-functions-bundle.ts` now prints `index.js` size and the total, and scans every `.js` file for fixture markers.
- **The deploy directory gains a `chunks/` folder.** `firebase.json` deploys `functions/deploy` whole, and `package.json` there still says `main: index.js`. Nothing else changes for the deploy, but RUNBOOK I6 should say the folder is expected.

## Differences from the plan
1. **`llm.call()` gained `maxSends` (default and ceiling 2), and the worker passes 1.** `llm.call()` re-sends once, inside its own `budgetMs`, when the output is not valid JSON or fails the schema. With that, one worker attempt could make two requests and a job four, against the rule "a job costs at most 2 model calls, kills included". With `maxSends: 1`, every request is bounded by the attempt counter. The cost is that a JSON or schema failure uses a worker attempt (the retry comes at the next run, 10 minutes later, with no issue codes) instead of an immediate resend. `budgetMs` (300 s) now covers one send of at most 150 s, so the deadline arithmetic in `config.test.ts` is conservative, not wrong. The change is additive and tested in `call.test.ts`.
2. **The query reads up to `workerReadLimit` (50) documents, then takes the oldest 10 in code.** The plan said `limit 10, oldest first, sorted in code`; with no `orderBy`, a limit of 10 would pick ten arbitrary documents, not the oldest ten. A `generating` application is owner-started, so 50 is far above any real count.
3. **Checks that need no model run before the attempt is counted.** The plan counted the attempt first. A missing header, no deep read, no usable facts, or exhausted attempts now block without costing one, so an owner's Retry after adding a header gets two real tries.
4. **A header with a character the PDF font can't print is treated as a missing header** (`cv_header_missing`, no call). `BLOCKED_CODES` has no code for it, and the fix is the same page. The 7C handoff described a `CvRenderError` from the header as a block "that names the header"; the check now happens before any call instead of after the render. A `CvRenderError` at render time still becomes `unsupported_char` for the retry.
5. **API, storage and render failures aren't in the plan's stage table.** They leave the job at `generating` (the attempt is counted), and on the last attempt block it with `error`. They also stop the run, because an outage or a bad key would otherwise burn the attempts of every job in it. The plan stopped the run only for caps.
6. **Facts are read twice:** before the call, for the prompt and aliases, and after, for `validateCv`, so a fact archived while the model wrote is `unknown_fact` instead of being published. Preference facts are not shown to the model (nothing may cite them); `validateCv` still sees every fact.
7. **`Change` takes `cvDoc?: { cvId, doc }`, not a generic `extraWrites`.** The store validates the doc with `CvDocSchema` and derives the path from `PATHS.cv(cvId)`, so a document ID can't be anything but the worker's own.
8. **A `ready` or `chosen` document keeps `attempt`.** The plan's builders didn't say; the owner's next move resets it (see above).
9. **A lost ready commit deletes the four files** (best effort). The plan said orphans are overwritten by the next attempt, which is still true if the delete fails.
10. **Files are written with up to 3 attempts and backoff** (`bucketCvFiles`), per the "every external call" rule.
11. **The prompt is `functions/src/applications/prompt.ts`**, as this plan's 7D.2 section says. The 7C handoff pointed at `functions/src/cv/prompt.ts`, which is the profile prompt (`parseCv`, `addFact`) and is unchanged.
12. **Build:** `scripts/build-functions.ts` uses `outdir` and `splitting: true` (the bundle task). The generated `functions/deploy/package.json` is unchanged.
13. **`CvRenderError` has an explicit `code` field** (`functions/src/cv/render/layout.ts`). The root `tsconfig` has `erasableSyntaxOnly`, which rejects a parameter property, and the emulator test now reaches that file from `tests/`.
14. **`.vitest/json/output.json` was committed by mistake with the 7D.1 handoff** (`25ca25b`) and fails `format:check` whenever it exists. It is removed from the index and `.vitest/` is ignored by git and Prettier.
15. **Dev:** `npm run dev` runs the real worker once at seed time (fake model, real renderer, Storage emulator) so the Ready application has a `cvs` doc and four real files; the other three seeded applications are plain documents. `scripts/dev-seed.ts` can't import `applications.ts` under Node's type stripping, so the two question IDs are literals that `dev-tools.test.ts` pins to `questionId()`. `node scripts/dev-worker.ts` bundles `functions/src/applications/dev-worker.ts` with esbuild, as `npm run eval` does, and refuses any project that isn't `demo-*`.
16. **The fake `cvWrite` answer quotes the facts word for word** and ignores the posting. It is valid against `validateCv` by construction, which is why the dev flow and the emulator test need no recorded output.

## Tests added
- `worker.test.ts` (42): ready; one send and `maxSends: 1`; no header or preference fact in the prompt; versioning; owner notes; NFC; retry with codes then ready; blocked after two invalids; `uncited` and `unknown_fact` as codes; an archived fact caught after the call; `too_long` from the fit and from a 2-page note; refusal, `max_tokens`, JSON, schema and no-text; every block that makes no call; non-generating stages untouched; the attempt counted before the call (call order); **killed runs** (two kills → two calls → third run makes none; a kill after a retry); a job moved between the listing and the count; 10 per run, oldest first; the start deadline (a fake clock, 120 s calls, and exactly at 210 s); a monthly or daily cap stops the run; an API failure stops it; the owner withdrawing mid-call (files deleted, nothing stored); **R11** with the real `llmCall` (no request reaches the transport at either cap; an `application-` reservation and `cvWrite` spend when it passes); injection in the posting, a requirement, a talking point and the notes (each tag opens and closes once, the system prompt holds none of it, an obeying output is refused, nothing stored); logs hold no CV, fact, job or header text.
- `prompt.test.ts` (8), `worker-moves.test.ts` (6), `index.test.ts` (schedule, time zone, 540 s, 1 GiB, one instance, no retry, no other trigger, the renderer only by dynamic import), `call.test.ts` (`maxSends`), `indexes.test.ts` (the worker's query needs no composite), `dev-tools.test.ts` (the pipeline seed).
- `tests/emulator/worker.test.ts` (5): start → skip all → generating → ready with the real store and renderer, four Storage objects with PDF and ZIP signatures, a valid `cvs` doc, one event per move, spend under `cvWrite`; two overlapping runs make one request; a missing and an invalid header make none; a withdrawn job is not read.

## Gate (after the last code change)

| Command | Result |
|---|---|
| `npm run format:check` | passed |
| `npm run check` | passed: lint, typecheck, 144 files and 2,137 tests, PII scan (507 files clean), eval replay (85.0%, 34/40, unchanged) |
| `npm run test:rules` | passed: 16 files, 378 tests |
| `npm run build` | passed |
| `npm run check:bundle` | passed: 35 chunks, initial JS 293.3 kB gzip (unchanged) |
| `node scripts/smoke-functions-bundle.ts` | passed: `generateCvs` is in the list, europe-west2, no fixtures; `index.js` 962 KiB, 9 files 6,553 KiB |
