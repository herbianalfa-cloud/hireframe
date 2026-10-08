# hf:usable over budget on v0.6.2: diagnosis and plan

## Context
RUNBOOK step 89 on the live site (v0.6.2) gives a median `hf:usable` of 2,891 ms (3394.79, 2777.10, 2513.60, 2891.1, 2904.30). The limit is 2,000 ms (ADR-038). v0.5.1 measured 1,920.7 ms. Initial JS has hardly changed (293.1 kB gzip). The tiles show To apply 35 and To review 162, and Apply shows "10+". Everything below comes from the code, the v0.5.1..main diff and the local `web/dist` build of b9c8bf3. Nothing was run against production.

## 1. Steps from navigation start to `hf:usable` (repeat visit)
`hf:usable` = `performance.measure` from 0 to the effect after the first render in which **all 4 counts have settled and the Apply list's first snapshot has arrived** (`web/src/features/today/TodayPage.tsx:247`). The steps run in four serial hops:

| # | Step | Code | Network / reads |
|---|---|---|---|
| A1 | `index.html` (`no-cache`, so it is revalidated) | firebase.json | 1 round trip |
| A2 | Entry JS + 4 modulepreloads (react, zod, firestore 139 kB gz, firebase) | from the immutable cache. Parse and eval at 4× CPU | none |
| B1 | `getFirebase()`: fetch `/__/firebase/init.json` (5 s timeout, retry), `initializeApp`, `initializeAppCheck` (loads the reCAPTCHA Enterprise script) | `web/src/services/firebase.ts:126` | 1 fetch + the reCAPTCHA script |
| B2 | Auth restore: `onAuthStateChanged` from IndexedDB. A securetoken refresh only if the ID token is over 1 h old | `services/auth.ts:24` | 0–1 round trip |
| B3 | App Check token (enforced on Firestore): from IndexedDB if still valid, otherwise a reCAPTCHA run + exchange before the **first** Firestore request | SDK | 0–2 round trips |
| C1 | **Owner check**: `getDoc(config/app)`. This is the first Firestore request, so it also opens the Watch stream (WebChannel). Rules: `isOwner()` = exists+get on `config/app` | `services/access.ts:33`, `app/AuthGate.tsx:20` | 1 doc |
| D1 | Shell renders. `lazy(TodayPage)` imports its graph (TodayPage, hooks, labels, JobDetail, SortSelect, SpendMeter, badge, jobs, dialog, textarea, ...: about 46 kB gz from the cache) | `app/App.tsx:13` | none (cache) |
| D2 | **In parallel on mount:** | | |
| | • 4 × `getCountFromServer`, **no limit**: toApply (`verdict==apply`, `status in [new,saved]`, 35); toReview (`verdict in [near_miss,wildcard]`, `status in [...]`, 4 index scans, 162); judgedToday (`verdict in 3`, `judgedAt>=day`); appliedThisWeek. Each has a 15 s timeout and retries (300/600 ms backoff) | `services/dashboard.ts:216` | 4 aggregations, **gate** |
| | • 3 × `onSnapshot` lists, `limit(10)`: apply (**gate**), near_miss and wildcard (not a gate, but they share the Watch stream). 30 full job docs today | `dashboard.ts:154` | 30 docs |
| | • criteria pointer → version listener (in series), not a gate | `services/criteria.ts:49` | 2 docs |
| | • SpendMeter: `getDoc(config/app)` **again** → usage listener (in series), not a gate | `dashboard.ts:280` | 2 docs |
| D3 | Each snapshot runs `parseJobs` → `readJob` (Zod `JobSchema`) at 4× CPU. Render, then the effect, then `performance.measure` | `services/job-read.ts` | none |
| — | After the mark: Added by you (`limit 5`) | `AddedByYou.tsx` | 5 docs |

So the critical path is **B (init + auth + App Check) → C (owner check, which opens the stream) → D1 (Today chunk) → D2 (the slower of the 4 counts and the Apply snapshot) → D3**. The Today reads can't start until the owner check has finished.

## 2. v0.5.1..main changes on these paths that can add time
- **No change to boot, auth, App Check, the owner check or the Today queries.** `firebase.ts`, `auth.ts`, `access.ts`, `AuthGate.tsx`, `session.ts`, `Shell.tsx`, `profile.ts:listen`, `criteria`, `SpendMeter` and `firebase@12.19.0` are all unchanged. The list, count and spend queries are unchanged apart from moving the `QuerySpec` type to shared. Firestore **read** rules are unchanged (only write rules changed). Indexes were only added.
- **Today's lazy graph grew** (D1, in series after C). TodayPage now imports `sort.ts`, `SortSelect`/`FilterSelect`, `sortPreference` (localStorage), `AddedByYou`. Through JobList it also imports `actions.ts`, `job-optimistic`, `Badge`, `pendingStateText`. JobDetail grew by 232 lines and is a static import. It comes from the cache on a repeat visit, so the cost is parse and eval at 4× CPU, probably tens of ms. `check:bundle` doesn't count it ("initial JS" only).
- **Per-snapshot work grew a little** (D3). `readJob` uses `serverTimestamps: 'estimate'`. `JobSchema` gained a `.refine` per source ref, more enums and `addedAt`/`describingAt`. This runs for 30 docs.
- **Render grew a little** (D3). A sort select per list plus the gap filter, Apply defaults to the Best overall sort, a `Badge` per row, and a `useLayoutEffect` in JobList.
- **Not code but data** (D2): M6 added alert email jobs and Lookup, so many more judged jobs. All three lists are now full (30 docs on one Watch stream, each with `deep`/`gaps`/`talkingPoints`/`keys` up to 60/`sources`), and the aggregation counts scan more index entries.
- **Headroom:** v0.5.1 left only **79 ms** (1,920.7 ms). None of the changes above adds a serial step. Together they plausibly add a few hundred ms, and the rest is the spread of a network-bound path (2.5–3.4 s across five runs, a 900 ms range). I can't tell from code alone which hop grew. The marks in §4 will show it.

## 3. Reads that grow with the number of jobs, and reads with no limit
- **The 4 tile counts have no limit.** Each count's server work and cost (1 read per 1,000 index entries) grows with matching jobs. toReview is a 2×2 `in` disjunction (4 index scans). At 35 and 162 the server time is small, but it has no bound.
- **The 3 Today lists are capped** (`limit(10)`). Their size no longer grows with job count, but they are now always full (30 docs), and doc size grew with the funnel fields.
- **Single-doc reads** (`config/app` ×2, criteria pointer and version, usage) don't grow.
- Off the critical path: Jobs' `loadJobsWindow` has `limit(300)`. Agreement has `limit(500)` (not on Today).

## 4. Plan

### Step 1: per-step marks (land first, measure, then go to step 2)
- New `web/src/lib/perf.ts`: `markOnce(name, detail?)` (each name once per page load, `performance.mark` in try/catch, no-op without `performance`) and `hfMarks()`, which returns `[name, ms]` for every `hf:*` mark sorted by time (for the console and tests).
- Marks (in time order):
  - `hf:boot`: top of `main.tsx` (A done: JS loaded and evaluated)
  - `hf:firebase`: `initHosted`/`initEmulators` resolved (B1)
  - `hf:appcheck`: first `onTokenChanged(appCheck)` callback, hosted only (B3)
  - `hf:auth`: first `onAuthStateChanged` callback (B2)
  - `hf:owner`: `checkAccess` resolved (C1)
  - `hf:today-mount`: TodayPage's first effect (D1)
  - `hf:count:<key>`: each count settled, detail `{ok}`. `hf:counts`: all 4 settled (D2)
  - `hf:list:<list>`: first snapshot of each list, detail `{docs, fromCache, bytes}`. `bytes` ≈ `JSON.stringify(raw).length` summed, computed only for that first snapshot (D2)
  - `hf:usable`: unchanged (the existing `performance.measure`)
- Services call `markOnce` from `lib/perf.ts`. This is a pure, side-effect-light helper (no Firebase), and the rule that components don't call Firebase still holds.
- RUNBOOK step 89: after the 3 reloads, also run `console.table(performance.getEntriesByType('mark').filter(m => m.name.startsWith('hf:')).map(m => ({ name: m.name, ms: Math.round(m.startTime), ...m.detail })))` and paste it. Keep `hf:usable` as the pass/fail.
- Tests: `perf.test.ts` (once only, ordering, throws swallowed). TodayPage test: marks appear in order `today-mount` < `counts`/`list:apply` < `usable`.
- Release as v0.6.3 (CI deploy on tag) and run step 89 with the table.
- **Decision gate:** proceed to step 2 if `owner − auth` plus `today-mount − owner` is a large share (expected). If `hf:appcheck` or `hf:auth` dominates, or one count stands out, stop and revisit before coding.

### Step 2: smallest fix. Start Today's critical reads during the owner check (ADR-038 lever 1)
This removes hops C1 and D1 from the critical path. The 4 counts, the Apply listener and the Today chunk start as soon as auth reports signed in, in parallel with `getDoc(config/app)`.
- `web/src/services/dashboard.ts`: `prefetchToday(now)`
  - starts `loadTodayCounts(now)` and keeps the promise in a module slot. `takePrefetchedCounts()` hands it to the first `useTodayKpis` load only (refreshKey 0, within 30 s). Later refreshes read fresh, so there is no second set of count reads.
  - opens an `onSnapshot` on the same Apply query. The Firestore SDK shares one target per identical query, so TodayPage's own listener gets the first snapshot as soon as it is current. The prefetch listener unsubscribes after `hf:usable`, or after 30 s, or on sign-out.
  - Errors are swallowed and logged at most once (`dashboard.prefetch_failed`, code only). A non-owner gets `permission-denied` from the rules and nothing renders: the rules stay the guard (ADR-011). The gate still decides what renders.
- `web/src/app/App.tsx`: export the Today `import()` factory so the prefetch and `lazy()` share one promise.
- `web/src/app/AuthGate.tsx`: when `uid` first becomes non-null and `location.pathname === '/'`, call `prefetchToday(new Date())` and the Today import once.
- Near misses and Wildcards are unchanged (not a gate). Added by you stays after the mark.
- Expected gain: the owner-check time plus the chunk import (step 1 will show the actual size). The Watch stream setup is shared instead of paid first.
- Docs: **ADR-050** (prefetch before the owner check: why it is safe, owner-only cost, the 30 s window). ADR-038 notes lever 1 as taken. SECURITY.md row: no data is rendered before the owner check, and rules deny non-owners. CHANGELOG 0.6.3/0.6.4. ARCHITECTURE Today line.
- Tests (`dashboard.test.ts`, `TodayPage.test.tsx`, `AuthGate.test.tsx`): the counts promise is reused once, with no second aggregation call; prefetch errors don't surface; no prefetch when signed out or off `/`; the prefetch listener is cleaned up; the non-owner path renders `NoAccessScreen` and no data.

### Parking lot (ROADMAP, not in this fix)
`limit()` on the counts (for example 1,000 → "999+"). Drop the duplicate `config/app` read in SpendMeter. Firestore persistent cache (lever 2: needs a privacy review because job data would sit in IndexedDB). Count the Today lazy graph in `check:bundle`.

## Verification
- `npm run check` clean. `npm run test:rules` (rules unchanged, but run it). `npm run build && npm run check:bundle`. `node scripts/smoke-functions-bundle.ts`.
- Local: `npm run dev`, open Today. `hfMarks()` lists every mark in order, and the Network panel shows the count requests starting before the `config/app` response.
- Live, after each tag: RUNBOOK step 89 (Fast 4G, 4× CPU, 3 repeat visits). Median `hf:usable` ≤ 2,000 ms, plus the marks table. Compare v0.6.3 (marks only) with the fix release.
- Branch from `main` (`perf-hf-usable`), Conventional Commits, one PR.
