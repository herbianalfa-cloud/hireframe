Status: Report (not a plan), 3 Nov 2026

# v0.9.1 deploy failure: `billingGuard` "Unexpected error creating Pub/Sub topic"

Run 41638473194, tag v0.9.1 (35a4dd4), firebase-tools 15.34.1, deployer `github-deployer@…` (7 baseline roles). Paths below are under `node_modules/firebase-tools/lib/`. Project number is `<NUM>`; `$P`, `$SA`, `$COMPUTE`, `$PSA`, `$GUARD` are the RUNBOOK Part K setup variables. No source, RUNBOOK, ADR or STATUS was edited.

## 1. When does the CLI PUT the topic?
- **Create only.** `createV2Function` reads `apiFunction.eventTrigger.pubsubTopic` and calls `pubsub.createTopic` *before* `gcfV2.createFunction`. Only 409 is tolerated. CONFIRMED: `deploy/functions/release/fabricator.js:416-434` (PUT), `:472` (createFunction). `createTopic` is `client.put(topic.name, topic)`, with no GET first. CONFIRMED: `gcp/pubsub.js:16-19`.
- **Updates never PUT.** `updateV2Function` deletes `eventTrigger.pubsubTopic` and patches the function. CONFIRMED: `fabricator.js:593-595`. `createTopic` has only one caller (`fabricator.js:421`). CONFIRMED by grep over `lib/`.
- **The PUT comes back through delete-and-recreate.** That happens when the topic changes, the trigger region changes, or a v1 schedule moves to v2 (`planner.js:71-76`, then `fabricator.js:315-317`). It also happens if billingGuard is deleted and re-added. CONFIRMED.
- **No skip case.** The PUT is unconditional whenever the topic is set, so an existing topic is not skipped: it only turns a 409 into a pass. There is no flag for this: `--force` and `--only` don't reach this code. CONFIRMED (`fabricator.js:416-417`). Eventarc channels are different: they do a GET first (`:440`).
- **The topic name is well formed.** It resolves to `projects/<project>/topics/billing-guard` (`deploy/functions/runtimes/discovery/v1alpha1.js:276-277`; `functions/src/config.ts:625`). CONFIRMED.
- **billingGuard was never created.** The PUT failed before `createFunction`, so the next deploy is a create again and the PUT happens again. CONFIRMED (order in `fabricator.js:416-472`).

## 2. Permission and likely cause
- **Permission needed.** `projects.topics.create` needs `pubsub.topics.create` "on the containing Cloud project", not on the topic. CONFIRMED: https://docs.cloud.google.com/pubsub/docs/access-control. So a binding on the `billing-guard` topic cannot satisfy it. CONFIRMED by the same row.
- **Order of checks.** Google's API rule says: "Services must check authorization before validating any request". A failed check returns PERMISSION_DENIED (403). CONFIRMED: https://google.aip.dev/211. So a caller without permission gets 403, not 409, even though the topic exists. That Pub/Sub follows AIP-211 here is UNVERIFIED (it is standard practice).
- **Roles that hold it.** Predefined roles with `pubsub.topics.create`: `roles/pubsub.admin`, `roles/pubsub.editor`, plus basic Editor and Owner. CONFIRMED (access-control page). `roles/pubsub.publisher` does not have it.
- **The deployer's roles.** `roles/cloudfunctions.developer` has no `pubsub.*` permission. CONFIRMED: https://docs.cloud.google.com/iam/docs/roles-permissions/cloudfunctions. By their names, none of the other six roles is a Pub/Sub role. UNVERIFIED per role; check 5b settles it.
- **Most likely cause: 403 on `pubsub.topics.create`.** UNVERIFIED, because the log has no status. The other candidates are all unlikely:
  - API disabled (that is also a 403): no, the topic was created in K3.
  - Wrong project: no, the 13 functions updated in the same project.
  - Bad name format (400): no, see above.
  - Quota (429): very unlikely. The executor retries 429s, so it would have retried first (`release/executor.js:17-23, 67-69`).
  - Org policy: UNVERIFIED. It's unlikely for a PUT on an existing topic with an empty body.
- **Why the spike didn't catch this.** The spike never ran this path. It deployed with `gcloud functions deploy … --trigger-topic` as Beeb's own account in the throwaway project, not with firebase-tools as the restricted deployer. CONFIRMED: `m8c-plan.md:288` (C28) and `m8c-spike-results.md:16`. The m8c-plan review covered `checkIam.js` (finding 1) but not the fabricator's PUT. This plan assumption was wrong: the decision is Beeb's.
- **A possible next blocker.** `cloudfunctions.developer` already includes `eventarc.triggers.create` (same roles page), so the C38b fallback is probably not needed. Whether `createFunction` with an existing-topic trigger then needs any caller-side Pub/Sub permission is UNVERIFIED. If it fails, the error will name the permission.

## 3. Fix options
**(a1) Temporary project binding of a one-permission custom role (recommended).**
- One-time role definition (Beeb, owner):
  `gcloud iam roles create hireframeTopicCreate --project=$P --title="Hireframe first-create topic PUT" --permissions=pubsub.topics.create --stage=GA`
- Grant: `gcloud projects add-iam-policy-binding $P --member=serviceAccount:$SA --role=projects/$P/roles/hireframeTopicCreate --condition=None`
- Remove: the same command with `remove-iam-policy-binding`.
- Scope: project-level, which is the narrowest scope that works. The deployer can create topics, but can't publish, delete or attach.
- Risk while held: the deployer could create stray topics, which is harmless.
- Rollback: remove the binding. Optionally `gcloud iam roles delete hireframeTopicCreate --project=$P`; the ID stays reserved for a while (UNVERIFIED how long).
- Later updates: not needed (§1). Needed again only for a delete-and-recreate or another new Pub/Sub function, so keeping the role definition unbound costs nothing.
- Posture: no standing privilege after removal, and the K9 diff stays empty.
- No-self-trigger: unaffected (no code change).

**(a2) The same window with `roles/pubsub.editor` instead.** One command less, but while held the deployer can also publish to `billing-guard` (forged budget messages) and delete topics, including `billing-guard`. Harmless only because the guard is in dry run with no billing role. Not recommended.

**(a3) A topic-level binding on `billing-guard`.** Does not work: `topics.create` is checked on the project (§2).

**(b) A permanent custom role binding.** It works, but it is a standing privilege that ordinary updates never use (§1). It goes against ADR-059's "no new standing privilege" and the K9 baseline of 7 roles. Not recommended.

**(c) Avoid the PUT in code or config.** No supported route was found:
- `onMessagePublished` always sets `pubsubTopic`, and no CLI flag skips the PUT (§1).
- Switching to an HTTP function fed by a push subscription, or to an Eventarc custom channel, is an architecture change (ADR-059) and a decision for Beeb. Not recommended.
- Patching firebase-tools is not recommended either: it's vendored, and the change would be lost on upgrade.
- Whether a newer firebase-tools does a GET before the PUT is UNVERIFIED.

**(d) Create billingGuard once outside the CLI** (`gcloud functions deploy` as owner, like spike C28), so that later CLI deploys only update it. This breaks the CI-only deploy rule (ADR-014). The function would also lack Firebase's labels and hash, so behaviour on the next CLI deploy is UNVERIFIED. Not recommended.

## 4. Re-running the failed job on v0.9.1
- **Same commit and ref.** A re-run uses "the same `GITHUB_SHA` … and `GITHUB_REF`" and is allowed "up to 30 days after its initial run" (so until about 3 Dec). CONFIRMED: https://docs.github.com/en/actions/how-tos/manage-workflow-runs/re-run-workflows-and-jobs. WIF trusts v* tags plus `production`, so OIDC should pass (`.github/workflows/deploy.yml:3-5`). Approval in `production` is probably asked again: UNVERIFIED, but RUNBOOK:245 says "approve again if asked".
- **The re-run is idempotent and safe:**
  - The 13 functions are skipped if their hash is unchanged (`planner.js:28-32`); otherwise they are re-updated with identical code, which is harmless.
  - Rules and Hosting re-release the same content.
  - There are no deletes.
  - billingGuard goes down the create path.
  - CONFIRMED (code). The same "Re-run failed jobs" pattern worked for earlier tag deploys (RUNBOOK:245, 332, 567).
  - The plan's "unverified re-run" (`v0-9-1-plan.md:153`) is about re-running v0.9.0 as a *rollback*, not this case.
- **Don't move the tag or cut v0.9.2.** The code is unchanged. A v0.9.2 would ship whatever is on `main` then and needs a CHANGELOG entry. Use it only if the re-run is refused or past 30 days.
- **K6 must be redone first.** `ensureServiceAgentRoles` adds the 3 bindings whenever no event-triggered function exists yet (`deploy/functions/checkIam.js:139-155`). billingGuard doesn't exist, and the deployer can't `setIamPolicy`. Without K6 the re-run fails in prepare with "We failed to modify the IAM policy". CONFIRMED (code).
- Keep the plan's pre-checks: weekday 10:00-16:00, digest arrived, nothing Generating.

## 5. Read-only checks (Beeb's bash tab, Part K setup block loaded)
On 3 Nov London time is GMT, so 13:01-13:07 London is 13:01-13:07 UTC.

**5a. Audit log of the PUT.** CreateTopic is an Admin Activity (`ADMIN_WRITE`) entry, which is always on, kept 400 days and free; Data Access logs are not needed. CONFIRMED: https://docs.cloud.google.com/pubsub/docs/audit-logging. Whether denied calls are written there is UNVERIFIED, though usual.
```bash
gcloud logging read 'protoPayload.serviceName="pubsub.googleapis.com" AND protoPayload.methodName="google.pubsub.v1.Publisher.CreateTopic" AND timestamp>="2026-11-03T12:55:00Z" AND timestamp<="2026-11-03T13:10:00Z"' --project=$P --format='table(timestamp,protoPayload.authenticationInfo.principalEmail,protoPayload.status.code,protoPayload.status.message,protoPayload.authorizationInfo.permission,protoPayload.authorizationInfo.granted)'
```
- **Confirms:** a row for `github-deployer@…` with status code `7` (PERMISSION_DENIED), permission `pubsub.topics.create`, granted False or empty.
- **Refutes:**
  - code `6` would be ALREADY_EXISTS (a 409, which should have passed);
  - code `8` or `3` would be quota or a bad argument;
  - no row means the request was refused before IAM (API or org policy). In that case, drop the `methodName` term and filter `protoPayload.status.code=7`.

**5b. Do the deployer's 7 roles hold any Pub/Sub permission?**
```bash
for r in cloudfunctions.developer cloudscheduler.admin datastore.indexAdmin firebase.viewer firebasehosting.admin firebaserules.admin serviceusage.serviceUsageConsumer; do echo "== $r"; gcloud iam roles describe roles/$r --format='value(includedPermissions)' | tr ';' '\n' | grep '^pubsub\.topics\.create$'; done
gcloud pubsub topics get-iam-policy billing-guard --project=$P --format='value(bindings.role,bindings.members)'
```
- **Confirms:** seven `==` headers with nothing under them, and no `$SA` line on the topic.
- **Refutes:** any `pubsub.topics.create` line. Then the cause is not IAM: go back to 5a.

## Recommendation
Run check 5a and 5b first (read-only, a few minutes). If they show the 403 on `pubsub.topics.create`, use **(a1)**: a one-permission custom role, bound to the deployer at project level only for the re-run, and removed in K9 together with the K6 grants. Project level is the narrowest scope that works, because topic-level bindings don't count for create. A single permission avoids pubsub.editor's publish and delete powers on `billing-guard`. Later billingGuard updates don't PUT, so nothing has to stay. The fix needs no code change and no new tag: re-running run 41638473194 is idempotent. ADR-059 and the RUNBOOK K6/K9 text need a later docs update that names the new temporary binding ("K6b"); that's Beeb's decision. Nothing here touches the no-self-triggering rule.

## Retry-day steps
1. Beeb-runs: checks 5a and 5b (any day). Paste only the codes and permissions.
2. Beeb decides: (a1) or another option; then Claude-edits: the evidence doc (deviation, decision) and a STATUS Decisions line.
3. Beeb-runs: release-day pre-checks (weekday 10:00-16:00, digest arrived, nothing Generating). `flat` diff against `~/iam-before-091.txt` is empty; C43 shows 7 roles.
4. Beeb-runs: `gcloud iam roles create hireframeTopicCreate …` (one time). Check `describe`: it lists only `pubsub.topics.create`.
5. Beeb-runs: **K6** again (the 3 bindings; the read prints 3 lines), then **K6b**: the `add-iam-policy-binding` for `$SA` with the custom role. Note the time; the K9 deadline is 15:30.
6. Beeb-runs: Actions, run 41638473194, **Re-run failed jobs**, approve `production`.
7. Claude-edits: none. Claude reads the log and expects `functions[billingGuard(europe-west2)] Successful create operation`.
   - Another failure: **abort path, K9 now** (step 9 including K6b), then diagnose.
   - An Eventarc permission error: C38b (approve first).
8. Beeb-runs: **K8** (invoker plus C46). Wait at least 2 minutes before any K12 publish.
9. Beeb-runs: **K9**: remove the 3 K6 bindings **and** K6b. The `flat` diff is empty and C43 shows 7 roles.
10. Beeb-runs: K10, K11, K12, K13, Scan-now proof; then C47 within 24 h and the post-K13 check, as planned. Claude-edits: the evidence doc after each step.
11. Beeb decides: keep the unbound custom role, or delete it. Claude-edits: the ADR-059 and RUNBOOK K6b note in the docs PR (#41 / K20).

## Could not verify
- The real HTTP status: the CI log omits it (checks 5a and 5b).
- That Pub/Sub checks IAM before existence for CreateTopic (AIP-211 says it should).
- Whether denied Admin Activity calls are written to the audit log for this method.
- The permissions of the six non-Functions deployer roles (5b covers it).
- Whether `createFunction` with an existing-topic trigger needs any further caller permission after the PUT passes.
- Whether `production` approval is asked again on the re-run, and whether the 13 functions' hashes match on rebuild.
- How long a deleted custom role ID stays reserved; whether a newer firebase-tools does a GET before the PUT.
- That no org policy applies to the project.
