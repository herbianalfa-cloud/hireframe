# Plan: chore/deps-firebase-13 (replaces Dependabot #36 and #38)

## Context
Dependabot opened #36 (`firebase` 12.19.0 → 13.0.0, the **web SDK**) and #38 (`@firebase/rules-unit-testing` 5.0.2 → 6.0.0). Both fail `check`, `rules` and `audit` at `npm ci`. Neither PR touches `firebase-tools` (it stays at 15.33.0). The goal is one branch that lands both bumps together, with the Functions runtime unchanged, merged after v1.0.0 and #42 and before #43.

## Open Dependabot alerts
| # | Severity | Package | Summary |
|---|---|---|---|
| 4 | medium | sprintf-js (via mammoth → argparse) | DoS through unbounded precision specifiers. **Stays open by decision.** |

No other alert is open.

## Root causes
1. **The two bumps need each other (the logged failure).** rules-unit-testing 6.0.0 has `peer firebase ^13.0.0` and 5.0.2 has `peer firebase ^12.0.0`. #38 alone fails with `ERESOLVE … peer firebase@"^13.0.0" … Found: firebase@12.19.0` (run 38620575874). #36 alone fails with `ERESOLVE … peer firebase@"^12.0.0" from @firebase/rules-unit-testing@5.0.2 … Found: firebase@13.0.0` (run 38897354556). All three jobs (check, rules, audit) die at `npm ci`. gitleaks passes. The fix is to bump both in one lockfile.
2. **Node ≥ 24 required (not yet reached in the logs, but next in line).** Every package in the firebase-js-sdk 13 release says `engines.node >=24.12.0` (upstream commit aaeedc5, "build!: Update minimum required Node version to 24"). `.npmrc` has `engine-strict=true`, and the root `engines` is `>=22.18 <23`, so `npm ci` would fail with EBADENGINE on Node 22 once the peer conflict is fixed. In the current tree, jsdom and some firebase-tools dependencies (re2, node-gyp, nopt …) accept `^24.15.0` but not 24.12. **So the floor is 24.15.0, not 24.12.**
3. **Latent: two copies of `@firebase/app` in #36's lockfile.** Dependabot's lockfile adds nested `firebase/node_modules/@firebase/app@0.16.3` and `@firebase/app-compat/node_modules/@firebase/app@0.16.3`, but keeps 0.16.2 at the top level. `@firebase/app-check` 0.13.1 and `@firebase/functions` 0.14.0 (both unchanged in 13) resolve the top-level copy, while `firebase/app` resolves the nested one. With two registries, App Check and the Functions SDK would register against a different app copy. That breaks App Check and therefore callables under enforcement in production, and unit tests wouldn't catch it. A fresh `npm install` should dedupe; a new test guards it.

What firebase 13 changes for us: the only listed major changes are in `@firebase/ai`, which we don't use. `app` 0.16.2→0.16.3, `auth` 1.13.6→1.13.7, `firestore` 4.17.2→4.18.0, `storage` 0.14.5→0.14.6. **`app-check` (0.13.1) and `functions` (0.14.0) don't change.** `@firebase/firestore` 4.18.0 still pins `@grpc/grpc-js ~1.9.0`, so the ADR-013 override stays.

## Decision (agreed)
Move the **toolchain only** to Node 24. The Cloud Functions runtime stays `nodejs22`: the esbuild target stays `node22`, the generated `deploy/package.json` keeps `engines.node "22"`, and `@types/node` stays 22.x so typecheck rejects any API that only exists in Node 24. CI adds a smoke of the built functions bundle **on Node 22**. This is recorded as an ADR-008 addendum (no new ADR number, so nothing collides with #42's ADR-062–064 or #43's ADR-065). The runtime move goes to the Parking lot.

## Branch and PR sequence
1. `git fetch origin && git switch -c chore/deps-firebase-13 origin/main`, on Node 24 (see the laptop steps).
2. Commits (Conventional Commits, each one small):
   - `chore: move the toolchain to Node 24.15 (functions stay on nodejs22)`: `.nvmrc` → `24`, root `package.json` `engines.node` → `>=24.15 <25`.
   - `chore(deps): bump firebase to 13.0.0 and @firebase/rules-unit-testing to 6.0.0`: root `package.json` (`firebase`, `@firebase/rules-unit-testing`), `web/package.json` (`firebase`), then `npm install` to regenerate `package-lock.json`. Check `npm ls @firebase/app` shows one version; if it doesn't, run `npm dedupe`. The `overrides` block doesn't change.
   - `ci: smoke the functions bundle on Node 22, the Functions runtime`: `.github/workflows/ci.yml`, see below.
   - `test: one copy of each Firebase web package, and Node pins that agree`: new `scripts/toolchain.test.ts`.
   - `docs: Node 24 toolchain (ADR-008 addendum), firebase 13`: see Files.
3. Open a **draft PR** now so CI runs. The body states the merge order, the Node decision, the no-self-triggering check (no function source changed, no new function, so `maxInstances` is untouched), the bundle sha256 proof and the check:bundle deltas. It ends with "Supersedes #36 and #38".
4. **Merge only after v1.0.0 (#41) is tagged and #42 has merged**, and before #43. Then rebase: `git fetch origin && git rebase origin/main`. On a `package-lock.json` conflict, **never hand-merge**: run `git checkout origin/main -- package-lock.json`, then `npm install` on Node 24, then `git add package-lock.json && git rebase --continue`. Re-run `npm ls @firebase/app` and the full gate. The force-push needs your OK, with the exact command shown first.
5. Mark the PR ready, merge, then tag **its own patch release** (the patch after #42's version) so that the Scan-now proof covers only this change. Then close #36 and #38: `gh pr close 36 --comment "Superseded by #<N> (firebase 13 + rules-unit-testing 6 + Node 24 toolchain)."` and the same for 38.
6. Heads-up for #43: when it rebases, take main's `package-lock.json` and run `npm install`. `web/package.json` (the line next to `firebase`) and `.github/dependabot.yml` (the comment next to its `pdfjs-dist` entry) will show small adjacent-line conflicts; keep both sides. Its ADR-065 number doesn't change.

## Files
- `.nvmrc`: `22` → `24`.
- `package.json`: `engines.node` → `>=24.15 <25`; `firebase` 13.0.0; `@firebase/rules-unit-testing` 6.0.0. `@types/node` stays 22.20.5.
- `web/package.json`: `firebase` 13.0.0.
- `package-lock.json`: regenerated with `npm install` (Node 24 / npm 11).
- `.github/workflows/ci.yml` (`check` job), after `Web bundle budget`:
  ```yaml
  # Cloud Functions runs nodejs22 (firebase.json); the toolchain is Node 24 (ADR-008 addendum).
  - uses: actions/setup-node@949feb2413d6458794dcd2491c4babbbce0c15c1 # v7.1.0
    with:
      node-version: '22'
  - name: Smoke the functions bundle on Node 22
    run: node --version && node scripts/smoke-functions-bundle.ts
  ```
  No `npm` here: it uses the `node_modules` already installed, and `engine-strict` doesn't apply to plain `node`. The smoke script is erasable TypeScript only (it uses `as` casts and imports nothing but `node:fs`) and runs today on Node 22.18+, so there is nothing to compile. The bundle's runtime dependencies (`firebase-functions`, `firebase-admin`) are pure JS; the only native addon in the tree (re2) is a firebase-tools dependency and the bundle doesn't load it.
- `.github/dependabot.yml`: change the `@types/node` comment to "Types track the Cloud Functions runtime (nodejs22); the toolchain is Node 24 (ADR-008 addendum)."
- `scripts/toolchain.test.ts` (new; the `scripts` vitest project already includes `scripts/**/*.test.ts`):
  - `package-lock.json` has exactly one entry each for `@firebase/app`, `app-check`, `auth`, `firestore`, `functions` and `storage`, so no nested `node_modules/**/@firebase/<x>`;
  - the Node pins agree: `firebase.json` runtime `nodejs22` ↔ `scripts/build-functions.ts` `target: 'node22'` and `engines: { node: '22' }` ↔ the `node-version: '22'` of the Node 22 smoke step in `ci.yml`; `.nvmrc` major ≥ 24 and inside the root `engines` range. The files are read as text, the way `hosting-headers.test.ts` and `firestore-config.test.ts` read config.
- `docs/DECISIONS.md`:
  - **ADR-008 addendum (Node 24 toolchain).** Why: firebase 13 and rules-unit-testing 6 require Node ≥ 24.12, and jsdom and firebase-tools' re2/node-gyp require ≥ 24.15 on the 24 line; with engine-strict, the whole toolchain must move. What: `.nvmrc` 24, engines `>=24.15 <25`. Functions stay `nodejs22` with esbuild target `node22`, deploy engines 22 and `@types/node` 22, so typecheck guards runtime APIs, and CI smokes the bundle on Node 22. Consequences: the Functions emulator runs on the host's Node 24 and logs a version-mismatch warning, which is accepted; the Node 22 smoke covers loading the bundle. Revisit before Node 22's end of life.
  - ADR-013: one sentence saying `@firebase/firestore` 4.18.0 (firebase 13) still pins `@grpc/grpc-js ~1.9.0`, so the override stays.
- `docs/RUNBOOK.md:637`: "Node 22" → "Node 24 (≥ 24.15)…". Add a line that Cloud Functions still runs Node 22 (ADR-008 addendum).
- `docs/ARCHITECTURE.md:17`: keep "Cloud Functions v2 (Node 22, TS)"; add "toolchain Node 24".
- `docs/ROADMAP.md` Parking lot: "Move Cloud Functions to `nodejs24` before Node 22 reaches end of life on **30 Apr 2027** (also check Google's nodejs22 deprecation date for Cloud Run functions). Change `firebase.json` runtime, the esbuild target, deploy engines and `@types/node` 24, and drop the Node 22 smoke step. All functions rebuild, so this needs the full clean-weekday gate."
- `CLAUDE.md` Commands: on the `smoke-functions-bundle` line, add "CI also runs it on Node 22, the Functions runtime".
- `CHANGELOG.md`: a new patch entry: firebase 13, rules-unit-testing 6, Node 24 toolchain, the Node 22 bundle smoke, no change to functions.

**Not changed:** `firebase.json`, `scripts/build-functions.ts`, `functions/**`, `.npmrc`, `.github/workflows/deploy.yml`, `firebase-tools`, `web/src/**`. No code change is expected in `web/src/services/callable.ts` or `firebase.ts`; if typecheck disagrees, stop and report.

## Effects
- **CI:** `check`, `rules` and `audit` run on Node 24 from `.nvmrc`. The `check` job gains the Node 22 smoke. The emulator cache key (the lockfile hash) changes, so the emulator JARs are downloaded once. The `audit` gate runs on npm 11; the allowlist doesn't change.
- **CI deploy (Path F):** `deploy.yml` runs npm ci, check, test:rules, build and `firebase deploy` on Node 24 (firebase-tools 15.33 accepts Node ≥ 20). The functions bundle is byte-identical, so firebase-tools' skip rule (the source hash plus env and secrets must match, in `release/planner.js`) prints "Skipping the deploy of unchanged functions" for all 14 functions. There is no Cloud Build run, so the Path F build account isn't exercised and the scheduler jobs and IAM aren't touched. Hosting gets the new web bundle; the rules don't change. If any function shows "Successful update" instead of being skipped, stop: the bundle changed.
- **App Check:** `@firebase/app-check` 0.13.1 doesn't change, and neither do the `initializeAppCheck` / `ReCaptchaEnterpriseProvider` / `onTokenChanged` APIs. The real risk is the duplicate `@firebase/app` (root cause 3), which the new test and `npm ls` close off. It is proved live by the Scan-now proof, because a callable needs a valid limited-use token.
- **`web/src/services/callable.ts`:** `@firebase/functions` 0.14.0 doesn't change; `httpsCallable(…, { timeout, limitedUseAppCheckTokens: true })` stays as it is, and `callable.test.ts` and `callables.test.ts` cover it.
- **Rules tests:** rules-unit-testing 6 has the same API (`initializeTestEnvironment`, etc.) and runs on the firebase 13 client with grpc-js 1.14.5 through the override. `npm run test:rules` must pass, including `tests/emulator/`.
- **Emulators:** firebase-tools doesn't change. The Functions emulator runs on the host's Node 24 (with a warning that it doesn't match `nodejs22`). `npm run dev` must still seed and serve.
- **Functions bundle hash:** unchanged by construction (no functions source or dependency changes, same esbuild target). Prove it, see Verification.
- **Initial JS budget (`check:bundle`):** app, auth and firestore are in the initial JS and get patch/minor bumps. The run must stay under 300 kB gzip with no chunk over 500 kB. Record the per-file gzip sizes before and after in the PR.

## Release gate
**The Scan-now proof is enough. The full clean-weekday gate isn't needed.** Under the STATUS speed-up policy, the full gate is needed only if scanning, scheduling, cost or IAM change live. Here, no function redeploys (all are skipped, with the hash proven), no scheduler job or IAM binding changes, and no LLM or config path changes; only Hosting (the web SDK) changes. The Scan-now proof is also the right live test for this change: Scan now → System shows Succeeded with a run time → `digestNow` arrives → `gcloud scheduler jobs list --location=$R --project=$P` shows every job. It exercises the new SDK, App Check's limited-use tokens and `callable.ts` end to end. Also do the RUNBOOK "Every release" items 1 (window), 2 (step 77 before and after), 4 (the C3 list) and 9 (deploy time). Item 8 ("a proving deploy needs a bundle change") is expected to say "not a proving deploy": record that every function was skipped. **If any function redeploys, this becomes a functions release, and the full gate applies.**

## Risks
- Duplicate `@firebase/app` breaks App Check or callables in production only. Mitigated by `npm ls`, the new lockfile test and the Scan-now proof.
- Node 24 locally vs Node 22 in production: a Node-24-only API in functions code would pass the emulator tests. Mitigated by `@types/node` 22, the `node22` target and the Node 22 smoke.
- npm 11 rewrites the lockfile differently, so other packages could float. The bundle sha256 check catches any change to functions, and check:bundle any change to the web bundle; check the lockfile diff only touches the Firebase packages.
- The rebase onto main after #42: lockfile conflict. The rule is to take main's and run `npm install`, then re-check.
- #43's rebase: adjacent-line conflicts in `web/package.json` and `dependabot.yml`, flagged in its PR.
- Your laptop: Node comes from Homebrew `node@22`, first on PATH in `~/.zprofile`. If that stays first, `nvm use` still wins in that shell, but a new shell without nvm loaded would fail fast with EBADENGINE.

## Laptop steps (Node 24 via nvm; nvm isn't installed yet)
```sh
brew install nvm
mkdir -p ~/.nvm
# add to ~/.zshrc:
export NVM_DIR="$HOME/.nvm"
[ -s "/opt/homebrew/opt/nvm/nvm.sh" ] && . "/opt/homebrew/opt/nvm/nvm.sh"
[ -s "/opt/homebrew/opt/nvm/etc/bash_completion.d/nvm" ] && . "/opt/homebrew/opt/nvm/etc/bash_completion.d/nvm"
# in ~/.zprofile: remove /opt/homebrew/opt/node@22/bin from PATH (keep openjdk@21)
exec zsh -l
nvm install 24          # latest 24.x (must be >= 24.15)
nvm install 22          # for the local Node 22 bundle smoke
nvm alias default 24
cd ~/Projects/hireframe && git switch chore/deps-firebase-13 && nvm use   # reads .nvmrc
node -v && npm -v       # v24.x, npm 11.x
rm -rf node_modules web/node_modules functions/node_modules packages/*/node_modules apps-script/node_modules
npm ci
java -version           # still 21
```
Your local `node_modules` currently has firebase-tools 15.32.1 against the pinned 15.33.0, so the `npm ci` above also fixes that. Optional, later: `brew uninstall node@22`.

## Verification (all on the branch, Node 24 unless stated)
1. `npm ci` (proves the peer conflict and engines are solved), `npm ls @firebase/app @firebase/app-check @firebase/functions` (one version each).
2. `npm run format:check && npm run check`, which includes `scripts/toolchain.test.ts`.
3. `npm run test:rules` (Java 21).
4. `npm run build && node scripts/smoke-functions-bundle.ts && npm run check:bundle`. Record the gzip sizes and compare them with main's.
5. `nvm exec 22 node scripts/smoke-functions-bundle.ts`: the Node 22 smoke, run locally.
6. **Bundle hash proof:** on main (Node 22: `nvm exec 22 npm ci && nvm exec 22 npm run build -w @hireframe/functions`) and on the branch (Node 24), run `find functions/deploy -type f -not -path '*/node_modules/*' | sort | xargs shasum -a 256`. The outputs must be identical; put both in the PR.
7. `npm run audit` (only alert 4's package is allowlisted or open).
8. `npm run dev`: sign in on the emulator, open Today, Jobs and Profile, run Scan now and `node scripts/dev-worker.ts`, download a Ready CV, and check the console for Firebase errors.
9. Look at the CI jobs on the draft PR: all of check (with "Smoke the functions bundle on Node 22" printing v22.x), rules, audit and gitleaks green.
10. After the tag: the deploy log shows all functions skipped, and Hosting released; then the Scan-now proof and the Every-release items above.

## Addendum (review 20 Oct)
Plan approved with these changes:
1. **Laptop:** nvm is installed and sourced in `~/.zshrc`, with Node 24 and 22 and default 22. `~/.zprofile` and the nvm default are not edited. nvm is a shell function: a bash call that needs it runs `. /opt/homebrew/opt/nvm/nvm.sh` first. The session started on Node 24; check `node -v` >= 24.15 before `npm ci`. This replaces the "Laptop steps" section above.
2. **Bundle hash proof:** build main in a worktree (`git worktree add ../hf-main origin/main`; there `nvm exec 22 npm ci` and the functions build), compare the sha256 lists, then `git worktree remove ../hf-main`.
3. **Release:** ship this PR together with #43 in one release after #42's (both Hosting-only), with one Scan-now proof. This replaces step 5's "its own patch release" and the sequence in step 4 and 6.

## Held (20 Oct)

**Held (20 Oct):** firestore 4.18.0 adds BSON/Decimal128 types to its shared core (+~7.5 kB gzip) and re2js 2.8.8 adds ~2 kB, so initial JS is 306.0 > 300 kB. This is not avoidable from our side. The budget stays 300 kB. Resume after ROADMAP item E (Firestore out of initial JS) frees >= 10 kB gzip.
