# PRD — Hireframe (Wave 1)

## Problem
Job hunting costs hours a day of searching, opening, and reading postings that turn out unviable (wrong seniority, experience gaps, clearance, sponsorship, wrong domain). Effort is spent before fit is known.

## Goal
Spend effort only on jobs worth it. The system finds jobs, decides fit cheaply in stages, and only spends heavy effort (CV tailoring) on request.

## User
One user: UK graduate targeting junior product and technical customer-facing B2B SaaS roles, London-first, open to anywhere in the UK. Personal details (visa, dates, deadline) live in the Firebase profile, never in this repo.

## Success metrics (tracked from day one)
| Metric | Target | Why |
|---|---|---|
| Daily review time | ≤ 20 min | Core promise |
| Verdict agreement (user agrees with Apply/Skip) | ≥ 85% after 2 weeks of tuning | Trust in verdicts |
| Missed-good-job rate (user finds a fit job the system skipped or never saw) | < 10% | Coverage |
| Applications / week | 10, all Apply-verdict | Quality-first volume |
| Response rate (any human reply) | Track; baseline first | Outcome |
| Cost per scanned job | Track; monthly cap enforced | Sustainability |
| Scan reliability | ≥ 95% of scheduled runs succeed | Ops |

These double as CV/case-study numbers. Store raw events so any metric can be recomputed.

## Wave 1 scope
In: profile from CV, editable criteria, scanners (public ATS boards, UK job APIs, HN, Gmail alerts), dedupe, staged funnel with verdicts, dashboard, link lookup, email digest, cost meter + cap, on-demand CV tailoring, agree/disagree feedback, run logs.
Out (later waves): see `ROADMAP.md`.

## Requirements and acceptance criteria

### R1 Auth and access
- Google sign-in; only the allowlisted UID can read/write anything.
- AC: any other account signs in and sees nothing; rules tests prove all collections deny non-owner.

### R2 Profile brain
- Upload master CV (.docx/.pdf). System extracts atomic facts: `skill | experience | achievement | metric | education | project | constraint | preference`, each with evidence text, dates, tags, and lane relevance.
- User can view, edit, add, archive facts. "Add fact" accepts free text ("finished Olist SQL project, live dashboard at …") and structures it.
- Re-upload merges: new facts added, changed facts flagged for review, never silent overwrites.
- AC: master CV produces ≥ 60 facts; every fact shows its source; edits are versioned.

### R3 Criteria
- One editable criteria document: target lanes + titles, excluded titles/keywords, seniority/experience cap, locations + remote policy, company size/stage preferences, sectors to boost/penalise, freshness window, wildcard interests.
- Editable in UI; versioned; each job records which criteria version judged it.
- AC: change criteria → next run uses it; "Re-score" button re-runs verdicts on the last 14 days of jobs.

### R4 Scanning
- Twice daily on weekdays (07:30 and 17:30 Europe/London), plus a "Scan now" button.
- Sources per `ARCHITECTURE.md`. Each source is a module with its own health status.
- AC: a run logs per-source counts (fetched / new / duplicate / errors); one source failing never fails the run.

### R5 Dedupe
- Same job from multiple sources appears once, with all source links attached.
- AC: seeded duplicate fixtures (LinkedIn alert + Greenhouse listing of the same role) collapse to one job.

### R6 Funnel and verdicts
- Staged per `FUNNEL.md`. Output per job: verdict (`apply | near_miss | wildcard | skip`), fit score 0–10, luck score 0–10, one-line reason, matched facts, gaps (typed: tool / domain / seniority / hard-blocker), stage it stopped at.
- AC: eval set agreement ≥ 80% at launch; every verdict shows evidence; skipped jobs show the rule or stage that skipped them.

### R7 Dashboard
- Screens: Today, Jobs, Job detail, Lookup, Profile, Criteria, System. Dark default, light toggle, responsive (phone + laptop).
- Today: KPI tiles (scanned today, Apply, applied this week vs target 10, spend this month vs cap), then Apply / Near miss / Wildcard lists.
- Job actions: Open posting, Mark applied, Skip, 👍/👎 on verdict (with optional reason), Generate CV.
- AC: Lighthouse accessibility ≥ 95; all actions keyboard-accessible; loads usable in < 2 s on 4G.

### R8 Lookup
- Paste any job URL (incl. LinkedIn). Returns: seen or not, verdict, stage, when.
- If unseen: try to fetch (public sources only); if not fetchable (e.g. LinkedIn), ask user to paste the description, then run the funnel.
- AC: LinkedIn `/jobs/view/{id}` URLs match jobs ingested from LinkedIn alert emails by job ID.

### R9 Digest
- Email after each morning run: Apply (with luck score + reason), Near misses (+ what fell short), Wildcards, run health, spend.
- AC: sent only if the run succeeded or with an explicit failure notice; never silently absent.

### R10 CV tailoring (on demand)
- For a chosen job: one-page tailored CV + short cover note, built only from profile facts, ATS-safe .docx + PDF, stored with version and linked to the job.
- AC: validator rejects any bullet without a `factId`; output fits one page; user can regenerate with notes.

### R11 Cost control
- Monthly spend cap (default £15) and per-run cap. Live meter on dashboard.
- At 80%: warning in digest. At 100%: deep stages pause; cheap stages continue; user can raise cap.
- AC: simulated overspend stops LLM calls before exceeding the cap.

### R12 Observability
- Run log: timings, counts per stage, errors, cost. Source health panel. Error alerts in digest.
- AC: any failed run is visible on the System screen within one minute of finishing.

## Non-goals
Multi-user, auto-apply, LinkedIn scraping, mobile native app, recruiter CRM (Wave 3).

