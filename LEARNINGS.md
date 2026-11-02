# Hireframe: learnings archive
_Append only. Moved verbatim from STATUS.md on 2026-11-02 (Playbook 3.0 · Kit 3.0.2). Nothing here is deleted; STATUS.md keeps the live state and points here._

## Lessons archived 2026-11-02 (older than 20 Oct, or made obsolete by the kit)
- [tech] The emulator does not enforce indexes, CORS or scheduler jobs, and `npm run dev` is not the production build. Check the live site after every deploy.
- [tech] **A new scheduled function may deploy with no Cloud Scheduler job** (generateCvs 12 Oct, purgeOldData 15 Oct). After the deploy, run `gcloud scheduler jobs list --location=europe-west2`. If the job is missing, use the RUNBOOK Recovery entry for that function.
- [tech] **Browser reads from Storage need bucket CORS.** Without it the SDK retries for minutes and the button spins.
- [tech] **App Check replay can come from a transport-level resend** of a POST (12 Oct, 49 s after a successful call). Not fixable in the client; the first delivery may have run. If it recurs, read the request logs for both deliveries.
- [process] If CI jobs time out or sit queued, check githubstatus.com. If `git pull`/`push` time out on a wifi network but GitHub loads in the browser, the network blocks git: use a phone hotspot or SSH over port 443.
- [tech] A new non-callable HTTPS function fails the deploy pre-flight (`cloudfunctions.functions.setIamPolicy`). Fix with the RUNBOOK step 91 pattern: save the role list, grant `roles/cloudfunctions.admin` to `github-deployer`, deploy, bind the invoker, remove the grant, diff the role list.
- [tech] `github-deployer` baseline roles (9 Oct): `cloudfunctions.developer`, `cloudscheduler.admin`, `datastore.indexAdmin`, `firebasehosting.admin`, `firebaserules.admin`, `firebase.viewer`, `serviceusage.serviceUsageConsumer`.
- [tech] A new callable (and a new scheduled function) fails its first deploy on the invoker policy. Run the binding command (Working rules), then re-run the failed job.
- [tech] **The first Pub/Sub (event) function needs a temporary pre-grant** before its deploy (firebase-tools `ensureServiceAgentRoles`): RUNBOOK K6, removed in K9. Event functions get no invoker from the CLI: bind the trigger SA by hand (K8).
- [tech] **After an invoker binding, Pub/Sub pushes get 403 for about 1 minute** (propagation). Wait 2 minutes before a test publish (K8/K12).
- [tech] A gcloud (not firebase) deploy of a firebase-functions v2 event function needs `FUNCTION_SIGNATURE_TYPE=cloudevent`. firebase-tools sets it.
- [tech] `gcloud … describe` commands reject `--filter`. Pipe the output to `grep`.
- [tech] **Re-running a deploy job rebuilds nothing:** unchanged function hashes are skipped. A proving deploy needs a bundle change.
- [tech] **`gcloud functions logs read` shows only the message, not structured fields.** Use the `gcloud logging read … jsonPayload.*` form in RUNBOOK K12.
- [tech] clasp: `rootDir` in `apps-script/.clasp.json` is `build`. The Script ID is in `apps-script/.clasp.json`. Script Properties belong to one project.
- [tech] A digest email that says `network_error` means `HIREFRAME_DIGEST_URL` is wrong. Paste it again from `gcloud functions describe getDigest`.
- [product] Title guards only see the words before a term, and titles are split on hyphens.
- [process] Keep the Opus self-review for every PR with a security or cost surface, and list the checks by name. For a large PR, review only the commits since the last reviewed one (`git diff <sha>...origin/<branch>`). One Opus Max review + one Opus High re-review of the fixes is enough (8A, 8B, 8C1 and 8C2 all found real fixes).
- [process] `npm run check` does not run `npm run format:check`; CI does. Use the full gate. Run the gate after the LAST commit. Capture exit codes with bash, not zsh.
- [tech] Do not put a tight wall-clock limit in a test; use a fake clock. CI runs about 4× slower than the laptop.
- [process] Put data in a prompt for Claude Code, not a placeholder. Save handoff notes between build sessions to `docs/plans/`. A handoff can't hold its own commit SHA; it records the head before itself.
- [process] **Plan mode does not save the plan or a review to the repo.** _(obsolete: the kit saves plans)_
  - Claude Code keeps it in `~/.claude/plans/`, with varying names (e.g. `pasted-content-id-…`).
  - Copy it from inside the Claude Code tab with `!`, and check the title. A second terminal tab may sit in another folder, and auto mode may deny the copy if Claude Code runs it:
    `! cp "$(ls -t ~/.claude/plans/*.md | head -1)" docs/plans/<name>.md && head -3 docs/plans/<name>.md`
  - Don't approve an Opus Max review's fix plan in that session: Escape, `/clear`, Sonnet, build.
- [process] Pastes from a narrow terminal arrive garbled or cut. Widen the terminal.
- [tech] A new Cloud Shell tab loses shell variables (`P`, `R`, `FN`). Set them again, or write the values in full.
- [tech] `hf:usable` must be measured with both throttles on (Fast 4G and 4× CPU), using **normal reloads (Cmd+R)**, never Cmd+Shift+R. `hfMarks()` is not a console global: use the RUNBOOK step 89 command. `hf:usable` is a measure, not a mark.
- [tech] Dev timings (`npm run dev`) are not comparable with the built site (unbundled modules).
- [process] The build prompt must say "put the list of differences in the PR body". `gh pr edit --body-file` avoids losing backticked words.
- [business] The £10 Firebase budget is an alert, not a cap. Blaze has no hard cap.
- [process] Do not tag or deploy late at night or just before a scheduled scan. Tag in the daytime, after the morning digest: weekdays 10:00–16:00, weekends 10:00–18:00.
- [process] A release that changes no functions or rules does not need step 77 (C1, C2).
- [tech] Dev data can hold an application stuck at Generating (there is no worker in the emulators). The wipe refuses until it is removed in the Emulator UI.
- [tech] A Markdown table cell with a shell pipe needs `\|`, or GitHub splits the row.
- [process] Never ask Beeb to close a terminal before he has copied its output.
- [process] Split big work into sessions: Opus plans → Sonnet builds in 2–3 sessions with handoffs → one Opus Max review → Sonnet fixes → Opus High re-review of the fixes → Sonnet fixes. 8C2 fitted in one afternoon this way.
- [process] **Building from the phone** (CV quality, 18 Oct):
  - On the laptop, run `caffeinate -i claude --remote-control "<name>"`, set `/model` in the terminal, then scan the QR code.
  - The session runs on the laptop (emulators, gate, local secrets), so the laptop stays plugged in with the lid open.
  - Start each build prompt with "end every final report with the whole report in one code block" so it copies in one tap.
  - Plan-mode reviews and `!` copies are easier at the laptop.
- [process] **Plan-mode files can vanish when Claude Code exits or updates.** Copy a review out of `~/.claude/plans/` with `!` before closing Claude Code. If it is lost, paste the copy from chat into the repo with `! pbpaste > docs/plans/<name>.md`. _(obsolete: the kit saves plans)_
- [process] **A LIVE eval that fails:** diagnose offline from the recordings (Sonnet, report only, free), batch every fix into one change, then do one LIVE run. The CV eval took 3 LIVE runs (about £1.05).
- [process] The full gate must run as a fixed loop (`for c in "npm run format:check" …; do bash -c "$c"; echo "$c exit=$?"; done`). A `name:command` split breaks on `format:check`, and a chain with `&&` can push a commit that failed formatting. _(obsolete: `node .claude/kit/gate.mjs` runs the gate)_
- [process] **Small web-only PRs** (CV preview, 19 Oct): one Opus Medium review was enough before the rebase. Do one Opus Medium re-review after the rebase instead of two reviews.
- [tech] A spike that checks browser support first saved a broken phone preview: the pdf.js default build needs 2025–26 browser APIs, so the legacy build is used.

## Working rule dropped 2026-11-02
- "In chat, still state Model · Effort · Mode for every manual piece of work." (the kit sets models per agent)

## Done entries archived 2026-11-02 (everything before 8C)
- **Setup:**
  - Repo `herbianalfa-cloud/hireframe`: public, ruleset `protect-main` (PR + checks `check`, `gitleaks`, `audit`, `rules`).
  - Firebase `hireframe-f6b03` (Blaze, £10 budget), region europe-west2.
  - Secrets: ANTHROPIC_API_KEY, REED_API_KEY, ADZUNA_APP_ID, ADZUNA_APP_KEY, INGEST_HMAC_SECRET.
  - Gmail labels `hireframe/alerts` and `hireframe/done` on the main Gmail account.
  - Alerts on LinkedIn (3), Wellfound, WaaS and WTTJ. LinkedIn alerts arrive on a second Gmail account and auto-forward to the main one.
  - Laptop: gcloud 589.0.0 (Homebrew), `default` configuration = the main account / `hireframe-f6b03`. Node through nvm: Node 22 default, Node 24 installed.
- **M0–M3** (PRs #1–#8, v0.1.0–v0.3.0):
  - Monorepo, CI, owner-only rules, App Check, keyless deploy on `v*` tags with `production` approval.
  - Profile brain (170 facts), Profile + Criteria screens, `llm.call()` with a spend cap.
  - Sources (Greenhouse, Lever, Ashby, Workable, Reed, Adzuna, HN), dedupe, watchlist of 204 companies / 94 boards.
- **M4 Funnel** (PRs #10–#11, v0.4.0–v0.4.1):
  - S1 rules → S2 Haiku triage → S3 Sonnet deep read, with scores recomputed in code.
  - Per-run budget lease = floor(cap × 0.75 / 46). S2 is limited to 40%; S3 can use the rest.
  - `scheduledScan` 07:30/17:30 Mon–Fri London, and `rescore`.
  - Eval: 40 fake postings, live 85.0% (gate 80%). Replay runs in `npm run check`. A prompt, schema or model change needs `LIVE=1 npm run eval`.
  - Known eval gaps: g06, g11, g19, weak wildcard recall.
- **M5 Dashboard** (PRs #12–#16, v0.5.0–v0.5.3): Today, Jobs, Job detail (`?job=`), System; actions, 👍/👎, keys `j k a s o`. Lighthouse a11y 100 (on v0.5.x).
- **Funnel intake** PR A (PR #17, v0.5.4, ADR-043) and PR B (PR #23, v0.6.1, ADR-045):
  - Expiry sweep. "S2 skip reasons" and "Recent S1 skips by rule" on System. Eight sales title rows live (C4 only).
  - Cap: `config/app.monthlyCapPence` = 3200, lease 52p, `s3MaxJobs` 32.
  - Unit costs: S2 about 0.15p, S3 about 0.9–1.0p.
  - Expected spend: £13–14 a month for scanning, about £22–30 with everything; £32 worst case.
- **Sort and filter** (PR #18, v0.5.5, ADR-044).
- **M6** (PRs #19, #24, v0.6.0–v0.6.2, ADR-046 to ADR-049):
  - Gmail bridge: Apps Script every 30 min, HMAC. LinkedIn is parsed in code, others through Haiku. 10p/day.
  - Lookup: paste links, or a LinkedIn results page with Cmd+A then Cmd+C. 25p/day. "Waiting for a description". The ATS hydrator makes up to 12 board reads a run.
  - The HTTP client refuses LinkedIn, Indeed, Wellfound and Glassdoor on every path and redirect hop.
- **Speed marks** (v0.6.3). **Billing guards plan** (PR #26, docs only): `docs/plans/m8-billing-guards.md`, plus the CLAUDE.md hard rule "No self-triggering code".
- **M7 done (12 Oct).** Plan `docs/plans/m7-plan.md`; handoffs `docs/plans/m7c-handoff.md`, `docs/plans/m7d-handoff.md`.
  - 7A summary bar (PR #27, v0.7.0, ADR-051).
  - 7B digest (PR #28, v0.7.1, ADR-052): `getDigest`, Apps Script `digestMorning` ~07:50, `digestFallback` ~08:20, `digestNow`.
  - 7C CV engine (PR #29, v0.7.2, ADR-053, ADR-054): `validateCv`, renderer (PDF + DOCX), `fitOnePage`.
  - 7D pipeline (PR #30, v0.7.3, ADR-055):
    - `application` callable: owner only, App Check consumed, 120 s, 1 instance. Its only model call is `answerFact`. 60p/day cap.
    - `generateCvs` worker every 10 min, 07:00–23:50 London: 540 s, 1 instance, retryCount 0, at most 2 `cvWrite` calls per attempt cycle, attempt counted before the call.
    - Pipeline screen (Chosen, Needs your input, Generating, Ready to send, Applied), Profile CV header, Start application, Applied mirror, Pipeline badge and "Things to do", digest Pipeline line.
    - Answer facts are kept only when their evidence verifies. The functions bundle is split into `index.js` + `chunks/`.
  - Live checks (12 Oct): one real application went Needs your input → Generating → Ready, with four files. The CV was one page, in the right reading order, with no false claim. Apply/Undo mirror works. The digest Pipeline section arrived on 13 Oct.
  - v0.7.4 (PR #31, 12 Oct):
    - Bucket CORS (`storage.cors.json`, RUNBOOK step 96). Downloads limited to 30 s.
    - Every owner callable goes through `web/src/services/callable.ts`: fresh limited-use token, no retry, one request per double click.
    - App Check replay wording: "This request may already have gone through. Check the page before you try again."
    - Owner check before the replay check.
- **I5 digest timing confirmed:** 07:56 on 12 and 13 Oct (full digest).
- **M8 plan (13 Oct):** `docs/plans/m8-plan.md`. Three PRs: 8A run health v0.8.0, 8B data lifecycle v0.9.0, 8C billing/IAM v1.0.0. Decisions are recorded in the plan; ADR-059/060 reserved for 8C.
- **8A done** (PR #32, v0.8.0, 14 Oct; ADR-056, ADR-050, ADR-013 addendum):
  - A 404 board is "gone", not a failure. Broken boards are skipped and re-probed at 7 d − 1 h.
  - A host-wide 404 (≥ 3 boards) is `host_not_found`: the source is failing and the run is Partial.
  - "Job boards that no longer exist" (watched only). "Partial because" line on runs. Deterministic errorCode. Today prefetch.
  - `npm run audit` gate with `audit-allowlist.json`.
  - Two Opus reviews, all findings fixed.
  - Live: C1/C2 correct, the 17:30 run on 14 Oct Succeeded, Fresha listed as gone.
- **8A2 done** (PR #33, v0.8.1, 14 Oct; ADR-061, plan `docs/plans/m8a2-plan.md`):
  - Today renders directly once its chunk is loaded (no 300 ms Suspense hold). Firebase starts before the first render. The built HTML preloads `/__/firebase/init.json`. Preconnects. `hf:prefetch:data` mark.
  - **R7 amended:** pass = median `hf:usable` of 5 reloads of Today, on Beeb's phone, on mobile data, no throttling, ≤ 2,000 ms (RUNBOOK step 97). The step 89 lab number is recorded only.
  - Lab v0.8.1 median 1,102 ms with normal reloads (v0.8.0: 2,212 ms with Cmd+Shift+R).
  - Lighthouse a11y on Pipeline 100. The 360 px phone check passed.
- **8B released** (PR #37, v0.9.0, 15 Oct; ADR-057, ADR-058, ADR-032 load-test addendum). Plan `docs/plans/m8b-plan.md`; handoffs `m8b-handoff-1..3.md`; reviews `m8b-review.md`, `m8b-review-2.md`.
  - `deleteAllData` callable (System → Danger zone):
    - Owner only, App Check consumed, typed DELETE, bounded passes. The client repeats; it returns `done` only on a clean pass.
    - The `wipe` lock holder blocks scans, re-score, ingest, Lookup and all 7 application actions.
    - It keeps config, criteria, usage, locks, nonces, source quota/pauses, and the profile unless that box is ticked.
  - `purgeOldData`, scheduled 03:30 London: skip descriptions > 60 days, only status new/skipped with no application. Cursor `(judgedAt, id)` in `locks/retention`. New index `jobs (verdict ASC, judgedAt ASC)`.
  - Managed Firestore backups every Sunday, kept 8 weeks (replaces `weeklyBackup`). Storage soft delete 7 days. RUNBOOK Part J (steps 98–103) + Recovery entries.
  - Load test `node scripts/load-test.ts` (emulator only): a 1,000-job run took 318.7 s. At peak the 52p lease stops S3 at 31 calls. Owner kept 52p (54p breaks the 75% scanning share).
  - Live (15 Oct):
    - C1/C2, C15/C16 and C20c before the tag; C10/C11 bindings.
    - C13b: purgeOldData's scheduler job created by hand.
    - C3: three jobs. C14: both functions correct. Index Enabled. purgeOldData run once.
    - Wipe preview counts right (8,078 jobs, 204 companies).

## Next / Parked sections archived in full (as of 2026-11-02; STATUS.md now links here)
### Next §4 CV quality (PR #42; merge after v1.0.0). Built 17–18 Oct.
  - **Docs:** plan `docs/plans/cv-quality-plan.md` (+ Addendum); handoffs `docs/plans/cv-quality-handoff-1.md`, `-2a`, `-2b`, `-3a`, `-3a-fix`, `-3b`. ADR-062 (layout v2), ADR-063 (writing rules + score; amends ADR-053 to 3 calls), ADR-064 (CV eval). Re-check these ADR numbers after the #41 rebase.
  - **What it does:**
    - Fit-and-fill one-page layout: size ladder 11/10.5/10, spacing spread, entries newest first (in code).
    - Formal monochrome Arial/Helvetica; DOCX styles black.
    - Code lint: dashes scrubbed, contrast pattern, buzzword stack, inflated claim, cliché.
    - Code score `rubric-v1`, gate 8; a hard finding caps the score at 7.5.
    - One `cvRevise` round, only when a finding is fixable. At most 3 model calls per owner move, each counted first.
    - Removal-only clamps (count limits, unsupported skills).
    - The retry hint carries the issue code + path (`lastIssueAt`).
    - "Quality x/10 · Luck y/10" on the Ready card.
  - **CV eval:** `npm run eval -- --suite cv` (replay in `npm run check`). 8 fake cases on `CV_EVAL_FACTS`, report-only `cvJudge`. Run 3: 7/7 full-profile ≥ 8, mean 9.77 (baseline), fill 93–99%, LIVE run about 28p (200p cap).
  - **Measured cost:** a write costs about 2.5–3.1p and a revision about 3.0p. About £1.35 a month at 43 CVs (£2.60 if all revise). Worst case per owner move 26.8p (2 per day under the 60p cap).
  - **Review and fixes (18–19 Oct):**
    - Opus Max review: 1 High (a missing revision recording passed the gate), 6 Medium, 8 Low, 7 Nits.
    - Fix A (no LIVE): H1; M1 (classification-only achievement words; the degree-token rule only with 2+ degree facts); M2; rubric-v2 (note criterion, tailoring 1.0); the baseline stores the rubric + prompt version.
    - Fix B (one LIVE run, 23.8p): `<draft_cv>` named as data; a cover note opener rule; lint misses and false positives; the section rule counted in the layout; FILL_RESERVE 10 pt; thin-profile revision skipped as not_fixable. Eval mean 9.66, judge note 6.6 (was 5.9). LIVE total about £1.29 across 4 runs.
  - **Re-review and Fix C (19 Oct):**
    - The Opus High re-review found 1 High (a "2:2" achievement let a CV print "2:1"), 3 Medium, 6 Low, 7 Nits.
    - Fix C (no LIVE): a phrase-based classification check (a class lends only its own synonyms; one-word classes need a degree word; an achievement naming a degree must match). The baseline compares by rubric, with `--accept-lower` for a lower mean. ADR-063/064 addenda. Lint fixes.
    - No third review (PLAYBOOK).
  - **RUNBOOK I7 passed** (19 Oct, Beeb).
  - **Remaining, in order:**
    1. Rebase on `main` after PR #41 merges. Paste the force-with-lease command to chat first. Re-check ADR numbers 062–064.
    2. Merge after v1.0.0 and deploy. Then read the first real CVs and say if they are still bad.

### Next §4b CV preview (PR #43; ADR-065; merge after v1.0.0 and #42).
  - **Docs:** plan `docs/plans/cv-preview-plan.md` (+ Addendum: pdf.js legacy build, our stated floor Chrome 125+ / Safari 18+, any failure shows Download PDF). Review `docs/plans/cv-preview-review.md` (Opus Medium: 0 High, 4 Medium, 8 Low, 8 Nits), all fixed, gate green.
  - **What it does:** renders the stored PDF with pdfjs-dist 6.4.299.
    - The version is pinned. eval is turned off by version; `useWasm: false`. Dependabot ignores it. Bump steps are in ADR-065.
    - Lazy chunk 487.6 kB; worker 1,321 kB (named cap). Fonts are served same-origin (a CV loads 2 Liberation Sans files).
    - Initial JS unchanged at 295 kB gzip.
    - No function, rule, CORS or model call.
  - **Remaining, in order:**
    1. After #42 merges, rebase on `main`: take main's `package-lock.json`, then `npm install`. Re-check the ADR number.
    2. One Opus Medium re-review of bcb758f..head plus the rebase.
    3. v2-PDF fidelity check, Lighthouse a11y on Pipeline + dialog snapshot ≥ 95, real-phone check (RUNBOOK 89, I7).
    4. Merge, then its own Hosting-only release after #42's (no step 77; Scan-now proof).

### Next §4c firebase 13 + Node 24 toolchain (PR #44; HELD).
  - **Plan:** `docs/plans/deps-firebase-13-plan.md` (+ Addendum 20 Oct).
    - firebase 13.0.0 and rules-unit-testing 6.0.0 go together (each needs the other).
    - Node 24.15+ toolchain (engine-strict). Functions stay `nodejs22`: esbuild node22, `@types/node` 22, CI Node 22 bundle smoke. ADR-008 addendum.
    - Hash proof: the functions bundle is identical to main (21 files).
  - **Gate:** green except `check:bundle` (initial 306.0 > 300 kB). The cause is the firestore BSON types, not avoidable; a re2js override would save only ~2 kB.
  - #36 and #38 were closed with "@dependabot ignore this major version".
  - The plan's Addendum item 3 ("ships with #43") is out of date. Fix it on the branch when it rebases.
  - **Resume after #45 merges:**
    1. Rebase onto main: take main's lockfile, `npm install` on Node 24, and `npm dedupe` if there are two `@firebase/app`.
    2. Run the gate. Expect initial JS about 165 kB and the Firestore chunk about 141 kB.
    3. Release together with #45.
  - Building on this branch needs `nvm use 24` + `npm ci`.

### Next §4d Firestore out of initial JS (PR #45; ADR-066; draft until K28).
  1. Beeb decides on the lazy-screens fix (Pending).
  2. After #43 merges, rebase onto main. Move the Firestore check-bundle tests into #43's `scripts/check-bundle.test.ts`, and keep both rule sets. Show the force-with-lease command first.
  3. One Opus Medium re-review after the rebase.
  4. Release with #44 (Hosting only):
     - Before the deploy, record a Lighthouse Mobile Performance run and one cold `hf:usable` load.
     - After the deploy: step 89 (warm and cold) and step 97 (phone median ≤ 2,000 ms).
     - If `hf:firestore` comes after `hf:auth`, apply the one-line boot fallback. If the cold load is worse, add the prefetch-link fallback.

### Parked ideas (full list)
- CV preview in the app before download (now PR #43).
- Evidence documents (reports, portfolio, internship report) parsed into cited facts (Opus plans for cost and privacy).
- The system asks for evidence or detail on a CV item.
- Personal eval from an owner export.
- **Selling Hireframe to an organisation** (Beeb's plan, 8 Oct). Not started.
  - A private repo on GitHub Free loses the ruleset, environments and secret scanning, so use GitHub Pro.
  - History and forks stay public.
  - Multi-user needs per-user caps and the buyer's billing.
- **CV LIVE batch 2** (about 30p): L-new-3 (note visible to the revision loop), L-new-4 (a recorded revision case; the gate needs one revised case), N-new-3 (own sentence for `<draft_cv>`).
- **CV quality follow-ups:**
  - Cover notes are often under 180 words (only 1 of 7 scores full on the note criterion).
  - Use the judge as a gate after two agreeing LIVE runs.
  - Thin-profile filler bullets.
  - The c01 4.7p write.
  - Tighten the 7D gap questions (must-haves only, max 3).
- **From 7D and v0.7.4:**
  - An archived fact overwrites an active one in `planNoteFacts`.
  - Withdraw `{deleteFiles}` races a start (and deletes a restarted upload).
  - The rules email regex is looser than `z.email()`.
  - The `a` shortcut flickers on a generating job.
  - The badge listener does not recover after an error.
  - "Started" is not announced.
  - The tab-bar test checks a class only.
  - A job can gain an application between read and batch.
  - App Check transport resend.
  - The callable coalesces a second click.
  - The PipelinePage download-limit test checks wording only.
- **From 8A2:** deferring the reCAPTCHA load (F), slimmer Today list docs (G), a persistent cache (H; privacy finding in ADR-061), the Suspense reveal hold on other lazy screens. Firestore out of initial JS (E) is now PR #45.
- **From 8C2:** the App Engine default account's Editor; a custom role narrowing `roles/browser` for the guard; a build account once firebase-tools supports one.
- Older parked items: see `docs/ROADMAP.md`.
