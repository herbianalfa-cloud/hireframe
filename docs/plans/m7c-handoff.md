# M7 PR 7C: handoff from sessions 7C.1 and 7C.2 to 7D

Sections 1 and 2 below are the 7C.1 handoff to 7C.2 (what existed then). **Start at "What 7D needs" at the end** for the finished 7C.

Branch `feat/m7c-cv-engine`, from `main` at `cf17ac8`. 7C.1 is schemas, pure logic, config and tests only: no new function, no model call, no prompt. Not started, on purpose: the renderer (7C.2), ADR-053, ADR-054, the CHANGELOG entry and the end-of-7C docs.

## What exists

### `packages/shared/src/applications.ts`
- `APPLICATION_STAGES`, `RESTORABLE_STAGES`, `BLOCKED_CODES`, `CV_ISSUE_CODES`, `APPLICATION_LIMITS` (`maxQuestions` 5, `maxAttempts` 2, `requirement` 200, `notes` 500, `answer` 2,000, `cvIds` 50).
- `ApplicationSchema` (`applications/{jobId}`), `QuestionSchema`, `QuestionAnswerSchema`, `BlockedSchema`. All are strict objects. `stageBefore` must be present exactly when `stage == 'applied'`.
- `questionId(text)`: `q-` plus 12 hex digits of FNV-1a over the folded text.
- `questionsFromRequirements(deep, max = 5)`: met and logistics out; must before nice, then missing before partial, then the job's own order; one question per distinct text.

### `packages/shared/src/cv.ts`
- `CV_LIMITS`, `EXPERIENCE_HEADING_FACT_TYPES`, `PROJECT_HEADING_FACT_TYPES`, `EDUCATION_FACT_TYPES`, `SKILL_FACT_TYPES`.
- `CvContentSchema` (strict, the plan's shape and limits) and `CvContentShapeSchema` (see differences). Types `CvContent`, `TrimmedCvContent`.
- `CvHeaderSchema` (`profile/cvHeader`), `CvDocSchema` (`cvs/{cvId}`), `cvId(jobId, n)`, `CV_FILE_KINDS`, `CV_FILE_FORMATS`.
- `validateCv(content, aliases, facts)`, `issueCodes(issues)`, `citedFactIds(content, aliases)`, `figuresIn(text)`, `hasContactDetails(text)`.
- `formatFactDates(dates)`: "Oct 2023 – May 2024". Dates in the output come from here, never from model text.
- `trimOrder(content)`, `applyTrim(content, count)`.

### Other shared changes
- `COLLECTIONS.applications`, `PATHS.application(jobId)`, `PATHS.cv(cvId)`, `DOCS.cvHeader`, `STORAGE_PATHS.cvFile(cvId, 'cv' | 'cover-note', 'pdf' | 'docx')`.
- `EventSchema` gains `application_stage { jobId, from, to, at }`. No rules change was needed: the events rule already ends in `: false` for an unknown type. A rules test now pins that a client can't create one.
- `CALLABLE_TIMEOUT_SECONDS.application = 120` and `.generateCvs = 540`.
- `DAILY_CAP_KEYS` gains `application`.
- `AppConfigSchema.applications` (an `unknown`, parsed on its own).
- Test fixtures: `packages/shared/src/fixtures/cv.ts` (`CV_FACTS`, `CV_ALIASES`, `aliasOf`, `validCv`, `fullCv`, `requirement`, `at`). They are a subset of the fake candidate's facts.

### `functions/src/config.ts`
- `LlmPurpose` gains `cvWrite` and `answerFact`.
- `MODELS.cvWrite`: `claude-sonnet-5-5`, effort `medium`, `maxTokens` 8,000, `timeoutMs` 150 s, `budgetMs` 300 s.
- `MODELS.answerFact`: the same as `addFact`.
- `PURPOSE_CALLABLE.cvWrite = 'generateCvs'` and `.answerFact = 'application'`.
- `APPLICATIONS = { dailyCapPence: 60, maxQuestions, maxAttempts, workerMaxPerRun: 10, workerStartDeadlineMs: 210_000 }`.
- `ApplicationOverridesSchema` (`{ dailyCapPence }`).

## Exported names 7C.2 needs
- **Parse the model's output with `CvContentShapeSchema`** (not `CvContentSchema`), then `validateCv(...)`, then re-parse with `CvContentSchema` for what is stored.
- `validateCv`'s `aliases` is the `toId` map from `factAliases(...)` (alias → fact ID). `facts` is `CvFact[]`: `{ id, type, text, evidence, status }`, **archived facts included**. `Fact` objects with an added `id` satisfy it.
- `applyTrim(content, n)` is `fitOnePage`'s step. Call it with `n = 0..trimOrder(content).length` and render each time. `trimmed` on the `cvs` doc is that `n`. The result has `summary: null` after the last step, so the renderer must handle a missing summary.
- `formatFactDates(fact.dates)` for the heading date lines. `CvHeader` for the contact block.
- `citedFactIds(content, aliases)` for `CvDoc.factIds`; `Object.fromEntries(toId)` for `CvDoc.aliases`.
- `cvId(jobId, n)` and `STORAGE_PATHS.cvFile(...)` for the four `storagePaths`.
- `CV_LIMITS` for the maximum-content render test; `fullCv()` in the shared fixtures is a maximum-size CV (note: its bullet texts are short, so it only tests counts, not line wrapping).
- **`unsupported_char` was not an issue code in 7C.1.** 7C.2 added it (see below).
- **Reservation IDs.** `dailyCapped(usage, 'application', cap)` throws unless the reservation ID starts `application-`. `llmCall` takes `deps.newId`, so the worker and the `answerFact` path must pass `newId: () => 'application-' + randomUUID()`. This is for 7D, but it is easy to miss.

## Differences from the plan

1. **`APPLICATIONS.workerStartDeadlineMs` is 210,000, not 300,000.** The plan's rule 2 (`workerStartDeadlineMs + budgetMs + margin ≤ 540 s`) can't hold at 300 + 300 + 30 = 630 s. I kept the rule and `budgetMs` (300 s: two 150 s sends inside `llmCall`) and moved the deadline to 540 − 300 − 30 = 210 s. `config.test.ts` pins that 210 s is the latest value that fits. Effect: about 3–5 CVs a run instead of 4–8, still well above 10 a week. **The plan text (the 7D.2 "300 s" in the worker section, the throughput risk and ADR-053) needs the same change.** If you'd rather keep 300 s, `budgetMs` has to drop to 210 s or less, which leaves no room for `llmCall`'s retry.
2. **`CALLABLE_TIMEOUT_SECONDS.application = 120` is added now**, not in 7D.1. `PURPOSE_CALLABLE.answerFact` has to name a callable that has a timeout, and the existing budget test iterates every purpose.
3. **`CvContentShapeSchema` (new).** The plan has one `CvContentSchema` with the limits. Parsing the model's output with it would turn a too-long or uncited output into a schema failure with no issue codes, and `uncited` and `too_long` could never reach the retry. The shape schema checks structure and caps array sizes at 4× the limit; `validateCv` applies the real limits.
4. **`TrimmedCvContentSchema` (new)**: the same as `CvContentSchema` with `summary` nullable, because `trimOrder` ends by removing the summary. `CvDoc.content` uses it.
5. **`validateCv` returns `{ ok: true } | { ok: false, issues }`** (the plan wrote `{ ok } | { issues }`).
6. **`trimOrder` returns `TrimStep[]`** (`bullet | project | skill | summary`), and each step refers to the content as the steps before it left it. `applyTrim` is new. Tie rule for "the longest experience entry": the later entry. Every experience entry keeps at least one bullet. The plan didn't say either.
7. **Withdrawn.** 7C.1 let headings and education lines each cite an `experience`, `education` or `project` fact. The review round replaced it with per-section types (see "Review round" below and ADR-054).
8. **`application_stage.from` is nullable** (null when an application starts).
9. **Number check limits (`unsupported_number`).**
   - A figure must match a cited fact's text or evidence by value and kind: `12k` = `12,000`; `30%` ≠ `30`; `£30` ≠ `30`.
   - A figure inside a word (`S3`, `ES6`, `3D`, `1st`) is ignored.
   - **Revised in the review round:** number words are checked by value (`twelve` is `12`; `one` alone is not checked), and the figure kinds are wider (multipliers, ordinals, plurals, fractions, `10+`, each currency).
   - A cite with an unknown fact also reports `unsupported_number` for figures only that fact supported.
10. **Contact check reuses `EMAIL` and `PHONE` from `pii.ts`**, plus links and any `label.tld` (revised in the review round: any final part of 2–24 letters, `[.]` and ` dot ` spellings, and a token allowed only when a cited fact has it literally). It misses an address written as "name at domain".
11. **Entry and bullet minimums are not enforced** (`bullets` may be empty, `experience` may be empty); the plan gave maximums only. The cover note's 2–4 paragraphs is enforced.
12. **Test phone numbers are built at run time** (`['07700', '900123'].join(' ')`) so the PII scan sees no literal. They are in Ofcom's fictional drama range.
13. ARCHITECTURE.md line 75 still shows the old `cvs/{cvId}` shape. Not touched, per the end-of-PR docs rule.
14. **Not done in 7C.1, as the plan says:** rules for `applications` and `profile/cvHeader` (7D.1); a `cvWrite` branch in the fake transport and the dev seed (7D.2); the prompt (7D.2).

## Gate (after the last code change)
`npm run check` passed (138 files, 1,874 tests; PII scan and eval replay clean). `npm run test:rules` passed (13 files, 344 tests). `npm run build`, `npm run check:bundle` (initial JS 293.3 kB gzip) and `node scripts/smoke-functions-bundle.ts` passed. The initial JS was not compared with `main`.

## Session 7C.2: the renderer (done)

`functions/src/cv/render/`: `layout.ts` (blocks, styles, `makeDateOf`, `CvRenderError`, our own word-wrap and pagination), `pdf.ts`, `docx.ts`, `fit.ts`, `index.ts`, and `fixtures.ts` (test support: `FAKE_HEADER`, `FAKE_DATES`, `fakeDateOf`, `maxCv()`; not imported by any `src` file, so the bundle's fixture check stays clean).

### Differences from the plan (7C.2)
15. **Render functions take a `DateOf`, not the facts.** The plan wrote `renderCvPdf(header, content, facts)`. They take `(header, content: TrimmedCvContent, dateOf)`, where `dateOf = makeDateOf(aliases, facts)` and `facts` are `{ id, dates }` (a `Fact` with its `id` fits). The notes take `(header, coverNote)`. All four are async and reject with `CvRenderError` (`code: 'unsupported_char'`) rather than throw, so a caller handles them in one `catch`.
16. **`fitOnePage` is `(header, content, dateOf)` and tries every step, not 12.** `trimOrder` on a maximum CV has about 26 steps (16 bullets, 3 projects, 6 skills, the summary), so "up to 12 times" could not reach a fit for content the limits allow. It stops at the first step that gives one page. It returns `{ ok: true, content, trimmed, bytes } | { ok: false, code: 'too_long' }` (the PDF bytes are the fitted ones, so the worker doesn't render the PDF twice).
17. **Two validator changes in `shared`, to make the plan's tests true.** `unsupported_char` joins `CV_ISSUE_CODES` (which widens `ApplicationSchema.lastIssues`) and is reported at the text's path for any character outside WinAnsi, a newline and a tab included. The cover note's "at most 250 words" needed an enforcement point, so `validateCv` reports `too_long` at `coverNote.paragraphs` when the paragraphs hold more than `CV_LIMITS.noteWords` (250) words. The greeting and sign-off are not counted.
18. **Education lines carry dates too.** The plan's "dates from the cited heading fact" named headings; an education line cites a fact too, so its dates (from `formatFactDates`) sit right-aligned like an entry's. A fact with no dates shows none.
19. **Section order and names:** Summary, Experience, Projects, Education, Skills; a section with nothing in it is left out, and so is the summary once trimmed. Skills are one comma-separated line. The cover note has a fixed "Dear hiring team," and "Yours sincerely," around the model's paragraphs, then the owner's name.
20. **Sizes** (plan: "10/10.5 pt"): body 10 pt on a 12.5 pt line, entry titles 10.5 bold, headings 11 bold with a rule, name 18, contact line 9.5, the note 10.5 on 14. All in `STYLES` in `layout.ts`; the DOCX uses the same numbers (exact line spacing).
21. **PDF bytes are deterministic:** no creation or modification date is written (`updateMetadata: false`), and the file is saved without object streams so its fonts and content are checkable in a test. The DOCX is not byte-deterministic (the library stamps the time).
22. **A word wider than a line is broken by character** instead of overflowing (a long link in the header, say).
23. **The functions bundle did not grow in the build, but it will:** the renderer is not imported by any function in 7C, so the deploy bundle went 5,194,538 → 5,195,926 bytes. Bundling the renderer from the entry (same esbuild options, a scratch entry that re-exports `index.ts` and the renderer) gives 5,194,513 → 6,911,824 bytes: **+1,717,311 bytes (+1.64 MiB), over the 1.5 MB line.** Per the session rule nothing was restructured. See the task for 7D.2 below.
24. **`workerStartDeadlineMs` stays at the value in `functions/src/config.ts` (210,000).** The plan text is corrected (7C.1 config bullet, 7D.2 worker step and test, the throughput risk) and ADR-053 carries the value and the new estimate: about 3–7 CVs a run (7 at 30 s a call, 5 at 50 s, 3 at 90 s).
25. **ARCHITECTURE's `cvs/{cvId}` line is now the real shape** (difference 13 is closed), with the stack row.

## What 7D needs

### Exported names
- From `@hireframe/shared`: everything listed under "What exists" and "Exported names 7C.2 needs", plus `isWinAnsi`, `isPrintable`, `wordCount` and `CV_LIMITS.noteWords`.
- From `functions/src/cv/render/index.ts`: `fitOnePage`, `renderCvPdf`, `renderNotePdf`, `renderCvDocx`, `renderNoteDocx`, `makeDateOf`, `CvRenderError`, and the types `FitResult`, `RenderedPdf`, `DateOf`, `DatedFact`.
- **The worker's render sequence:** parse with `CvContentShapeSchema` → `validateCv` (issue codes → retry) → re-parse with `CvContentSchema` → `dateOf = makeDateOf(new Map(toId), facts)` → `fitOnePage(header, content, dateOf)` (`too_long` → blocked) → with `fit.content`: `renderCvDocx`, `renderNotePdf(header, fit.content.coverNote)`, `renderNoteDocx`, and `fit.bytes` is the CV PDF → upload the four files → write `cvs/{cvId}` (`content: fit.content`, `trimmed: fit.trimmed`, `aliases: Object.fromEntries(toId)`, `factIds: citedFactIds(content, toId)`). A `CvRenderError` (a header with an unsupported character) is a block for the application with a message that names the header, not an invalid output: the retry cannot fix it. The validator already refuses unsupported characters in model text, so the retry can.
- The header is `profile/cvHeader`, read and parsed with `CvHeaderSchema`; a missing one is `cv_header_missing`.

### Reservation IDs for the daily cap
`dailyCapped(usage, 'application', cap)` counts only reservations whose ID starts `application-`, and throws if the ID doesn't. Every `llmCall` for `cvWrite` and `answerFact` must pass `deps.newId: () => 'application-' + randomUUID()`. Without it the `application` daily cap would count nothing and the 60p cap would never bite.

### Bundle note: a task for 7D.2
Bundling the renderer from the entry adds about 1.72 MB (1.64 MiB) to `functions/deploy/index.js` (5.19 → 6.91 MB), over the 1.5 MB line, and it would load on every cold start of every function (the file is one bundle). **7D.2: load the renderer with a dynamic `import('./cv/render/index.js')` inside the worker.** One caveat to check first: `scripts/build-functions.ts` writes a single `index.js` (`bundle: true`, no `splitting`), and esbuild inlines a dynamic import into that file. The file size would then stay the same, and what the dynamic import saves is only the module evaluation of pdf-lib and docx on cold starts of the other functions (esbuild wraps the inlined module so it runs on first use). If the parse cost matters too, the build needs `splitting: true` with an `outdir`, or a second entry file the worker imports. Measure both the size and a cold start of a small function, then put the numbers in the PR. Until the worker imports the renderer, the deploy bundle is unchanged.

### Still not done (7D)
Rules for `applications` and `profile/cvHeader` (7D.1), the `cvWrite` branch in `fakeTransport` and the dev seed (7D.2), the prompt (`prompt.ts`, 7D.2), the callable and the worker, the web screens.

## Gate (7C.2, after the last code change)
See the PR body for each command's result.

## Review round (PR #29): validator rules the 7D prompt must state

`validateCv` is stricter than 7C.2 shipped. The 7D prompt (`functions/src/cv/prompt.ts`) has to tell the model these, or most first attempts will fail:

- **Copy words from the cited fact.** A heading's role and org, an education line and a skill label may use only words (2+ letters, see "Second review round" below) that are in the cited fact's text or evidence; shortening is fine, adding a title or a company is `unsupported_text`. Skipped words: and, of, the, for, ltd, limited, inc, project, personal.
- **Cite one fact per skill part.** `SQL and Python` cites the SQL fact and the Python fact; a label with parts (`,` `;` `/` `&` `+` `|` `(` `)` `and` `or`) needs a fact for each. Do not add qualifiers (`Advanced SQL`).
- **Section fact types:** experience headings cite an `experience` fact; project headings a `project` or `experience` fact; education lines an `education` fact; skills `skill` facts. Bullets, headings and skills never cite `constraint` or `preference` facts; the summary and the note may cite a `constraint` fact; nothing cites a `preference` fact. (`wrong_fact_type`)
- **Figures:** every number, multiplier (`10x`), ordinal, plural (`100s`), fraction, `10+`, currency amount and number word (`twelve`, `half`, `doubled`, `a dozen`) must be in a cited fact, in the same kind. Say what the fact says.
- **No links and no addresses:** no URL, no email, no phone number, and nothing shaped like `name.tld` unless a cited fact has that exact token (`ASP.NET`). The header supplies contact details.

Worker changes this implies:
- **Check `renderNotePdf(header, coverNote).pages === 1`** before storing: the 250-word limit makes it hold, but the check is one call and `pages` is exact. A note over a page is `too_long` for the retry.
- **Map `too_long` from `fitOnePage` and `unsupported_text` from `validateCv` to the retry with issue codes.** `too_long` from the fit is a real outcome (ADR-054): headings and education are never trimmed, so wide content at the limits can be two pages. The retry prompt should say "shorten the headings and education lines" for it.
- **The new code widens `CV_ISSUE_CODES`** (`unsupported_text`, after `unsupported_number`), and with it `ApplicationSchema.lastIssues`. Any stored `lastIssues` array is unaffected (the new code only adds an allowed value); `issueCodes` returns codes in declared order.
- `fullCv()` and `maxCv()` do not pass `validateCv`; use `validCv()` when a test needs a valid CV, and `wideCv()` (`functions/src/cv/render/fixtures.js`) for the worst case of the fit.

## Second review round (PR #29): what the 7D CV prompt must also say

The word rule and the contact rule changed again (ADR-054). The prompt has to tell the model these:

- **Write the employer's name without a domain.** `Booking`, not `Booking.com`: a `name.tld` is `contact_in_text` unless a cited fact's own text (not its evidence) has the exact token.
- **Copy role, org, education and skill words exactly.** Every word of 2+ letters is checked against the cited fact, so no plurals (`Analysts` for `Analyst`), no abbreviations (`Sr`, `PM`, `VP`, `MD`), no added levels (`II`), and no `Certification` for `Certificate`. Skipped: and, of, the, for, at, in, on, to, by, an, as, or, project, personal, and company suffixes (ltd, limited, plc, inc, llc, llp, gmbh; **not** uk).
- **At least one real word per heading and per education line**, and a skill label with a real word in it.
- **Write `Python`, not `Python 3`, unless the fact has the figure** (`3` is an `unsupported_number`). The same holds for `S3`-style names only when the fact has the token; a figure inside a word is ignored.
- **Skill labels:** one part per fact; `C++`, `C#` and `F#` are different skills; a part separator is `,` `;` `/` `&` `|` `(` `)` `:` `•`, ` + `, ` - `, ` – `, ` — `, ` · `, `and` or `or`.

Worker change: **run `normaliseCvText(content)` on the parsed output before `validateCv` and store its result.** The validator checks printability after NFC, and the renderer does not, so storing the raw output could pass the check and then be refused by `CvRenderError`.
