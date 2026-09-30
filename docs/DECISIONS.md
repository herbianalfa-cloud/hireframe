# Decisions (ADRs)

Format: context → decision → consequences. Append new ones; never edit accepted ones (supersede instead).

## ADR-001 Firebase + React (Fridger stack)
Context: solo builder, needs to ship in a week. Decision: Firebase (Auth, Firestore, Functions v2, Hosting, Storage) + React/TS/Vite. Consequences: fast delivery, known patterns; requires Blaze plan for scheduled/outbound functions; vendor lock-in acceptable.

## ADR-002 Staged funnel with model tiers
Context: reading every job with a strong model is expensive. Decision: free rules → cheap-model triage → deep-model read → CV only on request. Consequences: ~10–20× lower cost per job; S1 rules must avoid killing wildcards (unknown titles pass).

## ADR-003 Gmail via Apps Script bridge, not OAuth app
Context: a Gmail OAuth app with restricted scopes needs Google verification, and unverified apps in Testing mode lose refresh tokens after 7 days. Decision: Apps Script in the user's own account reads a Gmail label and posts to an HMAC-signed webhook; it also sends the digest. Consequences: no verification, no token expiry, minimal scope; one more small codebase (`/apps-script`).

## ADR-004 No scraping of login-walled boards
Context: LinkedIn/Indeed/Wellfound prohibit scraping; account-ban risk. Decision: email alerts only. Consequences: Easy-Apply-only roles arrive via alerts, with a few hours' delay; Lookup can't fetch LinkedIn pages (user pastes text).

## ADR-005 Single prod environment
Context: one user. Decision: emulators + eval gate + tagged deploys instead of staging. Consequences: lower overhead; bad deploys roll back via `firebase hosting:rollback` and function redeploy of previous tag.

## ADR-006 CV facts must be cited
Context: LLM-tailored CVs can invent claims. Decision: every generated bullet references profile `factId`s; validator enforces. Consequences: no fabricated experience; profile must be kept current.

## ADR-007 Product renamed Shortlist → Hireframe
Context: name changed before any code was written. Decision: repo `hireframe`; Gmail labels `hireframe/alerts` and `hireframe/done`. Consequences: none beyond naming; all docs updated.


## ADR-008 M0 tooling
Context: the docs fix the stack but not the repo tooling. Decision:
- **npm workspaces** (`packages/*`, `functions`, `web`), no turbo/nx: three packages don't need a task runner.
- **TypeScript 6.0.x**, strict base config (`noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, …). TypeScript 7 is held back because typescript-eslint supports `< 6.1` only; Dependabot ignores TS majors until it does. `@types/node` tracks the Node 22 runtime.
- **ESLint** flat config with typescript-eslint `strictTypeChecked` + `stylisticTypeChecked` (type-aware: floating promises, deprecated APIs, unsafe `any` flows), `no-explicit-any` as error, plus **Prettier** via `eslint-config-prettier`. Markdown is excluded from Prettier so hand-written docs are not reformatted.
- **Vitest** with one inline project per workspace plus `scripts`, from a single root config.
- **husky** pre-commit running gitleaks on staged changes, **fail-closed**: if gitleaks is missing the commit is blocked.
- **CI gitleaks** runs a pinned binary (version + SHA-256 in the workflow) over the full history, instead of a third-party action; no token needed. Other actions are pinned by commit SHA.
- **PII scan** (`scripts/check-pii.ts`, Node 22 type stripping): emails/phone numbers in tracked files fail `npm run check` and CI; output is redacted because CI logs are public.

Consequences: one `npm run check` gate locally and in CI; contributors need gitleaks installed; the gitleaks version in CI is bumped by hand (Dependabot can't see it).

## ADR-009 Wave 1 spec clarifications
Context: a review of the docs before any code found invalid Firestore paths, overlapping verdict rules, an experience rule off by one, and a per-run worst case that exceeds the monthly cap. Decision:
- **Firestore paths:** `profile/main/facts/{factId}`, `profile/main/documents/{docId}`; the scan lock lives in `locks/scan` (not `runs/lock`), so run queries never return it. → ARCHITECTURE.md
- **Cost (M4):** caps stored in pence; `config/app.fxUsdToGbp` converts Anthropic's USD costs; the S3 per-run cap is lowered so the worst case (scheduled runs/month × S3 cap × max S3 cost) fits the monthly cap. → FUNNEL.md, ARCHITECTURE.md
- **Verdict precedence:** apply > wildcard > near_miss > skip; first match wins. → FUNNEL.md
- **Experience rule:** S1 skips only if the required minimum is greater than `experience_cap_years` (default 2, so 3+ years). Asks equal to the cap go to S2/S3 and take the luck penalty. → FUNNEL.md
- **S1 consistency:** the "Manager unless preceded by Product/Account/Associate/Junior" rule is in the seed criteria. Freshness is checked in S1 only, with a rule ID; S0 is dedupe only. → FUNNEL.md
- **Digest timing (M7):** Apps Script triggers fire within ±15 min, so `getDigest` returns an explicit in-progress/failed notice rather than nothing. → ARCHITECTURE.md
- **Evals in CI:** CI replays recorded responses only, so no Anthropic key is stored in GitHub; live evals run locally. → FUNNEL.md

Consequences: the spec is consistent before code exists; the M4 and M7 plans must implement these points (noted in ROADMAP.md).

## ADR-010 Personal details stay out of the repo
Context: the repo is public, and the first docs pack described the candidate's education, work-rights status, dates and employer. Decision: docs describe the user generically. Candidate-specific values live in the Firebase profile and are templated into prompts and rules at runtime (e.g. `{profile.work_rights}`). The single initial commit was amended and force-pushed on 2026-09-30 (the `main` ruleset was briefly disabled, then restored with identical rules), so those details are not in branch history. Guardrails: `.gitignore` blocks CV/document/data-export file types; `npm run scan:pii` runs in `check` and CI; the PR template asks for no personal data in PR text. Consequences: S2 prompts and S1 work-rights blocker patterns must read from the profile; commit author metadata keeps the real name by choice (portfolio repo).
