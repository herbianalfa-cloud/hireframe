# Security and safety

Single user, but it holds a CV, contact details, job history and Gmail-derived data, and the code is public. Treat it like a real product.

## Assets
CV and profile facts; job/application history; alert-email content; API keys (Anthropic, Reed, Adzuna, HMAC secret); Firebase project; the user's Google account.

## Threats → controls
| Threat | Control |
|---|---|
| Secret leaked via public repo | Secret Manager for all keys; `.env*` gitignored; gitleaks pre-commit (fail-closed: no gitleaks, no commit) + CI over full history; GitHub secret scanning + push protection on; rotate any key that ever touches a commit |
| Personal data in repo | Fixtures are fake; `evals/` anonymised; CV never committed (`.gitignore` blocks `.docx`/`.pdf`/`.jsonl` outside fixtures and evals); docs describe the user generically and candidate-specific values (e.g. `{profile.work_rights}`) are templated from the Firebase profile at runtime; `npm run scan:pii` (in `check` and CI) fails on non-allowlisted emails/phone numbers in tracked files. History was rewritten once to remove personal details (ADR-010) |
| Someone else reads the data | Firestore/Storage rules: `request.auth.uid == config/app.ownerUid` on every path, default deny, fail-closed until `config/app` exists; `config/*` never client-writable, so ownership can't be claimed; rules unit-tested for every collection (ADR-011); the only client writes are owner fact edits with versioned snapshots (including an optional https-only `evidenceUrl`, ADR-024), criteria versions, CV uploads (PDF/DOCX ≤ 5 MiB, immutable) and marking an upload removed (`removedAt` only, once, ADR-023), each tested for owner allow, anon deny and other-user deny (ADR-018, ADR-019); callables re-check the owner UID with the Admin SDK; App Check (reCAPTCHA Enterprise) enforced on Firestore, Storage, callables; new sign-ups and client-side account deletion disabled after bootstrap (Authentication → User actions, ADR-015) |
| Forged calls to webhooks | HMAC-SHA256 over body + timestamp; reject if > 5 min skew or replayed (nonce store 10 min); constant-time compare |
| Prompt injection in job posts / emails | Funnel LLM calls have no tools and fixed schemas; untrusted text wrapped in delimiters with explicit "data, not instructions"; outputs can only write verdict fields on that job; eval set includes injection cases. The profile calls (`parseCv`, `addFact`) follow the same pattern: tagged input that can't close its own tag, fixed schema, output validated with zod and evidence checked against the source text (ADR-018). Evidence links are not in the model's output schema, so injected text can't plant a link (ADR-024) |
| Hallucinated CV content | CV bullets must cite `factId`s; validator rejects unreferenced claims; user reviews before download |
| Runaway cost (loop, bug, big run) | App-level spend cap in `llm.call()`: each call reserves its worst case in a transaction before it runs, so concurrent calls can't overshoot, every send has a hard time limit, and a call that never settles (killed at the callable timeout) is charged its worst case rather than dropped (ADR-016); per-run caps (M4); max 1 function instance + single-flight lock; App Check tokens are consumed on calls that spend money; clients never auto-retry them; Anthropic console monthly limit; GCP budget alerts |
| Getting blocked / ToS breach at sources | Only public/official endpoints; robots.txt respected for web pages and unkeyed endpoints (Crawl-delay honoured), keyed official APIs (Reed, Adzuna) kept inside their developer terms and quotas (ADR-025); ToS checked before adding a source (ADR-026–028); `HireframeBot` User-Agent; per-host rate limit (≤ 1 req/s), at most 3 attempts with backoff on 429/5xx; no logged-in scraping |
| Gmail over-access | Apps Script runs in the user's own account, reads only the `hireframe/alerts` label, sends only to the user's own address |
| Data loss | Weekly JSON backup to Storage (8 kept); Firestore PITR optional; events are append-only |
| Account takeover | Google account 2FA (user); owner-only auth; no password auth enabled; sign-ups disabled |
| Dependency supply chain | Dependabot; `npm audit` in CI (production dependencies fail on high, dev-only tools on critical, ADR-013 addendum M3); lockfile committed; pinned GitHub Actions by SHA; deploys use keyless Workload Identity Federation limited to this repo, `v*` tags and the approved `production` environment (ADR-014) |
| Sensitive data in logs | Functions logger takes fixed event names and scalar fields only; the source HTTP client logs a host and a fixed label, never a URL (Adzuna's key travels in the query string), and scans log counts, never job text; redacts emails/phones and truncates strings; errors are logged by class and code, never message (zod issues and SDK errors can echo input); third-party console output is off (Anthropic SDK `logLevel: 'off'`, which `ANTHROPIC_LOG` can't override; pdf.js `verbosity: 0`); tests assert fixture CV text never reaches the log or the console on success and on every failure path (model timeout/abort, unusable output, extraction and store errors). Never log full descriptions or CV text |

## Data retention
- `skip` job descriptions purged after 60 days (metadata kept for metrics).
- Generated CVs kept until user deletes.
- "Delete all my data" admin action wipes collections + Storage. For the profile this is **Reset profile** (M2.1, ADR-023): an owner-only callable, confirmed by typing RESET, that hard-deletes every fact, version, upload document and uploaded CV file. Jobs, generated CVs and events join the wipe when they exist.
- "Remove upload" only archives (reversible); the uploaded file is kept until Reset profile.

## Security checklist before first deploy
- [x] Rules tests pass for every collection (owner allow, anon deny, other-user deny) (M1, `npm run test:rules`)
- [x] App Check enforced on Firestore and Storage (M1 RUNBOOK step 16, 2026-09-30)
- [ ] All secrets in Secret Manager; gitleaks clean on full history (Anthropic key in Secret Manager, read only by `hireframe-fns`; Reed and Adzuna keys from M3, mounted only on `scanNow` and never logged, ADR-025; HMAC from M6)
- [x] Budget alerts + Anthropic limit set
- [ ] HMAC verified with a replay test
- [ ] Injection eval cases pass

