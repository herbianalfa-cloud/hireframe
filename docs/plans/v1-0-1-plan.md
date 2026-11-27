Status: Approved (2026-11-27)

# v1.0.1: arm `billingGuard` and close the 8C2 leftovers (plan)

- **Tier:** portfolio. **Hard area:** yes. Arming a billing kill switch, project IAM (the App Engine account's Editor and two billing roles for the guard), budgets and API state. G1 and G3 are docs only and not a hard area. G2 is a hard area (`reviewer-deep`).
- **Precondition (not met today, 27 Nov):** v1.0.0 (RUNBOOK K19–K28 on PR #41) is tagged, deployed and K28 is done, with its follow-up docs PR merged. **Gate:** one full clean weekday on v1.0.0 (Decision 12), and per Decision 9 also after window A. Nothing in this plan runs before K28.
- **Time-box (C4):**
  - G1: ≤ 1.5 h of Claude time (this plan now; pre-flight and evidence skeleton after K28).
  - G2: ≤ 3 h of Claude time (code, docs, `reviewer-deep`, one re-review).
  - Window A (Beeb, no deploy): one weekday, 10:00–16:00 London, ≤ 2 h.
  - Window B (Beeb, the v1.0.1 release): one weekday, 10:00–16:00 London, ≤ 3 h. **Hard stop: B6 (the grant that arms) not done by 15:30 → don't grant; resume next weekday** (armed code without the roles is inert, section 6).
  - C47-armed read within 24 h of B6. G3: ≤ 45 min.
  - Whole plan: ≤ 5 working days from the K28 docs PR merge. Over that → C4 check with Beeb.

Sources read: `CLAUDE.md`, `.claude/kit/WORKFLOW.md`, `docs/PROJECT.md`, `STATUS.md`, `.claude/kit.config.json`, `docs/plans/v0-9-1-plan.md`, `v0-9-1-evidence.md`, `m8c-plan.md`, `m8c-spike-results.md`, `m8-billing-guards.md`, `docs/RUNBOOK.md` Part K and Recovery, `docs/DECISIONS.md` ADR-017 and ADR-059, `docs/SECURITY.md`, `docs/ROADMAP.md` (M8 row), `LEARNINGS.md` (Next §4–4d, parked ideas), `functions/src/billing/{endpoint,handler}.ts`, `functions/src/config.ts` (`BILLING_GUARD`, `guardMode`), `scripts/build-functions.ts`, `firebase.json`, `.firebaserc`, `package.json` (`deploy`), `.github/workflows/deploy.yml`. In `node_modules/firebase-tools` 15.34.1: `commands/deploy.js:83`, `deploy/functions/checkIam.js:31-47,139-160`, `deploy/functions/cache/hash.js:11-22`, `functions/env.js:179-273`. Web: Google Cloud spend-cap docs and the GA post (31 Oct 2026); Cloud Observability pricing (inconclusive). ADR-060, the ADR-059 option-A addendum and #41's RUNBOOK (K14–K28) are on PR #41, not `main`; cited through STATUS and LEARNINGS only.

### 1b. Not verified from the repo (each is checked by a read in section 8 or G1.2)
1. K17's evidence: which APIs were refused and the exact "cloudapis" refusal text (goes into #41's K20 commit). What "C53 N/A" means (CPU/GPU quotas).
2. Whether `compute.googleapis.com` is enabled today and whether it can be disabled at all (m8c's never-disable list keeps it).
3. Whether anything runs as, or acts as, the App Engine default account (`hireframe-f6b03@appspot…`), and whether an App Engine app exists.
4. Native spend caps: which billing service carries our gen2 function costs ("Cloud Run functions" or "Cloud Run"), GBP support, and whether an enforced cap also blocks Pub/Sub push to `billingGuard` (it is a Cloud Run function, so most likely yes).
5. Log-based alert pricing (search results conflict: free, or about $0.35 per policy per month) and whether the Monitoring API is enabled.
6. Whether the console now lets `hireframe-kill`'s scope be set to the single project (K13 could not).
7. Whether the £50 virtual card limit (m8-billing-guards §8) is in place.
8. The deployer's post-v1.0.0 role baseline (C43 after K26).
9. Whether a real budget notification carries `budgetId` in the Pub/Sub attributes, as Google's schema says. G1.2 showed the logs hold no message fields, so it is confirmed by the capture in A7b (window A), not from a log.
10. Whether any function runs with no explicit runtime account (R14), and what the console's excess-permissions insight says (R15; skipped if it needs an API).

## 2. Goal and definition of done

**Goal:** turn `billingGuard` from dry run to armed (option A: `roles/billing.projectManager` + `roles/browser`), after closing what has to be closed first. That covers the App Engine account's Editor, the deployer's `serviceAccountUser` on it, `hireframe-kill`'s scope, the K17 API leftovers and an API-enable alert. It also covers a recorded choice on native spend caps. v1.0.1 changes no function code and adds no function.

**Done when (each item says how it is measured):**
1. **Preconditions:** `git ls-remote --tags origin v1.0.0` shows the tag. K28's docs PR is merged. The evidence doc records the clean weekday(s) per Decision 12.
2. **App Engine account:** after A2, the R1 read prints no `roles/editor`, or Decision 3's "accept" is recorded with its reason in the ADR addendum. The deployer's `serviceAccountUser` on it is kept with the code reason (Decision 4). R2 still shows it.
3. **Publishers:** R5 lists only the `user:` Owner (accepted, not pasted) and Google service agents (listed by role) as project-level holders of `pubsub.topics.publish`. R6 shows only Google's budget publisher on the topic. Both run in B0 on the release day.
3b. **Identities and invoker:** R14 shows no function running as the App Engine account; R16 lists only the Eventarc trigger account as `billingguard`'s invoker; R17 shows only `hireframe-kill` publishing to the topic.
4. **Kill-budget scope:** the budget list shows `hireframe-kill` scoped to `hireframe-f6b03` only. If Decision 6 → B: R7 prints exactly one project, and the RUNBOOK rule is in G2.
5. **K17:** each API refused at K17 has a recorded outcome (disabled, or kept with a reason) in the evidence doc.
6. **API-enable alert:** Monitoring → Alerting lists `hireframe-api-enabled`, enabled, with the owner's email channel (set in the console, never in the repo). Its query shows ≥ 1 historic match in Logs Explorer, which proves the filter.
6b. **Failure alert:** Monitoring → Alerting lists `hireframe-guard-failed`, enabled, with the owner's email channel, and its field names were checked against a `billing_guard.below` row (A4b).
7. **Native cap:** Decision 5 is recorded. If a cap is chosen, Budgets & alerts lists it with spend cap on and not enforced, at about £40 (above the £25 kill budget) or with `billingGuard` excluded.
8. **Repo (G2):** `node .claude/kit/gate.mjs` all 0. the committed source file `functions/deploy-env/hireframe-f6b03.env` (one line, `BILLING_GUARD_MODE=armed`) is copied by `npm run build` to `functions/deploy/.env.hireframe-f6b03` (the build wipes that folder first), and no `.env`, `.env.prod` or `.env.local` there. `node scripts/smoke-functions-bundle.ts` asserts and prints it. The existing dry-run wiring test (env unset → no `fetch`) still passes unchanged.
9. **Release:** `v1.0.1` points at a `main` commit containing G2. `git log --oneline v1.0.0..v1.0.1` lists only the K28 docs PR, G1 and G2 (Decision 11). The Deploy log shows every function `Successful update operation` (the env change alters every function's hash, `hash.js:11`) and no failure. Job time recorded.
10. **Armed (B4–B8):** the env read shows `BILLING_GUARD_MODE=armed` on `billingGuard`. A £1 publish logs `billing_guard.below` with `mode: armed` within 2 min, both before and after the grant. `flat | grep $GUARD` prints exactly the two roles. The IAM diff vs `iam-before-101.txt` is exactly those two `>` lines. `billingEnabled` is `True`. **No over-threshold publish in prod, ever.**
11. **Post-deploy:** C1–C3, C14b, C46, C39a/C39b as in RUNBOOK K10/K11. Scan-now proof (System Succeeded, `digestNow` Completed with mail, three scheduler jobs ENABLED). Live site loads.
12. **C47-armed:** within 24 h of B6, a real budget message is logged as `billing_guard.below`, `mode: armed`. The 24 h per-severity read shows no `invalid`, `failed`, `disabled` or WARNING+ guard rows.
13. **Closeout (G3):** the evidence doc is filled. STATUS, CHANGELOG `[1.0.1]` (dated), the ADR addendum results line and the ROADMAP parking lot are updated. Gate 0.

## 3. Rules that apply
- **WORKFLOW gate 5 / C11:** Claude never merges, tags, deploys or touches gcloud, IAM or the console. Beeb runs every command, each shown in chat and approved first (memory: show admin commands, wait for OK).
- **IAM:** only `add-`/`remove-iam-policy-binding`, **never `set-iam-policy`**. Never touch the `user:` owner binding. Every member spelled out. Snapshot (`flat > ~/iam-*.txt`) before and `diff` after every change. Snapshots stay in `~`, never the repo.
- **C5 / never relax:** the £25 `hireframe-kill`, £2 and £10 budgets, the 3200p cap, the 52p lease and every daily cap stay as they are. A native cap only adds a limit (Decision 5). A failing gate, bundle or eval budget is Beeb's call.
- **CLAUDE.md no-self-triggering:** G2 adds no function, trigger or loop. Only `billing/decide.ts` (a pure function) and its schema and handler wiring change (G2.4); `billing/client.ts` and the write path do not, and the source guard (no publish, Firestore, Cloud Tasks or timers) still runs. The alert and the native cap are console objects that only send email. Say so in the G2 PR body.
- **CLAUDE.md config rule:** the deploy mode has one source of truth in `functions/src/`, never a literal copied into a script.
- **ADR-059:** only the exact string `armed` arms; unset means dry run. The guard's target is the metadata project. Before arming, the topic shows only the budget publisher, plus a project-level publisher read.
- **STATUS speed-up policy 2 and 3:** Scan-now proof after the deploy. A full clean weekday on v1.0.0 before arming (re-confirm, Decision 12).
- **STATUS Lessons:** run Part K/L blocks in a `bash` tab. macOS grep has no `\s` (use `[[:space:]]`). A deploy can fail midway (plan a partial release). A re-run asks for the `production` approval again. Expect Google's service-agent lines in diffs (record them, never remove them).
- **Release window:** weekday 10:00–16:00 London, after the morning digest, nothing Generating, never on a Sunday. Tag only after `git checkout main && git pull`.
- **No secrets, no personal data:** no emails, billing account ID or `user:` lines in the repo. Write service accounts as `name@…`, the project number as `<NUM>` and the billing account as `<BILLING_ID>`. `npm run scan:pii` stays clean.
- **Memory:** branches start from `origin/main` (never stacked). This plan's branch stays unmerged until after K28.

## 4. PR groups

### G1: plan, pre-flight, evidence skeleton (docs only)
Branch `feat/v1-0-1-arming-plan-g1` (from `origin/main` 041788f). **Not merged until K28 is done.**

- [x] **G1.1 This plan.** Allowed files: `docs/plans/v1-0-1-plan.md`. Pre-checks: none. Tests: none. Acceptance: `Status: Draft`, `scan:pii` clean, gate 0. Hard area: no.
- **Order change (Beeb, 27 Nov):** G1.2 runs now, on Friday 27 Nov, because it is read-only; the rest of the order is unchanged. G2 is then built now on a branch from `feat/v1-0-1-arming-plan-g1` (stacked on this plan branch, not on `main`; the plan stays approved, and this replaces the "after G1 merges" rule for the build only). Nothing merges and nothing pushes to `main` until after K28. Any branch is pushed only with Beeb's OK each time. Because v1.0.0 and the K28 docs PR don't exist yet, G1.2 items 1 and 2 (and the v1.0.0-based parts of item 5) can't pass today: they are recorded as "not yet checkable" and **re-run after K28**, before G2 merges. G2's merge, tag and every window step keep their original gates.
- [ ] **G1.2 Pre-flight (read-only; originally after the K28 docs PR merges, now run first on 27 Nov and re-run for items 1 and 2 after K28).** First update the branch from `origin/main` (show the rebase or merge command; Beeb approves).
  - Allowed files: `docs/plans/v1-0-1-evidence.md` (results only).
  - Checks:
    1. `git log --oneline v1.0.0..origin/main` shows only the K28 docs PR. Anything else → report (Decision 11).
    2. On `main`: the ADR-059 option-A addendum and ADR-060 are present. RUNBOOK has the Recovery entries "Billing was disabled" and "Rollback the Editor removal". Copy the K14–K18 evidence (K17 APIs and refusal text, C53) into the evidence doc.
    3. `firebase-tools` version in the lockfile. Re-check `commands/deploy.js` still calls `checkServiceAccountIam` (actAs on `<project>@appspot…`). `checkIam.js:143` still returns early when the event service exists. `cache/hash.js` still hashes `environmentVariables`. `functions/env.js` still loads `.env.<projectId>` and throws when both the `.env.<projectId>` and `.env.<alias>` files exist.
    4. `git diff 017d60c origin/main -- functions/src/billing functions/src/http/client.ts` (017d60c is #39's merge, nearest to the 17 Oct spike code). Empty → Decision 10 needs no re-test. Otherwise list the changes.
    5. `node .claude/kit/gate.mjs`, `npm run build`, `node scripts/smoke-functions-bundle.ts`, `npm run check:bundle`, `npm run test:rules`, `npm run audit`, all 0. `functions/deploy/` has no `.env*` file besides the gitignored `.secret.local`.
  - Tests: none. Acceptance: every item matches or is reported. A miss stops G1. Hard area: no.
- [ ] **G1.3 Evidence skeleton and STATUS.**
  - Allowed files: `docs/plans/v1-0-1-evidence.md`, `STATUS.md`, `docs/plans/v1-0-1-plan.md`.
  - Content: the redaction note (as in v0.9.1). One row per read R1–R13, A1–A8, the clean weekday(s), B0–B12 and C47-armed, each with the expected output copied from section 8, a blank "Result (pasted by Beeb)" cell, start and end times, and a "Deviation" cell. STATUS: In progress → v1.0.1 plan link, "window A next".
  - Acceptance: `scan:pii` clean. The evidence doc is ≤ ~300 lines. STATUS is ≤ 1 page. Gate 0. Hard area: no.

G1 review: `reviewer`. PR body: "No code; no self-triggering surface changed."

### G2: arm through the build, plus runbook and ADR (code + docs)
Branch `feat/v1-0-1-arming-g2`, **now from `feat/v1-0-1-arming-plan-g1`** (order change, Beeb 27 Nov: built early, stacked on the plan branch; say "Stacked on" in the PR body). It is rebased onto `origin/main` after G1 merges and before B1. Built while the clean weekday runs. **Merged by Beeb only at B1.** Not pushed without Beeb's OK.

- [x] **G2.1 Deploy env for the guard (tests first).**
  - Allowed files:
    - `functions/deploy-env/hireframe-f6b03.env` (new, committed source: one line, `BILLING_GUARD_MODE=armed`; Decision 1, Beeb 2026-11-27: a non-dot name, so `.gitignore` (`.env*`, kit block `.env.*`) and the kit guard don't apply);
    - `functions/src/deploy-env.ts` (new, import-free so `scripts/` can import it with `.ts`, as `scripts/load-test.ts` does): `deployEnvFile(sourceText)` validates and returns `{ name, content }`;
    - `functions/src/deploy-env.test.ts`;
    - `scripts/build-functions.ts`.
  - Pre-checks:
    - G1.2 item 3 holds. Decision 1 = A (amended).
    - `git check-ignore` on the source file prints nothing, and the kit guard lets Claude write it. If either blocks it: stop and ask (fallback name without an `.env` part, for example `hireframe-f6b03.vars`; a small decision, listed in the PR).
    - Emulator project: `scripts/dev.ts` uses `assertDemoProject` (`demo-hireframe`), and no `demo-*` or `.firebaserc` alias other than `prod` maps to `hireframe-f6b03`. If the emulator ID ever equals it, add an emulator override that keeps `dry_run` (Beeb's check (a)).
  - Tests to write first:
    - `deployEnvFile()` on the committed source returns exactly `{ name: '.env.hireframe-f6b03', content: 'BILLING_GUARD_MODE=armed\n' }`.
    - A source with `dry_run` returns `BILLING_GUARD_MODE=dry_run` (disarm path). Anything else (extra lines, a comment, another key, a blank value, a secret-looking value) throws.
    - The name is never `.env`, `.env.local`, `.env.prod` or `.env.demo-*`.
    - The project in the name equals `.firebaserc`'s `prod` alias and the domain of `BILLING_GUARD.serviceAccount`; and it is not the emulator's project ID (the `demo-` ID used by `scripts/dev.ts`).
    - Round trip: the value parsed from the line, passed to `guardMode({[BILLING_GUARD.modeEnvVar]: value})`, gives `armed`.
  - Change: after the esbuild step (and the `rmSync` of `functions/deploy/`), `build-functions.ts` reads the source file and writes the result into `functions/deploy/`.
  - Note: the kit guard stops Claude naming `.env*` paths in shell commands, so the build output is checked through G2.2's smoke script (which prints the value), not by reading the file.
  - Acceptance:
    - tests pass; gate 0;
    - `npm run build`, then `node scripts/smoke-functions-bundle.ts` reports one file with exactly one line;
    - `npm run dev` still starts (the emulator, `demo-hireframe`, never loads `.env.hireframe-f6b03`, `env.js:179-190`);
    - G2.1 touches no `billing/*.ts`; the dry-run wiring test passes unchanged.
  - Hard area: **yes**.
- [x] **G2.2 Smoke check.**
  - Allowed files: `scripts/smoke-functions-bundle.ts`.
  - Change: assert `functions/deploy/.env.hireframe-f6b03` is exactly `BILLING_GUARD_MODE=(armed|dry_run)` and print the value. Fail if `.env`, `.env.prod` or `.env.local` exists in `functions/deploy/`.
  - Tests: run it after `npm run build`, then once with the file deleted by hand (must fail).
  - Acceptance: exit 0 on the real build; non-zero on the planted cases. Hard area: yes.
- [x] **G2.3 Docs.**
  - Allowed files: `docs/DECISIONS.md` (ADR-059 addendum, plus an ADR-060 addendum for Decisions 3–4), `docs/RUNBOOK.md`, `docs/SECURITY.md` (billing row), `docs/ARCHITECTURE.md` (`billingGuard` row), `CHANGELOG.md` (`[1.0.1]` Unreleased), `STATUS.md`, `docs/plans/v1-0-1-plan.md`.
  - The ADR addendum records:
    - the mechanism (Decision 1);
    - the order (Decision 2: code first, roles last);
    - option A's roles at project level;
    - the disarm route (remove the two roles, then set the source file to `dry_run` and release a patch);
    - the guard acts only on a current-month `hireframe-kill` message (G2.4), and whether the payload carries a budget ID;
    - the deployer's `actAs` on the App Engine account kept, with the firebase-tools citation;
    - "every function now carries `BILLING_GUARD_MODE`; only `billingGuard` reads it".
  - RUNBOOK gets a new **Part L (v1.0.1)**:
    - the reads R1–R13 and steps A1–A8 and B0–B12 exactly as section 8;
    - "never publish at or above the threshold in prod";
    - "set `hireframe-kill`'s scope before linking any other project to the billing account";
    - Recovery entries **"Disarm `billingGuard`"** and **"API-enabled alert fired"**.
  - Acceptance: every command in Part L matches section 8 word for word. `scan:pii` clean. Gate 0.
  - Hard area: yes (IAM text).

- [x] **G2.4 The guard acts only on a current-month `hireframe-kill` message (tests first).**
  - Allowed files: `functions/src/billing/decide.ts`, `functions/src/billing/decide.test.ts`; `functions/src/billing/schema.ts`, `handler.ts` and `handler.test.ts` only to pass a clock and, if the payload has one, a budget ID; `functions/src/config.ts` only for a constant. **Not** `client.ts`, `functions/src/http/client.ts` or the write path.
  - What the code does today (read 27 Nov): acts only when `budgetDisplayName` equals `hireframe-kill` (`decide.ts:17`), ignores the forecast fields (`decide.ts:12-13`, test at `decide.test.ts:57`) and requires GBP (`decide.ts:20`). Missing: `costIntervalStart` is parsed as a non-empty string and never checked, so a replayed or stale message from an earlier month still kills. The schema has no budget ID.
  - Pre-checks (amended 27 Nov, Beeb, after G1.2 found that `billingGuard` logs no message fields):
    - Google's documented notification schema puts `budgetId` (and `billingAccountId`) in the Pub/Sub **message attributes**. G2.4 reads `budgetId` from the attributes and requires it to equal the `hireframe-kill` ID, held in `config.ts`. **Not verified from the repo**; window A's capture (A7b) confirms it.
    - If the real message has no `budgetId`, that requirement is **dropped before window B** (a G2 amend before B1) and the display name stays the identity. Anyone who can create a budget can pick that name, so say so in the ADR and keep R5/R6/R17 as the control.
    - The attributes have to reach `decideGuard`: check `endpoint.ts` and `handler.ts` for how the CloudEvent data arrives. If plumbing them changes the call from the handler to the client or its dependencies, Decision 10 applies (the builder reports which, and Beeb confirms at the checkpoint).
  - Tests to write first (injected clock):
    - a message with `costIntervalStart` in the current month, cost at the budget, armed → `disable`;
    - the same message with last month's start → `ignored` (`stale_period`), and no client call;
    - an unparseable or future `costIntervalStart` → `ignored`, no client call;
    - another budget name, another currency → `ignored` (existing tests stay);
    - forecast fields set and cost below the budget → `below` (existing test stays); forecast set with cost at the budget → the actual cost decides, as today.
  - Change: `decideGuard` takes the clock and compares the year and month of `costIntervalStart` with it. "Current month" is UTC; at the month boundary a message may be ignored for a few hours, which fails safe (no kill). Logged as `billing_guard.ignored` at info, so it doesn't trip the clean-weekday check. Small decision, listed in the PR.
  - Acceptance: tests pass; gate 0; `git diff --stat` shows no change to `billing/client.ts` or `http/client.ts`; the source-guard test (no publish, Firestore, Cloud Tasks or timers) passes unchanged. Hard area: yes (money, kill logic).
  - Fixture test (Beeb, 27 Nov, amended after G1.2): the logs hold no real message, so the first fixture is **Google's documented example** (field names and shapes from the schema, fake `billingAccountId` and `budgetId`, marked as documented, not captured), with the clock set to its month and cost at or above the budget → `disable` when armed. **After A7b** a second fixture is added from the real captured message (same field names and values, `billingAccountId` and `budgetId` faked again; nothing personal committed), and the same test runs against it before B1. If the real message's shape differs from the documented one, fix the schema and tests before window B.
  - Order of checks: identity (budget name, `budgetId`, currency) and staleness (`costIntervalStart`) run **before** the below/over decision. A rejection logs a distinct event, `billing_guard.ignored` with a reason (`wrong_budget`, `wrong_budget_id`, `wrong_currency`, `stale_period`), never `billing_guard.below`. So B10's "first real message after B6 is `billing_guard.below`, `mode: armed`" catches a guard that wrongly rejects real messages. A stale message with a low cost is `ignored`, not `below`.
  - Decision 10 (Beeb, 27 Nov): a change to `decide.ts` alone needs **no** throwaway armed kill test. The test **is** required if `client.ts` or `functions/src/http/client.ts`, the handler wiring between `decideGuard` and the client, the billing dependencies, or the Node runtime change. The PR body says which of these changed (expected: none).
  - Month-boundary blind spot (UTC month vs the budget period's reset, about 7–8 h): accepted as fail-safe by Beeb.

**Differences from plan (G2.3, built 27 Nov):**
- The ADR-060 addendum for Decisions 3-4 and the K14-K18 cross-references are not written yet: ADR-060 and #41's RUNBOOK are not on this base. They are added after G2 is rebased onto `origin/main` once #41 merges (with K20/K28).
- RUNBOOK Part L adds one note to section 8's B5/B8: K12's example `costIntervalStart` (`2026-10-01T00:00:00Z`) is stale under G2.4 and would log `ignored` (`stale_period`), so the publish uses the first of the current month (and the `budgetId` attribute once configured). The section 8 commands are unchanged.

G2 review: `reviewer-deep`, and G2.4 is reviewed specifically (decision logic, the real-message test, the Decision 10 scope). Gate set: the gate, `npm run build`, `smoke-functions-bundle`, `check:bundle`, `test:rules`, `audit`. The PR body states the no-self-triggering check.

### G3: closeout (after C47-armed and the next scheduled scan)
Branch from `origin/main` after the v1.0.1 tag.

- [ ] **G3.1 Evidence and docs.**
  - Allowed files: `docs/plans/v1-0-1-evidence.md`, `STATUS.md`, `CHANGELOG.md` (`[1.0.1]` date), `docs/DECISIONS.md` (one results line: the publisher read, the App Engine outcome, the K17 outcomes), `docs/ROADMAP.md` (parking lot), `docs/plans/v1-0-1-plan.md`, and `docs/PROJECT.md` lines 3.4/3.6/3.13/3.14 ("dry run, armed in v1.0.1" → "armed") **only if Decision 13 = A**.
  - Acceptance: every row has a result or "not done + why". STATUS ≤ 1 page (move old Lessons to LEARNINGS). `scan:pii` clean. Gate 0. The plan's `Status` line is left for Beeb.
  - Hard area: no.

## 5. Decisions (recommendation first)

**Decided by Beeb, 2026-11-27:** D1–D13 and R1–R2 as recommended below, except **D1**, amended: the committed non-dot source file, plus the two checks in G2.1. **Second opinion, 27 Nov (applied):** D5 amended (cap above the kill budget, about £40); new reads R14–R17; new step G2.4 (the guard acts only on a current-month `hireframe-kill` message); a log alert on `billing_guard.failed` (A4b); B10 checks the first message after the grant. **D10 scope** set by Beeb (see G2.4); the fixture test is added to G2.4 (documented example now, real capture in A7b; `budgetId` from the attributes, dropped before B if the real message has none; identity and staleness before below/over, distinct `ignored` reasons). The "still OK?" items (R1, R2, speed-up policy 2–3, K13 scope deviation + Budget API rule) are confirmed.

| # | Decision | Options | Recommendation + why | In STATUS Decisions? |
|---|---|---|---|---|
| 1 | How prod gets `BILLING_GUARD_MODE=armed` | **A (amended, Beeb 2026-11-27):** a committed one-line source file `functions/deploy-env/hireframe-f6b03.env`, which the build copies to `functions/deploy/.env.hireframe-f6b03`. Checks added: the emulator's project ID is not `hireframe-f6b03`; the source has a non-dot name because `.gitignore` ignores `.env*` and the kit guard blocks `.env*` paths. B: a plain `.env` file. C: make `guardMode` default to armed. D: `gcloud run services update --update-env-vars` | **A.** firebase-tools loads `.env.<projectId>` only for that project (`env.js:179-183`), so the emulator (`demo-hireframe`) stays dry run, and ADR-059's "unset = dry run" stays true. The value is reviewed in a PR. Trade-off: every function gets the variable and redeploys (`hash.js`). Rejected: B arms the emulator too. C breaks ADR-059's safety default. D drifts, because the next deploy overwrites it. | No (new) |
| 2 | Order in window B | **A:** deploy the armed code first, check, then grant the two roles last. B: grant first, then deploy | **A.** Armed code without a billing role can't disable anything (a 403 → `failed`), so the grant is the single switch. It is instant and removed with one command, and the 15:30 hard stop is safe. B leaves no inert stage. | No (new) |
| 3 | App Engine default account's Editor | **A:** remove it in window A, after R1–R4 show nothing runs as it. B: accept with a reason. C: disable the account | **A.** It can publish to `billing-guard`, so it can forge a kill once armed. The deployer can act as it (`serviceAccountUser`), so a deploy could run code with Editor. No function, trigger or scheduler job uses it (C39b, C3). Rollback is one `add-` command. Trade-off: unknown Google-side users; R4 only sees Admin Activity logs. C is untested and broader. | Yes: **re-confirm** ("removed, or accepted with a reason") |
| 4 | The deployer's `serviceAccountUser` on the App Engine account | **A:** keep it, and record why. B: remove it and prove with a deploy. C: delete the account | **A.** firebase-tools 15.34.1 runs `checkServiceAccountIam` before every functions deploy and throws unless the deployer has `actAs` on `<project>@appspot…` (`deploy.js:83`, `checkIam.js:31-47`). B would fail every deploy in prepare. C is hard to undo, with unknown side effects. Revisit when firebase-tools changes (G1.2 item 3). | No (new; parallels ADR-060 for the compute account) |
| 5 | Native spend caps vs `billingGuard` (GA 31 Oct 2026) | **A (amended, second opinion 27 Nov):** arm the guard and add one native cap on the billing service that carries our function costs, **above the £25 kill budget (about £40)**, or exclude `billingGuard` from it if R11 shows caps can be scoped per service. B: the same at £25 or lower (for example £10). C: park native caps. D: native caps instead of arming | **A.** Caps cover only Gemini, Vertex, Cloud Run and Cloud Run functions, per project and service. They never delete resources, act on estimated cost (faster) and auto-lift monthly. They are not hard caps (lag; overage billed). The £25 kill budget fires first for every service (Compute, Firestore, Storage, Build, functions), so the cap is only a later backstop if functions alone run away. **Trade-off:** an enforced functions cap pauses the app **and `billingGuard` itself** for the rest of the month, so it sits above the kill amount (about £40) and can never pause the guard before the kill has had its chance. B (£25 or lower) would. D is rejected: it leaves the stolen-account route (Compute) uncovered. Cost £0 (no fee listed). | Parked idea (11 Nov), now decided |
| 6 | `hireframe-kill` scope ("All projects (1)") | **A:** in window A, retry in the console to set the scope to `hireframe-f6b03` only; if refused, B. B: accept, plus R7 (one project on the billing account) in every arming pre-check, plus the RUNBOOK rule. C: set it with the Budget API (enable it for the step, then disable) | **A, then B.** Once armed, another project's spend would count toward the kill and unlink this project. A costs nothing. B is safe while R7 prints one project. C needs the API that stays disabled outside a K step. | Yes: **re-confirm** (v0.9.1 closeout K13 deviation; Budget API rule) |
| 7 | K17 carry-over (disables refused by `cloudapis` dependencies) | **A:** keep those APIs enabled, recording each with a reason; Decision 8's alert covers new enables. B: disable `cloudapis.googleapis.com` first, then retry each disable alone (no `--force`), each followed by the K17 check. C: `--force` | **A.** Idle APIs cost £0, and anyone who can misuse them as Owner can re-enable them. B is untested (unverified that disabling the umbrella leaves its dependencies alone) and needs a check per API. C is banned (never `--force`). Revisit with the K17 list in G1.2. | No (new; STATUS Done says "carry to v1.0.1") |
| 8 | API-enable log alert | **A:** one log-based alert on any Service Usage enable (all APIs). B: compute only, as scoped. C: none | **A.** The deployer can't enable APIs (`serviceUsageConsumer`), so an enable means a person or an attacker. It is rare and covers compute plus everything else at the same cost (≤ about $0.35/month, unverified). Trade-off: a console page that auto-enables an API will email too. | No (new) |
| 9 | Window shape | **A:** window A (no deploy: Editor, alert, scope, K17, cap) → one clean weekday → window B (release). B: everything in one window | **A.** One risky change per release (m8c §1). If a scan fails, the cause is never in doubt. Trade-off: at least 3 weekdays after K28. | No (new) |
| 10 | Re-run the throwaway armed kill test | **A (scope set by Beeb, 27 Nov):** only if `client.ts`, `http/client.ts`, the handler wiring between `decideGuard` and the client, the billing dependencies or the Node runtime changed since the spike (G1.2 item 4 and the G2 diff); `decide.ts` changes alone don't count. B: always. C: never | **A.** The prod armed path can't be tested without unlinking billing. The 17 Oct spike proved these exact roles on the same code path (C30 `False`). | No (new) |
| 11 | Merges between v1.0.0 and v1.0.1 | **A:** hold Dependabot and every other PR until the v1.0.1 tag, so v1.0.1 = G1 + G2 only. B: Dependabot after K28 as planned | **A.** Keeps the arming release single-purpose and the clean weekday meaningful. Trade-off: Dependabot waits a few more days. | Yes: **re-confirm** (Release plan, 24 Nov) |
| 12 | Clean weekday definition | **A:** a full London weekday after v1.0.0's deploy day (and after window A) with: both scheduled runs Succeeded (System); the digest arrived; that day's `billing_guard.*` rows only `below`/`dry_run`, none WARNING+; three scheduler jobs ENABLED; IAM `flat` diff vs the last snapshot empty. B: the same, without the IAM diff | **A.** Measurable and quick (about 5 reads). K28's 24-hour checks may fall on the same day. | Yes: **re-confirm** (speed-up policy 2–3) |
| 13 | PROJECT.md wording ("dry run, armed in v1.0.1") | **A:** update the four lines in G3. B: leave for housekeeping | **A.** The spec would otherwise be wrong on a security control. | No (new) |
| R1 | Arming = option A (17 Oct) | Keep / change | **Keep.** New since: native caps are GA (Decision 5), which doesn't change the roles. | Yes: **re-confirm** |
| R2 | #42 merges only after the v1.0.1 tag; then #43, #45 + #44 | Keep / let #42 go first | **Keep** (Beeb's 24 Nov call). New since: arming now needs ≥ 3 weekdays after K28 (Decision 9), so #42 waits that long. See Noticed 2. | Yes: **re-confirm** |

## 6. Risks

**Security**
- **Forged kill once armed:** anyone with `pubsub.topics.publish` can unlink billing. A replayed old message is stopped by G2.4. Mitigations: R5, R6, R16 and R17 before B6; removing Editor from the App Engine account (Decision 3); the compute account's Editor goes at v1.0.0 K24.
- **Residual route:** the deployer has `serviceAccountUser` on `hireframe-billing-guard` (K5), so a malicious deploy could run code as the guard and unlink billing. That is a DoS only. Deploys need a `v*` tag plus Beeb's `production` approval. Accepted, and recorded in the ADR.
- **Role scope:** `billing.projectManager` also allows linking billing, and `roles/browser` reads project metadata. A custom role narrowing `browser` stays parked.
- **Snapshots:** `~/iam-*-101*.txt` stay in the home directory. Paste role lists only.

**Cost (worst month)**
- Arming adds no spend. Budget messages are about 1,500 invocations a month (free tier).
- The v1.0.1 deploy rebuilds every function once (Cloud Build free tier, as on past releases).
- The Scan-now proof costs ≤ 52p, inside the 3200p cap.
- The log alert costs ≤ about $0.35/month (unverified). A native cap has no fee listed.
- **1C layers relied on:**
  - the Anthropic console limit;
  - `llm.call()` monthly cap 3200p, run lease 52p and daily caps;
  - `maxInstances: 1` + locks on every function;
  - budgets £2 and £10 (alerts);
  - `hireframe-kill` £25 → `billingGuard` (**armed after B6**; lags by hours);
  - the native cap (if Decision 5 A/B);
  - CPU/GPU quotas (C53 state unverified);
  - the card limit (unverified, 1b item 7).

**Data**
- If the guard fires (real or forged), every paid service stops. Google warns that resources may be deleted. Backups live in the same project (ADR-058, accepted). Recovery: RUNBOOK "Billing was disabled" (#41).
- An enforced native functions cap pauses scans, CVs and the digest until it is lifted or the month ends (Decision 5).

**Prod vs emulator gaps** (none testable locally)
- dotenv loading in the CI deploy;
- IAM;
- real budget messages;
- the console budget scope, native caps and log alerts;
- the armed `billingInfo` path (proved only in the 17 Oct throwaway).

**Operational**
- **Partial deploy (Lesson, 3 Nov):** some functions may carry the new env and others not. With no billing role (B6 not done), nothing can fire. Fix forward; check the env per function.
- **Deploy time:** 15 functions rebuild. Compare against v1.0.0's recorded job time and `timeout-minutes`.
- **Every deploy rewrites the scheduled invokers:** step 77 (C1, C2) in B3.

**Rollback**
- **Disarm (instant, no deploy):** `remove-iam-policy-binding` for the two guard roles. An over-threshold message then logs `failed`/`permission_denied`. Then flip the constant to `dry_run` and release a patch tag.
- **App Engine Editor:** `gcloud projects add-iam-policy-binding $P --member=serviceAccount:$APPSPOT --role=roles/editor --condition=None`.
- **Alert:** delete the policy. **Native cap:** lift, then delete. **Scope:** edit back.
- **Hosting:** `firebase hosting:rollback`. Functions: forward-fix by patch tag.
- **Billing unlinked:** re-link in the console (Recovery entry).

## 7. Out of scope
- PRs #42–#45 and Dependabot (Decision 11). Any change to `billing/*.ts` or to budget amounts.
- A custom role narrowing `roles/browser`. A build account. CPU/GPU quota edits (C53) beyond recording their state.
- **Any at- or over-threshold publish in prod.** A throwaway re-run unless Decision 10 says so.
- Alerts on `billing_guard.failed`/`disabled` or on VM creation (Noticed 3).

## 8. Manual steps for Beeb
Every command is shown in chat and approved before it runs. Use a `bash` tab with the RUNBOOK Part K setup block, plus `APPSPOT=$P@appspot.gserviceaccount.com`. Paste role lists and log tables only: no `user:` lines and no email addresses; `<NUM>`, `<BILLING_ID>`.

**Before window A (after K28)**
1. Answer Decisions 1–13, R1 and R2. Merge G1 when green.
2. **Reads (read-only, any weekday):**
   - **R1** App Engine account roles: `gcloud projects get-iam-policy $P --flatten='bindings[].members' --filter="bindings.members:serviceAccount:$APPSPOT" --format='value(bindings.role)'`. Expect `roles/editor`; record anything else.
   - **R2** who can act as it: `gcloud iam service-accounts get-iam-policy $APPSPOT --project=$P --format='value(bindings.role,bindings.members)'`. Expect only the deployer's `serviceAccountUser`.
   - **R3** nothing runs as it: C39a/C39b (RUNBOOK K10) and C3 (step 101) show no `$APPSPOT`. `gcloud app describe --project=$P --format='value(id,servingStatus,serviceAccount)'`: record the result or "no App Engine application".
   - **R4** its activity: `gcloud logging read "protoPayload.authenticationInfo.principalEmail=\"$APPSPOT\"" --project=$P --freshness=30d --limit=20 --format='table(timestamp,protoPayload.serviceName,protoPayload.methodName)'`. Expect empty (Admin Activity only).
   - **R5** project-level publishers:
     ```bash
     for ROLE in $(flat | cut -f1 | sort -u | grep '^roles/'); do gcloud iam roles describe "$ROLE" --format='value(includedPermissions)' 2>/dev/null | tr ';' '\n' | grep -qx 'pubsub.topics.publish' && flat | awk -F'\t' -v r="$ROLE" '$1==r && $2 !~ /^user:/ {print r, $2}'; done
     flat | cut -f1 | sort -u | grep '^projects/'
     ```
     The second line lists custom roles (expect none). Expect only Google service agents plus `$APPSPOT` (Editor) before A2.
   - **R6** topic: `gcloud pubsub topics get-iam-policy billing-guard --project=$P --flatten='bindings[].members' --format='value(bindings.role,bindings.members)'`. Expect only `roles/pubsub.publisher` for `billing-budget-alert@system…`.
   - **R7** billing account: `gcloud billing projects describe $P --format='value(billingAccountName,billingEnabled)'` (don't paste the ID), then `gcloud billing projects list --billing-account=<BILLING_ID> --format='value(projectId)'`. Expect exactly `hireframe-f6b03`.
   - **R8** APIs: `gcloud services list --enabled --project=$P --format='value(config.name)' | sort`. Note `compute`, `monitoring` and the K17 list.
   - **R9** guard now: C14b, the K12 env read (no `BILLING_GUARD_MODE`), and `flat | grep "serviceAccount:$GUARD"` (expect nothing).
   - **R10** console, Billing → Reports: this month and last, grouped by service, for this project. Note the services that carry function costs.
   - **R11** console, Budgets & alerts → Create budget: check that a spend-cap option is offered in GBP for that service, and whether a cap can be scoped per service or exclude `billingGuard` (D5). **Don't save.**
   - **R12** roles: `gcloud iam roles describe roles/billing.projectManager --format='value(includedPermissions)' | tr ';' '\n' | grep deleteBillingAssignment` and `gcloud iam roles describe roles/browser --format='value(includedPermissions)' | tr ';' '\n' | grep -x resourcemanager.projects.get`. Each prints one line.
   - **R13** C43: the deployer's roles equal the post-v1.0.0 baseline (K26).
   - **R14** runtime identities: `gcloud functions list --gen2 --project=$P --format='table(name,serviceConfig.serviceAccountEmail)'`. Expect every function on a dedicated account (`hireframe-fns@…`, `hireframe-billing-guard@…`) and none on `$APPSPOT` or the compute default. Any function with no explicit account runs as the App Engine default: record it and stop before A2.
   - **R15** console, IAM → the App Engine account's row → excess-permissions insight: record what it says about `roles/editor`. If it asks to enable an API, skip it (don't enable) and note "skipped".
   - **R16** invoker: `gcloud run services get-iam-policy billingguard --region=$R --project=$P --format='value(bindings.role,bindings.members)'`. Expect only `roles/run.invoker` for the Eventarc trigger account (the guard account, as C46). Anything else → stop.
   - **R17** console, Billing → Budgets & alerts: for each budget open its notifications. Only `hireframe-kill` publishes to the `billing-guard` topic; the £2, £5 and £10 budgets are email only. (Console only: the Budget API stays disabled outside a K step.)
   - R5 and R6 (project-level publishers and the topic policy) are the STATUS precondition and run again at A0 and B0.

**Window A (weekday 10:00–16:00, no deploy)**

| Step | What Beeb does | Expected | Rollback |
|---|---|---|---|
| A0 | R1–R9 and R14–R17 again, the same day, before any change | as the reads; any surprise → stop before A1 | — |
| A1 | `cd ~ && flat > ~/iam-before-101a.txt && wc -l ~/iam-before-101a.txt` | line count recorded | — |
| A2 (D3) | `gcloud projects remove-iam-policy-binding $P --member=serviceAccount:$APPSPOT --role=roles/editor --condition=None` | R1 prints no `roles/editor` | `add-` with the same arguments |
| A3 | `flat > ~/iam-after-101a.txt && diff ~/iam-before-101a.txt ~/iam-after-101a.txt`; C43 | exactly `< roles/editor serviceAccount:<project>@appspot…`; any other line → stop | per line |
| A4 (D8) | Logs Explorer, query: `logName="projects/hireframe-f6b03/logs/cloudaudit.googleapis.com%2Factivity" AND protoPayload.serviceName="serviceusage.googleapis.com" AND (protoPayload.methodName:"EnableService" OR protoPayload.methodName:"BatchEnableServices")`, range = max. Then Actions → Create log alert `hireframe-api-enabled`, 5 min notification rate, owner email channel. If the console asks to enable an API → stop and ask | ≥ 1 historic match; the policy is listed and enabled | delete the policy |
| A4b (D8) | Logs Explorer, query: Cloud Run revision logs of `billingguard` at ERROR whose message is `billing_guard.failed`. Check the field names first by running the same query with `billing_guard.below` (the K12 publish rows) and reading one row; then Create log alert `hireframe-guard-failed`, 5 min notification rate, owner email channel. Same console rules as A4 (an API prompt → stop and ask). No VM-creation alert: Compute is off and A4 covers enabling it | the policy is listed and enabled; the `below` check shows the field names | delete the policy |
| A5 (D6) | Budgets & alerts → `hireframe-kill` → Scope → Projects: only `hireframe-f6b03` → Save. Re-open: amount £25, actual, topic still `billing-guard` | scope shows the one project; refused → record the message, Decision 6 B | edit back |
| A6 (D7) | Per Decision 7 (A: record each API and its reason; B: each disable shown alone) | per decision | `gcloud services enable <api> --project=$P` |
| A7 (D5) | If A/B: Create budget `hireframe-cap-functions`, this project, the R10 service, about £40 (above the £25 kill budget), or with `billingGuard` excluded if R11 allowed it, spend cap on, **no** topic link | listed, spend cap, not enforced | lift, then delete |
| A7b (G2.4) | In order, one command at a time, each shown and approved first: (1) `gcloud pubsub subscriptions create hireframe-capture-tmp --topic=billing-guard --expiration-period=1d --project=$P`; (2) wait up to about 30 min for a budget message, then `gcloud pubsub subscriptions pull hireframe-capture-tmp --limit=1 --auto-ack --project=$P --format=json`; (3) paste only the field names, `attributes` keys and the non-identifying values (never the real account or budget ID); (4) `gcloud pubsub subscriptions delete hireframe-capture-tmp --project=$P`. The temporary subscription is pull-only and separate from the push subscription that feeds `billingGuard` | one message captured; field names match Google's schema (`budgetId` in the attributes, or not); the subscription is deleted (`gcloud pubsub subscriptions list` no longer shows it) | delete the subscription (it also expires after 1 day) |
| A8 | C1–C3, C39a/C39b; the live site loads; the next scheduled scan and the digest | as RUNBOOK K10/K11 | per Recovery |

3. **Clean weekday** (Decision 12) on the next weekday. Paste the five reads. Meanwhile Claude builds G2 (review included).

**Window B: v1.0.1 (weekday 10:00–16:00, digest arrived, nothing Generating)**

| Step | What Beeb does | Expected | If it fails |
|---|---|---|---|
| B0 | R5, R6, R7, R9 again; `cd ~ && flat > ~/iam-before-101.txt`; C43 | as the reads; R5 = Google agents only (plus the user Owner, not pasted) | any extra publisher → stop |
| B1 | Merge G2 (CI green). `git checkout main && git pull && git log -1` (G2 merge); `git log --oneline v1.0.0..HEAD` | only the K28 docs PR, G1 and G2 | other commits → stop (Decision 11) |
| B2 | `git tag v1.0.1 && git push origin v1.0.1`, approve `production`; record times | every function `Successful update operation`; no failure | partial → stop, Claude diagnoses; no grant today |
| B3 | C14b, C46, C39a/C39b, C1–C3 (RUNBOOK K10/K11) | unchanged from v1.0.0 | Recovery entries |
| B4 | `gcloud functions describe billingGuard --region=$R --gen2 --project=$P --format='value(serviceConfig.environmentVariables)'`; same for `scheduledScan` | `BILLING_GUARD_MODE: armed` on both (expected, harmless) | absent → stop |
| B5 | ≥ 2 min after the deploy: the RUNBOOK K12 £1 publish (`costAmount 1`) + log read | `billing_guard.below`, `mode: armed`, ≤ 2 min; `billingEnabled` `True` | nothing → Recovery "logs nothing after a publish" |
| B6 (arm, by 15:30) | `gcloud projects add-iam-policy-binding $P --member=serviceAccount:$GUARD --role=roles/billing.projectManager --condition=None` then the same with `--role=roles/browser` | `flat \| grep "serviceAccount:$GUARD"` prints exactly the two | disarm: the same with `remove-` |
| B7 | `flat > ~/iam-after-101.txt && diff ~/iam-before-101.txt ~/iam-after-101.txt`; C43 | exactly two `>` lines for `$GUARD`; deployer unchanged | other line → stop |
| B8 | the £1 publish again + log read; `billingEnabled` | `below`, `mode: armed`; `True` | stop, disarm |
| B9 | Scan-now proof: Scan now Succeeded; `digestNow` Completed with mail; scheduler list three ENABLED; live site loads | as v0.9.1 steps 5–8 | stop, Claude diagnoses |
| B10 | Within 24 h: the K13 log read, `--freshness=1d`, plus a per-severity count | the **first real message after B6** is `billing_guard.below`, `mode: armed` (the log has no separate decision field: the event name is the decision); all real messages `below`, `mode: armed`; no `invalid`/`failed`/`disabled`/WARNING+ | `.invalid` → disarm (B6 `remove-`), diagnose |
| B11 | The next scheduled scan Succeeded; the next digest arrived | — | Recovery |
| B12 | `gcloud auth revoke` on the laptop (C41). Paste the results for G3 | — | — |

**Never** publish `costAmount` ≥ 25 to `billing-guard` in prod: armed, it unlinks billing.

## 9. Noticed
1. **An enforced native functions cap also pauses `billingGuard`**, because it is a Cloud Run function. That is why Decision 5 (amended) puts the cap above the kill budget, at about £40, or excludes `billingGuard` if R11 shows per-service scoping. Confirm in R11 that the service list says so.
2. **#42 (CV quality, the user-facing win) now waits ≥ 3 weekdays after K28** behind an ops release that changes no code path #42 touches. If Beeb lets #42 ship first, the clean weekday moves to v1.1.0 instead (R2).
3. **Detection gap:** A4b now alerts on `billing_guard.failed`. Nothing alerts on `billing_guard.disabled` (billing going off is hard to miss) or on VM creation (Compute is off, and A4 covers enabling it). Both left out on purpose.
