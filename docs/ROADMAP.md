# Roadmap

## Wave 1 milestones (target: usable in ~1 week of evenings)
Each milestone = one PR, demoable, docs + CHANGELOG updated.

| # | Milestone | Done when |
|---|---|---|
| M0 | Repo + guardrails | Monorepo, strict TS, lint, Vitest, CI, gitleaks, Dependabot, branch protection, docs in place |
| M1 | Firebase foundation | Project on Blaze with budget alerts, Auth (Google, owner allowlist), rules + rules tests, App Check, emulators, empty dark shell deployed to Hosting |
| M2 | Profile brain | CV upload → facts; Profile screen (view/edit/add/archive); criteria seeded + Criteria screen |
| M3 | Sources | Greenhouse, Lever, Ashby, Reed, Adzuna, HN modules + company watchlist seed; ToS/robots checks for YC/Workable/Escape the City recorded as ADRs; normalise + dedupe with tests |
| M4 | Funnel | S0–S3, scheduled + manual runs, run logs; eval set labelled by user and ≥ 80% agreement. `llm.call()` with the monthly cap exists from M2 (ADR-016); M4 adds per-run caps, the 80% warning, batches and prompt caching, and decides on the refusal fallback. Also verifies PRD R3's "next run uses the changed criteria" and "Re-score", and records `criteriaVersion` on each job (`getCurrentCriteria`, ADR-019). Per ADR-009: caps in pence with USD→GBP rate, S3 per-run cap fits the monthly cap, verdict precedence, experience rule `> cap`, CI evals on recorded responses |
| M5 | Dashboard | Today, Jobs, Job detail, System screens; actions + 👍/👎 feedback; responsive; a11y ≥ 95 |
| M6 | Gmail bridge + Lookup | Apps Script ingest (HMAC), alert parsers (LinkedIn first), Lookup screen incl. LinkedIn ID matching |
| M7 | Digest + CV tailoring | Morning digest email (explicit in-progress/failed notice if the run isn't done, ADR-009); on-demand CV + cover note (.docx/.pdf) with factId validation |
| M8 | Hardening | Security checklist done, backups, retention job, load test a 1,000-job run, runbook complete, v1.0.0 tag |

**Usable at M6** — start relying on it daily from there.

## Wave 2 (weeks 2–3) — sharper decisions
Gmail auto-status (confirmations/rejections/interviews), follow-up reminders, company intel card (Companies House API, funding/headcount/news), UK sponsor licence flag (gov.uk register), ghost-job detector, ATS keyword match, lane-specific base CVs, CV version tracking, answer bank, dream-company alerts, push notifications (PWA), learning from feedback (score adjustments), AI assistant panel, full analytics.

## Wave 3 (November) — odds boosters
Referral path finder and recruiter/HM finder (public sources + one-click LinkedIn search links, no scraping), interview prep pack, mock interviews, hidden job market list, event finder, Indonesia fallback lane (separate tab, before December), skill-gap plan, weekly market report, targets & streaks, salary estimates.

## Wave 4 (when needed)
Offer & negotiation helper, autofill browser extension.

## Parking lot
Telegram bot, case-study page generator for fridgerweb.com. PR preview channels (need a Google sign-in/App Check story for preview domains, ADR-014). Playwright smoke test of sign-in against the emulators. Re-add `eslint-plugin-jsx-a11y` once it supports ESLint 10 (ADR-012). LLM-assisted fact merge as a second opinion on flagged changes (ADR-018). Side-by-side diff view for fact versions and criteria versions; restoring an old criteria version.

