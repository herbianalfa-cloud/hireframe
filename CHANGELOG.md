# Changelog

All notable changes. Format: Keep a Changelog, SemVer.

## [Unreleased]
### Added
- M2 Profile brain:
  - **CV → facts:** `parseCv` reads an uploaded PDF or DOCX (up to 5 MB), extracts the text and asks a Sonnet-class model for atomic facts (one claim each, multi-claim bullets split), each with a verbatim evidence quote checked against the CV. See ADR-018.
  - **Re-upload merge:** new facts are added, changed facts are flagged for review, archived facts aren't revived, nothing is overwritten.
  - **Profile screen:** view, search, edit, archive and restore facts; every fact shows its source; accept or keep proposed changes; version history; add a fact from a note (`addFact`, Haiku-class model).
  - **Criteria:** v1 seeded from FUNNEL.md (with structured excluded titles), an editable Criteria screen, immutable versions with a `criteria/current` pointer, and history. See ADR-019.
  - **Spend cap from day one:** a minimal `llm.call()` reserves each call's worst case against the monthly cap before it runs and records the actual cost in `usage/{yyyy-mm}`. See ADR-016.
  - **Rules:** the first client writes (versioned fact edits, criteria versions, CV uploads), each tested for owner allow, anon deny and other-user deny.
  - **Functions:** first Cloud Functions in europe-west2 on a dedicated runtime account, App Check enforced and consumed, bundled with esbuild; fake model in the emulator. See ADR-017.
  - **Docs:** RUNBOOK Functions setup (M2) and local-dev steps; `node scripts/make-cv-fixtures.ts` for fake CVs.

### Changed
- `npm run dev` also runs the Functions emulator and seeds criteria v1; `npm run test:rules` also runs emulator integration tests; `npm run deploy` includes functions.

### Fixed
- RUNBOOK M1 setup:
  - enable the Firebase Storage API and create the bucket from the Firebase console;
  - add the `web.app` origin and `/__/auth/handler` redirect URI to the OAuth web client;
  - close sign-ups and account deletion under User actions, with no Identity Platform upgrade (ADR-015).
- New recovery entries, and the SECURITY checklist is updated.

## [0.1.0] - 2026-09-30
### Added
- M1 Firebase foundation:
  - **Owner-only access:**
    - Firestore and Storage rules, owner-only and fail-closed until `config/app` exists, with no client writes in M1.
    - Rules tests for every collection, including bootstrap attacks (`npm run test:rules`, CI `rules` job). See ADR-011.
  - **Web shell:**
    - Vite, React 19, Tailwind v4, shadcn/ui and react-router, dark by default with Light and System themes.
    - Sidebar on desktop, bottom tabs on phone, and empty states for Today, Jobs, Lookup, Profile, Criteria and System. See ADR-012.
  - **Auth gate:** Google sign-in, then "No access" for anyone but the owner. `config/app` Timestamps are converted before the zod parse.
  - **App Check** with reCAPTCHA Enterprise. Firebase config is read from Hosting's `init.json`, so none is in the repo.
  - **Local dev:** `npm run dev` runs the emulators on `demo-hireframe` with a seeded fake owner. See ADR-013.
  - **Deploy:** a tag-only workflow with keyless Workload Identity Federation and `production` environment approval, in region europe-west2. See ADR-014.
  - **Security:** an npm override forces `@grpc/grpc-js` 1.14.5 under the Firebase SDK, fixing two high advisories (ADR-013).
  - **Docs:** RUNBOOK Firebase setup, owner bootstrap and recovery; `AppConfigSchema` and Firestore path constants in `packages/shared`.

### Changed
- Renamed product Shortlist → Hireframe (repo, Gmail labels, docs). See ADR-007.
- Spec clarifications: Firestore paths, `locks/scan`, cost cap in pence with USD→GBP rate, verdict precedence, experience rule `> cap`, freshness in S1 only, digest in-progress notice, recorded-only evals in CI. See ADR-009.
- Docs describe the user generically; personal details live in the Firebase profile only. See ADR-010.

### Added
- Wave 1 documentation pack (PRD, architecture, funnel, security, design, roadmap, ADRs, runbook).
- M0 repo + guardrails: npm workspaces (`packages/shared`, `functions`, `web`), strict TypeScript, ESLint (typescript-eslint strict, type-aware) + Prettier, Vitest projects, `npm run check`. See ADR-008.
- Fail-closed gitleaks pre-commit hook; PII scan (`npm run scan:pii`) for emails/phone numbers.
- CI (GitHub Actions, pinned by SHA): `check`, `gitleaks` (full history), `audit` (`npm audit`, high). Required on `main`.
- Dependabot (npm + Actions) and a PR template mirroring the definition of done.
