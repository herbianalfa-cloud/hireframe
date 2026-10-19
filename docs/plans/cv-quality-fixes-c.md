# CV quality Fix C

Fixes for `docs/plans/cv-quality-review-2.md`. No LIVE run and no model call. No committed recording went stale: `npm run eval` replays all 8 cases unchanged (mean 9.66, 7 of 7 at 8 or more).

## Findings

| Finding | Fixed how | Commit | Test |
|---|---|---|---|
| H-new-1, M-new-1 | `cv.ts`: classification by phrase (`CLASSIFICATIONS`, `classesIn`). The achievement lends only the words and figures of the classes it states ("2:1" = "Upper Second Class"); a one-word class needs a degree word in its sentence; the line's classes must be ones the achievement states; an achievement naming a degree token must match the education fact's token whatever the profile size. The two-degree "must share" rule keeps the owner's narrowing | 62305e5 | cv.test.ts "phrase-based classification (Fix C)": 2:1 against 2:2 refused, 2:2 and 2:1 pass, 2:1 = Upper Second, the four probe rows, MSc token against a BSc line. The honours, "MSc with Distinction" and certificate rows pass unchanged |
| M-new-2 | `cv-report.ts`, `cv-cli.ts`: the baseline compares by rubric only; the slack rule holds across a prompt bump even with `--update-baseline`; a lower mean under the same rubric needs `--accept-lower` and prints both means; a rubric change still needs `--update-baseline`. `evals/cv-baseline.json` untouched (9.66, ratified by the owner) | 66de8c5 | cv-eval.test.ts: prompt bump with a 0.3 lower mean fails "under the baseline" while updating; `canStoreBaseline` refuses without and allows with `acceptLower`; rubric rows unchanged |
| L-new-1 | `compose.ts`: the `invalid` result carries `stop`; a failing `deps.facts()` after a cap or outage rethrows the original error. `worker.ts` throws `StopRun` after `invalid()` | 00e70cb | compose.test.ts (stop `cap`; original cap error rethrown); worker.test.ts (no `cvs` doc, no files, blocked `invalid_output`, `stoppedBy` `cap`, next job untouched) |
| L-new-2 | `cv-lint.ts`: X at most 4 words; for "it was / they were" the pivot is not followed by a past participle or an irregular one (rebuilt, built…) | 0afdfc6 | cv-lint.test.ts: both probe sentences negative; every earlier contrast row still flags |
| L-new-5 | `cv-lint.ts`: a bare "I" is skipped only after a numeral noun (Phase, Part, Stage, Level…) or before a capital or digit; `BEFORE_REAL_I` dropped | 0afdfc6 | cv-lint.test.ts: the three probes flag; "Phase I", "Part I", "Key Stage I" do not |
| N-new-1 | `cv-evaluate.ts`: `coverage` divides by `CV_WEIGHTS.tailoring` | 74e8da3 | replay unchanged |
| N-new-2 | `prompt.ts`: strips `facts: F…` in any bracket, full-width brackets, `fact:` and bare | 74e8da3 | prompt.test.ts: five shapes |
| N-new-4 | `cv.ts` `scrubText`: a hyphen only between two figures that are both years or both not, second larger; otherwise a comma | 0afdfc6 | cv.test.ts "keeps a range of years, and does not join a year and a count" |
| N-new-5 | `cv-lint.ts`: "a leading" exclusions add contributor, analyst, member, expert, player, specialist; `own` for Lead is lead, leads, led | 0afdfc6 | cv-lint.test.ts: three flagged rows; a "leadership" fact does not own "Lead" |
| N-new-6 | `cv.test.ts`: the ternary with two equal branches removed | 74e8da3 | same test |
| N-new-7 | `cv-recorded.test.ts` already asserted `draft.hard` is 0 (line 84); I added a severity line, which did not typecheck (stored findings have no severity), and removed it | 74e8da3, f79c065 | existing assertion |
| M-new-3 | ADR-063 and ADR-064 addenda; stale lines in ADR-062/063/064 corrected; CHANGELOG, evals/README, CLAUDE.md eval line | b5447b4 | grep below |
| Parking lot | ROADMAP: L-new-3, L-new-4, N-new-3 | b5447b4 | none |

`grep -n "rubric v1\|6 pt reserve\|9.77" docs evals CHANGELOG.md CLAUDE.md` now returns only history: the ROADMAP calibration item, the ADR-064 "Measured" and "Accepted risks" lines, the ADR addendum's own history note, the CHANGELOG line that says "under rubric v1", and `docs/plans/*` and `evals/recordings.jsonl` (records).

## Differences

1. **"honours" is not a degree word.** The re-review lists it, but then its own fourth probe ("Came first in a class of 40 for statistics, earning honours") would lend "first". The degree words are degree, graduated, classification and a degree token. Recorded in the ADR-063 addendum.
2. **Class synonyms lend each other's words.** An achievement stating a class lends every word of that class's phrases, so "Graduated with a First" allows "First Class Honours" and "2:1" allows "Upper Second Class". It never lends across classes.
3. **Year ranges stay hyphenated (N-new-4).** The review said "neither a 4-digit year"; "2021 - 2023" would become "2021, 2023". Both-years ranges keep the hyphen; a year next to a count does not.
4. **N-new-7:** the assertion existed; see above.
5. The review document itself is committed with this report.
6. The first gate run failed `npm run check` on a typecheck error in my own N-new-7 line; fixed in f79c065 and the whole gate re-run from the start. The table is the second run.

## Gate (last code commit f79c065)

| Command | Exit |
|---|---|
| npm run format:check | 0 |
| npm run check | 0 |
| npm run test:rules | 0 |
| npm run build | 0 |
| npm run check:bundle | 0 |
| node scripts/smoke-functions-bundle.ts | 0 |

No-self-triggering check: no function, trigger, schedule, `maxInstances` or loop was added. L-new-1 adds no call; it only keeps a stop that was dropped.
