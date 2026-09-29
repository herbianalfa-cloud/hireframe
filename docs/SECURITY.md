# Security and safety

Single user, but it holds a CV, contact details, job history and Gmail-derived data, and the code is public. Treat it like a real product.

## Assets
CV and profile facts; job/application history; alert-email content; API keys (Anthropic, Reed, Adzuna, HMAC secret); Firebase project; the user's Google account.

## Threats → controls
| Threat | Control |
|---|---|
| Secret leaked via public repo | Secret Manager for all keys; `.env*` gitignored; gitleaks pre-commit + CI; GitHub secret scanning + push protection on; rotate any key that ever touches a commit |
| Personal data in repo | Fixtures are fake; `evals/` anonymised; CV never committed; CI grep for email/phone patterns in tracked files |
| Someone else reads the data | Firestore/Storage rules: `request.auth.uid == config owner UID` on every path, default deny; rules unit-tested; App Check (reCAPTCHA Enterprise) enforced on Firestore, Storage, callables |
| Forged calls to webhooks | HMAC-SHA256 over body + timestamp; reject if > 5 min skew or replayed (nonce store 10 min); constant-time compare |
| Prompt injection in job posts / emails | Funnel LLM calls have no tools and fixed schemas; untrusted text wrapped in delimiters with explicit "data, not instructions"; outputs can only write verdict fields on that job; eval set includes injection cases |
| Hallucinated CV content | CV bullets must cite `factId`s; validator rejects unreferenced claims; user reviews before download |
| Runaway cost (loop, bug, big run) | App-level spend cap checked in `llm.call()`; per-run caps; max 1 function instance + single-flight lock; Anthropic console monthly limit; GCP budget alerts |
| Getting blocked / ToS breach at sources | Only public/official endpoints; robots.txt respected; per-host rate limit (≤ 1 req/s), backoff on 429; no logged-in scraping |
| Gmail over-access | Apps Script runs in the user's own account, reads only the `hireframe/alerts` label, sends only to the user's own address |
| Data loss | Weekly JSON backup to Storage (8 kept); Firestore PITR optional; events are append-only |
| Account takeover | Google account 2FA (user); owner-only auth; no password auth enabled |
| Dependency supply chain | Dependabot; `npm audit` in CI (fail on high); lockfile committed; pinned GitHub Actions by SHA |
| Sensitive data in logs | Logger redacts emails/phones; never log full descriptions or CV text |

## Data retention
- `skip` job descriptions purged after 60 days (metadata kept for metrics).
- Generated CVs kept until user deletes.
- "Delete all my data" admin action wipes collections + Storage.

## Security checklist before first deploy
- [ ] Rules tests pass for every collection (owner allow, anon deny, other-user deny)
- [ ] App Check enforced
- [ ] All secrets in Secret Manager; gitleaks clean on full history
- [ ] Budget alerts + Anthropic limit set
- [ ] HMAC verified with a replay test
- [ ] Injection eval cases pass

