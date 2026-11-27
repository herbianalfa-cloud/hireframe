# v1.0.1 evidence (results only)

Redaction: no account IDs, no owner email, no `user:` lines, no budget email addresses; service accounts as `name@…`. Role lists and log tables only.

## G1.2 pre-flight, run 27 Nov 2026 (order change, plan section 4)

Branch `feat/v1-0-1-arming-plan-g1`, `origin/main` = `041788f`. Read-only; no prod access.

| # | Check | Result |
|---|---|---|
| 1 | `git log v1.0.0..origin/main` shows only the K28 docs PR | **Not yet checkable.** No `v1.0.0` tag on origin. Re-run after K28. |
| 2 | ADR-059 option-A addendum and ADR-060 on `main`; RUNBOOK Recovery entries "Billing was disabled" and "Rollback the Editor removal"; K14–K18 evidence copied | **Not yet checkable.** ADR-060 and both entries are not on `main` (they live on PR #41). Re-run after K28. |
| 3 | firebase-tools 15.34.1: `checkServiceAccountIam` called from `commands/deploy.js:83`; it throws without `iam.serviceAccounts.actAs` on `<project>@appspot…` (and only logs, then continues, if the IAM check itself errors); `cache/hash.js:11` hashes `environmentVariables`; `functions/env.js:179-190` loads `.env.<projectId>`, the alias file and the emulator file; `checkIam.js` `ensureServiceAgentRoles` returns early when there is no new event service | **Holds.** The emulator project is `demo-hireframe` (`scripts/dev.ts`), not the prod project. |
| 4 | `git diff 017d60c origin/main -- functions/src/billing functions/src/http/client.ts` | **Empty.** D10 needs no re-test from history. |
| 5 | Gate, build, smoke, `check:bundle`, `test:rules`, `audit` | All exit 0. Gate 2/2. Smoke: all 14 functions in europe-west2, `billingGuard` among them. Initial JS **298.2 kB gzip** (budget 300 kB: 1.8 kB of headroom). Audit: one high advisory, allowlisted (zod via `@google/clasp`). `functions/deploy/` holds no env file. |

## Finding: no real budget message is logged

The plan (G2.4, 1b item 9) says to take a fixture from "one real logged message". `billingGuard` never logs the message: `handler.ts` logs only `mode`, `cost` and `budget` (and `mode` alone for an invalid message). Neither `costIntervalStart`, the display name, the other payload fields nor the Pub/Sub attributes appear in Logging, so the log cannot supply the fixture or answer "does a budget ID exist". Decided by Beeb, 27 Nov: the first fixture is Google's documented example; a real message is captured with a temporary pull subscription in window A (step A7b); `budgetId` is read from the attributes and dropped before window B if the real message has none.
