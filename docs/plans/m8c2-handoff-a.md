# 8C2 session A handoff

Branch `feat/m8c2-hardening`, started from `main` at 3310a34.

## Head

- Code head (last commit before this file): `1680d2e`. This handoff is the commit on top of it; a file cannot hold its own commit SHA.
- Commits: `docs: add the 8C2 plan` (0938e5a), `chore: fold the scan lock stale rule into lockLiveUntil and isLockLive` (53e37a3), `feat: state maxInstances on every function` (1680d2e).

## Bundle sha256 (`functions/deploy/index.js`)

| Build | sha256 |
|---|---|
| `main` (3310a34, git worktree) | `d127d6d068d96f6512c49b9ba8dfe78f52771f031594ef9de5db2455a1384f76` |
| branch (1680d2e) | `764215d5595f868cd433f1c5e6bc1c9f6a7697b8114619f0e1431590248fe7dd` |

They differ, so v1.0.0 rebuilds every function. The `main` build used a worktree whose `node_modules` was linked to the repo's; `@hireframe/shared` resolves to the branch tree, but the branch changes nothing under `packages/shared`.

## EXPECTED table (as written in `functions/src/index.test.ts`)

| Function | trigger | timeoutSeconds | memoryMb | account |
|---|---|---|---|---|
| addFact | callable | 120 | 1024 | fns |
| application | callable | 120 | 1024 | fns |
| billingGuard | pubsub | 60 | 256 | guard |
| deleteAllData | callable | 120 | 512 | fns |
| generateCvs | schedule | 540 | 1024 | fns |
| getDigest | https | 60 | 512 | fns |
| ingestEmailJobs | https | 120 | 512 | fns |
| lookup | callable | 300 | 1024 | fns |
| parseCv | callable | 540 | 1024 | fns |
| purgeOldData | schedule | 300 | 512 | fns |
| rescore | callable | 540 | 1024 | fns |
| resetProfile | callable | 120 | 1024 | fns |
| scanNow | callable | 540 | 1024 | fns |
| scheduledScan | schedule | 540 | 1024 | fns |

Every global value (`serviceAccount`, `maxInstances`) was present in `__endpoint`; no stop condition was hit.

## Differences from the plan

1. **Branch.** `feat/m8c2-hardening` did not exist; it was created from `main`.
2. **`scheduledScan` timeout key.** `CALLABLE_TIMEOUT_SECONDS` has no `scheduledScan` row (it reads `scanNow`, 540). The plan's "equals `CALLABLE_TIMEOUT_SECONDS[name]`" and "`CALLABLE_TIMEOUT_SECONDS.<the exported const's name>`" cannot hold for it. The test has a one-entry `TIMEOUT_KEY` map (`scheduledScan` to `scanNow`) used by both the per-function check and the source scan. The shared table is unchanged.
3. **`limitProblems` return type.** It returns `{ problems: string[]; calls: number }`, not `string[]`, so the call count comes from the same walk.
4. **Extra self-check cases.** Beyond the plan's list: `maxInstances` from a constant, a timeout from a variable, options that are not an object literal, a trigger hidden in a wrapper (counted and flagged anonymous), and an `on*` import from outside `firebase-functions`.
5. **Drift guard wording.** The test counts `isLockLive(` at least 4 times in `store.ts` (one definition plus three call sites), which is the plan's "at least 3 outside its definition".
6. **Commit 1 amended once** before anything was pushed: a missing `type ScanLock` import. Tests passed without it because vitest does not typecheck.
7. **Comment on the new literals.** The comment sits above `maxInstances: 1` inside each options object, as in `application` and `deleteAllData`.
8. **Tests changed no timeouts or memory.** Each value was read from the source and matches the plan's 512/256 split.

## Not done, by design

No deploy, tag, gcloud command, `gh api` write or IAM change. `BILLING_GUARD_MODE` is unset. No PR (Session B2 opens it as a draft).
