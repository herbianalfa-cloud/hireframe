# M8 8B, session 2 (wipe UI + retention): handoff

Branch `feat/m8b-data-lifecycle`. Plan: `docs/plans/m8b-plan.md` (4 sessions; `done: true` only from a call whose pass finds steps 1 to 9 empty with nothing deleted: checked before building).

## Commits this session
1. `feat(retention): purgeOldData deletes old skipped jobs' descriptions`
2. `feat(jobs): say a purged description was deleted after 60 days`
3. `feat(system): Delete all my data dialog in the Danger zone`
4. `docs: changelog and architecture for retention and the wipe UI (m8b session 2)`
5. `test: satisfy lint in retention and wipe dialog tests`
6. `chore: format tests`
7. This handoff note.

## Built
- **Retention:** `functions/src/retention/{queries,run,store,schedule}.ts`; `purgeOldData` exported from `index.ts`. `RETENTION` and `RETENTION_SCHEDULE` in `config.ts`; `CALLABLE_TIMEOUT_SECONDS.purgeOldData: 300`; `DOCS.retentionCursor` (`locks/retention`); `JobSchema.descriptionPurgedAt`; log events `retention.done` and `retention.failed`; index `jobs (verdict ASC, judgedAt ASC)`.
- **Web:** `services/wipe.ts` (`deleteAllData`, `runWipe`, `previewCount`, `PREVIEW_COUNTS`), `features/system/DeleteAllData.tsx` (Danger zone, last section of System), the job sheet line in `JobDetail.tsx`.
- **Tests:** `retention/{run,queries}.test.ts`, `index.test.ts` and `config.test.ts` cases, `funnel/run.test.ts` (purged job waits), `tests/emulator/retention.test.ts`, `services/wipe.test.ts`, `DeleteAllData.test.tsx`, `SystemPage.test.tsx` (Danger zone, kept-only source card), `indexes.test.ts` (preview specs).

## Decisions taken in the session
- **Eligibility is one pure function** (`decidePurge`), used on the fresh reads inside the transaction. It re-checks verdict `skip`, `judgedAt` before the cutoff, status `new`/`skipped`, no application doc, not already purged, kind not `none`. A job that no longer exists counts as kept.
- **One page of at most 500 per run**, then chunks of 100. `full` is true when the page was full. The cursor is saved after each committed chunk and moves past every job in it. An empty page writes nothing (so `lastRunAt` only moves on a run that did work).
- **Page query** orders by `judgedAt` then `FieldPath.documentId()` explicitly and uses `select('judgedAt')`.
- **The dialog's loop** lives in `runWipe` (service), so it is tested without React. The component passes `deleteAllData` in explicitly. `Continue` resumes from the totals (calls keep counting). The profile ticked-state is captured when the wipe starts, so Continue and the summary use what was sent.
- **Preview** shows seven collection counts plus facts and uploads (shown only under the ticked box). Each is its own `getCountFromServer` and its own skeleton.

## Deviations from the plan
- `purgeOldData` memory is the literal `'512MiB'` in `schedule.ts` (the shared `CALLABLE.memory` is 1 GiB).
- `indexes.test.ts`: two existing negative guards ("rejects the v0.5.0 bug", "rejects a sort direction…") would now be served by the new retention index, so they check the indexes without it (`webIndexes`), with a comment. The retention query has its own negative test in `retention/queries.test.ts`.
- `RETENTION.chunkWorstCaseMs` (30 s) is a new config constant for the 240 s + one chunk ≤ 300 s test.
- A job that goes back to `skipped` with an old `judgedAt` behind the cursor is never purged (cursor only moves forward). Accepted: a status change doesn't touch `judgedAt`, and the cursor only passes jobs that were old when read. Noted for the ADR-057 risks.
- No dev seed change this session.

## Open items for session 3
- The funnel probe hook, `scripts/load-test.ts`, running it and recording the table, the ADR-032 addendum.
- Session 4: ADR-057 and ADR-058, ARCHITECTURE, SECURITY, RUNBOOK Part J and Recovery, ROADMAP, CHANGELOG 0.9.0, CLAUDE.md commands list (nothing new this session), then the PR.

## Commands for you to run
None this session (no live LLM, deploy, tag, gcloud or `gh api`). After the v0.9.0 deploy: C10 for `deleteAllData`; C11, C12, C13 (and C13b if "Failed to set invoker") for `purgeOldData`; C14 for both; C3 must then list exactly three scheduler jobs.

## Gate at the end of the session
All seven steps passed after the last code commit: `npm run check` (2,499 unit tests, eval 85.0%, passed), `npm run format:check`, `npm run test:rules` (18 files, 402 tests incl. `tests/emulator/retention.test.ts`), `npm run build`, `npm run check:bundle` (initial JS 295.0 kB gzip), `node scripts/smoke-functions-bundle.ts` (`purgeOldData` and `deleteAllData` in europe-west2), `npm run audit` (1 allowlisted high).
