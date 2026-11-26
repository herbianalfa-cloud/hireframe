# Hireframe: status & handoff

_Updated: 2026-11-25 · Playbook 3.0 · Kit 3.0.2_

The repo copy is the master. Spec: `docs/PROJECT.md`. Plans: `docs/plans/`. Older detail (Done before v0.9.1, older Lessons and Decisions, full Next and Parked text): `LEARNINGS.md`.

## Decisions
- **Billing guard arming (v1.0.1): option A** (17 Oct). The prod guard gets `billing.projectManager` + `roles/browser`, the tested path. Recorded in the ADR-059 addendum (PR #41).
- **Release plan after v0.9.1** (24 Nov, Beeb): `main` is frozen from K20 to K28 (only #41 merges). Tags: v1.0.0 hardening (#41), v1.0.1 arming, v1.1.0 #42, v1.2.0 #43, v1.2.1 #45 + #44. Grouping: #43 alone; #45 + #44 together (one Hosting-only release). **#42 merges only after the v1.0.1 tag (arming).** Dependabot waits until after K28; #59 gets its own plan.
- **PR queue** (24 Nov): #42, #43, #45 (with the lazy-screens fix) and #44 (rebased on `main`) have CI green and are unmerged. Merge order: #41 at K20; then, only after the v1.0.1 tag, #42, #43, #45, #44 in that order (tags above).
- **v0.9.1 closeout** (19–24 Nov, Beeb): 8b closed on the 3 Nov Ready CV (`generateCvs` unchanged since 3 Nov 13:07Z); C7 accepted with one third-party reCAPTCHA console error; K13 deviations accepted (no separate £5 budget, scope "All projects (1)", done outside the window); K9's two Google service-agent lines accepted.
- **App Engine default account's Editor:** stays in the ROADMAP parking lot (never spiked). v1.0.1 precondition: "removed, or accepted with a reason". The deployer's `serviceAccountUser` on it is the real path to re-enabling Compute (C53 N/A, 24 Nov; GitHub OIDC plus approval needed).
- **Speed-up policy:**
  1. Work while gates run. A gate blocks the release, not the building.
  2. **Scan-now proof** for minor releases: right after the deploy, Scan now → System shows Succeeded → `digestNow` → `gcloud scheduler jobs list --location=europe-west2`.
  3. **Full clean-weekday gate only** for releases that change scanning, scheduling, cost or IAM in a live way. v1.0.1 (arming) needs one full clean weekday on v1.0.0 first.
  4. Batch releases. Wave 2 ships in 2–3 releases.
  5. Scope filter for Waves 2–3: build only features that get interviews unless Beeb asks for more.

## Done
One line per milestone (older entries in `LEARNINGS.md`).
- **v0.9.1 released** (tag 3 Nov; `billingGuard` created by the Deploy re-run on 5 Nov, approved 12:35, done 12:42 London; evidence `docs/plans/v0-9-1-evidence.md`): K6 grants and the K6b custom role added, then removed (K9, 5 Nov; diff = only Google's `pubsub.serviceAgent` and `eventarc.serviceAgent` lines; deployer back to 7 roles; no C38b; no push grant live). K8, K10, K11 and the K12 dry run passed (`below`, `would_disable`; billing stayed on). K13 on 11 Nov. **C47 passed** 19 Nov (a budget message about every 22 min since 11 Nov, none invalid). Post-K13: 12/12 scans and 6 digests. **Scan-now proof passed** 19 Nov (scan, `digestNow`, three scheduler jobs). 8b closed. Step 8 (24 Nov): Today loads; one third-party reCAPTCHA console error accepted as C7.
- **Phase 3 K14–K18 done** (24 Nov, per Beeb, in another session): no IAM change; K17's disables were all refused by cloudapis dependencies and carry to the v1.0.1 review; C53 N/A. Its evidence goes in the K20 commit.
- **Kit and deps** (late Oct): kit 3.0.2 (#53) with `npm audit fix` (zod via clasp allowlisted to 2027-01-31); Dependabot #46 and #49 merged.
- **PR #45 built** (20–24 Oct, draft, ADR-066): initial JS 295.6 → 164.7 kB gzip; Firestore chunk lazy at 131.0 kB. Opus Medium review fixed; L7 bug (Try again cannot recover a failed chunk) fixed with a click-only full reload.

## Lessons (20 Oct onwards; older ones in `LEARNINGS.md`)
- [process] The restore drill is safe on a weekday, because it never touches `(default)`. RUNBOOK step 103 says "weekend": fix the wording in the K20 commit.
- [tech] **A Part K deploy can fail midway** (3 Nov): Hosting, rules and the other functions were already released when the `billingGuard` create failed, and the tag exists. Plan for a partial release; K9 and K11 still apply.
- [process] **macOS grep has no `\s`:** use `[[:space:]]` in the RUNBOOK K6 read (fix in the K20 commit).
- [process] **RUNBOOK Part K runs fine in a laptop `bash` tab**: type `bash`, then paste the Part K setup block.
- [tech] **A new service account can return NOT_FOUND on `describe` for up to a minute** after `create`. Wait 60 s; never re-run the create.
- [process] Splitting Part K across days is safe up to K5. Never stop between K6 and K9: the K6 pre-grant stays on until K9.
- [process] A re-run of a failed deploy job asks for the `production` approval again.
- [tech] The first event function makes Google add `eventarc.serviceAgent` and `pubsub.serviceAgent` to the project policy: expect both lines in the next K9 diff.
- [tech] A re-run deploy skips unchanged functions (`generateCvs` kept its 3 Nov `updateTime`). Compare `updateTime` with a Ready time to prove which code rendered a CV.
- [product] On `main`, an `unsupported_text` retry is blind (codes only); #42 adds the failing path and removal clamps. A live CV can block on the word check (ADR-054), so a release check cannot assume a fresh Ready.
- [process] Read a log by per-day counts (`uniq -c`), not from a pasted summary, and write start and Ready times down during a live check.

## In progress
v0.9.1 is released and verified (see Done); this closeout is PR group G2 (`docs/v0-9-1-closeout-g2`).
**M8 8C:** K1–K18 done. **Next: Phase 4 (K19–K28) = v1.0.0.** All five gates are done (phone test, restore drill, clean weekday, Scan-now proof on v0.9.1, C47). Weekday 10:00–16:00 London; nothing Generating; never on a Sunday. K20 merges PR #41.
- K order: K19 record gates → **K20 evidence commit, merge #41** → K21 snapshot → K22 buckets → K23 Path F grants → **K24 compute-account Editor removal (not the App Engine account), then straight to K25 tag v1.0.0** → K26 `diff -u` → K27 live checks → K28 24-hour checks, `gcloud auth revoke`, follow-up docs PR (C50, K26, K27, K28, C41).
- **K20 checklist:** carry the v0.9.1 lessons into the RUNBOOK edits (the K6b custom role create/bind/unbind/delete, macOS `[[:space:]]`, step 103 "weekend" wording, K9 expects both Google service-agent lines); the ADR-059 line (live push grant: none, C38b not used); K14–K18 evidence; raise `timeout-minutes` in the Deploy workflow if needed.

**Open PRs:** **#41** (8C2, `feat/m8c2-hardening`): ready, merge only at K20. **#42** CV quality, **#43** CV preview, **#45** Firestore out of initial JS (with the lazy-screens fix), **#44** firebase 13 + Node 24: all rebased on `main`, CI green, unmerged (merge order in Decisions).

## Next
1. **Use it daily.** Morning: digest → Today → Pipeline → apply → 👍/👎. Daily LinkedIn sweep in Lookup. Read every CV before you send it.
2. **M8 releases:** K19–K28 (v1.0.0) → follow-up docs PR.
3. **v1.0.1: arm the guard (option A).** Approved separately. Needs one clean weekday on v1.0.0; prod guard granted `roles/browser` + `billing.projectManager`; `BILLING_GUARD_MODE=armed`; topic policy shows only the budget publisher; App Engine Editor removed or accepted with a reason; a project-level publisher read; the K17 disables reviewed; the planner has looked at native spend caps vs `billingGuard`.
4. **Queued PRs, after the v1.0.1 tag** (details in `LEARNINGS.md`, "Next §4–4d"): #42 (v1.1.0) → #43 (v1.2.0, Lighthouse a11y ≥ 95 + real-phone check) → #45 + #44 together (v1.2.1, Hosting-only; Lighthouse and cold `hf:usable` before, steps 89 and 97 after). Each rebases on the one before and gets one Opus Medium re-review.
5. **After Wave 1:** audit token spend across the funnel (Opus plans it). Plan a video walkthrough (Opus). Then Waves 2–3 with the scope filter, in batched releases.
6. **Housekeeping:** fill the TBDs in `docs/PROJECT.md` (kill criteria, learning goal, time-boxes, pre-mortem, C10 identity, preview deploys, Playwright live smoke test).
7. **Trim STATUS to one page after K28** (the Release recipes move out once #41's RUNBOOK edits have landed).

## Parked ideas
Full list in `LEARNINGS.md` ("Parked ideas (full list)") and `docs/ROADMAP.md`.
- Evidence documents parsed into cited facts; the system asks for evidence on a CV item; personal eval from an owner export.
- **Selling Hireframe to an organisation** (8 Oct). Not started. Needs GitHub Pro, per-user caps, the buyer's billing, a C10 identity, commercial tier.
- CV LIVE batch 2 (about 30p) and CV quality follow-ups (short cover notes, judge as a gate, filler bullets, tighter 7D gap questions).
- 7D / v0.7.4 nits (archived fact vs active fact, withdraw race, `a` shortcut flicker, badge listener recovery, and others).
- From 8A2: reCAPTCHA load (F), slimmer Today docs (G), persistent cache (H). From 8C2: App Engine Editor; a custom role narrowing `roles/browser`; a build account.
- **Native spend caps vs `billingGuard`** (11 Nov, Beeb): for the planner before v1.0.1 (arming the guard). Also re-check `hireframe-kill`'s scope ("All projects (1)" = `hireframe-f6b03` today) if another project ever joins this billing account. Not started.
- [tech] **#44 hand-pinned `@firebase/app` 0.16.3 in `package-lock.json`** (1fbf396). A regenerated lockfile hoists 0.16.7 and nests 0.16.3, which fails `scripts/toolchain.test.ts`, and `npm dedupe` doesn't fix it. Remove the pin when firebase 13.x resolves to one copy: regenerate the lockfile on Node 24, and if the test passes without the edit, the pin is gone.
- [tech] **Log alert on `serviceusage.services.enable` for `compute.googleapis.com`**, so you'd hear if someone enables it. Not built. Related: the App Engine default account's Editor is the real path (see Decisions).
- **reCAPTCHA Enterprise `pat` 401 in the console** (24 Nov): a Google script request, not our code; accepted for C7 on v0.9.1. Re-check on the next console review.

## Pending / known
- **R7 median `hf:usable`:** recorded date-only (20 Oct, passed). Take fresh numbers (5 reloads, median) at the #45 + #44 release (steps 89 and 97).
- **One application is blocked in Chosen since 19 Nov** (word check, twice). A Retry costs up to about 18p and may block again until #42 ships.
- **Audit allowlist:** zod via `@google/clasp` until 2027-01-31. Review it by then.
- **Dependabot alert #4 (moderate): leave it open.** `sprintf-js` via `mammoth`, no patch; owner-only upload.
- **Cap:** lease 52p kept. Re-check c₃ if S3 averages above 1.0p. Retention backlog: check the `retention.done` `full` flag in early Dec.
- **M7 cost risk:** the daily caps (Lookup 25p, alerts 10p, applications 60p) could together pass the 800p manual share in a worst month; the monthly cap still holds. Each Retry or Regenerate buys 2 more `cvWrite` calls (3 with a revision once PR #42 ships).

## Working rules
- **Kit (Playbook 3.0):** Claude Code works through `/milestone`, `/build`, `/ship` and `/retro`. Models and effort are set per agent: Opus plans and reviews, Sonnet builds, no Haiku for building.
- Plans are saved to `docs/plans/` before building. Claude Code updates STATUS.md in every PR. Instructions to Beeb follow Playbook Part 5 (one step at a time).
- Show Beeb any `gh api`, force-push, tag, deploy or gcloud command, and wait for approval. Beeb runs every deploy, tag, IAM and console change.
- Only tag after the PR is merged (`git checkout main && git pull` first).
- **Release windows are in London time** (weekday 10:00–16:00 London, as in the plan), wherever Beeb is working. Beeb converts to local time; Claude states every deadline in London time and reads the app's times as London unless the screen says otherwise.
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
