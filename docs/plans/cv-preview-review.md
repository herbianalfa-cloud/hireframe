# Review: PR #43 (feat/cv-preview), report only

Read the diff against origin/main, the built `web/dist` and `functions/deploy`, the pinned pdf.js files and the lockfile. Nothing was edited.

## High
None.

## Medium
1. **The document and worker leak if the dialog closes while the PDF is opening.** `web/src/features/pipeline/CvPreview.tsx:84-86`: the cleanup (`:104-107`) runs before `held.doc` is set, so it closes nothing. Then `held.doc = opened; if (!isLive()) return;` returns without `closePdf`. Repro: press Preview, then press Esc before `openCvPreview` resolves. The `PDFDocumentProxy` and its Web Worker, which holds the CV bytes, stay alive until the page reloads, and each such reopen leaks another one. Fix: in the `!isLive()` branch, call `void closePdf(opened)`. No test closes the dialog during the open.
2. **"Too large" says "Download it instead" but the dialog has no Download button.** `services/cv-preview.ts:85` together with `CvPreview.tsx:68` (`canSave: false`) and `:219` (the toolbar button is disabled while `!stored`). The `size` failure is raised after the blob was fetched, but the blob is dropped. Either keep the file for `size` (`canSave: true`) or change the wording to point at the card's Download PDF. No component test covers the `size` step.
3. **The "no eval path" claim and its test are weaker than they read.**
   - `web/src/lib/pdf-preview.test.ts:95-96` greps the **unminified** `pdf.worker.mjs`, but the app ships `pdf.worker.min.mjs` (`pdf-preview.ts:1`).
   - The regex misses `Function(x)` without `new`, `.eval(` (it excludes `globalThis.eval(` on purpose), `(0,eval)(` and `window["eval"]`. It would catch the CVE-2024-4367 shape (`new Function(`), but not a real eval written another way. The shipped min worker already contains `Function("return this")()`, a constant webpack global shim that isn't driven by the PDF, and the test can't see it.
   - pdf.js 6.4.299 still turns PDF input into code another way: with `useWasm` on (the default, not set at `pdf-preview.ts:50-55`), Type 4 PostScript functions go through `compilePostScriptToWasm` → `new WebAssembly.Module(bytes)` (worker.mjs ~l.37446/38004). That runs in a sandbox and falls back to JS on failure, but it is runtime code generation from the PDF. Under an enforced CSP it would need `'wasm-unsafe-eval'`.
   - Suggest: run the test on the min file with a broader pattern, also assert `pdfjs-dist` is exactly `6.4.299`, and either pass `useWasm: false` or state the WASM path in ADR-065 and the SECURITY row. Today `pdf-preview.ts:43`, ADR-065 "Eval" and the SECURITY row all say there is no such path.
4. **A pdf.js patch bump fails loudly but not clearly, and it arrives through Dependabot's grouped PR.**
   - `scripts/check-bundle.ts:43`: the main chunk (487.6 kB, 12 kB margin) gets the generic message `pdf-XXXX.js is 501.2 kB (max 500.0 kB)`. It doesn't say this is pdf.js or point to ADR-065 and what to do (named cap vs. investigate).
   - `.github/dependabot.yml` groups every npm minor/patch weekly, so the next `pdfjs-dist` release lands mixed in with unrelated bumps. The bump would also move the versioned fonts folder and the worker hash. Suggest an `ignore` entry for `pdfjs-dist`, or its own group, so the exact pin stays deliberate, plus a pdf.js-specific message (or a named cap) for the main chunk.

## Low
5. **An old render can resize the canvas under a new one.** `lib/pdf-preview.ts:89-93`: `canvas.width/height/style` are set before the `if (cancelled) return` check. If a zoom click cancels while `getPage` is pending, the old run still resizes the canvas, which clears it, after the new run may have started drawing on it. Move the check to before the writes.
6. **A timeout during `getPage` doesn't stop the render.** `lib/pdf-preview.ts:103-105`: `cancelTask` is still undefined then, and `cancelled` isn't set, so the orphan run goes on to `page.render`. Set `cancelled = true` on timeout too.
7. **`check:bundle`'s "no pdf.js in initial files" check can pass vacuously, and its marker is ambiguous.**
   - `scripts/check-bundle.ts:28,60-64`: nothing asserts that the marker exists in some lazy chunk. If a future pdf.js stops carrying `GlobalWorkerOptions` verbatim, the check passes silently.
   - Our own adapter also carries the marker: the built `PipelinePage-*.js` contains `GlobalWorkerOptions.workerSrc=`. So it detects the adapter as well as pdf.js.
   - Suggest asserting exactly one non-initial chunk contains the marker, or keying on a pdf.js-only string.
8. **`check:bundle` collects initial files with `\.js"` only** (`scripts/check-bundle.ts:50`). An initial `.mjs` modulepreload would escape the marker scan and the gzip budget. The `index.html` regex at `:65` only partly covers this.
9. **The scroll area has `aria-label` on a `div` with no role** (`CvPreview.tsx:224-228`). ARIA 1.2 prohibits names on generic elements, and axe can flag `aria-prohibited-attr`, which matters for the ≥95 Lighthouse target in RUNBOOK step 89. Use `role="region"` (or `group`).
10. **The browser floor (Chrome 125+, Safari 18+) has no cited source.** The package's README and package.json state none. ADR-065 calls it "the legacy build's stated support", and the PRD R10 line now carries it as acceptance text. Cite where it comes from, or call it "tested on".
11. **Supply chain: fine, with notes.**
    - `@napi-rs/canvas@1.0.11` and its 11 platform packages are all `optional`, MIT and without install scripts.
    - They are not in the web bundle. The `pdf-*.js` chunk only holds pdf.js's Node-guarded `createRequire(...)("@napi-rs/canvas")` string, which is dead in the browser.
    - They are not in the functions bundle. `functions/deploy/chunks/pdfjs-*.js` is unpdf's own pdf.js, which uses a Proxy shim and no require, and `functions/deploy/package.json` lists only the firebase deps.
    - They are installed, but never loaded, on every `npm ci`, including `deploy.yml:45` (the linux-x64-gnu prebuilt binary).
    - `npm audit --omit=dev` (ci.yml:101) covers them, because `pdfjs-dist` is a runtime dependency.
    - Worth saying in the ADR and PR body: if `npm ci --omit=optional` were added to the deploy job, the binary would never land there.
12. **Tests: missing cases.**
    - Close or unmount during the open (would catch #1).
    - The `size` step in the component (#2).
    - An open timeout → message plus Download.
    - Zero pages: no Download or Try again offered; check that this is intended.
    - Try again after a render error closes the old doc and reopens.
    - A zoom change calls the previous render's `cancel`.
    - Unmount while rendering cancels it.
    - The worker grep on the shipped min file, plus the version pin (#3).
    - `check-bundle.ts` has no tests: the worker-count, fonts-folder and marker failures are unexercised.

## Nit
13. `services/cv-preview.ts:60-66`: `doc` is only assigned after `openPdf` resolves, so `if (doc) await closePdf(doc)` is dead code. `loadViewer()` also runs twice (once there, once inside `openPdf`). This is harmless.
14. `scripts/check-bundle.ts:21`: the comment says fonts total "816 kB", but the measured total is 798.0 kB. ADR-065 says "16 font files", which includes `LICENSE_FOXIT` and `LICENSE_LIBERATION` (14 fonts plus 2 licences).
15. `scripts/check-bundle.ts:74`: if a `pdfjs-*` folder has no `standard_fonts/`, `readdirSync` throws a stack trace instead of a budget message.
16. `CvPreview.tsx:296-298`: a `sr-only` `Loader2` with `aria-hidden` does nothing. Remove it.
17. `CvPreview.tsx:260-264`: with zero pages the zoom buttons stay enabled (`status === 'ready'`).
18. `CvPreview.tsx:274-282`: the canvases aren't linked to the text alternative (`aria-describedby` pointing at the `<details>` content). The text is real text, which is good.
19. `CvPreview.tsx:268`: the multi-page warning uses `role="alert"`. A non-error note fits `role="status"` better.
20. `lib/pdf-preview.ts:5`: `lib/` imports from `@/services/resilience` (a layering inversion). `web/vite.config.ts:46` hard-codes `/assets/...`, while `fontBaseUrl` uses `BASE_URL`. That is consistent only while `base` is `/`.

## Checked and OK
- **1. Read path:** the only read is `downloadCvFile` (`cv-preview.ts:45`). No Firebase import in components, and a test guards it (`CvPreview.test.tsx:263-267`). The diff touches no `storage.rules`, `firestore.rules`, `firebase.json`, CORS file or function.
- **2. pdf.js input:** pinned exactly to `"6.4.299"` (`web/package.json`), legacy build for both module and worker. The input is only the stored blob (`openCvPreview(stored.blob)`). XFA is off, `useSystemFonts: false`, and fonts are same-origin and versioned. The dev font middleware only serves names on the directory listing, so there is no path traversal.
- **5. Lifecycle:** the `live` flags guard late results. Zoom and close cancel renders. The cache is per `cvId` (`:52-54`), and a test shows a new version reads again. The only blob URL is in `saveBlob`, which revokes it. No timers or intervals, so `read-loops.test.ts` is unaffected. The exception is the leak in #1.
- **6. Fallback:**
  - Import, open and render failures show a message plus Download (tested).
  - A fetch timeout and not-found map to the download wording, with no Download (tested).
  - An open or render timeout maps to "couldn't be shown" plus Download.
  - Oversize: see #2. Zero pages: a message only.
- **7. Accessibility:**
  - Focus: Radix trap, Esc, and focus returns to the button (tested).
  - Labelling: the canvases are labelled `role="img"`, the text alternative is plain React text in `<details>`, and the zoom buttons are labelled.
  - Zoom: 75–200 % with the ends disabled (tested).
  - The scroll area is `tabIndex=0` (see #9).
- **8. Logs:** `cv_preview.failed` logs `{ step, code }` only. `code` is the Firebase `code` string or `Error.name`. No message, CV text or path (test at `cv-preview.test.ts:105`).
- **10. Docs:**
  - ADR-065 matches the code: caps, fonts, check:bundle, legacy build and no `isEvalSupported`. The exceptions are #3, #10 and #14.
  - The PRD R10 line, CHANGELOG, ARCHITECTURE, ROADMAP parking lot and CLAUDE.md `check:bundle` line match.
  - RUNBOOK I7 says "Esc or Close", and the dialog does render a Close button (`hideClose` defaults to false).
  - SECURITY row: accurate apart from the eval/WASM wording in #3.
