---
name: retro
description: Milestone or project retrospective for the master playbook, built from STATUS.md Lessons and LEARNINGS.md. Use when Beeb types /retro, at each milestone end and at project end.
disable-model-invocation: true
---
Read STATUS.md (Lessons, Decisions), LEARNINGS.md, docs/PROJECT.md and the plans in docs/plans/ for this milestone. Then output ONE code block for Beeb to paste into the master playbook chat:

Retrospective — <project> — <milestone> — <date> — kit <version from .claude/kit/VERSION.json>
1. **Start:** how it began, what was planned upfront.
2. **Missed:** things not covered at the start that bit later (tech, security, scope, cost, legal, data, UX).
3. **Wins:** what worked well and should be repeated.
4. **Happy accidents:** unplanned things that turned out good.
5. **Rules for next time:** and who suggested them (Beeb or Claude).
6. **Learned:** skills gained, and the portfolio evidence captured.
7. **Kit friction:** where the workflow, agents or gates got in the way or missed something.

Bullets only, max ~15 lines, each tagged [tech]/[product]/[business]/[process]. Below the block, in ≤3 lines: the time-box result (on time / over by X) and the C4 check — continue, pivot or stop, with your recommendation. Change no files.
