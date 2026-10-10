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

---

# Review fixes after 7D.2

Same branch, no new feature. Twelve review findings fixed; 7D.3 not started; no web code, ADR-055, CHANGELOG or end-of-7D docs.

## What changed

| # | Change |
|---|---|
| 1 | `firestore.rules` `validApplicationMirror`: Mark applied is refused from `generating`; Undo is refused when `stageBefore` is `generating`. A client can never write stage `generating`. Two rules tests; the allow-lists in the existing tests no longer include `generating`. |
| 2 | `planNoteFacts` also returns `verifiedKnownIds` (the repeated active facts whose draft evidence is a verbatim quote of the note). `run.ts` `answer` keeps only fresh facts with `evidenceVerified` and only `verifiedKnownIds`; with none left it refuses `no_fact`, writes nothing and doesn't move the stage. The Profile add-fact path is unchanged (it still stores an unverified fact, flagged). The log gains `dropped`. |
| 3a | `worker.ts` removes the four files when `put` fails part-way, when the ready commit throws, and (as before) when the commit is lost. A failing remove is logged as `cv_worker.failed {step: 'cleanup'}` with error codes only. |
| 3b | `ApplicationDeps.listFiles` (`bucketFileLister`). A `withdraw {deleteFiles: true}` also deletes `cvs/{jobId}-v{digits}/` folders that `cvIds` doesn't list. The prefix is built from the stored document's `jobId`; a name counts only when the part after `-v` is digits followed by `/`. |
| 3c | Tests: v1 deletion by folder leaves v10; unrecorded version deleted on withdraw, and other jobs' folders (`-v1-v1`, `-vx`, `0-v1`, a plain file) kept; a put rejects after a successful call; the ready commit throws (files removed), and throws after landing (files kept); the remove fails; a render error that is not a `CvRenderError`. The emulator withdraw test now expects the unrecorded `-v10` folder gone. |
| 4 | `seedWorkerEnv(env)` in `scripts/dev-seed.ts` drops `LIVE` and `ANTHROPIC_API_KEY`; `scripts/dev.ts` runs the seed's `dev-worker.ts` with it. `LIVE=1 npm run dev` neither stops at seeding nor makes a live call. `node scripts/dev-worker.ts` run by hand still honours `LIVE=1`. Unit test on `seedWorkerEnv`. |
| 5 | `scripts/smoke-functions-bundle.ts` imports every `.js` in `functions/deploy/` (chunks included) and fails if one doesn't load; follows `index.js`'s static `import`/`export … from` graph and fails if it reaches `chunks/render-*` or `chunks/pdfjs-*`; fails if `PDFRawStream`, `PDFPageLeaf` or `DocumentAttributeNamespaces` is in `index.js` (and if one of them is no longer in the render chunk, so a stale marker can't pass). Both failures were checked by hand against a doctored `index.js`. |
| 6 | The regex test in `index.test.ts` is kept as a fast pre-build guard and says so; item 5 covers the real bundle. |
| 7 | New `applications/callable.test.ts`: `onCall` is captured, and the options asserted are the final values (`enforceAppCheck`, `consumeAppCheckToken` true, `maxInstances` 1, `timeoutSeconds` 120, secrets `ANTHROPIC_API_KEY`). The captured handler refuses an anonymous caller (no access at all), a non-owner (only `config/app` read) and a replayed App Check token (no access). The old source-text test for App Check in `index.test.ts` is removed. |
| 8 | The three `setTimeout(…, 20)` in `worker.test.ts` are a `killedCall(h)` promise the fake call resolves when entered. |
| 9 | `tests/emulator/worker.test.ts`: a barrier in each run's `listGenerating` makes both list before either counts; asserts one send, one `ready`, one `lost`. |
| 10 | Log tests: ready, API error, storage error, clean-up failure and ready-commit failure with CV text in the error messages; the answer path (answered, dropped and refused) with a marker in the answer text. |
| 11 | In-memory `listGenerating(limit, readLimit)` reads at most `readLimit` first, like the query. Worker test with `readLimit: 3`. |
| 12 | Title now says what it asserts: two calls in total and none on the next run. |

## Decisions worth knowing
- **A ready commit that throws may have landed.** The worker re-reads the application and removes the files only when `cvIds` doesn't list the version; if the re-read fails it leaves them (an orphan is overwritten by the next attempt, a deleted ready CV is not recoverable).
- **A repeated active fact is linked on the answer path only when its quote verifies**, the same rule as a new fact.
- **A withdraw with `deleteFiles` now deletes unrecorded versions of this job**, so an owner who kept files, then asks for deletion, loses any orphan too. A withdraw that keeps files lists nothing.

## For 7D.3 and 7D.4
- The Profile CV header form validates with `CvHeaderSchema` before it writes (the rules' email pattern is looser).
- Mark applied is disabled while the stage is `generating` (the rules refuse it).

## Park in ROADMAP at 7D.4
- `addFact.ts` (`planNoteFacts`): an archived fact can overwrite an active one in the `known` map, so an answer that repeats only archived facts returns `no_fact` even when an active twin exists.
- `run.ts` `withdraw {deleteFiles}` can race a `start`: the clean-up isn't guarded against a restart that lands inside it.
- `firestore.rules` `validCvHeader`: the email regex is looser than `z.email()`.

## Gate (after the last code change)

| Command | Result |
|---|---|
| `npm run format:check` | passed |
| `npm run check` | passed: lint, typecheck, 145 files and 2,157 tests, PII scan (508 files clean), eval replay (85.0%, 34/40, unchanged) |
| `npm run test:rules` | passed: 16 files, 379 tests |
| `npm run build` | passed |
| `npm run check:bundle` | passed: 35 chunks, initial JS 293.3 kB gzip (unchanged) |
| `node scripts/smoke-functions-bundle.ts` | passed: every file in `functions/deploy/` loads, no static path to `render-*`/`pdfjs-*`, no pdf-lib or docx code in `index.js`; `index.js` 964 KiB, 9 files 6,555 KiB |

---

# Session 7D.3: Pipeline screen, Profile CV header, Start application

Same branch. Web code only: no change to `functions/`, `firestore.rules` or `packages/shared`. Not started, on purpose: the Applied mirror, the badge, the summary bar slot, the digest's Pipeline line (all 7D.4), the end-of-7D docs, ADR-055 and the CHANGELOG entry.

## What exists

### Services (`web/src/services/`)
| File | What |
|---|---|
| `applications.ts` | `PIPELINE_STAGES`, `PipelineStage`, `STAGE_PAGE_SIZE` (20), `stageSpec(stage)` (`stage ==` ordered by `stageAt desc`), `watchStage(stage, cb)` and `watchApplication(jobId, cb)` (both `ApplicationSchema`-parsed, invalid documents counted and skipped), `loadAppliedThisWeek(now)`, the callable wrappers `startApplication`, `answerQuestion`, `skipQuestion`, `skipAllQuestions`, `retryApplication`, `regenerateApplication`, `withdrawApplication` (`ApplicationInputSchema` in, `ApplicationResultSchema` out, limited-use App Check token, `clientTimeoutMs('application')`, never retried), `applicationErrorMessage`, `loadCvDoc` (`CvDocSchema`), `downloadCvFile`, `cvFileName`, `downloadErrorMessage`. |
| `fact-writes.ts` | `checkCvHeader(values)` (validates with `CvHeaderSchema`, returns per-field errors keyed `name`/`email`/`phone`/`location`/`link0..2`) and `buildCvHeaderWrite(values, storedCreatedAt, serverNow)`. |
| `profile.ts` | `watchCvHeader` (view `{ header: CvHeader \| null, raw }`; an unreadable stored header comes back with `header: null`) and `saveCvHeader(values, stored)`. |
| `lib/download.ts` | `saveBlob(blob, fileName)`. |

### Screens and components
- **`/pipeline`** (`features/pipeline/PipelinePage.tsx`, lazy; its own 13 kB chunk). A stage-count strip, then one section per stage: Chosen, Needs your input, Generating, Ready to send, Applied. Each section has a skeleton, an error line and an empty line; if every list is empty the page shows "No applications yet" with a link to Jobs.
  - **Needs your input:** the requirement as text, its level and match, an answer box (≤2,000 characters) with **Answer** and **Skip**, **Skip all** (shown when two or more are open), and answered or skipped questions listed read-only.
  - **Generating:** "Usually within 15 minutes", and, after an invalid first draft, the fact-check reasons in words.
  - **Ready to send:** four downloads (CV and cover note, .pdf and .docx), the version number from the second version on, the last notes, **Regenerate with notes** (notes optional, ≤500), **Withdraw**.
  - **Chosen:** the blocked reason in words (`BLOCKED_TEXT`, one line per `BlockedCode`), **Retry**, and **Add CV header** (to `/profile`) for `cv_header_missing`. Retry says "Still blocked: …" if the result is blocked again.
  - **Applied:** read-only card. No Mark applied, no Undo.
  - **Withdraw** is on every card except Applied, with a confirmation; when the application has CV versions it asks "keep files" or "delete files".
- **Nav:** `Pipeline` after Jobs, `inTabBar: true`; the phone tab bar is 5 columns (Today, Jobs, Pipeline, Lookup, More).
- **Stage tokens:** `--stage-chosen/input/generating/ready/applied` in `styles.css` for dark, light and system-light, with `text-stage-*` utilities. Each stage has a label and an icon (Inbox, MessageCircleQuestion, Hourglass, Send, CircleCheck).
- **Profile:** `CvHeaderCard` after `WorkRightsCard`: name, email, phone, location and three links. It validates with `CvHeaderSchema` before it writes and shows each error on its field. A fact with `answerFor` shows "From an application answer" (`sourceLabel`).
- **JobDetail:** **Generate CV** is gone. `StartApplication` shows **Start application** (disabled with a reason: not judged, no deep read, or already applied), then the stage and **Open in Pipeline** once an application exists, and a fresh Start after a withdraw. It is a separate control from Apply.
- **Index:** `applications (stage, stageAt desc)` added to `firestore.indexes.json`.

### Tests added
`applications.test.ts` (callable inputs and results, no retry on `unavailable`/`deadline-exceeded`/`internal`, error wording, file names), `fact-writes.test.ts` (header check and builder), `indexes.test.ts` (each stage list needs the composite and is served by it), `PipelinePage.test.tsx` (30: states, text-only rendering of a hostile requirement, answer/skip/skip-all, every blocked code, downloads with the right `cvId`, kind and format, regenerate, withdraw, no Mark applied), `CvHeaderCard.test.tsx` (7), `JobDetail.test.tsx` (7 for Start application), `labels.test.ts`, the lazy-route test in `App.test.tsx`, and `tests/rules/profile.rules.test.ts` (the web builder against the real rules: create, update keeping `createdAt`, an empty field is gone, a second create is refused).

## What 7D.4 needs
- **Mirror:** `performJobAction` and `buildJobStatusWrite` are untouched. The Applied list reads `applications where stage == 'applied'` and will fill as soon as the mirror writes it.
- **Badge and Things to do:** `useStage` and `watchStage` return up to 20 per stage and are not for a count. The badge wants a new count spec (`stage in [needs_input, ready]`, no `orderBy`; equality-only, so no composite) added to `indexes.test.ts`, started after `whenUsable()`.
- **`loadAppliedThisWeek`** is a second read of the same number Today's bar counts (`summarySpecs(now).appliedThisWeek`). The summary bar's slot may want to share one loader.
- **Applied card copy** says "Undo it from the job". Change it if 7D.4 adds an Undo there.
- **Tab bar:** `TabLink` and `SidebarLink` in `Shell.tsx` take `path`, `label` and `Icon` only; the badge needs a slot and an `aria-label` ("Pipeline, n to do").

## How to see each view with `npm run dev`
The seed (7D.2) already holds a CV header and four applications, so nothing new was added.
- **Pipeline:** `/pipeline`. Needs your input (`dev-job-apply-2`, two questions), Generating (`dev-job-apply-3`, "Usually within 15 minutes"), Ready to send (`dev-job-wildcard`, four real files from the seed-time worker), Applied (`dev-job-applied`). Answer one and skip the other, then run `node scripts/dev-worker.ts`: the card moves to Ready on its own.
- **Downloads:** on the Ready card, each of the four buttons saves a file named `Alex Example - CV - <company>.pdf` (or `Cover note`, or `.docx`).
- **Profile CV header:** `/profile`, below Work rights, filled from the seed. **Reset profile** deletes it, and the card then shows the "can't be written until you save" explanation.
- **Start application:** open any job with a deep read (`/jobs?job=<id>`, for example `dev-job-apply-1`). The job sheet shows **Start application**, or the stage and **Open in Pipeline** for the four seeded ones. A job with no deep read shows it disabled with the reason.
- **Chosen (blocked):** the seed has none. I did not run this path by hand; it is covered by `PipelinePage.test.tsx` for every `BlockedCode`. A seeded blocked row is worth adding with the 7D.4 seed work.

## Differences from the plan
1. **No `stageCountsSpec`.** The stage counts come from the live lists (at most 20 each, shown as "20+" when full), so they move as soon as a card does. A separate aggregation read would sit stale until reloaded.
2. **Applied this week comes from the jobs**, not from `applications`: the mirror leaves `stageAt` alone, so an application's `stageAt` is not the time it was applied (the plan's wording assumed it was). It reuses `summarySpecs(now).appliedThisWeek`, so no new index.
3. **The Applied list is ordered by `stageAt`**, which is the last stage move before applying, not the applied time. The rules allow only `stage`, `stageBefore` and `updatedAt` through the mirror, so an applied time can't be added without a rules change. Flag for 7D.4.
4. **Start application is also disabled for a job not yet judged and for a job already marked applied**, with the reason shown. The plan named only the missing deep read. An application for an applied job would collide with the mirror's "job not applied before" rule.
5. **Withdraw is on every non-Applied card**, not only on Ready, and asks keep or delete files when versions exist. The stage table allows withdraw from any stage but Applied.
6. **Skip all appears only when two or more questions are open** (with one left, Skip does the same).
7. **Download paths come from the `cvs/{cvId}` document** (`CvDocSchema.storagePaths`), not from `STORAGE_PATHS.cvFile`, so the file read follows what the worker recorded.
8. **Answered and skipped questions stay on the card as read-only lines**; the plan listed only the open ones.
9. **Initial JS is 293.6 kB gzip, up 0.3 kB from 293.3**: the Pipeline nav item, its icon and the lazy route entry live in the shell. The screen itself is a separate 13 kB chunk. Nothing runs before `hf:usable` on Today.
10. **A stored CV header that fails `CvHeaderSchema` is shown for repair** (prefilled with its strings) and saved as an update with its own `createdAt`. A document without a `createdAt` can't be repaired from the client (the rules need it unchanged); the save then reports an error.
11. **A rules test for the header builder was added** in `tests/rules/profile.rules.test.ts` (test code only), alongside the existing work-rights one.
12. **Not done in a browser:** the views were checked with component tests, not by hand in `npm run dev`, and Lighthouse a11y on Pipeline was not run (the plan's R7 acceptance needs it at the end of 7D).

## Gate (after the last code change)

| Command | Result |
|---|---|
| `npm run format:check` | passed |
| `npm run check` | passed: lint, typecheck, 149 files and 2,226 tests, PII scan (521 files clean), eval replay (85.0%, 34/40, unchanged) |
| `npm run test:rules` | passed: 16 files, 381 tests |
| `npm run build` | passed |
| `npm run check:bundle` | passed: 39 chunks, initial JS 293.6 kB gzip |
| `node scripts/smoke-functions-bundle.ts` | passed: every function in europe-west2, no fixtures; `index.js` 964 KiB, 9 files 6,555 KiB |

---

# Session 7D.4: Applied mirror, badge, Things to do, digest Pipeline line, end-of-7D docs

Same branch. This is the last 7D session. `firestore.rules` and `apps-script` are **unchanged** (the 7D.1 rules already allow the mirror). Not done, on purpose: merge and tag (`v0.7.3`).

## What exists

### Shared
- `applications.ts`: `appliedApplicationsSpec` (`stage == applied`, `updatedAt desc`).
- `pipeline-todo.ts` (new, no zod): `TODO_STAGES`, `todoApplicationsSpec` (`stage in [needs_input, ready]`, no `orderBy`), `TODO_COUNT_LIMIT` (50). A separate file, because the app shell reads it at start-up and `applications.ts`'s schemas came with it into the initial JS (+4.4 kB gzip before the move).
- `digest.ts`: `digestStageSpec(stage)` and `digestAppliedWeekSpec(weekStart)`.
- `firestore.indexes.json`: `applications (stage, updatedAt desc)`.

### Web
| File | What |
|---|---|
| `services/job-writes.ts` | `buildJobStatusWrite(jobId, raw, to, serverNow, application?)`. With an application, Mark applied adds `application: { stage: 'applied', stageBefore, updatedAt }` and Undo `{ stage: stageBefore, stageBefore: deleteField(), updatedAt }`. Refuses Mark applied from `generating` with `GENERATING_APPLIED_REASON`; no mirror for a withdrawn application or a `stageBefore` the rules would refuse. The job update and event are unchanged. |
| `services/jobs.ts` | `setJobStatus` reads `applications/{jobId}` once, only for a move into or out of applied (a failed read fails the action: nothing is written), and `commitAction` adds the mirror update to the same batch. |
| `services/applications.ts` | `stageSpec('applied')` is `appliedApplicationsSpec`. |
| `services/pipeline-todo.ts` | `watchTodoCount(cb)`: one ref-counted `onSnapshot` with `limit(50)`, shared by every subscriber; `TodoCount` is `loading`, `ready { count, capped }` or `error`. No `listen` from `profile.ts` (it would have pulled that module into the shell). |
| `lib/perf.ts` | `signalUsable()` (Today calls it right after the `hf:usable` measure) and `whenUsable(onToday)`: on Today it waits for the signal; elsewhere it resolves at first idle (`requestIdleCallback`, else 1.5 s); both give up after 10 s so a failed Apply list can't hold it for good. |
| `features/pipeline/` | `useTodoCount(enabled)`, `PipelineBadge` (skeleton while loading, number from 1, "n+" at the limit, `–` on error, nothing at 0) and `pipelineLabel` ("Pipeline, 3 to do"). |
| `app/Shell.tsx` | `useShellTodo`: waits on `whenUsable`, then `useTodoCount`. The sidebar link and the tab bar item carry the badge and the `aria-label`; the tab-bar badge is absolutely positioned over the icon. |
| `features/today/SummaryBar.tsx` | `ThingsToDo` item (after Wildcard), linking to `/pipeline`, with its own skeleton and a dash and "unavailable" on failure. The bar is 8 items. |
| `features/jobs/JobDetail.tsx` | Apply is disabled, with `aria-describedby` text, while the application is `generating`. |
| `features/pipeline/ApplicationCard.tsx` | An Applied card says "marked applied <updatedAt>". |

### Functions
- `digest/store.ts`: `DigestStore.pipeline(now)`: three `limit(100).count()` stage reads, the week's applied-jobs count (same cap), and `getCurrentCriteria` for the weekly target (the seed's target when there are no criteria). It throws on any failure.
- `digest/build.ts`: `readPipeline` catches that, logs `digest.pipeline_failed` (error class and code only) and omits the line; the digest is otherwise unchanged. The read runs for every digest state.
- `digest/render.ts`: `countText` clamps each number to a whole 0 to 999 (and "n+" at the read limit), so only digits and a `+` reach the line; the link is `APP_ORIGIN/pipeline`.
- `config.ts`: `DIGEST.pipelineCountLimit` (100). `log.ts`: `digest.pipeline_failed`.

### Dev seed
One more application: **Chosen, blocked** on `dev-job-near-miss-2` (`DEV_BLOCKED_JOB_ID`), `invalid_output`, `attempt: 2`, `lastIssues: ['unsupported_number', 'too_long']`. The seeded Applied application's `updatedAt` is now its applied time (20 h ago), as the mirror would write it.

### Tests added
- `job-writes.test.ts` (mirror builder, 5), `jobs-mirror.test.ts` (6: one read, one batch, no read for a save, generating refused, a failed read writes nothing), `tests/rules/jobs.rules.test.ts` (7: the real builders against the real rules for each of chosen, needs_input and ready, Undo to another status, withdrawn untouched, generating refused by builder and rules, mirror without a job change denied, non-owner denied).
- `pipeline-todo.test.ts` (4: one shared listener, the limit, error and recovery), `perf.test.ts` (whenUsable, 4), `PipelineBadge.test.tsx` (7), `Shell.test.tsx` (4: no read before the signal, idle elsewhere, 0 and error, five columns), `SummaryBar.test.tsx` (5 for Things to do, bar is 8 items), `TodayPage.test.tsx` (no to-do read before the Apply snapshot), `JobDetail.test.tsx` (3), `PipelinePage.test.tsx` (Applied date), `indexes.test.ts` (Applied, to-do), `applications.test.ts`.
- Digest: `render.test.ts` (clamp, hostile values, link only to the app), `build.test.ts` (one read, a failed read still sends without the line, the log has class and code only, the store has only reads), `queries.test.ts`, `tests/emulator/digest.test.ts` (the line from real documents, a corrupt criteria version still sends, and the "writes only the nonce" test now covers `applications` and `criteria`).

## How to see each new view with `npm run dev`
Sign in as the seeded owner. The seed has: Needs your input `dev-job-apply-2`, Generating `dev-job-apply-3`, Ready `dev-job-wildcard`, Applied `dev-job-applied`, and Chosen (blocked) `dev-job-near-miss-2`.
- **Badge and Things to do:** open `/` (Today). After the Apply list fills, the summary bar's **Things to do** shows 2 (Needs your input + Ready) and the Pipeline item in the sidebar (and the phone tab bar) shows a "2" badge; its accessible name is "Pipeline, 2 to do". Open `/jobs` first instead and the badge appears at the first idle moment. Answer or skip the two questions on `/pipeline` and the count follows live (the application moves on to Generating, so it drops to 1).
- **The failure state ("–") and the skeleton** aren't reachable by hand in the emulator without stopping it; they are covered by `Shell.test.tsx`, `SummaryBar.test.tsx` and `PipelineBadge.test.tsx`.
- **Mark applied mirror:** open `/jobs?job=dev-job-apply-2` and press **Apply**: the job turns Applied, and `/pipeline` moves its card from Needs your input to Applied. Press **Applied** again (Undo): it goes back to Needs your input with its questions. The same on `dev-job-wildcard` returns it to Ready. A job with no application (`dev-job-apply-1`) is unchanged.
- **Mark applied paused:** open `/jobs?job=dev-job-apply-3` (Generating): **Apply** is disabled, with "The CV is still being written…" under the buttons. Run `node scripts/dev-worker.ts` and it is enabled once the card is Ready.
- **Applied list order:** mark two applications applied; the one marked last is at the top, with "marked applied <date>".
- **Chosen (blocked):** `/pipeline` → Chosen shows Operations Analyst · Tidewater Freight, blocked with the invalid-output wording. **Retry** moves it to Generating; `node scripts/dev-worker.ts` moves it to Ready.
- **Digest line:** `node scripts/sign-test-alert.ts digest` prints the digest. Its PIPELINE section reads `1 need your input · 1 generating · 1 ready to send · <n> applied this week of 10`; `n` is 1 if `dev-job-applied`'s 20-hour-old `appliedAt` falls in the current London week (Monday, before 20:00, it is 0).

## Differences from the plan
1. **The mirror's read is in `services/jobs.ts` `setJobStatus`, not `performJobAction`.** The plan put the single `getDoc` in `performJobAction`; components don't call Firebase, so the service owns the read and the batch. `performJobAction`, `withStatus` and the optimistic patch are untouched.
2. **A failed application read fails the action.** The plan didn't say; writing the job alone would leave the two out of step.
3. **Mark applied is refused while `generating`** (button disabled with the reason; the service refuses it with the same reason for the Today list shortcut). The plan's table allowed "any but withdrawn"; the rules' review fix (7D.2) refuse `generating`.
4. **The Applied list is ordered by `updatedAt`** with a second composite, as the 7D.3 handoff flagged. The plan said `stageAt desc` for every list.
5. **`whenUsable(onToday)` takes a flag, and Today calls `signalUsable()`.** The plan's `whenUsable()` took none; the shell decides from the route it started on. A 10 s upper bound was added so a failed Apply list can't hold the badge back.
6. **The badge is a snapshot listener with `limit(50)` ("50+")**, not an aggregation count; the rule "every read has a limit" is why. It and the summary bar's item share one listener (`services/pipeline-todo.ts`).
7. **The navigation item shows a skeleton before the read, and "–" if it fails**, where the plan said only "n, and nothing at 0".
8. **Things to do shows 0** ("Nothing waiting") rather than hiding; the plan's 7A text said "hidden in 7A, wired in 7D".
9. **The digest's Pipeline reads use `limit(100).count()`** and show "100+"; they run for every digest state, not only `ready`; the weekly target comes from the current criteria (the seed's target when there are none, no line if they can't be read); and "applied this week" counts jobs, not applications (7D.3 difference 2).
10. **The tab-bar test asserts the structure** (five columns, the badge absolutely positioned) in jsdom. A real 360 px layout check wasn't done.
11. **`TODO_*` live in their own shared file** (`pipeline-todo.ts`) so the shell doesn't import the application schemas. Initial JS is 294.5 kB gzip, +0.9 kB on 7D.3's 293.6 (the badge, `perf.ts` and the listener).
12. **A fourth ROADMAP parking-lot item** (a job that gains an application between the page's read and the batch is marked applied without the mirror) was added beyond the three the handoff listed.
13. **Not done:** no browser pass of the new views and no Lighthouse a11y run on Pipeline (R7's acceptance needs it at the end of 7D, so it belongs in RUNBOOK I7 on the live site); the Word one-page check is RUNBOOK I7 too.

## Gate (after the last code change)

| Command | Result |
|---|---|
| `npm run format:check` | passed |
| `npm run check` | passed: lint, typecheck, 153 files and 2,276 tests, PII scan (529 files clean), eval replay (85.0%, 34/40, unchanged) |
| `npm run test:rules` | passed: 16 files, 391 tests |
| `npm run build` | passed |
| `npm run check:bundle` | passed: 39 chunks, initial JS 294.5 kB gzip (7D.3: 293.6) |
| `node scripts/smoke-functions-bundle.ts` | passed: every function in europe-west2 (`application` and `generateCvs` included), no fixtures; `index.js` 966 KiB, 9 files 6,561 KiB |
