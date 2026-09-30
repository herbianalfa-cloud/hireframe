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

## ADR-011 Owner allowlist, bootstrap and M1 rules
Context: PRD R1 allows only the owner's UID, but that UID doesn't exist until the owner first signs in, and the repo is public. Decision:
- Firestore and Storage rules allow access only when `request.auth.uid == config/app.ownerUid` (Storage reads it through cross-service rules). If `config/app` or `ownerUid` is missing, nobody gets in: the rules fail closed.
- `config/*` is never writable from a client, so a signed-in stranger can't create `config/app` to claim ownership. A rules test proves this.
- **Bootstrap:** after the first deploy the owner signs in and sees "No access". They copy their UID from the Auth console and create `config/app` in the Firestore console; console writes are admin writes (docs/RUNBOOK.md). There's no script and no local credentials.
- **M1 matrix:** the owner can read every Wave-1 collection. There are no client writes anywhere yet, for the owner too. Each later milestone opens only the writes its UI needs, with rules tests. Unknown paths and Storage `backups/**` are denied to all clients.
- **Defence in depth:** the web gate zod-parses `config/app` and compares UIDs; it never grants access by default. After bootstrap, new sign-ups are disabled (Identity Platform, ADR-014).
- **Rejected:**
  - "First sign-in becomes owner": whoever finds the URL first wins.
  - Owner email in the rules: personal data in a public repo.
  - Custom claims: they need an Admin SDK script and local credentials.

Consequences: each rules check costs one extra document read (`get(config/app)`), which is negligible for one user; custom claims can replace it later if that ever matters. A typo in `ownerUid` locks the owner out until fixed in the console. Changing the owner is a console edit.

## ADR-012 Web shell toolchain
Context: M1 needs a deployable dark shell on the documented stack (React 19, Vite, Tailwind v4, shadcn/ui, TanStack Query). Decision:
- **Routing:** react-router in declarative mode, which is enough for a handful of screens.
- **shadcn/ui:** components are added by hand into `web/src/components/ui` (no CLI step in CI).
- **Fonts:** Inter and JetBrains Mono are self-hosted via `@fontsource-variable`.
- **Firebase config:** read at runtime from Firebase Hosting's reserved `/__/firebase/init.json`, so no Firebase config or API key sits in the repo or CI (and gitleaks never sees one). `authDomain` is set to the serving host, so the sign-in handler is same-origin and works without third-party storage. Pop-up sign-in falls back to redirect if the pop-up is blocked.
- **Shared code:** `@hireframe/shared` has a `source` export condition, so Vite, Vitest and TS read its sources directly, while Node (functions) uses `dist`.
- **CSP:** ships as `Content-Security-Policy-Report-Only` in M1. Other security headers are enforced. CSP enforcement moves to M8, once the real traffic of Google sign-in and App Check has been observed.
- **eslint-plugin-jsx-a11y:** not used, because it doesn't support ESLint 10 yet and the forks are unvetted. Accessibility is covered by role-based component tests, the Lighthouse ≥ 95 check (R7) and native elements (e.g. radio inputs for the theme switcher). It gets added back once upstream supports ESLint 10 (ROADMAP parking lot).
- **Theme:** dark by default; `light` and `system` (follows `prefers-color-scheme`) on request. `<html data-theme>` is the single source of truth.

Consequences: the production bundle only works when served by Firebase Hosting (by design). A local production build needs `web/.env.local` with the public reCAPTCHA site key.

## ADR-013 Local development on the demo-hireframe emulator project
Context: local work must never touch production data, and rules tests need emulators. Decision:
- `npm run dev` and `npm run test:rules` run `firebase emulators:exec --project demo-hireframe`. A `demo-*` project can't reach real Firebase resources.
- `npm run dev` seeds a fake owner (`owner@example.com`, linked to Google so the emulator's sign-in pop-up lists it) and a console-shaped `config/app` with Timestamps. The seed refuses to run against any non-`demo-*` project.
- Rules tests live in `tests/rules/` with their own Vitest config (`vitest.rules.config.ts`, run serially because both suites share one emulator), so `npm test` stays network-free.
- `firebase-tools` is a pinned devDependency, so local runs and CI use the same emulators. The emulators need Java 21.

Consequences: contributors need Java 21 installed. firebase-tools brings a large dependency tree (currently only moderate `npm audit` findings; CI fails on high). Its lockfile entries include npm deprecation notices containing a third-party maintainer's public contact address, so `scan:pii` skips the generated `package-lock.json` rather than allowlisting a person's address; every hand-written file is still scanned. `@firebase/firestore` pins `@grpc/grpc-js ~1.9.0`, which has high advisories (GHSA-m9gg-hp2v-232j, GHSA-f596-whhp-79r4; server-side, and grpc-js is not in the browser bundle). A root `overrides` entry forces the patched 1.14.5 (rules tests pass on it) so the `audit` gate stays at `high`; remove the override once Firebase bumps its pin.

## ADR-014 Deploy: keyless, tag-only, London
Context: CLAUDE.md says deploys are CI-only on tagged releases, and there must be no long-lived keys. Decision:
- **Trigger:** `.github/workflows/deploy.yml` runs on `v*` tags in the GitHub `production` environment (owner approval required; only `v*` tags may deploy). It re-runs `check` and `test:rules`, builds, then deploys hosting, Firestore rules/indexes and Storage rules.
- **Auth:** Workload Identity Federation. The pool provider only accepts tokens whose `repository_id` is this repo, whose ref is `refs/tags/v*` and whose environment is `production`. The `github-deployer` service account holds only the roles the deploy needs (docs/RUNBOOK.md). There's no service-account key. `npm run deploy` refuses to run outside GitHub Actions on a `v*` tag.
- **Region:** `europe-west2` (London) for Firestore and Storage, and later for Functions. The Firestore location can't be changed.
- **No Cloud Functions in M1**: the `functions` block is added with the first function.
- **PR preview channels are parked:** Google sign-in and App Check (reCAPTCHA domain list) don't work cleanly on preview domains.
- **Sign-ups:** after the owner bootstrap, Firebase Auth is upgraded to Identity Platform (free at this scale, one-way) and "Enable create (sign-up)" is turned off, so strangers can't even create accounts.

Consequences: production auth and App Check are first exercised after merge and tag. That risk is reduced by the emulator tests, report-only CSP and `firebase hosting:rollback`. Adding Functions later needs extra deployer roles.

*The "Sign-ups" bullet is superseded by ADR-015.*

## ADR-015 Closing sign-ups without Identity Platform
Context: ADR-011 and ADR-014 assumed sign-ups could only be turned off after upgrading Firebase Auth to Identity Platform. During the v0.1.0 bootstrap, **Authentication → Settings → User actions** was already available, so no upgrade was needed. Decision: after bootstrap, untick both **Enable create (sign-up)** and **Enable deletion**. Deletion is also off because a deleted owner account couldn't be re-created while sign-ups are closed, and a new account would get a new UID anyway. The Identity Platform upgrade stays only as a fallback, for projects where User actions is missing. This supersedes ADR-014's "Sign-ups" bullet and the Identity Platform mention in ADR-011. Consequences: no one-way upgrade was made. A blocked sign-up still returns `auth/admin-restricted-operation`. Recovering a lost owner account is a short console procedure (RUNBOOK Recovery).
