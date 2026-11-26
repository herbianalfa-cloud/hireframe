---
name: scope
description: Import the kickoff output from Beeb's claude.ai Project chat into the repo (/scope import), or scope a small feature mid-project (/scope <topic>). No code. Use when Beeb types /scope.
argument-hint: "import | <feature or topic>"
disable-model-invocation: true
---
No code, no plans, no installs in this skill. Read CLAUDE.md, .claude/kit/WORKFLOW.md, docs/PROJECT.md, STATUS.md and .claude/kit.config.json if they exist. Run `git fetch origin` first.

## `/scope import` (after a kickoff in chat)
1. The chat's kickoff output is ONE block with `===== <path> =====` separator lines (docs/PROJECT.md, CLAUDE.md, STATUS.md). If it isn't in Beeb's message, ask him to paste it.
2. Split it and write the files:
   - docs/PROJECT.md and STATUS.md as given. Add the versions from .claude/kit/VERSION.json ("Playbook <playbook> · Kit <version>") to both.
   - CLAUDE.md: use the pasted content, but keep the current `## Kit` section exactly as it is. Keep CLAUDE.md under 100 lines.
3. Fill `.claude/kit.config.json`:
   - `tier`: toy | portfolio | client (PROJECT.md 3.1).
   - `gate`: only fast offline commands whose scripts already exist (check package.json or the project's build files). If nothing exists yet, leave it empty: the first plan step adds it. Emulator-only, live or paid checks go in CLAUDE.md "Extra checks" with when to run them.
   - `protectedBranches`: ["main"] unless the project uses another default branch.
4. Fill `.claude/settings.json` permissions for this project's own commands, merging with what is there: `allow` dev/test/gate commands; `ask` anything that deploys, publishes, costs money or changes cloud accounts; `deny` reading this project's secret files.
5. Not a Node/npm project (Unity, pnpm, yarn, Python…)? Adapt `.github/workflows/gate.yml` (setup and install steps) and `.github/dependabot.yml` (ecosystem) to it, or delete them if CI can't run the gate (say why).
6. Check PROJECT.md against `.claude/kit/KICKOFF-SHEET.md`: every section filled or "N/A because…". Blank items are gaps.
7. Ask Beeb about gaps and any conflict between the pasted files and the repo with AskUserQuestion (recommendation first). Add Noticed (max 3).
8. After his answers: show a 10-line summary. Create branch `docs/kickoff` from origin/main, commit, and follow .claude/skills/ship/SKILL.md to open the PR.

## `/scope <topic>` (small feature or change mid-project, e.g. from the phone)
1. Reflect back what you understood (3 lines). If it is big (new milestone, new users, new paid service, scope change), recommend taking it to the chat Project instead.
2. Ask in rounds with AskUserQuestion, recommendation first. Add Noticed after each round.
3. Continue until Beeb says the scope is done. Then update docs/PROJECT.md (scope, milestones) and STATUS.md (Decisions, Parked ideas), summarise in 10 lines, and commit on branch `docs/scope-<slug>` from origin/main with a PR via .claude/skills/ship/SKILL.md.
