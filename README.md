# Hireframe

Personal job-search engine. Scans UK + startup job sources twice a day, runs each job through a staged AI funnel, and hands over verdicts: **Apply / Near miss / Wildcard / Skip**. CVs are only generated on request.

Single user, private data, public code.

## Docs map
| File | Purpose |
|---|---|
| `CLAUDE.md` | Rules for Claude Code when building this repo. Read first. |
| `docs/PRD.md` | What we're building, why, success metrics, Wave 1 requirements + acceptance criteria |
| `docs/ARCHITECTURE.md` | Stack, components, data model, sources, scheduling, secrets |
| `docs/FUNNEL.md` | Staged filtering logic, scoring rubric, prompts, evals |
| `docs/SECURITY.md` | Threat model and controls |
| `docs/DESIGN.md` | Visual system, layout, screens, quality bar |
| `docs/ROADMAP.md` | Waves 1–4 and Wave 1 build milestones |
| `docs/DECISIONS.md` | Architecture decision records (ADRs) |
| `docs/RUNBOOK.md` | Operating, deploying, and fixing things |
| `CHANGELOG.md` | What shipped, when |

## Status
Wave 1 — M0 (repo + guardrails), M1 (Firebase foundation) and M2 (Profile brain) built; next: M3 Sources. Local setup and Firebase setup: `docs/RUNBOOK.md`.

