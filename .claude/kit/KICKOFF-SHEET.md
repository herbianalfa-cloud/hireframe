<!-- Generated from PLAYBOOK.md Part 3 by the kit installer. Edit the master playbook, not this file. -->
## 3. Kickoff Sheet (copy into `docs/PROJECT.md` and fill in)

### 3.1 Identity
- **Name and one-liner:**
- **Type:** web/PWA · mobile · game · AI/LLM · automation/scraper · messaging · internal tool · client work
- **Stakes and tier:** toy (Core) · portfolio (Core + this sheet) · commercial/client (everything)
- **Playbook version** used, and the **add-ons** chosen from Part 4:
- **Owner account / entity:**
- **Learning goal** (one skill this project should teach me):
- **Portfolio angle** (the case-study story; capture screenshots, before/after metrics and key decisions as you go):

### 3.2 Why
- **Problem, and for whom:**
- **Why now / why me:**
- **Non-goals:**
- **Success metrics** (numbers, with a date):
- **Kill or pivot criteria:**

### 3.3 Scope
- **MVP** (the smallest thing that proves the core loop):
- **Milestones** M0…Mn, each with exit criteria and a time-box:
- **Quality bars**, each with its measurement method:

### 3.4 Architecture
- **Stack, with a one-line reason for each choice:**
- **Boundaries:** UI / domain logic / data / external services
- **Data model:** entities, ownership, and which fields are PII:
- **External services:**

| Service | Purpose | Tier/plan | Cost at worst month | Licence/ToS checked | Cap in code | Account owner |
|---|---|---|---|---|---|---|

- **Lock-in check:** which vendor would be painful to leave, and what's the escape hatch?

### 3.5 Security and privacy
- **Threat model in five lines:** what's valuable, who would attack it, and how.
- **Auth** provider, **authorisation rules** (who can read/write what), **rate limits and abuse controls**, **App Check / bot protection**.
- **PII inventory**, **lawful basis**, **UK GDPR / UU PDP** where relevant, **privacy policy and terms**.
- **Secrets:** where they live and how they're rotated.

### 3.6 Cost model
- **Cost per active user,** and cost at 10× users:
- **Per-feature caps,** and what happens when one is hit (degrade gracefully, don't crash):

### 3.7 Environments and deploy
- **Environments:** local / preview / prod
- **Known emulator ↔ prod gaps:**
- **Post-deploy checklist** (start from C7, then extend):
- **Dev machines:** Win/Mac parity, dotfiles, `gh` auth, PAT expiry dates, and a git fallback for networks that block it (hotspot, or SSH over port 443). *(Fridger, Hireframe)*

### 3.8 Data lifecycle
- **Backup:** method, frequency, and date of the last restore drill:
- **Retention, user export and account wipe:**

### 3.9 Testing and evals
- **What's unit-tested:**
- **What's checked by hand, by whom, and how often:**
- **Evals** (for AI features): the golden set and its pass threshold:

### 3.10 Observability
- **Error tracking, logs, uptime and cost alerts,** and who gets alerted and how.
- **Structured logs** with a request ID, and **one error shape** with user-safe, translated messages.

### 3.11 Growth hooks (decide now, build later)
- **i18n, currency, timezones, offline support:**
- **Scale triggers** (don't pre-build):

| When… | Then do… |
|---|---|

### 3.12 Exit / acquisition readiness
- **IP ownership is clear:** collaborator agreements in place, and no employer or client claim (check for ELINDO/client overlap).
- **Clean licences:** no GPL code inside proprietary code, and asset licences recorded.
- **Handover:** the README (P5), transferable accounts, and metrics history.

### 3.13 Incident and sunset plans
- **Incident runbook** for "key leaked", "site down", "data breach" and "bill spike": who does what, in what order.
  - Default order: rotate the key → trip the kill switch → roll back.
  - Keep a template ready for the UU PDP 3×24h breach notice.
- **Sunset plan:** how users export their data, which services get cancelled (no zombie bills), and what happens to the domain.

### 3.14 Risks and open questions
- **Pre-mortem answers** (P3):
- **Top 5 risks,** each with likelihood, impact and mitigation:
- **Open questions,** each with an owner and a "decide by" date:
