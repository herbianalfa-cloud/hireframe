# M8 PR 8C2: instance audit, lock refactor, Path F, v1.0.0 (plan)

## Ambiguous or risky (read first)

**Settled in this planning session**
1. **"Literal timeout"** means: every options object has a `timeoutSeconds` key at its call site, set to a number or to `CALLABLE_TIMEOUT_SECONDS.<sameName>`. The shared table stays the only copy, because the web client waits on it. The table test pins each timeout to a number written in the test. `maxInstances: 1` must be a numeric literal.
2. **v1.0.0 gates (five):**
   - RUNBOOK step 97 (phone test);
   - the restore drill C17–C20;
   - one clean weekday on v0.9.0;
   - the **Scan-now proof on v0.9.1**: right after the deploy, Scan now → System shows Succeeded (run time recorded) → `digestNow` arrives → `gcloud scheduler jobs list --location=europe-west2` shows every job;
   - C47 (a real budget message parsed).

   This replaces the plan's "clean weekday on v0.9.1". **One full clean weekday on v1.0.0** goes into the ADR-059 addendum as a v1.0.1 (arming) precondition. It is not a v1.0.0 gate.
3. **Docs scope:** Session B also does the rest of plan §3's docs:
   - the Recovery entries;
   - the "Every release" checklist;
   - the ADR-017 addendum;
   - ARCHITECTURE, ROADMAP and CHANGELOG 1.0.0;
   - `.gitignore`.
4. **Late ticks:** some checklist evidence only exists after the v1.0.0 deploy (C50, the K26 diff, K27, K28, C41). 8C2 merges with those items marked "pending K25–K28". A docs-only PR after v1.0.0 ticks them. Deploys run only on tags, so that PR deploys nothing.

**Where this plan departs from `m8c-plan.md` (Session B1 fixes the plan to match)**
- **Branch:** `feat/m8c2-hardening` (your instruction), not `chore/m8c2-iam-release`. It starts from `main`, which already has 8C1 merged.
- **There are 14 functions, not 15.** `index.ts` exports 14. The plan's "15 functions, none Skipped" (K23) and "15 functions rebuild" (Risks) are wrong.
- **K numbering:** the plan's K14–K25 become K14–K28. The plan's K25 is split into live checks, the 24-hour checks and the revoke step, and the Phase 3 snapshot gets a step of its own.

**Risks**
- **The PR must not merge before v0.9.1 is tagged.** It opens as a **draft**, and the body says "merge only at RUNBOOK K20". K20 comes after every gate (K19), so it is after v0.9.1 by construction. Merging deploys nothing, because deploys run only on tags.
- **Global options in `__endpoint`.** The table test assumes firebase-functions 7.4.0 merges the global `serviceAccount`/`maxInstances` into each `__endpoint`. The `billingGuard` test already reads `serviceAccountEmail` that way. If a global value turns out to be missing, Session A **stops and reports**; it does not weaken the test.
- **The proving deploy depends on the bundle changing** (plan finding 5). Session A records the sha256 of `functions/deploy/index.js` built on `main` and on the branch, and they must differ. A single codebase means every function's hash changes.
- **`roles/browser` for the guard (option A)** also lets the guard read the project's IAM policy and its folder/org hierarchy. The ADR-059 addendum records this as accepted: the guard has no secrets, and its token stays in a closure. A custom role holding only `resourcemanager.projects.get` goes to the parking lot as a later narrowing. This doesn't reopen the decision.
- **Facts only known after v0.9.1:**
  - which push-delivery grant is live (K12);
  - whether C38b `eventarc.developer` was needed;
  - the v0.9.1 deploy time.

  None of these is written by the build. K20's evidence commit records them in ADR-059 and SECURITY. If the v0.9.1 deploy takes more than 12 minutes, K20 also raises `timeout-minutes` in `.github/workflows/deploy.yml` (20 today).
- **Phase 3 API disables (K17) must run after v0.9.1** and its Scan-now proof, so a disable can't be confused with a v0.9.1 fault.
- **The build is read-only toward the cloud.** It runs no deploy, tag, gcloud command or IAM change, and `BILLING_GUARD_MODE` stays unset. Every live step is RUNBOOK text.

## Context
- 8C1 (`billingGuard`, dry run) is merged; v0.9.1 is tagged Mon 19 Oct.
- 8C2 finishes M8 and is the last code PR before v1.0.0:
  - every function states its limits in its own options, with tests that make that permanent;
  - the three copies of the stale-lock rule become one (8C1 review #12);
  - ADR-060 makes the compute account build-only (Path F);
  - the spike results go into ADR-059;
  - RUNBOOK K14–K28 hold the Phase 3 and Phase 4 live steps;
  - the SECURITY "Before v1.0.0" checklist lists the evidence and the five gates.
- The code change is also what makes v1.0.0 a proving deploy: every function rebuilds under the new IAM.

---

## Session A (Sonnet · Medium): items 1 and 2, with tests

### Files
- **Literal `maxInstances: 1` at the 7 call sites that only inherit it.** Each is inline in the object passed to `on*()`, never inside `ownerOptions`/`llmOptions`, so the source test can see it. Each gets the existing comment "Stated here as well as in the global options, so a change there can't widen this one."
  - `functions/src/profile/callables.ts`: `parseCv`, `addFact`, `resetProfile`
  - `functions/src/funnel/callables.ts`: `rescore`
  - `functions/src/lookup/callable.ts`: `lookup`
  - `functions/src/scan/callables.ts`: `scanNow`, `scheduledScan`
  - `options.ts` `setGlobalOptions` stays as a backstop. Timeouts are already explicit (`CALLABLE_TIMEOUT_SECONDS.<name>`) and don't change.
- **`functions/src/scan/store.ts`: the lock refactor**
  - `export function lockLiveUntil(lock: Pick<ScanLock, 'runId' | 'startedAt' | 'staleAt'> | undefined): Date | undefined`
    - Undefined unless `lock.runId` (truthy, the same as today) and `lock.startedAt` are both set.
    - Otherwise `staleAt ?? startedAt + SCAN.lockStaleMs`.
    - `ScanLock` comes from `packages/shared/src/jobs.ts:492`.
  - `export function isLockLive(lock, now: Date): boolean` returns `until !== undefined && now < until`.
  - Use it at all three sites:
    - `liveLockHolder` (`:62-69`): `if (!parsed.success || !isLockLive(parsed.data, now)) return null; return parsed.data.holder ?? 'scan';`
    - `acquireOrRefreshWipe` (`:86-89`): `const live = isLockLive(lock, now);`
    - `acquireLock` (`:140-143`): `if (lock && isLockLive(lock, now)) return { ok: false, reason: 'running', holder: lock.holder ?? 'scan' };`
  - The dead-scan recovery, the cooldown and the written lock shape don't change. **No behaviour change.**

### Tests
- **`functions/src/index.test.ts`: new `describe('every function states its limits (ADR-060, C2)')`**
  - **`EXPECTED` table** with 14 rows. Each row holds `trigger` (`callable` | `https` | `schedule` | `pubsub`), `timeoutSeconds`, `memoryMb` and `account` (`fns` | `guard`). The numbers are written out, on purpose, as in the region test.
    - 1024 MiB unless listed below: `deleteAllData`, `ingestEmailJobs`, `getDigest` and `purgeOldData` are 512; `billingGuard` is 256. Session A confirms each against the source.
  - **Exports equal the table:** sorted export names equal the table's keys, so a new export without a row fails.
  - **Per function (`it.each`):**
    - `maxInstances` is 1;
    - `timeoutSeconds` equals the table's number **and** `CALLABLE_TIMEOUT_SECONDS[name]`;
    - `availableMemoryMb` equals the table's number;
    - exactly one of `callableTrigger`, `httpsTrigger`, `scheduleTrigger` or `eventTrigger` is set, and it matches `trigger`;
    - a schedule has `retryConfig.retryCount` 0; an event has `retry` false;
    - `serviceAccountEmail` is the literal `hireframe-fns@hireframe-f6b03.iam.gserviceaccount.com`, except `billingGuard`, which is `hireframe-billing-guard@…`.
  - **Source scan**, a pure helper `limitProblems(file, source): string[]` in the test file, using `typescript`'s AST (precedent: `billing/endpoint.test.ts:3`):
    - It walks `functions/src/**/*.ts`, excluding `*.test.ts` and `loadtest/`.
    - It flags every call to an `on[A-Z]…` identifier imported from `firebase-functions/*` whose first argument:
      - isn't an object literal;
      - lacks a `maxInstances` property assignment with the numeric literal `1` (a spread doesn't count);
      - or lacks `timeoutSeconds` set to a numeric literal or `CALLABLE_TIMEOUT_SECONDS.<the exported const's name>`.
    - It expects no problems, and the number of call sites found must equal the number of exports (14). So a wrapper that hides a trigger fails too.
  - **Self-check:** `limitProblems` run on inline samples flags each failure: no `maxInstances`, `maxInstances: 2`, a spread only, no timeout, a mismatched table key. This makes the "a planted function fails" check permanent rather than a manual step.
  - Existing per-function `describe`s stay; where they now repeat the table, they could be trimmed later.
- **`functions/src/scan/store.test.ts`**
  - **New pure tables for `lockLiveUntil`/`isLockLive`:**
    - each holder (scan 12, email 3, lookup 2, wipe 3 min): window − 1 ms is live; the window and window + 1 ms are free;
    - legacy (no `staleAt`, no holder): 12 min ± 1 ms;
    - no `runId`, or `runId: ''` → undefined and not live;
    - no `startedAt`, even with a future `staleAt` → undefined;
    - a `staleAt` shorter than the 12-minute fallback is honoured;
    - `undefined` lock → undefined.
  - **The `liveLockHolder` cases stay.**
  - **Drift guard (source):** `store.ts` contains `+ SCAN.lockStaleMs` exactly once (in `lockLiveUntil`), and `isLockLive(` at least 3 times outside its definition.
- **Unchanged and run in the gate:** the emulator lock tests (`tests/emulator/scan.test.ts`, `wipe.test.ts`, `ingest.test.ts:384-411`) through `npm run test:rules`.
- **Red first:**
  - the new lock tests fail before the functions exist;
  - for the source scan, temporarily delete one new `maxInstances: 1` and watch it fail, then restore it.

### Commits
1. `chore: fold the scan lock stale rule into lockLiveUntil and isLockLive`, with the store tests.
2. `feat: state maxInstances on every function`, with the table test, the source scan and the self-check.

### Acceptance criteria covered
- Billing-guards AC: "a test fails when a function has no `maxInstances`" (and now also no explicit timeout).
- 8C1 review #12: one stale rule, ±1 ms boundary tests on the function the transactions use.
- Plan finding 5: the bundle changes, so v1.0.0 rebuilds every function. Proven by the sha256 check.
- No behaviour change: C14 after v1.0.0 must show the same instances and timeouts.

### Risks (Session A)
- **A global value missing from `__endpoint`:** stop and report (see the top section).
- **A false negative in the source scan from an unusual call shape:** caught by the count-equals-exports check.
- **The refactor shifts the semantics of `runId: ''` or of a lock with `staleAt` but no `startedAt`:** both are pinned by the new tables.
- **The load test isn't touched:** its lock use goes through the same store.

### Gate (after the last commit)
1. `npm run check`
2. `npm run format:check`
3. `npm run test:rules`
4. `npm run build`
5. `npm run check:bundle`
6. `node scripts/smoke-functions-bundle.ts`
7. `npm run audit`

After the gate, record the sha256 of `functions/deploy/index.js` built on `main` (`git worktree` or a clean checkout) and on the branch. They must differ.

---

## Session B: items 3–6 plus the §3 docs, in two Sonnet · Medium sessions

### Split
- **B1:** DECISIONS (ADR-060, the ADR-017 and ADR-059 addenda), SECURITY, ARCHITECTURE, ROADMAP, CHANGELOG, `.gitignore` and the m8c-plan note. Then the full gate, the push, and a handoff at `docs/plans/m8c2-handoff-b.md`.
- **B2:** RUNBOOK (K14–K28, Every release, the Recovery entries). Then the full gate after the last commit, and the draft PR.
- **The handoff (`m8c2-handoff-b.md`)** holds:
  - the branch head SHA;
  - the B1 gate result;
  - the K14–K28 numbers and titles that SECURITY and the ADRs cite;
  - the Recovery entry titles that ADR-059 and SECURITY point at;
  - the PR body draft (below);
  - anything B1 left open.

  B2 starts from it and must keep every cited K number and title unchanged.

### Files and content
- **`docs/DECISIONS.md`**
  - **ADR-060 "Build account: the compute account becomes build-only (Path F)"**, as plan §3's outline:
    - **Context:** the compute account holds Editor, and firebase-tools 15.32.1 sends no `buildConfig.serviceAccount`.
    - **Decision:** the compute account becomes build-only.
      - Editor is removed.
      - It gets `logging.logWriter` (project), `artifactregistry.writer` on `gcf-artifacts`, and `storage.objectViewer` conditioned on `resource.name.startsWith("projects/_/buckets/gcf-v2-")` (title `gcf-sources`). The spike proved the condition, so no per-bucket grant is needed.
      - `cloudbuild.builds.builder` isn't needed. Quota 0 doesn't block builds.
    - **Nothing runs as it:** the table test, C3 and C39a/b.
    - **The deployer keeps `serviceAccountUser` on it.** It needs that to act as the build account, so the ROADMAP's "drop it" is impossible, and the ADR says why.
    - **Instance audit note:** all 14 functions are at a literal 1; callables stay at 1; the global option is a backstop.
    - **Proof:** the v1.0.0 deploy (K25, C50). A re-run proves nothing. Rollback is C40.
    - **Revisit** when firebase-tools supports a build account. The App Engine default account's Editor is parked.
  - **ADR-017 addendum (M8 8C2):**
    - every function states `maxInstances: 1` and `timeoutSeconds` in its own options;
    - the global options stay as a backstop;
    - the table test and the source scan enforce both.
  - **ADR-059 addendum (8C2, spike 17 Oct):**
    - Path F build passes.
    - Quota 0 doesn't block builds; a new project starts at CPUs/GPUs (all regions) = 0.
    - Armed below the budget, the guard logs `billing_guard.below`.
    - The project-ID lookup works.
    - **`billing.projectManager` alone fails** GET `billingInfo` with `permission_denied`, because it needs `resourcemanager.projects.get`. With `roles/browser` added: `billing_guard.disabled`, `billingEnabled` False.
    - **Decision (17 Oct, Beeb):** option A for arming in v1.0.1. The prod guard gets `billing.projectManager` plus `roles/browser`. This supersedes the "only if `projectManager` is enough" line.
    - `roles/browser`'s extra read access is accepted (top section).
    - **v1.0.1 preconditions:**
      - one full clean weekday on v1.0.0;
      - the arming check (topic IAM) after Editor removal;
      - C37b grants both roles;
      - `functions/deploy/.env` holds `armed`.
    - **Spike-only notes:**
      - the `FUNCTION_SIGNATURE_TYPE=cloudevent` env var a gcloud deploy needs;
      - after an invoker grant, wait 2 minutes.
    - **Arming is not part of 8C2.**
- **`docs/RUNBOOK.md`**
  - Retitle Part K to cover 8C2 and v1.0.0, and replace the closing line "K14 onwards … belong to PR 8C2".
  - Add K14–K28 below. Each step gets its command, check and rollback, uses the existing setup block, and has every command approved in chat.
  - Add a new **"Every release"** subsection:
    - the window: a weekday, 10:00–16:00 London, never Sun 25 Oct;
    - nothing Generating;
    - step 77 before and after the deploy;
    - invokers for new functions, by type (callable step 28; scheduled step 94.4; event K8);
    - the C3 list;
    - indexes Enabled;
    - C14 on new functions;
    - step 89 recorded and step 97 when R7 is touched;
    - a proving deploy needs a bundle change;
    - deploy time inside the job timeout.
  - **New Recovery entries:**
    - **"Billing was disabled":** check `billingEnabled` and the `billing_guard.*` logs, find the cause first, relink with `gcloud billing projects link`, then C3, a Scan now and a backup check (ADR-058);
    - **"Project suspended (card declined)";**
    - **"Rollback the Editor removal" (C40):** the add command, wait 2 minutes, **Re-run failed jobs**; the per-bucket `objectViewer` variant if a build log shows 403 on `gcf-v2-*`;
    - **"First Pub/Sub function: the CLI's IAM step":** the K6/K9 pattern generalised.
- **`docs/SECURITY.md`**
  - Update the Billing row: the v1.0.1 arming plan with both roles; Editor removed at v1.0.0.
  - Add a row: **"Over-privileged default compute account (ADR-060)".**
  - Point the first-deploy checklist's unticked "All secrets in Secret Manager" item at K15.
  - New **"Security checklist before v1.0.0"** section. Each item has an evidence pointer:
    - secrets and gitleaks (C34/K15);
    - no user-managed keys (C48/K14);
    - the invoker audit (C49/K16);
    - the IAM snapshot and diff (K26);
    - Editor removed and the proving deploy green (C39, C50);
    - deployer baseline (C43);
    - the kill switch in the throwaway (C30);
    - dry run on prod (C35);
    - C47;
    - budgets and the virtual card, passkey and recovery (owner);
    - quotas 0 (C53/K18);
    - APIs (C33/K17);
    - the restore drill;
    - the wipe tested;
    - the audit allowlist;
    - the `maxInstances` test;
    - no self-triggering;
    - `gcloud auth revoke` (C41).
  - **Ticked at build:** only items whose evidence exists today: C30 (17 Oct spike), the audit allowlist (8A), the wipe tests and load test (8B), the `maxInstances` test (Session A), no self-triggering (PR body).
  - **The K numbers are fixed by this plan** (K14–K28 as in the outline below), so B1 can cite them before B2 writes the steps.
  - **"v1.0.0 release gates" sub-list:** the five gates.
- **`docs/ARCHITECTURE.md`:** Environments: the build account, and nothing runs as the compute account.
- **`docs/ROADMAP.md`:**
  - The M8 row: 8C1 is v0.9.1; 8C2 is built; v1.0.0 after the gates; Path F instead of "a dedicated Cloud Build account"; the deployer keeps `serviceAccountUser` (ADR-060).
  - Parking lot:
    - the App Engine account's Editor;
    - a custom role narrowing `roles/browser` for the guard;
    - a build account once firebase-tools supports one.
- **`CHANGELOG.md`: `## [1.0.0] - Unreleased`**
  - Changed: the literal `maxInstances` (no behaviour change; rebuilds every function) and the lock refactor.
  - Tests.
  - Docs.
- **`.gitignore`:** `iam-*.json` and `iam-*.txt`.
- **`docs/plans/m8c-plan.md`:**
  - a short note pointing at RUNBOOK K14–K28 as authoritative;
  - 15 → 14 functions;
  - the branch name;
  - the gate list.

### RUNBOOK K14–K28 (outline)

**Phase 3: stolen-account guards (own weekday window, after the v0.9.1 Scan-now proof, each step approved alone)**

| Step | What | Check | Rollback |
|---|---|---|---|
| K14 | Snapshot `flat > ~/iam-before-p3.txt`; C43; C48 keys loop; C51 | 7 baseline roles (8 if C38b, recorded); 0 user keys for every account; compute account holds only `roles/editor` | — |
| K15 (C34) | `secrets list`, then `get-iam-policy` for each | the accessor is only `hireframe-fns`; deployer `secretmanager.viewer` per ADR-017; no public member; the last `main` CI gitleaks job green | — |
| K16 (C49) | The invoker loop over `run services` | `allUsers` only on the 8 callables plus `ingestemailjobs` and `getdigest`; `hireframe-fns` only on the 3 scheduled; the guard only on `billingguard` | Recovery entries per function |
| K17 (C32, C33) | List the enabled APIs; Claude proposes a disable list in chat; `gcloud services disable <api>` one at a time, **never `--force`**; the never-disable list copied from the plan | after each: the app loads and signs in, System OK, the next scan succeeds | `gcloud services enable <api>` |
| K18 (C53) | Record the current CPU/GPU (all regions) values, then set both to 0 in the console | the C24c read with `--project=$P` shows 0 and 0; `flat` diffed against K14 shows no change; then **Scan now → System shows Succeeded** (the spike proved builds under quota 0, not the runtime) | set the old values back |

**Phase 4: v1.0.0 (after the five gates, a weekday 10:00–16:00, nothing Generating, never Sun 25 Oct)**

| Step | What | Check | Rollback |
|---|---|---|---|
| K19 | Record the release checklist: the five gates with dates; Lighthouse and 360 px referenced from 8A2; the R1–R12 pointers | every gate has its evidence | — |
| K20 | Evidence commit to 8C2: the pre-deploy SECURITY ticks, the gate dates, ADR-059's live push grant and C38b, the deploy-timeout bump if v0.9.1 took more than 12 min. CI green, then merge (merging deploys nothing) | the PR merged | — |
| K21 | K1 (C1–C3); `flat > ~/iam-before-100.txt`; C43; C51; C39a/b; the topic IAM read | nothing uses `$COMPUTE`; record the topic's publishers | — |
| K22 (C52) | `gcloud storage buckets list … \| grep '^gcf-v2-'` | the sources and uploads buckets exist and match the condition's prefix; otherwise stop | — |
| K23 (C39) | The 3 Path F grants, exactly as the spike proved | C51 shows editor + logWriter + objectViewer (`gcf-sources`); the AR policy shows the writer | each with `remove-…` |
| K24 (C39) | Remove `roles/editor` from `$COMPUTE`, **then go straight to K25** | C51 shows exactly logWriter + objectViewer | C40: add Editor back |
| K25 (C4, C50) | `git checkout main && git pull && git log -1` shows the merge commit, **then** tag `v1.0.0`, push and approve | all **14** functions show "Successful update operation", none Skipped; `builds list` all SUCCESS as `$COMPUTE` | a build fails → C40, wait 2 min, **Re-run failed jobs**, report the log line |
| K26 | `flat > ~/iam-after-100.txt && diff` against K21's file | exactly `- roles/editor`, `+ logging.logWriter`, `+ storage.objectViewer` on `$COMPUTE`; C43 is the baseline | — |
| K27 | Live checks: K1 again; C51; C39a/b; C49 (K16); C14 table (`functions list` with instances, timeout and memory, expected values from the table test); C35 below-threshold publish → `below` with `dry_run` within 2 min and the env var absent; topic IAM read (the ADR-059 arming check, recorded for v1.0.1) | every check as stated | C40 if the runtime breaks |
| K28 | Within 24 h: scheduled scan Succeeded; digest arrived; `generateCvs` last attempt OK; `retention.done` at 03:30; Apps Script `run` 2xx; the step 89 lab table. Then C41 `gcloud auth revoke` on the laptop, delete `~/iam-*.txt` from Cloud Shell, and open the follow-up docs PR ticking C50, K26, K27, K28 and C41. v1.0.1 waits for one full clean weekday on v1.0.0 | every item recorded | — |

### Commits
**B1**
1. `docs: add ADR-060 Path F and the ADR-017 and ADR-059 addenda`
2. `docs: add the SECURITY v1.0.0 checklist and the release gates`
3. `docs: update ARCHITECTURE, ROADMAP, CHANGELOG 1.0.0 and the m8c plan`
4. `chore: ignore IAM snapshot files`
5. `docs: add the 8C2 session B handoff`

The handoff is committed last, so B1's gate runs after it. Then B1 pushes `feat/m8c2-hardening`.

**B2**
1. `docs: add RUNBOOK K14–K28, the Every release checklist and the Recovery entries`

Then run the gate and open a **draft** PR.

### PR body
- Summary, and **"Do not merge before v0.9.1 is tagged; merge only at RUNBOOK K20."**
- **No-self-triggering check (CLAUDE.md step 6):**
  - no new function and no trigger changed;
  - the lock refactor adds no loop, external call or write;
  - `maxInstances` is now literal on all 14;
  - no function reschedules or re-enqueues itself.
- The two sha256 values (the bundle changed).
- The gate output.
- No personal details.
- `🤖 Generated with [Claude Code](https://claude.com/claude-code)`.
- No `gh api` writes.

### Acceptance criteria covered
- **Billing-guards ACs:**
  - CPU/GPU quotas 0 and unused APIs disabled (K17 and K18, written);
  - RUNBOOK has "Billing was disabled".
- **SECURITY:** the "Before v1.0.0" checklist with evidence pointers and the five gates.
- **ADR-060 and the ADR-059 addendum** recorded. The RUNBOOK is complete for M8.
- **PRD:** the K19 sweep re-verifies R1–R12:
  - R7 by step 97;
  - R4 and R12 by the v0.9.0 clean weekday and the Scan-now proof;
  - R11 by the cap test.

### Risks (Session B)
- **A command in K14–K28 drifts from the plan or the spike:** every command is copied from `m8c-plan.md` §4 or `m8c-spike-results.md`, and the Opus · Max review diffs them.
- **PII scan:** no addresses in the docs. Members are written only as `$VAR`, and the budget publisher is named without its address.
- **Ticking an item without evidence:** only the five listed items are ticked at build.

### Gate (B1 after its handoff commit, before the push; B2 after its last commit, before the PR)
The same 7 steps as Session A, in each session:
1. `npm run check`
2. `npm run format:check`
3. `npm run test:rules`
4. `npm run build`
5. `npm run check:bundle`
6. `node scripts/smoke-functions-bundle.ts`
7. `npm run audit`

---

## After the build (not part of it)
- One **Opus · Max** review of the whole PR (code, tests, ADRs, RUNBOOK commands and IAM), then the fix commits, then the gate again.
- One **Opus · High** re-review of the fix commits only: `git diff <sha>...origin/feat/m8c2-hardening`, where `<sha>` is the PR head the Max review read.
- **Mon 19:** v0.9.1 (Part K K1–K13) and the Scan-now proof.
- **Sun 18:** C17 to C20.
- C47 within 24 h of K13.
- Phase 3 window: K14–K18.
- Phase 4: K19–K28.
- The follow-up docs PR.
- v1.0.1 arming after one full clean weekday on v1.0.0.

## Verification
- **Session A:**
  - the gate;
  - the source scan goes red on a deleted `maxInstances` (then restored), and the self-check stays green;
  - the lock tables pass, and the emulator lock tests pass unchanged;
  - the bundle sha256 differs from `main`'s.
- **Sessions B1 and B2:**
  - the gate in each (`scan:pii` covers the docs and the handoff);
  - B2's K numbers and Recovery titles match the handoff;
  - every K step has a command, a check and a rollback;
  - each SECURITY item names its evidence;
  - the plan, RUNBOOK and ADRs agree on 14 functions, K14–K28 and the five gates.
- **Live (after merge, from the RUNBOOK):**
  - C50 builds as the compute account with no Editor;
  - the K26 diff is exact;
  - K27 C14 is unchanged;
  - C35 shows `dry_run`.
