# CV quality: Fix A (review fixes that need no LIVE run)

Branch `feat/cv-quality`, from `a0564c5 docs: CV quality review`. No LIVE or model call was made, and no committed recording changed. Fix B items (M3, M5, the M4 note prompt, L1, L2, L7, L8, M6) are not started.

## Findings

| ID | Fixed how | Commit | Test |
|---|---|---|---|
| H1 | `evaluateCvCase` keeps a `RecordingMissingError` from the revision and rethrows it once `composeCv` returns, so the CLI says "recordings stale". `gateCv` fails `revisionSkipped` `error` or `cap` (new `revisionSkipped` field on the case result). | `f38ea74` | cv-eval.test.ts: a replay map with no `cvRevise` rejects with `RecordingMissingError`; two gate rows |
| N3 | The CV eval prints how many recordings went unused. | `f013ab4` | none (a console line) |
| M2 | A failed revision re-reads the facts and re-prepares the draft; if it no longer validates the result is `invalid` with its issues. | `9f4e1de` | compose.test.ts: a fact archived while the call ran gives `invalid` with `unknown_fact`, one fact read |
| M1 | An education line takes only a closed classification list from its achievement (First Class Honours, Upper/Lower Second, 2:1, 2:2, Third, Distinction, Merit, Pass, Commendation, cum laude) and no figure except 2:1 and 2:2. With 2 or more degree facts in the profile (BSc, BA, BEng, MSc, MA, MEng, MBA, PhD, LLB, MPhil, dotted forms too; certificates don't count) the achievement must share a degree token or a year, else `wrong_fact_type`. | `e20a0a9`, `0e8d240` | cv.test.ts: the unrelated award and another degree's classification are refused; (a) BSc + two certificates + honours passes, (b) BSc + MSc with an unrelated achievement is `wrong_fact_type`, (c) "MSc with Distinction" on the MSc line passes |
| M4 | Rubric v2: tailoring 1.0, a new `note` criterion 1.0 (180 to 250 words 0.25, no stock opener 0.5, at most 30% trigram overlap with the bullets 0.25), no new finding code. `CV_RUBRIC_VERSION = 'rubric-v2'`. `note` is optional in the stored `quality.criteria`, so old `cvs` docs still parse. | `3e5708a` | cv-score.test.ts (note rows, a templated note 0.75 lower); cv-rubric-v2.test.ts pins the v2 totals by replay |
| L5 | The baseline stores `rubric` and `promptVersion`. On a mismatch (or a baseline with neither) the baseline rule is skipped and the gate asks for `--update-baseline`. A lower mean under the same rubric and prompt can't be stored. | `f48df6e` | cv-eval.test.ts: a v1 baseline with v2 results; a lower mean can't be stored |
| L3 | `orderEntries` takes `hasDatesOf`; an experience or project entry with no dates at all follows the dated ones in the model's order. Start-only stays Present. | `f0cadc0` | cv.test.ts: [undated, ended, present] sorts to [present, ended, undated] |
| L4 | A spaced dash between two figures becomes a hyphen. | `90bdc87` | cv.test.ts: "10 – 15 people" becomes "10-15 people" |
| L6 | A source test that `purpose: 'cvJudge'` appears only in `functions/src/eval/` and the name only in config.ts besides. | `c202bc1` | cv-judge-source.test.ts |
| N1 | The fit.ts comment says (steps + 1) × 3 sizes, then 9 layouts and one render. | `75ccb17` | none |
| N5 | `better()` ranks two candidates at the cap by their uncapped sums (`CvScore.uncapped`). | `75ccb17` | compose.test.ts: two candidates at 7.5; fails without the fix |
| N6 | `revisionPlan` ignores unused facts that have no alias. | `75ccb17` | compose.test.ts: fails without the fix |
| N2 | Sends are counted before they return, so a send that throws counts against the 3-call limit; `textsMatch` also checks the note PDF text. | `b80cadf` | existing `textsMatch` tests |
| N4 | A test pins the grammar of issue paths against hostile content. | `b80cadf` | cv.test.ts "issue paths hold structure only" |
| N7 | RUNBOOK step 95 item 9: reload open tabs after a deploy that changes the `cvs` schema. | `e7dc9cb` | none |
| (lint) | Lint errors and the emulator test's rubric version found by the gate. | `2a977f0` | tests/emulator/worker.test.ts |

## Differences from the review

1. **M1's degree rule is narrower than the review's.** The review said "2 or more education facts". That made the committed recordings c01 to c07 stale, because the profile's two certificates are education facts and the honours achievement names no degree. I stopped, reported it, and was told to count only facts with a degree token (decision of the owner). The first M1 commit (`e20a0a9`) had the wider rule and the replay was stale at that commit; `0e8d240` fixes it, and the CV eval replay passes from there.
2. The existing honours test fixture was reworded in `e20a0a9` and restored to its original text in `0e8d240`.
3. M1's "end year" half of the shared test is a year in both fact texts. The validator doesn't see fact dates, so a year that only appears in `dates` doesn't count.
4. L5 stores the baseline on a rubric or prompt mismatch only with `--update-baseline`, and a baseline file without the two fields counts as stale.
5. N5 added a field, `uncapped`, to `CvScore`.
6. H1's gate rule also fires for `cap`, as the review said; a normal run never has either.
7. The recorded c04 draft test in cv-recorded.test.ts no longer asserts it passes without a revision: under v2 that old draft scores 7.74 (its note costs it). It now asserts no hard finding and a draft total over 7.
8. The v2 totals match the review's probe exactly.

## Gate (after the last code commit `2a977f0`)

| Command | Exit |
|---|---|
| `npm run format:check` | 0 |
| `npm run check` | 0 |
| `npm run test:rules` | 0 |
| `npm run build` | 0 |
| `npm run check:bundle` | 0 |
| `node scripts/smoke-functions-bundle.ts` | 0 |

The first gate run (after `e7dc9cb`) failed `npm run check` on four lint errors and `npm run test:rules` on one emulator test that expected `rubric-v1`. Both were fixed in `2a977f0` and the whole gate was run again.

## Rubric v2 totals and the new baseline

| Case | v1 total | v2 total |
|---|---|---|
| c01 | 9.75 | 9.00 |
| c02 | 9.75 | 8.75 |
| c03 | 10.00 | 9.25 |
| c04 | 10.00 | 9.00 |
| c05 | 9.13 | 8.38 |
| c06 | 9.75 | 8.75 |
| c07 | 10.00 | 9.25 |
| c08 (thin) | | 6.80 (draft 6.50, revision used) |

Full-profile mean 9.77 to 8.91, 7 of 7 at 8 or more, no draft newly asks for a revision. `evals/cv-baseline.json` was reset from replay: mean 8.91, 8 cases, `rubric-v2`, prompt `cv-2026-10-18c`.

## No-self-triggering check

No function, trigger, schedule, `maxInstances` or `timeoutSeconds` line changed (grep of `git diff a0564c5..HEAD -- functions/src`). The M2 re-read is one extra `deps.facts()` call inside the existing revision catch, with no loop. The revision stays at most one per job.
