---
name: ship
description: Gate, commit, update STATUS.md, push the feature branch and open the PR. Never merges, tags or deploys. Use when Beeb types /ship, or when /build, /milestone or /scope reach their ship step.
disable-model-invocation: true
---
1. Branch: must not be a protected branch. If it is, `git fetch origin` and create `<type>/<slug>` from origin/main first. Base = origin/main, or the stacked parent branch.
2. Gate: `node .claude/kit/gate.mjs --if-changed`. Not all exit=0 → stop and report. Never ship red. "GATE SKIPPED" is fine only when every changed file is docs or config (`*.md`, `docs/**`, `.claude/**`, `.github/**`); otherwise stop: the gate needs real commands first.
3. Diff check: `git diff --stat <base>...HEAD` plus uncommitted changes. Only intended files; no secrets, .env, personal or client data, generated outputs, or stray debug/tuning values. Anything odd → stop and ask.
4. STATUS.md: update Done (one line per change), In progress, Next (top 3), Lessons (new surprises, tagged), Parked ideas, Pending / known; today's date at the top. Keep it ≤ 1 page (move old Lessons and old Decisions to LEARNINGS.md).
5. Commit remaining changes: `git add <files>` then, as a separate command, `git commit -m "<type>: <summary>"`.
6. Push: `git push -u origin <branch>`.
7. PR: write the body to a temp file, then `gh pr create --base <base-branch> --head <branch> --title "<type>: <summary>" --body-file <file>`. If the PR exists, `gh pr edit <branch> --body-file <file>`. Body: What · Why (plan + group) · Differences from plan · Small decisions · Review findings and resolution · How to test (what Beeb clicks) · Gate output (exit codes) · Stacked on (if any).
8. If `gh` isn't available (some cloud sessions), push anyway and give the compare URL: `https://github.com/<owner>/<repo>/compare/<base>...<branch>`.
9. Never merge, tag, release or deploy. Reply (≤5 lines): PR link · gate result · what Beeb should review first.
