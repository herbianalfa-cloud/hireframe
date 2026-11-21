# M8 PR 8C: billing guards, IAM, v1.0.0 (plan)

> **Note (8C2 planning):** `docs/plans/m8c2-plan.md` and RUNBOOK K14–K28 are authoritative for 8C2 and v1.0.0. Where they differ from §3 and §4 below, they win: there are **14** functions, not 15; the 8C2 branch is `feat/m8c2-hardening`; the K numbers run K14–K28; and the gate is the 7 steps `check`, `format:check`, `test:rules`, `build`, `check:bundle`, `smoke-functions-bundle`, `audit`.

## Context
- v0.9.0 (8B) is live. 8C finishes M8 and releases **v1.0.0**. ADR-059 and ADR-060 are reserved for it.
- Scope comes from `m8-plan.md` §8C and `m8-billing-guards.md`:
  - the kill switch, **dry run only** (never a real billing disable in prod);
  - the instance and timeout audit, the time-dependent tests and the client read loops;
  - a build account, and Editor removed from the default compute account;
  - the SECURITY checklist, the RUNBOOK completed, v1.0.0.
- The v1.0.0 gates outside the code go in the release checklist, and **no tag is planned before they pass**:
  - RUNBOOK step 97 (phone speed test);
  - the restore drill C17–C20 (after the first backup, Sun 18 Oct);
  - one clean weekday on v0.9.0.

**What I checked in the code, and how it changes the m8-plan 8C section.** All of this is from `node_modules/firebase-tools` 15.32.1 and the repo.
1. **The first deploy of a Pub/Sub function is a new trap.** `checkIam.js:139-160` `ensureServiceAgentRoles`:
   - When no event-triggered function exists yet (true today), the CLI requires these project bindings:
     - `roles/run.invoker` and `roles/eventarc.eventReceiver` for `<NUM>-compute@developer.gserviceaccount.com`;
     - `roles/iam.serviceAccountTokenCreator` for `service-<NUM>@gcp-sa-pubsub.iam.gserviceaccount.com`.
   - If a binding is missing, the CLI calls `setIamPolicy`. The deployer can't, so the deploy throws "We failed to modify the IAM policy for the project" **in prepare, before anything deploys**.
   - Fix: a temporary pre-grant, removed straight after the deploy (the step 91 pattern).
   - The check runs only while no event function exists, so later deploys skip it.
2. **The trigger's service account is settled by the code.** `gcp/cloudfunctionsv2.js:221-222` sets `eventTrigger.serviceAccountEmail` from the function's `serviceAccount`. The spike no longer needs to prove this. C14b still checks it live.
3. **Event functions get no invoker from the CLI.** `fabricator.js` sets an invoker only for HTTPS, callable, task-queue, blocking and scheduled functions.
   - So `billingGuard` hits none of the three known invoker traps.
   - But it needs C38 (the trigger account's `run.invoker`) by hand.
4. **A `defineString` param breaks CI deploys.** `params.js:186` throws on a non-interactive deploy when a param has no dotenv value, even with a default.
   - So the mode is a plain env var: unset means dry run.
   - Prod never sets it in 8C. The throwaway sets it with `gcloud --set-env-vars`.
5. **Re-running a deploy job doesn't rebuild anything.** The planner skips functions whose hash is unchanged (`planner.js:25-30`), and `FUNCTIONS_DEPLOY_UNCHANGED` appears only in a message.
   - The m8-plan's "proving deploy = re-run the deploy job" would build nothing.
   - **A proving deploy must change the functions bundle.**
6. **Path D (a dedicated build account) doesn't work with the Firebase CLI.**
   - firebase-tools sends no `buildConfig.serviceAccount`, so every new function is built by the default (compute) account.
   - Path D would also break the first build of every future function.
   - **Decided: Path F.** No Q1/Q2 spike; Path F is rehearsed in the throwaway project instead.

**Decisions (plan review, 15 Oct)**
1. Path F directly.
2. No billing role in prod while in dry run. C37b moves to arming.
3. The mode is a plain env var. C35 checks that `BILLING_GUARD_MODE` is absent.
4. v0.9.0 deployed Thu 15 Oct. The clean weekday on v0.9.0 is Fri 16 Oct.
5. New v1.0.0 gate: one clean weekday on v0.9.1.
6. Lighthouse accessibility on Pipeline (100) and the 360 px phone check were recorded in 8A2. K17 only references them.
7. The spike runs from the laptop's gcloud, in a dedicated `guard-test` configuration.

## 1. Shape: two PRs

| PR | Branch | Tag | What |
|---|---|---|---|
| **8C1** | `feat/m8c1-billing-guard` | **v0.9.1** | `billingGuard` (dry run), ADR-059, time-dependent tests (C4), client read counter (C5), the CLAUDE.md working-method step |
| **8C2** | `feat/m8c2-hardening` | **v1.0.0** | Explicit `maxInstances` everywhere plus the table and source tests (C2), ADR-060 (Path F), SECURITY checklist, RUNBOOK complete, ROADMAP, CHANGELOG 1.0.0 |

**Why split:**
- **One risky infra change per release.**
  - v0.9.1 carries the first event function, with new service accounts and a CLI IAM step.
  - v1.0.0 carries only the Editor removal.
  - If a deploy fails, the cause is never in doubt and the rollback is small.
- **The evidence exists before the checklist is ticked.** The dry run (C35), a real budget message parsed (C47) and the throwaway kill test (C30) are live by the time 8C2 is written. In one PR they could only be ticked after their own release.
- **v1.0.0 needs a bundle change to prove the build account** (finding 5). C2 is that change: it adds the same `maxInstances: 1` values as literals, so it changes no behaviour but rebuilds every function under the new IAM.
- **The gates don't block the risky work.** 8C1 ships on Mon 19; v1.0.0 waits only for the gates.

**Timeline (London):**
- Thu 15 to Fri 16: build 8C1. Fri 16 is the clean weekday on v0.9.0.
- Sat 17: the throwaway spike.
- Sun 18: C17 to C20 (backup READY, then the restore drill).
- Mon 19, 10:00–16:00: v0.9.1. The 8C2 build starts the same day.
- Tue 20: the clean weekday on v0.9.1.
- v1.0.0 after every gate, on a weekday between 10:00 and 16:00. Never Sun 25 Oct.

---

## 2. PR 8C1: `billingGuard`, tests, read counter (v0.9.1)

### Files
- `functions/src/billing/schema.ts`: zod schema for the budget message.
  - `budgetDisplayName`, `costAmount`, `budgetAmount`, `currencyCode`, `costIntervalStart`; optional `alertThresholdExceeded` and `forecastThresholdExceeded`; other fields passed through.
  - The data is base64-decoded from `event.data.message`.
- `functions/src/billing/decide.ts` (pure): `decideGuard(message, mode)` returns one of `below`, `ignored` (wrong budget or currency), `would_disable` or `disable`.
  - It acts only when the name is `hireframe-kill`, the currency is GBP and `costAmount >= budgetAmount`.
  - Forecast fields are ignored.
- `functions/src/billing/client.ts`: the metadata server (project ID and token) and Cloud Billing `GET`/`PUT projects/{id}/billingInfo`.
  - Reuse `createHttpClient` (`functions/src/http/client.ts`, policy `api-terms`): timeout, 3 attempts with backoff, zod. Extend its `RequestOptions` minimally if it can't send PUT, a body and headers.
  - The target project is **always the runtime project from the metadata server, never a literal**. So the throwaway test can't touch prod.
- `functions/src/billing/handler.ts`: `runGuard(deps)`.
  - Parse, decide, then:
    - **dry run makes no network call at all**;
    - armed reads `billingInfo`, logs `already_disabled` if billing is already off, otherwise PUTs `{billingAccountName: ""}` once.
  - Logs: `billing_guard.below`, `.ignored`, `.invalid`, `.would_disable`, `.disabled`, `.already_disabled`, `.failed`. Each carries `mode`, codes and amounts only.
- `functions/src/billing/endpoint.ts`: `onMessagePublished` with these options:
  - topic `billing-guard`, `serviceAccount: BILLING_GUARD.serviceAccount`;
  - `maxInstances: 1`, `timeoutSeconds: 60`, `memory: '256MiB'`, `retry: false`;
  - no secrets.
- `functions/src/config.ts`:
  - `BILLING_GUARD` = `{ topic, budgetDisplayName: 'hireframe-kill', currency: 'GBP', serviceAccount: 'hireframe-billing-guard@hireframe-f6b03.iam.gserviceaccount.com', requestTimeoutMs, deadlineMs }`;
  - `guardMode(env)`: only the exact string `armed` arms; anything else is `dry_run`.
- `functions/src/index.ts`: export it. `packages/shared/src/callables.ts`: `billingGuard: 60` in the timeout table.
- **C4:** fake-clock tests that fill gaps, one per m8-plan C4 item. The PR body lists each item with its test file.
- **C5:** `web/src/services/read-counter.ts`, dev only behind `import.meta.env.DEV`. It is wired into the services' snapshot and get helpers and warns above 200 document reads a minute. Also audit every effect-held listener and every `refetchInterval`.
- **CLAUDE.md:** the working-method step "Before every PR, check the diff against the no-self-triggering rule…" (decision 6).
- **Docs:**
  - ADR-059;
  - ARCHITECTURE (functions table, the `billingGuard` row);
  - SECURITY (a "Billing" threat row);
  - RUNBOOK Part K, steps K1 to K13 below;
  - RUNBOOK Recovery: **"`billingGuard` logs nothing after a publish"**. This is the Pub/Sub push token. Grant the resource-level `tokenCreator` (K12 fallback), then publish below the threshold again;
  - CHANGELOG 0.9.1 (also date the `[0.9.0]` heading, which still says Unreleased).

### Tests
- `billing/decide.test.ts`:
  - below, at (equal), above;
  - the wrong name; the wrong currency;
  - forecast-only (`forecastThresholdExceeded` set, cost below);
  - malformed base64 or JSON, missing fields, NaN or negative amounts, extra fields tolerated.
- `config.test.ts` (`guardMode`): unset, `armed`, `ARMED`, ` armed` and `true`. Only `armed` arms.
- `billing/handler.test.ts` (fake client, fake clock):
  - dry run makes **zero fetches** at or above the threshold;
  - armed PUTs exactly once, on `projects/<metadata project>`;
  - already disabled leads to no PUT;
  - a 403 leads to `failed` with code `permission_denied`;
  - 5xx is retried 3 times, then `failed`;
  - a timeout and the deadline;
  - logs carry no message text.
- **The dry-run wiring test:** call the exported `billingGuard(cloudEvent)` itself (not `.run`, which skips the Pub/Sub wrapper) with a base64 message at the threshold and env unset. It must log `would_disable` and never call `fetch`. A second case sends an attributes-only message (no `data`): it logs `invalid`, resolves and makes no request.
- `index.test.ts` for `billingGuard`'s `__endpoint`:
  - the Pub/Sub `messagePublished` event type, topic `billing-guard`;
  - `retry` false;
  - `serviceAccountEmail` is `hireframe-billing-guard@…`;
  - 1 instance, 60 s, 256 MiB, no secrets;
  - no HTTPS or callable trigger.
- **The no-self-trigger source guard:** `billing/*.ts` has no `firebase-admin`, `getFirestore`, `publish(`, `PubSub`, `httpsCallable`, `setTimeout` re-enqueue or `CloudTasks`.
- **Rules:** no rules change. `npm run test:rules` runs unchanged in the gate.
- **The C5 counter:** it warns at 201 reads, not at 200, and `check:bundle` greps that the warning string isn't in `web/dist`.

### What 8C1 closes
- **Billing-guards ACs:**
  - "the kill switch removes billing in a test project" (C30);
  - fake-clock tests for every time-logic item (§5);
  - the CLAUDE.md rule (the PLAYBOOK change is the owner's).
- **SECURITY:** the new Billing row; the evidence for the 8C2 checklist (C30, C35, C47).
- **PRD:** no R-criterion changes. It supports the "Cost per scanned job: monthly cap enforced" metric, alongside R11.

### ADR-059 outline: billing kill switch
- **Pattern:**
  - the `hireframe-kill` budget (£25, actual cost, this project only) publishes to the `billing-guard` topic;
  - `billingGuard` runs as `hireframe-billing-guard`, with no secrets and no Firestore access;
  - 1 instance, 60 s, no retry.
- **Decision rule** as in `decide.ts`. Forecast is ignored. The target is the metadata project (read from the documented plain-text leaf `project/project-id`).
- **Mode:** the env var `BILLING_GUARD_MODE`. Unset means dry run. Why not a param: finding 4.
- **Prod holds no billing role while in dry run** (change from m8-plan C37b). Belt and braces: even a mode bug can't disable billing.
- **Arming (later, separately approved, v1.0.1):**
  - grant `billing.projectManager` (C37b);
  - the build writes `functions/deploy/.env` with `armed`;
  - only if the throwaway proved `projectManager` is enough; otherwise it moves to the parking lot.
  - **Arming check (ADR-059):** once armed, anyone who can publish to `billing-guard` can trip the kill with a forged message, because the guard can't authenticate messages. Before arming, `gcloud pubsub topics get-iam-policy billing-guard --project=$P` must show only the budget publisher, and the project Owners and Editors (the compute account keeps Editor until v1.0.0) are accepted as publishers until 8C2 removes Editor.
- **The lag statement:**
  - budget notifications lag spend by hours, so this is a backstop;
  - the real limits are `llm.call()` caps and leases, `maxInstances: 1`, the locks and the card's limit.
- **Budget messages arrive several times a day**, so roughly 1,500 invocations a month, inside the free tier.
- **Hard rule:** the trigger is a message the function can't cause. It publishes and writes nothing.
- **First-deploy service-agent bindings:** temporary and removed (finding 1).
- **Push delivery after the removal:** if removing the Pub/Sub service agent's project-level `tokenCreator` stops push delivery, the fallback grants it on `hireframe-billing-guard` only (resource level, K12). The ADR records which one is live.
- **Consequences when armed:** every paid service stops; Google warns resources may be deleted; the backups are in the project (accepted risk, ADR-058). Recovery: RUNBOOK "Billing was disabled".

---

## 3. PR 8C2: instance audit, Path F, checklist, v1.0.0

### Files
- **C2:**
  - Add a literal `maxInstances: 1` to the 7 call sites that only inherit it: `parseCv`, `addFact`, `resetProfile`, `rescore`, `lookup`, `scanNow`, `scheduledScan`.
  - `setGlobalOptions` stays.
  - Callables stay at 1, recorded in ADR-060's "instance audit" note.
- **Scan and wipe locks (review item 12, moved from 8C1):** `scan/store.ts:67-69`, `:86-89` and `:140-143` hold three copies of the stale-lock rule.
  - Add `export function lockLiveUntil(lock): Date | undefined`: undefined unless the lock has a `runId` and a `startedAt`, otherwise `staleAt ?? startedAt + SCAN.lockStaleMs`.
  - Add `isLockLive(lock, now)` on top of it and use it at all three sites.
  - Point the `store.test.ts` boundary table (±1 ms) at `isLockLive`, and keep the `liveLockHolder` cases. Today only `liveLockHolder` has ±1 ms tests; `acquireLock` and `acquireOrRefreshWipe` are tested only at ±1–2 minutes in the emulator.
- `functions/src/index.test.ts`: one table test over every export:
  - `maxInstances` 1, `timeoutSeconds` and `availableMemoryMb` present;
  - scheduled functions have `retryCount: 0`, event functions `retry` false;
  - `serviceAccountEmail` is `hireframe-fns@…`, except `billingGuard`.
  - A source scan fails if any `onCall`, `onRequest`, `onSchedule` or `onMessagePublished` options object in `functions/src` (tests and `loadtest/` excluded) lacks a literal `maxInstances`.
- **Docs:**
  - ADR-060 and an ADR-017 addendum;
  - SECURITY: the checklist "Before v1.0.0", ticked with evidence;
  - RUNBOOK:
    - Part K finished (K14 to K28);
    - a single **"Every release"** checklist: step 77, invokers for new functions per type, the C3 list, indexes Enabled, C14 on new functions, step 89/97, the release window, nothing Generating, and "a proving deploy needs a bundle change";
    - Recovery: **"Billing was disabled"**, **"Project suspended (card declined)"**, **"Rollback the Editor removal"** (C40) and **"First Pub/Sub function: the CLI's IAM step"**;
  - ARCHITECTURE (Environments: the build account);
  - ROADMAP: M8 done; parking lot: arming if needed, and the App Engine account's Editor;
  - CHANGELOG 1.0.0;
  - `.gitignore`: `iam-*.json`, `iam-*.txt`.

### Tests
- The table test and the source scan above.
- The existing `index.test.ts` and `smoke-functions-bundle.ts` keep the region and lazy-chunk checks.
- No rules change; `test:rules` runs in the gate.

### What 8C2 closes
- **Billing-guards ACs:**
  - CPU and GPU quotas are 0, and unused APIs are disabled (K15, K16);
  - a test fails when a function has no `maxInstances`;
  - RUNBOOK has "Billing was disabled".
- **SECURITY "Before v1.0.0" checklist, each item with its evidence:**
  - secrets in Secret Manager and gitleaks clean (C34);
  - no user-managed SA keys (C48);
  - the public invoker audit (C49);
  - the IAM snapshot reviewed and diffed (K25);
  - Editor removed and the proving deploy green (C39, C50);
  - deployer roles equal the 9 Oct baseline (C43);
  - the kill switch tested in the throwaway (C30); dry run on prod (C35); a real budget message parsed (C47);
  - budgets £2, £5 and £10 (actual and forecast) plus `hireframe-kill` (owner);
  - virtual card £50, passkey, recovery checked (owner);
  - quotas 0 (C53); APIs (C33);
  - the restore drill (C18–C20); the wipe tested (emulator plus the load test);
  - the audit allowlist (8A); the `maxInstances` test;
  - no self-triggering functions (review); `gcloud auth revoke` (C41).
- **PRD:** the v1.0.0 release checklist re-verifies R1 to R12 with evidence pointers:
  - R7 by step 97, the Lighthouse runs (Pipeline ≥ 95 included) and the 360 px check;
  - R4 and R12 by the clean weekday;
  - R11 by the existing cap test.

### ADR-060 outline: build account, Path F
- **Context:** Editor on the compute account; finding 6 (no build-account field in firebase-tools 15.32.1; new functions build as the default account).
- **Decision:** the compute account becomes **build-only**.
  - Editor is removed.
  - It gets `logging.logWriter` (project), `artifactregistry.writer` on `gcf-artifacts`, and `storage.objectViewer` on the `gcf-v2-*` buckets (conditional or per bucket, whichever the throwaway proved).
  - **Nothing runs as it:**
    - every function sets `serviceAccount` (the test);
    - every scheduler job uses `hireframe-fns` (C3);
    - no Eventarc trigger uses it (C39a).
- **The deployer keeps `serviceAccountUser` on it**, because it's needed to act as the build account. ROADMAP's "drop it" is not possible, and the ADR says why.
- **Proof:** the v1.0.0 deploy rebuilds every function (the C2 bundle change). A re-run would skip unchanged functions (finding 5). Rollback C40.
- **Revisit** when firebase-tools supports a build service account. The App Engine default account's Editor is parked.

---

## 4. Manual steps, in order (exact commands, a check and a rollback each)
Every command is shown in chat and approved before it runs. Shell setup for each Cloud Shell session:
```bash
P=hireframe-f6b03; R=europe-west2
NUM=$(gcloud projects describe $P --format='value(projectNumber)')
SA=github-deployer@$P.iam.gserviceaccount.com
FNS=hireframe-fns@$P.iam.gserviceaccount.com
GUARD=hireframe-billing-guard@$P.iam.gserviceaccount.com
COMPUTE=$NUM-compute@developer.gserviceaccount.com
PSA=service-$NUM@gcp-sa-pubsub.iam.gserviceaccount.com
flat() { gcloud projects get-iam-policy $P --flatten='bindings[].members' --format='value(bindings.role,bindings.members)' | sort; }
```

### Phase 0: reads (any time, Cloud Shell)
- **C43 Deployer roles.**
  - Command: `gcloud projects get-iam-policy $P --flatten='bindings[].members' --filter="bindings.members:serviceAccount:$SA" --format='value(bindings.role)' | sort`
  - Check: exactly the 7 baseline roles.
  - Then `for A in $FNS $P@appspot.gserviceaccount.com $COMPUTE; do gcloud iam service-accounts get-iam-policy $A --project=$P --format='value(bindings.role,bindings.members)'; done`. Check: `serviceAccountUser` for `$SA` on each.
- **C44 APIs.**
  - Command: `gcloud services list --enabled --project=$P --format='value(config.name)' | grep -E '^(pubsub|eventarc|cloudbilling|run|cloudbuild|artifactregistry|compute)\.googleapis\.com$'`
  - Check: 7 lines.
  - If `pubsub` is missing, enable it with `gcloud services enable pubsub.googleapis.com --project=$P` (approve first; rollback `disable`).
- **C51 Compute account roles.**
  - Command: `gcloud projects get-iam-policy $P --flatten='bindings[].members' --filter="bindings.members:serviceAccount:$COMPUTE" --format='value(bindings.role)'`
  - Check: today `roles/editor`. Record anything else.
- **C48 Keys.**
  - Command: `for A in $(gcloud iam service-accounts list --project=$P --format='value(email)'); do echo "$A $(gcloud iam service-accounts keys list --iam-account=$A --managed-by=user --project=$P --format='value(name)' | wc -l)"; done`
  - Check: 0 for each.

### Phase 1: throwaway spike (Sat 17; local laptop on the 8C1 branch after `npm run build`)
- **What it proves:** the spike deploys with **gcloud**, not the Firebase CLI. So it proves the Path F build roles, quota 0 and the kill switch. **It doesn't prove the firebase-tools IAM step** (finding 1); K6 and K7 cover that in prod.
- **Variables:** set `T=hireframe-guard-test-<4 digits>`, `TNUM`, `TCOMPUTE`, `TGUARD=hireframe-billing-guard@$T.iam.gserviceaccount.com`.
- **Every command carries `--project=$T`**, and it runs in its own gcloud configuration.
- **Order:** the build rehearsal first, the kill test last, because billing is gone after it.

| Step | Command | Check | Rollback |
|---|---|---|---|
| C20d (config) | `gcloud config configurations create guard-test && gcloud config set account "$(gcloud config get-value account --configuration=default)"` | `gcloud config configurations list` → `guard-test` active | C31b |
| C21 | `gcloud projects create $T && gcloud config set project $T` | `gcloud projects describe $T --format='value(lifecycleState)'` → ACTIVE; `gcloud config get-value project` → `$T` | C31 |
| C22 | `gcloud billing accounts list` (read) | note `<BILLING_ID>` | — |
| C23 | `gcloud billing projects link $T --billing-account=<BILLING_ID>` | C30 prints `True` | `gcloud billing projects unlink $T` |
| C24 | `gcloud services enable compute.googleapis.com cloudfunctions.googleapis.com run.googleapis.com cloudbuild.googleapis.com artifactregistry.googleapis.com pubsub.googleapis.com eventarc.googleapis.com cloudbilling.googleapis.com --project=$T` | `services list --enabled` shows 8 | C31 |
| C24a | `gcloud artifacts repositories create gcf-artifacts --repository-format=docker --location=$R --project=$T` | `artifacts repositories describe` | C31 |
| C24b (Path F rehearsal) | `remove-iam-policy-binding $T --member=serviceAccount:$TCOMPUTE --role=roles/editor --condition=None` (if C51-style read shows it); then logWriter (project), `artifacts repositories add-iam-policy-binding gcf-artifacts … artifactregistry.writer`, and `storage.objectViewer --condition='expression=resource.name.startsWith("projects/_/buckets/gcf-v2-"),title=gcf-sources'` | C51-style read shows exactly those | C31 |
| C24c (quotas, console) | Quotas: **Compute Engine API, CPUs (all regions) = 0, GPUs (all regions) = 0** | `gcloud compute project-info describe --project=$T --flatten=quotas --format='value(quotas.metric,quotas.limit)' \| grep -E '^(CPUS_ALL_REGIONS\|GPUS_ALL_REGIONS)\s'` → 0 (`compute project-info describe` rejects `--filter`; a new project starts at 0 and the console refuses an equal value, spike 2026-10-17) | C31 |
| C25 | `gcloud iam service-accounts create hireframe-billing-guard --project=$T` | `describe` | C31 |
| C26 | `gcloud projects add-iam-policy-binding $T --member=serviceAccount:$TGUARD --role=roles/billing.projectManager --condition=None`, then the same with `--role=roles/browser` (`billing.projectManager` alone fails the `billingInfo` read with `permission_denied`: it needs `resourcemanager.projects.get`; spike 6; the prod guard needs both, see `m8c-spike-results.md`) | read | C31 |
| C27 | `gcloud pubsub topics create billing-guard --project=$T` | `topics describe` | C31 |
| C27b (bundle, read) | `node -p "const p=require('./functions/deploy/package.json'); [p.main, p.type, p.engines.node, Object.keys(p.dependencies).sort().join(',')].join(' ')" && test -f functions/deploy/index.js && echo index.js present` | `index.js module 22 firebase-admin,firebase-functions` and `index.js present`. Otherwise run `npm run build` again (not the dev build) | — |
| C28 | `gcloud functions deploy billingGuard --gen2 --project=$T --region=$R --runtime=nodejs22 --source=functions/deploy --entry-point=billingGuard --trigger-topic=billing-guard --trigger-service-account=$TGUARD --service-account=$TGUARD --set-env-vars=BILLING_GUARD_MODE=armed,FUNCTION_SIGNATURE_TYPE=cloudevent --max-instances=1 --timeout=60s --memory=256Mi` (spike only: a gcloud deploy needs `FUNCTION_SIGNATURE_TYPE=cloudevent`, which firebase-tools sets itself, else "Malformed Pub/Sub event"; gcloud warns about `cloudbuild.builds.builder`, answer the continue prompt **without** granting it) | build SUCCESS: `gcloud builds list --region=$R --project=$T --limit=1 --format='value(status,serviceAccount)'` → SUCCESS, `$TCOMPUTE`. **This proves Path F roles and quota 0 don't block builds.** If the storage condition fails (403 on `gcf-v2-*`), grant per bucket and redeploy; record which one worked | C31 |
| C28a | `gcloud functions add-invoker-policy-binding billingGuard --region=$R --member=serviceAccount:$TGUARD --project=$T` | C14b with `--project=$T` | C31 |
| C29a | Wait 2 minutes after C28a (invoker propagation: the first deliveries got 403 for about 1 minute), then `gcloud pubsub topics publish billing-guard --project=$T --message='{"budgetDisplayName":"hireframe-kill","costAmount":1,"budgetAmount":25,"currencyCode":"GBP","costIntervalStart":"2026-10-01T00:00:00Z"}'` | `gcloud logging read 'resource.type="cloud_run_revision" AND resource.labels.service_name="billingguard"' --project=$T --freshness=10m --limit=10 --format='table(timestamp,severity,jsonPayload.event,jsonPayload.mode,jsonPayload.step,jsonPayload.code)'` → `billing_guard.below`, `mode: armed`. This is also the first real use of the project-id leaf (`step: project` would show in `jsonPayload.step`) | — |
| C29b | the same with `"costAmount":30` | the same logging read → `billing_guard.disabled` | — |
| C30 | `gcloud billing projects describe $T --format='value(billingEnabled)'` | **`False`**. If `failed: permission_denied`: `projectManager` isn't enough, so arming leaves M8 (decision 2) | — |
| C31 | `gcloud projects delete $T` | `describe` → DELETE_REQUESTED | — |
| C31b (config) | `gcloud config configurations activate default && gcloud config configurations delete guard-test` | `gcloud config configurations list` → only `default`, active; `gcloud config get-value project` → `hireframe-f6b03` | — |

### Phase 2: v0.9.1 (Mon 19 Oct, 10:00–16:00, nothing Generating; after Fri 16 was clean on v0.9.0 and the spike passed)

**K1. Step 77 and the scheduler list (C1, C2, C3).**
- Repeat Part G step 77 (C1, C2) and the C3 line of Part J step 101.
- Check:
  - C1: `30 7,17 * * 1-5`, `Europe/London`, `hireframe-fns@…`;
  - C2: only `hireframe-fns`;
  - C3: three jobs, all ENABLED.
- Fix: the existing Recovery entries.

**K2. Snapshot.**
- Command: `cd ~ && flat > ~/iam-before-091.txt && wc -l ~/iam-before-091.txt`, plus C43. Paste the role list, not the file.

**K3 (C36). Create the topic.**
- Command: `gcloud pubsub topics create billing-guard --project=$P`
- Check: `gcloud pubsub topics describe billing-guard --project=$P --format='value(name)'`
- Rollback: `gcloud pubsub topics delete billing-guard --project=$P`

**K4 (C37). Create the guard's service account.**
- Command: `gcloud iam service-accounts create hireframe-billing-guard --display-name="Hireframe billing guard" --project=$P`
- Check: `gcloud iam service-accounts describe $GUARD --project=$P --format='value(email,disabled)'`
- Rollback: `gcloud iam service-accounts delete $GUARD --project=$P`
- **No billing role now** (C37b moves to arming).

**K5 (C37c). Let the deployer act as it.**
- Command: `gcloud iam service-accounts add-iam-policy-binding $GUARD --member=serviceAccount:$SA --role=roles/iam.serviceAccountUser --project=$P`
- Check: `gcloud iam service-accounts get-iam-policy $GUARD --project=$P --format='value(bindings.role,bindings.members)'` shows only that line.
- Rollback: the same command with `remove-iam-policy-binding`.

**K6 (C45). Temporary pre-grant for the CLI's first Pub/Sub deploy (finding 1).**
- First read:
  `flat | grep -E "^roles/(run.invoker|eventarc.eventReceiver)\s+serviceAccount:$COMPUTE|^roles/iam.serviceAccountTokenCreator\s+serviceAccount:$PSA"`
- Then grant only the missing ones:
  ```bash
  gcloud projects add-iam-policy-binding $P --member=serviceAccount:$COMPUTE --role=roles/run.invoker --condition=None
  gcloud projects add-iam-policy-binding $P --member=serviceAccount:$COMPUTE --role=roles/eventarc.eventReceiver --condition=None
  gcloud projects add-iam-policy-binding $P --member=serviceAccount:$PSA --role=roles/iam.serviceAccountTokenCreator --condition=None
  ```
  If `$PSA` "does not exist": `gcloud beta services identity create --service=pubsub.googleapis.com --project=$P`, then retry.
- Check: the read prints 3 lines.
- Rollback: K9.

**K7 (C4). Tag v0.9.1.** Merge 8C1, then run `git checkout main && git pull && git log -1`. The log must show the PR's merge commit. Only then run `git tag v0.9.1 && git push origin v0.9.1`, then approve.
- Check: the log shows `functions[billingGuard(europe-west2)] Successful create operation` and no "We failed to modify the IAM policy".
- If prepare fails with that message: nothing was deployed. Grant only the bindings the CLI printed (shown in chat first), then **Re-run failed jobs**.
- If the create fails on an Eventarc permission: C38b, `gcloud projects add-iam-policy-binding $P --member=serviceAccount:$SA --role=roles/eventarc.developer --condition=None`. It stays, because later updates need it too, and it's recorded in ADR-059. Then re-run.
- Rollback: none needed for safety (no billing role). To remove the function, revert the export in a PR and release a patch.

**K8 (C38). Bind the trigger account as invoker.**
- Command: `gcloud functions add-invoker-policy-binding billingGuard --region=$R --member=serviceAccount:$GUARD --project=$P`
- Check (C46): `gcloud run services get-iam-policy billingguard --region=$R --project=$P --flatten='bindings[].members' --filter='bindings.role:roles/run.invoker' --format='value(bindings.members)'` prints **only** `serviceAccount:hireframe-billing-guard@…`.
- Rollback: `gcloud functions remove-invoker-policy-binding billingGuard --region=$R --member=serviceAccount:$GUARD --project=$P`.

**K9 (C45r). Remove the K6 grants.**
- The same three commands with `remove-iam-policy-binding`, only for the ones K6 added.
- Check:
  - `cd ~ && flat > ~/iam-after-091.txt && diff ~/iam-before-091.txt ~/iam-after-091.txt` prints nothing, or only `roles/eventarc.developer serviceAccount:$SA` if K7 needed C38b (record it);
  - a `roles/pubsub.serviceAgent serviceAccount:$PSA` line, if K6 created the agent, is Google's own binding: record it and never remove it;
  - any other line: stop;
  - C43 again shows 7 roles (or 8 with C38b, recorded).

**K10. Checks on `billingGuard` (C14b, C39a, C39b).**
- C14b must show `1 60 256Mi hireframe-billing-guard@… hireframe-billing-guard@… projects/hireframe-f6b03/topics/billing-guard RETRY_POLICY_DO_NOT_RETRY`.
- C39a and C39b:
  ```bash
  for L in $R global; do gcloud eventarc triggers list --location=$L --project=$P --format='table(name,serviceAccount,destination.cloudRun.service,transport.pubsub.topic)'; done
  gcloud functions list --regions=$R --project=$P --format='table(name,serviceConfig.serviceAccountEmail,eventTrigger.serviceAccountEmail)'
  ```
  - No row shows `$COMPUTE`.
  - The `billingguard` trigger shows `hireframe-billing-guard@…`.
  - Every function shows `hireframe-fns@…`, except `billingGuard`.

**K11. Step 77 again (C1, C2, C3).** The bundle changed, so the deploy rewrote the invokers.

**K12 (C35). Dry run.**
- Read: `gcloud functions describe billingGuard --region=$R --gen2 --project=$P --format='value(serviceConfig.environmentVariables)'` must **not** contain `BILLING_GUARD_MODE`.
- Below the threshold: publish `costAmount 1` (C29a's message, `--project=$P`). **Within 2 minutes** the logs (`gcloud logging read 'resource.type="cloud_run_revision" AND resource.labels.service_name="billingguard"' --project=$P --freshness=10m --limit=10 --format='table(timestamp,severity,jsonPayload.event,jsonPayload.mode,jsonPayload.step,jsonPayload.code)'`; the plain `functions logs read` doesn't print `mode`) must show `billing_guard.below`, `mode: dry_run`.
- **Only after that line shows `dry_run`**, at the threshold: publish `costAmount 30`. **Within 2 minutes:** `billing_guard.would_disable`.
- Check: `gcloud billing projects describe $P --format='value(billingEnabled)'` → `True`.
- **No log line within 2 minutes of a publish:** push delivery is broken, most likely by K9 removing the Pub/Sub agent's project-level `tokenCreator`.
  - Fallback (resource level, shown in chat first): `gcloud iam service-accounts add-iam-policy-binding $GUARD --member=serviceAccount:$PSA --role=roles/iam.serviceAccountTokenCreator --project=$P`.
  - Check: `gcloud iam service-accounts get-iam-policy $GUARD --project=$P --format='value(bindings.role,bindings.members)'` shows it beside the deployer's `serviceAccountUser`. Then publish below the threshold again and expect the log within 2 minutes.
  - The K9 project diff is unchanged by this fallback, because the grant is resource level.
  - Rollback: the same command with `remove-iam-policy-binding`.
- Rollback for the dry run itself: none needed. Prod has no billing role, so it can't disable.

**K13 (owner, console). Budgets.**
- Billing → Budgets & alerts:
  - £2, £5 and £10 at 100%, actual and forecast, emails on;
  - `hireframe-kill` £25, scope this project, connected to topic `projects/hireframe-f6b03/topics/billing-guard`.
- Check C47: within 24 h the logs (`gcloud logging read 'resource.type="cloud_run_revision" AND resource.labels.service_name="billingguard"' --project=$P --freshness=1d --limit=10 --format='table(timestamp,severity,jsonPayload.event,jsonPayload.mode,jsonPayload.step,jsonPayload.code)'`) show a real message as `billing_guard.below` (never `.invalid`). An `.invalid` is fixed in 8C2.
- Rollback: delete the budget.

### Phase 3: stolen-account guards (a separate weekday window before v1.0.0, each approved alone)

**K14. Secrets and invokers (C34, C49).**
- C34: `gcloud secrets list --project=$P --format='value(name)'`, then `gcloud secrets get-iam-policy <name> --project=$P` for each.
- C49:
  ```bash
  for S in $(gcloud run services list --region=$R --project=$P --format='value(metadata.name)'); do echo "$S: $(gcloud run services get-iam-policy $S --region=$R --project=$P --flatten='bindings[].members' --filter='bindings.role:roles/run.invoker' --format='value(bindings.members)' | tr '\n' ' ')"; done
  ```
  Check: `allUsers` only on the 8 callables plus `ingestemailjobs` and `getdigest`; `hireframe-fns` only on the 3 scheduled; the guard only on `billingguard`.

**K15 (C32, C33). Unused APIs.**
- C32 lists them, and I propose a disable list in chat. Each one is disabled alone: `gcloud services disable <api> --project=$P` (**never `--force`**).
- Check: the app loads and signs in, System is OK, and the next scan succeeds.
- Rollback: `gcloud services enable <api> --project=$P`.
- **Never disable:** `identitytoolkit`, `securetoken`, `firestore`, `firebaserules`, `firebasehosting`, `firebasestorage`, `storage*`, `firebaseappcheck`, `recaptchaenterprise`, `cloudfunctions`, `run`, `cloudbuild`, `artifactregistry`, `eventarc`, `pubsub`, `cloudscheduler`, `secretmanager`, `iam`, `iamcredentials`, `sts`, `cloudresourcemanager`, `serviceusage`, `cloudbilling`, `firebaseextensions`, `compute`, `logging`, `firebase`.

**K16 (C53). Quotas, console.**
- Set CPUs (all regions) and GPUs (all regions) to 0, after recording the current values.
- Check: the C24c read with `--project=$P`.
- Rollback: set the old values back.

### Phase 4: v1.0.0 (after every gate, a weekday 10:00–16:00, nothing Generating)

**K17. Release checklist recorded:**
- step 97 phone median ≤ 2,000 ms;
- C17–C20 (Sun 18);
- the clean weekday on v0.9.0 (Fri 16);
- **the clean weekday on v0.9.1 (Tue 20)**;
- C47 seen;
- references only: Lighthouse accessibility on Pipeline (100) and the 360 px phone check, both recorded in 8A2.

**K18. Reads before the change:**
- C1, C2, C3;
- `cd ~ && flat > ~/iam-before-100.txt`;
- C51, C39a, C39b: nothing uses the compute account.

**K19 (C52). Read the bucket names.**
- Command: `gcloud storage buckets list --project=$P --format='value(name)' | grep '^gcf-v2-'`

**K20 (C39, Path F). Give the compute account the build roles, exactly as the spike proved.**
```bash
gcloud projects add-iam-policy-binding $P --member=serviceAccount:$COMPUTE --role=roles/logging.logWriter --condition=None
gcloud artifacts repositories add-iam-policy-binding gcf-artifacts --location=$R --member=serviceAccount:$COMPUTE --role=roles/artifactregistry.writer --project=$P
gcloud projects add-iam-policy-binding $P --member=serviceAccount:$COMPUTE --role=roles/storage.objectViewer --condition='expression=resource.name.startsWith("projects/_/buckets/gcf-v2-"),title=gcf-sources'
```
- Use the per-bucket variant instead of the third line if the spike needed it: `gcloud storage buckets add-iam-policy-binding gs://<bucket> --member=serviceAccount:$COMPUTE --role=roles/storage.objectViewer`.
- Check: C51 plus `gcloud artifacts repositories get-iam-policy gcf-artifacts --location=$R --project=$P`.
- Rollback: each command with `remove-…`.

**K21 (C39). Remove Editor from the compute account.**
- Command: `gcloud projects remove-iam-policy-binding $P --member=serviceAccount:$COMPUTE --role=roles/editor --condition=None`
- Check: C51 shows no `roles/editor`.
- Rollback (C40): `gcloud projects add-iam-policy-binding $P --member=serviceAccount:$COMPUTE --role=roles/editor --condition=None`

**K22.** Commit the evidence ticks to 8C2, wait for CI to go green, then merge.

**K23 (C4). Tag v1.0.0. This is the proving deploy.**
- Check:
  - every function shows "Successful update operation" (14 functions, none Skipped);
  - C50: `gcloud builds list --region=$R --project=$P --limit=20 --format='table(id,createTime.date(),status,serviceAccount)'` shows all SUCCESS, run as `$COMPUTE`.
- If a build fails: C40, wait 2 minutes, then **Re-run failed jobs**. Those functions kept their old hash, so they rebuild. Then report the failing build's log line.

**K24. Diff.**
- Command: `cd ~ && flat > ~/iam-after-100.txt && diff ~/iam-before-100.txt ~/iam-after-100.txt`
- Check: exactly `- roles/editor …$COMPUTE`, `+ roles/logging.logWriter …$COMPUTE` and `+ roles/storage.objectViewer …$COMPUTE` (conditional variant).
- C43: still the deployer baseline.

**K25. Afterwards:** the live checks below. Then C41, `gcloud auth revoke` on the laptop. Delete `~/iam-*.txt` from Cloud Shell once they're summarised in the PR.

---

## 5. Live checks

**After v0.9.1:**

| Check | What |
|---|---|
| C1, C2, C3 | Step 77, three scheduler jobs |
| C14b | `billingGuard` 1, 60, 256Mi, the guard SA twice, topic, no retry |
| C46 | The only invoker is the guard |
| C39a, C39b | No trigger or function on the compute account |
| C35 | `BILLING_GUARD_MODE` absent; `below` with `dry_run`, then `would_disable`, each logged within 2 minutes; billing still `True` |
| C47 | A real budget message parsed |
| K9 diff | Empty; deployer baseline |
| — | The next scheduled scan succeeds and the digest arrives (System, inbox) |

**After v1.0.0:**

| Check | What |
|---|---|
| C1, C2, C3 | As above |
| C50 | Builds SUCCESS as the compute account |
| C51 | No Editor |
| K24 diff | As expected |
| C39a, C39b | As above |
| C35 | Below threshold only: `below`, `dry_run`, within 2 minutes, after the rebuild |
| C49 | Invoker audit |
| C14 | Unchanged `maxInstances` and timeout on every function |
| — | Within 24 h: a scheduled scan Succeeded (R4, R12); the digest arrived; `generateCvs` last attempt OK (`gcloud scheduler jobs describe firebase-schedule-generateCvs-europe-west2 --location=$R --format='value(status,lastAttemptTime)'`); `retention.done` at 03:30; Apps Script `run` shows 2xx; the step 89 lab table recorded |

---

## 6. Risks

**Lock-out**
- **IAM edits on the wrong member.**
  - Only `add-` and `remove-iam-policy-binding`, never `set-iam-policy`.
  - Never touch the `user:` owner binding. Every member is spelled out in full.
  - Snapshot and diff around every change.
- **A passkey or hardware key.** Add it as an extra factor and keep the backup codes. Don't enrol in Advanced Protection.
- **Disabling an auth or IAM API** (`identitytoolkit`, `securetoken`, `iamcredentials`, `sts`, `cloudresourcemanager`) locks out sign-in or deploys. These are on the never-disable list, and each disable is approved alone, with no `--force`.
- **The £50 card limit:** a declined charge suspends the project, and the app stops. The Recovery entry is written. Normal GCP spend is near zero.

**Scans stopping**
- **Every deploy rewrites the `scheduledScan` invoker.** K1 and K11.
- **Editor removal doesn't touch the runtime:** every function runs as `hireframe-fns`, and the scheduler's OIDC is `hireframe-fns` (C3, C39b).
- **The guard is dry run with no billing role**, so it can't stop anything in 8C.
- **API disables** (K15) are checked by the next scan.

**Deploys stopping**
- **The first Pub/Sub function: the CLI's IAM step** (K6, finding 1). Fails safe: nothing deploys.
- **Editor removal breaks builds:** rehearsed in the throwaway (C24b, C28), with C40 rollback ready.
- **The storage condition may not match** the `gcf-v2-*` bucket names. The spike proves it; the per-bucket grant is the fallback.
- **A temporary grant removed that later deploys need:** v1.0.0 updates `billingGuard` without K6 in place, which proves it isn't needed.
- **K9 may break push delivery:** removing the Pub/Sub agent's project-level `tokenCreator` could stop messages reaching `billingGuard`. K12 requires a log line within 2 minutes of each publish; the fallback is the resource-level grant on `$GUARD`.
- **C38b (`eventarc.developer`), if needed, stays permanently**, because updates need it.
- **A `defineString` param would fail every CI deploy** (finding 4). Not used.
- **Re-runs prove nothing** (finding 5). The proving deploy is the C2 bundle change.
- **Deploy job time:** 14 functions rebuild, inside the job's 20 min `timeout-minutes`. Watch v0.9.1's time; if it is over 12 minutes, raise the job timeout in 8C2.

**Other**
- **The throwaway's billable resources:** one afternoon, then C31.
- **Running a throwaway command against prod:** use `--project=$T` on every command, a separate terminal, and type `T` once at the top. The armed function exists only in `$T`, and it disables only its own runtime project.
- **Budget notification lag:** a backstop only (ADR-059).

---

## 7. Sessions: Model · Effort · Mode
PLAYBOOK isn't in the repo. These defaults come from the m7 and m8b plans.

| Session | Model · Effort · Mode |
|---|---|
| 8C1 build S1: `billing/*`, `index.test`, ADR-059 | Sonnet · Medium · plan → accept edits |
| 8C1 build S2: C4 time tests, C5 counter, CLAUDE.md step, docs, gate, PR | Sonnet · Medium · plan → accept edits |
| 8C1 self-review (on the PR) | Opus · High · plan (read-only) |
| 8C1 security review | **Opus · Max** · plan (read-only) |
| Throwaway spike (owner runs, Claude guides) | Opus · High · default (each command approved) |
| 8C2 build S1: C2, table and source tests, ADR-060, docs, gate, PR | Sonnet · Medium · plan → accept edits |
| 8C2 self-review | Opus · High · plan |
| 8C2 security review (IAM) | **Opus · Max** · plan |
| Release sessions (Phase 2 and Phase 4 commands) | Opus · High · default |

Every PR runs the 7-step gate (`check`, `format:check`, `test:rules`, `build`, `check:bundle`, `smoke-functions-bundle`, `audit`) after the last commit and after review fixes. No `gh api` writes.

## Verification
- **8C1:**
  - the gate;
  - C30 `False` in the throwaway;
  - K9 diff empty;
  - C14b, C46, C35 and C47 as listed.
- **8C2:**
  - the gate (the table test fails on a planted function without `maxInstances`);
  - C50 builds as the compute account with no Editor;
  - the K24 diff exact;
  - the SECURITY checklist fully ticked with evidence;
  - the R1 to R12 sweep in the release checklist.

## Open questions
None. All seven were answered in the 15 Oct review (see Decisions under Context).
