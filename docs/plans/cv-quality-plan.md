# CV quality plan

Branch `feat/cv-quality` (from `main` at `3310a34`). **Merges only after v1.0.0.** No deploy, no tag and no live change from this work. The PR stays a draft until v1.0.0 is tagged.

**Decisions taken in planning:** below 8/10 after the limit → ship the best valid version and show its score; **one** revision round; the CV eval gets a **report-only** model judge; section order **Summary, Education, Experience, Projects, Skills**.

## Context

v0.7.3 makes safe CVs: every claim cites a fact, and `validateCv` gates them. But the CVs read poorly. The ROADMAP item (line 21) names four goals: a filled, formal one-page layout; writing rules; a self-score with revision; and a CV eval. This plan bases each fix on what the code does today.

### What is wrong today, and why (from the code)

**Layout (`functions/src/cv/render/`)**
1. **Nothing fills the page.** `fitOnePage` (`fit.ts`) only removes content while the PDF is over one page. When the model writes less than a page, the rest stays blank. From `STYLES` in `layout.ts`, the dev seed's Ready CV is about 306 pt of 757 pt usable, so about 60% of the page is an empty band. That CV comes from `fakeCvWrite`: 1 entry, 3 bullets, 1 project, 1 education line and 8 skills. A real model is told "Fewer, stronger bullets beat many" (rule 8), with no length target, so it underfills too.
2. **Overflow trimming guts Experience first.** `trimOrder` (`shared/cv.ts:812`) cuts every experience entry down to one bullet before it touches projects. Then it removes whole projects, which can leave a band of 60–100 pt in one step. The limits allow up to 35 bullets (4×5 + 3×5), while the page holds about 13 two-line bullets once the other sections are in. So a full model output is always trimmed, and trimmed in the wrong order.
3. **Entry order is the model's.** The prompt says "Put the most relevant facts for this job first", and no code sorts entries by date. Experience can come out of reverse-chronological order.
4. **Visual weight is flat and heavy.** `"role, org"` is a single bold run. Education lines use the `entry` style (10.5 pt bold), so they look like job titles. There is no regular-weight org, and the header is left-aligned at body rhythm.
5. **The DOCX can drift from the PDF.**
   - The `docx` library's default `Title`/`Heading1`/`Heading2` styles are blue (`2E74B5`) at 28/16/13 pt. Our runs override colour and size, but the style definitions stay blue, so Word's style pane and any edit by the owner go blue.
   - The PDF wraps at the full width. Word has no slack, so one extra wrap in Word makes page 2.
   - The PDF draws an entry's dates on the title's *first* line. Word puts tab+dates after the title's *last* word, so a long title can cost Word an extra line.

**Writing (`functions/src/applications/prompt.ts`)**
6. **There are no style rules at all.** The prompt says nothing about em dashes, "not X, it's Y" contrasts, buzzwords, verb-first bullets, bullet length, first person or tone. Rules 1–8 only cover citation and validation. So the model falls back on its default register, with em dashes, contrasts and inflated verbs, and no code catches any of it. `validateCv` checks prose for figures and contact details only (ADR-054, "accepted risks").
7. **The prompt hides the tailoring signal.** `requirementLine` prints `level (type, match): text` but drops the S3 `factIds` that matched each requirement. The model has to rediscover which facts meet which requirement.
8. **Nothing measures quality.** No score is computed, nothing is revised, and nothing is evaluated (M7 plan, Risks: "There is no eval for CV writing").

**Not yet compared with Beeb's own list.** ROADMAP line 21 expects "Beeb's list of what is wrong with the v0.7.3 CV" (see Open questions).

---

## Design

### 1. Layout: measured fit-and-fill (code only, no model call)

- **Sizes and order.** `layout.ts` becomes a function of a `LayoutSpec` (body size, leading, gaps) instead of fixed `STYLES`.
  - Section order is `SECTION_ORDER`: Summary, Education, Experience, Projects, Skills.
  - `orderEntries(content, dateOf)` sorts experience, projects and education newest first, by the cited heading fact's end date (no end date counts as Present). Ties keep the model's order. It runs before the trim. The model still orders bullets within an entry.
- **`trimOrder` v2** (`shared/cv.ts`). It removes the last bullet of whichever entry, Experience or Projects, has the most bullets. Experience entries keep at least 2 bullets and projects at least 1. Then it removes the oldest project, then skills beyond 10, then the summary. Headings and education are never removed (as ADR-054). It stays deterministic and table-tested.
- **`fitPage` replaces `fitOnePage`.** It measures with the font metrics once and renders the PDF once at the end. Today every step is a full PDF render.
  1. For `trimmed = 0..n`, try body sizes `[10.5, 10]` and take the first that is one page. Fewer cuts win over a bigger font.
  2. **Fill.** Spread the leftover height over the section gaps, entry gaps and bullet gaps (each at most ×1.6) and the leading (at most +6%). Keep a 6 pt reserve and confirm one page, with at most 8 halving steps.
  3. All spacing is rounded to 1/20 pt (twips) *before* the PDF layout, so the PDF and the DOCX use identical numbers.
  4. Return `{ content, trimmed, spec, fill, bytes, lines }`. `fill` is the used height ÷ the usable height after spreading.
- **PDF never wraps later than Word.** The PDF wraps bullets and text at `CONTENT_WIDTH − 1.5%`, and the DOCX keeps the full width. Arial and Helvetica have the same advance widths, so Word fits at least as many words per line. An entry's dates go on the title's **last** line, which is how Word places a right tab. If they don't fit there, they go on a line of their own, right-aligned. A heading whose role, org and dates don't fit on one line is a score finding (`heading_wraps`): the validator allows shortening, so the revision can fix it.
- **Formal monochrome.**
  - Black only. Helvetica/Arial regular and bold. 0.5 pt black rules under section headings, which are in bold capitals.
  - Name 18 pt and the contact line centred.
  - Entry line: **role** bold, org regular, on one line. `Block` gains `runs: {text, bold}[]`, and `wrapText` measures mixed runs.
  - Education lines are regular weight with right-aligned dates. Skills are one paragraph.
  - Left-aligned ragged text, never justified.
- **DOCX parity.**
  - Override the library's `title`/`heading1`/`heading2` styles: black, Arial, our sizes, `keepNext`.
  - Two runs for role and org. The same `LayoutSpec` numbers in twips.
  - Still no tables, text boxes, images, headers or footers.

### 2. Writing rules: pure lint, plus one deterministic fix

**New pure modules:**
- `packages/shared/src/cv-lint.ts`: `lintCv(content, facts, aliases) → Finding[]`.
- `packages/shared/src/cv-findings.ts`: finding codes and labels in words. It is small, so the lazy Pipeline chunk can import it without pulling in the regexes.

A finding is `{ code, path, severity: 'hard' | 'soft', fixable }`. It never contains the text it found, so findings are safe to log and to send back to the model, as the existing issue codes are.

**What code enforces:**
- **Dashes, fixed in code:** `scrubDashes(content)` runs right after `normaliseCvText` on every model output, before `validateCv`, so what is validated is what ships.
  - A spaced em/en dash becomes `, `; an unspaced one between words becomes `-`; duplicate punctuation is collapsed.
  - Skill labels split on both forms, so the parts are unchanged. Figures are unchanged.
  - It counts what it replaced (`dashesReplaced`, stored).
  - Code-made date ranges keep their en dash (see Open questions).
- **Hard lint findings** (each costs 1 point, and caps the total below 8):
  - `contrast_pattern`: "not (just) X, but/it's Y", "isn't about X, it's about Y", "it's not X. It's Y", "not only … but also", "less X, more Y". These are regex tables with positive and negative examples.
  - `buzzword_stack`: 2 or more listed buzzwords in one sentence, or a chain of 3 adjectives.
  - `inflated_claim`: a leadership, seniority or superlative word (spearheaded, pioneered, orchestrated, architected, championed, expert, seasoned, world-class, extensive, strategic, led/managed/oversaw…) **unless a cited fact has the same stem**. So "Led onboarding for 12 clients" passes on its fact.
  - `cliche`: "passionate about", "proven track record", "results-driven", "team player", "fast-paced environment", "hit the ground running", "I am writing to apply".
- **Soft lint findings** (each costs 0.25): a single buzzword not in a cited fact; intensifier adverbs (successfully, effectively, significantly…); weak openers (Responsible for, Worked on, Tasked with, Helped to); first person in the CV (allowed in the note); a sentence over 30 words; an exclamation mark; a greeting or sign-off written into the note (code adds those).

**Prompt v2** (`prompt.ts`, `CV_PROMPT_VERSION` bumped):
- A **voice** section: write as a recent graduate describing their own work plainly. Start bullets with a plain past-tense verb (present tense for a current role). One idea per bullet, 10–25 words, at most 2 lines. Use the fact's real figure. The banned patterns above are listed, each with one short bad/good pair written on placeholder text, not fake facts.
- A **length target from code**: `CV_BULLET_BUDGET`, about 12–15 bullets and about 1,700 characters of bullets in total. It comes from `LayoutSpec`, and a test pins that the budget fills at least 90% of a page and fits.
- **Requirement fact mapping:** `requirementLine` adds `(facts: F3, F7)`, mapping S3's `factIds` to the current aliases and dropping unknown ones. This stays inside `<job_analysis>`, which is untrusted.
- A cover note section: 180–250 words in the first person, naming one or two of the job's requirements and the facts that meet them.
- The citation rules 1–7 are unchanged. Rule 8 ("fewer, stronger bullets") is replaced by the length target.

### 3. Self-score with one revision round

**Scoring is code only in production.** It is deterministic and free, replayable, and injected text can't argue with it. A model judge runs only in the eval, report-only (§4).

`scoreCv(input) → { total, criteria, findings, gatePassed }` (`packages/shared/src/cv-score.ts`, pure). Its inputs are the content, facts, aliases, the job's requirements, the company name and the layout metrics (`fill`, lines per bullet, heading wraps) from `fitPage`.

**Rubric v1 (`CV_RUBRIC_VERSION = 'rubric-v1'`):**

| # | Criterion | Weight | How code scores it |
|---|---|---|---|
| 1 | Page fill | 2.0 | Empty band b = 1 − fill after spreading: 2.0 at b ≤ 3%, 0 at b ≥ 25%, linear between. A heading wrap costs −0.25 each |
| 2 | Writing rules | 2.5 | Start at 2.5; −1.0 per hard finding, −0.25 per soft finding, floor 0 (CV and cover note) |
| 3 | Real numbers | 1.0 | Of the bullets citing a fact that has a figure, the share that use one of its figures (1.0 if there are none) |
| 4 | Tailoring | 2.0 | Weighted coverage of the job's coverable requirements (must = 2, nice = 1, logistics out; covered = the CV cites one of the requirement's `factIds`). Full marks at ≥ 80% |
| 5 | Bullet craft | 1.5 | 0.5 × share of verb-first bullets; 0.5 × share of bullets 8–28 words and ≤ 2 rendered lines; 0.5 − 0.25 per opening verb used more than twice |
| 6 | Structure and note | 1.0 | 0.25 each: a summary of 1–2 sentences and ≤ 3 lines; the newest experience entry has ≥ 2 bullets and no entry has 0; 6–14 skills; a note of 150–250 words that names the company and has no cliché opener |

**What counts as 8/10:** `total ≥ 8.0` **and** no hard finding (a hard finding caps the total at 7.5). For example, 95% fill, one soft finding, all figures used, 80% coverage and clean craft come to about 9.6. A 25% empty band alone takes the most a CV can score down to 8.0.

**The loop** (a new pure core, `functions/src/applications/compose.ts`, which both the worker and the eval use):
1. **Write.** This is the existing path. An invalid write still goes to the existing next-run retry with issue codes, at most 2 writes.
2. On a valid draft: `orderEntries` → `fitPage` → `lintCv` → `scoreCv`.
3. **Revise only if** all of these hold: the score is below 8 or there is a hard finding; at least one finding is `fixable`; an attempt is left; it is the run's first revision for this job; and the run is still before `workerStartDeadlineMs`.
   - Underfill counts as fixable only when ≥ 2 unused bullet-type facts exist. A thin profile never pays for a revision it can't use.
4. **Revision call:** purpose `cvRevise`, the same system prompt, and a user message with `<job_posting>`, `<job_analysis>`, the draft JSON in a new untrusted `<draft_cv>` tag (it is model output derived from untrusted input), and code-made findings (path + code + fixed guidance, the measured fill, and the aliases of unused relevant facts). It returns the full `CvContentShapeSchema`.
5. **Re-read the facts and re-validate both candidates** against them (a fact archived during the revision invalidates the draft too). Fit and score the revision, then ship the best valid one, ranked by fewest hard findings, then the higher score. An invalid revision is dropped and the draft ships. **A revision can never add an uncited claim**, because nothing ships without passing `validateCv` on the final text.
6. **A failed revision call ships the draft:**
   - a cap or daily cap: ship the draft, then stop the run, as now;
   - an API error: ship the draft, then stop the run;
   - a refusal, invalid JSON or `max_tokens`: ship the draft.
   The reason is recorded in `revisionSkipped`.

**The attempt rule holds.** Every model call, revision included, is preceded by the `planAttempt` precondition transaction.
- `APPLICATION_LIMITS`: `maxWrites: 2`, `maxRevisions: 1`, `maxAttempts: 3`.
- `invalid()` blocks once `attempt ≥ maxWrites`.
- A job costs **at most 3 model calls per owner move, kills included**. Kill cases are table-tested: a kill during a revision leaves `attempt = 2`, the next run writes at attempt 3 and ships without a revision, and a fourth call never happens.
- `ApplicationSchema.attempt` goes from `0..2` to `0..3`, which is backward-compatible.

**Stored:** `CvDocSchema.quality?` (optional, so old docs parse) holds `{ rubric, total, criteria{6}, findings ≤ 20 (code, path), revised, revisionSkipped?: 'deadline'|'cap'|'error'|'output'|'not_fixable'|'attempts', draftTotal?, dashesReplaced, layout: { bodySize, fill } }`.

**Web:** the Ready card (`features/pipeline/ApplicationCard.tsx`) shows "Quality 8.6/10". Below the gate it says "Below target:" with the top two findings in words from `cv-findings.ts`, and suggests Regenerate or adding facts.

**Config** (`functions/src/config.ts`):
- `MODELS.cvRevise` is Sonnet 5.5, effort medium, 8,000 max tokens, 150 s timeout, 300 s budget, and `PURPOSE_CALLABLE.cvRevise = 'generateCvs'`, so the existing budget tests cover it.
- `APPLICATIONS.scoreTarget: 8`.
- The `generateCvs` and `application` options are **unchanged**: literal `maxInstances: 1`, `timeoutSeconds`, and their EXPECTED rows (PR #41) stay the same.
- The deadline arithmetic is unchanged: a revision is a call, and no call starts after 210 s.

### 4. CV eval on the fake candidate

- **Fixtures** (fake only):
  - `evals/cv-cases.jsonl`: 8 cases. Each has a posting reference into `golden.jsonl` (or an inline fake posting), frozen S3 `requirements` (with `fact-NN` IDs) and `talkingPoints`, optional `notes`, and tags.
  - The candidate is `EVAL_FACTS` (Alex Example's 63 facts) and the fake header is `FAKE_HEADER`, which is `example.com`.
  - The cases:
    - 3 apply cases across the lanes;
    - 1 near miss (a tool gap);
    - 1 wildcard;
    - 1 **injection** posting (from the golden injection cases, with a marker string);
    - 1 **buzzword-bait** posting (a new fake one: "rockstar… passionate…");
    - 1 **thin profile**: 15 facts, which must not spend a revision on underfill it can't fix. It also carries regenerate notes.
  - Requirements are exported once from the funnel's recorded S3 answers (where they exist) and then frozen, so the two evals don't stay coupled. The bait case's requirements are written by hand.
- **Runner:** `functions/src/eval/cv-*.ts` uses `compose.ts` (the worker's real path) with `llmCall` and the existing `replayTransport`/`recordingTransport`.
  - Recordings go in `evals/cv-recordings.jsonl` and the baseline in `evals/cv-baseline.json`.
  - `npm run eval` runs both suites; `-- --suite funnel|cv` runs one.
  - `LIVE=1 npm run eval -- --suite cv` re-records only the CV suite, so a CV prompt change doesn't cost the funnel's ~40p.
  - The rendered PDFs and DOCX files are written to `tmp/cv-eval/` (gitignored) for reading by eye.
- **Metrics per case:**
  - valid on the first write; calls and cost;
  - draft and final score, and per criterion;
  - hard and soft findings by code; dashes replaced;
  - fill and body size; trimmed steps;
  - whether a revision was used, and why it was skipped;
  - requirement coverage;
  - whether the PDF and DOCX text match (unpdf vs mammoth);
  - the judge's scores.
- **Gate** (replay, inside `npm run check`):
  - recordings fresh, or "recordings stale";
  - every case valid, a one-page PDF, DOCX text equal to the PDF text in order, no hard finding in the final, no em dash, and the injection marker absent;
  - at least 6 of the 7 full-profile cases ≥ 8.0, a mean ≥ 8.3, and the mean not below `cv-baseline.json` − 0.2;
  - the thin-profile case has `revisionSkipped: 'not_fixable'` (or a revision for a non-fill finding only);
  - every case ≤ 3 calls.
- **Judge, report-only:** purpose `cvJudge`, used only in the eval. It is Sonnet 5.5, effort low, through `llm.call()`, scoring on four subjective items (sounds like a graduate, plain and specific, tailored, cover note specific). Its answers are recorded and replayed, and its numbers are printed beside the code score. It is promoted to a gate only after two LIVE runs agree.

---

## Cost

Sonnet 5.5 at $2/$10 per MTok, FX 0.85 (ADR-053's basis). A write is about 10k tokens in and 3k out. A revision is about 12k in (the draft adds about 2k) and 3k out. **These are estimates. Session 3's LIVE eval replaces them with measured tokens, and the ADR records the measured numbers.**

| | Before (v0.7.3) | After |
|---|---|---|
| Typical CV | 4.3p (one write) | 4.3p + r × 4.6p: **6.6p at a 50% revision rate**, 8.9p if every CV revises |
| Worst-case reservation per call | 8.8p | write 8.8p, revision 9.1p |
| **Worst case per Start, Retry or Regenerate** | 17.7p (2 calls) | **26.8p** (write + retry + revision) |
| Worst-case moves under 60p/day | 3 | **2** (a third write needs 8.8p of room at 53.6p) |
| Typical CVs under 60p/day | ~13 | ~6 (always revising) to ~8 (50%) |
| Monthly at 10 CVs/week (~43) | ~£1.83 | **~£2.82** (50%) to £3.80 (100%) |

- **Against the £15 default cap (1500p):** CV spend goes from about 12% to 19–25% of the cap. The 25% manual share (375p) is also used by Lookup (25p/day cap) and alerts. In a heavy month the daily caps together can pass that share, as ADR-053 already accepts; the monthly cap still holds in `llm.call()`, and the 80% digest warning shows it.
- **What keeps the cost down, code before calls:**
  - dashes, fill (size and spacing), trimming and entry order are all fixed in code;
  - a revision runs only below 8 and only for a fixable finding;
  - prompt v2 aims to keep the revision rate at or below 40%, and the eval measures it;
  - a revision refused by a cap ships the valid draft instead of blocking.
- **Parked:** prompt caching of the shared system prompt (saves about 0.3p per revised CV) and patch-style revisions.
- **One LIVE CV eval run:** 8 × (4.3 + r × 4.6) + 8 × ~1.0p for the judge comes to **about 60p** at r = 0.5 (about 79p at r = 1). The worst-case reservation bound is about 160p, and the suite has its own **200p** cap (the funnel suite keeps 150p).

---

## Files and tests

| File | Change | Tests |
|---|---|---|
| `functions/src/cv/render/layout.ts` | `LayoutSpec`, mixed runs, `SECTION_ORDER`, centred header, dates on the last line, narrower PDF wrap, `usedHeight` and per-line metrics, twip rounding | `layout.test.ts` (new): wrap with mixed runs, dates placement, rounding, section order |
| `functions/src/cv/render/fit.ts` | `fitPage` (size ladder, trim, spread, confirm) | `render.test.ts`: fills ≥ 0.93 for `validCv`/fake content; no page 2 at any size; `maxCv` and `wideCv` behaviour kept; ≤ 300 ms at the limits; deterministic bytes |
| `pdf.ts`, `docx.ts` | Spec-driven; DOCX style overrides; two runs per entry | DOCX styles black (parse `styles.xml`); same spacing in twips as the spec; PDF and DOCX text equal; still no table, image, header or footer; **wrap invariant** (the PDF line count at the DOCX width is ≤ at the PDF width, over fixtures) |
| `packages/shared/src/cv.ts` | `trimOrder` v2, `orderEntries`, `scrubDashes` | Trim table tests (Experience keeps 2, project order); ordering by end date and Present; scrub keeps figures, skill parts and headings valid (`validateCv` still passes) |
| `packages/shared/src/cv-lint.ts`, `cv-findings.ts` (new) | Rule tables and `lintCv` | Positive and negative examples per rule; a fact-backed "Led" is allowed; findings never hold text |
| `packages/shared/src/cv-score.ts` (new) | `scoreCv`, rubric v1 | Each criterion at its edges; a good fixture ≥ 8.5; each defect fixture moves the total as specified; a hard finding caps at 7.5 |
| `packages/shared/src/applications.ts` | `maxWrites`, `maxRevisions`, `maxAttempts: 3`; `CvDocSchema.quality?` | Schema: an old doc parses; `attempt` 3 is accepted and 4 refused |
| `functions/src/applications/prompt.ts` | v2 voice and length rules, `(facts: …)` mapping, `cvReviseUser` with `<draft_cv>` | `prompt.test.ts`: tags open and close once, unknown IDs dropped, no header or criteria, findings without text |
| `functions/src/llm/untrusted.ts` | Tag `draft_cv` | Existing tag tests |
| `functions/src/applications/compose.ts` (new) | Write → fit → lint → score → revise → pick | Every branch with fakes: no revision at ≥ 8; no revision when not fixable; invalid revision → draft; fact archived mid-revision; cap, API, refusal and deadline → draft shipped |
| `worker.ts`, `transitions.ts` | Use `compose`; attempt count before each call; `invalid` at `maxWrites`; store `quality` | `worker.test.ts`: kill tests updated to the 3-call bound (kill during a revision; three kills → 3 calls, then none); call order spy (count before every send); the deadline also stops a revision; **R11** with the real `llmCall` at both caps for `cvRevise`; injection in `<draft_cv>`; logs hold no CV text |
| `functions/src/config.ts` | `cvRevise`, `cvJudge`, `scoreTarget` | `config.test.ts`: budgets for the new purposes; the deadline arithmetic unchanged |
| `functions/src/llm/fake-transport.ts`, `fake-answers.ts` | `fakeCvWrite` fills a page (3 entries, about 12 bullets, 3 projects); `fakeCvRevise` returns the draft | `dev-tools.test.ts`; emulator `worker.test.ts` still reaches ready with `quality` |
| `functions/src/eval/cv-*.ts`, `scripts/eval.ts`, `evals/cv-*` | Suite, runner, report, gate | `cv-eval.test.ts`: the gate on synthetic results, a stale recording, suite selection |
| `web/src/features/pipeline/ApplicationCard.tsx` | The quality line | `PipelinePage.test.tsx`: the score, below-target words, an old doc without `quality` |
| `scripts/dev-seed.ts` | Ready CV with `quality` | `dev-tools.test.ts` |

---

## ADRs (numbers checked after the #41 rebase; ADR-060 is in #41, so these are expected to be 062–064)

- **ADR-062 CV layout v2.**
  - Fit-and-fill: the size ladder, `trimOrder` v2, spreading the spacing, and twip-rounded specs.
  - Entries newest first, in code; the recent-graduate section order.
  - The PDF wraps narrower than the DOCX, and dates go on the title's last line.
  - Mixed runs; DOCX style overrides.
  - Amends ADR-054's sizes and trim.
- **ADR-063 CV writing rules and the quality score.**
  - The lint rules and the hard/soft split; `scrubDashes`.
  - Code-only scoring, rubric v1, the gate of 8 with the hard-finding cap.
  - One revision round, only when fixable; `cvRevise` and `<draft_cv>`; ship-best below target.
  - `maxAttempts` 3. **This amends ADR-053's "at most 2 model calls" to 3.**
  - Cost and cap effects (measured).
- **ADR-064 CV eval.** The fake candidate and frozen S3 cases; separate recordings and baseline; the gates; the report-only judge; the 200p LIVE cap.

---

## Build: 3 sessions (Sonnet · Medium), then reviews

**The gate for every session:** `npm run format:check`, `npm run check`, `npm run test:rules`, `npm run build`, `npm run check:bundle`, `node scripts/smoke-functions-bundle.ts`. Small Conventional Commits. Each session ends with a handoff (what exists, exported names, differences from this plan, the gate table) and a no-self-triggering check.

- **Session 1: layout, fill and lint (pure + renderer).**
  - `layout.ts`, `fit.ts`, `pdf.ts`, `docx.ts`;
  - `trimOrder` v2, `orderEntries`, `scrubDashes`;
  - `cv-lint.ts`, `cv-findings.ts`.
  - The worker calls `fitPage` where it called `fitOnePage`; no prompt change.
  - Handoff: `docs/plans/cv-quality-handoff-1.md`.
- **Session 2: score, prompt v2, revision loop, worker.**
  - `cv-score.ts`, prompt v2, `cvReviseUser`, `compose.ts`;
  - worker and `transitions.ts` (attempts 3), config `cvRevise`;
  - `CvDocSchema.quality`, the fake transport, the dev seed.
  - Handoff: `cv-quality-handoff-2.md`.
- **Session 3: CV eval, web line, docs.**
  - Eval suite, cases, runner, gate, `cvJudge`, `--suite`;
  - the Ready card line.
  - **LIVE=1 CV eval run (about 60p, Beeb's OK first)** to record answers, measure tokens and set the baseline.
  - ADR-062–064, ADR-053/054 cross-references.
  - PRD R10 AC (fills the page, writing rules, score shown);
  - ARCHITECTURE (CV output row, `generateCvs` row: 3 calls, `cvs` doc `quality`);
  - SECURITY (CV threat row: `<draft_cv>`, re-validation after a revision);
  - FUNNEL S4 cost, RUNBOOK I7 (open the DOCX in Word and Google Docs), `evals/README.md` CV section, CLAUDE.md commands (`--suite`), ROADMAP (item done; parking lot), CHANGELOG "Unreleased".
  - Handoff: `cv-quality-handoff-3.md`.
- **Review:**
  - **Opus · Max** review of the whole branch, to `docs/plans/cv-quality-review.md`;
  - **Sonnet** fix commits, to `cv-quality-fixes.md`;
  - **Opus · High** re-review of the fix commits only, to `cv-quality-review-2.md`.

**Rebase after PR #41 merges:**
1. Run `git fetch origin && git rebase origin/main` on `feat/cv-quality` at the next session boundary, at the latest before Session 3's docs.
2. Resolve the docs, `index.test.ts` and EXPECTED conflicts (our rows don't change), then run the full gate.
3. Then `git push --force-with-lease origin feat/cv-quality`: **I'll show the exact commands and wait for your OK** first.
4. Re-check the ADR numbers. Rebase again before the post-v1.0.0 merge if `main` has moved.

**The PR body's no-self-triggering check:**
- no new function, trigger or schedule;
- `generateCvs` is unchanged (scheduled only, ≤ 10 jobs, no call after 210 s);
- per job ≤ 3 calls with each counted first;
- the revision loop is bounded by `maxRevisions` 1;
- the fit search is bounded (trim steps × 2 sizes + 8 halving steps);
- the eval is a local script over fixed cases;
- literal `maxInstances: 1` and `timeoutSeconds` are kept, and the EXPECTED rows are unchanged.

---

## Verification

- **Per session:** the gate above. Plus, on the branch:
  - `npm run dev` → `/pipeline` → the Ready card shows a filled one-page CV and its quality line;
  - Retry the blocked seed → `node scripts/dev-worker.ts` → Ready with `quality` (a fake revise);
  - open the four files.
- **Session 3:** run `npm run eval` (both suites replay clean), then `LIVE=1 npm run eval -- --suite cv`, and read `tmp/cv-eval/*.pdf` by eye.
- **Local check:** open one DOCX in Word and in Google Docs and confirm it is one page, black only, in the same order.
- **PRD R10 AC still holds:** every bullet cites a `factId` (validated after every revision), and the output is one page.

## Risks

- **Spend:** the worst case per owner move goes up by about half (17.7p → 26.8p), and only 2 worst-case moves fit in a day. Mitigations: revise only when a finding is fixable, and ship the draft on a cap.
- **The lint can be wrong either way:** a false positive costs a revision, and a miss lowers quality. Mitigations: rule tables with negative examples, and the facts-own-words exemption for inflation and buzzwords.
- **A code score can be gamed or miss tone.** The eval's report-only judge watches for drift; promote it to a gate later.
- **Word can still differ from the PDF** (other fonts on the reader's machine, Google Docs substitution). Mitigations: the narrower PDF wrap, twip-identical spacing, and the manual check (RUNBOOK I7).
- **The deadline can cut off a revision** when several jobs queue in one run. That job ships with `revisionSkipped: 'deadline'`. Usually there is one job per run.
- **Thin profiles can't reach 8**; they ship with the score and "add facts" guidance, not a block.
- **The prompt change invalidates nothing stored.** Old `cvs` docs have no `quality`, and the web handles that.
- **Rebase conflicts** with #41 in the docs.

## Open questions for Beeb

1. **Your own list of what's wrong with the v0.7.3 CV** (ROADMAP line 21). This plan diagnoses from the code. If your list has items it misses (a specific phrase, a font, the cover note's greeting), I'll fold them into Session 1 or 2.
2. **En dash in date ranges** ("Oct 2023 – May 2024") is code's, not prose. Keep it, or use "Oct 2023 to May 2024"?
3. **Cover note greeting:** keep "Dear hiring team," or use "Dear <Company> hiring team,"? The company name is posting text: printable-checked, but untrusted, so I'd keep it off by default.
4. **The LIVE CV eval run in Session 3:** about 60p, at most 200p. OK to spend it, or will you run it yourself?
5. **Showing the score on the Ready card** is a small web change inside this scope (needed for ship-best). Confirm it's wanted, or keep the score server-side only.

On approval: save this plan to `docs/plans/cv-quality-plan.md` on `feat/cv-quality`, commit (`docs:`), and stop before Session 1.

## Addendum (18 Oct, Beeb)

**Compared with Beeb's manual CV prompt.** The plan already covers: one page filled, monochrome and formal, the 8/10 score with revision, no em dashes, no "not X, it's Y", human graduate tone, apply/skip first (funnel verdict and gaps). Outreach tips stay out of scope (Wave 3 referral and recruiter finder). The 9/10 stretch gets no extra round: the gate stays 8.

**Answers to the open questions:**
1. No separate list. Beeb's manual prompt is the list, and this addendum folds it in.
2. Keep the en dash in code-made date ranges.
3. Keep "Dear Hiring Team,". Do not print the company name in the greeting.
4. LIVE CV eval in Session 3: allowed, about 60p, 200p cap. Ask Beeb for OK right before the run.
5. Show the score on the Ready card: yes.

**Font:** keep Arial (DOCX) and Helvetica (PDF). Sans-serif reads as modern for tech and product roles; both are ATS-safe.

**Added to Session 2: gap questions.**
- First read the 7D "Needs your input" path (application callable, answerFact, transitions, Pipeline screen).
- If it fits that path: code makes up to 3 questions per job from S3 requirements with level must and match missing or partial (skip logistics and hard-blocker types). Question text is a fixed code template plus the requirement text (untrusted: printable-checked, length-limited). No new model call to make the questions, no new function, trigger or schedule. Answers go through the existing answerFact call, its verification and its 60p/day cap, as today.
- If it does not fit cleanly: do not build it. Park it in docs/ROADMAP.md parking lot and give the reason in handoff 2.

**Added to Session 3: luck score on the Ready card.** Show "Quality 8.6/10 · Luck 7/10", with luck from the job's luckScore. A job without luckScore shows the quality only.

**Thin-case gate (changed in Session 3a fix, handoff `cv-quality-handoff-3a-fix.md`, fix 12):** the thin-profile case now passes by shipping "a valid one-page CV within 3 calls", with no score or revision rule. The "must not spend a revision" rule in §4 no longer applies (ADR-064).
