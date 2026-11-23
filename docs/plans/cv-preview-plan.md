# Plan: CV preview in the app before download

## Context
ROADMAP parking lot: "CV preview in the app before download (small; first after M8)". Today the Ready card (`web/src/features/pipeline/ApplicationCard.tsx`, `Ready`) only offers four downloads. The owner has to download the PDF and open it elsewhere to check it, which is clumsy on a phone. This adds an in-app preview of the **stored CV PDF**. There is no model call, no server re-render, no new function and no change to the rules, CORS or indexes.

Branch `feat/cv-preview` from `origin/main` (3310a34), opened as a **draft PR** titled "feat: CV preview (draft, merge after v1.0.0 and #42)". Merge it only after v1.0.0 is tagged (#41) and #42 has merged.

## Approach (recommended)
**Render the stored PDF with pdf.js (`pdfjs-dist`) to a `<canvas>`, loaded lazily when Preview is pressed.**

A native `<iframe>`/`<object>` with a `blob:` URL is not an option:
- Android Chrome has no inline PDF viewer, so the preview would be blank or turn into a download. iOS shows only part of the file.
- The CSP blocks it: `frame-src` doesn't list `blob:` and `object-src 'none'`. The CSP is report-only today, but it would still break once enforced.

pdf.js works the same on phone and laptop and needs no CSP change. The worker is same-origin, so `worker-src` falls back to `script-src 'self'`.

Data path (all of it existing code, reused):
`CvPreview` → `services/cv-preview.ts` → existing `downloadCvFile({ cvId, kind: 'cv', format: 'pdf', … })` (`web/src/services/applications.ts:311`). That call:
- reads the path from `cvs/{cvId}` (`loadCvDoc`, zod-parsed),
- makes one `getBlob` attempt within `DOWNLOAD_TIME_LIMIT_MS` = 30 s (`web/src/services/firebase.ts:42`, also the Storage retry window),
- is checked by the existing owner-only rule `match /cvs/{allPaths=**} allow read: if isOwner()` (`storage.rules:41`), already tested in `tests/rules/storage.rules.test.ts:30`,
- uses the GET that `storage.cors.json` already allows (v0.7.4).

`applications.ts` is **not edited**.

## Files

### New (not touched by #41 or #42)
- **`web/src/services/cv-preview.ts`**
  - `loadCvPreview({ cvId, headerName, company })` calls `downloadCvFile` and returns `{ blob, fileName }`.
  - It refuses a blob over `PREVIEW_MAX_BYTES` (5 MiB, mirrors `MAX_CV_BYTES`) before parsing.
  - `previewErrorMessage(error)` gives the user-facing message for each failure:

    | Failure | Message |
    |---|---|
    | not-found / `storage/object-not-found` | Same wording as the download error: "That file isn't there any more. Regenerate the CV to make a new one." |
    | `TimeoutError` / `storage/retry-limit-exceeded` | "Couldn't load the preview. Try again later." |
    | Too large | "Download it instead" |
    | Bad PDF | "This PDF couldn't be shown here. Download it instead." |
    | Viewer chunk failed to load | "Couldn't load the viewer. Check your connection and try again." |
    | Anything else | Check your connection |

  - It logs `logError('cv_preview.failed', { code, step })` with scalars only and never any text.
  - Constants: `PREVIEW_MAX_BYTES`, `PREVIEW_MAX_PAGES` = 3 and `PREVIEW_RENDER_LIMIT_MS` = 15 s (the parse and render deadline).
- **`web/src/lib/pdf-preview.ts`**
  - A thin adapter over a lazy `import('pdfjs-dist')`, plus `pdf.worker.min.mjs?url` for `GlobalWorkerOptions.workerSrc`.
  - `openPdf(bytes)` uses `isEvalSupported: false` and system fonts. The renderer uses `StandardFonts.Helvetica` (`functions/src/cv/render/pdf.ts:27`), which is not embedded.
  - `renderPage(doc, n, canvas, cssWidth)` caps the bitmap at 2,000 px wide and returns a cancellable task.
  - `pageText(doc, n)` builds lines from `getTextContent` (`hasEOL`).
  - `closePdf(doc)` calls `destroy()`.
  - The page loop is bounded by `PREVIEW_MAX_PAGES` and the render deadline.
- **`web/src/features/pipeline/CvPreview.tsx`**
  - **Button:** a "Preview CV" button (`Eye` icon, secondary).
  - **Dialog:** the existing Radix `Dialog` from `web/src/components/ui/dialog.tsx`, which gives the focus trap, Esc to close and focus returning to the button.
    - Phone: full screen through a `cn`/twMerge override of `DialogContent`: `inset-0`, `h-dvh`, no radius.
    - `md` and up: centred, `max-w-3xl`, `h-[90dvh]`.
  - **States:**
    - *Loading:* an A4-ratio `Skeleton` with `role="status"` "Loading the preview…" and `aria-busy`.
    - *Ready:* each page is a `<canvas role="img" aria-label="CV page 1 of 1">`. A page count line flags more than one page ("This PDF has 2 pages"), which ties to R10's one-page rule. A `<details>` "Text of the CV" shows the PDF's own text as plain React text, never HTML.
    - *Empty:* zero pages gives "This PDF has no pages. Regenerate the CV." With no `currentCvId` there is no button at all, and the existing message stays.
    - *Error:* a message with `role="alert"` and a **Try again** button. When the blob was fetched but couldn't be drawn, a **Download PDF** button is also shown.
  - **Controls:**
    - Zoom − / Fit / + (75–200 %, live percentage, disabled at the limits).
    - The scroll area is `tabIndex=0` with an `aria-label`, so it is reachable by keyboard (a Lighthouse rule).
    - **Download PDF** inside the dialog uses `saveBlob` with the blob already fetched, so there is no second read.
  - **Lifecycle:**
    - The blob is kept per `cvId` while the card is mounted, so reopening doesn't refetch and a new version does.
    - On close or unmount it cancels the render, destroys the document and ignores late results through a `current` flag.
    - Effects have cleanups, so it passes `read-loops.test.ts`.
- **Tests (new files, so `PipelinePage.test.tsx` and `fixtures.ts` stay untouched):**
  - `web/src/services/cv-preview.test.ts`: asks for the CV PDF of the current `cvId`; 30 s limit with fake timers turns into the timeout message; not-found mapping; size cap stops before parse; log fields are scalar and carry no text.
  - `web/src/lib/pdf-preview.test.ts` (`pdfjs-dist` mocked): `isEvalSupported: false`; worker src set once; page cap holds for a 50-page document; render deadline cancels the task; the bitmap cap; text lines from `hasEOL`; `destroy` on close.
  - `web/src/features/pipeline/CvPreview.test.tsx` renders `ApplicationCard` with a Ready view from the existing `makeApplication`. It checks:
    - the button shows only on Ready with a `currentCvId`;
    - Enter and Space open the dialog;
    - the loading status shows;
    - the canvas is labelled and the page count is right, including the multi-page warning;
    - the text toggle works;
    - each error state shows its message and Try again refetches;
    - Esc closes and focus returns to the button;
    - reopening doesn't refetch, while a new `cvId` does;
    - the in-dialog download calls `saveBlob` with no second `downloadCvFile` call;
    - the zoom limits hold;
    - nothing calls Firebase directly.

### Edited (not in #41 or #42)
- **`web/package.json` + `package-lock.json`:** add `pdfjs-dist`, pinned exactly to the current release that is at least 2 weeks old. Today that is 6.4.299 (3 Oct 2026); confirm at build time. It must be ≥ 4.2.67 (CVE-2024-4367). `npm run audit` must be clean. Note: Dependabot #38 and the `firebase-13.0.0` branch also touch the lockfile.
- **`scripts/check-bundle.ts`:**
  - Scan `.mjs` assets too. Today it filters `.js` only, so the worker would slip past the check.
  - Allow exactly one named exception, the pdf.js worker asset, with its own cap (the measured size plus a margin, set in the ADR).
  - Fail if any initial file contains pdf.js (marker: `GlobalWorkerOptions`), which proves Today's `hf:usable` path is unaffected.
  - If the main pdf.js chunk is over 500 kB, it gets the same named treatment. The spike measures this.

### Shared with PR #42 (unavoidable; kept minimal)
| File | This PR's change | #42's change | Conflict risk |
|---|---|---|---|
| `web/src/features/pipeline/ApplicationCard.tsx` | 1 import line after `./labels`; 1 JSX line `<CvPreview cvId headerName company />` after the `downloadError` block in `Ready` | `@hireframe/shared` + `@/services/applications` imports, `QualityLine`, the scores effect after `const cvId`, the line before `<ul aria-label="Downloads">` | Low (separate hunks) |
| `CHANGELOG.md` | `[Unreleased]` entry | `[Unreleased]` | Text, redo on rebase |
| `docs/ARCHITECTURE.md` | Web client: preview row | yes | Text |
| `docs/DECISIONS.md` | ADR-065 (next after #42's 062–064; re-check at rebase) | ADR-062–064 | Text |
| `docs/PRD.md` | R10 AC line (below) | R10 AC line | Adjacent, redo on rebase |
| `docs/ROADMAP.md` | remove the parking-lot item | yes | Text |
| `docs/SECURITY.md` | pdf.js row (below) | yes | Text |
| `docs/RUNBOOK.md` | step 89: Lighthouse also on Pipeline + snapshot with the dialog open; I7: preview before download | yes | Text |
| `CLAUDE.md` | the `check:bundle` line mentions the worker exception | yes | One line |

PR #41 also touches CHANGELOG, ARCHITECTURE, DECISIONS, ROADMAP, RUNBOOK and SECURITY, and no code file this PR touches. **Avoided entirely:** `web/src/services/applications.ts`, `PipelinePage.test.tsx`, `fixtures.ts`, `functions/src/cv/render/*`, `packages/shared`, the rules and `firebase.json`.

All doc edits go in **one final `docs:` commit**. On rebase it can be dropped and rewritten on top of #42's text instead of hand-merging conflicts.

## Commits
1. `chore: add pdfjs-dist to web` (pin and audit). Spike first: measure the chunk and worker sizes in `vite build`, and check pdf.js under the Hosting emulator's CSP for report-only violations. If either fails the assumptions above, stop and report.
2. `feat: pdf preview adapter` with `lib/pdf-preview.ts` and its tests.
3. `feat: cv preview service` with `services/cv-preview.ts` and its tests.
4. `feat: preview the CV on the Ready card` with `CvPreview.tsx`, the 2-line `ApplicationCard` change and the tests.
5. `build: bundle budget covers .mjs and the pdf.js worker` (`check-bundle.ts`).
6. `docs: CV preview` (ADR, PRD, CHANGELOG, ARCHITECTURE, SECURITY, RUNBOOK, ROADMAP, CLAUDE.md).

## PRD criteria
- **R7 (Dashboard):** responsive on phone and laptop (full-screen sheet / centred dialog); Lighthouse accessibility ≥ 95 on Pipeline with a Ready card, plus a DevTools Lighthouse *snapshot* with the dialog open; every control keyboard-operable (Radix focus trap, Esc, focusable scroll area, labelled zoom buttons); loading, empty and error states announced (`status`/`alert`); "usable in ≤ 2 s" unaffected because pdf.js is lazy and kept out of the initial JS by `check:bundle`.
- **R10 (CV tailoring):** add the AC "The owner can preview the stored CV PDF on the Ready card (phone and laptop) before downloading it: owner-only, read from Storage with the 30 s limit, no model call and no re-render; the preview shows the page count, so a CV over one page is visible." It supports the existing "output fits one page" AC and the SECURITY line "The user reviews before download".

## ADR-065 (proposed): CV preview renders the stored PDF with pdf.js on the client
- **Decision:** lazy pdf.js canvas render of the stored PDF through `downloadCvFile`. Owner-only by the existing rules, 30 s limit, `isEvalSupported: false`, page and size caps, text from the PDF itself as the text alternative.
- **Rejected:**
  - iframe/object with a blob URL: no Android inline viewer, and the CSP `frame-src`/`object-src` blocks it.
  - A server-rendered image: a new model-free render path or function.
  - Rendering from the `cvs` content: that would not be the file that gets sent.
- **Consequences:** a new dependency, a lazy chunk and a worker over the 500 kB chunk rule (named exception and cap in `check:bundle`), fonts rendered from system fonts (Helvetica isn't embedded), no CSP change.

**SECURITY.md row:** pdf.js runs in the browser on our own generated PDF, pinned ≥ 4.2.67 with eval off. The worker is same-origin. No new host, rule, CORS, IAM or write path.

## New function?
**None needed.** There is no trigger, schedule, callable or rules change, so the "Every new function" steps don't apply.

**`STATUS.md` does not exist** on `main`, `feat/m8c2-hardening` or `feat/cv-quality`. The nearest checklists are CLAUDE.md working-method step 6 and m8c-plan's "Every release" list (invokers, C14, the runbook steps).

**PR body (step 6 check):**
- no event trigger;
- nothing reschedules or re-enqueues;
- the page loop is bounded by `PREVIEW_MAX_PAGES` and `PREVIEW_RENDER_LIMIT_MS`;
- the fetch is one attempt within 30 s;
- `maxInstances` is not applicable because no function is added.

## Risks
1. **Bundle:** the pdf.js worker (~1 MB+) and maybe the main chunk exceed the 500 kB rule. Mitigation: lazy only, named caps, `.mjs` now scanned. The spike measures it first.
2. **Security of pdf.js:** past font-eval RCE (CVE-2024-4367). Mitigation: pinned version, `isEvalSupported: false`, the input is only our own stored PDF, `npm run audit` gate.
3. **Fidelity:** non-embedded Helvetica renders with a system font, so spacing can differ slightly from Acrobat. The preview says so in its description ("Download the PDF to see it exactly as sent"). If the spike shows bad output, serve pdf.js `standard_fonts` as static assets (extra ~100–200 kB lazy).
4. **Phone memory and canvas limits:** bitmap capped at 2,000 px wide (about 5.6 M pixels, under iOS's 16.7 M limit); one render at a time, cancelled on zoom or close.
5. **CSP:** report-only today; verify zero violations under the Hosting emulator before relying on "no CSP change".
6. **Rebase:** two small hunks in `ApplicationCard.tsx`, and #42's `QualityLine` sits just above them. The docs are rewritten after the rebase. The ADR number may shift.
7. **Lighthouse can't open the dialog by itself:** use snapshot mode by hand (RUNBOOK step 89), plus the role and keyboard tests in Vitest. The repo has no axe tooling, and this PR doesn't add it.
8. **Extra reads:** opening the preview adds one `cvs` doc read and one Storage GET. Reopening is cached per `cvId`.
9. **Scope:** cover-note preview is not included. The component takes `kind`, so adding it later is trivial: it goes to the parking lot.

## Rebase order
1. **#41** (`feat/m8c2-hardening`) merges and v1.0.0 is tagged.
2. **#42** (`feat/cv-quality`) rebases onto `main` and merges.
3. **This branch:**
   - Drop the `docs:` commit and `git rebase origin/main`. Expect at most a trivial `ApplicationCard.tsx` hunk.
   - Re-run the full gate. Rewrite the docs commit on #42's text: confirm the ADR number, the CHANGELOG version and the PRD line under #42's.
   - Mark the PR ready and merge.

Never stack on #42. Branch from `main` and rebase after #42 merges.

## Verification
- **Gate:** `npm run format:check`, `npm run check`, `npm run test:rules` (unchanged rules, still green), `npm run build`, `npm run check:bundle` (prints worker and chunk sizes), `node scripts/smoke-functions-bundle.ts`, `npm run audit`.
- **Dev check:** `npm run dev`, then Pipeline → the seeded Ready application (real PDF from the fake worker) → **Preview CV**.
  - Laptop width and a 360 px phone width in DevTools.
  - Keyboard only: Tab, Enter, zoom, scroll, Esc, focus returns.
  - Error paths: stop the Storage emulator for the error state; delete the file in the emulator UI for not-found.
- **CSP:** `vite build` then the Hosting emulator; open the preview and check the console for no CSP report-only violations.
- **Lighthouse:** Mobile, Accessibility on Pipeline ≥ 95, and a snapshot with the dialog open ≥ 95.
- **Real phone (after merge and deploy):** open the preview on the owner's phone on mobile data, and record it in RUNBOOK I7.

## Addendum (review 19 Oct)
Plan approved with these changes. They override the text above where they differ.

1. **Fonts:** serve pdf.js `standard_fonts` as lazy same-origin assets from the start (`standardFontDataUrl`, `useSystemFonts: false`). The spike measures their size; add them to the `check:bundle` named caps.
2. **Browser support:** the spike also checks the Vite build target and pdf.js's minimum Safari and Chrome versions. If an older phone browser would fail, stop and report.
3. **Dev seed:** confirm the emulator seed has a Ready application with a real PDF. If not, add a dev-only fake fixture PDF (no personal data) so the dev check works.
4. **Download in the dialog:** the in-dialog Download PDF must have the same side effects as the existing PDF download button (file name, events, logs). Read `downloadCvFile`'s callers first.
5. **Rebase:** after rebasing on #42, re-run the dev and fidelity checks on a v2 PDF before marking ready.
6. **Lockfile:** never hand-merge `package-lock.json`: take main's and run `npm install`. Merge order after v1.0.0: #42, the deps branch, this branch.
7. **Decision (browser support, option A):** use `pdfjs-dist/legacy` (pinned 6.4.299) for the module and the worker. Documented floor for the preview: Chrome 125+, Safari 18+ (the owner's phone is above it). No user-agent sniffing: if the viewer import, the document open or the render throws, show the existing fallback message with Download PDF; the rest of the app is unaffected. A test covers that fallback. `standard_fonts` load lazily and only the files pdf.js requests; the ADR records which files a generated CV loads.
