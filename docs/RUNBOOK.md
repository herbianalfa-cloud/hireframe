# Runbook

## One-time setup (user)
1. **GitHub:** create public repo `hireframe`, push this docs pack. Enable secret scanning + push protection, Dependabot, branch protection on `main` (PR required now; add required status checks after M0 CI has run once).
2. **Firebase:** new project → upgrade to Blaze → GCP Billing budget alerts at £5 and £10. Enable Google sign-in.
3. **Anthropic:** create API key at console.anthropic.com, set a monthly spend limit (e.g. £20).
4. **Reed:** free Jobseeker API key. **Adzuna:** free developer app_id + app_key.
5. **Gmail:** create labels `hireframe/alerts` and `hireframe/done`; filters that label job-alert senders (LinkedIn, Wellfound, Work at a Startup, Welcome to the Jungle, Reed, Indeed alerts).
6. **Job alerts:** set up LinkedIn/Wellfound/WaaS/WTTJ alerts for the lane titles in `FUNNEL.md`, UK/London, daily.
7. Secrets go into Secret Manager via `firebase functions:secrets:set` — never pasted into chat or code.

## Building with Claude Code
Open the repo in Claude Code and start with:
> Read CLAUDE.md and every file in docs/. Summarise the plan back to me in 10 lines and list anything ambiguous or risky. Then plan milestone M0 in plan mode. Don't write code until I approve the plan.

Per milestone: "Plan M{n}" → review → approve → build → PR → you test on the preview → merge → tag if release.

## Daily operation
- Morning: read digest (≤ 20 min). Apply to Apply-verdict jobs; 👍/👎 anything that looks wrong.
- Evening run adds more; check Today when convenient.
- Friday: glance at System (source health, spend) and Near misses for criteria tweaks.

## Incidents
| Symptom | Check | Fix |
|---|---|---|
| No digest | System → last run | Re-run with "Scan now"; check Apps Script executions log |
| Source shows red | Run log errors | Endpoint changed or rate-limited → fix module; run continues without it |
| Spend near cap | usage/{month} | Tighten S1 rules or lower S3 per-run cap; raise cap deliberately |
| Verdicts feel wrong | 👎 notes, eval report | Adjust criteria or rubric; add cases to golden set; re-run eval before deploy |
| Bad deploy | — | `firebase hosting:rollback`; redeploy functions from previous tag |
| Suspected key leak | GitHub alert | Rotate key immediately, update Secret Manager, purge from history |

