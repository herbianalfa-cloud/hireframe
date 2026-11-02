# Hireframe: status & handoff

_Updated: 2026-11-02 · Playbook 3.0 · Kit 3.0.2_

The repo copy is the master. Spec: `docs/PROJECT.md`. Plans: `docs/plans/`. Older detail (Done before 8C, older Lessons, full Next and Parked text): `LEARNINGS.md`.

## Decisions
- **Billing guard arming (v1.0.1): option A** (17 Oct). The prod guard gets `billing.projectManager` + `roles/browser`, the tested path. Recorded in the ADR-059 addendum (PR #41).
- **CV quality** (17–18 Oct): draft PR #42. Merge only after v1.0.0, after a rebase on `main` once PR #41 merges.
  - Below 8/10, ship the best valid CV with its score shown. One revision round. Report-only model judge in the eval.
  - Section order: Summary, Education, Experience, Projects, Skills. Arial. "Dear Hiring Team,". Keep the en dash in date ranges.
  - Degree classification goes on the degree line (`achievementRef`). Gap questions stay with the 7D path (tightening parked).
- **App Engine default account's Editor:** stays in the ROADMAP parking lot (never spiked). v1.0.1 precondition: "removed, or accepted with a reason".
- **firebase 13 held** (20 Oct): firestore 4.18.0 adds ~10 kB gzip (BSON types), so initial JS would be 306 > 300 kB. Budget stays 300 kB. PR #44 stays a draft until ROADMAP item E (PR #45) frees the budget.
- **Item E budget** (20 Oct, PR #45): initial JS 200 kB gzip plus a separate 165 kB cap on the Firestore chunk (ADR-066; amends ADR-021). Takes effect when #45 merges.
- **PR #45 merge order** (20 Oct): draft until RUNBOOK K28 is done. Then #42 → #43 → #45 → #44. #45 and #44 ship together in one Hosting-only release.
- **Speed-up policy:**
  1. Work while gates run. A gate blocks the release, not the building.
  2. **Scan-now proof** for minor releases: right after the deploy, Scan now → System shows Succeeded → `digestNow` → `gcloud scheduler jobs list --location=europe-west2`.
  3. **Full clean-weekday gate only** for releases that change scanning, scheduling, cost or IAM in a live way. v1.0.1 (arming) needs one full clean weekday on v1.0.0 first.
  4. Batch releases. Wave 2 ships in 2–3 releases.
  5. Scope filter for Waves 2–3: build only features that get interviews unless Beeb asks for more.
- **Docs hygiene (2 Nov):** CLAUDE.md aligned with kit PR groups and /milestone; Docs line and gate command added; App Engine Editor K24 vs Decisions resolved.
- **Playbook 3.0 + kit** (Nov 2026): `STATUS.md` and `docs/PROJECT.md` live in the repo and are the masters. Claude Code works through `/milestone`, `/build`, `/ship`, `/retro`.

## Done
One line per milestone (full entries in `LEARNINGS.md`).
- **Setup:** public repo `herbianalfa-cloud/hireframe`, ruleset `protect-main` (checks `check`, `gitleaks`, `audit`, `rules`); Firebase `hireframe-f6b03` (Blaze, europe-west2); five secrets in Secret Manager; Gmail labels `hireframe/alerts` and `hireframe/done`.
- **M0–M3** (PRs #1–#8, v0.1.0–v0.3.0): monorepo, CI, owner-only rules, App Check, profile brain, `llm.call()`, sources, dedupe, watchlist.
- **M4 Funnel** (v0.4.0–v0.4.1): S1 → S2 Haiku → S3 Sonnet; eval live 85.0% (gate 80%).
- **M5 Dashboard** (v0.5.0–v0.5.3): Today, Jobs, Job detail, System. **Funnel intake** (v0.5.4, v0.6.1) and **sort/filter** (v0.5.5): cap 3200p/month, lease 52p.
- **M6** (v0.6.0–v0.6.2): Gmail bridge (Apps Script, HMAC) and Lookup. Speed marks v0.6.3.
- **M7** (v0.7.0–v0.7.4, 12 Oct): summary bar, digest, CV engine, pipeline, callable hardening.
- **8A** (v0.8.0, 14 Oct): run health, "gone" boards. **8A2** (v0.8.1): Today speed, R7 amended to the phone median.
- **8B** (v0.9.0, 15 Oct): `deleteAllData`, `purgeOldData`, managed backups, load test.
- **8C1** (PR #39, 16 Oct, merged, not tagged): `billingGuard` (dry run), HTTP client `putJson`, C4/C5 tests. Reviews `m8c1-review.md`, `m8c1-review-2.md`.
- **8C Phase 1 spike** (17 Oct, `docs/plans/m8c-spike-results.md`): Path F build passes; `billing.projectManager` alone fails the read, needs `roles/browser`.
- **8C2 built** (17 Oct): PR #41, head 0743bdf, CI and gate green. Plan `m8c2-plan.md`; review `m8c2-review.md` (all fixed). 14 functions with literal `maxInstances: 1` + `timeoutSeconds`; ADR-060; ADR-059 addendum; RUNBOOK K14–K28; SECURITY checklist. The bundle hash changed, so v1.0.0 rebuilds every function.
- **Clean weekday on v0.9.0:** Fri 16 Oct. **R7 phone test** (step 97): passed 20 Oct. **Restore drill** C17–C20: done 20 Oct (backup `41ead5bb-…`, restore-drill deleted).
- **v0.9.1 K1–K5 done** (20 Oct): C1/C2/C3 checked, deployer has the 7 baseline roles, topic `billing-guard` and SA `hireframe-billing-guard` created. The Billing Budget API stays disabled outside a K step.
- **Kit and deps** (late Oct): kit 3.0.2 (#53) with `npm audit fix` (zod via clasp allowlisted to 2027-01-31); Dependabot #46 and #49 merged.
- **PR #45 built** (20–24 Oct, draft, ADR-066): initial JS 295.6 → 164.7 kB gzip; Firestore chunk lazy at 131.0 kB. Opus Medium review fixed; L7 bug (Try again cannot recover a failed chunk) fixed with a click-only full reload. Gate green except `test:rules` (port conflict with `npm run dev`).

## Lessons (20 Oct onwards; older ones in `LEARNINGS.md`)
- [tech] **Node per branch** (20 Oct): after every branch switch, run `nvm use` (reads `.nvmrc`), then `npm ci`. Start `claude` after `nvm use`. nvm is a shell function: in Claude Code bash, source `/opt/homebrew/opt/nvm/nvm.sh` first.
- [tech] **Check `check:bundle` before planning a dependency bump:** a minor Firebase bump can push initial JS over 300 kB (firestore 4.18.0, +10 kB gzip).
- [tech] **zsh reads `$VAR:r…` as a modifier** (20 Oct). Write `${VAR}` before a colon, or run the block in `bash <<'EOF'`. Give heredoc blocks outside numbered lists in chat.
- [tech] **Firestore document counts:** the console shows none. Use a `runAggregationQuery` count with curl and `gcloud auth print-access-token`, in bash. Pick a named database with the console's database selector.
- [process] The restore drill is safe on a weekday, because it never touches `(default)`. RUNBOOK step 103 says "weekend": fix the wording in the next docs PR.
- [process] **RUNBOOK Part K runs fine in a laptop `bash` tab**: type `bash`, then paste the Part K setup block.
- [tech] **A new service account can return NOT_FOUND on `describe` for up to a minute** after `create`. Wait 60 s; never re-run the create.
- [process] Splitting Part K across days is safe up to K5. Never stop between K6 and K9: the K6 pre-grant stays on until K9.
- [tech] rolldown's default `includeDependenciesRecursively` let the `firestore` chunk group swallow `@firebase/app`, util and component. Set it to `false` on that group (PR #45).
- [tech] **A failed dynamic import stays failed in the browser:** only a full page reload recovers. A chunk-load error must offer a click-only Reload (PR #45, L7).
- [process] `npm run test:rules` fails with "port taken" while `npm run dev` emulators run. Stop `npm run dev` first.
- [tech] In dev, `hf:firestore` came after `hf:auth`. Judge the order on the built site (step 89) before you change it.
- [process] Chrome request blocking: in Network, right-click the request → **Block request URL**.

## In progress
**M8 8C.** State confirmed 2 Nov: only K1–K5 are done (git tags show only v0.9.0):
- v0.9.1: K6 → K7 tag (from `main`; PR #41 unmerged) → K8–K13 (K12 dry run, K13 budgets £2/£5/£10 + `hireframe-kill` £25) → Scan-now proof → C47 within 24 h of K13. **Not done:** v0.9.1 is not tagged; K6 onward, the Scan-now proof and C47 are not started.
- Phase 3 (K14–K18): weekday 10:00–16:00 after the Scan-now proof, each step approved alone. **Not done:** not started.
- Phase 4 (K19–K28) = v1.0.0: after all five gates (phone test, restore drill, clean weekday: done; Scan-now proof on v0.9.1 and C47: not done); weekday 10:00–16:00; nothing Generating. K20 merges PR #41.
- K order: K19 record gates → **K20 evidence commit, merge #41** → K21 snapshot → K22 buckets → K23 Path F grants → **K24 Editor removal, then straight to K25 tag v1.0.0** → K26 `diff -u` → K27 live checks → K28 24-hour checks, `gcloud auth revoke`, follow-up docs PR (C50, K26, K27, K28, C41).

**Open PRs:**
- **#41** (8C2, `feat/m8c2-hardening`): ready, not merged. Merge only at K20.
- **#42** (CV quality, `feat/cv-quality`, head 40b4b7d): draft. Reviewed twice, Fix A/B/C done, gate green, CV eval 7/7 ≥ 8 (mean 9.66), RUNBOOK I7 passed 19 Oct.
- **#43** (CV preview, `feat/cv-preview`, head aa42e0f): draft. Reviewed, fixes in, gate green.
- **#44** (firebase 13 + Node 24, `chore/deps-firebase-13`): draft, HELD until #45 frees the budget.
- **#45** (Firestore out of initial JS, `perf/firestore-lazy`): draft until K28.

## Next
1. **Use it daily.** Morning: digest → Today → Pipeline → apply → 👍/👎. Daily LinkedIn sweep in Lookup. Read every CV before you send it.
2. **M8 releases:** confirm v0.9.1 + Scan-now proof → K14–K18 → K19–K28 (v1.0.0; never on a Sunday) → follow-up docs PR.
3. **v1.0.1: arm the guard (option A).** Approved separately. Needs one clean weekday on v1.0.0; prod guard granted `roles/browser` + `billing.projectManager`; `BILLING_GUARD_MODE=armed`; topic policy shows only the budget publisher; App Engine Editor removed or accepted with a reason; a project-level publisher read.
4. **Queued PRs, after v1.0.0** (details in `LEARNINGS.md`, "Next §4–4d"):
   - #42 CV quality: rebase on `main` after #41 merges (show the force-with-lease command first), re-check ADR-062–064, merge, read the first real CVs.
   - #43 CV preview (ADR-065): rebase after #42, one Opus Medium re-review, Lighthouse a11y ≥ 95 + real-phone check, own Hosting-only release.
   - #45 then #44: decide the lazy-screens fix; rebase after #43 (move the Firestore check-bundle tests into #43's `scripts/check-bundle.test.ts`); one Opus Medium re-review; one Hosting-only release with a Lighthouse + cold `hf:usable` record before, and steps 89 and 97 after.
5. **After Wave 1:** audit token spend across the funnel (Opus plans it). Plan a video walkthrough (Opus). Then Waves 2–3 with the scope filter, in batched releases.
6. **Housekeeping:** fill the TBDs in `docs/PROJECT.md` (kill criteria, learning goal, time-boxes, pre-mortem, C10 identity, preview deploys, Playwright live smoke test).

## Parked ideas
Full list in `LEARNINGS.md` ("Parked ideas (full list)") and `docs/ROADMAP.md`.
- Evidence documents parsed into cited facts; the system asks for evidence on a CV item; personal eval from an owner export.
- **Selling Hireframe to an organisation** (8 Oct). Not started. Needs GitHub Pro, per-user caps, the buyer's billing, a C10 identity, commercial tier.
- CV LIVE batch 2 (about 30p) and CV quality follow-ups (short cover notes, judge as a gate, filler bullets, tighter 7D gap questions).
- 7D / v0.7.4 nits (archived fact vs active fact, withdraw race, `a` shortcut flicker, badge listener recovery, and others).
- From 8A2: reCAPTCHA load (F), slimmer Today docs (G), persistent cache (H). From 8C2: App Engine Editor; a custom role narrowing `roles/browser`; a build account.

## Pending / known
- **PR #45 lazy-screens decision (Beeb).** The lazy screens have no error boundary, so a failed screen chunk blanks the app (already true on `main` after a deploy for a tab left open). `loadTodayPage()` and `loadDashboardService()` also cache a failed promise. Recommended: one route error boundary with a click-only Reload, plus resetting both loaders on failure, inside #45.
- **Not done:** the v0.9.1 tag and Scan-now proof, C47, K14–K18 (not started). The R7 median `hf:usable` (ms) for the K20 evidence is not recorded.
- **Audit allowlist:** zod via `@google/clasp` until 2027-01-31. Review it by then.
- **Dependabot alert #4 (moderate): leave it open.** `sprintf-js` via `mammoth`, no patch; owner-only upload.
- The wipe dialog shows "[400]" after a refusal message (cosmetic). The Pipeline hydration warning (`<div>` inside `<p>` in StageTile) is not from #43 or #45.
- **Cap:** lease 52p kept. Re-check c₃ if S3 averages above 1.0p. Retention backlog: check the `retention.done` `full` flag in early Dec.
- **M7 cost risk:** the daily caps (Lookup 25p, alerts 10p, applications 60p) could together pass the 800p manual share in a worst month; the monthly cap still holds. Each Retry or Regenerate buys 2 more `cvWrite` calls (3 with a revision once PR #42 ships).
- **Not confirmed on the live site:** that a Cmd+A paste reads all 25 cards; that the Lookup preview shows a "not read" count; that a job with no description shows no "Show description" button.
- **Draining a backlog:** add `funnel` (map) to `config/app` with `runBudgetPence: 120` and `s3MaxJobs: 60` as numbers; press Scan now (5 min apart) until "queued" is 0; delete `funnel`. A wrong type or key is silently ignored.
- 27 Workable watchlist rows are unchecked: `node scripts/detect-ats.ts --recheck`. The unused Cloud Storage bucket (not `…firebasestorage.app`) can be deleted.
- `docs/plans/firestore-lazy-plan.md` was copied to `main`'s working tree untracked on 20 Oct. Check that only the committed copy on `perf/firestore-lazy` remains.

## Working rules
- **Kit (Playbook 3.0):** Claude Code works through `/milestone`, `/build`, `/ship` and `/retro`. Models and effort are set per agent: Opus plans and reviews, Sonnet builds, no Haiku for building.
- Plans are saved to `docs/plans/` before building. Claude Code updates STATUS.md in every PR. Instructions to Beeb follow Playbook Part 5 (one step at a time).
- Show Beeb any `gh api`, force-push, tag, deploy or gcloud command, and wait for approval. Beeb runs every deploy, tag, IAM and console change.
- Only tag after the PR is merged (`git checkout main && git pull` first).
- UI changes: check locally with `npm run dev` before merging, then on the live site after the deploy.
- No automated browsing or scraping of LinkedIn (CLAUDE.md hard rule, ADR-004).
- The master CV lives in the claude.ai Project. Upload it in the app; never commit it. No personal data or account emails in this repo (it is public).
- Never paste API keys or the HMAC secret into chat or Claude Code.
- Follow the speed-up policy in Decisions. Never relax a budget, threshold, cap or test without Beeb's decision.
- **Release recipes:**
  - **Every new callable:** after its first deploy, run `gcloud functions add-invoker-policy-binding <name> --region=europe-west2 --member=allUsers --project=hireframe-f6b03`, then re-run the failed deploy job.
  - **Every new non-callable HTTPS function:** the RUNBOOK step 91 pattern, then the same invoker binding.
  - **Every new scheduled function:** bind `hireframe-fns` as invoker, re-run the failed deploy, then run `gcloud scheduler jobs list --location=europe-west2`. If the job is missing, follow the RUNBOOK Recovery entry.
  - **Every new event (Pub/Sub) function:** bind its trigger SA as invoker by hand (RUNBOOK K8).
  - **Every new function of any kind:** set a literal `maxInstances: 1` and a `timeoutSeconds` key in code, and add a row to the `EXPECTED` table in `functions/src/index.test.ts`. The source scan fails otherwise.
  - **Every deploy that changes functions or rules:** RUNBOOK step 77 first (only `hireframe-fns` as invoker on `scheduledscan`). See the RUNBOOK "Every release" checklist (PR #41).
  - **Every new Firestore query:** add it to the query specs. After the deploy, wait for any new index to say Enabled.
  - **Apps Script changes** are not deployed by CI: run `npm run build:apps-script`, then `npm exec -w apps-script clasp -- push`.
