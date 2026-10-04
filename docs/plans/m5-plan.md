# v0.4.1 funnel throughput, then M5 Dashboard — plan

Two PRs, both branched from `main` (never stacked):
1. **`fix/funnel-throughput` → tag `v0.4.1`**: the triage pricing fix (F0), back-pressure (F2), the cache-write worst case (F4), per-stage stop reasons (F5), the flake fix, the schedule Recovery entry. One session.
2. **`feat/m5-dashboard` → tag `v0.5.0`**: two sessions (data and services, then screens), branched after PR 1 merges.

Each session ends with a list of deviations from this plan.

## Context
M4 shipped the funnel: jobs now carry verdicts, scores, reasons, gaps and matched facts. The only place to see them is the Firestore console. M5 turns the data into the product (PRD R7):
- Today, Jobs and Job detail screens;
- job actions, plus 👍/👎 feedback so verdict agreement can be measured (PRD metric: ≥ 85%);
- a spend meter and error alerts on System;
- Adzuna attribution on listings (ADR-025).

First, v0.4.1 fixes what the first production run showed: S1 passed 422, S2 judged 30 and stopped, and S3 judged 5 of 8 at 14p of a 24p lease. v0.4.1 also fixes the System test flake and documents the missing-schedule recovery from the v0.4.0 deploy.

---

## Findings

### 1. Funnel throughput (confirmed by the step 1 data)
**What the run shows:**
- **Not the time box.** The whole run took 135 s; S2's deadline is 400 s.
- **No S2 errors.** `s2.in` 30 = passed 8 + skipped 22, with review 0, so all 30 calls succeeded and there's no sign of 429s.
- **S2 stopped on its own 40% share.** `s2.costPence` was 9.28p of the 9.6p share. The next reservation (about 0.6p) didn't fit.
- **Each triage call settled at about 0.30p instead of about 0.15p.**

**Root cause: dated model IDs are priced at the top rate.**
- `llm.call()` reserves at the requested model's price: `priceFor(model.id)` = `claude-haiku-4-5`, which is correct.
- It *settles* at the price of the model the API reports: `priceFor(response.model)` (`functions/src/llm/call.ts:150`, `transport.ts:102`).
- For Haiku the API reports the dated snapshot `claude-haiku-4-5-20251001`. That isn't a key in `PRICES_USD_PER_MTOK`, so `priceFor` falls back to `TOP_PRICE`, which is Sonnet 5.5's $2/$10, and logs `llm.unknown_model_price`.
- That's exactly your arithmetic: 1,476 in + 61 out at $2/$10 × 0.85 = 0.3028p.
- The fakes and tests return the alias (`fake:claude-haiku-4-5`, `claude-haiku-4-5`), so no test saw it.

**Prices checked against platform.claude.com/docs/en/about-claude/pricing today:**
- Haiku 4.5: $1 / $1.25 / $0.10 / $5 (input / 5-minute cache write / cache read / output). Matches the table.
- Sonnet 5.5: $2 / $2.50 / $0.20 / $10. Matches.
- **deepRead is priced correctly:** the API reports `claude-sonnet-5-5` (eval recordings show the undated ID), which is in the table. `s3.costPence` 5.05p over 5 calls is about 1.0p each, consistent with cache reads at $0.20.

**Why S3 then stopped at 14.3p (unchanged diagnosis):**
- S2 had taken 9.28p.
- S3 reserves about 5.5p worst case per call, against about 1.0p actual. With 2 in flight, a reservation is refused once used + 11p > 24p.
- The stage stops for good on that refusal (`run.ts:483`), leaving 9.7p unspent with 3 candidates still queued.

**Is `usage/{month}` overstated? Yes.**
- Every Haiku call is charged at twice its real cost: S2 triage since v0.4.0, and `addFact` since v0.2.0.
- That's in `spendPence`, `byPurpose`, each run's `costPence`, and the eval's reported cost.
- Reservations were always right, and the error is in the safe direction (overstated, never understated).

**Correct it? No. I recommend no hand correction:**
- The amount is small. This month's triage is about 4.6p too high (30 calls), plus about 0.1–0.2p per Add-fact note.
- The overstatement is fail-safe.
- `usage/{yyyy-mm}` gates spending: a document that fails its schema blocks all model calls (ADR-016). A hand edit there risks blocking the funnel to save pennies.
- Closed months don't matter, and October corrects itself going forward.
- CHANGELOG `0.4.1` and ADR-039 record the overstatement and how to compute it exactly if ever needed: `tokens['claude-haiku-4-5-20251001']` at the right rate, versus at the top rate.

**Fixes for v0.4.1 (the lease size is unchanged, so the monthly worst case of 46 × 24p plus the 25% manual share is unchanged):**
- **F0. Price dated snapshot IDs as their alias.**
  - `priceFor` strips a trailing `-YYYYMMDD` before the lookup, and only then falls back to `TOP_PRICE`.
  - The fallback log becomes `log.error` once per model per process, so a new ID can't hide.
  - Tests:
    - `claude-haiku-4-5-20251001` costs exactly the alias price;
    - a truly unknown ID still gets the top price;
    - every `MODELS[*].id`, bare and with a date suffix, resolves to a table entry;
    - the `call.test.ts` transport now returns a dated ID.
  - Effect: S2 calls settle at about 0.15p, so S2 fits about 2× more jobs in its share.
- **F2. Back-pressure instead of stopping** (S2 and S3).
  - The stage waits for in-flight calls to settle when the next call's expected worst case doesn't fit. The expected worst case is the largest one reserved so far this run for that stage.
  - It stops only when the call can't fit with nothing in flight, or at the deadline.
  - A refusal while calls are in flight waits for a settle and retries that job once.
  - `llm.call()`'s reserve-or-refuse check and the lease are unchanged.
- **F4. Fix the worst case for cached prompts:** input is reserved at max(input, 5-minute cache write) when `cacheSystem` is set. A cache write costs more than uncached input, so the old bound could be exceeded.
- **F5. Per-stage stop reasons:** `budget.stops: {s2?, s3?}`, shown on System.
- **Expected per run after F0 + F2 at 24p:**
  - S2: about 55–60 calls (stops at about 9.6p − 0.6p), against 30 now.
  - S3: about 8–9 deep reads if that many candidates exist (spend up to about 24p − 5.5p), against 5 now.
- **Dropped:**
  - F1 (drain during fetch) and its new-job reservation: the time box isn't the cause.
  - F3 (rate-limit pause): no evidence of 429s.

  If either shows up later, F5's per-stage stop reasons will name it (`deadline`, `model_errors`).
- **Parked (ROADMAP):** `deepRead.maxTokens` 2,500 at the next forced re-record (keep 4,000 if real outputs exceed about 1,250 tokens); Message Batches.

### 2. The missing schedule (from the v0.4.0 deploy logs)
- **Attempt 1** failed enabling the Scheduler API.
- **Attempt 2** created `scheduledScan`, then hit "Failed to set invoker". The CLI sets the invoker *before* it creates the Scheduler job (`createEndpoint` → `createV2Function` throws, so `setTrigger` never runs).
- **Attempt 3** logged "Skipped (No changes detected)".

**Future risk:** every bundle change updates `scheduledScan`, and the CLI rewrites the invoker unless the members are **exactly** `serviceAccount:hireframe-fns@…`. v0.4.1 is the first such deploy, so the check (step 3) comes before its tag.

### 3. The scan-once test flake
The scan resolves **outside `act`**, and the test then counts `countJobs` calls inside a 1 s `waitFor`. On a loaded runner the refetch effect lands late.

Fix:
- resolve inside `await act(async () => …)`;
- make `countJobs` return 57, then 59, and assert **"Jobs stored: 59"**;
- keep the call count as a secondary check.

Verify with 50 sequential runs of the file and 4 parallel full suites. This ships in v0.4.1 because the deploy job re-runs the suite.

### 4. Bundle today
The initial JS is **297.6 kB gzip** against a **310 kB** budget, in 7 files: firestore 138, react 90, zod 27, button-common 19, firebase 17, index 6.5.
- M5's screens load lazily.
- Target: initial JS ≤ 300 kB.
- `check-bundle` prints the per-file breakdown.

### 5. R7 "loads usable in < 2 s on 4G": the measure
- **Measure.** `hf:usable` is a `performance.measure` from navigation start to the first render of Today with tiles and Apply list filled from Firestore.
- **Conditions.** Chrome DevTools Fast 4G, CPU 4× slowdown, signed in.
- **Pass.** The median of 3 **repeat visits** is **≤ 2,000 ms**. The median of 3 cold visits is recorded (target ≤ 3,000 ms) but doesn't gate.
- **If it fails**, in order:
  1. start the Today queries and chunk during the owner check;
  2. Firestore persistent local cache;
  3. shrink the initial chunks.
  - Still failing after those: report the numbers and park it.
- **Lighthouse** Accessibility **≥ 95** on Today, Jobs, Job detail and System (mobile, Clear storage unticked).

---

## Decisions (ADRs)
- **v0.4.1:**
  - **ADR-039 Funnel throughput:**
    - the confirmed cause (dated-ID pricing) and F0, F2, F4, F5 (amends ADR-016's price lookup and ADR-032's stop-on-refusal);
    - the overstatement and why it isn't hand-corrected;
    - F1 and F3 considered and dropped on the step 1 evidence;
    - the parked levers.
  - **ADR-037 addendum:** invoker before schedule, skip-unchanged, exact invoker.
- **M5:**
  - **ADR-038 Dashboard data, job actions and feedback.**
    - Client writes on `jobs` are limited to `status` (`new|saved|applied|skipped`), `appliedAt` and `appliedVerdict` (set together with applied, to server time and to the job's verdict; cleared on leaving it), `feedback {agree, note? ≤ 280, verdict, expected?, at}` and `updatedAt`.
    - Events are create-only.
    - **Agreement** over 14 days: an explicit 👍/👎 counts against the verdict it judged. Without one, Mark applied on an Apply verdict counts as agree. Skips and no action don't count. The line shows the split. There's no implicit disagree (bias recorded).
    - The KPI definitions; the R7 measure; focus-scoped shortcuts (WCAG 2.1.4); 👎 → golden candidates parked.
  - **ADR-025 addendum:** Adzuna per-advert "Jobs by Adzuna" (116×23 px, "Jobs" links to adzuna.co.uk, the logo self-hosted); Reed shows a plain "via Reed" link, since no terms were found.

---

## PR 1 (one session): `fix/funnel-throughput` → v0.4.1
- `functions/src/llm/call.ts`: F0 `priceFor` normalisation (and its error log); F4 `cacheWrite` passed to `worstCasePence`.
- `packages/shared/src/usage.ts`: `worstCasePence(..., {cacheWrite})`.
- `functions/src/llm/lease.ts`: `waitForRoom`, `maxReserved`, `inFlight`, a settle notifier.
- `functions/src/funnel/run.ts`: the F2 gate and retry; `stops` per stage.
- `packages/shared/src/funnel.ts`: `RunBudgetSchema.stops?`.
- `web/src/features/system`: per-stage stop reasons; the flake fix.
- **Tests:**
  - `call.test.ts` (dated IDs, unknown IDs, every configured model);
  - `usage.test.ts` (cache-write worst case); `lease.test.ts`; `config.test.ts`;
  - **`run.test.ts` throughput scenario**: a **400-job S2 queue**, a transport that reports `claude-haiku-4-5-20251001` and `claude-sonnet-5-5` with eval-sized tokens, lease 24p, concurrency 4/2. It asserts:
    - S2 keeps going past 30 and stops only on its share (`stops.s2 === 'run_budget'`), at ≥ 55 calls;
    - each S2 call settles at the Haiku price;
    - S3 ≥ 8 when ≥ 8 candidates exist;
    - spend ≤ lease at every settle; no start after the deadlines.
- **Docs:**
  - ADR-039, the ADR-037 addendum;
  - RUNBOOK: the Recovery entry (below) and Part E step 68 binding `hireframe-fns` explicitly;
  - FUNNEL per-run limits; CHANGELOG `0.4.1` (including the overstatement).
- **Ends with:** `npm run check`, `test:rules`, `build`, the smoke bundle script, the 50× flake loop, and a deviations list.

## PR 2, Session 1: data and services
- **Shared:**
  - `jobs.ts` (`JobFeedbackSchema`; `appliedAt?`, `appliedVerdict?` and `feedback?` on `JobSchema`; `CLIENT_JOB_STATUSES`);
  - `events.ts`;
  - `metrics.ts` (`verdictAgreement`, `londonDayStart`/`WeekStart`, `todayKpis`);
  - `DEFAULT_MONTHLY_CAP_PENCE` moves to shared.
- **Rules:**
  - `validJobAction()` and create-only `events`, with `tests/rules/jobs.test.ts`;
  - six `jobs` indexes: `(verdict, status, judgedAt↓)`, `(verdict, judgedAt↓)`, `(status, judgedAt↓)`, `(status, appliedAt↓)`, `(review.stage, judgedAt↓)`, `(feedback.agree, feedback.at↓)`.
- **Web services:**
  - `jobs.ts`, `job-writes.ts` (pure builders, emulator-tested against the rules);
  - `dashboard.ts` (Today lists, counts, usage, agreement).
- **Dev seed:** about 12 judged jobs across verdicts, Adzuna and Reed jobs, an S1 skip, a review job, a queued job, usage, one feedback and one applied-on-Apply.
- **Docs:** ADR-038, the ADR-025 addendum, ARCHITECTURE data model, RUNBOOK Part F.
- `check-bundle` per-file report.
- **Ends with:** `check`, `test:rules`, and a deviations list.

## PR 2, Session 2: screens
- **Today:** tiles with the spend meter, three lists, attribution, `hf:usable`, all states.
- **Jobs:** filters, Load more, the agreement line.
- **JobDetail drawer/sheet:** verdict, reason, shortfall, requirements with cited facts, matched facts, gaps, talking points, skip rule, review/queued, flags, plain-text description, sources, attribution, actions with 👍/👎 dialog; Generate CV disabled until M7.
- `labels.ts`, `useListKeys.ts`.
- `AdzunaAttribution`.
- **System:** spend meter, alerts, agreement.
- Lazy routes.
- **Tests:** all fields, actions, injection-as-text, keyboard, states, routing.
- CHANGELOG `0.5.0`, ROADMAP (M5 done; parking lot: ⌘K palette, 👎 → anonymised golden candidates, `maxTokens` 2,500 at the next re-record, Batches, axe in unit tests).
- **Ends with:** `check`, `build` + `check:bundle` (≤ 300 kB), `test:rules`, the smoke bundle script, the PR, and a deviations list.

## PRD acceptance criteria (M5)
- **R7:** the screens, tiles, lists and actions; responsive; keyboard. **AC:** a11y ≥ 95; < 2 s per Finding 5.
- **R6 AC:** evidence and skip rule visible.
- **R11:** the meter and 80% warning. v0.4.1's F0 makes the meter accurate for Haiku.
- **R12:** error alerts.
- **Metrics:** agreement and applications/week.
- **ADR-025:** attribution.

## Risks
- **Another dated ID** (a future Sonnet snapshot) now resolves through F0's normalisation. A truly new model logs an error and is over-, not under-, charged.
- **The invoker must be exact** before every deploy that changes functions (steps 3 and 13).
- **Index build delay** after v0.5.0 (step 13).
- **Bundle creep.**
- **Feedback race with a re-score:** rejected by the rules, and the UI asks to retry.
- **The Adzuna logo** must be official (step 10).
- **Untrusted text:** plain text only.

---

## Manual steps (for you)

### After PR 1's session
**Step 1.** Run `npm run dev`, sign in as **Dev Owner**, **System → Scan now**. The run card shows separate stop reasons for S2 and S3.

**Step 2.** Run `npm run test:rules` (needs Java 21): all tests pass.

### Deploy `v0.4.1`
**Step 3. Check `scheduledScan` before tagging.** Open Cloud Shell (the **>_** icon in the Google Cloud console) and paste these one at a time:

```bash
gcloud config set project hireframe-f6b03
```
```bash
gcloud scheduler jobs describe firebase-schedule-scheduledScan-europe-west2 --location=europe-west2 --format='value(schedule,timeZone,httpTarget.oidcToken.serviceAccountEmail)'
```
```bash
gcloud run services get-iam-policy scheduledscan --region=europe-west2 --flatten='bindings[].members' --filter='bindings.role:roles/run.invoker' --format='value(bindings.members)'
```

- The second command must print `30 7,17 * * 1-5`, `Europe/London` and `hireframe-fns@hireframe-f6b03.iam.gserviceaccount.com`.
- The third must print **only** `serviceAccount:hireframe-fns@hireframe-f6b03.iam.gserviceaccount.com`.
- If either differs, follow the Recovery entry below first.

**Step 4.** Merge PR 1, push tag `v0.4.1`, then **Actions → Deploy → Review deployments → Approve**.

**Step 5.** On your phone: **System → Scan now**.
- The run shows S2 well past 30 (about 55–60 while the backlog lasts) and separate S2/S3 stop reasons.
- In Firestore, `runs/<id>.perStage.s2.costPence` divided by `s2.in` is about 0.15.

**Step 6.** Next weekday after 07:30: a "Scheduled" run shows the same.

### After PR 2, Session 1
**Step 7.** Run `npm run test:rules`: all tests pass.

**Step 8.** Optional: tell me if you want a different agreement window or target (default: 14 days, 85%).

### During or after PR 2, Session 2 (local)
**Step 9.** Run `npm run dev`. **Today** shows 4 tiles and three lists from the fake seed.

**Step 10. Adzuna logo.**
- a) Open https://www.adzuna.co.uk/press.html.
- b) Download the official logo (SVG if offered, else PNG).
- c) Save it as `web/public/attribution/adzuna-logo.svg` (or `.png`) and tell me.

**Step 11.** **Jobs** → click a job.
- a) Press 👎 with a note and "should have been: Near miss".
- b) Open an Apply job → **Mark applied**.
- c) **System**: agreement shows 2 rated and 2 applied (the seed already has one of each).
- d) Click into the list and press `j`, `k`, `a`.

**Step 12.** At phone width: bottom tabs show, and Job detail opens full screen.

### Deploy `v0.5.0`
**Step 13.** Repeat step 3. Merge PR 2, push tag `v0.5.0`, approve the deploy. Then **Firestore → Indexes**: wait until the six new `jobs` indexes say **Enabled**.

**Step 14.** On your phone: open **Today**, open a job, mark one applied. **Applied this week** goes up by one.

**Step 15. Speed and accessibility**, on your laptop in Chrome, signed in.
- a) **DevTools** (⌥⌘I) → **Network** → throttling **Fast 4G**. **Performance** → ⚙️ → CPU **4× slowdown**.
- b) With **Disable cache** unticked, reload Today 3 times. After each, run `performance.getEntriesByName('hf:usable')[0].duration` in the **Console** and note it. The median must be ≤ 2000.
- c) Tick **Disable cache** and repeat 3 times (recorded, not gating).
- d) **Lighthouse**: untick **Clear storage**, tick **Accessibility**, device **Mobile**, **Analyze**. Do this on Today, Jobs, a job's detail and System. Each must be ≥ 95.
- e) Paste all numbers in the chat.

### New RUNBOOK Recovery entry (drafted, ships in v0.4.1)
> **A new scheduled function has no schedule after its first deploy** (the deploy said "Failed to set invoker function <fn>", and a re-run says "Skipped (No changes detected)"). The Firebase CLI sets the function's invoker before it creates the Cloud Scheduler job. The deploy account can't set IAM, so the job is never created, and later deploys skip the unchanged function. In Cloud Shell:
> ```bash
> PROJECT_ID=hireframe-f6b03; REGION=europe-west2; FN=scheduledScan
> FNS=hireframe-fns@$PROJECT_ID.iam.gserviceaccount.com
> gcloud config set project $PROJECT_ID
> gcloud functions add-invoker-policy-binding $FN --region=$REGION --member=serviceAccount:$FNS
> URI=$(gcloud functions describe $FN --region=$REGION --gen2 --format='value(serviceConfig.uri)')
> gcloud scheduler jobs create http firebase-schedule-$FN-$REGION --location=$REGION --schedule='30 7,17 * * 1-5' --time-zone='Europe/London' --uri="$URI" --http-method=POST --oidc-service-account-email=$FNS --attempt-deadline=540s --max-retry-attempts=0
> gcloud scheduler jobs run firebase-schedule-$FN-$REGION --location=$REGION
> ```
> - Use exactly this job name, so later deploys update the job.
> - The schedule must match `SCHEDULE` in `functions/src/config.ts`.
> - The invoker must be **only** `hireframe-fns`. Any other member makes every later deploy that changes the function fail before it updates the schedule. Remove extras with `gcloud functions remove-invoker-policy-binding`.
> - Within 10 minutes, **System** shows a "Scheduled" run.

## Verification
- **v0.4.1:** `npm run check`, `test:rules`, `build`, the smoke bundle script, the 50× flake loop; steps 1–6.
- **v0.5.0:** the same plus `check:bundle`; steps 7–15.
