Status: Draft

# v0.9.1: RUNBOOK K6–K13 and the Scan-now proof (plan)

- **Tier:** portfolio. **Hard area:** yes for the manual steps (IAM and billing: K6–K9, K12 fallback, K13). The repo steps are docs only and not a hard area.
- **Time-box (C4):**
  - G1 (pre-flight + release-prep docs PR): ≤ 1.5 h of Claude time.
  - Release window (Beeb): one weekday, 10:00–13:00 London, target ≤ 3 h. **K6 → K9 ≤ 60 min.** Hard stop: if K9 is not done by 15:30, take the abort path (do K9 now, see section 8).
  - C47: checked ≤ 24 h after K13 (plus one 24 h extension only if Decision 6 allows it).
  - G2 (closeout docs PR): ≤ 45 min.
  - Whole plan: ≤ 3 working days from G1 merge. Over that → C4 check with Beeb.

Sources read: `CLAUDE.md`, `.claude/kit/WORKFLOW.md`, `docs/PROJECT.md`, `STATUS.md`, `.claude/kit.config.json`, `docs/RUNBOOK.md` Part K (lines 495–558) and Recovery (line 629), `docs/DECISIONS.md` ADR-059, `docs/plans/m8c-plan.md`, `docs/plans/m8c-spike-results.md`, `CHANGELOG.md` `[0.9.1]`, `.github/workflows/deploy.yml`, `node_modules/firebase-tools` 15.34.1 `checkIam.js`. `docs/plans/m8c2-plan.md` and ADR-060 are not on this branch or on `main` (they live on PR #41), so this plan cites them only through STATUS.

## 2. Goal and definition of done

**Goal:** release v0.9.1 from `main` (8C1 `billingGuard` in dry run, plus everything merged since v0.9.0), finish RUNBOOK Part K steps K6–K13, pass the Scan-now proof, and see C47 (a real budget message parsed) within 24 h of K13. Nothing here arms the guard or merges PR #41.

**Done when (each item says how it is measured):**
1. **Tag:** `git ls-remote --tags origin v0.9.1` shows the tag, and it points at a commit on `main` that does **not** contain PR #41's head (`git merge-base --is-ancestor 0743bdf v0.9.1` exits 1).
2. **Deploy:** the Deploy run log shows `functions[billingGuard(europe-west2)] Successful create operation` and no "We failed to modify the IAM policy" (RUNBOOK K7). Deploy job time recorded (m8c-plan §6: over 12 min → note it for 8C2).
3. **IAM back to baseline:** the K9 `diff ~/iam-before-091.txt ~/iam-after-091.txt` prints nothing, or only the lines RUNBOOK K9 allows (C38b `eventarc.developer` for the deployer, recorded; Google's `pubsub.serviceAgent` for the Pub/Sub agent, recorded). Deployer roles = 7 baseline (8 with C38b).
4. **Guard shape (K10):** C14b prints `1 60 256Mi`, the guard account twice, `projects/hireframe-f6b03/topics/billing-guard`, `RETRY_POLICY_DO_NOT_RETRY`. C46 prints only the guard as invoker. C39a/C39b: no row on the compute account.
5. **Scheduler unharmed (K11):** C1 `30 7,17 * * 1-5`, `Europe/London`, `hireframe-fns@…`; C2 only `hireframe-fns`; C3 three jobs, all ENABLED.
6. **Dry run (K12, C35):** no `BILLING_GUARD_MODE` in the env; `billing_guard.below` with `mode: dry_run` within 2 min of the first publish; `billing_guard.would_disable` within 2 min of the second; `billingEnabled` still `True`.
7. **Budgets (K13):** Billing → Budgets & alerts lists £2, £5, £10 (100%, actual and forecast, emails on) and `hireframe-kill` £25 (this project, actual cost, topic `projects/hireframe-f6b03/topics/billing-guard`). Beeb confirms each setting in chat (text, no screenshot needed).
8. **Scan-now proof + I7-lite (STATUS Decisions, speed-up policy 2; Beeb 2 Nov):** System shows the Scan now run **Succeeded**; `digestNow` Execution Completed and the email arrives; `gcloud scheduler jobs list --location=europe-west2` shows the three jobs ENABLED. **I7-lite:** one CV generated on the live site; its DOCX and PDF both open and look right (one page, readable, right order). Any CV render problem is a **stop** (the release is not accepted; Claude diagnoses before any retry).
9. **C47:** within 24 h of K13, the RUNBOOK K13 logging read shows a real message as `billing_guard.below`, `mode: dry_run`, never `.invalid`.
10. **Post-K13 (RUNBOOK line 558):** the next scheduled scan succeeds (System) and the next morning digest arrives.
11. **Repo:** G1 and G2 merged; `node .claude/kit/gate.mjs` all 0 on each; STATUS, CHANGELOG and `docs/plans/v0-9-1-evidence.md` record items 1–10.

## 3. Rules that apply
- **WORKFLOW gate 5 / C11:** Claude never merges, tags, deploys or touches IAM or the console, and holds no prod credentials. Beeb runs every `gcloud`, tag, deploy and console step. Every command is shown in chat and approved first (memory: show admin commands, wait for OK; snapshot and diff).
- **RUNBOOK Part K preamble:** only `add-`/`remove-iam-policy-binding`, never `set-iam-policy`; never touch the `user:` owner binding; every member spelled out.
- **STATUS Lessons:** never stop between K6 and K9 (the pre-grant stays on until K9); run Part K in a `bash` tab (zsh misreads `$VAR:`); a new SA can return NOT_FOUND for a minute.
- **Release window:** weekday 10:00–16:00 London, after the morning digest, nothing Generating (RUNBOOK Part K preamble, STATUS).
- **STATUS Decisions:** PR #41 stays unmerged until K20; v0.9.1 is tagged from `main` without it; only tag after `git checkout main && git pull`.
- **C5:** never relax a budget, threshold, cap or test. The K13 amounts are fixed (£2/£5/£10/£25). A failing gate or bundle budget is Beeb's decision.
- **C7 / P2:** live checks after the deploy (K10, K11, Scan-now proof); rollback by tag.
- **CLAUDE.md hard rules:** no secrets and no personal data in the repo. Evidence is pasted as role lists and log tables, never files; no owner email, no `user:` lines, no budget email addresses (`scan:pii` fails on any address not in `scripts/pii-allowlist.txt`; write service accounts as `name@…`).
- **CLAUDE.md working method 6 / no self-triggering:** no code changes here; `billingGuard`'s trigger is a message it cannot cause (ADR-059).
- **Memory:** public repo, no personal details in docs or PR bodies; branches start from `main`, never stacked.
- **Billing Budget API:** stays disabled outside a K step (STATUS Done, 20 Oct).

## 4. PR groups

### G1: pre-flight and release prep (docs only, before the window)
Branch from `origin/main` after `git fetch origin` (the existing `feat/v0-9-1-k6-k13-g1` may be reused; `docs/v0-9-1-release-g1` matches the type better — small decision).

- [ ] **G1.1 Pre-flight on `origin/main` (read-only, no prod access).**
  - Allowed files: none changed (results go into G1.2's evidence doc).
  - Pre-checks: `npm run dev` stopped (STATUS Lesson: `test:rules` port conflict); `nvm use` then `npm ci` (STATUS Lesson); show Beeb `git diff --stat` of the uncommitted `CLAUDE.md`, `STATUS.md`, `docs/PROJECT.md` on the current branch and ask whether they belong in G1 (Decision 9) before anything is staged.
  - Checks to run and record:
    1. `git log --oneline v0.9.0..origin/main`: list every PR that v0.9.1 will deploy (expected: #39 8C1, #46, #49, #53, #54, #55; any other → report).
    2. `git merge-base --is-ancestor 0743bdf origin/main` exits 1 (PR #41 not on `main`).
    3. `git diff --stat v0.9.0 origin/main -- firestore.rules storage.rules firestore.indexes.json` (expected empty: no rules or index change; any line → report, it changes the post-deploy checks).
    4. `node .claude/kit/gate.mjs` (format:check, check), then `npm run build`, `node scripts/smoke-functions-bundle.ts` (`billingGuard` in europe-west2), `npm run check:bundle` (record initial JS gzip; budget ≤ 300 kB — #49 bumped deps on a 295.6 kB base), `npm run test:rules`, `npm run audit`.
    5. `functions/deploy/.env` absent and no `BILLING_GUARD_MODE` in `functions/deploy/` (grep), so prod stays dry run.
    6. Re-verify the K6 rationale on the deployed CLI version: `firebase-tools` in the lockfile on `main` (15.34.1 on this branch; m8c-plan finding 1 was written on 15.32.1). `lib/deploy/functions/checkIam.js` `ensureServiceAgentRoles` still adds the Pub/Sub agent `tokenCreator` and the compute account's `run.invoker` + `eventarc.eventReceiver` when no event function exists, and still throws "We failed to modify the IAM policy" on a failed `setIamPolicy`. (Checked by the planner on 2 Nov: unchanged in 15.34.1, lines 139–190.)
  - Tests to write first: none (no code).
  - Acceptance: every check above exits 0 or matches its expected output; any miss stops G1 and goes to Beeb (a failing budget is Beeb's call, never relaxed).
  - Hard area: no.

- [ ] **G1.2 Evidence and handoff doc.**
  - Allowed files: `docs/plans/v0-9-1-evidence.md` (new).
  - Pre-checks: G1.1 done.
  - Content: the G1.1 results; a row per K6–K13 step, the Scan-now proof, the I7-lite CV check (DOCX and PDF open; a failure is a stop), C47 and the post-K13 check, each with the RUNBOOK reference, the expected output copied from RUNBOOK, a blank "Result (pasted by Beeb)" cell, time started/finished, and a "deviation" cell; the abort path (section 8); the two conditional fallbacks (C38b, K12 Recovery) with the exact RUNBOOK commands; a redaction note (paste role lists and log tables only; no `user:` lines, no email addresses other than allowlisted service accounts written `name@…`; project number written `<NUM>`).
  - Tests to write first: none.
  - Acceptance: every RUNBOOK citation matches `docs/RUNBOOK.md` on `main` word for word for expected outputs; `npm run scan:pii` clean; file ≤ ~300 lines.
  - Hard area: no.

- [ ] **G1.3 CHANGELOG and STATUS.**
  - Allowed files: `CHANGELOG.md` (`[0.9.1]` section only), `STATUS.md`, `docs/plans/v0-9-1-plan.md`.
  - Pre-checks: G1.1 commit list.
  - Change: under `[0.9.1]` add a `### Changed` line for what else ships (Dependabot #46 and #49, kit 3.0.1/3.0.2 with the audit fix #53, docs #54/#55), and set the heading date to the planned release day (Decision 4). STATUS "In progress": plan and evidence links, "K6 next".
  - Tests to write first: none.
  - Acceptance: `[0.9.1]` lists every PR from G1.1 item 1; gate all 0; STATUS ≤ 1 page; no RUNBOOK or DECISIONS edit (Decisions 1 and 2).
  - Hard area: no.

G1 review: `reviewer` (docs only). PR body lists the G1.1 output and "No code; no self-triggering surface changed."

### G2: closeout (after C47 and the post-K13 check)
Branch from `origin/main` after G1 is merged and v0.9.1 is tagged.

- [ ] **G2.1 Fill the evidence doc.**
  - Allowed files: `docs/plans/v0-9-1-evidence.md`.
  - Pre-checks: Beeb has pasted every result in chat; C47 seen (or Decision 6 path taken).
  - Content: results, times, deploy job duration, which K6 bindings were added (so K9's scope is on record), whether C38b was needed, which push grant is live after K12 (project-level none / resource-level on the guard), whether the Budget API was enabled and when it was disabled.
  - Tests to write first: none.
  - Acceptance: every row has a result or an explicit "not done + why"; `scan:pii` clean.
  - Hard area: no.

- [ ] **G2.2 STATUS and CHANGELOG.**
  - Allowed files: `STATUS.md`, `CHANGELOG.md` (`[0.9.1]` date only, if the release day moved), `docs/plans/v0-9-1-plan.md`.
  - Change: STATUS Done "v0.9.1 tagged <date>, K6–K13 done, Scan-now proof passed, C47 seen <date>"; In progress → Phase 3 (K14–K18) next; Pending: "ADR-059 records the live push grant and C38b at K20" (Decision 2); Lessons (one line each) from the window; any RUNBOOK wording fixes queued for the K20 evidence commit or the post-v1.0.0 docs PR (Decision 1).
  - Tests to write first: none.
  - Acceptance: gate all 0; STATUS ≤ 1 page (move old Lessons to `LEARNINGS.md` if over); plan `Status` line left for Beeb.
  - Hard area: no.

G2 review: `reviewer`.

## 5. Decisions

| # | Decision | Options | Recommendation + why | In STATUS Decisions? |
|---|---|---|---|---|
| 1 | **Decided 2 Nov: A.** Edit RUNBOOK on `main` before v0.9.1 (K7 still says "Merge the PR", though PR #39 is merged; step 103 "weekend" wording; spike result 5's 2-minute wait not in K8/K12 text) | A: no RUNBOOK edit now; record the deviations in the evidence doc and fix them in #41's K20 evidence commit or the post-v1.0.0 docs PR. B: edit RUNBOOK on `main` in G1 | **A.** PR #41 rewrites Part K and adds "Every release"; editing it on `main` now means a rebase conflict in a hard-area PR at K20. The deviations are small and recorded. | No (new) |
| 2 | **Decided 2 Nov: A.** Where to record "which push grant is live" and C38b (RUNBOOK K7/K12 say "record in ADR-059") | A: evidence doc + STATUS now; ADR-059 line in #41's K20 evidence commit. B: edit `docs/DECISIONS.md` on `main` in G2 | **A.** #41 already carries an ADR-059 addendum (option A); one edit there avoids a conflict. Trade-off: ADR-059 lags reality until K20 (days). | No (new) |
| 3 | **Decided 2 Nov: A (kept).** v1.0.0 gate for v0.9.1: Scan-now proof + C47 (STATUS In progress) vs a full clean weekday on v0.9.1 (m8c-plan decision 5; speed-up policy item 3 says full gate for releases that change IAM or cost live) | A: Scan-now proof + C47 + RUNBOOK line 558 (next scheduled scan succeeds, digest arrives). B: also a full clean weekday on v0.9.1 | **A.** The C47 wait already spans the next scheduled scan and morning digest, so A covers the scheduler path at no extra time. v0.9.1's IAM change is temporary and diffed back to baseline (K9). Trade-off: weaker than a full day of both scans. | Yes — **re-confirm** (speed-up policy 2–3) |
| 4 | **Decided 2 Nov: A.** Release day | A: first Tue–Thu after G1 merges, start 10:00, K13 done by 13:00. B: any weekday | **A.** Leaves a working day after for C47 and any fix; K13 early keeps the 24 h C47 window ending on a working morning. Friday works but pushes C47 into Saturday. | No (new) |
| 5 | **Decided 2 Nov: A.** Conditional IAM fallbacks during the window: C38b (`roles/eventarc.developer` for the deployer, **permanent**) and the K12 Recovery grant (resource-level `tokenCreator` on the guard) | A: Beeb accepts both in principle before the window; each still shown and approved at the time it is needed. B: decide live | **A.** Both are in RUNBOOK with rollback text; deciding a permanent deployer role mid-window under the K6–K9 clock invites a rushed call. Trade-off: pre-accepting C38b widens the deployer if it is needed. | No (new) |
| 6 | **Decided 2 Nov: A and C.** C47 outcomes | `.invalid` → A: stop, diagnose from the log codes, fix in a small PR on `main` and release v0.9.2 with a Scan-now proof, then re-check C47; B: fold the fix into #41 and move C47 to "before v1.0.1". No message in 24 h → C: extend once by 24 h after checking the budget's topic link in the console; D: treat as failed | **A and C.** A keeps v1.0.0 a single-risk release (Editor removal only, m8c-plan §1) and keeps the C47 evidence ahead of #41's checklist. C because Google says the first notification can take several hours; a second miss → stop and diagnose. | No (new) |
| 7 | **Decided 2 Nov: A (kept).** Billing Budget API during K13 | A: don't enable it; enable only if the console refuses to save the topic link without it, then disable after C47 is seen and confirm one more message arrives. B: enable for K13 and disable at the end of K13 | **A.** Matches "disabled outside a K step" and doesn't risk C47 on an untested assumption that notifications survive the disable. Unverified: whether the console needs it at all (Google's notification docs list roles, not this API). | Yes — **re-confirm** (STATUS Done, 20 Oct) |
| 8 | **Decided 2 Nov: Keep, plus I7-lite post-deploy checks (step 8b).** Tag from `main` without PR #41; #41 merges only at K20 | Keep / change | **Keep.** New since 20 Oct: `main` also carries #46, #49 (18 dependency bumps, `firebase-tools` 15.34.1) and #53, so v0.9.1 deploys more than 8C1 and rebuilds every function. K6's reason re-checked on 15.34.1: unchanged. | Yes — **re-confirm** |
| 9 | **Decided 2 Nov: stashed** (`git stash push -m "pre-v0.9.1 leftovers" -- CLAUDE.md STATUS.md docs/PROJECT.md`; the stash is kept, never dropped). Uncommitted `CLAUDE.md`, `STATUS.md`, `docs/PROJECT.md` changes on the current branch | A: include in G1 if they are the 2 Nov state confirmation. B: separate docs PR | **Ask Beeb after seeing the diff.** G1's Allowed files cover `STATUS.md` only; `CLAUDE.md` and `PROJECT.md` changes need Beeb's say. | No (new) |
| 10 | **Decided 2 Nov: A.** Existing £5 and £10 budgets from One-time setup step 2 | A: edit them to RUNBOOK K13's settings (100%, actual and forecast, emails on) and add £2. B: create three new ones beside them | **A.** Avoids duplicate alert emails and keeps exactly the K13 set. Read the list first. | No (new) |

## 6. Risks

**Security**
- K6 grants three project-level bindings: `run.invoker` and `eventarc.eventReceiver` to the compute account (which already holds Editor until v1.0.0, so little new power) and `serviceAccountTokenCreator` to the Pub/Sub agent (project-wide token minting by a Google agent). Bounded by K6 → K9 ≤ 60 min and the K9 diff.
- C38b, if needed, permanently adds `eventarc.developer` to the deployer (Decision 5). Recorded; C43 then expects 8 roles.
- Forged messages on `billing-guard`: project Owners/Editors (compute account) can publish. Harmless while dry run: prod holds no billing role (ADR-059). Re-checked before v1.0.1 arming, not here.
- IAM snapshot files (`~/iam-*-091.txt`) live in the home directory, never the repo; `.gitignore` gains `iam-*` only with #41. Never run `flat >` from inside the repo.

**Cost (worst month)**
- `billingGuard`: ~1,500 invocations/month, inside the free tier (ADR-059); Pub/Sub topic and budgets: £0.
- Scan-now proof: one run, at most the 52p run lease of Anthropic spend, inside the 3200p monthly cap.
- Deploy: rebuilds all 14 functions once (Cloud Build minutes, within the free tier on past releases).
- 1C layers relied on: Anthropic console spend limit; `llm.call()` monthly cap 3200p, run lease 52p and daily caps; `maxInstances: 1` + locks; GCP budgets £2/£5/£10 (alerts, added here); `hireframe-kill` → `billingGuard` (dry run, a backstop only, hours of lag); virtual card limit.

**Data**
- No Firestore or Storage data change. The deploy includes rules and indexes from `main`; G1.1 item 3 confirms they are unchanged since v0.9.0.
- A deploy while an application is Generating could kill a `generateCvs` pass (hence "nothing Generating").

**Prod vs emulator gaps** (none of these can be tested locally)
- The CLI's first-event-function IAM step (K6/K7), the Eventarc trigger and Pub/Sub push OIDC (K12), invoker rewrites on scheduled functions (K11), the real budget message shape (C47), invoker propagation (~1 min of 403s, spike result 5 → wait 2 min after K8 before the K12 publish).

**Operational**
- **Deploy fails after K6:** prepare failure → nothing deployed; follow K7's text, then Re-run failed jobs. Fails in `npm run check`/`test:rules` (before deploy) or can't be fixed by 15:30 → **abort path: K9 now** (remove what K6 added, K9 diff), stop, report. The K6–K9 rule forbids leaving the pre-grant on, not aborting through K9.
- Deploy job timeout is 20 min (`deploy.yml`); 14 functions rebuild. Record the time.
- **Doc and state discrepancies (verified 2 Nov):**
  1. RUNBOOK K7 says "Merge the PR"; PR #39 was merged 16 Oct. The K7 check becomes: `git log --oneline v0.9.0..HEAD` on `main` includes #39's merge and HEAD is G1's merge. (Decision 1.)
  2. The "Every release" checklist and the Recovery entries "Billing was disabled" etc. are **not on `main`** (PR #41); PROJECT.md 3.7 cites them. For v0.9.1 the post-deploy checks are K10, K11, the Scan-now proof and RUNBOOK line 558.
  3. STATUS numbers Phase 3/4 as K14–K18/K19–K28 (PR #41's RUNBOOK); `main`'s m8c-plan numbers them K14–K16/K17–K25. Not used here; flag for #41.
  4. Spike result 5 (wait 2 min after the invoker binding) is in m8c-plan C29a but not in `main`'s RUNBOOK K8/K12 text.
  5. RUNBOOK says "Cloud Shell"; STATUS Lesson says a laptop `bash` tab works. Either is fine; laptop gcloud is revoked at K28 (C41).
  6. One-time setup step 2 created £5 and £10 budgets already; K13 reads as if new (Decision 10).
  7. CHANGELOG `[0.9.1]` lists only 8C1; `main` also ships #46/#49/#53 (G1.3).

**Rollback**
- IAM: each K-step's own rollback (section 8); K9 is K6's rollback.
- Function: none needed for safety (no billing role). To remove `billingGuard`: revert the export in a PR and release a patch (RUNBOOK K7).
- Hosting: `firebase hosting:rollback` (Incidents table). Functions: forward-fix by patch tag. Re-running the v0.9.0 Deploy run is **unverified**: `npm run deploy` is `--non-interactive`, and removing `billingGuard` would need `--force`, so expect it to fail rather than roll back.
- Budgets: delete the budget (K13).

## 7. Out of scope
- Merging PR #41, K14 onwards (Phase 3 and v1.0.0), Editor removal, Path F grants.
- Arming the guard (v1.0.1), any billing role for `hireframe-billing-guard`, `roles/browser`.
- Any code change (a C47 `.invalid` fix is its own plan, Decision 6).
- RUNBOOK and DECISIONS edits on `main` (Decisions 1–2), the step 103 "weekend" wording fix.
- PRs #42–#45, the PR #45 lazy-screens decision, R7 steps 89/97.

## 8. Manual steps for Beeb

**Before the window (any time, after G1 merges)**
1. Read Decisions 3–10 and answer them.
2. `git checkout main && git pull`; `git log --oneline -3` shows G1's merge on top (Claude shows the expected line).

**Window pre-checks (release day, 10:00 or later)**
3. The morning digest has arrived. Pipeline shows nothing Generating. It is a weekday, between 10:00 and 16:00.
4. Open a `bash` tab (laptop or Cloud Shell), paste the Part K setup block (RUNBOOK lines 497–506), then `gcloud config get-value project` → `hireframe-f6b03`.

**K-steps** (each command shown in chat and approved before it runs; paste outputs back, redacted as in section 3)

| Step | RUNBOOK | What Beeb does | Expected output | If it fails | Rollback |
|---|---|---|---|---|---|
| K6 | Part K, K6 (C45), line 518 | Run the read; grant **only** the missing bindings (of the three); retry after `services identity create` if `$PSA` doesn't exist. Note which ones were added. **From here, no stop until K9.** | The read prints 3 lines | `$PSA` missing → the `gcloud beta services identity create` line, then retry | K9 |
| K7 | Part K, K7 (C4), line 529; Part C step 27 | `git checkout main && git pull && git log -1` (HEAD = G1 merge; #39 is in `v0.9.0..HEAD`), then `git tag v0.9.1 && git push origin v0.9.1`, approve **Actions → Deploy → Review deployments**. Record start/end time. | `functions[billingGuard(europe-west2)] Successful create operation`; no "We failed to modify the IAM policy" | Prepare fails with that message → grant only what the CLI printed (shown first), Re-run failed jobs. Eventarc permission error → C38b (Decision 5), record, re-run. Can't fix by 15:30 → abort path: K9 now | None needed for safety; remove the function by revert PR + patch |
| K8 | Part K, K8 (C38), line 530 | `add-invoker-policy-binding billingGuard` for `$GUARD`, then C46. Note the time (wait ≥ 2 min before K12's publish). | C46 prints only `serviceAccount:hireframe-billing-guard@…` | Other members → stop, report | `remove-invoker-policy-binding` (K8 text) |
| K9 | Part K, K9 (C45r), line 535 | `remove-iam-policy-binding` for exactly the bindings K6 added; `flat > ~/iam-after-091.txt`; diff; C43 | Diff empty, or only C38b / `pubsub.serviceAgent` lines (record); deployer 7 roles (8 with C38b) | Any other diff line → stop, report | Re-adding is never wanted; report |
| K10 | Part K, K10, line 536 | C14b describe; C39a/C39b lists | `1 60 256Mi` guard ×2, topic, `RETRY_POLICY_DO_NOT_RETRY`; no compute-account row; all `hireframe-fns@…` except `billingGuard` | Mismatch → stop, Claude diagnoses (planner) | — (read-only) |
| K11 | Part K, K11 = K1 (step 77 + step 101 C3), line 548 | Repeat K1 | C1 `30 7,17 * * 1-5`, `Europe/London`, `hireframe-fns@…`; C2 only `hireframe-fns`; C3 three ENABLED | Recovery entries for a scheduled function (lines 583–625) | Per Recovery entry |
| K12 | Part K, K12 (C35), line 549; Recovery line 629 | Env read; publish `costAmount 1`, read logs; only after `dry_run` shows, publish `costAmount 30`, read logs; `billing projects describe` | No `BILLING_GUARD_MODE`; `billing_guard.below` `dry_run` ≤ 2 min; `billing_guard.would_disable` ≤ 2 min; `True` | No log in 2 min → Recovery "`billingGuard` logs nothing after a publish" (resource-level grant, Decision 5), re-publish below threshold; still nothing → check C46 and C14b, stop | Recovery grant: same command with `remove-` |
| K13 | Part K, K13, line 556 | Console: Billing → Budgets & alerts. Read the list first (Decision 10). £2/£5/£10 at 100%, actual and forecast, emails on; `hireframe-kill` exactly that name, £25, this project, actual cost, topic `projects/hireframe-f6b03/topics/billing-guard`. Budget API only per Decision 7. Note the time (C47 clock starts). | Four budgets as listed; topic connected | Console refuses the topic link → stop, report the exact message (Decision 7) | Delete the budget |

**Scan-now proof** (STATUS Decisions, speed-up policy 2; after K13)
5. App → System → **Scan now** → the run row shows **Succeeded**. Partial or Failed → read "Partial because", stop and report; Claude diagnoses before any retry.
6. Apps Script editor → select `digestNow` → **Run** (RUNBOOK Part I step 92.3) → Executions shows Completed, a `digest.now` line with today's `isoWeekday`, and the email arrives. Failure → step 92.4 and Recovery "No digest arrived".
7. `gcloud scheduler jobs list --location=europe-west2 --project=$P` → three jobs, all ENABLED.
8. Check the live site: sign in, Today loads, no console errors (C7).
8b. **I7-lite** (added 2 Nov, because #49 bumped `docx` to 9.15 and every function rebuilds): Start an application on one job, wait for Ready, download and open the DOCX and the PDF. Expect one page, black text, right section order, no garbled characters. **Any CV render problem is a stop:** do not continue to C47 bookkeeping; paste what you see and Claude diagnoses (planner) first. Costs about 3p of the 60p/day application cap.
8c. `gcloud scheduler jobs list --location=europe-west2 --project=$P` again after the CV worker has run (three jobs ENABLED).

**C47 window**
9. Within 24 h of K13's time (Google: the first notification can take several hours; then several a day): the RUNBOOK K13 logging read (`--freshness=1d`). Expect `billing_guard.below`, `mode: dry_run`. `.ignored` → the budget name or currency is wrong: fix it in the console and wait for the next message. `.invalid` or nothing → Decision 6.
10. The next scheduled scan (17:30 or 07:30, weekdays) shows Succeeded in System, and the next morning digest arrives (RUNBOOK line 558).
11. If the Budget API was enabled in K13: disable it after step 9 passes, then confirm one more `billing_guard.below` arrives (Decision 7).
12. Paste the results to Claude for G2. Merge G1 and G2 when green (Beeb only).

## 9. Noticed
1. **K6 may be unnecessary but is still the safe path.** In `checkIam.js` (15.34.1) a failed *read* of the project policy only warns and continues; only a failed *write* throws. Whether the deployer can read the policy decides it; the pre-grant makes the CLI skip the write either way. Keep K6 as written.
2. **v0.9.1 is bigger than 8C1.** It ships #49's 18 dependency bumps to Hosting and every function. If any are web runtime packages, PROJECT.md's rule ("steps 89/97 for each release that touches the load path") may apply; G1.1's `check:bundle` number shows whether initial JS moved. Beeb decides whether a step 89 lab record is wanted.
3. **Cut: the separate G2 PR could fold into the K20 evidence commit on #41** if Beeb would rather keep `main` quiet until v1.0.0. Trade-off: STATUS on `main` stays stale for days, against the "update STATUS in every PR" rule.
