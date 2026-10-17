# PR #41 review (M8 8C2, draft): findings only, nothing changed

## Context
I reviewed `git diff main...origin/feat/m8c2-hardening` at head 7360ad6. The merge base is `main` (3310a34), and the local branch matches origin. I checked it against the CLAUDE.md hard rules, SECURITY.md, `m8c2-plan.md`, `m8c-plan.md` §4 and `m8c-spike-results.md`, on the nine checks you named.

Line numbers refer to the files on the branch. Claims about firebase-tools were checked in `node_modules/firebase-tools` 15.32.1. I replayed the source scan's logic in memory with `node -e`; no files were written.

## High
None.

## Medium

**M1. Two pre-deploy SECURITY items are marked for the follow-up PR, so no step ticks them.**
- Where: `docs/SECURITY.md:48` (secrets, C34/K15) and `:49` (keys, C48/K14) both say "pending K25–K28".
- Why it's wrong:
  - K14 and K15 run in Phase 3, before K20.
  - The section's intro (`:47`) and plan item 4 (`m8c2-plan.md:21`) keep that marker for evidence that needs the v1.0.0 deploy.
  - The first-deploy item for the same evidence says "pending K15" (`:41`).
- Result: K20 ticks only "pre-deploy" items (`RUNBOOK.md:596`). K28's follow-up PR ticks only "C50, K26, K27, K28 and C41" (`RUNBOOK.md:643`). Both items fall through.
- Fix:
  - Drop "pending K25–K28" from `:48` and `:49`; K20's evidence commit ticks them.
  - For the invoker audit (`:50`: K16, then again at K27), choose one: tick it at K20 and re-confirm at K27, or keep it pending and add C49 to K28's list.

**M2. Once the guard is armed, "Billing was disabled" would trip again after the relink.**
- Where: `docs/RUNBOOK.md:734`.
- Why:
  - The rule keeps no state (`functions/src/billing/decide.ts:23`). Any message whose month-to-date cost is at or above £25 disables billing.
  - Messages arrive several times a day, so a relink in the same month is undone within hours.
  - "Find the cause" only tells apart the guard, a manual unlink and a card problem. It never finds or stops what spent the money.
- Fix, before the relink:
  1. Find what spent (Billing → Reports by service and SKU, and `usage/{yyyy-mm}`) and stop it.
  2. Stop the guard tripping again this month. Either raise `hireframe-kill` above the month's cost, or remove the guard's `roles/billing.projectManager`. Show it in chat first, record it, and restore it deliberately: next month, or once the budget is raised.
- Fix, after the relink:
  - Run `gcloud scheduler jobs resume <job> --location=$R --project=$P` for any job that isn't ENABLED.
  - Run K27's C14 table to confirm all 14 functions still exist.
- This must be fixed before v1.0.1 arms the guard.

**M3. ADR-060 and SECURITY claim more than the Editor removal delivers.**
- The deployer must keep `serviceAccountUser` on the App Engine default account. firebase-tools checks actAs on it in every functions deploy (`commands/deploy.js:76-77` calls `checkIam.js:31-35`), so that grant can't be dropped.
- That account still holds Editor (parked in the ROADMAP).
- So a stolen deploy path can still deploy code that runs with Editor. Once the guard is armed, that includes publishing a forged kill message.
- ADR-059 accepts Editors as publishers "until 8C2 removes Editor" (`DECISIONS.md:791`), but 8C2 doesn't remove this one.
- Once armed, the deployer can also act as the guard (K5) and unlink billing directly. No accepted-risk line covers this.
- Where:
  - `docs/DECISIONS.md:814` ("can no longer use the compute account…");
  - `:800` (the v1.0.1 preconditions);
  - `docs/SECURITY.md:25` ("shrinks who can publish");
  - `docs/SECURITY.md:26`.
- Fix:
  - Name this remaining path in ADR-060's Consequences and in both SECURITY rows.
  - Add two v1.0.1 preconditions:
    - "the App Engine default account's Editor is removed, or accepted with a reason";
    - a project-level publisher read: `gcloud projects get-iam-policy $P --flatten='bindings[].members' --filter='bindings.role=(roles/owner roles/editor roles/pubsub.publisher roles/pubsub.editor roles/pubsub.admin)' --format='value(bindings.role,bindings.members)'`.
  - Add "the deployer can act as the guard" to ADR-059's accepted risks.
  - Moving the App Engine Editor removal out of the parking lot widens scope, so that's Beeb's call.

## Low

**L1. The source scan doesn't see some import shapes. Only the count rule catches them, and the self-check never tests that rule.**
- Where: `functions/src/index.test.ts:417` tests `element.name.text`, which is the local name.
- These all return `{"problems":[],"calls":0}` in my replay:
  - an aliased import (`import { onCall as call }`);
  - a namespace import (`import * as https`, then `https.onCall(…)`);
  - a trigger re-exported through a local module;
  - `beforeUserCreated`.
- The count check at `:522` is the only guard against these, and the self-check block below it never runs it.
- Fix:
  - Test `(element.propertyName ?? element.name).text` against `/^on[A-Z]/`, and record the local name.
  - Treat a namespace import from `firebase-functions*` as a trigger namespace and check its `ns.on*()` calls.
  - Add self-check cases for both.
  - Move the count rule into a helper that takes several sources, and self-check it with a two-export sample.

**L2. ADR-060 and the new Recovery entry get wrong when the CLI's IAM step runs.**
- `docs/DECISIONS.md:814` says a new Pub/Sub function's first deploy "still needs the CLI's IAM step". In firebase-tools 15.32.1 that isn't so:
  - `ensureServiceAgentRoles` (`checkIam.js:139-160`) asks for bindings only for event services that aren't deployed yet.
  - It asks for the compute and Pub/Sub agent bindings only when no event function exists (`:152`).
  - `billingGuard` already makes Pub/Sub a deployed service.
- The Recovery entry (`docs/RUNBOOK.md:741`):
  - says "for any first event-triggered function";
  - removes every binding the CLI asked for;
  - diffs "as in K9" but never says to take a snapshot first.
- For a first Storage trigger, the CLI asks for the Cloud Storage agent's `roles/pubsub.publisher` (`services/storage.js:13,30`). Removing it afterwards stops that trigger's events.
- Fix:
  - Scope both texts to: "only when no event function is deployed (for example, `billingGuard` was removed), or for the first function of a new event service such as Storage".
  - In the Recovery entry, add "take a `flat` snapshot first (K2)" and "the Storage agent's publisher binding stays".

**L3. Nothing checks that the conditional `objectViewer` grant kept its condition.**
- K23's check (`docs/RUNBOOK.md:614`) reads C51 with `value(bindings.role)`. K26's diff (`:629`) uses `flat`, which prints only the role and the member.
- Both print the same line for a conditional and an unconditional `roles/storage.objectViewer`. If the condition were lost (for example, a quoting slip on `:612`), both checks would still pass. The compute account could then read every bucket, the CV uploads included.
- The plan's K23 check named the title `gcf-sources` (`m8c2-plan.md:273`), but the RUNBOOK dropped it.
- Fix: at K23, and again at K27, run `gcloud projects get-iam-policy $P --flatten='bindings[].members' --filter="bindings.members:serviceAccount:$COMPUTE AND bindings.role=roles/storage.objectViewer" --format='value(bindings.condition.title,bindings.condition.expression)'`. It must print `gcf-sources` and the `startsWith("projects/_/buckets/gcf-v2-")` expression.

**L4. "Rollback the Editor removal" mixes rolling back with fixing forward, and doesn't say the proof is then lost.**
- Where: `docs/RUNBOOK.md:736-740`.
- After C40 and a re-run, the failed functions were built with Editor, so Path F is still unproven:
  - K26's diff will fail.
  - A retry needs K24 again and a new bundle change, because a re-run skips unchanged functions ("Every release" item 8).
- For a 403 on `gcf-v2-*`, fixing forward keeps the proof: leave Editor off, add the per-bucket grants, wait 2 minutes, then re-run.
- Fix: split the entry in two:
  - (a) 403 on `gcf-v2-*`: per-bucket grants, no Editor, re-run.
  - (b) Anything else: C40, re-run, then record "Path F unproven; redo K24 with the next bundle change", and leave the SECURITY item unticked.

**L5. K19 points at "the R1–R12 pointers in the PRD", which don't exist.**
- Where: `docs/RUNBOOK.md:595`. `docs/PRD.md` has R1–R12 sections but no evidence pointers.
- The plan's mapping (`m8c2-plan.md:314-317`) was dropped: R7 by step 97; R4 and R12 by the v0.9.0 clean weekday and the Scan-now proof; R11 by the cap test.
- Fix: write that mapping into K19, or under the SECURITY release gates.

**L6. Two SECURITY items name no evidence, although the intro (`:47`) says every item does.**
- `docs/SECURITY.md:57` (budgets): the evidence is K13, which isn't cited.
- `:58` (card, passkey and recovery): no RUNBOOK step records it.
- Fix: cite K13 on `:57`. Add a line to K19 that records the owner's card, passkey and recovery check with its date, and cite that line on `:58`.

**L7. Two older lines now contradict ADR-060.**
- `docs/DECISIONS.md:152` says "M8 replaces the compute-account grant with a dedicated Cloud Build account".
- `docs/RUNBOOK.md:128` (step 23) says "M8 moves builds to their own account".
- The new ADR-017 addendum (`:154`) doesn't supersede that line, as the ADR-059 addendum does for its own (`:798`).
- Fix:
  - End the ADR-017 addendum with "ADR-060 supersedes the last line above: there is no dedicated build account, and the deployer keeps the compute-account grant".
  - Reword step 23's sentence to point at ADR-060.

**L8. "Every release" leaves out new non-callable HTTPS functions.**
- Where: `docs/RUNBOOK.md:649` covers callable, scheduled and event functions only.
- A new `onRequest` function needs Part G step 80's temporary `roles/cloudfunctions.admin` for its first deploy, then step 28's `allUsers`.
- Fix: add that case.

**L9. K28's scheduler read has no `--project`, and the setup block never sets one.**
- Where: `docs/RUNBOOK.md:643`. `gcloud scheduler jobs describe firebase-schedule-generateCvs-europe-west2 --location=$R --format=…` (copied from plan §5) is the only K14–K28 command without `--project=$P`.
- K1, K21 and K27 also reuse step 77's commands, which have none either. The setup block (`:497-506`) never runs `gcloud config set project`.
- Fix:
  - Add `--project=$P` to that command.
  - Add `gcloud config set project $P` to the setup block.
  - Say that an empty `status` means the last attempt succeeded.

**L10. The table test's `pubsub` kind accepts any event trigger.**
- Where: `functions/src/index.test.ts:497` sets `pubsub` whenever `eventTrigger` is present.
- A future Firestore or Storage trigger would pass as `pubsub`; only `billingGuard`'s own test checks the event type. That weakens the table as a guard for the no-self-triggering rule.
- Fix: for `pubsub`, require `eventTrigger.eventType === 'google.cloud.pubsub.topic.v1.messagePublished'`, and add `eventType` to `FullEndpoint`.

## Nit
- **N1** `functions/src/index.test.ts:558` and `docs/plans/m8c2-handoff-a.md:45`: "flags it as anonymous" is wrong.
  - The owner is `make` (my replay prints `a.ts: make (onCall)`).
  - The sample fails only because `{}` is empty; a wrapper with complete options passes.
  - Rename the test and add a truly anonymous sample (`export default onCall({…})`).
- **N2** `index.test.ts:439-447`: a spread placed after the literal (`{ maxInstances: 1, timeoutSeconds: 60, ...wide }`) passes the scan (replayed). Only the table test catches a widened value. Flag any spread that comes after either key.
- **N3** `index.test.ts:352` and `:402`: `FullEndpoint` and `exported` duplicate `Endpoint` and `endpoints` in the same file (`:12`, `:23`). Extend those instead.
- **N4** `functions/src/scan/store.ts:19`: `type ScanLock` breaks the alphabetical import order; it belongs after `type Quota`.
- **N5** `functions/src/scan/store.test.ts:74-79` has no `rescore` row, but `CHANGELOG.md:13` says "for each lock holder". Add the row (12 min) or reword. `CHANGELOG.md:6` and `:12`: elsewhere in the file (0.9.1), and in Keep a Changelog, Added comes before Changed.
- **N6** `docs/RUNBOOK.md:629`: the check is written with `-` and `+`, but plain `diff` prints `<` and `>`. Use `diff -u`.
- **N7** `docs/RUNBOOK.md:647`: "never Sun 25 Oct" doesn't belong in a permanent checklist. A Sunday isn't a weekday anyway, and the point is the clock change, so say "never on a UK clock-change day". `:650`: "exactly three jobs" will go out of date; say "one per scheduled function in `EXPECTED` (three today)".
- **N8** `docs/RUNBOOK.md:586`: "the next scan succeeds" after each disable means waiting for a scheduled scan, which runs twice a day. Say "Scan now succeeds", run 5 minutes apart because of the cooldown. Also add "the next Apps Script `run` is 2xx", because the app checks don't cover the Gmail bridge.
- **N9** `docs/RUNBOOK.md:607`: if the prefix doesn't match, `grep '^gcf-v2-'` prints nothing, so the per-bucket variant has no bucket names. In that case, list all buckets.
- **N10** `docs/RUNBOOK.md:591`: K18's rollback (from 0 back to the old value) is a quota increase request and may need approval. Say so; it's harmless, because nothing uses Compute Engine CPUs.
- **N11** `docs/RUNBOOK.md:507`: after K23 the project policy contains a condition. From then on, a project-level `add-` or `remove-iam-policy-binding` without `--condition` is refused (non-interactive) or prompts. Worth one line in Part K's rules.
- **N12** `docs/RUNBOOK.md:624`: K25's failure branch only covers build failures. A failure in prepare deploys nothing, and C40 doesn't fix it; point at the Recovery entries for a disabled API or a 403. Also `:642`: K27's "C40 if the runtime breaks" can't help, because nothing runs as the compute account. Point invoker faults at K1's Recovery entries and dry-run faults at K12's.
- **N13** `docs/RUNBOOK.md:580`: K16's fix pointers only cover a missing binding. An extra member needs `gcloud functions remove-invoker-policy-binding <fn> --region=$R --member=<member> --project=$P`, shown in chat first.
- **N14** `docs/RUNBOOK.md:643`: "summarised in the PR" should repeat K14's rule: role lists only, members as `$VAR`, never the `user:` line. The PR is public.
- **N15** `docs/DECISIONS.md:798`: say both roles are granted on the project, as in the spike. `docs/plans/m8c-spike-results.md:20` still says "Decision pending (Beeb)"; point it at the addendum.
- **N16** Neither handoff nor the PR body records the red-first runs the plan asks for (`m8c2-plan.md:108-110` and `:350`):
  - the lock tests failing before the functions existed;
  - the scan failing on a deleted `maxInstances: 1`.

## Checked and clean
1. **Source scan:** the `scheduledScan` → `scanNow` mapping is right in both the scan and the table test. The count rule holds (14 calls, 14 exports). Options built elsewhere (an identifier, or only a spread) are flagged.
2. **Table test:** all 14 rows match the source (timeouts, memory and accounts). Exports equal the table.
3. **Lock refactor:** behaviour is identical in `liveLockHolder`, `acquireOrRefreshWipe` and `acquireLock`.
   - `now == until` is free.
   - A lock with an empty `runId`, or with `staleAt` but no `startedAt`, is not live, as before.
   - `tests/emulator` is untouched, and no other copy of the rule exists in `functions/src`, `packages/shared` or `web/src`.
4. **ADR-059 addendum:** every spike fact it states matches spike results 1, 2, 4, 5 and 6. Option A is recorded, the v1.0.1 preconditions match the plan, and arming stays out of 8C2.
5. **ADR-060:** the three roles and the `gcf-sources` condition match spike result 1 exactly.
6. **RUNBOOK K14–K28:**
   - Every command matches plan §4 or §5, K10 or the spike. The never-disable list is identical to the plan's.
   - The new commands are valid and safe: the C32 list, the K18 diff, the C14 table, the `retention.done` read (it matches the `event` field `log.ts` writes), `rm ~/iam-*.txt`, the billing describe and link, and the 2-day log read.
   - The order is right: K23, then K24, then straight to K25. K17 never uses `--force`, and K18 includes Scan now. K23's rollback keeps the condition.
   - A re-run does rebuild the failed functions: `release/planner.js:27-32` skips only ACTIVE functions whose hash is unchanged.
7. **Recovery:** the commands are correct. "Billing was disabled" reads the billing state and the logs before relinking; M2 is about what's missing after that.
8. **SECURITY ticks:** only the five allowed items are ticked, and each has evidence.
9. **Hard rules:**
   - No secrets or personal addresses in the diff: only service-account addresses that are already in `config.ts`, and "Beeb" is the agreed name.
   - No new function or trigger.
   - No change to `.github`, `scripts` or `package.json`; deploys still run only on `v*` tags.

## Outside this diff
On `main`, `docs/plans/m8-billing-guards.md:41` and `:58` contain "herbianalfa@", the first part of the owner's email address. PR #41 didn't add it, but the repo is public.

## Next step
This was a review only, and nothing will be edited. If you want the fixes:
1. Fix commits on `feat/m8c2-hardening` (`docs:` and `test:`).
2. The 7-step gate.
3. The Opus · High re-review of the fix commits from 7360ad6 (`m8c2-plan.md:338`).

M3 is a scope decision for Beeb before it's written up.
