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

