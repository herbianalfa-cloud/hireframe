# CV quality: handoff 2a (score, prompt v2, config)

Branch `feat/cv-quality`. Session 2a of 3 (plan: `docs/plans/cv-quality-plan.md`, with the Addendum; Session 1: `cv-quality-handoff-1.md`). **Do not merge before v1.0.0.** No deploy, tag or live change. Session 2b (compose, worker, transitions, fake transport, dev seed, gap questions) is not started.

## What exists

**Shared (`packages/shared/src/`)**

- `cv-score.ts` (new): `scoreCv(input) → { rubric, total, criteria, findings, gatePassed }`, pure. Rubric v1: fill 2.0, writing 2.5, real numbers 1.0, tailoring 2.0, bullet craft 1.5, structure and note 1.0. A hard finding caps the total at 7.5. `gatePassed` is `total >= target && no hard finding`.
- `applications.ts`: `APPLICATION_LIMITS` has `maxWrites: 2`, `maxRevisions: 1`, `maxAttempts: 3`. `ApplicationSchema.attempt` is 0..3.
- `cv.ts`: `CvDocSchema.quality?` (optional, so old docs parse), `CvQualitySchema`, `CV_CRITERIA`, `REVISION_SKIPPED`.

**Functions**

- `applications/prompt.ts`: prompt v2 (`CV_PROMPT_VERSION = 'cv-2026-10-18'`), voice section, length target `CV_BULLET_BUDGET`, `requirementLine` with `(facts: F3, F7)`, `cvReviseUser` with `<draft_cv>`. Rules 1 to 7 are unchanged; rule 8 now points at the length target.
- `llm/untrusted.ts`: tag `draft_cv`.
- `config.ts`: `MODELS.cvRevise` (same as `cvWrite`), `PURPOSE_CALLABLE.cvRevise = 'generateCvs'`, `APPLICATIONS.scoreTarget`.
- `cv/render/layout.ts`: greeting is "Dear Hiring Team,".

## Exported names

- `@hireframe/shared`: `scoreCv`, `CvScoreInput`, `CvScore`, `CvLayoutMetrics`, `CV_RUBRIC_VERSION` ('rubric-v1'), `CV_SCORE_TARGET` (8), `CV_HARD_FINDING_CAP` (7.5), `CV_WEIGHTS`, `FILL_FULL_BAND` (0.03), `FILL_ZERO_BAND` (0.25), `CV_CRITERIA`, `CvCriterion`, `REVISION_SKIPPED`, `RevisionSkipped`, `CvQualitySchema`, `CvQuality`.
- `scoreCv` input: `{ content, facts, aliases, requirements, company, layout: { fill, bulletLines, headingWraps }, target? }`. `layout` is `fitPage`'s `fill` and `lines` (`lines.bullets` is `bulletLines`). `scoreCv` adds the `heading_wraps` findings itself, with path `headings`.
- `prompt.ts`: `CV_BULLET_BUDGET` (`{ bullets: { min: 12, max: 15 }, chars: 2400 }`), `bulletBudget(spec)`, `BulletBudget`, `cvReviseUser`, `CvReviseInput` (`{ ...CvUserInput, draft, findings, fill, unusedAliases }`). `CvUserInput` gains optional `toAlias` (fact ID → alias).
- `config.ts`: `LlmPurpose` has `'cvRevise'`.

## Differences from the plan and the brief

1. **`APPLICATIONS.maxAttempts` stays 2 in config.** Raising `APPLICATION_LIMITS.maxAttempts` to 3 would let the unchanged worker make three write calls, because the worker and `worker-wiring` read `APPLICATIONS.maxAttempts`. So config sets it to `APPLICATION_LIMITS.maxWrites` (a comment says why). Session 2b moves the worker to `APPLICATION_LIMITS.maxAttempts` and uses `maxWrites` in `invalid()`.
2. **`transitions.ts` is untouched, but its bound is now 3.** `planAttempt` and `planRetry` read `APPLICATION_LIMITS.maxAttempts` directly. The worker still stops at 2 first. `worker-moves.test.ts` was edited (test only) to expect the new bound.
3. **`CvDocSchema` is in `cv.ts`, not `applications.ts`.** `quality?` went where the schema is. `cv.ts` now imports `FINDING_CODES` from `cv-findings.ts`.
4. **The greeting change is in `layout.ts` (`noteBlocks`) and `render.test.ts`,** not `prompt.ts`, because that is where the greeting is written. This settles handoff 1, difference 10.
5. **`CV_BULLET_BUDGET` is derived by a formula, and its numbers differ from the plan's "about 1,700 characters".** `bulletBudget(spec)` takes the page height less a typical CV's fixed parts (5 sections, 5 entry headings, 3 summary lines, 2 education lines, 2 skill lines), times 0.95, over the cost of a 1.8-line bullet. Result: 12 to 15 bullets, 2,400 characters. The test builds a CV at both ends of the bullet range with the target characters and `fitPage` gives fill 0.99 at body size 10 with no trimming (the test needs at least 0.90). The 1,700 in the plan comes out low once the layout is measured.
6. **Tailoring counts only coverable requirements:** not logistics, and with at least one matched active fact. Requirements the profile cannot meet don't lower the score.
7. **Real numbers reads the fact's text, not its evidence.** Evidence usually carries a year, which is not a figure a bullet should repeat.
8. **`heading_wraps` is charged once,** in the fill criterion (−0.25 each), and not again in writing rules.
9. **Bullet craft's "verb-first" is a word-list check:** the first word is not a stop word, a gerund or a noun ending. It can't tell a present-tense verb from a noun without a dictionary. A summary counts as 3 lines at 270 characters or fewer, because the layout does not report summary lines.
10. **`requirementLine`'s `(facts: …)` needs the caller to pass `toAlias`.** It is optional, and the unchanged worker doesn't pass it, so the mapping is live only once 2b wires it.
11. **`cvJudge` is not added** (Session 3), as briefed.
12. **Not done in 2a:** compose, worker, transitions, the fake transport and the dev seed, the gap questions (the Addendum's 7D read), the web line, ADRs and docs.

## Gate

Run on the last code commit (`4530079 fix: lint in the prompt test`). The first run, on `730f517`, failed at `npm run check` on one lint error in `prompt.test.ts` (`prefer-includes`). It was fixed in `4530079` and the whole gate was run again from a clean log. Logs are in `tmp/` (not committed).

| Command | Exit | Notes |
|---|---|---|
| `npm run format:check` | 0 | |
| `npm run check` | 0 | 190 files, 2873 tests; funnel eval replay passed |
| `npm run test:rules` | 0 | 18 files, 407 tests |
| `npm run build` | 0 | |
| `npm run check:bundle` | 0 | initial JS 295.1 kB gzip, 6 files |
| `node scripts/smoke-functions-bundle.ts` | 0 | `index.js` 1005 KiB; 14 functions in europe-west2 |

## No-self-triggering check (CLAUDE.md rule 6)

- No new function, trigger or schedule. No change to any `maxInstances`, `timeoutSeconds`, `onSchedule`, `onDocument*`, `onCall` or `onRequest` line. `generateCvs` is unchanged. The worker, `transitions.ts` and `worker-wiring.ts` have no source change.
- Nothing is triggered by an event it can cause, and nothing reschedules or re-enqueues itself. `scoreCv`, `bulletBudget` and the prompt builders are pure.
- Loops are bounded: single passes over the content, the facts and the requirements. No external call is added, and no model call is made (`cvRevise` is configured but nothing calls it yet).
- Model calls per job are unchanged: the worker still stops at 2 (difference 1).

## For Session 2b

- Order: `scrubDashes`, `validateCv`, `orderEntries`, `fitPage`, `lintCv` and `scoreCv` (input from `fit.fill` and `fit.lines`), then revise if `!gatePassed` and a finding is fixable.
- Move the worker to `APPLICATION_LIMITS.maxAttempts` and make `invalid()` block at `maxWrites`. Change the `APPLICATIONS.maxAttempts` line and its `config.test.ts` row together.
- Pass `toAlias` to `cvUser` and `cvReviseUser`.
- Underfill is fixable only with 2 or more unused bullet-type facts.
- Store `quality` with `dashesReplaced`, `draftTotal` and `revisionSkipped`; findings are capped at 20 on the doc.
