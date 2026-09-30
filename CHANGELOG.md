# Changelog

All notable changes. Format: Keep a Changelog, SemVer.

## [Unreleased]
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
