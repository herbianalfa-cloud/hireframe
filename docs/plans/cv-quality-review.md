# CV quality review

Branch `feat/cv-quality` at `3f47648`: 51 commits over `main` at `3310a34`, and the same commit as `origin/feat/cv-quality` after `git fetch`. I read CLAUDE.md, docs/SECURITY.md, the plan with its Addendum, and handoffs 1, 2a, 2b, 3a, 3a-fix and 3b first. Nothing was changed. Claims marked **probe** were checked by bundling repo code with esbuild from stdin straight into `node`, in memory: a replay of the committed recordings, with no API call and no file written.

**Verdict.** The call bound, the attempt counting, the caps and the no-self-triggering rule all hold, and the validator gates every shipped candidate on the success path. There is one High finding: the CV gate can pass with a missing revision recording, which is exactly what a "no LIVE run" rubric change would hit. There are six Medium findings.

**Checked and withdrawn.** I suspected the PDF's `Math.max(after, before)` paragraph spacing (layout.ts:492) differs from Word. It doesn't. Word uses the larger of the two values unless "Don't use HTML paragraph auto spacing" is set, and the DOCX settings.xml (compatibilityMode 15) doesn't set it.

## Findings at a glance

| ID | Severity | Finding |
|---|---|---|
| H1 | High | A missing `cvRevise` recording is swallowed as `revisionSkipped: 'error'`, and the gate passes |
| M1 | Medium | `achievementRef` lets an education line borrow any achievement's words and figures |
| M2 | Medium | A failed revision ships the draft against facts read before the call |
| M3 | Medium | The system prompt doesn't name `<draft_cv>` as data, and the revision calls it "Your draft" |
| M4 | Medium | The code score saturates, and the cover note is worth 0.25 of 10 (rubric calibration, Q5) |
| M5 | Medium | The lint misses "X isn't Y, it's Z", "not X but Y", present-tense "Lead/Manage" and "My" |
| M6 | Medium | The DOCX section borders need about 7.5 pt that the PDF never reserves; the reserve is 6 pt |
| L1 | Low | Hard lint false positives: "led to", "managed to", "outstanding tickets", "a leading retailer" |
| L2 | Low | A thin profile pays for a revision that can't reach 8 (ADR-063 says it never does) |
| L3 | Low | An undated experience entry sorts first |
| L4 | Low | A spaced dash in a number range becomes a list ("10 – 15" becomes "10, 15") |
| L5 | Low | A rubric change can't be re-baselined through the CLI, and the baseline holds no rubric version |
| L6 | Low | `cvJudge` is eval-only by convention; nothing pins it |
| L7 | Low | The posting's title exempts its words from `inflated_claim` everywhere |
| L8 | Low | Requirement text can spoof its own `(facts: …)` mapping |
| N1–N7 | Nit | Small accuracy and test gaps |

## Checks by name

**1. CLAUDE.md hard rules**

| Check | Result | Evidence |
|---|---|---|
| No shipped text without `validateCv` on the final text | Holds on the success path; gap on the failure path (M2) | Every candidate goes NFC, `clampCvCounts`, `dropUnsupportedSkills`, `scrubDashes`, `validateCv`, strict parse (compose.ts:151-164). After a revision, both candidates are re-checked against fresh facts (compose.ts:385-389). A failed revision ships the earlier check (compose.ts:371-382) |
| The revision and the clamps can't add a claim | Holds | The revision goes through the same `prepare` (compose.ts:389). The clamps only slice or filter (cv.ts:939-981). The dash swap runs before the validator (compose.ts:153-154) |
| `achievementRef` can't smuggle words | **Fails (M1)** | cv.ts:612-625 and 833-855 |
| Every model call goes through `llm.call()` | Holds | worker.ts:325 and 351 (`deps.llm` is `llmCall` over the application deps); cv-evaluate.ts:222, 239 and 316 |
| No self-triggering code | Holds | No `maxInstances`, `timeoutSeconds`, trigger, schedule or timer line changed (grep of the diff). At most one revision per job (compose.ts:343-372). The eval loop stops at `maxWrites` (cv-evaluate.ts:220) |
| No personal data in fixtures | Holds | `CV_EVAL_FACTS` lengthens the existing fake candidate's facts, with invented employers (cv-facts.ts). `evals/cv-*.jsonl` and `fixtures/cv-recorded.ts` hold no email, phone number or link (grep). The header is `FAKE_HEADER` (example.com) |

**2. Cost**

| Check | Result | Evidence |
|---|---|---|
| At most 3 calls per owner move, kills and retries included | Holds | `planAttempt` stops at `maxAttempts` (transitions.ts:243-246). `planRetry`, `invalid()` and `fail()` stop at `maxWrites` (transitions.ts:277, worker.ts:213 and 245). Compose checks `attempt < maxAttempts` (compose.ts:346). Tests: worker.test.ts:562-617 and 1145-1199 |
| Attempt counted before every call | Holds | worker.ts:303-313 for the write; worker.ts:346-350 with compose.ts:351-359 for the revision. Call-order spy: worker.test.ts:1126 |
| 60p daily cap and monthly cap hit mid-revision | Holds | A cap ships the draft and stops the run (compose.ts:296-297, worker.ts:435). The daily cap wraps the whole application usage store (applications/llm.ts:22), so `cvRevise` counts. Tests: worker.test.ts:1244-1340 |
| `cvRevise` and `cvJudge` budgets | Holds | config.ts:100-121. config.test.ts checks that the deadline plus the revision's budget fits the worker timeout |
| `cvJudge` unreachable from production code | Holds by inspection, not pinned (L6) | The only caller is cv-evaluate.ts:317 (git grep) |

**3. Prompt injection**

| Check | Result | Evidence |
|---|---|---|
| `<draft_cv>` | Wrapped and defused, but not named as data (M3) | prompt.ts:357, 178 and 365 |
| `<job_analysis>` and `(facts: …)` | Inside the tag, but the text can spoof a mapping (L8) | prompt.ts:231-241 and 270-281 |
| Requirement text in gap questions | Unchanged on this branch | No diff to `questionsFromRequirements` (handoff 2b, difference 1) |
| `lastIssueAt` can't carry text | Holds (see N4) | `ApplicationSchema` regex; paths come from `validateCv`'s fixed keys (cv.ts:570-646); `setIssues` keeps only code and path (transitions.ts:249-264) |
| Findings and logs hold no CV text | Holds | Stored findings are code and path (compose.ts:263-265). Logs carry codes and numbers (compose.ts:416, worker.ts:423-433). Tests: worker.test.ts:1403-1480 |

**4. Correctness**

| Check | Result | Evidence |
|---|---|---|
| `composeCv` branches and ranking | Hold, except M2, N5 and N6 | compose.ts:343-437; compose.test.ts (34 tests) |
| `orderEntries` | Holds for education; experience has L3 | cv.ts:899-927 |
| `trimOrder` v2 | Holds | cv.ts:1062-1131: ties go to the later entry (projects first); Experience keeps 2 bullets, projects 1; then the oldest project, skills over 10, the summary |
| `fitPage` bounds | Hold (N1) | fit.ts:100-143: (steps + 1) × 3 sizes, then 9 spread layouts and one render for the size that fits |
| `scrubDashes` | Holds, except L4 | cv.ts:991-1035 |
| Lint | Misses (M5), false positives (L1), title exemption (L7) | cv-lint.ts |
| PDF/DOCX parity and the wrap invariant | Spacing matches Word; the borders and the contact line don't (M6); the invariant test only checks itself | render.test.ts:517-538 |
| Old `cvs` and `applications` docs | Parse (N7) | `quality` and `achievementRef` are optional (cv.ts:99 and 233). `attempt` is 0..3 and `lastIssueAt` is optional (applications.ts). The client mirror rule checks changed keys only (firestore.rules:392-412) |

**5. Rubric calibration:** see M4. The code score is too lenient, and the smallest change that needs no LIVE run first is a rubric change.

**6. Eval integrity**

| Check | Result | Evidence |
|---|---|---|
| Recording keys | Hold for writes and the judge | Keyed on model, effort, max tokens, system, cache flag, messages and schema (recordings.ts:29-43) |
| The gate can't pass on stale or missing recordings | **Fails for the revision (H1)** | |
| Thin-case rule | Matches ADR-064 | The case must ship, be one page, have no hard finding and take at most 3 calls; there is no score rule (cv-report.ts:88-103) |
| Baseline handling | L5 | |

**7. Tests:** see "Tests missing or wording-only" below.

## High

### H1. A missing `cvRevise` recording passes the CV gate
- **Evidence:** `revisionFailure` maps any error that isn't a cap or an `LlmOutputError` to `revisionSkipped: 'error'` (compose.ts:291-305), and the catch ships the draft (compose.ts:371-382).
  - The replay's `RecordingMissingError` (recordings.ts:63-65, thrown at :93) is such an error, because `llmCall` rethrows transport errors unchanged (llm/call.ts:146-165).
  - `evaluateCvCase` never reads `composed.stop` or `revisionSkipped` (cv-evaluate.ts:230-272).
  - `runCvSuite` reports "stale" only when the error escapes the case (cv-cli.ts:72-85).
  - `gateCv` has no rule on `revisionSkipped` (cv-report.ts:88-103).
  - The only stale test uses an empty map, so it fails at the write and never reaches the revision (cv-eval.test.ts:214-218).
- **Probe:** I replayed the committed recordings with `APPLICATIONS.scoreTarget` raised to 9.5 in memory, as a stand-in for a stricter rubric.
  - c05 (9.13) then asks for a revision nobody recorded. It ships its draft as `revisionSkipped: 'error'`, all 17 recordings count as used, and `gateCv` returns `{ ok: true, reasons: [] }`.
  - Today only luck catches it. When I dropped c08's recorded revision instead, c08's shipped text changed, so its judge request missed and the case threw.
- **Risk:** ADR-064's "recordings fresh" doesn't hold on the revision path.
  - A change to the lint, the rubric, the layout, the finding guidance or `cvReviseUser` can create or change a revision request while `npm run check` stays green.
  - A LIVE run with a transient revision error is recorded as a silent skip.
  - This is the trap for M4's "no LIVE run" rubric change.
- **Fix:**
  - In cv-evaluate.ts, wrap `revise` so a `RecordingMissingError` is kept and rethrown once `composeCv` returns; the CLI then reports "recordings stale".
  - Make `gateCv` fail any case whose `revisionSkipped` is `'error'` or `'cap'`.
  - Optionally report recordings left unused (N3).
- **Test:** in cv-eval.test.ts:
  - A replay map that holds a below-target case's `cvWrite` and `cvJudge` answers but no `cvRevise`: `evaluateCvCase` rejects with `RecordingMissingError`.
  - `gateCv` with one result at `revisionSkipped: 'error'` returns `ok: false`.

## Medium

### M1. `achievementRef` lets an education line borrow any achievement's words and figures
- **Evidence:** the education cite adds the achievement as a second ref, typed only as "an achievement" (cv.ts:612-625, `typesByRef` at :621).
  - The word rule allows the union of both facts' words (cv.ts:833-843), and the figure rule the union of their figures (cv.ts:850-855).
  - "Only the classification" is a rule in the prompt (prompt.ts rule 4 and the `OUTPUT_SHAPE` note), not in code.
- **Probe:** the facts were "BSc Economics, Example University", "Awarded a Distinction for the MSc dissertation" and an unrelated "Won first prize at a 60-person hackathon with a fraud-detection model". `validateCv` accepted both of these lines:
  - "BSc Economics, Example University, Distinction"
  - "BSc Economics, first prize, 60-person hackathon"
- **Risk:** the credential line can give one degree another degree's classification, or carry an unrelated award and its figure.
  - Every word still comes from a cited fact, so it isn't an uncited claim, but the combined claim is false.
  - Bullets and the summary already allow such combinations (ADR-054 checks prose for figures and contact details only). This branch removes the stricter one-fact rule the education line had.
- **Fix:**
  - Words the line takes from the achievement must be in a closed classification list: First Class Honours, Upper/Lower Second Class, 2:1, 2:2, Third, Distinction, Merit, Pass, Commendation, cum laude. No figure may come from the achievement.
  - With two or more education facts, the achievement must share a degree token (BSc, MSc, BA…) or the end year with the cited education fact; otherwise refuse with `wrong_fact_type`.
- **Test:** in cv.test.ts, "an education line citing a classification":
  - Both probe lines fail with `unsupported_text`.
  - "BSc …, First Class Honours" citing "Graduated with First Class Honours" still passes.

### M2. A failed revision ships the draft against facts read before the call
- **Evidence:** on any revision error, the draft ships through `ship()` (compose.ts:371-382).
  - That candidate was prepared against `input.facts`, read once after the write (worker.ts:366).
  - The facts are read again only on the success path (compose.ts:385-389).
  - SECURITY.md:19 and ADR-063 (DECISIONS.md:814) say both candidates are re-validated against facts read after the call.
  - The failure tests change no fact (compose.test.ts:566-597).
- **Risk:** an `output` failure is a full call (up to the 150 s timeout), and an API error can be too. A fact the owner archived in that window, for example because it was wrong, ships in the CV. Before this branch the window was only the render and the upload.
- **Fix:** in the catch, read `deps.facts()` again and re-`prepare` the draft before shipping (one read). If it no longer validates, return `invalid` with its issues, as the success path does.
- **Test:**
  - compose.test.ts: the probe archives a fact the draft cites, then the revision throws `LlmOutputError('invalid_json')`. The result is `kind: 'invalid'` with `unknown_fact`.
  - worker.test.ts: no `cvs` doc and no files are written, and the job is blocked with `invalid_output`.

### M3. The system prompt doesn't name `<draft_cv>` as data, and the revision calls it "Your draft"
- **Evidence:** the revision reuses the write's system prompt (worker.ts:318 and 351-357).
  - Its data sentence names only `<job_posting>`, `<job_analysis>` and `<owner_notes>` (prompt.ts:178).
  - The revision request then says "Your draft was checked by code. Fix these and keep everything else that works" (prompt.ts:365).
  - prompt.test.ts:74-77 pins the three-tag sentence. worker.test.ts:1222-1241 checks only that the attack text stays inside the tags.
- **Risk:** SECURITY.md:19 treats the draft as untrusted model output derived from the posting, but the model is told it is its own work.
  - Bullet prose isn't word-checked, so text planted by the posting can survive the first write and reach the revision as if trusted.
  - `validateCv` still gates claims, so the damage is limited to obeyed formatting, dropped content or tone, not an uncited claim.
- **Fix:** add `<draft_cv>` to the data sentence, and say in `cvReviseUser` that the draft is data to correct, not instructions. Bump `CV_PROMPT_VERSION`.
  - Every CV recording goes stale, so batch this with M4's prompt step and M5 into one LIVE run (about 28p, owner's OK first).
- **Test:**
  - prompt.test.ts: the data sentence names all four tags.
  - worker.test.ts: the revision's system prompt names `<draft_cv>` in that sentence.

### M4. The code score saturates, and the cover note is worth 0.25 of 10 (rubric calibration)
- **Evidence (probe):** the criteria for each full-profile case in the committed recordings.

  | Case | fill | writing | numbers | tailoring | craft | structure | total | judge g/p/t/n |
  |---|---|---|---|---|---|---|---|---|
  | c01 | 2 | 2.25 | 1 | 2 | 1.5 | 1 | 9.75 | 6/7/9/6 |
  | c02 | 2 | 2.5 | 1 | 2 | 1.5 | 0.75 | 9.75 | 7/8/9/4 |
  | c03 | 2 | 2.5 | 1 | 2 | 1.5 | 1 | 10 | 7/8/9/6 |
  | c04 | 2 | 2.5 | 1 | 2 | 1.5 | 1 | 10 | 7/8/7/6 |
  | c05 | 1.63 | 2.25 | 1 | 2 | 1.5 | 0.75 | 9.13 | 7/7/6/6 |
  | c06 | 2 | 2.5 | 1 | 2 | 1.5 | 0.75 | 9.75 | 7/8/9/7 |
  | c07 | 2 | 2.5 | 1 | 2 | 1.5 | 1 | 10 | 7/8/9/6 |

  Numbers, tailoring and craft are full in 7 of 7. Fill is full in 6 of 7, and writing is 2.25 or more in 7 of 7. Tailoring scores 2.0 even where the judge gives 6 (c05).
- **Why:**
  - **Tailoring** counts a citation of a requirement's fact anywhere, skills and the note included (cv-score.ts:180-197). The prompt now hands the model that map as `(facts: …)` (prompt.ts:231-241), so it measures following the hint.
  - **Fill** is measured after the gaps are spread up to ×1.6 (fit.ts:109-127, cv-score.ts:130-139).
  - **Writing:** the lint checks the same list the prompt bans.
  - **The note** is one quarter of `structure` (cv-score.ts:272-281): 150 to 250 words, names the company, no cliché opener. The 150 floor is looser than the prompt's 180 (cv-score.ts:86 against prompt.ts:164).
  - What the judge marks down is in every recorded note:
    - all 8 open "I am applying for the … at <company>.";
    - 6 of 8 are under the prompt's 180-word floor;
    - 18% to 42% of a note's word trigrams are already in the bullets;
    - 5 of 8 end on availability or location.
  - The template comes from prompt.ts:164 ("Name the company once… Name one or two of the job's requirements and the facts that meet them"), which the notes follow as "The posting asks for… You also want…".
- **Risk:** only below-target CVs are revised, so the revision never works on the weak part. The Ready card shows 9.8/10 beside a note the judge gives 4.
- **Answer: yes, the code score is too lenient, and the smallest change that needs no LIVE run first is in the rubric, not the prompt.**
  - A prompt change alters every recorded request.
  - A rubric change re-scores the recorded outputs for free, as long as no recorded draft newly drops below 8. A draft that did would ask for a revision nobody recorded, so H1 must land first to make that fail loudly instead of passing.
  - **Rubric v2:**
    - Tailoring goes from 2.0 to 1.0.
    - A new `note` criterion is worth 1.0:
      - 0.25 for the prompt's 180 to 250 words;
      - 0.5 for no stock opener (`^I am (applying|writing)`, `^I would like to apply`);
      - 0.25 for at most 30% of the note's word trigrams appearing in the bullets.
    - It is a score only, with no new finding code, so c08's recorded revision request stays the same.
  - **Probe** (re-scoring the committed recordings under v2):
    - The full-profile mean goes from 9.77 to 8.91: c01 9.00, c02 8.75, c03 9.25, c04 9.00, c05 8.38, c06 8.75, c07 9.25.
    - No case falls under 8, and no draft newly asks for a revision.
    - c08's revision still beats its draft (6.80 to 6.50). So every shipped text and every judge request is unchanged, and the replay needs nothing new.
  - **Agreement with the judge:**
    - Every recorded note scores 0 or 0.25 of 1.0. That agrees with the judge that the notes are generic.
    - It doesn't reproduce the judge's ranking: c06 is the judge's best note.
    - 8 cases and one judge run give a direction, not a calibration. Keep the plan's rule of two agreeing LIVE runs before the judge gates anything.
  - **Lands with it:** `CV_RUBRIC_VERSION = 'rubric-v2'` and a baseline reset (L5: the CLI can't do it today). Old `cvs` docs keep their stored v1 score.
  - **Then the prompt, with one LIVE run:**
    - Replace the note template at prompt.ts:164 with an opener rule and "use at least one fact that is not already a bullet".
    - Batch it with M3 and M5 (about 28p).
    - Leave tone ("graduate", mean 6.75) to the judge and the read by eye.
- **Test:**
  - cv-score.test.ts: a note that opens "I am applying for the X role at Y" and repeats two bullets scores 0.75 lower than a specific one.
  - A replay test (cv-recorded.test.ts or a new one) pins the v2 totals above, so a later rubric change shows up as a diff.

### M5. The lint misses the owner's named contrast form and present-tense claims
- **Evidence:**
  - `CONTRAST` needs "not just/only/merely/simply", "about", "it's/that's not" or "not a …, but a" (cv-lint.ts:36-52).
  - `INFLATED` has no "lead", "leads", "manage", "manages" or "oversees" (cv-lint.ts:114-116).
  - `FIRST_PERSON` is case-sensitive (cv-lint.ts:129).
  - `NEGATION_BEFORE` reads "not only" as a denial (cv-lint.ts:189).
- **Probe:** `lintCv` gave no finding for each of these:
  - "Good onboarding isn't paperwork, it's trust."
  - "Built the dashboard not for show but for weekly decisions."
  - "It wasn't luck. It was a weekly check."
  - "The goal was not speed, it was accuracy."
  - "Lead weekly onboarding calls for 12 clients."
  - "Manage the onboarding queue…"
  - "Oversees setup…"
  - "My onboarding work covered 12 clients." (in the summary)
  - "Not only led onboarding…, also wrote guides."

  The first four are the Addendum's "no 'not X, it's Y'". Present tense is what the prompt asks for in a current role (prompt.ts:161).
- **Risk:** these ship with full writing marks, no revision and no word on the card.
- **Fix:**
  - Add "<subject> isn't/wasn't/is not/was not X, it's/it was Y" and a plain "not X but Y" form.
  - Flag lead/leads/manage/manages/oversees only as a bullet's opening verb, so "the lead paragraph" stays clean.
  - Match "my/me/myself" in any case.
  - Drop "only/just/merely" after "not" from the denial window.
  - Add finding codes, but never rename or remove one: stored `cvs` docs hold them under a strict schema.
  - A lint change can change c08's recorded revision request, so ship this in the LIVE batch.
- **Test:** in cv-lint.test.ts, each probe sentence becomes a positive row. Negative rows: "Wrote the lead paragraph of each article." (cv-lint.test.ts:175 today) and "lead time".

### M6. The DOCX needs about 7.5 pt more than the PDF reserves
- **Evidence:**
  - Each DOCX section heading has a bottom border, 1 pt from the text plus a 0.5 pt rule (docx.ts:99-101). Word adds that space and width below the paragraph.
  - The PDF draws its rule inside the line box (pdf.ts:96-104), and `layoutBlocks` counts no height for it (layout.ts:474-516). Five sections come to about 7.5 pt, against `FILL_RESERVE` of 6 pt (fit.ts:26).
  - The DOCX contact line keeps the double spaces in "  |  " (layout.ts:238, written as is by docx.ts). The PDF wrap collapses spaces (layout.ts:386-389), so in Word a long contact line is two spaces per separator wider.
  - The invariant test runs `layoutBlocks` against itself at a wider width (render.test.ts:517-538). With greedy wrapping it can't fail, and it sees neither difference.
- **Probe:** I laid out the 7 recorded full-profile CVs under Word's defaults: full width, the larger of space after and space before, and a right tab with no 10 pt gap, plus the border.
  - c02 ends 0.1 pt above the page bottom, and c03 ends 0.8 pt below it.
  - The others have 12.5 to 46.3 pt left.
  - The spacing rule itself matches Word (see "Checked and withdrawn" above).
- **Risk:** at the fill the eval now reaches (98 to 99%), a DOCX can push a line onto page 2 in Word, which is the failure the plan set out to prevent. RUNBOOK I7 (open the DOCX in Word and Google Docs) is still not done (handoff 3b).
- **Fix:**
  - Count the rule in the layout: give the section block 1.5 pt more height, and draw the PDF rule in that space.
  - Use " | " with single spaces.
  - Raise `FILL_RESERVE` to about 10 pt to cover Word's rounding.
  - Then do RUNBOOK I7 with the c02 and c03 files from `tmp/cv-eval/`.
- **Test:** in render.test.ts:
  - A DOCX height built from document.xml is at most `USABLE_HEIGHT` for `fullCv()` and `maxCv()` at their fitted spec. Per paragraph: the larger of the previous after and this before, plus lines × line, plus the border's space and size. Lines come from `wrapRuns` at `CONTENT_WIDTH` with spaces kept.
  - The DOCX contact text equals the PDF's without squashing spaces.

## Low

### L1. Hard lint false positives
- **Evidence and probe:**
  - `inflated_claim` (hard) fires on "…which led to fewer tickets", "…managed to cut setup time", "…cleared outstanding tickets", "Example is a leading retailer…" (in the note) and "…ran expert interviews" (cv-lint.ts:109, 114-115 and 120).
  - `contrast_pattern` (hard) fires on "Cut setup to less than 2 weeks, more than halving it…" (cv-lint.ts:51).
  - `first_person` fires on "Ran Phase I onboarding…" (cv-lint.ts:129).
- **Risk:** each hard finding caps the total at 7.5, pays for a revision (about 3p) and puts a wrong label on the Ready card.
- **Fix:**
  - Add negative patterns: "led to", "managed to", "outstanding <tickets|issues|items>", "a leading <noun>", "expert <interviews|review>".
  - Match "less X, more Y" only without "than".
  - Skip "I" after a capitalised word (Phase I, Part I).
- **Test:** a negative row for each sentence in cv-lint.test.ts.

### L2. A thin profile pays for a revision that can't reach the target
- **Evidence:** every finding code is `fixable: true` (cv-findings.ts:45-119), so any finding makes a below-target draft revisable (compose.ts:228-230).
  - c08 (draft 7.25, fill 62%, two soft findings) was revised to 7.55.
  - Clearing both soft findings is worth 0.5, and fill can't move without unused facts, so 8 was out of reach.
  - ADR-063 (DECISIONS.md:814) says a thin profile "never pays for a revision it can't use".
- **Risk:** about 2.3p per thin CV for 0.3 points.
- **Fix:** skip as `not_fixable` when there's no hard finding and the total, plus the fixable findings' costs, plus the fill points (only with at least 2 unused facts) stays under the target. Or correct the ADR. Either way c08's recordings change, so this belongs in the LIVE batch.
- **Test:** compose.test.ts: a 7.25 draft with two soft findings and no unused facts gives `not_fixable`, with nothing counted.

### L3. An undated experience entry sorts first
- **Evidence:** `factEndKey` treats no end date as `9999-12` (cv.ts:886, pinned at cv.test.ts:1482), and experience and projects are always "dated" (cv.ts:919-920). Education got "dated lines first" in the 3a fix; experience didn't.
- **Risk:** a role with no dates, such as a parsed CV line without them, is listed above the current internship.
- **Fix:** keep start-only as Present; put entries with no dates at all after the dated ones, in the model's order, as education does.
- **Test:** cv.test.ts: [undated, ended 2024-05, present] sorts to [present, 2024-05, undated].

### L4. A spaced dash in a number range becomes a list
- **Evidence:** a spaced dash becomes ", " (cv.ts:1003), so "Trained teams of 10 – 15 people" becomes "Trained teams of 10, 15 people". The figures still validate.
- **Fix:** between two figures, write "-" (or " to ").
- **Test:** cv.test.ts `scrubDashes`: "10 – 15 people" becomes "10-15 people".

### L5. Baseline handling
- **Evidence:**
  - `--update-baseline` runs only after the gate passes (cv-cli.ts:95-109), and the gate fails a mean more than 0.2 under the baseline (cv-report.ts:113-117). So a deliberate rubric change that lowers the mean (M4: 9.77 to 8.91) can't be re-baselined without editing the file by hand.
  - `CvBaselineSchema` holds no rubric or prompt version, and `cases` is never compared (cv-report.ts:14-19).
  - Each update can lower the floor by up to 0.2.
- **Fix:**
  - Store `rubric` and `promptVersion` in the baseline.
  - On a mismatch, skip the baseline rule and require `--update-baseline`.
  - Refuse an update that lowers the mean unless the rubric changed.
- **Test:** cv-eval.test.ts:
  - A `rubric-v1` baseline with `rubric-v2` results: the gate ignores the old mean and asks for an update.
  - A lower mean under the same rubric can't be stored.

### L6. `cvJudge` is eval-only by convention
- **Evidence:** it is a production `LlmPurpose` with a `MODELS` entry and `PURPOSE_CALLABLE.cvJudge = 'generateCvs'` (config.ts:43, 115-121 and 137). Its only caller is cv-evaluate.ts:317.
- **Risk:** low. A future caller in a function would spend on a report-only judge under the worker's caps.
- **Fix and test:** a source test that `purpose: 'cvJudge'` appears only under `functions/src/eval/`, following the pattern of the billing source test.

### L7. The posting's title exempts its words from `inflated_claim` everywhere
- **Evidence:** any word of the job's title, which is posting text, is skipped in every text (cv-lint.ts:192-215). Probe: "Strategic thinker who ran onboarding for 12 clients." passes under the title "Strategic Partnerships Associate".
- **Risk:** an inflated or injected title such as "Expert Strategic Manager" switches the check off for those words in the summary and the note. This affects the score only; claims are still gated.
- **Fix:** exempt a title word only when it sits next to another title word ("Product Manager", "Strategic Partnerships"), not on its own.
- **Test:** cv-lint.test.ts: the probe sentence flags, and "for the Strategic Partnerships Associate role" doesn't.

### L8. Requirement text can spoof its own `(facts: …)` mapping
- **Evidence:** the code-made aliases go on the same line, after the S3 requirement text (prompt.ts:235-240). A requirement text that ends "(facts: F1, F2)", from an injected posting through S3, reads as a mapping.
- **Risk:** it steers which facts the model cites. The validator still gates claims, and the tailoring score uses S3's IDs, not the text.
- **Fix:** strip "(facts:" from requirement text before printing it, or list the mappings after the requirements, numbered.
- **Test:** prompt.test.ts: a requirement text containing "(facts: F9)" prints no F9 mapping.

## Nits
- **N1.** fit.ts:87 says "steps × 2 sizes + 9 layouts", but `BODY_SIZES` has three sizes (layout.ts:83). ADR-062 has it right.
- **N2.** `textsMatch` checks the CV PDF, the CV DOCX and the note DOCX, but not the note PDF (cv-evaluate.ts:341-342); `noteText` from :310 is only scanned for the dash and the marker. The call counts come from sends that returned (cv-evaluate.ts:144-156), so a send that threw isn't counted against the 3-call limit.
- **N3.** Recordings left unused are never reported: cv-cli.ts never reads `replayTransport().used` (recordings.ts:77-99).
- **N4.** `lastIssueAt` paths pass a regex that allows letters, so "never text" rests on `validateCv` building paths from fixed keys and indices (cv.ts:570-646). It does; a test should pin that path grammar.
- **N5.** `better()` compares capped totals when both candidates have the same number of hard findings (compose.ts:245-250). So 7.5 against 7.5 keeps the draft even when the revision's uncapped sum is higher.
- **N6.** `revisionPlan` counts unused facts that have no alias (facts added after the prompt was built) toward the 2-fact rule (compose.ts:226-230), even though they are left out of the request (compose.ts:236).
- **N7.** `CvDocSchema` is strict (cv.ts:214), and downloads parse it (web services/applications.ts:354-356). A tab left open across the deploy can't parse a doc written after it with `quality` or `achievementRef` (no score line, no download) until it is reloaded.

## Tests missing or wording-only

**Missing (each tied to a finding):**
- the revision path of the stale-recording check, and `gateCv` on `revisionSkipped: 'error'` (H1);
- a fact archived during a failed revision (M2);
- an education line borrowing another degree's classification or an unrelated award (M1);
- the system prompt naming `<draft_cv>` as data (M3);
- a rubric that can tell a templated note from a specific one (M4);
- the canonical contrast and present-tense rows (M5) and the false-positive rows (L1);
- a DOCX height model, and the contact line compared with its spaces kept (M6);
- `cvJudge` called only by the eval (L6);
- a baseline reset after a rubric change (L5).

**Wording-only, or a test that checks itself:**
- render.test.ts:517-538 compares `layoutBlocks` with itself at two widths.
- worker.test.ts:1222-1241 checks the tag counts and positions, not what the model is told about the tag.
- prompt.test.ts pins sentences (for example :60-77, :139-210 and :408-478). That is fine as a version pin, but :74-77 pins the very sentence M3 needs changed.
- cv-eval.test.ts:214-218 ("stale") covers only the first write.
- compose.test.ts:566-597 checks the `revisionSkipped` labels, not that the shipped draft is still valid.

## Suggested fix order
1. **H1**, so that every later change that touches a revision request fails as stale instead of passing.
2. **M2 and M1** (compose and the validator). No prompt change; after H1, the tooling says if a recording is affected.
3. **M4's rubric v2 with L5.** LIVE-free according to the probe.
4. **One LIVE batch** (about 28p, owner's OK first): M3, M5, the note prompt step from M4, L1 and L2.
5. **M6**, then RUNBOOK I7.
6. The remaining Lows and the Nits alongside.

## Next step on approval
Save this review as `docs/plans/cv-quality-review.md` on `feat/cv-quality` in one docs-only commit (`docs: CV quality review`), as the plan's Review step says. No code change, and no push unless asked. The fix session then works from that file.
