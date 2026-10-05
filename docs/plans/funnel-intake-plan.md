# Funnel intake: plan

> **On approval:** copy this file to `docs/plans/funnel-intake-plan.md` on a new branch `feat/funnel-intake` from `main`, commit it (`docs:`), push the branch, and stop. No code gets written in this session; the build happens in a later session.

## Context

The goal is that no good job waits in a queue. Three things stop that today:

- **S1 lets through too much.** In one budget-limited run, S2 judged 58 jobs that S1 passed and skipped 43 of them (74%). Each of those skips costs about 0.15p and a slot in S2's 40% share.
- **Stale jobs never leave the queue.** `isExpired` only runs on jobs a stage actually reads. S2 reads the newest 300 by `sortAt`, and S3 reads the top 50 by triage score. Anything below that line stays `next: s2|s3` forever: it inflates the queue counts and is never judged. The backlog is 738+.
- **The lease isn't sized to the intake.** It's sized to the cap (24p = floor(1500 × 0.75 / 46), ADR-032), so on a busy day a run leaves good jobs queued.

The parts below are in your order. Shipping needs **two releases**, because part 1 has to measure prod before any rule is chosen:

| Release | Contains |
|---|---|
| PR A | 1a (skip-reasons panel), 2 (expiry sweep), query specs, the sizing method for 3 |
| *between them* | You deploy, read the counts and run figures, and approve rules and the cap |
| PR B | 1b (the S1 rules the counts justify), and 3's cap change if you approve it |

---

## 1. Tighten S1 using the real S2 skip reasons

### 1a. Getting the distribution from prod, as aggregate counts only (PR A)

There are no local admin credentials (ADR-011). The owner can already read `jobs` and `jobs/*/description` (`firestore.rules:350`). So the counting happens in your signed-in browser, and the page shows only numbers.

**New panel on System: "S2 skip reasons"** (lazy-loaded, so the initial bundle stays inside its budget).

- `web/src/services/funnel-diagnostics.ts` reads three spec-built queries (see "Queries"):
  1. **S2 skips:** `skip.stage == 's2'`, `judgedAt >= now − 30d`, ordered by `judgedAt desc`, limit 500. Code then keeps only the model's skips: those with `triage` and no `skip.ruleId`, which leaves out `freshness` expiries.
  2. **Good jobs:** `verdict in [apply, near_miss, wildcard]`, `judgedAt >= now − 30d`, limit 500.
  3. **Waiting for S3:** `next == 's3'`, ordered by `sortAt desc`, limit 500. S2 passed these.

  It also loads descriptions for all three sets in batches of 100.
- A new pure module, `packages/shared/src/s2-diagnostics.ts`, does the counting. It's unit-tested with fake jobs.
  - `skipReasonCounts(jobs)` counts by `lane`, by `seniority`, by `lane × seniority`, and by **blocker category**. Each blocker string is sorted in code into one of: `experience`, `clearance`, `licence`, `right_to_work`, `location`, `language`, `other`, using the same patterns S1 uses where they exist. The free text itself is never shown.
  - `candidateRuleHits(candidates, sets, criteria, workRights)` runs each candidate rule through the real `applyHardRules`, with criteria plus that one change. For each rule it returns `{ s2Skipped, good, queuedS3 }`: how many jobs the rule *would* have skipped in each set.
- **Set sizes come first.** The panel shows how many jobs are in each set (S2 skips, good jobs, waiting for S3) and the date range each covers, and the copied JSON includes them. A `good == 0` over a handful of S3 verdicts proves little, so the size is always shown next to the rule hits. ADR-044 records the sizes.
- **What the page shows:** count tables only. No titles, companies, notes or text. A **"Copy counts"** button copies the JSON, made of rule IDs, enum values, category names and integers, so you can paste it into chat safely. A test asserts that the copied JSON holds no string from any fake job's title, company, note or blockers.

**Your steps after PR A deploys:** open System, go to "S2 skip reasons", press "Copy counts" and paste the result. Also paste the run figures from 3a below.

### 1b. Candidate rules (chosen in PR B, from the counts)

**Adoption bar:** a rule ships only if `good == 0` and `queuedS3 == 0`, and `s2Skipped ≥ 2`. The principle that unknown titles are never skipped at S1 still holds: every rule below targets a *known* non-fit term, not "fits no lane".

| ID | Rule | Where it lives | Wildcard / lane guard |
|---|---|---|---|
| C1 | Seniority markers in the title: `Sr`, `Snr`, `Mid`, `Mid Level`, `Experienced`, `Staff`, `II`, `III` | `excluded_titles`, with IDs added to `SENIORITY_TITLE_IDS` | Seniority beats lanes, the same as `senior` |
| C2 | Plain `Product Manager` (the `manager` rule currently lets "Product" prefix it through) | `excluded_titles` `product-manager`, unless prefixed by Associate, Junior, Graduate or Trainee | APM, Junior PM and Graduate PM are lane titles and win |
| C3 | Engineering titles: `Software Engineer`, `Data Engineer`, `DevOps`, `Data Scientist`, `Developer` | `excluded_titles` | `Developer` unless prefixed by Unity or Game. "Prompt Engineer" isn't matched. Solutions engineers are lane titles |
| C4 | Sales titles: `Sales Executive`, `Sales Representative`, `Sales Development`, `Sales Associate`, `Account Executive`, `Business Development`, `SDR`, `BDR` | `excluded_titles` | Plain `Sales` isn't a term. A guard can only look at the words *before* a term, so a bare `Sales` rule would also exclude "Sales Engineer". Sales Engineer, Pre-Sales and Presales are the Solutions lane under another name, and none of them contains any C4 term. ("Sales Manager" is already caught by the `manager` rule.) |
| C5 | Language blocker ("fluent German required" and similar) | a new known blocker label `language` in `s1.ts` | – |
| C6 | Ambiguous experience ask at `cap + 2` or more (4+ years by default) | a new optional criteria key `experience_ambiguous_skip_years` | – |

C1–C4 only change criteria data, which is the seed plus your prod criteria. C5–C6 change code.

**Rolling it out in prod:** you edit criteria in the app, which writes `criteria/vN+1`, and then press Re-score. S1 re-runs over the last 14 days, and because no prompt changed, no model is called (ADR-037).

- **The Criteria screen can already express the guards.** Each excluded title row has a "Title term" and an "Allowed when preceded by" list (`CriteriaForm.tsx`), which saves as `unless_prefixed_by` (`model.ts` `toContent`). No UI work is needed.
- **IDs come from the term.** A new row's ID is `slugify(term)` when it's saved. C1 matches seniority rules by ID, so the IDs in `SENIORITY_TITLE_IDS` must be exactly what the terms slugify to: `sr`, `snr`, `mid`, `mid-level`, `experienced`, `staff`, `ii`, `iii`.
- **Order:** deploy PR B first, then add the C1 rows in the app, typed exactly as listed. A term that clashes with an existing ID gets `-2` and would lose its seniority behaviour. A web test asserts that `slugify` turns each C1 term into its listed ID.

**Spot-checking the first week (PR B):**
- **New panel section, "Recent S1 skips by rule".** It lists up to 20 jobs per adopted rule ID from the last 7 days, each with its title and company, and opens the job sheet. It shows on screen only and isn't included in "Copy counts".
- **Query:** `skip.ruleId == <id>`, ordered by `judgedAt desc`. That needs a **new index (`skip.ruleId` ASC, `judgedAt` DESC)**, which gets a spec and an index test.
- **Routine:** for the first 7 days after rollout, check each new rule's list once a day. If a rule skipped a job it shouldn't have, delete or narrow that term in Criteria and press Re-score. That's free, and it brings the job back to S2.

**Files (PR B)**
- `packages/shared/src/criteria-seed.ts`: the adopted terms.
- `packages/shared/src/titles.ts`: new IDs in `SENIORITY_TITLE_IDS` (C1).
- `packages/shared/src/s1.ts`: the `language` blocker (C5) and the ambiguous-ask skip (C6), only if they're adopted.
- `packages/shared/src/criteria.ts`: the optional key for C6.
- `docs/FUNNEL.md` (S1 section, seed YAML).

**Tests (PR B)**
- `titles.test.ts`: table rows for each new rule, covering hit, lane win and wildcard survival ("Unity Developer", "Prompt Engineer", "Junior Product Manager", "Senior Product Analyst"). These rows feed the eval's S1 title table, which must stay at 100%.
  - **C4 rows that must pass S1:** "Sales Engineer", "Pre-Sales Consultant", "Pre Sales Solutions Consultant", "Presales Engineer", "Solutions Consultant".
  - **C4 rows that must be excluded:** "Sales Development Representative", "Account Executive", "Business Development Executive".
- `web/src/features/criteria/model.test.ts`: each C1 term slugifies to its `SENIORITY_TITLE_IDS` entry.
- `s1.test.ts`: C5 and C6 rows, including "2+ years preferred" and "4+ years nice to have".

---

## 2. Expire queued jobs older than 14 days (PR A)

"Older than 14 days" means the existing freshness rule: `sortAt` (the posting date, else first seen) older than `criteria.freshness_days`, which is 14. There's one setting, and it's the same test `isExpired` already applies.

- **Store:** `FunnelStore.staleQueued(stage, before, limit)` runs `next == stage`, `sortAt < before`, ordered by `sortAt desc`, with a limit. It's served by the existing `(next, sortAt desc)` index for **both** stages, so no new index is needed.
- **Run (`functions/src/funnel/run.ts`):** a new sweep step runs after S1 and before the lease, for `s2` and then `s3`.
  - The cutoff is `now − freshness_days`.
  - It pages up to `FUNNEL.expireMaxJobs` (2,000, in `config.ts`), re-checks each job with `isExpired`, and writes `expiredPatch(stage)`.
  - It's free and needs no lease, so it runs even when the month's cap is reached or no profile exists.
  - It counts into the existing `s2.expired` and `s3.expired`, so the run schema and the System page need no change.
  - The existing per-job check when a job leaves a queue stays as a backstop.
- **One-off:** the first run after deploy expires whatever part of the 738+ is past 14 days. Whatever is left (no more than 14 days of intake) is the backlog handled in 3c.

**Files:** `functions/src/funnel/run.ts`, `store.ts`, `testing.ts` (the fake store), `functions/src/config.ts`, `docs/FUNNEL.md` (the Freshness bullet and the per-run limits paragraph).

**Tests:**
- `run.test.ts`: stale jobs beyond the S2 read limit are expired. Stale S3 jobs with a low triage score are expired. A job exactly at the cutoff is kept. The sweep runs when the cap is reached. Counts are right. No model call is made for an expired job.
- `store.test.ts`: the query's shape.
- `tests/emulator/`: one integration case where a stale queued job ends as `skip` with rule `freshness`.

**Risk:** a queued job with no `sortAt` doesn't appear in an `orderBy('sortAt')` query. Today's `queued()` has the same blind spot, so such jobs were never judged either. `s1PassPatch` and `requeuePatch` always set `sortAt`. The panel shows one extra number, "queued without sortAt", per stage. It comes from two server-side counts: `count(next == stage)` minus `count(next == stage orderBy sortAt)`. Both use existing indexes. If either number is above 0, PR B adds a one-off fix.

---

## 3. Size the per-run budget to clear each day's intake (cap unchanged until you approve)

### 3a. Inputs to read from System, Runs (aggregate numbers only)

`scheduledScan` only starts today (5 Oct). So:
- **Provisional:** use the **first 6 scheduled runs**, which must include a Monday 07:30 run, because it carries the weekend's postings.
- **Re-check at 10 runs:** recompute, and if L moves, bring a revised cap for approval.

For each run, read: `s0.new`, `s1.passed`, `s2.in`, `s2.passed`, `s3.in`, `s3.costPence`, `s2.costPence`, `budget.stops`.

From those:
- **P**: S1 passed per weekday, both runs summed. Size on the **largest** day in the sample. With so few days, a percentile means little. At 10 runs, keep using the largest day unless one day is clearly an outlier.
- **f**: the bigger run's share of the day (1/2 if the runs are even).
- **q**: S2 pass rate = Σ`s2.passed` / Σ`s2.in` (≈ 15/58 = 0.26 so far).
- **t**: the share of S1 passes the adopted rules remove = Σ`s2Skipped` over adopted rules ÷ (number of S2 skips + number passed) in the panel's set.

### 3b. Arithmetic

Unit costs come from ADR-032 and ADR-039, at FX 0.85:
- **S2 actual** c₂ = 0.151p (1,476 in + 61 out at $1/$5 = $0.001781 × 0.85).
- **S2 worst case** w₂ ≈ 0.55p (1,476 in + 1,000 max_tokens out = $0.006476 × 0.85).
- **S3 actual** c₃ = 1.5p. This is conservative: the first prod run saw about 1.0p.
- **S3 worst case** w₃ ≈ 5.5p.

The peak run must clear:

- **S2 calls:** n₂ = f · P · (1 − t)
- **S3 calls:** n₃ = f · P · q. The adopted rules only remove S2 skips, so S3's volume doesn't change.

Back-pressure (ADR-039) admits a stage's last call only if its worst case fits with nothing in flight, so each stage needs headroom of (w − c) on top of its spend:

- **S2 share:** 0.4 · L ≥ n₂ · c₂ + (w₂ − c₂), so L ≥ (0.151 · n₂ + 0.40) / 0.4
- **Whole lease:** L ≥ 0.151 · n₂ + 1.5 · n₃ + 4.0
- L is the larger of the two, rounded up to a whole penny.

**S3 has no 60% cap; it can spend whatever S2 leaves.** I checked this in code. `createRunLease` (`functions/src/llm/lease.ts`) allows a reservation when total used + in flight + the new reservation ≤ `grantedPence`. Only S2 has an extra test (≤ `grantedPence × s2Share`). S3's only limit is the whole lease, so no separate 0.6 · L constraint applies, and the table stands.

Count and time ceilings:
- n₂ ≤ 300.
- n₃ ≤ `s3MaxJobs`, which is 25. The override goes up to 60 in `config/app.funnel`.
- S3 also has to finish inside the 450 s deadline. Check `stops.s3 != 'deadline'` in the sample. If it's breached, raise `s3MaxJobs` or move the deadline, not the budget.

**Cap:** the lease defaults to floor(cap × 0.75 / 46), so

> **monthlyCapPence = ceil(46 · L / 0.75)**, rounded up to the next 100. Then check that floor(cap × 0.75 / 46) ≥ L.

Expected *actual* spend is about 46 × the mean run's (n₂ · c₂ + n₃ · c₃) plus manual work. It's far below the cap, because the cap bounds the worst case (runs × lease).

**Worked table** (f = 0.6, q = 0.26, t = 0.3; fill in P from 3a):

| P (S1 passed per day) | n₂ | n₃ | L (pence) | monthlyCapPence |
|---|---|---|---|---|
| 60 | 26 | 10 | 23 (today's 24 already covers it) | 1500 (no change) |
| 100 | 42 | 16 | 35 | 2200 |
| 150 | 63 | 24 | 50 | 3100 |
| 200 | 84 | 32 → 25 cap* | 55* | 3400* |

\* n₃ is above `s3MaxJobs`. At that volume you'd raise `s3MaxJobs` to 32, which gives L = 65 and a cap of 4000.

Arithmetic for the P = 100 row:
- n₂ = 0.6 × 100 × 0.7 = 42
- n₃ = 0.6 × 100 × 0.26 = 15.6, which rounds up to 16
- L = 42 × 0.151 + 16 × 1.5 + 4.0 = 6.34 + 24 + 4 = 34.3, so 35
- The S2 check is (6.34 + 0.40) / 0.4 = 16.9, which is less than 35, so it passes
- The cap is 46 × 35 / 0.75 = 2,146.7, rounded up to **2200**
- Check: floor(2200 × 0.75 / 46) = floor(35.87) = 35, which meets L ✓

**PR A ships only the method:** an ADR-032 amendment draft plus `FUNNEL.md` text. **No change** to `config/app.monthlyCapPence`, `defaultRunBudgetPence` or any override. Once you've pasted the run figures, I compute the exact number and you approve it. The cap is then a console edit of `config/app.monthlyCapPence`, and the amendment records the approved figure in PR B.

### 3c. The backlog left after expiry (one-off, sized separately)

B is the queued count after the first sweep (System shows it). The cost to drain it is about B × c₂ + B × q × c₃. For example, B = 300 gives 45p + 78 × 1.5p, about **£1.62**.

The way to drain it is a few manual Scan now runs with a temporary `config/app.funnel.runBudgetPence`, paid from the 25% manual share. You approve this separately, and the override is removed afterwards.

---

## Queries (ADR-040 specs)

- **Move** `QuerySpec` (the type only) and `indexServes` to `packages/shared/src/query-spec.ts`. They're pure, and `sideEffects: false` still holds (ADR-042). `web/src/services/query-spec.ts` keeps `specConstraints` and re-exports the rest. **Add the `<` op**, treated as a range in the same way as `>=`.
- **Functions specs, new queries only:** a new `functions/src/funnel/queries.ts` exports `staleQueuedSpec(stage, before)`, and `store.ts` builds only `staleQueued` from it. The existing `store.ts` queries stay as they are. Bringing them under specs goes to the ROADMAP parking lot.
- **Web specs (new):** `diagnostics:s2Skips` needs a **new composite index (`skip.stage` ASC, `judgedAt` DESC)** in `firestore.indexes.json`. `diagnostics:good` (`verdict in …` + `judgedAt`) is served by the existing `(verdict, judgedAt desc)` index. `diagnostics:queuedS3` is served by `(next, sortAt desc)`.
- **PR B adds** `diagnostics:s1SkipsByRule` with its new `(skip.ruleId, judgedAt desc)` index.
- **Tests:** `functions/src/funnel/queries.test.ts` checks the new functions specs against `firestore.indexes.json`. `web/src/services/indexes.test.ts` adds the diagnostics specs. `packages/shared/src/query-spec.test.ts` covers `<` and the range-ordering rule.

## Eval impact: no `LIVE=1` re-record needed

- The S2 system prompt holds lanes, wildcards, the facts summary and work rights. S3's adds company preferences. Neither prompt contains `excluded_titles`, keywords, blockers, freshness or budget. So no recording key changes, and replay doesn't go stale. `cli.ts` fails only on *missing* recordings; unused ones are fine.
- Replay runs S1 live with the seed criteria (`EVAL_CRITERIA`). So in PR B, some skip cases will stop at S1 instead of S2, which lowers the eval's cost. If a new rule catches a golden case labelled apply, near miss or wildcard, agreement drops and the gate fails. That rule is then dropped, not tuned around.
- PR B adds S1 **title-table rows** (code only), not golden cases. A new golden case *would* need `LIVE=1` (about 40p).
- Parts 2 and 3 don't touch the eval.

## Risks

- **A false skip at S1 is silent and free,** so nobody sees the good job. Mitigations: the adoption bar (zero good hits, zero S3-queue hits), wildcard guards, title-table tests and the eval gate. The PR B ADR also records each rule's counts.
- **The panel reads up to about 1,500 job docs plus descriptions** per open. That's owner-only and on demand, a few pence of Firestore reads at most. It loads only when you press "Load".
- **The new index has to build** before the panel works in prod. The deploy creates it, and the panel shows "index building" on `failed-precondition`.
- **The expiry sweep's first run writes up to about 738 updates**, in batches of 400 within the existing write path. Its time cost is a few seconds, before the lease.
- **The cap size depends on q and c₃ holding.** If a tightened S1 changes the S2 pass rate, or S3 averages above 1.5p, re-run 3b on the next 10 runs.
- **Sizing on the largest day in a small sample** still leaves rare spikes queued. Those wait one run; they don't expire, because the sweep only expires jobs past 14 days.

## ADRs

- **ADR-043 Funnel intake: a queue-expiry sweep and S2 skip diagnostics** (PR A). Covers the sweep before the lease, the 30-day panel, counts-only output, the copy format and the read cost.
- **ADR-040 amendment** (PR A): specs and `indexServes` move to shared, the `<` op, and the new functions queries are covered. The existing functions queries are parked.
- **ADR-032 amendment** (PR A drafts it, PR B finalises it): the intake-based sizing formula, and the approved `monthlyCapPence` with its inputs (aggregate figures only).
- **ADR-044 S1 tightening from S2 skip reasons** (PR B): each adopted and rejected candidate with its `{s2Skipped, good, queuedS3}` counts, **plus each set's size and date range**, the new `language` blocker and C6 key if adopted, and the first-week spot-check routine.

## Docs and changelog

- `docs/FUNNEL.md`: the S1 rules, Freshness, per-run limits and sizing.
- `docs/ROADMAP.md` parking lot: rejected candidates worth re-testing, and "build the existing `store.ts` funnel queries through specs and check them against the index file".
- `CHANGELOG.md`: both PRs.
- `CLAUDE.md`: no new command, unless the panel gets a script.

## Verification

- **Both PRs:** `npm run check` (lint, typecheck, unit tests, PII scan, eval replay), `npm run test:rules` (emulator integration including the expiry case), `npm run build`, `npm run check:bundle` (the panel is lazy), and `node scripts/smoke-functions-bundle.ts`.
- **Local:** `npm run dev`. Seed fake queued jobs older than 14 days, beyond the read limit, and run Scan now. They end as `skip` / `freshness`, and System shows the `expired` counts. Open "S2 skip reasons" and check that the tables fill from the twelve fake judged jobs and the copied JSON holds only counts.
- **Prod, after PR A:** the first scheduled run shows `s2.expired`/`s3.expired` around the stale share of 738, and queue counts drop. Then you paste the panel counts and the figures from the first 6 runs (including a Monday morning), and I return the exact rule set and cap for approval before PR B.
