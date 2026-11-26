# Kit workflow (Playbook Part 5 — operative copy for Claude Code)

Beeb scopes in his claude.ai Project chat. Claude Code plans, builds, reviews and ships. Beeb decides, reviews PRs and merges. Beeb often works from his phone: keep messages short and put decisions in AskUserQuestion.

**Session check:** the session must start with a `[kit x.y.z]` line. If it is missing, or says GUARD NOT ACTIVE, tell Beeb before any git work.

## Gates — never skip, never self-approve
1. **Kickoff** (chat) → `/scope import` writes docs/PROJECT.md, CLAUDE.md, STATUS.md. No PROJECT.md → no `/milestone`.
2. **Plan** (`/milestone`): plan file starts `Status: Draft`. Only Beeb approves.
3. **Approve**: set `Status: Approved (YYYY-MM-DD)` only after Beeb explicitly approves that plan in this session.
4. **Build** (`/build`): one PR group per run, then a **checkpoint**. After a checkpoint Beeb types `/build` again.
5. **Merge, tag, deploy, release**: Beeb only. Never merge a PR, push a tag, or deploy.

## Big decisions → ask Beeb
Anything Beeb would notice or that is hard to undo: features and scope; UI/UX, layout, copy; data model, file formats, architecture, folder structure; new dependencies or services; anything that costs money; security, privacy, caps; any deviation from the approved plan; a step bigger than planned.
- Earlier decisions (STATUS.md "Decisions") that the current plan or step touches: re-confirm them in ONE multi-select question ("Still OK?"), saying for each whether anything learned since changes it. Don't re-ask decisions the work doesn't touch.
- Small decisions (internal names, refactors inside one file, test structure): decide, then list them in the PR body.

## How to ask
- Use the AskUserQuestion tool (it reaches Beeb's phone). Max 4 questions per call, 2–4 options each.
- Recommendation first, labelled "(Recommended)", with the why and the trade-off in its description.
- Group related questions. Never ask what the repo, the docs or a quick check can answer.
- After the questions, add **Noticed** (max 3): better options, risks, simplifications, things to cut, ideas found while working.

## Ideas, changes of mind, spikes
- New ideas → STATUS.md "Parked ideas" (one line). Never build them without approval.
- Beeb changes a decision → first list what it affects (files, plan steps, earlier decisions, cost, time-box), then wait for go. Log it in STATUS.md "Decisions".
- `spike/*` branches only when Beeb asks: time-box ≤2h, rules relaxed, never merged. A working spike becomes a proper plan step.

## Building rules
- Change only the step's **Allowed files**. The plan file and STATUS.md are always allowed. Tests first for pure logic. Files ≤ ~300 lines.
- One failed fix → stop. The orchestrator gets a diagnosis from `planner` and allows ONE more attempt. Still failing → stop and ask Beeb.
- A failing budget (bundle size, cost, eval score, performance bar) is Beeb's decision. Never relax a budget, threshold, cap or test to get green.
- Restore any temporary tuning or debug values before committing. Run `git diff --stat` before every review.
- Never put secrets in files, prompts, logs or commits. Never read real `.env` files. Dev uses mocked or seeded data, never real personal data.
- Run `git add` and `git commit` as separate commands (the guard scans what is staged).

## Gate
`node .claude/kit/gate.mjs` runs the commands in `.claude/kit.config.json` → `gate` and prints each exit code (summary mode; `--verbose` for full output; `--if-changed` reuses a pass when nothing changed). All must be 0 before review and before ship. CI runs the same gate.
- Empty gate: docs-only changes may ship. The first code step of the first milestone must add real gate commands (test, typecheck/lint, build) and make them pass.

## Branches and PRs
- Never commit to or push `main`. Run `git fetch origin` before branching. Branch `<type>/<slug>-g<N>` (feat, fix, chore, docs, refactor). Conventional Commits, small.
- New group branches from `origin/main` when the previous group is merged; otherwise it stacks on the previous group's branch (say so in the PR body).
- PR body (`gh pr create --body-file`): What · Why (plan + group) · Differences from plan · Small decisions · Review findings and resolution · How to test (what Beeb can click) · Gate output · Stacked on.

## Review
Before every PR: `reviewer` (or `reviewer-deep` for Hard areas or client tier). Fix every High/Medium finding that has a clear fix. A finding that needs a choice → ask Beeb. One re-review of the new commits only, then ship.

## STATUS.md (the handoff; keep ≤ 1 page)
Sections: Decisions · Done · Lessons · In progress · Next · Parked ideas · Pending / known · Working rules. Update it in every PR. Lessons are one line each, tagged [tech]/[product]/[business]/[process]. Over one page → move old Lessons and superseded or old Decisions to LEARNINGS.md (append; never delete).

## Usage
Subagents keep the main context small: delegate building and reviewing. Use the gate's summary mode. Suggest a new session per milestone. Batch paid live runs; mock by default.

## Kit review
When the SessionStart message says the kit review is due, tell Beeb once, in one line: "Kit review due — run /kit-review."
