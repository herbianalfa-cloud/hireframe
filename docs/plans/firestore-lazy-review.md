# Review of draft PR #45 (perf/firestore-lazy, d3d42d3..55c21a4)

## Context
Review only; no fixes yet. Checked against CLAUDE.md hard rules, SECURITY.md, ADR-021/050/061/066 and docs/plans/firestore-lazy-plan.md. Built chunks were read from web/dist (built 16:56, after HEAD 55c21a4 at 16:53, clean tree; sizes match the PR: Firestore 131.0 kB gzip, initial 164.7 kB).

## Verdict per item
1. Owner gate: OK. checkAccess unchanged (catch → error, permission-denied → denied, hf:owner in finally via markOnce). Timestamps converted in firestore-boot.readAppConfig, covered by firestore-boot.test.ts.
2. App Check before getFirestore: OK. getFirestore is called only in firestore-boot.connectDb, called only from getFirebase after getFirebaseCore resolves; initHosted calls initializeAppCheck before it returns. Test pins ['appcheck','connectDb'].
3. One copy at run time: OK in this build. index → firebase, zod, react, runtime, firestore-DTTVKU9i (constants) only; firestore-BmoStdv5 (SDK) imports core from firebase-*.js; "initializeApp() first" (@firebase/app) and "has already been registered" (@firebase/component) are only in firebase-*.js; the RPC marker only in firestore-BmoStdv5. Not guarded by CI (M1).
4. check:bundle: rules work as written; gaps in M1, L1, L2.
5. firestore-<hash> constants chunk: yes, rename (L3).
6. Functions/Storage/Auth on getFirebaseCore: OK; no caller destructures only auth/app from getFirebase. Tests for Functions/Storage use a never-settling import. Auth has no test (L6).
7. pipeline-todo: OK. Per-start `cancelled` flag, unsubscribe guarded, no retry on failure, import not repeated except on a new subscribe. Tests weak (M3).
8. Today prefetch: OK. getFirebase's then is registered before the dashboard import's, both after the core; the dashboard chunk shares the same Firestore chunk fetch; uid still arrives after both start. hf:firestore is markOnce, no payload, not set on failure.
9. Tests: the 50 ms sleep and vi.waitFor's 1 s default timeout are wall-clock (M3).

## Findings
High: none. No hard-rule violation (no function, trigger, secret, PII or new host).

Medium
- M1 check:bundle does not guard one copy of @firebase/app/component/auth. Today's build is right only because of `includeDependenciesRecursively:false` and the group regexes; a rolldown or Firebase bump that copies the core into the Firestore chunk passes CI and fails at run time ("Service firestore is not available"). `npm run dev` won't catch it (unbundled). Fix: markers "initializeApp() first" and "has already been registered" each in exactly one chunk, which must be initial.
- M2 firebase-lazy.test.ts "…imports again on the next call" never makes the second call. The Retry path (plan risk 5) is untested. Fix: second getFirebase() after re-mocking a good boot resolves with db and connectDb called once.
- M3 pipeline-todo tests: "starts no listener when everything unsubscribed…" waits a fixed 50 ms, so a slow import makes it pass without testing anything; `listening()`/TodoError use vi.waitFor (1 s default), which can fail on a slow CI first transform. Fix: getFirebase mock returns a deferred the test controls; stop(), resolve it, `await import('./pipeline-todo-listen')`, flush microtasks, assert. Warm the module in beforeAll so the other cases can keep `tick()`.

Low
- L1 check:bundle initial set: the regex counts any `href="/assets/*.js"` (rel=prefetch too) as initial. A prefetch can't pass wrongly; it fails wrongly, so the ADR-066 fallback needs the rule change it already describes. The initial set comes only from index.html, not the entry's static imports; a renamed group passes correctly (marker-based), but a removed group could spread the SDK so the cap measures only the marker's chunk.
- L2 check-bundle.test.ts: no case with the marker in a modulepreload file (only the script src), none for a prefetch link, none for the core-copy rule once added.
- L3 `firestore-DTTVKU9i.js` (shared COLLECTIONS/DOCS/PATHS + FUNCTIONS_REGION, from packages/shared/src/firestore.ts) is a modulepreload. Rename: the plan's verification check fails as worded, the ADR-066 prefetch plugin finds "the firestore chunk" by name (two matches), and step 89's Network tab shows a firestore-* load at boot. Rename via chunkFileNames for chunks whose modules are all in packages/shared (e.g. `paths-[hash].js`), or rename the source to paths.ts (only index.ts re-exports it). Don't add a broad packages/shared group: zod schemas would join the initial JS (ADR at DECISIONS.md:517).
- L4 access.test.ts has no case for the default reader: Firestore chunk import fails → error, never owner; permission-denied through it → denied.
- L5 pipeline-todo: no test for the listener-module import rejecting (error published once, logged, no retry; cancelled → no publish).
- L6 No test that onAuthChange/signInWithGoogle/signOut never wait for Firestore (plan said auth.test.ts would mock getFirebaseCore; auth.test.ts only covers signInErrorMessage).
- L7 Risk (unverified): a failed dynamic import may stay failed in the browser's module map, so Retry may not refetch. Same as the lazy screens; worth one manual offline → online check in step 4.

Nit
- ADR-021 (DECISIONS.md:194) still says 300 kB and ADR-050 (:723) still says the dashboard import starts "as soon as the app loads"; no pointer to ADR-066.
- FirebaseServices redeclares app and auth already in FirebaseCore.
- access.ts: loadFirestoreBoot() in the Promise.all is redundant after getFirebase(); harmless.
- lazy-pages.ts comment lines now run past the file's wrap width.
- firebase-lazy.test.ts: `'anything' as never`.

## Next step after approval
Fix M1–M3 and L3 first (tests + check:bundle rule + chunk name), then L1/L2/L4–L6 and the nits; re-run format:check, check, test:rules, build, check:bundle, and confirm the constants chunk name in index.html.
