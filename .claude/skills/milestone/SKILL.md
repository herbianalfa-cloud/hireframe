---
name: milestone
description: Plan a milestone or feature into a Draft plan, walk Beeb through its decisions, and mark it Approved only when he approves. Use when Beeb types /milestone.
argument-hint: "<milestone or feature, e.g. M1 folder input>"
disable-model-invocation: true
---
1. Preconditions: docs/PROJECT.md and STATUS.md exist (else stop: run `/scope import` first). Run `git fetch origin`.
2. Create branch `feat/<slug>-g1` from `origin/main` (slug from the milestone name, kebab-case).
3. Delegate to `planner` (planning mode) with: the task "$ARGUMENTS" and the paths CLAUDE.md, .claude/kit/WORKFLOW.md, docs/PROJECT.md, STATUS.md, docs/plans/, .claude/kit.config.json.
4. Read the plan file. Check: Allowed files and acceptance criteria per step; a Decisions table; if the gate is empty, the first code step adds real gate commands. If anything is missing, send it back to `planner` once.
5. Save the Draft right away so it survives a closed phone: commit the plan ("docs: draft plan <slug>") and `git push -u origin feat/<slug>-g1`.
6. Show Beeb, in ≤12 lines: goal, PR groups, time-box, manual steps for him.
7. Ask the open decisions with AskUserQuestion (max 4 per call; more calls if needed), recommendation first. Earlier decisions the plan touches: one multi-select "Still OK?" question. Then Noticed (max 3).
8. If tier is `client`, or the plan has a Hard-area step: recommend a second opinion in his chat Project and print a ≤25-line plan summary in one code block for him to paste there. Wait for his result.
9. Apply his answers to the plan. Log each decision in STATUS.md "Decisions" (`YYYY-MM-DD — decision — why — rejected`). Commit and push.
10. AskUserQuestion: "Approve this plan?" — Approve (Recommended, only if nothing is open) · Change something · Stop.
11. On Approve: first line → `Status: Approved (YYYY-MM-DD)`. Commit "docs: approve plan <slug>" and push. Tell Beeb: "Approved. Type /build to start group 1."
