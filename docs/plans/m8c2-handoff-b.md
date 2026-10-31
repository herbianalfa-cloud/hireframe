# 8C2 session B1 handoff

Branch `feat/m8c2-hardening`, from `main` at 3310a34. Session B2 starts from this file and must keep every K number and title below unchanged.

## Head

- Head before this file: `19ceda7`. This handoff is the commit on top of it; a file cannot hold its own commit SHA.
- B1 commits: `37e09c9` ADR-060 and the ADR-017 and ADR-059 addenda; `23c6f1e` SECURITY checklist and release gates; `d556851` ARCHITECTURE, ROADMAP, CHANGELOG 1.0.0 and the m8c plan; `19ceda7` `.gitignore`.
- The B1 gate result is not recorded here; it runs after this commit.

## K14–K28 numbers and titles (cited by SECURITY and the ADRs)

| Step | Title | Cited as |
|---|---|---|
| K14 | Snapshot `flat` to `~/iam-before-p3.txt`; C43; C48 keys loop; C51 | C48/K14, C43 |
| K15 | Secrets (C34) | C34/K15 |
| K16 | Invoker audit (C49) | C49/K16 |
| K17 | Unused APIs (C32, C33) | C32, C33, K17 |
| K18 | Quotas (C53) | C53/K18 |
| K19 | Release checklist recorded (the five gates) | SECURITY gates |
| K20 | Evidence commit to 8C2; CI green; merge | ADR-059 addendum (live push grant, C38b) |
| K21 | Reads before the change (K1, `flat > ~/iam-before-100.txt`, C43, C51, C39a/b, topic IAM) | K21 |
| K22 | Bucket names (C52) | |
| K23 | Path F grants (C39) | K23–K25 |
| K24 | Remove `roles/editor` from `$COMPUTE`, then straight to K25 (C39) | K23–K25 |
| K25 | Tag v1.0.0, the proving deploy (C4, C50) | ADR-060, K25, C50 |
| K26 | IAM diff against K21's file | K26 |
| K27 | Live checks (K1, C51, C39a/b, C49, C14 table, C35, topic IAM read) | K27, C35 |
| K28 | Within 24 h; C41 `gcloud auth revoke`; follow-up docs PR | K28, C41 |

SECURITY marks the post-deploy items "pending K25–K28".

## Recovery entry titles (cited by ADR-059 and SECURITY)

- "Billing was disabled" (ADR-059 consequences; check `billingEnabled` and `billing_guard.*` logs first, relink with `gcloud billing projects link`, then C3, a Scan now and a backup check, ADR-058)
- "Project suspended (card declined)"
- "Rollback the Editor removal" (C40: the add command, wait 2 minutes, **Re-run failed jobs**; the per-bucket `objectViewer` variant if a build log shows 403 on `gcf-v2-*`)
- "First Pub/Sub function: the CLI's IAM step" (the K6/K9 pattern generalised)

Also for B2: the "Every release" subsection (window, nothing Generating, step 77 before and after, invokers by type, the C3 list, indexes Enabled, C14 on new functions, step 89 and step 97, a proving deploy needs a bundle change, deploy time inside the job timeout), and retitling Part K to cover 8C2 and v1.0.0.

## PR body draft (draft PR, opened by B2)

> **Do not merge before v0.9.1 is tagged; merge only at RUNBOOK K20.** Merging deploys nothing, because deploys run only on tags.
>
> ## Summary
> - Literal `maxInstances: 1` and an explicit timeout on all 14 functions, enforced by a table test and a source scan.
> - The three copies of the stale-lock rule become `lockLiveUntil` and `isLockLive` (8C1 review #12).
> - ADR-060 (Path F: the compute account becomes build-only), the ADR-017 and ADR-059 addenda, the SECURITY checklist before v1.0.0 with the five release gates, RUNBOOK K14–K28, the "Every release" checklist and four Recovery entries.
>
> ## No-self-triggering check (CLAUDE.md step 6)
> - No new function and no trigger changed.
> - The lock refactor adds no loop, external call or write.
> - `maxInstances` is now literal on all 14.
> - No function reschedules or re-enqueues itself.
>
> ## Bundle changed (`functions/deploy/index.js` sha256)
> | Build | sha256 |
> |---|---|
> | `main` (3310a34) | `d127d6d068d96f6512c49b9ba8dfe78f52771f031594ef9de5db2455a1384f76` |
> | branch (1680d2e, last code commit) | `764215d5595f868cd433f1c5e6bc1c9f6a7697b8114619f0e1431590248fe7dd` |
>
> They differ, so v1.0.0 rebuilds every function.
>
> ## Gate
> (paste B2's gate output)
>
> 🤖 Generated with [Claude Code](https://claude.com/claude-code)

No `gh api` writes. No personal details.

## Left open

- SECURITY items other than the five ticked (C30, audit allowlist, wipe tests, `maxInstances` test, no self-triggering) stay unticked; the ones needing the v1.0.0 deploy say "pending K25–K28".
- ADR-059's live push-delivery grant, C38b and the v0.9.1 deploy time are not known yet. K20's evidence commit records them in ADR-059 and SECURITY, and raises `timeout-minutes` in `.github/workflows/deploy.yml` (20 today) if the deploy took more than 12 minutes.
- Handoff A, difference 2: `scheduledScan`'s timeout comes from `CALLABLE_TIMEOUT_SECONDS.scanNow`. Noted in the ADR-017 addendum and the CHANGELOG.
- RUNBOOK is untouched by B1, so its closing line "K14 onwards … belong to PR 8C2" still stands until B2.
- No deploy, tag, gcloud command, `gh api` write or IAM change. `BILLING_GUARD_MODE` is unset. No PR yet.
