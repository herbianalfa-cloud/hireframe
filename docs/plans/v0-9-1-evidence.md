# v0.9.1 evidence and handoff

Plan: `docs/plans/v0-9-1-plan.md` (sections 4, 5, 8). RUNBOOK: `docs/RUNBOOK.md` Part K and Recovery. Beeb fills the "Result" and time cells during the window; Claude fills "deviation" afterwards. Expected outputs are copied from the RUNBOOK text.

## Redaction note (read before pasting)
- Paste role lists and log tables only, never the whole IAM file.
- No `user:` lines. No email addresses except allowlisted service accounts, written `name@…` (for example `hireframe-billing-guard@…`).
- Write the project number as `<NUM>`.
- Outputs go to chat only, never into the repo.

## Pre-flight, 2 Nov 2026, HEAD 356efb8 = origin/main e914d72 + plan docs
All PASS.
1. `git log --oneline v0.9.0..origin/main` = 52 commits (v0.9.0 = 4d8164a). Expected PRs present: #39, #46, #49, #53, #54, #55. EXTRA (reported): #34 (actions/setup-node bump), #35 (minor-and-patch Dependabot, 11 updates), #40 (docs: 8C Phase 1 spike results).
2. `git merge-base --is-ancestor 0743bdf origin/main` exit 1 (PR #41 is not on main).
3. `firestore.rules`, `storage.rules`, `firestore.indexes.json` diff v0.9.0..origin/main: empty.
4. Gate exit 0 (format:check 2.9 s, check 42.0 s). `npm run build` 0. `smoke-functions-bundle` 0 (index.js 1000 KiB, 9 files 6282 KiB; `billingGuard` and 13 other functions in europe-west2). `check:bundle` 0: 42 chunks, initial JS 298.2 kB gzip in 6 files (budget 300 kB, headroom 1.8 kB; firestore 141.7, react 89.5, zod 26.8, index 22.3, firebase 17.4, rolldown-runtime 0.4). `test:rules` 0 (18 files, 407 tests). `npm run audit` 0 (1 high allowlisted: zod via @google/clasp).
5. `functions/deploy` has no env file; `BILLING_GUARD_MODE` appears only as the bundled `modeEnvVar` constant. Caveat: `functions/deploy/.secret.local` exists (gitignored, not read). Beeb may confirm it has no `BILLING_GUARD_MODE`.
6. `firebase-tools` 15.34.1 on main. `checkIam.js` `ensureServiceAgentRoles` unchanged: Pub/Sub agent `tokenCreator`; compute account `run.invoker` + `eventarc.eventReceiver`; throws "We failed to modify the IAM policy" on a failed `setIamPolicy`. K6 rationale holds.

### Noticed
- Initial JS headroom is only 1.8 kB (298.2 of 300 kB).
- RUNBOOK deviations queued for #41's K20 commit (Decisions 1 and 2; RUNBOOK and DECISIONS are not edited now): K7 says "Merge the PR" though #39 is merged; the spike's "wait 2 min before publishing" is missing from K8 and K12; step 103 says "weekend"; the "Every release" checklist and the "Billing was disabled" Recovery entry exist only on #41.

## Setup (window pre-checks 3 and 4)
Weekday 10:00-16:00 London, digest arrived, nothing Generating. Part K setup block (RUNBOOK lines 497-506) pasted; `gcloud config get-value project` prints `hireframe-f6b03`. Every command is shown in chat and approved first. Only `add-` / `remove-iam-policy-binding`; never `set-iam-policy`; never touch the `user:` owner binding.

## Step table
Columns: Result = pasted by Beeb; Start/End = London time; Deviation = filled by Claude.

### K6 Temporary pre-grant (C45), RUNBOOK Part K, K6
- Expected: "Check: the read prints 3 lines." Read: `flat | grep -E "^roles/(run.invoker|eventarc.eventReceiver)\s+serviceAccount:$COMPUTE|^roles/iam.serviceAccountTokenCreator\s+serviceAccount:$PSA"`. Grant only the missing ones. If `$PSA` "does not exist": `gcloud beta services identity create --service=pubsub.googleapis.com --project=$P`, then retry. Note which bindings were added. No stop until K9.
- Result (pasted by Beeb):
- Start / End:
- Deviation:

### K7 Tag v0.9.1 (C4), RUNBOOK Part K, K7; Part C step 27
- Run `git checkout main && git pull && git log -1` (HEAD = G1 merge; #39 is in `v0.9.0..HEAD`), then `git tag v0.9.1 && git push origin v0.9.1`, approve the deploy.
- Expected: "the deploy log shows `functions[billingGuard(europe-west2)] Successful create operation` and no "We failed to modify the IAM policy"".
- Result (pasted by Beeb):
- Start / End:
- Deviation:

### K8 Invoker binding (C38, C46), RUNBOOK Part K, K8
- Run `gcloud functions add-invoker-policy-binding billingGuard --region=$R --member=serviceAccount:$GUARD --project=$P`, then C46: `gcloud run services get-iam-policy billingguard --region=$R --project=$P --flatten='bindings[].members' --filter='bindings.role:roles/run.invoker' --format='value(bindings.members)'`.
- Expected: "It prints **only** `serviceAccount:hireframe-billing-guard@…`." Note the time (wait at least 2 minutes before K12's publish; plan section 8).
- Result (pasted by Beeb):
- Start / End:
- Deviation:

### K9 Remove the K6 grants (C45r), RUNBOOK Part K, K9
- The same three commands with `remove-iam-policy-binding`, only for the ones K6 added. Then `cd ~ && flat > ~/iam-after-091.txt && diff ~/iam-before-091.txt ~/iam-after-091.txt`, and the C43 deployer role read from K2.
- Expected: "prints nothing, or only `roles/eventarc.developer serviceAccount:$SA` if K7 needed C38b (record it). A `roles/pubsub.serviceAgent serviceAccount:$PSA` line, if K6 created the agent, is Google's own binding: record it and never remove it. Any other line: stop. The deployer's roles (K2) are still the 7 baseline ones (8 if K7 needed `eventarc.developer`, recorded)."
- Result (pasted by Beeb; role lists only):
- Start / End:
- Deviation:

### K10 Checks on billingGuard (C14b, C39a, C39b), RUNBOOK Part K, K10
- C14b: `gcloud functions describe billingGuard --region=$R --gen2 --project=$P --format='value(serviceConfig.maxInstanceCount,serviceConfig.timeoutSeconds,serviceConfig.availableMemory,serviceConfig.serviceAccountEmail,eventTrigger.serviceAccountEmail,eventTrigger.pubsubTopic,eventTrigger.retryPolicy)'`
  Expected: "It must show `1 60 256Mi hireframe-billing-guard@… hireframe-billing-guard@… projects/hireframe-f6b03/topics/billing-guard RETRY_POLICY_DO_NOT_RETRY`."
- C39a and C39b: `for L in $R global; do gcloud eventarc triggers list --location=$L --project=$P --format='table(name,serviceAccount,destination.cloudRun.service,transport.pubsub.topic)'; done` and `gcloud functions list --regions=$R --project=$P --format='table(name,serviceConfig.serviceAccountEmail,eventTrigger.serviceAccountEmail)'`
  Expected: "No row shows `$COMPUTE`. The `billingguard` trigger shows `hireframe-billing-guard@…`. Every function shows `hireframe-fns@…`, except `billingGuard`."
- Result (pasted by Beeb):
- Start / End:
- Deviation:

### K11 Step 77 again (C1, C2, C3), RUNBOOK Part K, K11 = K1
- Repeat Part G step 77 (C1, C2) and the C3 line of step 101.
- Expected (K1): "`scheduledScan`'s job is `30 7,17 * * 1-5`, `Europe/London`, `hireframe-fns@…`. C2: its invoker is only `hireframe-fns`. C3: three scheduler jobs, all ENABLED." Fix: the Recovery entries for a scheduled function.
- Result (pasted by Beeb):
- Start / End:
- Deviation:

### K12 Dry run (C35), RUNBOOK Part K, K12
- Env read: `gcloud functions describe billingGuard --region=$R --gen2 --project=$P --format='value(serviceConfig.environmentVariables)'` must "**not** contain `BILLING_GUARD_MODE`".
- Publish below threshold: `gcloud pubsub topics publish billing-guard --project=$P --message='{"budgetDisplayName":"hireframe-kill","costAmount":1,"budgetAmount":25,"currencyCode":"GBP","costIntervalStart":"2026-10-01T00:00:00Z"}'`, then read: `gcloud logging read 'resource.type="cloud_run_revision" AND resource.labels.service_name="billingguard"' --project=$P --freshness=10m --limit=10 --format='table(timestamp,severity,jsonPayload.event,jsonPayload.mode,jsonPayload.step,jsonPayload.code)'`
- Expected: "**Within 2 minutes** the log must show `billing_guard.below` with `mode: dry_run`. **Only after that line shows `dry_run`**, publish the same message with `"costAmount":30`: within 2 minutes the log must show `billing_guard.would_disable`. Check: `gcloud billing projects describe $P --format='value(billingEnabled)'` still prints `True`."
- No log line within 2 minutes: see fallback B below.
- Result (pasted by Beeb):
- Start / End:
- Deviation:

### K13 Budgets (owner, console), RUNBOOK Part K, K13
- Read the budget list first (Decision 10: edit the existing £5 and £10, add £2). Billing -> Budgets & alerts: "£2, £5 and £10 at 100%, actual and forecast, emails on; and `hireframe-kill` at £25, scope this project, actual cost, connected to the topic `projects/hireframe-f6b03/topics/billing-guard`." Budget API only per Decision 7. Note the time (C47 clock starts).
- Result (pasted by Beeb; names and amounts only):
- Start / End:
- Deviation:

### Scan-now proof, plan section 8 steps 5-8c
- Expected: System -> **Scan now** run row **Succeeded** (Partial or Failed: read "Partial because", stop). `digestNow` Run shows Completed, a `digest.now` line with today's `isoWeekday`, and the email arrives (Part I step 92.3; failure: step 92.4 and Recovery "No digest arrived"). `gcloud scheduler jobs list --location=europe-west2 --project=$P`: three jobs, all ENABLED. Live site: sign in, Today loads, no console errors (C7).
- Result (pasted by Beeb):
- Start / End:
- Deviation:

### I7-lite CV check, plan section 8 step 8b
- Start an application on one job, wait for Ready, download and open the DOCX and the PDF. Expected: one page, black text, right section order, no garbled characters. A CV render problem is a stop: do not continue to C47 bookkeeping, paste what you see, and Claude diagnoses first. Then step 8c: scheduler list again (three jobs ENABLED).
- DOCX opens / PDF opens (yes or no):
- Result (pasted by Beeb):
- Start / End:
- Deviation:

### C47 budget message, RUNBOOK Part K, K13
- Within 24 hours of K13: `gcloud logging read 'resource.type="cloud_run_revision" AND resource.labels.service_name="billingguard"' --project=$P --freshness=1d --limit=10 --format='table(timestamp,severity,jsonPayload.event,jsonPayload.mode,jsonPayload.step,jsonPayload.code)'`
- Expected: "`billing_guard.below` (`mode: dry_run`), never `billing_guard.invalid`. An `.invalid` is fixed in the next PR."
- `.ignored` means the budget name or currency is wrong: fix it in the console and wait. `.invalid` or nothing: Decision 6 (A: stop, diagnose, small PR, v0.9.2 with a Scan-now proof; C: extend once by 24 h after checking the budget's topic link; a second miss: stop).
- If the Budget API was enabled: disable it after this passes, then confirm one more `billing_guard.below` (Decision 7).
- Result (pasted by Beeb):
- Start / End:
- Deviation:

### Post-K13 check, RUNBOOK Part K (line 558)
- Expected: "After K13, check that the next scheduled scan succeeds and the morning digest arrives." Next scan 17:30 or 07:30, weekdays, shows Succeeded in System; the next morning digest arrives.
- Result (pasted by Beeb):
- Start / End:
- Deviation:

## Abort path (plan section 8)
If K7 cannot be fixed by 15:30, or any step says stop: run K9 now (remove only the bindings K6 added), then the K9 diff and deployer role check. Nothing else is needed for safety, because the function has no billing role. To remove the function, revert the export in a PR and release a patch. Report to Claude before retrying. Re-adding grants is never wanted.

## Conditional fallbacks (accepted in principle, Decision 5; each shown and approved when needed)
### A. C38b: Eventarc permission error on the K7 create (permanent)
RUNBOOK K7: "If the create fails on an Eventarc permission, grant `gcloud projects add-iam-policy-binding $P --member=serviceAccount:$SA --role=roles/eventarc.developer --condition=None` (C38b), record it in ADR-059 (it stays, because later updates need it too), then re-run." Record here; the ADR-059 line goes into #41's K20 commit (Decision 2). K9's diff then also shows `roles/eventarc.developer serviceAccount:$SA`; deployer roles are 8.
- Used (yes or no) / time:

### B. K12 Recovery: "`billingGuard` logs nothing after a publish"
Grant it on the guard account only (shown in chat first; variables are Part K's setup block):
```bash
gcloud iam service-accounts add-iam-policy-binding $GUARD --member=serviceAccount:$PSA --role=roles/iam.serviceAccountTokenCreator --project=$P
gcloud iam service-accounts get-iam-policy $GUARD --project=$P --format='value(bindings.role,bindings.members)'
```
"The second command must show it beside the deployer's `serviceAccountUser`. Then publish the below-threshold message again and expect `billing_guard.below` within 2 minutes. Rollback: the same command with `remove-iam-policy-binding`. If it still logs nothing, check C46 (the only invoker is `hireframe-billing-guard@…`) and C14b (the trigger's service account). Record the live option in ADR-059."
- Used (yes or no) / time:
