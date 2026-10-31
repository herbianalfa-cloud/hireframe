# CV quality: handoff 2b (compose, worker, fake model)

Branch `feat/cv-quality`. Session 2b of 3 (plan: `docs/plans/cv-quality-plan.md`, with the Addendum; earlier: `cv-quality-handoff-1.md`, `cv-quality-handoff-2a.md`). **Do not merge before v1.0.0.** No deploy, tag or live change. Session 3 (CV eval, web line, docs, ADRs) is not started.

## What exists

- `functions/src/applications/compose.ts` (new): the loop of Design §3. Scrub dashes, validate, order entries, fit, lint and score; one revision only when it can help; re-read the facts and re-validate both candidates; ship the best valid one. Every failure of the revision ships the draft and says why in `revisionSkipped`.
- `worker.ts` uses it. It counts the attempt before the write and again, through `compose`, before the revision. `invalid()` and the error path block at `maxWrites`. The ready commit stores `quality`.
- `transitions.ts`: `planRetry` is bounded by `maxWrites`. `planAttempt` stays at `maxAttempts`.
- Limits have one source: `APPLICATION_LIMITS` in shared. `APPLICATIONS.maxAttempts` is removed from `config.ts` (a test pins that no copy exists). `worker-wiring.ts` passes `maxWrites`, `maxAttempts` and `scoreTarget`.
- Fake model: `fakeCvWrite` fills a page; `fakeCvRevise` returns the draft in the request; `fake-transport.ts` answers `cvRevise` with it.
- `toAlias` is passed to `cvUser`, so `(facts: F3, F7)` is live.

## Exported names

- `compose.ts`: `composeCv(deps, input) → ComposeResult`, `validatorFacts`, `ComposeDeps`, `ComposeInput`, `ComposeResult`, `ComposeRenderer`, `Shipped`.
  - `ComposeDeps`: `render` (`fitPage`, `makeDateOf`, `makeEndKeyOf`, `CvRenderError`), `facts()`, `countAttempt()`, `revise(user)`, `beforeDeadline()`.
  - `ComposeInput`: `draft`, `header`, `job`, `notes`, `facts`, `toAlias`, `toId`, `attempt`, `maxAttempts`, `scoreTarget`, `writeCostPence`.
  - `ComposeResult` is `{ kind: 'invalid', issues } | { kind: 'lost' } | { kind: 'composed', shipped, stop?: 'cap' | 'error' }`. `Shipped` is `{ fit, cited, factIds, quality, costPence, facts }`.
- `worker.ts`: `CvWorkerLimits` gains `maxWrites` and `scoreTarget`; `CvRenderer` gains `makeEndKeyOf`.
- `fake-answers.ts`: `fakeCvRevise(user)`.

## How the loop decides

1. The worker counts attempt n, calls `cvWrite`, loads the renderer and reads the facts again.
2. `compose` prepares the draft: NFC, `scrubDashes`, `validateCv`, strict schema, `orderEntries`, `fitPage`, `scoreCv`. An invalid draft returns `invalid` and the worker retries or blocks as before.
3. No revision when `gatePassed`. Otherwise `not_fixable` unless some finding is fixable (all are) or the page is under-full with at least 2 unused bullet-type facts (experience, achievement, metric, project; active; not cited anywhere in the draft). Then `attempts` when `attempt >= maxAttempts`, then `deadline`.
4. `countAttempt()` runs, then `revise()`. A false count returns `lost`, and nothing is called.
5. Both candidates are prepared again against facts read after the call. The best valid one ships: fewest hard findings, then the higher total, and the draft on a tie. A draft that stops validating while the revision still does ships the revision. Neither valid → `invalid`.
6. Failures: a cap or daily cap → `cap` and `stop: 'cap'`; an API or count error → `error` and `stop: 'error'`; a refusal, cut-off, bad JSON or schema miss, or an invalid revision → `output`. The worker ships the draft, then throws `StopRun` for a `stop` (the job is `ready`, the rest of the run is untouched).

## Differences from the plan and the brief

1. **Gap questions: not built, and not parked as new work.** The 7D path already does it: `questionsFromRequirements` (shared) makes the questions from S3 requirements in code, `mergeQuestions` calls it on every start and retry, and answers go through `answerFact` and its 60p/day cap. No new model call, function or trigger. It differs from the Addendum in three ways: up to 5 questions, not 3; must and nice, not must only; it skips `logistics` but not a `hard-blocker` gap. A second builder would duplicate it and change shipped 7D behaviour, so `docs/ROADMAP.md` (parking lot) records how to tighten it if wanted.
2. **`APPLICATIONS.maxAttempts` is removed, not kept in sync.** The worker, `transitions.ts` and the schema read `APPLICATION_LIMITS`.
3. **The error path blocks at `maxWrites`, not `maxAttempts`.** An API error on the second call would otherwise leave a third write possible. The bound stays 3 calls: only a kill during the revision lets a write run at attempt 3.
4. **`planRetry` is bounded by `maxWrites`** (the plan names only `invalid()`). A retry is a write.
5. **The revision's score ranks, but `revised` means "the revision shipped".** A valid revision that loses the ranking leaves `revised: false` and no `revisionSkipped`, with `draftTotal` set. `revisionSkipped` is for failures and skips only.
6. **`costPence` on the doc is write + revision**, plus what a failed revision call cost (`LlmOutputError.costPence`).
7. **`dashesReplaced` is the shipped candidate's count.** Both candidates are scrubbed; the revision's own dashes are counted if it ships.
8. **The note's page check stays in the worker** (`renderFiles`), after the choice. A cover note over one page is `too_long` for the shipped candidate only.
9. **Facts are read twice before the draft is checked** (once at the start of the job for the prompt, once after the write for the check), plus once after a revision. The ready path reads them twice, as before.
10. **The dev seed needed no change.** The Ready CV is written by the real worker with the fake model, so it has `quality` now. A fake CV on the seeded profile is under 8 with something to fix, so it is revised once (the fake returns the draft, which ships). A job at seed time costs a write and a revision. The test for the fake writer is `functions/src/applications/fake-answers.test.ts`, not `dev-tools.test.ts` (it needs the renderer).
11. **Emulator tests changed.** `tests/emulator/worker.test.ts` expects `['cvWrite', 'cvRevise']`, `attempt: 2`, and that of two overlapping runs one makes both calls and the other none.
12. **`validatorFacts` moved from `worker.ts` to `compose.ts`.**
13. **Not done here (Session 3):** the CV eval, `cvJudge`, the Ready-card line (quality and luck), ADRs 062–064, CHANGELOG, ARCHITECTURE, SECURITY, RUNBOOK and PRD edits. `CLAUDE.md` still says the dev seed has a Ready CV with four real files; it now also has a score.

## Tests added

- `compose.test.ts` (34): every branch with a stub fit and a probe for the calls. No revision at 8 or more; `not_fixable` (none unused, one unused); a revision with two unused; a hard finding on a full page; `attempts`; `deadline`; a false count (`lost`); a count that throws; count before send; the request holds `<draft_cv>`, finding codes, the fill, unused aliases and `(facts: …)`; the ranking (higher score, fewer hard findings at a lower score, tie, an invalid revision); facts re-read, both archived (invalid) and only the draft's fact archived (revision ships); a cap, a daily cap, an API error and five output failures (cost included); dashes scrubbed and counted; entries ordered newest first; `too_long`, a render refusal, another failure thrown; 20 findings stored at most.
- `worker.test.ts`: kill during the revision (attempt 2, then a write at 3 that ships without one, then nothing); three kills → 3 calls, then none; a kill and then an invalid write → blocked after 3 calls; no fourth call however the runs end; the call-order spy (`commit, llm, commit, llm, commit:ready`, and the stored attempt at each send); the deadline stops a revision (and one just before it starts); R11 with the real `llmCall` at both caps for `cvRevise` (no request sent, draft shipped, `byPurpose.cvRevise` absent) and the passing case (recorded under `cvRevise`, no reservation left); injection in `<draft_cv>` (tags open and close once, the attack stays inside, not in the system prompt); logs hold no CV text on the revision paths; a fact archived during the revision.
- `fake-answers.test.ts` (4), `worker-moves.test.ts` and `config.test.ts` updated.

## Gate

Run on the last code commit (`test: emulator worker expects the fake CV's one revision`) with the exact command from the brief, from clean logs. The first run, on the commit before it, failed `npm run test:rules` on two emulator tests that still expected one model call (the fake CV is now revised once); the tests were fixed and the whole gate was run again. Logs are in `tmp/` (not committed).

| Command | Exit | Notes |
|---|---|---|
| `npm run format:check` | 0 | |
| `npm run check` | 0 | 192 files, 2934 tests; funnel eval replay passed (85.0% agreement, unchanged) |
| `npm run test:rules` | 0 | 18 files, 407 tests |
| `npm run build` | 0 | |
| `npm run check:bundle` | 0 | initial JS 295.1 kB gzip, 6 files |
| `node scripts/smoke-functions-bundle.ts` | 0 | `index.js` 1014 KiB; 14 functions in europe-west2 |

## No-self-triggering check (CLAUDE.md rule 6)

- No new function, trigger or schedule. `git diff 756c402..HEAD -- functions/src` has no changed line matching `maxInstances`, `timeoutSeconds`, `onSchedule`, `onDocument*`, `onCall`, `onRequest` or `onMessagePublished`. `generateCvs` keeps its literal `maxInstances: 1` and `timeoutSeconds`.
- Nothing is triggered by an event it can cause. The revision is a call inside the same worker run, not a trigger, a re-enqueue or a reschedule. A kill leaves the job at `generating` for the next schedule tick, as before.
- Every loop is bounded. `composeCv` has no loop over external calls: one `countAttempt` and one `revise` at most, and only when `attempt < maxAttempts` (3). A job costs at most 3 model calls per owner move, kills included, and every call is counted by the precondition transaction first (tested with a call-order spy and by kills). The run is still bounded by `workerMaxPerRun` (10) and the start deadline (210 s), which now also stops a revision. The re-validation is two more passes of the single-pass fit; `fitPage` is bounded as in handoff 1.
- `maxRevisions` is 1 and nothing re-runs `composeCv` on its own output.

## For Session 3

- The cost table in the plan: a typical CV is now a write plus, when below target and fixable, a revision. The fake data revises every time, so measure the revision rate in the LIVE eval.
- The eval can call `composeCv` directly with `countAttempt` and `beforeDeadline` stubbed. `fakeCvWrite` and `fakeCvRevise` are the replay fakes for the worker, not the eval.
- Update the CLAUDE.md `npm run dev` line to say the Ready CV carries a quality score.
- Settle the gap-question wording (difference 1) before the ARCHITECTURE edit.
