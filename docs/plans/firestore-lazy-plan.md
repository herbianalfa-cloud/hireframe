# Plan: perf/firestore-lazy — ROADMAP item E, Firestore out of the initial JS

## Context
Item E comes from `docs/plans/m8a2-plan.md` §2. ADR-061 parked it under "Not taken", and it sits in the ROADMAP Parking lot under the `hf:usable` v0.8.1 bullet. Main's initial JS is 295 kB gzip against check:bundle's 300 kB budget. PR #44 (firebase 13: firestore 4.18 adds about 7.5 kB, re2js about 2 kB) takes it to 306 kB, so #44 is held until E frees at least 10 kB.

Today the Firestore chunk (about 139 kB gzip, 479 kB raw) is a `modulepreload` in `index.html`. It is compiled and evaluated before `main.tsx` runs, so it sits before `hf:boot`. Three entry-graph modules import Firestore values:
- `services/firebase.ts`: `getFirestore`, `connectFirestoreEmulator`.
- `services/access.ts`: `doc`, `getDoc`, and through `timestamps.ts`, `Timestamp`; through `reads.ts`, `onSnapshot`.
- `services/pipeline-todo.ts` (Shell's badge): `collection`, `query`, `limit`; through `query-spec.ts`, `where` and `orderBy`; through `reads.ts`.

All other services are already in lazy chunks.

Keep:
- R7: phone median `hf:usable` ≤ 2,000 ms. The v0.8.1 lab median was 1,102 ms.
- The services pattern.
- App Check (initialised before Firestore, as today).
- Owner-only rules (no rules change).
- The Today prefetch (ADR-050).

Budget decision (agreed): the initial budget drops to **200 kB** gzip, and the Firestore chunk gets its own cap of **165 kB** gzip.

## Approach
### How Today gets its first data
1. `hf:boot` → `main.tsx` calls `getFirebase()`, as now. This first runs the **core**, which is in the entry chunk: the preloaded `init.json`, `initializeApp`, `initializeAppCheck`, then `getAuth`. When the core is ready it marks `hf:firebase` (same meaning as now). Auth's restore request is now in flight.
2. **Once the core is ready**, `getFirebase()` dynamically imports `services/firestore-boot.ts`. That import pulls in the `firestore` vendor chunk. The module then runs `getFirestore(app)` (plus the emulator connect in dev) and marks the new `hf:firestore`.
   - Why after the core and not at `hf:boot`: `init.json` is already preloaded from the HTML, so the core's init is CPU work right after boot. Evaluating Firestore at boot would compete with that work on the main thread and could delay Auth's `accounts:lookup`.
   - After the core, Firestore's compile and evaluation overlap Auth's network wait (about 850 ms in the lab). Firestore can't send anything before Auth's first user anyway (ADR-061).
3. On `/`, `main.tsx` starts `loadDashboardService()` **once the core is ready** (`getFirebaseCore().then(…)`), not at boot. Its chunk depends statically on Firestore, so starting it at boot would evaluate Firestore at boot anyway. It is still in well before the uid arrives, which is what ADR-050 needs.
4. When the uid arrives, two things start in parallel, unchanged:
   - AuthGate's `checkAccess` → `firestore-boot.readAppConfig(db)`. That module has been loaded since step 2, so there is no extra request.
   - `startTodayPrefetch()` → `dashboard.prefetchToday()` → `getFirebase()` → `db` → `onSnapshot`.

   Both go out on the same stream as today. `hf:owner`, `hf:prefetch:data`, `hf:today-mount` and `hf:usable` keep their meaning.
5. The Shell badge's listener (after `hf:usable`) imports `pipeline-todo-listen.ts` dynamically. That is a cached chunk off the critical path, and Firestore is already evaluated by then.

### Files
- `web/src/services/firebase.ts`
  - New `getFirebaseCore(): Promise<{ app, auth }>`, memoised. It marks `hf:firebase`, and a failure resets it.
  - `getFirebase()` keeps its type: `FirebaseServices { app, auth, db }`, where `Firestore` becomes a type-only import. It is `getFirebaseCore().then(core => loadFirestoreBoot().then(b => ({ ...core, db: b.connectDb(core.app) })))` and marks `hf:firestore`. A Firestore failure resets only this promise, not the core, so Retry re-imports it.
  - New `loadFirestoreBoot()`: a memoised `import('./firestore-boot')`.
  - No static import of `firebase/firestore`.
  - `getFunctionsClient()` and `getStorageClient()` build on `getFirebaseCore()` instead of `getFirebase()`. Every caller that needs only the Functions or Storage client then never waits for the Firestore import: `callable.ts`, and the Storage uses in `applications.ts` and `profile.ts`. Their own Firestore reads still use `getFirebase()`.
- `web/src/services/firestore-boot.ts` (new, lazy): what the boot path needs from Firestore.
  - `connectDb(app)`: `getFirestore`, plus `connectFirestoreEmulator` in dev.
  - `readAppConfig(db): Promise<AppConfigRead>`: `getDoc(doc(db, DOCS.appConfig))` through `tally`, with `timestampsToDates` applied here.
- `web/src/services/access.ts`
  - Removes the `firebase/firestore`, `timestamps` and `reads` imports.
  - The default reader becomes `Promise.all([getFirebase(), loadFirestoreBoot()])` → `readAppConfig(db)`.
  - `evaluateAccess` parses `read.data` (already converted).
  - `checkAccess` is unchanged: retry, timeout, `permission-denied` → denied, error is never owner, `hf:owner`.
- `web/src/services/auth.ts`: `getFirebase()` → `getFirebaseCore()` in `onAuthChange`, `signInWithGoogle` and `signOut`. Auth never waits on Firestore.
- `web/src/services/pipeline-todo.ts`: the subscription state stays. `start()` awaits `Promise.all([getFirebase(), import('./pipeline-todo-listen')])`, and the `cancelled` guard covers both.
- `web/src/services/pipeline-todo-listen.ts` (new): the limited `todoApplicationsSpec` query with `watchSnapshot`, moved out unchanged.
- `web/src/main.tsx`: the dashboard prefetch is chained after `getFirebaseCore()`, and the comments are updated. `void getFirebase()` stays.
- `web/src/app/lazy-pages.ts`: comment only (when the dashboard import starts).
- `web/vite.config.ts`: comment only. The `firestore` group stays: it is a stable cached vendor chunk and check:bundle names it.
- `scripts/check-bundle.ts`
  - `MAX_INITIAL_GZIP_BYTES` 300 → **200 kB**.
  - `FIRESTORE_MARKER = 'google.firestore.v1.Firestore'`, the RPC service path, which is only in the SDK. Checked: it appears exactly once, in the firestore chunk.
  - Fail if any initial file contains the marker.
  - Fail unless **exactly one** chunk contains it, so a renamed group or a second Firestore copy can't pass. That chunk must be ≤ **165 kB** gzip.
  - Print its gzip size under the initial list as "Firestore (loaded after the core)".
  - E is built on today's main, which doesn't have #43's version of the script yet. So E adds the `CHECK_BUNDLE_DIST` line exactly as #43 has it. When E rebases after #43, the script keeps #43's pdf.js rules and E's Firestore rules side by side.
- `scripts/check-bundle.test.ts`:
  - **On today's main:** E creates it with only the Firestore cases and a minimal fixture-dist helper.
  - **After #43 merges:** E rebases onto main, and #43 has created the same file, so the two collide. Resolve it by taking #43's file and moving E's Firestore cases into it as a `describe` block that uses #43's fixture helpers. Then drop E's own helper, so the file has one harness.
- Docs:
  - `docs/DECISIONS.md` **ADR-066**. Numbers 060 and 062–065 are taken by #41, #42 and #43.
  - ROADMAP: take item E out of the Parking lot and record it as done (v1.0.x).
  - RUNBOOK step 89: expect `hf:firestore` before `hf:auth`; `hf:firebase` still within about 60 ms of `hf:boot`. Step 89 also records **one cold load**: DevTools **Disable cache** on, one reload of Today, then read `hf:usable` and paste the marks table. It is recorded, not gating, and compared with the previous release's cold load.
  - ARCHITECTURE: the web bundle line, if it lists the initial chunks.
  - CLAUDE.md Commands: the check:bundle line says "initial JS under 200 kB gzip, Firestore only in its own lazy chunk with its own cap".
  - CHANGELOG: an Unreleased patch entry.

### ADR-066 (new)
**Title:** Firestore loads once the Firebase core is up; initial JS budget 200 kB plus a Firestore chunk cap.

- **Takes** ADR-061's parked "Moving Firestore out of the initial JS".
- **Amends ADR-021:** the budget goes from 300 to 200 kB, with a Firestore cap of 165 kB, the marker rule and the exactly-one rule.
- **Amends ADR-050:** the dashboard chunk import starts after the core, not at boot.
- **New mark:** `hf:firestore` (scalars only).
- **Why after the core, not at boot:** main-thread contention with Auth's restore.
- **Accepted:**
  - Total bytes before `hf:usable` don't shrink. The win is ordering, not size.
  - On a cold visit the Firestore download starts about one `init.json` later.
  - A signed-out visit still loads Firestore after the core, as today.
- **Fallback if the marks show `hf:firestore` after `hf:auth`:** move the trigger to boot. That is a one-line change.
- **Cold load:** step 89 records one cold load (empty cache). If the cold `hf:usable` is worse than main's, the fallback is a `<link rel="prefetch" as="script" crossorigin href="/assets/firestore-….js">`. It downloads early at idle priority but evaluates late: the dynamic import after the core still evaluates it, and finds it in the HTTP cache. The fallback has three parts:
  - **Plugin:** the build-only `earlyFirebase` plugin injects the link, using the hashed `firestore` chunk name from `transformIndexHtml`'s bundle context.
  - **check:bundle:** it counts only `<script src>` and `rel="modulepreload"` as initial, so a prefetch is not counted. It also fails if the Firestore chunk is a modulepreload. The Firestore cap still applies.
  - **Rules unchanged:** same origin and no new host, so SECURITY doesn't change.

  The fallback is a follow-up change, not part of this PR unless the cold number calls for it before merge.

## Expected kB saved
| | Initial JS (gzip) | Firestore chunk (gzip, capped, not in initial) |
|---|---|---|
| main today | 295 kB | in the initial JS |
| main + E | ≈ 156 kB (−139 kB) | ≈ 139 kB |
| main + E + #44 | ≈ 157–158 kB (< 200) | ≈ 150 kB (< 165) |

A few hundred bytes of access and pipeline-todo code move to lazy chunks. E frees about 139 kB against the 10 kB #44 needs. Exact before and after numbers come from check:bundle in the PR.

Lab time saved: ADR-061 estimated 80–200 ms, mostly an earlier `hf:boot`, with some of it coming back during the Auth wait.

## Tests
- `firebase.test.ts`, with `firebase/*` and `./firestore-boot` mocked:
  - `getFirebaseCore` never imports `firestore-boot`.
  - `getFirebase` calls `connectDb` with the core's `app`, after the core, with one import for concurrent calls.
  - Hosted mode (`vi.stubEnv('DEV', false)`, a site key, `fetch` stubbed for `init.json`): `initializeAppCheck` is called before `connectDb`.
  - A failed Firestore import rejects `getFirebase`, keeps the core resolved, and the next call re-imports.
  - `hf:firebase` is marked at the core and `hf:firestore` at the db.
  - **The Functions and Storage clients never wait for Firestore:**
    - The setup: `./firestore-boot` is mocked with a factory that awaits a deferred promise that never settles.
    - `getFunctionsClient()` and `getStorageClient()` both still resolve.
    - `connectDb` is never called.
    - `getFirebase()` is still pending.
    - Plus one case through `callable.ts`: a callable invocation reaches the mocked `httpsCallable` while the Firestore import is pending.
- `firestore-boot.test.ts` (new):
  - `readAppConfig` turns console Timestamps (nested and in arrays) into Dates. This test moves from `access.test.ts`.
  - A missing doc gives `{ exists: false }`.
  - `connectDb` connects the emulator in dev.
- `access.test.ts`:
  - Owner, denied, `permission-denied`, malformed (missing timestamp, string date, empty `ownerUid`), the read that keeps failing, and `hf:owner` once, all on converted data.
  - Error is never owner.
- `auth.test.ts`: mocks `getFirebaseCore`.
- `pipeline-todo.test.ts`:
  - The existing cases are unchanged (`vi.mock` also covers the dynamic import).
  - New: unsubscribing before the listener module loads starts no listener.
- `AuthGate.test.tsx`, `App.test.tsx`, `lazy-pages.test.ts`: still pass. Their mocks are at the service level, and `getFirebase`'s shape doesn't change, so the other service mocks stay as they are.
- `scripts/check-bundle.test.ts`, each on a fixture dist:
  - The marker in an initial file fails.
  - The marker in 0 or 2 chunks fails.
  - A Firestore chunk over 165 kB fails.
  - Initial JS over 200 kB fails.
  - A clean dist passes and prints the Firestore line.

## Verification
1. On the branch: `npm run format:check && npm run check` (lint, typecheck, unit tests, PII, eval replay), and `npm run test:rules` (Java 21; rules unchanged).
2. `npm run build && npm run check:bundle` on main first, then on the branch. Record the per-file numbers in the PR. Check also that:
   - `index.html` has no `firestore-` modulepreload;
   - no initial file contains `from"./firestore-`;
   - `node scripts/smoke-functions-bundle.ts` passes (functions are untouched).
3. Prove #44 fits. In a throwaway worktree:
   - `git worktree add ../hf-e44 perf/firestore-lazy`.
   - Merge `origin/chore/deps-firebase-13` there.
   - `. /opt/homebrew/opt/nvm/nvm.sh && nvm use 24`, then check `node -v` is ≥ 24.15.
   - `npm ci && npm run build && npm run check:bundle`. Expect about 157 kB under 200 and a Firestore chunk about 150 kB under 165. Then `git worktree remove ../hf-e44`. Nothing is pushed.
4. `npm run dev`:
   - Sign in. In the Console, check the marks: `hf:boot < hf:firebase < hf:firestore < hf:auth < hf:owner < hf:usable`.
   - Today, Jobs, Pipeline (badge), Lookup, Profile and System load.
   - Sign out, then sign in again.
   - The Console shows no Firebase errors.
   - A deep link to `/jobs` works.
5. After the tag of the E + #44 release (Hosting only; all functions skipped in the deploy log):
   - **Before** deploying, record on the live release (main, including #42 and #43):
     - a Lighthouse Mobile **Performance** run on Today (TBT, JS execution time; recorded, not gating);
     - one **cold load** `hf:usable` with its marks table (Disable cache on).
   - **After** deploying, run both again.
   - The Scan-now proof and the RUNBOOK "Every release" items.
   - RUNBOOK **step 89**: lab median with the marks table, against 1,102 ms. Expect `hf:boot` earlier and `hf:firestore` before `hf:auth`.
   - **The cold load:** compare it with main's. If it is worse, take the prefetch fallback (ADR-066) as a follow-up.
   - Lighthouse **Accessibility ≥ 95** on Lookup, Today and Jobs.
   - **Step 97 phone median ≤ 2,000 ms (the R7 gate).**
   - In DevTools, the Firestore Listen requests carry `X-Firebase-AppCheck`.
   - Stop and report if the phone median is over 2,000 ms, or the lab median is more than 100 ms above 1,102 ms.

## Risks
1. **A static import brings Firestore back into the entry graph** (a service later imported by Shell or AuthGate). check:bundle's marker rule fails CI.
2. **Main-thread contention:** Firestore's evaluation lands during Auth's restore, so `hf:auth` comes later. Mitigated by starting after the core. Watch it with `hf:firestore` versus `hf:auth`; the fallback is a one-line move of the trigger.
3. **Two Firestore copies** give "expected instance" errors at run time. Caught by the exactly-one rule and the dev and live smoke tests.
4. **App Check ordering.** `getFirestore` runs only after `initializeAppCheck` (a test checks it); App Check itself is unchanged.
5. **The chunk fails to load** (offline, or a deploy mid-load). `checkAccess` shows the gate error with Retry, which re-imports. This is the same failure mode as the lazy screens. There is no automatic retry loop.
6. **The owner-check file is touched.** Its logic doesn't change: only where the Timestamp conversion runs, and that is covered by the moved test.
7. **Merge conflicts:**
   - E is built on today's main and rebases onto main after #43 merges. At that rebase:
     - `check-bundle.ts`: keep both rule sets.
     - `scripts/check-bundle.test.ts`: move the Firestore tests into #43's file, as described under Files.
     - `vite.config.ts`: keep both sides' changes.
     - Re-run the full gate and check:bundle after the rebase.
   - Every rebase needs a force-push of the draft. I show the exact `git push --force-with-lease origin perf/firestore-lazy` first and wait for your OK.
   - #44 then rebases onto E. It has no code conflicts, re-runs check:bundle, and must come in at about 157 kB.

   ADR-066 avoids every reserved number.
8. **Cold visits:** the Firestore download starts after the core. It is still inside the Auth wait, and R7 measures repeat visits. Step 89's cold load shows the effect. The fallback is the prefetch link (ADR-066).
9. **One release for E and #44:** the lab and phone numbers can't tell E's effect apart from #44's. check:bundle on E alone (verification step 2) and the #44 dry run (step 3) record each one's bytes. If R7 fails, the release is reverted as a whole.

## Branch, commits, PR
- **Timing:**
  - v0.9.1 and v1.0.0 are tagged from main this week.
  - **Build now** (speed-up policy: build while the gates run).
    - Branch `perf/firestore-lazy` from `origin/main` today: `git fetch origin && git switch -c perf/firestore-lazy origin/main`.
    - Open the **draft PR** as soon as the first commits are pushed, so CI runs.
    - It stays a draft until RUNBOOK **K28** is done.
    - When the v0.9.1 and v1.0.0 tags or other merges move main, E rebases only if a conflict or CI needs it.
- **Merge order after K28:** #42, #43, **E**, #44 (unchanged).
  - After #43 merges, E rebases onto main and moves its Firestore check-bundle tests into #43's `scripts/check-bundle.test.ts`.
  - #44 rebases onto E.
- **One release for E and #44:**
  - Hosting only, with one Scan-now proof, step 89 (with the cold load) and step 97 for both.
  - #44's plan's Addendum item 3 ("ships with #43") is out of date. Fix it on #44's branch when it rebases; that is not part of E's PR.
- Commits:
  1. `perf: load Firestore once the Firebase core is up`
  2. `perf: load the pipeline badge's listener lazily`
  3. `perf: initial JS budget 200 kB and a Firestore chunk cap in check:bundle`
  4. `docs: ADR-066, runbook marks, roadmap item E done`
- PR body:
  - check:bundle before and after, and the #44 dry-run result.
  - The no-self-triggering check: no function is added or changed, so `maxInstances` is untouched. The client has no new loop; the import retry runs only from the Retry button.
  - Release gate: shipped with #44 as one Hosting-only release, so the Scan-now proof, step 89 (repeat median plus one cold load) and step 97.
