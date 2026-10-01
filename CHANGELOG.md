# Changelog

All notable changes. Format: Keep a Changelog, SemVer.

## [Unreleased]
### Fixed
- **Evidence on Profile fact cards looked empty.** The quote was stored and rendered, but it sits in a collapsed disclosure whose summary had no marker, so "Evidence" read as a heading with nothing under it. It now has a chevron that turns when open. A component test covers CV and manual facts.
- **Re-uploading the same CV is stable** (ADR-022). Uploading the .docx and then the .pdf gave "Added 64, unchanged 77, flagged 53", because the model words facts differently on every read.
  - The merge now matches on the fact's evidence quote (normalised for PDF/DOCX extraction noise) before falling back to text similarity. An archived fact is never re-added under new wording.
  - parseCv stores a SHA-256 of each upload and doesn't read the same file twice: no model call, nothing changes.
  - Tests reproduce the bug with two differently worded fake reads of the same CV.

### Added
- **Upload rows show the original file name** (truncated, full name in a tooltip). `parseCv` takes a required `fileName` (1–200 characters, validated with zod) and saves it on the upload document. It is never logged (a test checks). Uploads made before this have no name and show none. The immutable-fields rules test now covers `fileName`.
- **Remove upload** on each upload row (ADR-023). It archives the facts that upload added and that were never edited, drops its pending proposed changes, keeps (and counts) facts you edited, and marks the upload Removed. It uses versioned client writes, with one new rule: the owner may set `removedAt` once on a finished upload.
- **Reset profile** in a Profile Danger zone (ADR-023). You type RESET, and the owner-only `resetProfile` callable hard-deletes every fact, version, upload and uploaded file; criteria and spend are kept. It refuses while a CV is being read.
- **Evidence link** on facts (ADR-024): an optional https-only `evidenceUrl`, editable and versioned. A model can never set one. Rules and rules tests are updated.

### Changed
- RUNBOOK: "Functions setup (M2)" is now **Part C**.
  - It covers every manual step from the v0.2.x deploys: the extra APIs (and why); the deployer's `serviceAccountUser` on the App Engine default and the default compute accounts; a one-time `allUsers` invoker binding per new callable; a check of the Storage service agent's `firebaserules.firestoreServiceAgent` role.
  - Upgrade steps for v0.2.2 and new Recovery entries.
- The functions runtime account needs `storage.objectUser` instead of `storage.objectViewer` on the bucket (to delete uploads on reset).
- Only the model callables mount the Anthropic key.
- Security: scoped npm overrides under firebase-tools: `basic-ftp` 6.2.1 (GHSA-c475-qrg2-pj4r, high; fixes the CI `audit` job) and `uuid` 11.1.1 (GHSA-w5hq-g745-h8pq, Dependabot alert #1). See the ADR-013 addendum.
- ROADMAP: M8 adds a dedicated Cloud Build account and removes Editor from the default compute account; "file attachments as evidence" is parked.

## [0.2.1] - 2026-10-01
### Fixed
- The v0.2.0 deploy failed with "Invalid service account (hireframe-fns@)" from Secret Manager. The runtime account is now the full email, from one constant in `functions/src/config.ts`, with a test that it stays a full email.

### Changed
- RUNBOOK Functions setup: step 2 also enables `eventarc`, `firebaseextensions` and `cloudbilling`; step 7 also grants the deployer `roles/iam.serviceAccountUser` on the App Engine default account (the Firebase CLI pre-check).

## [0.2.0] - 2026-10-01
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
  - **Title rules:** `checkTitle` applies excluded titles as "immediately preceded by", whole words, with lanes winning over every rule except seniority. See ADR-020.
  - **Checks:** `npm run check:bundle` (web bundle budget) and a static guard listing every client-writable rules path; the CI smoke test now checks every function is in europe-west2.

### Changed
- `npm run dev` also runs the Functions emulator and seeds criteria v1; `npm run test:rules` also runs emulator integration tests; `npm run deploy` includes functions.
- Web: Profile and Criteria load on first visit, the Functions and Storage SDKs on first use, and vendors split into cached chunks; initial JS down from 1.08 MB to about 0.97 MB with no chunk over 500 kB (ADR-021).
- The region and callable timeouts are shared by functions and web (`packages/shared/src/callables.ts`).
- The emulator's fake model records `fake:<model id>`, so fake spend can't be mistaken for real spend.

### Fixed
- PR #4 review:
  - streamed model calls now have a hard time limit (the SDK timeout stopped at the response headers), and each `llm.call()` has a budget inside its callable timeout;
  - a call killed mid-flight is charged its worst case instead of vanishing from the month's spend (ADR-016);
  - the Anthropic SDK logger and pdf.js warnings can no longer print CV text to the function logs;
  - a CV whose parse was abandoned shows "Timed out" instead of "Reading" forever;
  - the CSP allows the callables host.
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
