# CV quality: handoff 1 (layout, fill and lint)

Branch `feat/cv-quality`, from `main` at `3310a34`. Session 1 of 3 (plan: `docs/plans/cv-quality-plan.md`, with the Addendum). **Do not merge before v1.0.0.** No deploy, tag or live change.

## What exists

**Renderer (`functions/src/cv/render/`)**

- `layout.ts`: `LayoutSpec` (body size, leading scale, section/entry/bullet gap scales) and `resolveStyles(spec)`, which rounds every size and spacing to 1/20 pt. Blocks carry mixed `runs`; `wrapRuns` wraps them. `SECTION_ORDER` is Summary, Education, Experience, Projects, Skills (titles are written in capitals). The name and contact line are centred. An entry is a bold role and a regular organisation, with its dates on the title's **last** line, or on a line of their own if they don't fit there. Education lines are regular weight with right-aligned dates, and skills are one paragraph. The PDF wraps at `CONTENT_WIDTH − 1.5%` (`PDF_WRAP_WIDTH`); the DOCX keeps the full width.
- `fit.ts`: `fitPage` replaces `fitOnePage`. It measures with Helvetica's widths and renders the PDF once, at the end. For 0..n trim steps it tries body sizes 10.5 then 10 and takes the first that is one page. It then bisects (1 test plus 8 halvings) how far to spread the gaps (≤ ×1.6) and the leading (≤ +6%), keeping a 6 pt reserve.
- `pdf.ts` and `docx.ts` are spec-driven. The DOCX overrides the library's `title`, `heading1` and `heading2` styles (black, Arial, our sizes, `keepNext`) and writes role and organisation as two runs.

**Shared (`packages/shared/src/`)**

- `cv.ts`: `trimOrder` v2, `orderEntries`, `factEndKey`, `scrubDashes`.
- `cv-findings.ts` (new): finding codes, severity, fixable, a label in words and a fixed guidance line per code.
- `cv-lint.ts` (new): `lintCv(content, facts, aliases) → Finding[]`.

**Worker:** `worker.ts` calls `fitPage` where it called `fitOnePage`, and passes `fit.spec` to `renderCvDocx`. Nothing else changed. No prompt change, no new model call, function, trigger or schedule.

## Exported names

- `@hireframe/shared`: `trimOrder`, `applyTrim`, `TrimStep` (bullet steps now have `section: 'experience' | 'projects'`), `orderEntries(content, endKeyOf)`, `factEndKey(dates)`, `scrubDashes(content) → { content, replaced }`, `lintCv`, `FINDING_CODES`, `FindingCode`, `Finding`, `FindingSeverity`, `FINDING_INFO`, `FINDING_SEVERITY`, `makeFinding`, `findingLabel`.
- `functions/src/cv/render/index.ts`: `fitPage`, `FILL_RESERVE`, `FitResult`, `FitLines`, `BASE_SPEC`, `SECTION_ORDER`, `LayoutSpec`, `makeEndKeyOf`, plus the existing `renderCvPdf`, `renderCvDocx` (both take an optional 4th `spec`), `renderNotePdf`, `renderNoteDocx`, `makeDateOf`, `CvRenderError`.
- `FitResult` is `{ ok: true, content, trimmed, spec, fill, bytes, lines: { bullets: number[], headingWraps } } | { ok: false, code: 'too_long' }`. `lines.bullets` is the rendered line count per bullet in document order (Experience, then Projects). Session 2's score reads `fill` and `lines`.
- Lint codes. Hard: `contrast_pattern`, `buzzword_stack`, `inflated_claim`, `cliche`. Soft: `buzzword`, `intensifier`, `weak_opener`, `first_person`, `long_sentence`, `exclamation`, `note_greeting`, `heading_wraps`. `heading_wraps` is not produced by `lintCv`; Session 2's score builds it from `lines.headingWraps` with `makeFinding`.

## Differences from the plan

1. **`orderEntries` takes `endKeyOf(factRef) → string`, not `dateOf`.** `DateOf` returns display text ("Oct 2023 – May 2024"), which doesn't sort. `factEndKey` makes the key (`2024-05`, a bare year as its December, `present` or no end date as `9999-12`). `makeEndKeyOf(aliases, facts)` in the renderer builds the function from the facts.
2. **`orderEntries` and `scrubDashes` are not wired into the worker.** The brief said only `fitPage` is called. The plan puts both in `compose.ts` (Session 2), where `scrubDashes` also needs somewhere to store `dashesReplaced`. Until then entry order is still the model's and dashes are not scrubbed.
3. **`validCv()` fills only 46% of the page, not ≥ 0.93.** It has about 4 bullets, so the spread caps (×1.6, +6%) stop short. The plan's test line can't hold for it. The fill tests use `fullCv()` (95%) and `maxCv()` (99%), and one test pins that the small CV spreads to the caps and no further. Session 2's `fakeCvWrite` is meant to fill a page.
4. **Section titles are literal capitals** ("EXPERIENCE") in both formats, not `allCaps` styling, so the PDF and DOCX text stay identical. Tests and `readingOrder` were updated.
5. **Extra DOCX overrides.** `heading3` to `heading6` and `hyperlink` are black too. They are unused, but the library's blue would show in Word's style pane. The plan named only title, heading1 and heading2.
6. **New block kind `education`** (regular, not a heading). Entry size is body + 0.5 and section size is body + 1, so they follow the 10.5/10 ladder. The name (18 pt) and the cover note are fixed.
7. **`trimOrder` v2 ties.** Across Experience and Projects a tie goes to the later entry in the list (projects first). An experience entry with fewer than 2 bullets is left alone. `applyTrim` removes projects from the end, which is "oldest" only once `orderEntries` has run.
8. **`CvDoc.trimmed` now counts v2 steps.** The number on stored docs counted v1 steps. Nothing reads it for logic.
9. **`scrubDashes` detail.** A spaced dash becomes `, `; an unspaced one becomes `-`. A dash next to punctuation or at an edge is dropped, so no doubled punctuation is left and text without a dash is untouched byte for byte.
10. **Cover note greeting is unchanged: "Dear hiring team,".** The Addendum says to keep "Dear Hiring Team,". The code says lower-case. Beeb to confirm; a one-line change in `noteBlocks`.
11. **`FINDING_INFO` carries a fixed `guidance` line per code**, for Session 2's revision request. The plan only named codes and labels.
12. **Not done here (Session 3):** ADRs 062–064, CHANGELOG, ARCHITECTURE and RUNBOOK edits, and opening a DOCX in Word or Google Docs.

## Checked by eye

One PDF of a fake CV, rendered to PNG: centred header, bold role with regular organisation, dates right, 0.5 pt rules, one page. The DOCX was checked through `styles.xml` and `document.xml` in tests, not opened in Word.

## Gate

Run on the last code commit (`chore: format the worker`). This handoff is a docs-only commit after it.

| Command | Exit | Notes |
|---|---|---|
| `npm run format:check` | 0 | |
| `npm run check` | 0 | 189 files, 2823 tests; funnel eval replay passed (85.0% agreement, unchanged) |
| `npm run test:rules` | 0 | 18 files, 407 tests |
| `npm run build` | 0 | |
| `npm run check:bundle` | 0 | initial JS 295.1 kB gzip, 6 files |
| `node scripts/smoke-functions-bundle.ts` | 0 | `index.js` 1000 KiB; 14 functions in europe-west2 |

## No-self-triggering check (CLAUDE.md rule 6)

- No new function, trigger or schedule. `git diff 3310a34..HEAD -- functions/src` has no change to any `maxInstances`, `timeoutSeconds`, `onSchedule`, `onDocument*`, `onCall` or `onRequest` line. `generateCvs` is unchanged.
- No function is triggered by an event it can cause, and nothing reschedules or re-enqueues itself. The renderer and lint are pure and have no I/O.
- Loops are bounded. `fitPage` does at most (trim steps + 1) × 2 size tries, then 9 spread layouts, then one PDF render. The trim steps are bounded by the schema's limits (a test runs it at the limits in under 300 ms; it measured about 25 ms). `wrapRuns` and `layoutBlocks` walk their input once. `lintCv` and `scrubDashes` are single passes. No external call is added.
- Model calls per job are unchanged (this session adds none).

## For Session 2

- Order: `scrubDashes` right after `normaliseCvText`, then `validateCv`, then `orderEntries(content, makeEndKeyOf(toId, datedFacts))`, then `fitPage`, `lintCv` and `scoreCv`.
- `fitPage` takes untrimmed `CvContent`. Pass it the ordered content, and keep passing `fit.spec` to `renderCvDocx`.
- Add `heading_wraps` findings from `fit.lines.headingWraps`.
- Settle the greeting (difference 10).
