# M8 8B, session 1 (wipe server): handoff

Branch `feat/m8b-data-lifecycle`. Plan: `docs/plans/m8b-plan.md` (4 sessions; `done: true` only from a call whose pass finds steps 1 to 9 empty with nothing deleted: checked before building).

## Commits so far
1. `fix(watchlist): Fresha has no supported board (keep-none)`: `--write` output formatted with Prettier; the diff touches only Fresha's `ats` (`type: 'none'`).
2. `docs(roadmap): park a Teamtailor source`
3. `feat(wipe): wipe lock holder, schemas, Reset profile core, field-level pause read`
4. `feat(applications): refuse every action while the wipe holds the lock`
5. `feat(wipe): deleteAllData callable, bounded pass, store and tests`
6. `docs: changelog and architecture for the wipe server (m8b session 1)`
7. This handoff note.

## Built
- `packages/shared/src/wipe.ts`: `DeleteAllDataInputSchema` (strict), `DeleteAllDataResultSchema`, `WIPE_STEPS`, `WIPE_STEP_LABELS`; `wipe` added to `LOCK_HOLDERS` and `SHORT_LOCK_HOLDERS`; `CALLABLE_TIMEOUT_SECONDS.deleteAllData: 120`.
- `functions/src/wipe/{plan,run,store,callable,testing}.ts`; `index.ts` exports `deleteAllData`.
- `scan/store.ts`: `acquireOrRefreshWipe`, `liveLockHolder`, `pausedHosts()` (field by field); `ScanStore.pausedHosts` is required, the scan carries pauses from it.
- `profile/reset.ts`: `resetProfileCore`, `assertNoCvBeingRead` (handler behaviour and wording unchanged).
- `applications/run.ts`: `ApplicationDeps.lockHolder()`, refusal code `wiping`, first line of `runApplication`.
- `config.ts`: `WIPE`, `SHORT_LOCK.wipeStaleMs`, `LOOKUP.busyRetrySeconds.wipe: 60`. Log events `wipe.refused`, `wipe.pass`.
- Web (small, needed for the kept source docs): `SourceView.health` is `SourceHealth | null`; `watchSources` shows a kept-only doc as "No scan since your data was deleted"; `systemAlerts` skips null.

## Decisions taken in the session
- **Two phases per call:** a delete pass (stops only on the 3,000-document cap, the 20-page cap or 90 s), then a reads-only check pass (`limit(1)` per collection) that builds `remaining`. A step the delete pass never reached counts as remaining. Past 90 s no check read starts either, so every unchecked step is remaining.
- **Profile step** runs in the call whose check pass found steps 1 to 9 empty, even if that call deleted something; its counts are added to `deleted`, so that call is `done: false` and the next one (profile step returns zeros) is `done: true`. **Session 2: the client must sum `profile` over calls**, since the final call's `profile` is all zeros.
- **Lock:** taken at the start (`acquireOrRefreshWipe`) and refreshed again at the end of a call that isn't done; released through the existing `releaseLock('wipe', now)` when done, so `lastFinishedAt` is kept and no cooldown starts. A store error leaves the lock held (stale after 3 min).
- **Sources step:** one `get()` of the collection (small). A doc already holding only `quota`/`pausedHosts`/`updatedAt`/`schemaVersion` is left; otherwise rewritten to those fields, or deleted when it has neither. Rewrites count as changes, so the next call confirms.
- **Jobs page:** `pageSize` 200 documents = 100 jobs with their descriptions (200 ops, inside the 400-op batch).

## Deviations from the plan
- "The refusal reaches the client as `failed-precondition` with the wording" is tested in `applications/handler.test.ts` (the handler that does the mapping), not in `callable.test.ts`: that file's admin mock fails any read but `config/app`, so it can only test the owner refusals.
- The kept-source-card web change (service + `SourceCard` + `systemAlerts`) moved into session 1 because the type change needs it to typecheck. The `SystemPage.test.tsx` case for that card is still session 2.
- `ARCHITECTURE.md` got the `deleteAllData` row and the `wipe` holder now; the rest of the doc changes and the ADRs stay in session 4.
- The worker's lost path needed **no fix**: `removeIfUnrecorded` already removes the files when the application is missing (new emulator test pins it).
- `ats-pauses.ts` is pure helpers and reads nothing from Firestore; the field-level reader the plan asks for is `funnel/store.ts` (already field by field) and the new `scan/store.ts` `pausedHosts()`.

## Open items for session 2
- `web/src/services/wipe.ts`, `DeleteAllData.tsx`, Danger zone on `SystemPage.tsx`, `purgeOldData`, `descriptionPurgedAt`, the new index, the job sheet line.
- Sum `profile` counts across calls in the UI; `remaining` can be empty on a call with `done: false` (it deleted something and the check pass is clean).
- `SystemPage.test.tsx`: add the kept-only source card case.
- The preview's `alertMessages` line has no count (client can't read it).

## Commands for you to run
None this session (no live LLM, deploy, tag, gcloud or `gh api`). After the deploy of v0.9.0 (session 4's PR): C10 for `deleteAllData`.

## Gate at the end of the session
All seven steps passed after the last code commit: `npm run check` (eval 85.0%, passed), `npm run format:check`, `npm run test:rules` (17 files, 399 tests incl. `tests/emulator/wipe.test.ts`), `npm run build`, `npm run check:bundle` (initial JS 295.0 kB gzip), `node scripts/smoke-functions-bundle.ts` (`deleteAllData` in europe-west2), `npm run audit` (1 allowlisted high).
