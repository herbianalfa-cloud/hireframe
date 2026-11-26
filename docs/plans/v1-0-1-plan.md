Status: Draft

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

## 2. Goal and definition of done

**Goal:** turn `billingGuard` from dry run to armed (option A: `roles/billing.projectManager` + `roles/browser`), after closing what has to be closed first. That covers the App Engine account's Editor, the deployer's `serviceAccountUser` on it, `hireframe-kill`'s scope, the K17 API leftovers and an API-enable alert. It also covers a recorded choice on native spend caps. v1.0.1 changes no function code and adds no function.

**Done when (each item says how it is measured):**
1. **Preconditions:** `git ls-remote --tags origin v1.0.0` shows the tag. K28's docs PR is merged. The evidence doc records the clean weekday(s) per Decision 12.
2. **App Engine account:** after A2, the R1 read prints no `roles/editor`, or Decision 3's "accept" is recorded with its reason in the ADR addendum. The deployer's `serviceAccountUser` on it is kept with the code reason (Decision 4). R2 still shows it.
3. **Publishers:** R5 lists only the `user:` Owner (accepted, not pasted) and Google service agents (listed by role) as project-level holders of `pubsub.topics.publish`. R6 shows only Google's budget publisher on the topic. Both run in B0 on the release day.
4. **Kill-budget scope:** the budget list shows `hireframe-kill` scoped to `hireframe-f6b03` only. If Decision 6 → B: R7 prints exactly one project, and the RUNBOOK rule is in G2.
5. **K17:** each API refused at K17 has a recorded outcome (disabled, or kept with a reason) in the evidence doc.
6. **API-enable alert:** Monitoring → Alerting lists `hireframe-api-enabled`, enabled, with the owner's email channel (set in the console, never in the repo). Its query shows ≥ 1 historic match in Logs Explorer, which proves the filter.
7. **Native cap:** Decision 5 is recorded. If a cap is chosen, Budgets & alerts lists it with spend cap on and not enforced.
8. **Repo (G2):** `node .claude/kit/gate.mjs` all 0. `npm run build` writes `functions/deploy/.env.hireframe-f6b03` containing exactly `BILLING_GUARD_MODE=armed`, and no `.env`, `.env.prod` or `.env.local` there. `node scripts/smoke-functions-bundle.ts` asserts and prints it. The existing dry-run wiring test (env unset → no `fetch`) still passes unchanged.
9. **Release:** `v1.0.1` points at a `main` commit containing G2. `git log --oneline v1.0.0..v1.0.1` lists only the K28 docs PR, G1 and G2 (Decision 11). The Deploy log shows every function `Successful update operation` (the env change alters every function's hash, `hash.js:11`) and no failure. Job time recorded.
10. **Armed (B4–B8):** the env read shows `BILLING_GUARD_MODE=armed` on `billingGuard`. A £1 publish logs `billing_guard.below` with `mode: armed` within 2 min, both before and after the grant. `flat | grep $GUARD` prints exactly the two roles. The IAM diff vs `iam-before-101.txt` is exactly those two `>` lines. `billingEnabled` is `True`. **No over-threshold publish in prod, ever.**
11. **Post-deploy:** C1–C3, C14b, C46, C39a/C39b as in RUNBOOK K10/K11. Scan-now proof (System Succeeded, `digestNow` Completed with mail, three scheduler jobs ENABLED). Live site loads.
12. **C47-armed:** within 24 h of B6, a real budget message is logged as `billing_guard.below`, `mode: armed`. The 24 h per-severity read shows no `invalid`, `failed`, `disabled` or WARNING+ guard rows.
13. **Closeout (G3):** the evidence doc is filled. STATUS, CHANGELOG `[1.0.1]` (dated), the ADR addendum results line and the ROADMAP parking lot are updated. Gate 0.

## 3. Rules that apply
- **WORKFLOW gate 5 / C11:** Claude never merges, tags, deploys or touches gcloud, IAM or the console. Beeb runs every command, each shown in chat and approved first (memory: show admin commands, wait for OK).
- **IAM:** only `add-`/`remove-iam-policy-binding`, **never `set-iam-policy`**. Never touch the `user:` owner binding. Every member spelled out. Snapshot (`flat > ~/iam-*.txt`) before and `diff` after every change. Snapshots stay in `~`, never the repo.
- **C5 / never relax:** the £25 `hireframe-kill`, £2 and £10 budgets, the 3200p cap, the 52p lease and every daily cap stay as they are. A native cap only adds a limit (Decision 5). A failing gate, bundle or eval budget is Beeb's call.
- **CLAUDE.md no-self-triggering:** G2 adds no function, trigger or loop. `billing/*.ts` is unchanged, and its source guard (no publish, Firestore, Cloud Tasks or timers) still runs. The alert and the native cap are console objects that only send email. Say so in the G2 PR body.
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
- [ ] **G1.2 Pre-flight (read-only, after the K28 docs PR merges).** First update the branch from `origin/main` (show the rebase or merge command; Beeb approves).
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
Branch `feat/v1-0-1-arming-g2` from `origin/main` after G1 merges. Built while the clean weekday runs. **Merged by Beeb only at B1.**

- [ ] **G2.1 Deploy env for the guard (tests first).**
  - Allowed files:
    - `functions/src/deploy-env.ts` (new, import-free so `scripts/` can import it with `.ts`, as `scripts/load-test.ts` does);
    - `functions/src/deploy-env.test.ts`;
    - `scripts/build-functions.ts`;
    - `functions/src/config.ts` (only if the builder keeps the mode constant there; small decision, listed in the PR);
    - `functions/src/config.test.ts`.
  - Pre-checks: G1.2 item 3 holds. Decision 1 = A.
  - Tests to write first:
    - `deployEnvFile()` returns exactly `{ name: '.env.hireframe-f6b03', content: 'BILLING_GUARD_MODE=armed\n' }`.
    - With the mode constant set to `dry_run` it writes `BILLING_GUARD_MODE=dry_run` explicitly (disarm path).
    - The name is never `.env`, `.env.local`, `.env.prod` or `.env.demo-*`.
    - The project in the name equals `.firebaserc`'s `prod` alias and the domain of `BILLING_GUARD.serviceAccount`.
    - Round trip: the value parsed from the line, passed to `guardMode({[BILLING_GUARD.modeEnvVar]: value})`, gives `armed`.
  - Change: after the esbuild step, `build-functions.ts` writes that one file into `functions/deploy/`.
  - Acceptance:
    - tests pass; gate 0;
    - `npm run build`, then the file exists with exactly one line;
    - `npm run dev` still starts (the emulator, `demo-hireframe`, never loads `.env.hireframe-f6b03`, `env.js:179-190`);
    - `billing/*.ts` is untouched; the dry-run wiring test passes unchanged.
  - Hard area: **yes**.
- [ ] **G2.2 Smoke check.**
  - Allowed files: `scripts/smoke-functions-bundle.ts`.
  - Change: assert `functions/deploy/.env.hireframe-f6b03` is exactly `BILLING_GUARD_MODE=(armed|dry_run)` and print the value. Fail if `.env`, `.env.prod` or `.env.local` exists in `functions/deploy/`.
  - Tests: run it after `npm run build`, then once with the file deleted by hand (must fail).
  - Acceptance: exit 0 on the real build; non-zero on the planted cases. Hard area: yes.
- [ ] **G2.3 Docs.**
  - Allowed files: `docs/DECISIONS.md` (ADR-059 addendum, plus an ADR-060 addendum for Decisions 3–4), `docs/RUNBOOK.md`, `docs/SECURITY.md` (billing row), `docs/ARCHITECTURE.md` (`billingGuard` row), `CHANGELOG.md` (`[1.0.1]` Unreleased), `STATUS.md`, `docs/plans/v1-0-1-plan.md`.
  - The ADR addendum records:
    - the mechanism (Decision 1);
    - the order (Decision 2: code first, roles last);
    - option A's roles at project level;
    - the disarm route (remove the two roles, then flip the constant and release a patch);
    - the deployer's `actAs` on the App Engine account kept, with the firebase-tools citation;
    - "every function now carries `BILLING_GUARD_MODE`; only `billingGuard` reads it".
  - RUNBOOK gets a new **Part L (v1.0.1)**:
    - the reads R1–R13 and steps A1–A8 and B0–B12 exactly as section 8;
    - "never publish at or above the threshold in prod";
    - "set `hireframe-kill`'s scope before linking any other project to the billing account";
    - Recovery entries **"Disarm `billingGuard`"** and **"API-enabled alert fired"**.
  - Acceptance: every command in Part L matches section 8 word for word. `scan:pii` clean. Gate 0.
  - Hard area: yes (IAM text).

G2 review: `reviewer-deep`. Gate set: the gate, `npm run build`, `smoke-functions-bundle`, `check:bundle`, `test:rules`, `audit`. The PR body states the no-self-triggering check.

### G3: closeout (after C47-armed and the next scheduled scan)
Branch from `origin/main` after the v1.0.1 tag.

- [ ] **G3.1 Evidence and docs.**
  - Allowed files: `docs/plans/v1-0-1-evidence.md`, `STATUS.md`, `CHANGELOG.md` (`[1.0.1]` date), `docs/DECISIONS.md` (one results line: the publisher read, the App Engine outcome, the K17 outcomes), `docs/ROADMAP.md` (parking lot), `docs/plans/v1-0-1-plan.md`, and `docs/PROJECT.md` lines 3.4/3.6/3.13/3.14 ("dry run, armed in v1.0.1" → "armed") **only if Decision 13 = A**.
  - Acceptance: every row has a result or "not done + why". STATUS ≤ 1 page (move old Lessons to LEARNINGS). `scan:pii` clean. Gate 0. The plan's `Status` line is left for Beeb.
  - Hard area: no.

## 5. Decisions (recommendation first; all open unless marked)

| # | Decision | Options | Recommendation + why | In STATUS Decisions? |
|---|---|---|---|---|
| 1 | How prod gets `BILLING_GUARD_MODE=armed` | **A:** the build writes `functions/deploy/.env.hireframe-f6b03` from one constant in `functions/src/`. B: a plain `.env` file. C: make `guardMode` default to armed. D: `gcloud run services update --update-env-vars` | **A.** firebase-tools loads `.env.<projectId>` only for that project (`env.js:179-183`), so the emulator (`demo-hireframe`) stays dry run, and ADR-059's "unset = dry run" stays true. The value is reviewed in a PR. Trade-off: every function gets the variable and redeploys (`hash.js`). Rejected: B arms the emulator too. C breaks ADR-059's safety default. D drifts, because the next deploy overwrites it. | No (new) |
| 2 | Order in window B | **A:** deploy the armed code first, check, then grant the two roles last. B: grant first, then deploy | **A.** Armed code without a billing role can't disable anything (a 403 → `failed`), so the grant is the single switch. It is instant and removed with one command, and the 15:30 hard stop is safe. B leaves no inert stage. | No (new) |
| 3 | App Engine default account's Editor | **A:** remove it in window A, after R1–R4 show nothing runs as it. B: accept with a reason. C: disable the account | **A.** It can publish to `billing-guard`, so it can forge a kill once armed. The deployer can act as it (`serviceAccountUser`), so a deploy could run code with Editor. No function, trigger or scheduler job uses it (C39b, C3). Rollback is one `add-` command. Trade-off: unknown Google-side users; R4 only sees Admin Activity logs. C is untested and broader. | Yes: **re-confirm** ("removed, or accepted with a reason") |
| 4 | The deployer's `serviceAccountUser` on the App Engine account | **A:** keep it, and record why. B: remove it and prove with a deploy. C: delete the account | **A.** firebase-tools 15.34.1 runs `checkServiceAccountIam` before every functions deploy and throws unless the deployer has `actAs` on `<project>@appspot…` (`deploy.js:83`, `checkIam.js:31-47`). B would fail every deploy in prepare. C is hard to undo, with unknown side effects. Revisit when firebase-tools changes (G1.2 item 3). | No (new; parallels ADR-060 for the compute account) |
| 5 | Native spend caps vs `billingGuard` (GA 31 Oct 2026) | **A:** arm the guard and add one native cap on the billing service that carries our function costs, at £25. B: the same at a lower amount (for example £10). C: park native caps. D: native caps instead of arming | **A.** Caps cover only Gemini, Vertex, Cloud Run and Cloud Run functions, per project and service. They never delete resources, act on estimated cost (faster) and auto-lift monthly. They are not hard caps (lag; overage billed). At £25 the guard still covers every other service first (Compute, Firestore, Storage, Build). The cap is a gentler, earlier stop if functions alone run away. **Trade-off:** an enforced functions cap pauses the app **and `billingGuard` itself** for the rest of the month, so B buys speed at the price of the backstop. D is rejected: it leaves the stolen-account route (Compute) uncovered. Cost £0 (no fee listed). | Parked idea (11 Nov), now decided |
| 6 | `hireframe-kill` scope ("All projects (1)") | **A:** in window A, retry in the console to set the scope to `hireframe-f6b03` only; if refused, B. B: accept, plus R7 (one project on the billing account) in every arming pre-check, plus the RUNBOOK rule. C: set it with the Budget API (enable it for the step, then disable) | **A, then B.** Once armed, another project's spend would count toward the kill and unlink this project. A costs nothing. B is safe while R7 prints one project. C needs the API that stays disabled outside a K step. | Yes: **re-confirm** (v0.9.1 closeout K13 deviation; Budget API rule) |
| 7 | K17 carry-over (disables refused by `cloudapis` dependencies) | **A:** keep those APIs enabled, recording each with a reason; Decision 8's alert covers new enables. B: disable `cloudapis.googleapis.com` first, then retry each disable alone (no `--force`), each followed by the K17 check. C: `--force` | **A.** Idle APIs cost £0, and anyone who can misuse them as Owner can re-enable them. B is untested (unverified that disabling the umbrella leaves its dependencies alone) and needs a check per API. C is banned (never `--force`). Revisit with the K17 list in G1.2. | No (new; STATUS Done says "carry to v1.0.1") |
| 8 | API-enable log alert | **A:** one log-based alert on any Service Usage enable (all APIs). B: compute only, as scoped. C: none | **A.** The deployer can't enable APIs (`serviceUsageConsumer`), so an enable means a person or an attacker. It is rare and covers compute plus everything else at the same cost (≤ about $0.35/month, unverified). Trade-off: a console page that auto-enables an API will email too. | No (new) |
| 9 | Window shape | **A:** window A (no deploy: Editor, alert, scope, K17, cap) → one clean weekday → window B (release). B: everything in one window | **A.** One risky change per release (m8c §1). If a scan fails, the cause is never in doubt. Trade-off: at least 3 weekdays after K28. | No (new) |
| 10 | Re-run the throwaway armed kill test | **A:** only if G1.2 item 4 shows billing or http-client changes since the spike. B: always. C: never | **A.** The prod armed path can't be tested without unlinking billing. The 17 Oct spike proved these exact roles on the same code path (C30 `False`). | No (new) |
| 11 | Merges between v1.0.0 and v1.0.1 | **A:** hold Dependabot and every other PR until the v1.0.1 tag, so v1.0.1 = G1 + G2 only. B: Dependabot after K28 as planned | **A.** Keeps the arming release single-purpose and the clean weekday meaningful. Trade-off: Dependabot waits a few more days. | Yes: **re-confirm** (Release plan, 24 Nov) |
| 12 | Clean weekday definition | **A:** a full London weekday after v1.0.0's deploy day (and after window A) with: both scheduled runs Succeeded (System); the digest arrived; that day's `billing_guard.*` rows only `below`/`dry_run`, none WARNING+; three scheduler jobs ENABLED; IAM `flat` diff vs the last snapshot empty. B: the same, without the IAM diff | **A.** Measurable and quick (about 5 reads). K28's 24-hour checks may fall on the same day. | Yes: **re-confirm** (speed-up policy 2–3) |
| 13 | PROJECT.md wording ("dry run, armed in v1.0.1") | **A:** update the four lines in G3. B: leave for housekeeping | **A.** The spec would otherwise be wrong on a security control. | No (new) |
| R1 | Arming = option A (17 Oct) | Keep / change | **Keep.** New since: native caps are GA (Decision 5), which doesn't change the roles. | Yes: **re-confirm** |
| R2 | #42 merges only after the v1.0.1 tag; then #43, #45 + #44 | Keep / let #42 go first | **Keep** (Beeb's 24 Nov call). New since: arming now needs ≥ 3 weekdays after K28 (Decision 9), so #42 waits that long. See Noticed 2. | Yes: **re-confirm** |

## 6. Risks

**Security**
- **Forged kill once armed:** anyone with `pubsub.topics.publish` can unlink billing. Mitigations: R5 and R6 before B6; removing Editor from the App Engine account (Decision 3); the compute account's Editor goes at v1.0.0 K24.
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
   - **R11** console, Budgets & alerts → Create budget: check that a spend-cap option is offered in GBP for that service. **Don't save.**
   - **R12** roles: `gcloud iam roles describe roles/billing.projectManager --format='value(includedPermissions)' | tr ';' '\n' | grep deleteBillingAssignment` and `gcloud iam roles describe roles/browser --format='value(includedPermissions)' | tr ';' '\n' | grep -x resourcemanager.projects.get`. Each prints one line.
   - **R13** C43: the deployer's roles equal the post-v1.0.0 baseline (K26).

**Window A (weekday 10:00–16:00, no deploy)**

| Step | What Beeb does | Expected | Rollback |
|---|---|---|---|
| A1 | `cd ~ && flat > ~/iam-before-101a.txt && wc -l ~/iam-before-101a.txt` | line count recorded | — |
| A2 (D3) | `gcloud projects remove-iam-policy-binding $P --member=serviceAccount:$APPSPOT --role=roles/editor --condition=None` | R1 prints no `roles/editor` | `add-` with the same arguments |
| A3 | `flat > ~/iam-after-101a.txt && diff ~/iam-before-101a.txt ~/iam-after-101a.txt`; C43 | exactly `< roles/editor serviceAccount:<project>@appspot…`; any other line → stop | per line |
| A4 (D8) | Logs Explorer, query: `logName="projects/hireframe-f6b03/logs/cloudaudit.googleapis.com%2Factivity" AND protoPayload.serviceName="serviceusage.googleapis.com" AND (protoPayload.methodName:"EnableService" OR protoPayload.methodName:"BatchEnableServices")`, range = max. Then Actions → Create log alert `hireframe-api-enabled`, 5 min notification rate, owner email channel. If the console asks to enable an API → stop and ask | ≥ 1 historic match; the policy is listed and enabled | delete the policy |
| A5 (D6) | Budgets & alerts → `hireframe-kill` → Scope → Projects: only `hireframe-f6b03` → Save. Re-open: amount £25, actual, topic still `billing-guard` | scope shows the one project; refused → record the message, Decision 6 B | edit back |
| A6 (D7) | Per Decision 7 (A: record each API and its reason; B: each disable shown alone) | per decision | `gcloud services enable <api> --project=$P` |
| A7 (D5) | If A/B: Create budget `hireframe-cap-functions`, this project, the R10 service, the amount chosen, spend cap on, **no** topic link | listed, spend cap, not enforced | lift, then delete |
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
| B10 | Within 24 h: the K13 log read, `--freshness=1d`, plus a per-severity count | real messages `below`, `mode: armed`; no `invalid`/`failed`/`disabled`/WARNING+ | `.invalid` → disarm (B6 `remove-`), diagnose |
| B11 | The next scheduled scan Succeeded; the next digest arrived | — | Recovery |
| B12 | `gcloud auth revoke` on the laptop (C41). Paste the results for G3 | — | — |

**Never** publish `costAmount` ≥ 25 to `billing-guard` in prod: armed, it unlinks billing.

## 9. Noticed
1. **An enforced native functions cap also pauses `billingGuard`**, because it is a Cloud Run function. That is why Decision 5 recommends the cap at the kill amount, not below it. Confirm in R11 that the service list says so.
2. **#42 (CV quality, the user-facing win) now waits ≥ 3 weekdays after K28** behind an ops release that changes no code path #42 touches. If Beeb lets #42 ship first, the clean weekday moves to v1.1.0 instead (R2).
3. **Detection gap:** nothing alerts on `billing_guard.failed`/`disabled` or on `compute.instances.insert` (the stolen-account VM route). A second log alert at the same cost would cover both. Parked unless Beeb wants it in window A.
