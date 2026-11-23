# CV quality, Session 3b: handoff (docs only)

Branch `feat/cv-quality`, PR #42 (draft, **do not merge before v1.0.0**). Follows `cv-quality-handoff-3a-fix.md`. This session changes documentation only: no code, no function, trigger or schedule, no deploy and no tag. The three LIVE CV eval runs were all in 3a and its fix; none was run here.

## ADR numbers used

The highest ADR on this branch was ADR-061, so the three new ones are 062 to 064. ADR-060 is expected to arrive with PR #41, so each ADR says its number is **re-checked after the PR #41 rebase**.

| ADR | Title | Notes |
|---|---|---|
| ADR-062 | CV layout v2 | Measured numbers: fill 93% to 99% at body size 11 for full profiles, 62% for the thin one; the size ladder is 11, 10.5, 10 |
| ADR-063 | CV writing rules and the quality score | **Amends ADR-053's 2 calls to 3.** Measured: write about 2.5p to 3.1p, revision about 3.0p, mean 3.13p per CV; reserved worst case per owner move 26.8p; 2 worst-case moves a day (was 3) |
| ADR-064 | CV eval | Three LIVE runs 46.7p, 30.4p, 27.9p (the next one costs about 28p, not the plan's about 60p); baseline 9.77; the thin-case gate changed to "a valid one-page CV within 3 calls" |

Accepted ADRs were not edited. An "Amended by" line was added at the end of ADR-053 (by ADR-063) and of ADR-054 (by ADR-062 and ADR-063).

## Files changed (docs only)

| File | Change |
|---|---|
| `docs/DECISIONS.md` | ADR-062, ADR-063, ADR-064; "Amended by" lines on ADR-053 and ADR-054 |
| `docs/PRD.md` | R10 AC: fills the page, writing rules, score shown, at most 3 calls |
| `docs/ARCHITECTURE.md` | CV output row, `applications` doc (`attempt` 0..3, `lastIssueAt`), `cvs` doc `quality`, `generateCvs` at most 3 calls, the pipeline note |
| `docs/SECURITY.md` | CV threat row: `<draft_cv>`, re-validation after a revision, removal-only clamps |
| `docs/FUNNEL.md` | S4 cost row (measured) and output |
| `docs/RUNBOOK.md` | Step 95.4 (I7): open one DOCX in Word and one in Google Docs; one page, black only, same order |
| `evals/README.md` | A CV eval section: cases, commands, gates, judge, stale recordings |
| `CLAUDE.md` | `npm run eval` line: `--suite`, `LIVE=1 ... --suite cv`, `--update-baseline`; the dev seed line mentions the quality score |
| `docs/ROADMAP.md` | CV quality marked built (merge after v1.0.0); four parking-lot items: cover note quality (judge about 5.9), code rubric against judge calibration, thin-profile filler bullets, the c01 4.7p write |
| `CHANGELOG.md` | `[Unreleased]` entry (Added, Changed, Not yet done) |
| `docs/plans/cv-quality-plan.md` | One line at the end of the Addendum: the thin-case gate changed (handoff 3a-fix) |
| `docs/plans/cv-quality-handoff-3b.md` | This file |

## Differences from the brief

1. The ADRs record **measured** numbers from the handoffs. Where a number was an estimate in the plan, the ADR says so and gives the measurement. The worst case per owner move stays the **reserved** 26.8p (reservations come from config); the measured worst case is 9.0p for one three-call job (run 1).
2. The monthly figures (about £1.35 at the measured mean, about £2.60 if every CV were revised) are my arithmetic on 43 CVs a month at run 3's 3.13p and at 3.1p + 3.0p, not a measurement.
3. The ADR-054 addendum also names the 3a-fix validator changes (an education line's `achievementRef`, an empty project organisation, the clamps), because they change what ADR-054 describes.
4. The CHANGELOG entry is a new `[Unreleased]` heading above `[0.9.1]`, since this work merges after v1.0.0 and has no version yet.
5. **The Word and Google Docs check (RUNBOOK I7) is documented, not done.** The ADRs, the CHANGELOG and the PR body say so.
6. The plan's §4 thin-case line is not edited (the plan is a record); the Addendum line points at the change.

## Gate (after the last commit before this handoff)

Run with the exact command from the brief, from clean logs (`tmp/gate.log`, `tmp/codes.txt`, not committed). Every step passed on the first run.

| Command | Exit | Notes |
|---|---|---|
| `npm run format:check` | 0 | |
| `npm run check` | 0 | 196 files, 3,059 tests; funnel eval and CV eval replay passed |
| `npm run test:rules` | 0 | 18 files, 407 tests |
| `npm run build` | 0 | |
| `npm run check:bundle` | 0 | initial JS 295.1 kB gzip, 6 files |
| `node scripts/smoke-functions-bundle.ts` | 0 | `index.js` 1019 KiB |

This handoff is a docs-only commit after the gate run.

## No-self-triggering check (CLAUDE.md rule 6)

No code changed in this session: `git diff 6a4dcfe..HEAD --stat` lists Markdown files only (plus `CLAUDE.md` and `CHANGELOG.md`). No function, trigger, schedule, `maxInstances` or `timeoutSeconds` line is touched, so nothing can be triggered by its own event, reschedule itself or loop over external calls.

## Before the merge (after v1.0.0)

1. The Opus review of the whole branch and the fix rounds (plan, "Review").
2. RUNBOOK I7: one DOCX in Word and one in Google Docs.
3. `git fetch origin && git rebase origin/main` after PR #41 merges; re-check the ADR numbers (062 to 064) and resolve the docs conflicts; run the full gate. The force-push needs the owner's OK, with the exact commands shown first.
