---
name: build
description: Build the next PR group of an Approved plan - delegate steps, run the gate, review, fix, open a PR, then stop at a checkpoint. Use when Beeb types /build (again after each checkpoint).
argument-hint: "[plan path]"
disable-model-invocation: true
---
You orchestrate. Delegate the work; keep your own context small.

0. Sync: `git fetch origin`. If package.json exists and node_modules doesn't, run `npm ci`.
1. Find the plan: "$ARGUMENTS" if given; else the newest file in docs/plans/ with unticked steps on the current branch or origin/main; else on the newest remote branch `origin/feat/*-g*` (read it with `git show <branch>:<path>`). It must say `Status: Approved`, else stop and say so.
2. Group N = the first PR group with unticked steps. Previous group's branch = `feat/<slug>-g<N-1>` (none for N=1).
   - Previous PR merged? `gh pr view <prev-branch> --json state -q .state`. If `gh` isn't available, AskUserQuestion: "Is the group N-1 PR merged?" (Yes / No). Don't guess from git history (squash merges hide it).
   - N=1, or previous merged: switch to `feat/<slug>-g<N>`, creating it from `origin/main` if needed.
   - The branch already exists stacked on a parent that has since been squash-merged: `git rebase --onto origin/main origin/<prev-branch>`, then `git push --force-with-lease origin feat/<slug>-g<N>` (Beeb approves the prompt), then `gh pr edit feat/<slug>-g<N> --base main`.
   - Previous not merged: create `feat/<slug>-g<N>` from `origin/<prev-branch>` (stacked; note it for the PR body).
3. For each unticked step in the group, in order:
   - Routine step (docs, copy, fixtures, formatting) → `chores`. Anything else → `builder`. Pass: plan path, step text, Allowed files.
   - Agent reports a failure → send the output to `planner` (diagnosis mode), then call `builder` ONCE more with the diagnosis and the words "no own retry". Still failing → stop and AskUserQuestion: try a new approach (Recommended if the diagnosis has one) · change the plan · stop.
   - Agent reports a big decision, a bigger-than-planned step, a broken assumption or a budget problem → AskUserQuestion (recommendation first). Wait.
4. Gate: `node .claude/kit/gate.mjs` must pass.
5. Review: `reviewer-deep` if any step in the group is a Hard area or tier is client; else `reviewer`. Pass plan path, group, base ref (origin/main, or the stacked parent).
   - High/Medium with a clear fix → `builder`. Low/Nit → `chores` if trivial, else list in the PR.
   - "Decision needed" findings → AskUserQuestion.
   - Then ONE re-review of the new commits only. Anything left goes into the PR body.
6. Ship: read and follow .claude/skills/ship/SKILL.md.
7. Checkpoint (always stop here). Tell Beeb in ≤10 lines: PR link · what he can now see or click and how to try it · manual steps for him · Noticed (max 3). Then AskUserQuestion "Group N shipped. Next?" — "I'll review and merge, then type /build" (Recommended) · "Build the next group now, stacked" · "Change something" · "Stop here". If he picks "now", go back to step 2.
8. All groups done: say the milestone is complete, recommend `/retro`, and suggest a new session for the next milestone.
