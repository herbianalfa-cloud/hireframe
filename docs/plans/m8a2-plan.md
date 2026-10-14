# m8a2 plan: `hf:usable` speed fix (v0.8.1, PR perf/m8a2-usable)

## Approved changes to the plan below
1. The ADR is **ADR-061** (ADR-057 to ADR-060 are reserved for 8B and 8C in `docs/plans/m8-plan.md`).
2. **The R7 amendment is approved.** Pass = the median `hf:usable` of 5 repeat visits to Today on the owner's own phone, on mobile data (Wi-Fi off), no throttling, is 2,000 ms or less. The step 89 lab number (Fast 4G + 4x CPU) is recorded each release with its marks table and does not gate. PRD R7, ADR-061 (amends the ADR-038 and ADR-051 R7 measure) and RUNBOOK step 89 are updated, and the phone measure is a new RUNBOOK step.
3. Build A, B, C and D. M1 and M2 are skipped. No tag, no deploy.

---

# v0.8.1 speed fix for PRD R7 (`hf:usable`): diagnosis and plan

## Context
RUNBOOK step 89 on v0.8.0 (14 Oct, Fast 4G + 4× CPU, repeat visits to Today): `hf:usable` 2508, 3003, 3270, 3068, 3551 → **median 3068 ms**, limit 2000. v0.7.3 was about 2350 (12 Oct, no marks table). ADR-050's gate says: over 2000, stop and report with the marks table. This plan is that report and a small, low-risk fix. Branch `perf/m8a2-usable` from `main`, one PR, tag `v0.8.1`.

Sources: the code at `main` (91d4bc3), `web/dist` from 13 Oct, and the installed SDKs: `@firebase/auth` (`initializeCurrentUser`, `_reloadWithoutSaving`), `@firebase/app-check` (`_activate`, `initializeEnterprise`), `react-dom@19.3.0` (`globalMostRecentFallbackTime + 300`) and `react` (`lazyInitializer`). Nothing was run against production.

## 1. Diagnosis: the critical path, mark by mark (slowest visit)

| Mark | ms | Gap | What the gap is |
|---|---|---|---|
| `hf:boot` | 1684 | 1684 | `index.html` is `no-cache`, so it is revalidated: one throttled request, about 165 ms DevTools latency plus server time. Then the 5 initial files come from the immutable cache (≈990 kB raw, 294.9 kB gzip: firestore 479 kB raw, react+router+query 290, zod 95, entry 64, firebase 59). They are compiled and **every static module is evaluated** before `main.tsx`'s body runs. `hf:boot` is the first line of that body, so it comes after the whole initial graph has run at 4× CPU. Most of the 1684 is JS compile and evaluate. |
| `hf:firebase` | 1923 | 239 | `getFirebase()` isn't called until React's first commit: `useAuthState`'s effect → `onAuthChange` → `getFirebase()`. So the gap is React's first render (LoadingScreen) plus the **`/__/firebase/init.json` request** (about 165 ms + server). After that: `initializeApp`, `initializeAppCheck`, `getAuth`, `getFirestore`. |
| `hf:appcheck` | 1931 | 8 | `_activate` reads the cached App Check token from IndexedDB, and the listener fires with it. **The token was valid, so there was no reCAPTCHA run and no exchange.** But `initializeAppCheck` always calls `provider.initialize()`, which appends `enterprise.js`, loads `recaptcha__en.js` and renders the invisible widget on **every** load. That script then runs on the main thread during the next gap. |
| `hf:auth` | 2798 | **867** | Not App Check: its token was ready at 1931. The auth restore in the SDK runs in series: IndexedDB persistence probe and user read → redirect check (sessionStorage only) → **`_reloadWithoutSaving`**: `getIdToken()` (a `securetoken` refresh only when the ID token is over 1 h old) then **`accounts:lookup` on identitytoolkit, a network request on every load**. Its headers wait on the heartbeat (IndexedDB) and `appCheck.getToken()` (cached here, so about 0). Then the user is written back and listeners fire. So it is one or two throttled requests plus IndexedDB work at 4× CPU, and it competes for the main thread with reCAPTCHA's script, the dashboard chunk and React. **App Check is serial before auth only when its token has expired.** Then `accounts:lookup` waits for reCAPTCHA plus the exchange, a much slower visit. A trace is needed to split the 867 (M2). |
| `hf:prefetch` | 2802 | 4 | AuthGate's effect on the uid. The dashboard chunk is already in, so the listener queues at once. Firestore can't send anything before this point anyway: its credentials provider waits for auth's first user. |
| `hf:owner` | 3202 | 400 | The first Firestore traffic: the WebChannel handshake (a POST, then the backchannel GET), so about 2 throttled requests. The `config/app` getDoc and the prefetched Apply query go out on the same stream. Watch raises consistent snapshots, so the owner result may also wait for the Apply target's 10 docs (44 kB) and their rules checks. |
| `hf:today-mount` | 3516 | **314** | **React's Suspense reveal throttle.** The owner result reaches AuthGate through React Query's `useSyncExternalStore`, which is a sync render. `lazy(TodayPage)` always suspends on first render, even when the chunk is already loaded: its factory returns a fresh `.then()` promise that can't be resolved yet. So the `ScreenLoading` fallback is committed, and the retry that reveals Today is held until **fallback time + 300 ms** (react-dom 19.3.0, retry lanes only). 314 ≈ 300 + render. |
| `hf:list:apply` | 3528 | 12 | Today's own listener attaches to the target the prefetch already filled. The data was waiting: it is no longer the gate. |
| `hf:usable` | 3552 | 24 | parseJobs on 10 docs, render, effect. |
| after | 3653–3954 | | Near miss (10 docs, 51.6 kB), the 4 counts plus `hf:counts`, wildcard (3 docs). None gate. |

**Answers to the specific questions**
- **The 1684 ms boot** = one HTML round trip (~200 ms) + compiling and evaluating ≈990 kB of initial JS at 4× CPU, because `hf:boot` comes after the whole static graph. Firestore is 48% of those bytes.
- **The 867 ms between App Check and auth**: auth isn't waiting on App Check on this visit. It is waiting on its own `accounts:lookup` request (plus a `securetoken` refresh when the ID token is over 1 h old), IndexedDB work, and main-thread contention. reCAPTCHA's script loads and runs on every visit, even with a cached token.
- **S3, the early dashboard-chunk import:** it can't delay `hf:boot`, because it is issued from `main.tsx`'s body after the mark. The chunk graph is small (dashboard 4.8 + jobs 3.4 + profile 8.5 = 16.7 kB gzip, ≈44 kB raw; estimated 20–50 ms of evaluation at 4×). It lands in the init.json and auth window, which is mostly network wait, so its cost on the path is about **0–30 ms**. Not worth undoing.
- **Animation set-up:** there isn't any in JS. The only animations are Tailwind `animate-spin` and `animate-pulse` (CSS, run by the compositor). 0 ms; nothing to defer.
- **Why v0.8.0 may be slower than v0.7.3 (~2350):**
  1. **ADR-050's gains were absorbed by the 300 ms throttle.** The Today chunk preload can't help, because `lazy` suspends once anyway and React holds the reveal for 300 ms. The Apply prefetch can't help much, because the gate is now owner + 300 ms, and that is later than the data. So v0.8.0 gained close to 0.
  2. **What it added on the path:** the owner snapshot may now wait for the Apply target (44 kB, 10 rules checks) on the same Watch stream, about +50–150 ms. There is extra main-thread work during the network waits (the dashboard chunk at boot, the Today chunk at the uid, a second listener), about +0–60 ms.
  3. **The rest (≈500 ms) can't be explained from code.** The 5 visits span 1,043 ms (2508–3551) and rise visit by visit. v0.7.3 has no marks table. Things that vary between visits: `accounts:lookup` and Firestore server time, a `securetoken` refresh on the first visit after an hour, and an expired App Check token (a reCAPTCHA run). M1 below shows which gap moves.

## 2. Candidate fixes (ms saved on this path, cost, risk)

| # | Candidate | Saves (lab, per visit) | Cost | Risk | In set? |
|---|---|---|---|---|---|
| A | **Render Today directly when its chunk is loaded** (no Suspense fallback, so no 300 ms reveal throttle) | **≈250–270** (314 → ~50) | Small: `lazy-pages.ts`, `App.tsx`, tests | Low. The choice is made once per mount (`useState` initializer), so it never remounts. If the chunk isn't loaded yet it falls back to today's `lazy` path. | **Yes** |
| B | **Start auth restore earlier:** preload `/__/firebase/init.json` from the HTML (`<link rel="preload" as="fetch" crossorigin>`, injected at build only) and call `getFirebase()` at the top of `main.tsx`, before the first render | **≈180–230** if init.json is a network request on repeat visits (expected); ≈40–60 if it is already cached (M2 says which) | Small: a build-only `transformIndexHtml` plugin in `vite.config.ts`, one line in `main.tsx`, a `check:bundle` assertion | Low. Same URL and same CORS mode, so `fetch()` reuses the preload. CSP `connect-src 'self'` covers it. The config still comes from Hosting (no config in the repo or CI, ADR-012). | **Yes** |
| C | Preconnect to `identitytoolkit`, `securetoken`, `firestore.googleapis.com` | **0 counted.** DevTools throttling works per request and doesn't model handshakes, and repeat reloads reuse warm sockets. On real 4G after idle it saves about 100–300 ms per cold host. | Trivial (same plugin) | Very low. These hosts are contacted anyway. Not `www.google.com`, which would pull reCAPTCHA earlier. | **Yes** (real use only) |
| D | `hf:prefetch:data` mark (the prefetch's first snapshot, `{docs, fromCache}`) | 0. It is measurement only, and shows whether the data ever becomes the gate again. | Trivial | None | **Yes** |
| E | Move Firestore out of the initial JS (dynamic import started at boot): initial 294.9 → ≈156 kB gzip | ≈80–200 (less work before `hf:boot`; some of it comes back in the auth wait) | Medium-high: split `getFirebase`, dynamic Firestore in `access.ts`, `timestamps.ts`, `pipeline-todo.ts`, lots of test mocks | Medium. It touches the owner-check file and the boot order. | No (doesn't change the outcome; parking lot) |
| F | Defer App Check's reCAPTCHA load while a cached token is valid (a wrapper around the provider) | 0–300 (only contention; needs M2) | Medium | **High.** It depends on App Check internals, it is the attestation path, and a reCAPTCHA started late gives lower scores, so more token refusals. App Check isn't serial on this path. | No |
| G | Smaller Today list payload (≈4.4 kB/doc; a slim card doc or fewer fields) | ≈0–60 (≈45 ms of transfer at 8 Mbps plus parsing, and only through the shared Watch snapshot) | High: a denormalized server write path, rules, indexes | Medium | No |
| H | Firestore persistent cache (IndexedDB) | **≈0, possibly negative.** The gate is the owner check, and `getDoc` still waits for the server (no change to the owner check allowed). The data already arrives before the gate. IndexedDB setup (open, tab lease) adds ≈50–150 ms at 4× before the first Firestore read. | Medium | Privacy (below) | No |

**H, what would sit in IndexedDB** (`firestore/[DEFAULT]/<project>/main`: stores `remoteDocuments`, `targets` with query definitions and resume tokens, `targetDocuments`, `mutationQueues`/`mutations`/`documentOverlays` for pending writes, plus `owner` and `clientMetadata` leases). It holds every document any screen reads, not only Today:
- job docs: title, company, location, salary, URL, verdict, scores, reasons, gaps, talking points, matched fact IDs, keys, sources, and description text until it is purged;
- `config/app`: owner uid, caps;
- criteria versions;
- profile facts: work history, education, skills, work rights;
- `profile/cvHeader`: name, email, phone, location, links;
- applications, including the owner's answers and notes;
- `cvs` metadata, usage and spend, runs, the watchlist;
- any write not yet sent, such as a feedback note.

Effects:
- It stays after the tab closes and **after sign-out**, unless the app calls `terminate()` + `clearIndexedDbPersistence()`. A revoked session or a forced sign-out leaves it in place.
- The default cache limit is 40 MB with LRU, so in practice all of it stays.
- The app doesn't encrypt it: only OS disk encryption and the browser profile protect it.
- It can be read from an unlocked device (DevTools → Application), by user-level malware (the profile's LevelDB files), by extensions with content scripts on the origin, and by any XSS on the origin without a live session.
- The remote-document cache isn't partitioned per user, so a second account on the same profile starts with the first user's documents on disk (the gate would still render nothing).
- Rules are unchanged, and the server stays the authority.
- Firebase Auth already keeps a refresh token in IndexedDB. The cache adds *offline, post-sign-out, token-free* exposure of the CV facts and contact details.

That cost, for a 0 ms gain on this path, is why H is out.

## 3. Prediction
Slowest visit: 3552 − A (≈260) − B (≈200) ≈ **3,090**. A and B are structural, the same on every visit. **Predicted median ≈ 2,600 ms (range 2,550–2,800; the top of the range if init.json turns out to be cached).** That is still **above 2,000 ms**. Even adding E and F at their best gives about 2,100–2,400. The remaining floor is the boot JS at 4× CPU (~1.45 s), Auth's `accounts:lookup` on every load (~0.85 s, inside the SDK, auth method fixed) and the owner check's 2 Firestore requests (~0.4 s). None of these can move within the hard limits.

**Recommendation: amend R7 so that pass or fail is judged on real use**, and record the step 89 lab number only. Proposed wording (ADR-061, amending ADR-038's and ADR-051's R7 measure; PRD R7 AC):
- **Pass:** the median `hf:usable` of 5 repeat visits to Today on the owner's own phone, on mobile data (Wi-Fi off), with no throttling, is ≤ 2,000 ms.
- The Fast 4G + 4× CPU number (step 89) is recorded with its marks table each release and doesn't gate.

I'll make this docs change in the PR only if you approve it with this plan. If you don't, the PR ships A–D and records the number.

## 4. Implementation (one PR, `perf/m8a2-usable` → `v0.8.1`)
1. **A: direct Today render.** `web/src/app/lazy-pages.ts`: `loadTodayPage()` also stores the resolved module, and a new `loadedTodayPage()` returns it or `undefined`. `web/src/app/App.tsx`: a `TodayRoute` takes `useState(() => loadedTodayPage()?.TodayPage ?? LazyTodayPage)` once per mount and renders it inside the existing `Suspense`. Other screens are unchanged.
   Tests (`App.test.tsx` / `lazy-pages.test.ts`): after `await loadTodayPage()`, `/` renders Today with no `Loading screen` status. Without the preload it shows the fallback, then Today (current behaviour). Revisiting `/` doesn't remount mid-life.
2. **B + C: early Firebase start.** In `web/vite.config.ts`, a small build-only plugin (`apply: 'build'`, `transformIndexHtml`, head-prepend) adds:
   - `<link rel="preload" href="/__/firebase/init.json" as="fetch" crossorigin>`;
   - preconnects (with `crossorigin`) to `https://identitytoolkit.googleapis.com`, `https://securetoken.googleapis.com` and `https://firestore.googleapis.com`.

   `web/src/main.tsx`: `void getFirebase().catch(() => undefined)` right after `hf:boot`, before `createRoot`. `onAuthChange` joins the same promise. A failed init still allows the UI retry. `getFirebase` stays the only bootstrap, so components still never touch Firebase.

   `scripts/check-bundle.ts`: fail if `dist/index.html` lacks the init.json preload, or if the preload comes after the entry script.
3. **D: mark.** `web/src/services/dashboard.ts` `prefetchToday`: `markOnce('hf:prefetch:data', () => ({ docs, fromCache }))` on the first snapshot, scalars only. Covered by `dashboard.test.ts`.
4. **Docs.**
   - `docs/DECISIONS.md`: ADR-061 (A, B, C and why E–H were not taken, including the IndexedDB analysis; plus the R7 amendment if approved). A note on ADR-050: the chunk preload only pays with A.
   - RUNBOOK step 89: 5 visits, and expect `today-mount − owner` < 100 ms and `firebase − boot` < 60 ms.
   - `CHANGELOG.md` 0.8.1, ARCHITECTURE (startup order).
   - SECURITY row: the preload and preconnects contact no new host and carry no data.
   - ROADMAP parking lot: E, F, G, H (with the privacy finding), and the reveal throttle on the other lazy screens. PRD R7 only if approved.
5. `npm run check`, `npm run build && npm run check:bundle` (initial JS unchanged at ≈294.9 kB, still ≤ 300), `node scripts/smoke-functions-bundle.ts`, `npm run test:rules` (rules unchanged). Conventional Commits; PR description per the public-repo rule (no personal data). Tag `v0.8.1` after merge with your OK; CI deploys.

Hard limits respected: the owner check, App Check enforcement, Firestore rules and the auth method are untouched. The initial JS stays ≤ 300 kB gzip.

## 5. Measurements
M1 and M2 are skipped (the owner decided). **M3** becomes RUNBOOK steps: after the v0.8.1 deploy, step 89 (lab, 5 repeat visits, each marks table, recorded, not gating) and the phone measure (5 reloads of Today on the owner's phone on mobile data, Wi-Fi off, no throttling; the median gates R7).

## Verification
- Local: `npm run dev`, open Today, `hfMarks()`: the order is `hf:prefetch` < `hf:prefetch:data` ≤ `hf:owner` < `hf:today-mount` < `hf:usable`, and the `Loading screen` skeleton never appears after the owner check.
- Build: `web/dist/index.html` has the preload and preconnects before the entry script; the dev `index.html` has neither.
- Live: Network shows one `init.json` request, started by the preload (no "preloaded but not used" warning in the console), and the M3 numbers.
