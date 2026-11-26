# 8C2 evidence: Phase 3 (K14–K18), 24 Nov 2026

RUNBOOK Part K, Phase 3. Done by the owner in one window (17:00 WIB, 10:00 London), each command approved in chat. Role lists and tables only: no `user:` lines, no addresses except service accounts written `name@…`, the project number as `<NUM>`. The full outputs stayed in chat.

Baseline before the first change: System OK, Scan now Succeeded (11:02–11:04 London).

## K14: snapshot and reads
- `~/iam-before-p3.txt`: 34 lines (kept in Cloud Shell, not in the repo).
- C43, the deployer's roles: exactly 7: `cloudfunctions.developer`, `cloudscheduler.admin`, `datastore.indexAdmin`, `firebase.viewer`, `firebasehosting.admin`, `firebaserules.admin`, `serviceusage.serviceUsageConsumer`. No custom role left from K6b; no `eventarc.developer` (C38b was not needed).
- C51, the compute account: `roles/editor` only.
- C48, user-managed keys: six service accounts (the deployer, the billing guard, the compute account, the Firebase Admin SDK account, the App Engine default account, `hireframe-fns`), 0 keys each.
- Read A, principals holding `serviceusage.services.enable`: `roles/owner` (the owner account); `roles/editor` on the compute account (removed at K24), the Google APIs service agent and the App Engine default account; Google-managed service agents (`gcf-admin-robot`, Firebase management, Firebase mods). `github-deployer` does not hold it directly.
- Read B, who can act as the App Engine default account: `github-deployer` holds `roles/iam.serviceAccountUser` on it. The account is an Editor, so a deploy that runs as it could enable the Compute Engine API. The deployer is reachable only through GitHub OIDC from the protected repository, and a deploy needs the manual approval (Part C step 27). Settled at v1.0.1.

## K15: secrets (C34)
Five secrets (`ADZUNA_APP_ID`, `ADZUNA_APP_KEY`, `ANTHROPIC_API_KEY`, `INGEST_HMAC_SECRET`, `REED_API_KEY`). Each has exactly two bindings: `secretmanager.secretAccessor` for `hireframe-fns@…` and `secretmanager.viewer` for the deployer. No `allUsers` or `allAuthenticatedUsers`. The last `main` CI run (`a2bcd86`, 4 Nov) has a green `gitleaks` job (the job's scan step log was not opened; the job exits non-zero on a finding).

## K16: invoker audit (C49)
14 services. `allUsers`: `addfact`, `application`, `deletealldata`, `lookup`, `parsecv`, `rescore`, `resetprofile`, `scannow` (the 8 callables), plus `getdigest` and `ingestemailjobs`. `hireframe-fns@…`: `scheduledscan`, `generatecvs`, `purgeolddata`. The billing guard: `billingguard`. Nothing else.

## K17: unused APIs (C32, C33)
Proposed from the C32 list (54 enabled APIs), in the owner's order, each alone, no `--force`. Before `bigquery`: billing export off (FOCUS, standard, detailed, pricing and CUD all disabled), `bq ls` empty, log sinks only `_Required` and `_Default`.

| API | Result |
|---|---|
| `deploymentmanager` | refused: depended on by `firebaseextensions` |
| `analyticshub` | refused: depended on by `cloudapis` |
| `dataform` | refused: depended on by `cloudapis` |
| `dataplex` | refused: depended on by `cloudapis` |
| `bigquery` | refused: depended on by `bigquerystorage` and `cloudapis` |

No API was disabled and nothing changed, so no post-disable checks were due. The five stay enabled and carry to the v1.0.1 review (the blocker is the `cloudapis` umbrella service, which is on the never-disable list).

## K18: quotas (C53)
The Compute Engine API is not enabled (`gcloud compute project-info describe` answers "API [compute.googleapis.com] not enabled"), so C53 is not applicable. Residual risk accepted until v1.0.1 arms the kill switch (`dry_run` today). The wording and the principals that could enable the API are in the SECURITY checklist.

IAM diff, `~/iam-before-p3.txt` against `~/iam-after-p3.txt`: empty (`no IAM change`).
