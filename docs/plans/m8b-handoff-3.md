# M8 8B, session 3 (load test): handoff

Branch `feat/m8b-data-lifecycle`. Plan: `docs/plans/m8b-plan.md` (4 sessions; `done: true` only from a call whose pass finds steps 1 to 9 empty with nothing deleted: checked before building).

## Commits this session
1. `feat(funnel): optional probe marks for the load test` (+ a test fix commit)
2. `feat(loadtest): data, transport, counting, report and the load-test script`
3. `chore: lint the load-test script`, `fix(loadtest): valid fingerprint on seeded jobs`
4. `feat(loadtest): say whether time or the lease limited S3`
5. `docs: changelog, ADR-032 load-test addendum and commands (m8b session 3)`
6. This handoff note.

## Built
- **Probe hook:** `FunnelProbe` and `ProbeMark` in `funnel/run.ts` (`FunnelDeps.probe?`, `FunnelWiring.probe?`): marks at S1, sweep, S2, S3 start and end and around each hydrator read. Absent in production; a test shows identical results with and without it.
- **`functions/src/loadtest/`:** `data.ts`, `transport.ts`, `fetch.ts`, `counting.ts`, `report.ts`, `args.ts`, `run.ts` with tests for each except `run.ts` (it needs the emulators; it is exercised by the script).
- **`scripts/load-test.ts`:** starts its own emulators (`demo-hireframe-load`, Firestore and Storage), refuses `LIVE=1`, a non-`demo-*` project and busy ports 8080 and 9199, bundles `run.ts` with esbuild.
- **Docs:** ADR-032 addendum (table and answer), CHANGELOG, CLAUDE.md Commands line.

## Result (the number for the PR body)
| | Peak (`--s1-passes 105`) | Stress (`--s1-passes 210`) |
|---|---|---|
| Whole run (limit 540 s) | 318.7 s | 345.1 s |
| S2 calls, last start | 111, 168.4 s | 134 (`run_budget`), 198.7 s |
| S3 calls, last start | 31 (`run_budget`), 309.5 s | 28 (`run_budget`), 338.8 s |
| Lease used | 47.76p of 52p | 48.23p of 52p |
| Largest batch, peak RSS | 400, 162 MiB | 400, 154 MiB |
| Run 2: new, changed | 0, 0 | 0, 0 |
| Wipe | 2,665 docs in 2 calls | same |

All criteria pass. The question "32 S3 + 12 reads inside 450 s": **time fits** (no deadline stop, last S3 start 140 s early); **the count doesn't**: 31 calls, stopped by the 52p lease because S2 made 111 calls (approved n₂ = 99; the 6 extra are the postings that match an alert's title). ADR-045's formula gives 53.3p for that. Lever, owner's choice: `runBudgetPence` 54. Nothing was tuned.

## Decisions taken in the session
- **Seeding:** alert and stale jobs go through the real ingest plan and writer, then funnel patches (`s1PassPatch`, `s2PassPatch`, `needsDescriptionPatch`) put them in their queue. Fingerprints are 64 hex characters (the schema requires it).
- **Run 2's "writes limited"** is measured as: no job created, and no job's `sources` or `keys` changed, no description added. Funnel fields may change (leftover queue jobs are legitimately judged).
- **Counting proxy** works (reads 2,811, writes 3,529 at the peak), so nothing is reported as "not measured".
- **Expected S3** is `min(32, S2 passes + alerts)`.

## Deviations from the plan
- `s3Answer` reports why the answer is NO (time vs lease) instead of a bare yes/no.
- The CLAUDE.md Commands line is added now (plan said session 4), to keep the list current.
- The wipe's table row covers one 2,665-document call plus the empty-check call; the 3,000-document cap is not reached, so the multi-call path is covered by the unit and emulator tests, not by this run.
- Two real runs (peak and stress) were made, not one.

## Open items for session 4
ADR-057 and ADR-058, ARCHITECTURE, SECURITY, RUNBOOK Part J and Recovery, ROADMAP (M8 8B done), CHANGELOG 0.9.0 heading, then the gate and the PR (body: each acceptance criterion with its test, the table above, the deviations from sessions 1 to 4). Note for the PR: the S3 count finding and the 54p lever.

## Commands for you to run
None this session (no live LLM, deploy, tag, gcloud or `gh api`). Optional, locally: `node scripts/load-test.ts` (about 6 minutes, stop `npm run dev` first).

## Gate at the end of the session
All seven passed after the last code and docs commit: `npm run check` (eval passed), `npm run format:check`, `npm run test:rules` (18 files, 402 tests), `npm run build`, `npm run check:bundle` (initial JS 295.0 kB gzip), `node scripts/smoke-functions-bundle.ts` (13 functions in europe-west2, no fixtures, so the load-test code is not in the bundle), `npm run audit` (1 allowlisted high).
