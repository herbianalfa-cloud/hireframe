---
name: kit-review
description: Periodic review of the kit and playbook against current Claude Code features, models and plans. Use when Beeb types /kit-review (every 1-2 months, or when the SessionStart message says it is due, or after a major model or Claude Code release).
disable-model-invocation: true
---
Goal: keep the kit current without churn. Change nothing until Beeb approves.

1. Read .claude/kit/VERSION.json, .claude/kit/WORKFLOW.md, .claude/agents/*.md, .claude/skills/*/SKILL.md, .claude/settings.json and, if present, PLAYBOOK.md.
2. Research what changed since the kit date, using official sources only (code.claude.com docs and changelog, anthropic.com news, support.claude.com): models and their best use, effort levels, plan limits, subagent/skill/hook/settings fields, permission modes, Remote Control, cloud sessions, mobile, review commands, renamed or removed features.
3. Produce a numbered list of proposed changes. Each: what · why (with source link) · file(s) · risk · your recommendation. Include "no change needed" areas briefly so Beeb knows they were checked.
4. Ask with AskUserQuestion which to apply (recommendation first; batch into ≤4 questions).
5. Apply approved changes only in the master: the `playbook` repo (`kit/` and PLAYBOOK.md). If this session is in a project repo, write the approved change list as one code block for Beeb to run in the playbook repo instead.
6. In the master: bump `kit/files/.claude/kit/VERSION.json` (version, date, reviewBy = date + 2 months), add a PLAYBOOK changelog line, ship a PR.
7. Tell Beeb to update each project after merging: `node <path-to-playbook>/kit/install.mjs <repo>`.
