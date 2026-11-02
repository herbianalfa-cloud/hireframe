# Hireframe: project spec (Kickoff Sheet)
_Playbook 3.0 · Kit 3.0.2 · Filled 2026-11-02 from the Wave 1 docs (PRD, ARCHITECTURE, FUNNEL, SECURITY, DESIGN, ROADMAP, DECISIONS, RUNBOOK) and STATUS.md. Those docs stay the detailed source; this sheet is the summary and points to them._

## 3.1 Identity
- **Name and one-liner:** Hireframe. A personal job-search engine. It scans UK and startup job sources twice each weekday and runs each job through a staged AI funnel (rules → Haiku → Sonnet). It returns a verdict for each job: Apply, Near miss, Wildcard or Skip. It generates CVs only on request.
- **Type:** web/PWA + AI/LLM + automation (public job sources, plus job-alert emails through an Apps Script bridge).
- **Stakes and tier:** portfolio (Core + this sheet). One user, private data, public code, and real money spent on APIs. Production rules already in place: P2 (rollback by tag), P4 (zod at every boundary), P6, P7, P10. Moves to the commercial tier if Hireframe is sold to an organisation (see STATUS Parked ideas).
- **Playbook version and add-ons:** Playbook 3.0, kit 3.0.2. Add-ons: AI/LLM features · Automation/scraping/external sources · Web/PWA.
- **Part 2 (Indonesia market defaults):** N/A because the market is the UK job market, there is one user, and the region is europe-west2. An Indonesia lane is a Wave 3 idea.
- **Owner account / entity:** Beeb's personal GitHub, Google/Firebase and Anthropic accounts. A C10 project identity is TBD; it is needed before any sale or handover.
- **Learning goal:** TBD.
- **Portfolio angle:** the PRD success metrics double as CV and case-study numbers. Capture eval agreement, cost per scanned job, R7 load times, before/after numbers (e.g. initial JS 295.6 → 164.7 kB in PR #45) and the key ADRs. A case-study page for the portfolio site is parked.

## 3.2 Why
- **Problem, and for whom:** job hunting costs hours a day of reading postings that turn out unviable: wrong seniority, experience gaps, clearance, sponsorship or domain. The effort is spent before fit is known. For one UK graduate targeting junior product and technical customer-facing B2B SaaS roles, London first, open to anywhere in the UK.
- **Why now / why me:** an active graduate job search in 2026/27, and the builder knows the stack from Fridger (ADR-001).
- **Non-goals:** multi-user; auto-apply; sending messages on the user's behalf; scraping or logged-in automation of LinkedIn, Indeed, Wellfound or Glassdoor; a native mobile app; a recruiter CRM (Wave 3).
- **Success metrics** (PRD). Target dates: TBD.

| Metric | Target |
|---|---|
| Daily review time | ≤ 20 min |
| Verdict agreement | ≥ 85% after 2 weeks of tuning |
| Missed-good-job rate | < 10% |
| Applications / week | 10, all Apply-verdict |
| Response rate | Tracked; baseline first |
| Cost per scanned job | Tracked; monthly cap enforced |
| Scan reliability | ≥ 95% of scheduled runs succeed |

- **Kill or pivot criteria:** TBD (C4 check at each milestone boundary).

## 3.3 Scope
- **MVP:** Wave 1 was usable at M6: scan → funnel → dashboard → Gmail alerts + Lookup. Reached Oct 2026.
- **Milestones.** Wave 1 was time-boxed at "about 1 week of evenings". Per-milestone time-boxes: TBD (C4).

| # | Milestone | Exit criteria | State |
|---|---|---|---|
| M0 | Repo + guardrails | Monorepo, strict TS, lint, Vitest, CI, gitleaks, Dependabot, branch protection, docs | Done |
| M1 | Firebase foundation | Blaze + budget alerts, owner-only Auth, rules + tests, App Check, emulators, shell on Hosting | Done |
| M2 | Profile brain | CV upload → facts; Profile + Criteria screens | Done |
| M3 | Sources | ATS + Reed + Adzuna + HN modules, watchlist, dedupe tests, ToS ADRs | Done |
| M4 | Funnel | S0–S3, `llm.call()` with cap, zod, scheduled + manual runs, eval ≥ 80% | Done (85.0%) |
| M5 | Dashboard | Today, Jobs, Job detail, System; actions + 👍/👎; a11y ≥ 95 | Done |
| M6 | Gmail bridge + Lookup | Apps Script ingest (HMAC), alert parsers, Lookup incl. LinkedIn ID match | Done |
| M7 | Digest + CV tailoring | Morning digest; on-demand CV + cover note with factId validation | Done |
| M8 | Hardening | Security checklist, backups, retention, 1,000-job load test, runbook, v1.0.0 | 8A, 8A2, 8B done; 8C in progress |

  Waves 2–4 are in `docs/ROADMAP.md`. They are built with the scope filter: only features that get interviews.
- **Quality bars, with how each is measured:**

| Bar | Measurement |
|---|---|
| R7 load speed | Median `hf:usable` of 5 normal reloads of Today, on Beeb's phone, on mobile data, no throttling: ≤ 2,000 ms (RUNBOOK step 97). The lab number (step 89: Fast 4G + 4× CPU, Cmd+R) is recorded only. |
| Accessibility | Lighthouse a11y ≥ 95, WCAG 2.1 AA, 44×44 px targets |
| Funnel quality | `npm run eval`: 40-posting golden set, agreement ≥ 80%. Replay runs in `npm run check`. A prompt, schema or model change needs `LIVE=1`. |
| CV quality | `npm run eval -- --suite cv`: rubric score ≥ 8/10 on full-profile cases (PR #42) |
| Bundle | `check:bundle`: initial JS ≤ 300 kB gzip. PR #45 proposes 200 kB plus a 165 kB Firestore chunk cap (ADR-066). |
| Reliability | ≥ 95% of scheduled runs succeed (System screen run log) |
| Cost | Monthly cap `config/app.monthlyCapPence` = 3200; spend meter on Today |

## 3.4 Architecture
- **Stack, with the reason for each choice:**
  - Web: React 19, TypeScript strict, Vite, Tailwind v4, shadcn/ui, TanStack. Known stack, with a premium component base.
  - Backend: Firebase Auth, Firestore, Storage, Hosting and Cloud Functions v2 (Node 22), on Blaze. Known stack; needed for scheduled functions and outbound HTTP.
  - AI: Anthropic API, with a Haiku-class model for triage and a Sonnet-class model for deep reads and CVs. Splits cost from quality.
  - Gmail: Apps Script in the owner's account (ADR-003). No OAuth verification and no 7-day token expiry.
  - CV output: one structured CV → DOCX + PDF. One source of truth, ATS-safe.
  - Validation: zod at every boundary.
  - Tests: Vitest, Firebase emulators, rules-unit-testing.
  - CI: GitHub Actions. Deploys on `v*` tags with `production` approval.
- **Boundaries:**
  - UI: `web/`. Components use `web/src/services/` only.
  - Domain logic: `packages/shared`. Pure dedupe, rules and scoring.
  - Data: Firestore and Storage, behind owner-only rules.
  - External: source modules, `llm.call()`, and HMAC webhooks for Apps Script.
- **Data model:** see `docs/ARCHITECTURE.md`: config, criteria, profile/facts, profile/documents, companies, jobs (+ description), applications/cvs, runs, usage, events, locks. One owner UID owns everything.
  - **PII:** profile facts and the uploaded CV; generated CVs and cover notes; alert-email content; feedback notes; the owner UID.
  - Job postings are public business data.
- **External services:**

| Service | Purpose | Tier/plan | Cost at worst month | Licence/ToS checked | Cap in code | Account owner |
|---|---|---|---|---|---|---|
| Firebase / GCP | Hosting, Auth, Firestore, Storage, Functions, Scheduler, backups | Blaze | TBD (budgets £2/£5/£10 + `hireframe-kill` £25) | Yes | `maxInstances: 1` on every function; single-flight locks; `billingGuard` (dry run, armed in v1.0.1) | Beeb (personal) |
| Anthropic API | Triage, deep read, CV, alert parsing | Pay-as-you-go | £32 (cap) | Yes | `llm.call()`: monthly 3200p, run lease 52p, daily caps | Beeb (personal) |
| Reed API | UK jobs | Free key | £0 | Yes | Per-host rate limit | Beeb |
| Adzuna API | UK aggregator | Free key | £0 | Yes | Per-host rate limit | Beeb |
| Greenhouse / Lever / Ashby / Workable / HN Algolia | Public job boards | Public | £0 | Yes (ADRs, M3) | ≤ 1 req/s per host, backoff | n/a |
| Gmail + Apps Script | Alert ingest, digest email | Free | £0 | Yes | Reads one label; sends only to the owner | Beeb |
| reCAPTCHA Enterprise | App Check | Free tier | TBD | Yes | n/a | Beeb |
| GitHub | Public repo, CI | Free | £0 | Yes | n/a | Beeb |

- **Lock-in check:** Firebase is the painful one. Escape hatch: pure logic in `packages/shared`, zod schemas, and managed Firestore exports. Anthropic is easy: every call goes through `llm.call()`, and model names live in config.

## 3.5 Security and privacy
- **Threat model:** the valuable things are the CV and profile facts, the job and application history, alert-email content, the API keys and HMAC secret, and the billing account. Attackers are anyone who finds the public repo or the live endpoints. Routes: leaked secrets, forged webhook calls, reads by other accounts, prompt injection in postings or emails, runaway cost through loops or abuse.
- **Auth:** Google sign-in. Only the owner UID (allowlisted in `config/app`) can read or write. Rules deny by default and are unit-tested.
- **Rate limits and abuse controls:** sources ≤ 1 req/s per host with backoff on 429; daily caps per feature; single-flight locks; `maxInstances: 1`; HMAC over body + timestamp with a 5-minute skew and a nonce store.
- **App Check:** reCAPTCHA Enterprise, enforced on Firestore, Storage and callables. Limited-use tokens are consumed on owner callables.
- **PII inventory:** see 3.4. The logger redacts emails and phone numbers and never logs descriptions or CV text.
- **Lawful basis / UK GDPR:** N/A because the only data subject is the owner, processing their own data. Revisit before any sale to an organisation.
- **Privacy policy and terms:** N/A because there is one user.
- **Secrets:** ANTHROPIC_API_KEY, REED_API_KEY, ADZUNA_APP_ID, ADZUNA_APP_KEY and INGEST_HMAC_SECRET live in Secret Manager. The HMAC secret is also in the Apps Script Script Properties. gitleaks runs in CI, with secret scanning and push protection on. Rotation: immediately on a leak (RUNBOOK). A scheduled rotation is TBD.

## 3.6 Cost model
- **Cost per active user (1 user):** expected £13–14 a month for scanning and about £22–30 with everything; £32 worst case (the cap). Firebase/GCP cost: TBD, measured.
- **Cost at 10× users:** N/A until multi-user. That needs per-user caps and the buyer's billing.
- **Per-feature caps, and what happens when one is hit:**
  - Run lease 52p: S2 limited to 40%, S3 gets the rest, `s3MaxJobs` 32. Overflow is queued for the next run.
  - Lookup 25p/day. Gmail alerts 10p/day. Applications 60p/day, at most 3 model calls per owner move (with PR #42).
  - Monthly cap 3200p. At 80% the digest shows a warning. At 100% the deep stages pause and the cheap stages continue.
  - Billing guard: budget → Pub/Sub → `billingGuard`. It is in dry run now; v1.0.1 arms it with option A.

## 3.7 Environments and deploy
- **Environments:** local (emulators and fake data; `LIVE=1` for real paid calls) and prod (`hireframe-f6b03`, europe-west2). No staging (ADR-005). Preview deploys per PR: TBD (C6).
- **Known emulator ↔ prod gaps:** indexes, CORS, Cloud Scheduler jobs, IAM/invoker bindings, App Check. `npm run dev` is unbundled, so its timings are not comparable with the built site.
- **Post-deploy checklist:** the RUNBOOK "Every release" checklist (PR #41):
  - step 77 (C1, C2) when functions or rules change;
  - `gcloud scheduler jobs list --location=europe-west2`;
  - every new index says Enabled;
  - invoker bindings for every new callable, scheduled or event function;
  - check the live site;
  - the Scan-now proof;
  - the digest arrives.
  - A C7 Playwright smoke test on the live site: TBD.
- **Dev machines:**
  - Mac laptop with Homebrew gcloud, `gh`, and nvm (Node 22 default; Node 24 for PR #44).
  - Run multi-line shell blocks in bash, because zsh misreads `$VAR:`.
  - Git fallback: a phone hotspot or SSH over port 443.
  - The phone works through Remote Control.
  - PC parity and PAT expiry dates: TBD.

## 3.8 Data lifecycle
- **Backup:** managed Firestore backups every Sunday, kept 8 weeks. Storage soft delete 7 days. Last restore drill: 2026-10-20 (RUNBOOK step 103).
- **Retention:** `purgeOldData` runs at 03:30 London. It deletes descriptions older than 60 days for status new/skipped jobs with no application. Generated CVs are kept until the owner deletes them.
- **Wipe:** `deleteAllData` (System → Danger zone).
- **Owner export:** TBD (parked).

## 3.9 Testing and evals
- **Unit-tested:**
  - pure logic: dedupe, S1 rules, scoring, budget lease, CV validator, layout, lint and score;
  - services;
  - function limits (the `EXPECTED` table + an AST source scan);
  - `check:bundle` rules;
  - Firestore/Storage rules (`npm run test:rules`).
  - The load test (`node scripts/load-test.ts`, emulator, 1,000 jobs) runs by hand.
- **Checked by hand, by Beeb:**
  - the live site after each deploy;
  - RUNBOOK steps 89 and 97 for each release that touches the load path;
  - I7 (DOCX in Word and Google Docs) for CV changes;
  - daily use with 👍/👎.
- **Evals:**
  - Funnel: 40-posting golden set, gate 80%, free replay in `npm run check`.
  - CV suite: 8 cases, gate 8/10, report-only model judge.
  - LIVE runs are batched, and a failure is diagnosed offline first.

## 3.10 Observability
- **Logs and alerts:**
  - The System screen shows runs, per-source health, per-stage counts, the "Partial because" line, errors and spend.
  - The digest email (~07:50, with a fallback at 08:20) reports run health and errors.
  - GCP budget emails.
  - `billingGuard` logs (read with `gcloud logging read … jsonPayload.*`).
- **Uptime monitoring:** N/A because there is one user; the digest is the daily signal.
- **Structured logs:** deterministic `errorCode`. A request ID is TBD. One error shape: TBD.

## 3.11 Growth hooks (decide now, build later)
- **i18n:** N/A (one English-speaking user).
- **Currency:** GBP, stored as integer pence.
- **Timezones:** schedules run in Europe/London.
- **Offline:** N/A.
- **Scale triggers:**

| When… | Then do… |
|---|---|
| Hireframe is sold to an organisation | GitHub Pro (a private repo keeps the ruleset, environments and secret scanning), per-user caps, the buyer's billing, C10 project identity, commercial tier |
| S3 averages above 1.0p per job | Re-check c₃ and the 52p lease |
| The retention backlog `full` flag is still set in early Dec | Review `purgeOldData` throughput |
| Initial JS is near its budget | Look at ROADMAP items E–H before any dependency bump |

## 3.12 Exit / acquisition readiness
- **IP:** solo builder, no collaborators. Confirming that ELINDO and clients have no claim: TBD.
- **Licences:** a dependency licence audit is TBD. `pdfjs-dist` is pinned; the CV fonts are Liberation Sans.
- **Handover:** README, RUNBOOK, DECISIONS (ADRs) and CHANGELOG. The accounts are personal (C10 TBD). Metrics history lives in `runs`, `usage` and `events`.

## 3.13 Incident and sunset plans
- **Incident runbook:** the RUNBOOK Incidents table and its Recovery entries.
  - Key leaked: rotate it in Secret Manager (and in the Apps Script properties for HMAC), then purge it from history.
  - Site down: `firebase hosting:rollback`, then redeploy the functions from the previous tag.
  - Bill spike: pause the scheduler jobs, use the billing guard (armed in v1.0.1), and follow the Recovery entry "Billing was disabled".
  - Data breach: rotate the secrets, revoke the tokens, re-check the rules.
  - UU PDP notice: N/A (UK, own data).
- **Sunset:**
  1. Run `deleteAllData`.
  2. Delete the Firebase/GCP project.
  3. Remove the Apps Script triggers and the Gmail labels.
  4. Revoke the Anthropic, Reed and Adzuna keys.
  5. Archive the repo.
  - Custom domain: none recorded (TBD).

## 3.14 Risks and open questions
- **Pre-mortem (P3):** TBD. It was not run at kickoff.
- **Top 5 risks:**

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Runaway GCP or Anthropic spend | Low | High | `llm.call()` caps, `maxInstances: 1`, locks, budgets, billing guard (arm in v1.0.1) |
| Prod-only IAM, scheduler or CORS surprises after a deploy | Medium | Medium | "Every release" checklist, step 77, Scan-now proof |
| Wrong verdicts or missed good jobs | Medium | High | Golden-set eval gate, 👍/👎, Lookup sweep, Near-miss review |
| A source endpoint changes or a board disappears | Medium | Low | Per-source health; a 404 board is "gone" (ADR-056); one source never fails the run |
| Prompt injection through postings or emails | Low | Medium | No tools, fixed schemas, data delimiters, injection cases in the golden set |

- **Open questions:**

| Question | Owner | Decide by |
|---|---|---|
| Fix the lazy screens' failed-chunk handling inside PR #45? | Beeb | Before PR #45 rebases |
| Kill or pivot criteria | Beeb | TBD |
| C10 project identity for the accounts | Beeb | Before any sale |
| Per-PR preview deploys (C6) and a Playwright live smoke test (C7) | Beeb | TBD |

## Project hard rules (CLAUDE.md + the playbook rules that apply)
- No secrets in the repo (Secret Manager or `.env.local` only; gitleaks in CI). Never paste keys or the HMAC secret into chat or Claude Code.
- No personal data in the repo. Fixtures and evals are fake; the CV is never committed.
- No LinkedIn, Indeed, Wellfound or Glassdoor scraping or logged-in automation (ADR-004). Those boards arrive only through alert emails or a user paste.
- Only official or clearly public endpoints. Respect robots.txt and ToS, send a User-Agent, rate-limit per host.
- No auto-applying and no sending messages on the user's behalf.
- Job text is untrusted. Funnel LLM calls have no tools and a fixed schema.
- Generated CVs use only profile facts. Every bullet cites a `factId`.
- Every LLM call goes through `llm.call()`, which checks the cap first and records the cost.
- No self-triggering code. Every function has a literal `maxInstances: 1` and a `timeoutSeconds`, with a row in the `EXPECTED` table.
- C5: caps live in code and at the provider. Never relax a budget, threshold, cap or test without Beeb's decision.
- C7: check the live site, scheduler jobs, invoker bindings, CORS and App Check after every deploy.
- C11: Claude Code gets no prod credentials and no real personal data. Beeb runs every deploy, tag, IAM and console change.
- C12: update dependencies on a dedicated branch. Read the changelog of any major version, and check `check:bundle` and `engines` first.
