# PR #39 (8C1) re-review: b6681d9..5637ef5

## Context
- **Scope:** the 15 fix commits since the first Opus review (`docs/plans/m8c1-review.md`, at `b6681d9`), up to `5637ef5`.
- **Method:**
  - Read the full source, test and doc diffs.
  - Checked each of the 24 findings against its commit in the PR table.
  - Re-ran the comment stripper in `node` against bypass snippets.
  - Checked that `jsonPayload.event` and `step` exist in the log sink (`log.ts`, `handler.ts`), so the new `gcloud logging read` columns fill.
- **Read-only.** Nothing was edited, committed or run beyond `git`, `gh` and one `node -e`.

## Verdict: no blockers, ready to merge
- All 24 findings are addressed as described, including the six differences the fix session listed (#5, #6, #7, #14, #21, #22). I agree with each one:
  - `getText` was the right way to do #7.
  - The `.trim()` before the `PROJECT_ID` check is harmless, because the pattern stays strict.
  - Mapping a body-read error to `timeout` or `network` keeps the PUT retry safe, because the PUT is idempotent.
- **The gate gap is a non-issue.** `5637ef5` touches only `billing/endpoint.test.ts` and `http/client.test.ts` (3 lines). Test files aren't in the functions bundle or the web bundle, so the build, check:bundle, smoke and audit results still hold. `npm run check` (lint and tests) ran after it.
- **Code checks that hold:**
  - On a redirect, the forbidden-host check now runs first: before the PUT refusal, the hop limit and the scheme check.
  - Redirects are https-only.
  - The plain-http list is empty by default and matches the exact `url.host` with no userinfo.
  - Credentials are dropped when a redirect changes origin. Only `Authorization` (Reed, hydrate, billing) and `Metadata-Flavor` carry secrets in `functions/src`, so the strip list is complete.
  - Each new test fails on the old code, as claimed.

## New nits (optional, none blocking)
1. **The comment stripper is still fooled by regex literals.**
   - **Where:** `functions/src/billing/endpoint.test.ts`, `stripComments`.
   - **What:** a `/*` or `//` inside a regex literal is treated as a comment, which hides the code after it. I confirmed both in node:
     - `const r = /[/*]/; topic.publish(x); const q = /[*/]/;` strips to `const r = /[]/;`;
     - `/https:\/\//` drops the rest of its line.
   - **Severity:** this fails open, but only in a test heuristic. IAM is still the real backstop.
   - **Fix:**
     - Strip comments with the TypeScript parser: `ts.createPrinter({ removeComments: true }).printFile(ts.createSourceFile(name, source, ts.ScriptTarget.Latest))`. `typescript` is already at the root.
     - Then add the regex snippet to the self-test table.
2. **A stale doc comment.**
   - **Where:** `functions/src/billing/client.ts:11-12`.
   - **What:** it still says the http client "logs hosts, labels and codes only". This is the same staleness as #19.
   - **Fix:** change it to "hosts, paths, labels and codes".
3. **One ADR-059 sentence can't be checked as written.**
   - **Where:** `docs/DECISIONS.md`, the "Forged messages when armed" bullet.
   - **What:** it says the topic policy "must show only the budget publisher beside the accepted Owner and Editor roles". `topics get-iam-policy` shows topic-level bindings only, so project Owners and Editors never appear in it.
   - **Fix:** "shows only the budget publisher; project Owners and Editors can also publish through the project policy (accepted until 8C2 removes Editor)". The plan's wording in `m8c-plan.md` is already fine.
4. **The handoff doc (`docs/plans/m8c1-handoff-1.md`) has two lines that no longer match the code.**
   - **Line 8:** "default `PLAIN_HTTP_HOSTS`" is now wrong; the list defaults to empty.
   - **Line 28:** the claim that a redirect to plain http is refused for every host was false at `b6681d9`, and is true only since `291818e`.
   - **Fix:** a one-line "(changed after the Opus review)" note on each, matching how line 31 was handled. Or leave the handoff as a session snapshot.

## After approval
- This session makes no changes, as in the first review.
- If you want the nits fixed, do it in one small commit on `feat/m8c1-billing-guard`:
  - `test:` for #1;
  - `docs:` for #2–#4.
- Then add a row to the PR body's review table pointing at this re-review.

## Verification (for whoever applies the nits)
- **#1:** with the new stripper, the regex snippet's self-test fails on the old stripper and passes on the new one, and the five billing files stay clean.
- **Gate:** `npm run check` and `npm run format:check`. No build, bundle, smoke or audit rerun is needed if only test and doc files change.
