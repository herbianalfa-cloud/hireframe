# Security and safety

Single user, but it holds a CV, contact details, job history and Gmail-derived data, and the code is public. Treat it like a real product.

## Assets
CV and profile facts; job/application history; alert-email content; API keys (Anthropic, Reed, Adzuna, HMAC secret); Firebase project; the user's Google account.

## Threats → controls
| Threat | Control |
|---|---|
| Secret leaked via public repo | Secret Manager for all keys; `.env*` gitignored; gitleaks pre-commit (fail-closed: no gitleaks, no commit) + CI over full history; GitHub secret scanning + push protection on; rotate any key that ever touches a commit |
| Personal data in repo | Fixtures are fake; `evals/` anonymised; CV never committed (`.gitignore` blocks `.docx`/`.pdf`/`.jsonl` outside fixtures and evals); docs describe the user generically and candidate-specific values (e.g. `{profile.work_rights}`) are templated from the Firebase profile at runtime; `npm run scan:pii` (in `check` and CI) fails on non-allowlisted emails/phone numbers in tracked files. History was rewritten once to remove personal details (ADR-010) |
| Someone else reads the data | Firestore/Storage rules: `request.auth.uid == config/app.ownerUid` on every path, default deny, fail-closed until `config/app` exists; `config/*` never client-writable, so ownership can't be claimed; rules unit-tested for every collection (ADR-011); the only client writes are owner fact edits with versioned snapshots, criteria versions and CV uploads (PDF/DOCX ≤ 5 MiB, immutable), each tested for owner allow, anon deny and other-user deny (ADR-018, ADR-019); callables re-check the owner UID with the Admin SDK; App Check (reCAPTCHA Enterprise) enforced on Firestore, Storage, callables; new sign-ups and client-side account deletion disabled after bootstrap (Authentication → User actions, ADR-015) |
| Forged calls to webhooks | HMAC-SHA256 over body + timestamp; reject if > 5 min skew or replayed (nonce store 10 min); constant-time compare |
| Prompt injection in job posts / emails | Funnel LLM calls have no tools and fixed schemas; untrusted text wrapped in delimiters with explicit "data, not instructions"; outputs can only write verdict fields on that job; eval set includes injection cases. The profile calls (`parseCv`, `addFact`) follow the same pattern: tagged input that can't close its own tag, fixed schema, output validated with zod and evidence checked against the source text (ADR-018) |
| Hallucinated CV content | CV bullets must cite `factId`s; validator rejects unreferenced claims; user reviews before download |
| Runaway cost (loop, bug, big run) | App-level spend cap in `llm.call()`: each call reserves its worst case in a transaction before it runs, so concurrent calls can't overshoot (ADR-016); per-run caps (M4); max 1 function instance + single-flight lock; App Check tokens are consumed on calls that spend money; clients never auto-retry them; Anthropic console monthly limit; GCP budget alerts |
| Getting blocked / ToS breach at sources | Only public/official endpoints; robots.txt respected; per-host rate limit (≤ 1 req/s), backoff on 429; no logged-in scraping |
| Gmail over-access | Apps Script runs in the user's own account, reads only the `hireframe/alerts` label, sends only to the user's own address |
| Data loss | Weekly JSON backup to Storage (8 kept); Firestore PITR optional; events are append-only |
| Account takeover | Google account 2FA (user); owner-only auth; no password auth enabled; sign-ups disabled |
| Dependency supply chain | Dependabot; `npm audit` in CI (fail on high); lockfile committed; pinned GitHub Actions by SHA; deploys use keyless Workload Identity Federation limited to this repo, `v*` tags and the approved `production` environment (ADR-014) |
| Sensitive data in logs | Functions logger takes fixed event names and scalar fields only, redacts emails/phones and truncates strings; errors are logged by class and code, never message (zod issues and SDK errors can echo input); tests assert fixture CV text never reaches the log. Never log full descriptions or CV text |

## Data retention
- `skip` job descriptions purged after 60 days (metadata kept for metrics).
- Generated CVs kept until user deletes.
- "Delete all my data" admin action wipes collections + Storage.

## Security checklist before first deploy
- [x] Rules tests pass for every collection (owner allow, anon deny, other-user deny) (M1, `npm run test:rules`)
- [x] App Check enforced on Firestore and Storage (M1 RUNBOOK step 16, 2026-09-30)
- [ ] All secrets in Secret Manager; gitleaks clean on full history (Anthropic key in Secret Manager, read only by `hireframe-fns`; Reed/Adzuna/HMAC from M3/M6)
- [x] Budget alerts + Anthropic limit set
- [ ] HMAC verified with a replay test
- [ ] Injection eval cases pass

