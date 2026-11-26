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

## Release-day pre-flight, 3 Nov 2026, 12:22 London (reported by Beeb, bash tab)
- Part K setup block loaded; `gcloud` account and project correct (`hireframe-f6b03`); `NUM` set (written `<NUM>` here).
- `~/iam-before-091.txt` (taken 20 Oct, K2) diffs clean against the live policy now. Fresh copy saved as `~/iam-pre-k6-091.txt`. K9 still diffs against `iam-before-091.txt`.
- Plan step 3 confirmed by Beeb before the K6 grants: morning digest arrived today (yes); Pipeline Generating: none. Weekday, within 10:00-16:00.
- Repo: `main` = 35a4dd4 (G1 merge, #56).

## Step table
Columns: Result = pasted by Beeb; Start/End = London time; Deviation = filled by Claude.

### K6 Temporary pre-grant (C45), RUNBOOK Part K, K6
- Expected: "Check: the read prints 3 lines." Read: `flat | grep -E "^roles/(run.invoker|eventarc.eventReceiver)\s+serviceAccount:$COMPUTE|^roles/iam.serviceAccountTokenCreator\s+serviceAccount:$PSA"`. Grant only the missing ones. If `$PSA` "does not exist": `gcloud beta services identity create --service=pubsub.googleapis.com --project=$P`, then retry. Note which bindings were added. No stop until K9.
- Result (pasted by Beeb):
  - Read, 3 Nov ~12:3x: the three-binding grep printed 0 lines (BSD grep: Beeb used `[[:space:]]` for `\s`). Cross-check `flat | grep -E "$COMPUTE|$PSA" | cut -f1` printed only `roles/editor`. So all three bindings were missing.
  - Grants: all three added (run.invoker and eventarc.eventReceiver on `<NUM>-compute@…`; serviceAccountTokenCreator on `service-<NUM>@…`). `$PSA` existed; no `services identity create` needed. Re-read prints 3 lines: `roles/eventarc.eventReceiver`, `roles/iam.serviceAccountTokenCreator`, `roles/run.invoker`.
  - **K9 must remove all three.**
  - **Redone 5 Nov:** read 12:23:09 (0 lines), three grants 12:25:05, re-read = 3 lines; plus K6b (custom role `hfTmpTopicsCreate091` created 12:19:19, bound to the deployer 12:27:40). All removed at K9 on 5 Nov.
- Start / End: start not recorded (after the 12:2x pre-flight, before the read); end 12:38:36 London. K9 deadline 15:30.
- Deviation: grep uses `[[:space:]]` (macOS); no effect on the result.

### K7 Tag v0.9.1 (C4), RUNBOOK Part K, K7; Part C step 27
- Run `git checkout main && git pull && git log -1` (HEAD = G1 merge; #39 is in `v0.9.0..HEAD`), then `git tag v0.9.1 && git push origin v0.9.1`, approve the deploy.
- Expected: "the deploy log shows `functions[billingGuard(europe-west2)] Successful create operation` and no "We failed to modify the IAM policy"".
- Deploy job duration: attempt 1 (3 Nov) 13:01:39 to 13:07:24 London, failed. Attempt 2 (5 Nov, re-run) approved 12:35, finished 12:42 London, about 7 min, succeeded.
- Result (pasted by Beeb):
  - Step 1 (check main), 3 Nov after 12:38: `git checkout main && git pull` = already up to date; `git log -1` = `35a4dd4 ... (G1) (#56)`, equals origin/main. #39 is in `v0.9.0..HEAD` as `017d60c Merge pull request #39`; `merge-base --is-ancestor 017d60c HEAD` true.
  - Step 2 (tag), 12:45:59 London: `git tag v0.9.1 && git push origin v0.9.1` printed `* [new tag] v0.9.1 -> v0.9.1`. Remote tag = 35a4dd4 (checked by `git ls-remote`). Deploy run 41638473194 (push, `v0.9.1`, sha 35a4dd4) created 12:46:00 and is waiting for review.
  - Step 3 (deploy), **FAILED**. Run 41638473194: job `deploy` 13:01:39 to 13:07:24 London (so approved about 13:01), conclusion failure. Read by Claude with `gh run view --log-failed` at 14:15. Hosting, Storage rules and Firestore rules released; 13 existing functions `Successful update operation`; `billingGuard(europe-west2)` NOT created: `Unexpected error creating Pub/Sub topic`, then "Deploys failed. Skipping deletes", exit 2. No "We failed to modify the IAM policy" line (K6 worked). Not one of the two planned fallbacks (that message, or an Eventarc permission error).
  - **Retry, 5 Nov (attempt 2): PASSED.** `gh run rerun 41638473194 --failed` at 12:31:09 London; the `production` approval was asked again (approved 12:35); finished 12:42, `completed success`; `functions[billingGuard(europe-west2)] Successful create operation`; no IAM-policy failure; C38b not needed. K6 and K6b were redone first (12:25 and 12:27 London).
  - Code path (firebase-tools 15.34.1, `fabricator.js` `createV2Function`): the CLI does `PUT` on the topic from `eventTrigger.pubsubTopic`; only HTTP 409 is tolerated, any other status throws that message. The topic exists from K3, so the PUT should give 409 unless the deployer is refused (likely 403, `pubsub.topics.create`). Unverified: the real status is not in the log.
- Start / End: K7 start 12:45:59 (tag push); deploy job ended 13:07:24 (failed).
- Deviation: Beeb skipped the pasted "tag exists?" pre-check; the `&&` chain and the `[new tag]` result show neither side had it. My `grep "#39\)"` matched nothing (the merge subject has no `)`); Beeb's plain `grep "#39"` plus the ancestor check confirmed it. Beeb's working tree carries the uncommitted evidence-doc edit (`M`); it does not affect the tag.

### K8 Invoker binding (C38, C46), RUNBOOK Part K, K8
- Run `gcloud functions add-invoker-policy-binding billingGuard --region=$R --member=serviceAccount:$GUARD --project=$P`, then C46: `gcloud run services get-iam-policy billingguard --region=$R --project=$P --flatten='bindings[].members' --filter='bindings.role:roles/run.invoker' --format='value(bindings.members)'`.
- Expected: "It prints **only** `serviceAccount:hireframe-billing-guard@…`." Note the time (wait at least 2 minutes before K12's publish; plan section 8).
- Result (pasted by Beeb):
  - 5 Nov 12:51:19 London: `add-invoker-policy-binding` printed only `roles/run.invoker` for `hireframe-billing-guard@…`; C46 printed only that account. **PASSED.**
- Start / End: 5 Nov 12:51:19 London
- Deviation: None.

### K9 Remove the K6 grants (C45r), RUNBOOK Part K, K9
- The same three commands with `remove-iam-policy-binding`, only for the ones K6 added. Then `cd ~ && flat > ~/iam-after-091.txt && diff ~/iam-before-091.txt ~/iam-after-091.txt`, and the C43 deployer role read from K2.
- Expected: "prints nothing, or only `roles/eventarc.developer serviceAccount:$SA` if K7 needed C38b (record it). A `roles/pubsub.serviceAgent serviceAccount:$PSA` line, if K6 created the agent, is Google's own binding: record it and never remove it. Any other line: stop. The deployer's roles (K2) are still the 7 baseline ones (8 if K7 needed `eventarc.developer`, recorded)."
- Result (pasted by Beeb; role lists only):
  - 3 Nov (abort path, three K6 removals only) and 5 Nov 12:52:30 to 13:00:17 London (K6b unbound, custom role deleted, three K6 bindings removed). Final diff vs `iam-before-091.txt` = only Google's `pubsub.serviceAgent` and `eventarc.serviceAgent` lines (accepted by Beeb); deployer = the 7 baseline roles. **PASSED.**
- Start / End: 5 Nov 12:52:30 to 13:00:17 London (3 Nov: abort path only)
- Deviation: K6b and the custom role were added to the sequence (plan 8b). Google's `eventarc.serviceAgent` line is not in RUNBOOK K9's allowed list; accepted by Beeb as Google-created (see the retry-day block).

**K9 progress (abort path, Beeb's decision after the K7 failure):** step 1 done 3 Nov, 14:18:48 to 14:19:40 London. All three `remove-iam-policy-binding` calls printed `Updated IAM policy for project [hireframe-f6b03].` Each returned policy shows the binding gone: `run.invoker` for `<NUM>-compute@…`, then `eventarc.eventReceiver` for it, then `serviceAccountTokenCreator` for `service-<NUM>@…` (the `firebase-adminsdk-fbsvc@…` member of that role stays). Step 2 done (about 14:2x): `diff ~/iam-before-091.txt ~/iam-after-091.txt` empty, `diff exit: 0`; deployer roles (C43) = exactly the 7 baseline (cloudfunctions.developer, cloudscheduler.admin, datastore.indexAdmin, firebase.viewer, firebasehosting.admin, firebaserules.admin, serviceusage.serviceUsageConsumer). **K9 PASSED, done well before 15:30; all K6 grants removed; no C38b used.** Note: Beeb pasted whole policies into chat (includes a `user:` line); nothing from them goes in the repo.

### K10 Checks on billingGuard (C14b, C39a, C39b), RUNBOOK Part K, K10
- C14b: `gcloud functions describe billingGuard --region=$R --gen2 --project=$P --format='value(serviceConfig.maxInstanceCount,serviceConfig.timeoutSeconds,serviceConfig.availableMemory,serviceConfig.serviceAccountEmail,eventTrigger.serviceAccountEmail,eventTrigger.pubsubTopic,eventTrigger.retryPolicy)'`
  Expected: "It must show `1 60 256Mi hireframe-billing-guard@… hireframe-billing-guard@… projects/hireframe-f6b03/topics/billing-guard RETRY_POLICY_DO_NOT_RETRY`."
- C39a and C39b: `for L in $R global; do gcloud eventarc triggers list --location=$L --project=$P --format='table(name,serviceAccount,destination.cloudRun.service,transport.pubsub.topic)'; done` and `gcloud functions list --regions=$R --project=$P --format='table(name,serviceConfig.serviceAccountEmail,eventTrigger.serviceAccountEmail)'`
  Expected: "No row shows `$COMPUTE`. The `billingguard` trigger shows `hireframe-billing-guard@…`. Every function shows `hireframe-fns@…`, except `billingGuard`."
- Result (pasted by Beeb):
  - 5 Nov (14:13 London): C14b `1  60  256Mi`, function and trigger account `hireframe-billing-guard@…`, topic `billing-guard`, `RETRY_POLICY_DO_NOT_RETRY`; C39a/C39b: one trigger (account `hireframe-billing-guard@…`), no row with the compute account, the other 13 functions `hireframe-fns@…`. **PASSED.**
- Start / End: 5 Nov 14:13:40 London
- Deviation: None.

### K11 Step 77 again (C1, C2, C3), RUNBOOK Part K, K11 = K1
- Repeat Part G step 77 (C1, C2) and the C3 line of step 101.
- Expected (K1): "`scheduledScan`'s job is `30 7,17 * * 1-5`, `Europe/London`, `hireframe-fns@…`. C2: its invoker is only `hireframe-fns`. C3: three scheduler jobs, all ENABLED." Fix: the Recovery entries for a scheduled function.
- Result (pasted by Beeb):
  - C1/C2, 3 Nov after 14:2x (run after the failed deploy, which updated 13 functions): scheduler job `30 7,17 * * 1-5`, `Europe/London`, `hireframe-fns@…`; `scheduledscan` invoker only `serviceAccount:hireframe-fns@…`. PASS.
  - C3, 3 Nov after 14:2x: exactly three jobs, all ENABLED, all `hireframe-fns@…`: `purgeOldData` `30 3 * * *`, `scheduledScan` `30 7,17 * * 1-5`, `generateCvs` `*/10 7-23 * * *`, all `Europe/London`. PASS. **K11 PASSED.**
- Start / End: about 14:2x to 14:3x London.
- Deviation: K11 ran after the failed K7 deploy (abort path), not after a successful one.
- Re-run 5 Nov, 14:15:45 London (after the successful deploy): C1 `30 7,17 * * 1-5` Europe/London `hireframe-fns@…`; C2 only `hireframe-fns@…`; C3 three jobs ENABLED. **PASSED.**

### K12 Dry run (C35), RUNBOOK Part K, K12
- Env read: `gcloud functions describe billingGuard --region=$R --gen2 --project=$P --format='value(serviceConfig.environmentVariables)'` must "**not** contain `BILLING_GUARD_MODE`".
- Publish no sooner than 2 min after K8's noted time.
- Publish below threshold: `gcloud pubsub topics publish billing-guard --project=$P --message='{"budgetDisplayName":"hireframe-kill","costAmount":1,"budgetAmount":25,"currencyCode":"GBP","costIntervalStart":"2026-10-01T00:00:00Z"}'`, then read: `gcloud logging read 'resource.type="cloud_run_revision" AND resource.labels.service_name="billingguard"' --project=$P --freshness=10m --limit=10 --format='table(timestamp,severity,jsonPayload.event,jsonPayload.mode,jsonPayload.step,jsonPayload.code)'`
- Expected: "**Within 2 minutes** the log must show `billing_guard.below` with `mode: dry_run`. **Only after that line shows `dry_run`**, publish the same message with `"costAmount":30`: within 2 minutes the log must show `billing_guard.would_disable`. Check: `gcloud billing projects describe $P --format='value(billingEnabled)'` still prints `True`."
- No log line within 2 minutes: see fallback B below.
- Result (pasted by Beeb):
  - 5 Nov: no `BILLING_GUARD_MODE`; the £1 publish gave `billing_guard.below` `dry_run` (14:30:54 to 14:31:00); the £30 publish gave `billing_guard.would_disable` `dry_run` (14:32:04 to 14:32:07); `billingEnabled` True. **PASSED.** No push grant needed.
- Start / End: 5 Nov 14:18:49 to 14:32:13 London
- Deviation: None. The first log read ran before the publish (no effect).

### K13 Budgets (owner, console), RUNBOOK Part K, K13
- Read the budget list first (Decision 10: edit the existing £5 and £10, add £2). Billing -> Budgets & alerts: "£2, £5 and £10 at 100%, actual and forecast, emails on; and `hireframe-kill` at £25, scope this project, actual cost, connected to the topic `projects/hireframe-f6b03/topics/billing-guard`." Budget API only per Decision 7. Note the time (C47 clock starts).
- Result (pasted by Beeb; names and amounts only):
  - 11 Nov 16:54 London (Beeb): `hireframe-kill` £25 (100% actual, topic `billing-guard`), `hireframe-2gbp` £2 (100% actual and forecast), the existing £10 budget kept (50/90/100% actual plus a 100% forecast row); no separate £5; scope shows "All projects (1)"; billing-admin emails on; topic policy shows only Google's budget publisher. Budget API not enabled. Deviations accepted by Beeb. **DONE.**
- Start / End: 11 Nov 16:54 London (`hireframe-kill` saved)
- Deviation: Run 6 days after K12 and outside 10:00-16:00; no separate £5 budget (the £10 budget's 50% row covers it); scope "All projects (1)"; accepted by Beeb.

### Scan-now proof, plan section 8 steps 5-8c
- Expected: System -> **Scan now** run row **Succeeded** (Partial or Failed: read "Partial because", stop). `digestNow` Run shows Completed, a `digest.now` line with today's `isoWeekday`, and the email arrives (Part I step 92.3; failure: step 92.4 and Recovery "No digest arrived"). `gcloud scheduler jobs list --location=europe-west2 --project=$P`: three jobs, all ENABLED. Live site: sign in, Today loads, no console errors (C7).
- Result (pasted by Beeb):
  - 19 Nov: Scan now Succeeded (ended 14:46 London); `digestNow` Completed, `isoWeekday` 4, real digest arrived; scheduler list: three jobs ENABLED (again on 22/23 Nov). I7-lite is the row below. Step 8 (24 Nov, 11:28 London): Today loads; one third-party reCAPTCHA `pat` 401 in the console, accepted as a deviation of C7 (Beeb). **PASSED with that deviation.**
- Start / End: 19 Nov (scan ended 14:46 London); step 8 on 24 Nov, finished 11:28
- Deviation: Step 8 was done five days later; C7 accepted with one third-party reCAPTCHA console error (Beeb).

### I7-lite CV check, plan section 8 step 8b
- Start an application on one job, wait for Ready, download and open the DOCX and the PDF. Expected: one page, black text, right section order, no garbled characters. A CV render problem is a stop: do not continue to C47 bookkeeping, paste what you see, and Claude diagnoses first. Then step 8c: scheduler list again (three jobs ENABLED).
- DOCX opens / PDF opens (yes or no): yes / yes
- Result (pasted by Beeb): 3 Nov, afternoon, on the live site (docx 9.15 live via the failed deploy's 13 function updates). One application on a health-tech job reached Ready, "well under 20 minutes" (not timed). Both files open; one page; black text on white; all sections present and in order; no garbled characters; bullets fine; Console showed no red errors. **Render check PASSED.** Beeb's own comment: the CV *content* is weak. That is CV quality (queued PR #42, after v1.0.0), not a render problem; not judged here.
- Start / End: not timed.
- Deviation: ran on the abort path, with no `billingGuard`. Step 8c (scheduler list after the CV worker ran), 3 Nov afternoon: run twice, identical both times: `purgeOldData` `30 3 * * *`, `scheduledScan` `30 7,17 * * 1-5`, `generateCvs` `*/10 7-23 * * *`, all ENABLED. **8c PASSED.**

### C47 budget message, RUNBOOK Part K, K13
- Within 24 hours of K13: `gcloud logging read 'resource.type="cloud_run_revision" AND resource.labels.service_name="billingguard"' --project=$P --freshness=1d --limit=10 --format='table(timestamp,severity,jsonPayload.event,jsonPayload.mode,jsonPayload.step,jsonPayload.code)'`
- Expected: "`billing_guard.below` (`mode: dry_run`), never `billing_guard.invalid`. An `.invalid` is fixed in the next PR."
- `.ignored` means the budget name or currency is wrong: fix it in the console and wait. `.invalid` or nothing: Decision 6 (A: stop, diagnose, small PR, v0.9.2 with a Scan-now proof; C: extend once by 24 h after checking the budget's topic link; a second miss: stop).
- If the Budget API was enabled: disable it after this passes, then confirm one more `billing_guard.below` (Decision 7).
- Result (pasted by Beeb):
  - 19 Nov read (`--freshness=8d`): `billing_guard.below` with `mode: dry_run` about every 22 min; per-day counts 18/58/56/61/68/67/56/51/35 (11 to 19 Nov); no `invalid`, `ignored`, `would_disable`, `disabled` or WARNING rows. **PASSED** (read 8 days after K13; messages began within hours of it).
- Start / End: read 19 Nov, about 14:35 London
- Deviation: Read 8 days after K13, so the 24 h window was missed on timing; messages began within hours of K13.

### Post-K13 check, RUNBOOK Part K (line 558)
- Expected: "After K13, check that the next scheduled scan succeeds and the morning digest arrives." Next scan 17:30 or 07:30, weekdays, shows Succeeded in System; the next morning digest arrives.
- Result (pasted by Beeb):
  - 19 Nov: 12 of 12 scheduled scans Succeeded (11 Nov 17:30 to 19 Nov 07:30); digests arrived 12, 13, 16, 17, 18 and 19 Nov. **PASSED.**
- Start / End: 11 Nov 17:30 to 19 Nov 07:30 (12 scans)
- Deviation: None.

## Diagnosis checks and retry decision, Wed 4 Nov 2026 (about 13:25 London)
Planner report: `docs/plans/v0-9-1-deploy-diagnosis.md` (report only; its claims are marked CONFIRMED or UNVERIFIED there).
- **5a (audit log, read-only): CONFIRMED cause.** `CreateTopic` at 2026-11-03T13:05:49Z by `github-deployer@…`: status code 7, "User not authorized to perform this action.", permission `pubsub.topics.create`, granted False. That is the 403 the CLI does not tolerate (only 409 passes). It is the only row in 12:55-13:10Z.
- **5b (role permissions, read-only): CONFIRMED.** None of the deployer's 7 roles lists `pubsub.topics.create` (seven headers, nothing under any); the `billing-guard` topic policy printed nothing (no bindings). Beeb's paste also echoed the next command line under the first role header: a terminal paste artifact, not output.
- **Decision (Beeb, 4 Nov, 13:2x):** retry **Thu 5 Nov, 10:00** (today is past the cutoff; nothing else today). Fix = a **temporary one-permission custom role** (`pubsub.topics.create`) bound to the deployer as **K6b** next to K6; in **K9** unbind it **and delete the custom role** (not kept). No new tag: Re-run failed jobs on run 41638473194 (planner: idempotent; UNVERIFIED that `production` approval is asked again). K6 must be redone first.
- **Retry-day sequence:** pre-checks (weekday 10:00-16:00, digest arrived, nothing Generating; `flat` diff vs `~/iam-before-091.txt` empty; deployer 7 roles) -> create the role -> **K6** (3 bindings) -> **K6b** (bind the role to `$SA`) -> Re-run failed jobs, approve -> expect `functions[billingGuard(europe-west2)] Successful create operation` -> K8 (wait 2 min before K12) -> **K9** (remove the 3 K6 bindings, unbind K6b, delete the role; diff empty, deployer 7 roles) -> K10, K11, K12, K13, Scan-now proof. Hard stop: K9 by 15:30.
- Role and binding commands are shown in chat and approved first on the day. K9 order matters: unbind before deleting the role.
- Open / UNVERIFIED (from the report): whether `createFunction` needs another caller permission after the topic step (a new error would name it; C38b is the known Eventarc fallback); how long a deleted custom role ID stays reserved (not needed again).
- ADR-059 and RUNBOOK K6/K6b/K9 text: update later in #41's K20 commit (Decision 2), not now.

### Retry day, Thu 5 Nov (London = GMT)
- Pre-checks (Beeb, own tab): setup block loaded, NUM ok, IAM diff vs `iam-before-091.txt` = baseline unchanged. Digest yes; nothing Generating.
- **Step 0, custom role created, 12:19:19 GMT.** `Created role [hfTmpTopicsCreate091].` `includedPermissions`: only `pubsub.topics.create`; stage GA. Unbound; nothing granted yet. K9 must unbind, then delete it.
- **K6 read, 12:23:09 GMT:** the three-binding grep count = 0 (all three missing).
- **K6 grants, 12:25:05 GMT:** all three added, each `Updated IAM policy for project [hireframe-f6b03].` (`run.invoker` and `eventarc.eventReceiver` on `<NUM>-compute@…`; `serviceAccountTokenCreator` on `service-<NUM>@…`). `$PSA` existed. **No stop until K9 (by 15:30).**
- **K6 verify:** re-read prints 3 lines (`eventarc.eventReceiver`, `iam.serviceAccountTokenCreator`, `run.invoker`).
- **K6b, 12:27:40 GMT:** `projects/hireframe-f6b03/roles/hfTmpTopicsCreate091` bound to `github-deployer@…` at project level. `Updated IAM policy for project [hireframe-f6b03].`
- **K6b check:** deployer has exactly 8 roles: the 7 baseline plus `projects/hireframe-f6b03/roles/hfTmpTopicsCreate091`.
- **K7 retry, 12:31:09 GMT:** `gh run rerun 41638473194 --failed` accepted (attempt 2). The job waited for the `production` approval, so **approval is asked again on a re-run**. Run finished `completed success`; log (12:39Z lines): `creating Node.js 22 (2nd Gen) function billingGuard(europe-west2)...` then `functions[billingGuard(europe-west2)] Successful create operation.` No "We failed to modify the IAM policy". C38b not needed. The log also holds Firestore `PERMISSION_DENIED` lines at 12:39:48Z (rules-test noise, see deviation); approved 12:35, finished 12:42 (Beeb). Beeb states the `PERMISSION_DENIED` lines come from the rules-test step (expected denials) and `MetadataLookupWarning` is CI noise. **K7 PASSED.**
- **K8, 12:51:19 GMT:** `add-invoker-policy-binding billingGuard` printed one binding: `roles/run.invoker` for `hireframe-billing-guard@…`, etag `BwZfhvPks6w=`. **C46 PASSED:** the `billingguard` service's `run.invoker` list prints only `serviceAccount:hireframe-billing-guard@…`.
- **K9 step 1, 12:52:30 GMT (K9 started; limit 15:30):** K6b unbound (`remove-iam-policy-binding` of `hfTmpTopicsCreate091` from `github-deployer@…`). `Updated IAM policy for project [hireframe-f6b03].` etag `BwZfhvgwe4k=`.
- **K9 step 2:** custom role `hfTmpTopicsCreate091` deleted (`deleted: true`, role etag `BwZfhwBLSMM=`; time not pasted, after 12:52:30 GMT).
- **K9 step 3A, 12:58:15 GMT:** all three K6 bindings removed (`run.invoker` and `eventarc.eventReceiver` on `<NUM>-compute@…`; `serviceAccountTokenCreator` on `service-<NUM>@…`), each `Updated IAM policy for project [hireframe-f6b03].` etags `BwZfhwyllKE=`, `BwZfhwzHgIs=`, `BwZfhwzn0ho=`. Diff and deployer role read pending.
- **K9 step 3B, 13:00:17 GMT: STOP, diff not empty (`diff exit: 1`).** Two added lines vs `iam-before-091.txt`: `roles/eventarc.serviceAgent` for `service-<NUM>@gcp-sa-eventarc.iam.gserviceaccount.com` and `roles/pubsub.serviceAgent` for `service-<NUM>@gcp-sa-pubsub.iam.gserviceaccount.com`. Deployer roles = exactly the 7 baseline (temporary role gone). RUNBOOK K9 allows only the `pubsub.serviceAgent` line (and says never remove it); the `eventarc.serviceAgent` line is not listed, so per "Any other line: stop" nothing was changed. Unverified: that both were created by Google when the first event-triggered function was created. Beeb to decide.
- **K9 diff, audit-log read (project `SetIamPolicy`, from 12:30Z):** six rows. Four by the owner at our own steps (12:52:33 K6b unbind; 12:58:16, 12:58:19, 12:58:21 the three K6 removals). Two by `service-agent-manager@… (Google system account)` (Google's system account) at 12:40:34 and 12:41:54, inside the deploy window (approved 12:35, finished 12:42). So the two extra lines were written by Google during the `billingGuard` create, not by any of our commands. Caveat: the log does not say which row wrote which line. **Decision (Beeb, 5 Nov, ~13:1x): accept both lines as Google-created service agents; never remove them.** Same rule as RUNBOOK K9's `pubsub.serviceAgent` line, extended to `eventarc.serviceAgent`. **K9 PASSED:** K6 bindings removed, K6b unbound, custom role deleted, deployer = 7 baseline roles, diff = only those two Google lines. RUNBOOK K9 wording ("an `eventarc.serviceAgent` line appears when the first event function is created") queued for #41's K20 commit (Decision 2). Future K9/C43 diffs should expect both lines. K9 done 13:00:17 GMT, well before 15:30.
- **K10 C14b PASSED (time not pasted):** `billingGuard` = `1  60  256Mi`, function account and trigger account both `hireframe-billing-guard@…`, topic `projects/hireframe-f6b03/topics/billing-guard`, `RETRY_POLICY_DO_NOT_RETRY`. (A `gcloud components update` notice also printed; ignored.)
- **K10 C39a/C39b PASSED, 14:13:40 GMT:** one trigger in `europe-west2` (`billingguard-051487`, account `hireframe-billing-guard@…`, topic `projects/hireframe-f6b03/topics/billing-guard`; its `SERVICE` cell printed empty), none in `global`. All 13 other functions show `hireframe-fns@…` and no event trigger account; `billingGuard` shows `hireframe-billing-guard@…` for both. No row shows `<NUM>-compute@…`.
- **K11 PASSED, 14:15:45 GMT:** C1 `30 7,17 * * 1-5`, `Europe/London`, `hireframe-fns@…`. C2 `scheduledscan` invoker = only `serviceAccount:hireframe-fns@…`. C3 three jobs, all ENABLED, all `hireframe-fns@…`: `purgeOldData` `30 3 * * *`, `scheduledScan` `30 7,17 * * 1-5`, `generateCvs` `*/10 7-23 * * *`.
- **K12 env read, 14:18:49 GMT:** `billingGuard` environment variables = `EVENTARC_CLOUD_EVENT_SOURCE`, `FIREBASE_CONFIG`, `FUNCTION_REGION`, `FUNCTION_SIGNATURE_TYPE`, `FUNCTION_TARGET`, `GCLOUD_PROJECT`, `LOG_EXECUTION_ID`. **No `BILLING_GUARD_MODE`**, so the guard is in dry run.
- **K12 log reads at 14:21:41 and 14:24:26 GMT: empty, but no publish had been run yet** (the terminal shows only the env read, then these two reads). Not a delivery failure; the below-threshold publish is still to do.
- **K12 below-threshold publish, 14:30:54 GMT:** `costAmount` 1 of 25 published, `messageIds` one id (`23096956820808902`). Log read 14:31:08 GMT: `2026-11-05T14:31:00.794816Z INFO billing_guard.below mode=dry_run` (about 6 s after the publish), plus three INFO rows with no event field (14:30:58 x2, 14:31:00 x1). **Push delivery works with the K6 grants removed**, so Recovery B is not needed (no guard-level `tokenCreator` grant; project-level none). The £30 publish is next.
- **K12 over-threshold publish, 14:32:04 GMT:** `costAmount` 30 of 25, `messageIds` one id (`23101196282534264`). Log read 14:32:13 GMT: `2026-11-05T14:32:07.684469Z WARNING billing_guard.would_disable mode=dry_run` (about 3 s after the publish). `gcloud billing projects describe` → `billingEnabled` **True**. **K12 PASSED.** Live push grant after K12: none (project-level removed at K9, no guard-level grant).
- **K13 done Wed 11 Nov, 16:54 GMT (Beeb; 6 days after K12, outside the 10:00-16:00 window).** Console, all alerts-only, no spend caps. Budget API not needed (not enabled).
  - `hireframe-kill`: £25, 100% actual, Pub/Sub topic `projects/hireframe-f6b03/topics/billing-guard`.
  - `hireframe-2gbp`: £2, 100% actual + forecast.
  - £10 budget kept: 50/90/100% actual **plus a 100% forecast row (added, confirmed 11 Nov).** Emails to billing admins: on. `hireframe-2gbp` emails to billing admins: on.
  - **Deviations from plan K13 / Decision 10, accepted by Beeb (11 Nov):** (1) no separate £5 budget (the £10 budget's 50% actual row covers it; the £5 forecast alert is gone); (2) scope "All projects (1)" = `hireframe-f6b03` only, because the console would not let Beeb pick the project explicitly (plan and RUNBOOK say "this project"); (3) K13 ran outside the window, console only, harmless.
  - **Re-check before v1.0.1:** `hireframe-kill`'s scope if another project ever joins this billing account, because its spend would count toward the kill budget when the guard is armed. Parked on the planner item in STATUS.
  - **Topic policy read, 11 Nov ~17:0x GMT (Beeb):** `billing-guard` has only `roles/pubsub.publisher` for `serviceAccount:billing-budget-alert@system…` (Google's budget publisher). No other bindings. The K13 link added that publisher; no project-level IAM change.
  - **Post-K13 scan check:** tonight's 17:30 scan counts if System shows Succeeded (result to record).
- **Resumed Thu 19 Nov, 13:45 London (nothing done 12-18 Nov).** C47's 24 h window (due Thu 12 Nov 16:54) passed unread: deviation, recorded. Release windows stay London time (STATUS working rule).
- **Step 1, post-K13 health PASSED (Beeb, 19 Nov):** 12 of 12 scheduled scans Succeeded from Wed 11 Nov 17:30 to Thu 19 Nov 07:30 (none Partial or Failed, none missing). Morning digests arrived on 12, 13, 16, 17, 18 and 19 Nov. Covers plan step 10 / RUNBOOK line 558 with eight days of margin.
- **Step 2, C47 read, Thu 19 Nov (Beeb, `--freshness=8d --limit=50`):** 13 rows, all `billing_guard.below` with `mode: dry_run`, about every 22 min today; latest 2026-11-19T14:34:21Z, **earliest 2026-11-19T10:10:04Z**. No `.invalid` or `.ignored` in those rows. Real budget messages are parsed (the C47 point). **Open:** (a) no rows at all between K13 (11 Nov 16:54) and 19 Nov 10:10Z, although the read window is 8 days and 13 < the limit of 50; cause unknown (Google says the first notification can take hours, not days). (b) The 8-day check for `invalid|ignored|would_disable|disabled|error` was left as a placeholder in Beeb's message: result pending. C47 not marked passed until both are answered.
- **Step 2 follow-up, Thu 19 Nov (Beeb):** rows per day for `billing_guard.*` events over the 8-day window: 11 Nov 18, 12 Nov 58, 13 Nov 56, 14 Nov 61, 15 Nov 68, 16 Nov 67, 17 Nov 56, 18 Nov 51, 19 Nov 35 (to ~14:35 London). Messages flowed every day from K13 on; the "gap" I flagged was wrong: it rested on reading "13 rows shown" as the whole result of a `--limit=50` read, but the first read was a summary, not the full table. The 11 Nov rows (18) all fall after K13 (16:54), so the first real messages arrived within hours. Check for `invalid|ignored|would_disable|disabled` or any severity >= WARNING over 8 days: **empty (none)**. **C47 PASSED** (substance within 24 h of K13; the read itself was done 8 days late). Budget API not used, so plan step 11 does not apply.
- **Step 5, Scan now, Thu 19 Nov (Beeb):** System → Scan now: run row **Succeeded**, ended 14:46 London (start time not noted).
- **Step 6, `digestNow`, Thu 19 Nov (Beeb):** Executions **Completed**; `digest.now` `isoWeekday` = 4 (Thursday, London); the email arrived in the inbox (not Spam) and was the real digest. **PASSED.**
- **Step 7, scheduler list, Thu 19 Nov (Beeb):** three jobs, all ENABLED: `purgeOldData` `30 3 * * *`, `scheduledScan` `30 7,17 * * 1-5`, `generateCvs` `*/10 7-23 * * *` (all Europe/London). **PASSED.**
- **Stop, Thu 19 Nov (Beeb, reported Sun 22 Nov 12:40 London):** Beeb left partway through step 8. The 8b application (started after step 7) was believed to have reached Ready; the logs later showed it **blocked** (see the 23 Nov entries below). Start time not noted (about 15:29 London from the logs). **Step 8 (live site + console, C7) not done. 8b file check (DOCX and PDF opened) not done. 8c not done.** No Apply pressed, no second application, nothing else changed since. Main has only docs commits after the v0.9.1 tag (`git log v0.9.0..origin/main`, checked 22 Nov), so the deployed build is still v0.9.1.
- **8b log read (Beeb pasted 22/23 Nov; London = UTC):** `application` function POSTs, all 200: 2026-11-19 15:29:26Z, 15:30:53Z, 15:31:20Z (probably Start application, then two answers; not confirmed by name). `generateCvs` passes every 10 min: `pending` 0 up to the 15:30:01Z pass; **15:40:01Z pending 1 → `cv_worker.job` outcome `retry` (attempt 1); 15:50:01Z pending 1 → `cv_worker.job` outcome `blocked` (attempt 2)**; from 16:00:01Z pending 0 through 16:50:01Z (end of the 14:50–17:00Z window the read covered). No `outcome: ready` row and no `cv_worker.failed` row in that window. Scheduler list re-read (8c content): three jobs ENABLED. **Conflict:** Beeb recalls the application reaching Ready, but the logs show it blocked after two attempts within this window. Either it was retried later (after 17:00Z) or it is blocked. **8b is a stop until resolved** (plan 8b: any CV problem is a stop; planner diagnoses first).
- **8b resolved as BLOCKED, not Ready (Beeb, Mon 23 Nov):** all worker job outcomes since Thu 19 Nov 15:00Z: `15:40:14Z cv_worker.job retry attempt 1 issues=unsupported_text`; `15:50:10Z cv_worker.job blocked attempt 2 code=invalid_output`; nothing after. The card is back in **Chosen** (since 19 Nov) with "The model's drafts didn't pass the fact checks, twice. Retry to try again, or add a fact on Profile that covers what was missing." Retry **not** pressed. Pipeline: Chosen 1, Needs input 0, Generating 0, Ready to send 2, Applied this week 0. Beeb's "reached Ready" memory was most likely the 2 older Ready applications. Planner diagnosis requested by Beeb before any retry (running). **No retry until the planner's report is read.**
- **Planner diagnosis (23 Nov):** fact-check block, not a render problem. `unsupported_text` is the exact-word check on headings, education lines and skill labels (`packages/shared/src/cv.ts`, ADR-054 accepted risk); it runs on the parsed output before the renderer loads; no `cv_worker.failed` was logged. On `main` the retry is told only the issue codes (blind re-roll); PR #42 adds the failing path and removal clamps. `git diff v0.9.0..v0.9.1` (checked by Claude) touched no validator, prompt or schema: `docx.ts` type-only refactor (`IRunOptions`), `config.ts` billingGuard constants. Retry cost about 4.3p per call, at most 2 attempts (~18p), inside the 60p/day cap; no self-triggering risk. Attempt 2's codes are on the card ("Last check failed because: …"), not in the log.
- **Decision (Beeb, 23 Nov): option 1, conditional.** Accept the 3 Nov Ready CV (docx 9.15, render check PASSED, the I7-lite row (3 Nov)) as 8b's render proof **only if** it was generated after the successful v0.9.1 functions deploy (K7 attempt 2: approved 12:35, finished 12:42 on 5 Nov). Compare the card's generation time with the deploy time. If it was before: do the local dev-worker run plus one live Retry after #42 has shipped. Check pending.
- **Timing check, Mon 23 Nov (Beeb's pastes; clarified rule: the Ready CV must come from the `generateCvs` code deployed now, so any Ready time after `generateCvs`'s `updateTime` counts, even if that is 3 Nov):**
  - `gcloud functions describe generateCvs --gen2`: `updateTime` **2026-11-03T13:07:12Z**, state ACTIVE. So the 5 Nov re-run did not redeploy `generateCvs`; the code running now is the 3 Nov v0.9.1 deploy.
  - Every `cv_worker.job outcome=ready` since 3 Nov 00:00Z: exactly one, **2026-11-03T15:50:16Z, attempt 1**. That is 2 h 43 min after `updateTime`, so that CV was rendered by the code deployed now. (The second Ready card is older than 3 Nov.)
  - **Result: rule met. 8b render proof = the 3 Nov Ready CV (render check PASSED, the I7-lite row (3 Nov)).** The 19 Nov application is recorded as a fact-check block (ADR-054 limit), not a render problem. **8b CLOSED with a deviation (no fresh Ready on 19 Nov), accepted by Beeb 23 Nov.** A live Retry waits for #42; not needed for v0.9.1.
- **8c PASSED:** scheduler list re-read after the CV worker had run (pasted 22/23 Nov): three jobs ENABLED (`purgeOldData`, `scheduledScan`, `generateCvs`).
- **Step 8, live site (C7), 24 Nov 11:28 London (Beeb):** signed in, Today loaded. Console: one red error, `POST https://www.google.com/recaptcha/enterprise/pat?k=<site key> 401 (Unauthorized)` from `recaptcha__en.js`. It is Google's script, not our code (nothing in the repo calls it); Beeb believes it is the Private Access Token probe, which I could not confirm from the repo. It was not seen on 3 Nov. Today loaded with data under enforced App Check (SECURITY.md, M1), so tokens worked. **Beeb accepted this as a deviation of C7 ("no console errors"), 24 Nov;** re-check on the next console review (parked in STATUS).
- **G2 summary:** Deploy attempt 2 (re-run) approved 12:35, finished 12:42 London on 5 Nov (about 7 min; attempt 1 ran 13:01-13:07 on 3 Nov and failed). K6 bindings added: all three (`run.invoker` and `eventarc.eventReceiver` on the compute account, `serviceAccountTokenCreator` on the Pub/Sub agent), plus the K6b custom role `hfTmpTopicsCreate091` (deleted at K9). C38b not needed. Live push grant after K12: none (project-level removed at K9; no guard-level grant, because delivery worked). Budget API: never enabled. K14-K18 (24 Nov, another session): evidence goes in #41's K20 commit.
  - **C47 clock starts 11 Nov 16:54; read due by Thu 12 Nov 16:54** (Google: the first notification can take several hours). Scan-now proof moved to Thu 12 Nov morning (plan as of 11 Nov; the C47 read and the proof were both done on 19 Nov).

## Abort path (plan section 8)
If K9 is not done by 15:30 (for example K7 can't be fixed), or any step says stop: run K9 now (remove only the bindings K6 added), then the K9 diff and deployer role check. Nothing else is needed for safety, because the function has no billing role. To remove the function, revert the export in a PR and release a patch. Report to Claude before retrying. Re-adding grants is never wanted.

## Conditional fallbacks (accepted in principle, Decision 5; each shown and approved when needed)
### A. C38b: Eventarc permission error on the K7 create (permanent)
RUNBOOK K7: "If the create fails on an Eventarc permission, grant `gcloud projects add-iam-policy-binding $P --member=serviceAccount:$SA --role=roles/eventarc.developer --condition=None` (C38b), record it in ADR-059 (it stays, because later updates need it too), then re-run." Record here; the ADR-059 line goes into #41's K20 commit (Decision 2). K9's diff then also shows `roles/eventarc.developer serviceAccount:$SA`; deployer roles are 8.
- Used (yes or no) / time: No. The create succeeded on the 5 Nov re-run without it (the deployer stayed on 7 roles).

### B. K12 Recovery: "`billingGuard` logs nothing after a publish"
Grant it on the guard account only (shown in chat first; variables are Part K's setup block):
```bash
gcloud iam service-accounts add-iam-policy-binding $GUARD --member=serviceAccount:$PSA --role=roles/iam.serviceAccountTokenCreator --project=$P
gcloud iam service-accounts get-iam-policy $GUARD --project=$P --format='value(bindings.role,bindings.members)'
```
"The second command must show it beside the deployer's `serviceAccountUser`. Then publish the below-threshold message again and expect `billing_guard.below` within 2 minutes. Rollback: the same command with `remove-iam-policy-binding`. If it still logs nothing, check C46 (the only invoker is `hireframe-billing-guard@…`) and C14b (the trigger's service account). Record the live option in ADR-059."
- Used (yes or no) / time: No. Push delivery worked after K9 removed the project-level grants (5 Nov, 14:31 and 14:32 London); no guard-level grant was added.
