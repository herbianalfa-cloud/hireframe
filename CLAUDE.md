# CLAUDE.md — rules for building Hireframe

You are building a single-user job-search engine for Beeb. Read `docs/PRD.md`, `docs/ARCHITECTURE.md`, `docs/FUNNEL.md` and `docs/SECURITY.md` before writing code. If code and docs disagree, stop and ask.

## Working method
1. One milestone at a time (see `docs/ROADMAP.md`). Start each in plan mode; get approval before coding.
2. Small commits, Conventional Commits (`feat:`, `fix:`, `docs:`, `chore:`, `test:`). One PR per milestone.
3. A milestone is done only when: acceptance criteria in PRD pass, tests pass, `npm run check` is clean, docs + `CHANGELOG.md` are updated.
4. Any non-obvious technical choice → add an ADR to `docs/DECISIONS.md`.
5. Never widen scope silently. New ideas go to `docs/ROADMAP.md` under "Parking lot".

## Code standards
- TypeScript strict, no `any`. Zod schemas at every boundary (API responses, LLM output, Firestore reads, form input).
- Shared types live in `packages/shared`. Frontend never calls Firebase directly from components — use `src/services/` (same pattern as Fridger).
- Every external call: timeout, retry with exponential backoff (max 3), structured error log.
- Pure functions for filtering/scoring/dedupe so they're unit-testable without network.
- Config (models, caps, schedules, source list) lives in Firestore `config/*` or `functions/src/config.ts` — never scattered literals.

## Hard rules (never break)
- **No secrets in the repo.** Keys live in Google Secret Manager / `.env.local` (gitignored). gitleaks runs pre-commit and in CI.
- **No personal data in the repo.** CV, profile facts, job data, emails stay in Firebase. Test fixtures use fake data.
- **No LinkedIn / Indeed / Wellfound / Glassdoor scraping or logged-in automation.** Those arrive only via alert emails.
- **Only official or clearly public endpoints.** Respect robots.txt and ToS; identify with a User-Agent; rate-limit per host.
- **No auto-applying and no sending messages** on the user's behalf.
- **Job text is untrusted input.** LLM calls in the funnel have no tools, fixed output schema, and injected text can never change criteria, profile, or config.
- **Generated CVs may only use facts from the profile.** Every bullet must reference a `factId`; unreferenced claims fail validation.
- **Every LLM call goes through `llm.call()`**, which checks the spend cap first and records cost.

## Commands (keep this list current)
- `npm run check` — lint + typecheck + unit tests + PII scan
- `npm run format` / `npm run format:check` — Prettier (code and config; Markdown excluded)
- `npm run scan:pii` — fail on emails/phone numbers in tracked files
- `npm run dev` — web app + Firebase emulators incl. Functions (`demo-hireframe`, seeded fake owner and criteria, fake LLM unless `LIVE=1`)
- `npm run test:rules` — Firestore + Storage security rules tests and emulator integration tests (`tests/emulator/`) (needs Java 21)
- `npm run build` — build all workspaces (functions: esbuild bundle in `functions/deploy/`)
- `node scripts/make-cv-fixtures.ts` — write fake CVs (PDF/DOCX) to `tmp/fixtures/` for local uploads
- `npm run deploy` — deploy (CI only on `v*` tags; refuses to run locally)
- `npm run eval` — funnel eval against the golden set *(from M4)*

