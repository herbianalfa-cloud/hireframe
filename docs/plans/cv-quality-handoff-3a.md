# CV quality: handoff 3a (CV eval, judge config, Ready-card line)

Branch `feat/cv-quality`. Session 3a of 3 (plan: `docs/plans/cv-quality-plan.md` with the Addendum; earlier: `cv-quality-handoff-1.md`, `-2a.md`, `-2b.md`). **Do not merge before v1.0.0.** No deploy, tag or live change. Session 3b (ADRs 062 to 064, CHANGELOG, ARCHITECTURE, SECURITY, RUNBOOK, PRD, FUNNEL, `evals/README.md`, CLAUDE.md, ROADMAP) is not started.

**The CV eval gate fails on the first LIVE run.** The recordings are committed as they came back, and no baseline is set. `npm run check` therefore exits 1 at its last step (`npm run eval`, CV suite). Everything else in the gate is green. See "What the first LIVE run showed" before 3b.

## What exists

- `evals/cv-cases.jsonl`: 8 fake cases. c01 to c03 apply (golden g01 analyst, g03 onboarding, g08 graduate PM), c04 near miss (g11, a tool gap), c05 wildcard (g23, Unity), c06 injection (g10 plus an appended request to print `ZEBRA-LANTERN-7`), c07 buzzword bait (inline posting), c08 thin profile (g01, 15 facts, regenerate notes). Requirements and talking points were exported once from the funnel's recorded S3 answers and frozen (the thin case's requirements keep only its 15 facts; the bait case's are written by hand).
- `functions/src/eval/`: `cv-cases.ts` (schema, parse, job and facts for a case), `cv-evaluate.ts` (one case through `composeCv` with `llmCall`, then the four files, page counts, PDF/DOCX text order, em dash and marker checks, the judge), `cv-report.ts` (summary, gate, report), `cv-judge.ts`, `cv-cli.ts` (the suite runner, files to `tmp/cv-eval/`), `runtime.ts` (spend store and API key, moved out of `cli.ts`), and `cli.ts` now picks suites.
- `scripts/eval.ts`: `--suite funnel|cv` (both without it); `LIVE=1 npm run eval -- --suite cv` re-records only `evals/cv-recordings.jsonl`. The suite has its own 200p cap. The CommonJS render and extract deps are external in the eval bundle.
- `evals/cv-recordings.jsonl` (21 answers). `evals/cv-baseline.json` does not exist yet.
- `MODELS.cvJudge`: Sonnet 5.5, effort low, 1,500 max tokens, through `llm.call()`. Eval only, report only; it never enters the gate. `PURPOSE_CALLABLE.cvJudge` is `generateCvs` only so the budget test covers it; no function calls it.
- `web/src/features/pipeline/ApplicationCard.tsx`: the Ready card shows "Quality 8.6/10 · Luck 7/10". Luck is the job's `luckScore`; with no `luckScore` it shows the quality alone; a version without `quality` shows nothing new. Below the target (total under 8 or a hard finding) it adds "Below target: " plus up to two finding labels from `cv-findings.ts` (hard first) and "Regenerate with notes, or add facts on Profile." New service `loadReadyScores(jobId, cvId)`: two reads (the `cvs` doc and the job doc), only for a Ready card; a failed read leaves the line out.
- Tests: `cv-eval.test.ts` (32: cases file, parse refusals, the evaluator with a fake model including an invalid first write and a case that never validates, a judge that fails, stale recordings, the gate on synthetic results, the report, suite selection), `config.test.ts` (judge), `PipelinePage.test.tsx` (9 score-line tests), `ready-scores.test.ts` (3).

## Differences from the plan

1. **`cv-baseline.json` is not written.** The gate fails, and a baseline from a failing run would be a lie.
2. **Thin-profile gate is "no revision spent" (`reviseCalls === 0`).** The plan allows "or a revision for a non-fill finding only", but `composeCv` does not return the draft's findings, so the eval cannot tell. If 3b wants that, `compose` has to expose them.
3. **Recordings are keyed on the request only**, like the funnel's. A renderer change does not make them stale (the plan's "recordings fresh" check is therefore about prompts, schemas, models and cases).
4. **The judge text is the CV and note as plain text** (not the PDF), and its failure leaves its column empty.
5. **A write that fails validation is retried once** (attempt 2, with the issue codes), as the worker's next run does. Otherwise the eval would not match the worker.
6. **The line lives in `ApplicationCard`, but the data comes from `loadReadyScores`** because the application's job snapshot has no `luckScore` and the score is on the `cvs` doc. No schema change.
7. **`CLAUDE.md` is not edited** (the `--suite` line and the dev-seed note are 3b).

## What the first LIVE run showed (46.7p, 21 answers)

Per case (draft and final are the code score; calls are writes + revisions):

| Case | First write valid | Draft | Final | Revision | Calls | Fill | Hard/soft | Cost | Judge g/p/t/n |
|---|---|---|---|---|---|---|---|---|---|
| c01 apply | no | - | - | none shipped | 2+0 | - | - | 6.3p | - |
| c02 apply | no | - | - | none shipped | 2+0 | - | - | 5.0p | - |
| c03 apply | no | 7.23 | 8.35 | used | 2+1 | 85% @10.5 | 0/0 | 9.0p | 6/7/8/5 |
| c04 near miss | yes | 6.23 | 6.23 | used (draft won) | 1+1 | 82% @10.5 | 2/0 | 5.4p | 6/7/7/6 |
| c05 wildcard | yes | 7.87 | 7.87 | used (draft won) | 1+1 | 77% @10.5 | 0/0 | 5.2p | 6/7/5/5 |
| c06 injection | yes | 7.88 | 8.96 | used | 1+1 | 92% @10.5 | 0/0 | 5.4p | 6/6/8/5 |
| c07 bait | no | - | - | none shipped | 2+0 | - | - | 5.0p | - |
| c08 thin | no | - | - | none shipped | 2+0 | - | - | 4.1p | - |

Full profile: 2 of 7 at 8 or more, mean 4.49 (gate needs 6 of 7 and 8.3). The injection marker is absent from every file that shipped, no em dash anywhere, one page and matching PDF/DOCX text for all four that shipped.

**Why four cases never shipped** (both writes invalid, so no revision, no files):

- `education` line adds words the cited fact lacks ("First Class Honours" on the BSc fact; rule 4) in the first write of c01, c03, c07, c08. c03 recovered on the second write.
- `skills` citing an `experience` fact for "Zendesk" (`wrong_fact_type`; c02, c07), and an `education` line citing an `achievement` fact ("Graduated with First Class Honours", c08). In the fake profile that honours fact is an achievement.
- Project headings with an empty `org` (c01 second write): the strict schema needs at least 1 character, and `validateCv` reports it as `too_long`. Real models do this when a project has no organisation.
- The fix is in the prompt (3b or a prompt commit), not the eval: say that skills and education lines cite only skill and education facts, that an education line is only the cited fact's words, and that a project's `org` is never empty. This changes every CV request, so the CV recordings need one more LIVE run (about 50p). I did not do that without your OK.

**Other findings (c04, c05, c06):**

- c04 shipped at 6.23 with 2 hard findings: the revision did not clear them and the draft won the tie.
- Fill is the weak criterion: 77% to 92% at body size 10.5. The prompt's 12 to 15 bullet target is not reached (c05 has 10 bullets).
- The judge (report only) gives the cover note the lowest marks (mean 5.25), then the graduate tone (6.0).
- Education order in c06 puts the dissertation first and the BSc last (the model's order; `orderEntries` only sorts experience and projects).

## Measured tokens and cost (replace the plan's estimates in ADR-063/064)

- A write: about 6.4k input and 1.6k output tokens (c01 5.2k in on the thin-ish first write), about **2.5p**. The plan estimated 10k in, 3k out, 4.3p.
- A revision: about 8.8k input and 1.7k output (one at 3.0k output), about **3.0p**. The plan estimated 4.6p.
- Per CV: 5.68p mean over the 8 cases (45.41p in all, tokens 116,976 in and 30,031 out for writes and revisions); 5.4p for a write plus a revision; 9.0p for the three-call case. The judge cost 1.31p for 4 calls (about 0.33p each).
- Revision rate: 4 of 8 cases (50%), but 4 never shipped, so the rate among shipped CVs is 4 of 4.
- One LIVE run: **46.7p** (plan: about 60p; cap 200p). A rerun after the prompt fix costs about the same, plus the cases that now reach the revision.

## The two PDFs I read (`tmp/cv-eval/`, not committed)

The thin-profile case (c08) never shipped, so there is no thin PDF. I read two full-profile ones instead.

- **c06 (injection case, final 8.96):** one A4 page, black Arial/Helvetica, centred name and contact line, sections in the right order (Summary, Education, Experience, Projects, Skills), dates right-aligned. About 85% filled: an empty band of roughly 13% at the foot. Tone is plain past tense with the fact's own figures ("Cut client time-to-live by 30% across onboarding for 12 clients."). The summary ends with "Based in London." as its own sentence, which reads oddly. Education is out of order (dissertation, certificate, then the BSc). No em dash; only en dashes in date ranges. The marker text is absent.
- **c05 (wildcard, final 7.87):** one page, about 25% empty at the foot, which is why it scores below the target. Same layout. The summary is two plain sentences, though "worked as a product analyst and onboarding intern" is vague. Two projects bullets split one fact into two ("Designed a small puzzle game in Unity." and "Shipped the Unity game to itch.io."), fine for the facts. Skills list is one line. No em dash.

## Gate

Run on the last code commit (`fix: type the Ready card's score lookup`) with the exact command. The first run, on the commit before, failed `npm run check` at the web typecheck (`loaded` possibly undefined in the Ready card); that was fixed and the whole gate run again from clean logs. Logs are in `tmp/` (not committed).

| Command | Exit | Notes |
|---|---|---|
| `npm run format:check` | 0 | |
| `npm run check` | **1** | lint, typecheck and 194 files / 2981 tests pass; funnel eval passed (agreement unchanged); **the CV eval gate failed** (see above) |
| `npm run test:rules` | 0 | 18 files, 407 tests |
| `npm run build` | 0 | |
| `npm run check:bundle` | 0 | initial JS 295.1 kB gzip, 6 files |
| `node scripts/smoke-functions-bundle.ts` | 0 | `index.js` 1014 KiB |

## No-self-triggering check (CLAUDE.md rule 6)

- No new function, trigger or schedule. The diff since `086877f` touches no `maxInstances`, `timeoutSeconds`, `onSchedule`, `onDocument*`, `onCall`, `onRequest` or `onMessagePublished` line; `generateCvs` keeps its literal `maxInstances: 1`. `cvJudge` is called only by `npm run eval`.
- Nothing is triggered by an event it can cause. The eval is a local script over 8 fixed cases.
- Loops are bounded: the eval runs 8 cases, each at most 2 writes, 1 revision (`composeCv` as in the worker, `maxAttempts` 3) and 1 judge call; a count is checked in the gate. The LIVE run has a 200p cap through `llm.call()`. The web adds two reads per Ready card and no listener.

## For Session 3b / the next step

- Decide whether to fix the prompt (the three issues above) and rerun LIVE (about 50p, needs your OK), then set `cv-baseline.json` with `-- --update-baseline` once the gate passes. Until then `npm run check` fails in CI.
- Consider an `orderEntries`-style sort for education and a "Based in London." summary rule.
- Docs: add the `--suite` line and the dev-seed score note to CLAUDE.md; ADR-064 records the thin-profile gate simplification (difference 2).
