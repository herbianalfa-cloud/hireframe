# Decisions (ADRs)

Format: context → decision → consequences. Append new ones; never edit accepted ones (supersede instead).

## ADR-001 Firebase + React (Fridger stack)
Context: solo builder, needs to ship in a week. Decision: Firebase (Auth, Firestore, Functions v2, Hosting, Storage) + React/TS/Vite. Consequences: fast delivery, known patterns; requires Blaze plan for scheduled/outbound functions; vendor lock-in acceptable.

## ADR-002 Staged funnel with model tiers
Context: reading every job with a strong model is expensive. Decision: free rules → cheap-model triage → deep-model read → CV only on request. Consequences: ~10–20× lower cost per job; S1 rules must avoid killing wildcards (unknown titles pass).

## ADR-003 Gmail via Apps Script bridge, not OAuth app
Context: a Gmail OAuth app with restricted scopes needs Google verification, and unverified apps in Testing mode lose refresh tokens after 7 days. Decision: Apps Script in the user's own account reads a Gmail label and posts to an HMAC-signed webhook; it also sends the digest. Consequences: no verification, no token expiry, minimal scope; one more small codebase (`/apps-script`).

## ADR-004 No scraping of login-walled boards
Context: LinkedIn/Indeed/Wellfound prohibit scraping; account-ban risk. Decision: email alerts only. Consequences: Easy-Apply-only roles arrive via alerts, with a few hours' delay; Lookup can't fetch LinkedIn pages (user pastes text).

## ADR-005 Single prod environment
Context: one user. Decision: emulators + eval gate + tagged deploys instead of staging. Consequences: lower overhead; bad deploys roll back via `firebase hosting:rollback` and function redeploy of previous tag.

## ADR-006 CV facts must be cited
Context: LLM-tailored CVs can invent claims. Decision: every generated bullet references profile `factId`s; validator enforces. Consequences: no fabricated experience; profile must be kept current.

## ADR-007 Product renamed Shortlist → Hireframe
Context: name changed before any code was written. Decision: repo `hireframe`; Gmail labels `hireframe/alerts` and `hireframe/done`. Consequences: none beyond naming; all docs updated.


## ADR-008 M0 tooling
Context: the docs fix the stack but not the repo tooling. Decision:
- **npm workspaces** (`packages/*`, `functions`, `web`), no turbo/nx: three packages don't need a task runner.
- **TypeScript 6.0.x**, strict base config (`noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, …). TypeScript 7 is held back because typescript-eslint supports `< 6.1` only; Dependabot ignores TS majors until it does. `@types/node` tracks the Node 22 runtime.
- **ESLint** flat config with typescript-eslint `strictTypeChecked` + `stylisticTypeChecked` (type-aware: floating promises, deprecated APIs, unsafe `any` flows), `no-explicit-any` as error, plus **Prettier** via `eslint-config-prettier`. Markdown is excluded from Prettier so hand-written docs are not reformatted.
- **Vitest** with one inline project per workspace plus `scripts`, from a single root config.
- **husky** pre-commit running gitleaks on staged changes, **fail-closed**: if gitleaks is missing the commit is blocked.
- **CI gitleaks** runs a pinned binary (version + SHA-256 in the workflow) over the full history, instead of a third-party action; no token needed. Other actions are pinned by commit SHA.
- **PII scan** (`scripts/check-pii.ts`, Node 22 type stripping): emails/phone numbers in tracked files fail `npm run check` and CI; output is redacted because CI logs are public.

Consequences: one `npm run check` gate locally and in CI; contributors need gitleaks installed; the gitleaks version in CI is bumped by hand (Dependabot can't see it).

## ADR-009 Wave 1 spec clarifications
Context: a review of the docs before any code found invalid Firestore paths, overlapping verdict rules, an experience rule off by one, and a per-run worst case that exceeds the monthly cap. Decision:
- **Firestore paths:** `profile/main/facts/{factId}`, `profile/main/documents/{docId}`; the scan lock lives in `locks/scan` (not `runs/lock`), so run queries never return it. → ARCHITECTURE.md
- **Cost (M4):** caps stored in pence; `config/app.fxUsdToGbp` converts Anthropic's USD costs; the S3 per-run cap is lowered so the worst case (scheduled runs/month × S3 cap × max S3 cost) fits the monthly cap. → FUNNEL.md, ARCHITECTURE.md
- **Verdict precedence:** apply > wildcard > near_miss > skip; first match wins. → FUNNEL.md
- **Experience rule:** S1 skips only if the required minimum is greater than `experience_cap_years` (default 2, so 3+ years). Asks equal to the cap go to S2/S3 and take the luck penalty. → FUNNEL.md
- **S1 consistency:** the "Manager unless preceded by Product/Account/Associate/Junior" rule is in the seed criteria. Freshness is checked in S1 only, with a rule ID; S0 is dedupe only. → FUNNEL.md
- **Digest timing (M7):** Apps Script triggers fire within ±15 min, so `getDigest` returns an explicit in-progress/failed notice rather than nothing. → ARCHITECTURE.md
- **Evals in CI:** CI replays recorded responses only, so no Anthropic key is stored in GitHub; live evals run locally. → FUNNEL.md

Consequences: the spec is consistent before code exists; the M4 and M7 plans must implement these points (noted in ROADMAP.md).

*The "Cost (M4)" bullet's S3 formula is superseded by ADR-032 (a per-run budget lease).*

## ADR-010 Personal details stay out of the repo
Context: the repo is public, and the first docs pack described the candidate's education, work-rights status, dates and employer. Decision: docs describe the user generically. Candidate-specific values live in the Firebase profile and are templated into prompts and rules at runtime (e.g. `{profile.work_rights}`). The single initial commit was amended and force-pushed on 2026-09-30 (the `main` ruleset was briefly disabled, then restored with identical rules), so those details are not in branch history. Guardrails: `.gitignore` blocks CV/document/data-export file types; `npm run scan:pii` runs in `check` and CI; the PR template asks for no personal data in PR text. Consequences: S2 prompts and S1 work-rights blocker patterns must read from the profile; commit author metadata keeps the real name by choice (portfolio repo).

## ADR-011 Owner allowlist, bootstrap and M1 rules
Context: PRD R1 allows only the owner's UID, but that UID doesn't exist until the owner first signs in, and the repo is public. Decision:
- Firestore and Storage rules allow access only when `request.auth.uid == config/app.ownerUid` (Storage reads it through cross-service rules). If `config/app` or `ownerUid` is missing, nobody gets in: the rules fail closed.
- `config/*` is never writable from a client, so a signed-in stranger can't create `config/app` to claim ownership. A rules test proves this.
- **Bootstrap:** after the first deploy the owner signs in and sees "No access". They copy their UID from the Auth console and create `config/app` in the Firestore console; console writes are admin writes (docs/RUNBOOK.md). There's no script and no local credentials.
- **M1 matrix:** the owner can read every Wave-1 collection. There are no client writes anywhere yet, for the owner too. Each later milestone opens only the writes its UI needs, with rules tests. Unknown paths and Storage `backups/**` are denied to all clients.
- **Defence in depth:** the web gate zod-parses `config/app` and compares UIDs; it never grants access by default. After bootstrap, new sign-ups are disabled (Identity Platform, ADR-014).
- **Rejected:**
  - "First sign-in becomes owner": whoever finds the URL first wins.
  - Owner email in the rules: personal data in a public repo.
  - Custom claims: they need an Admin SDK script and local credentials.

Consequences: each rules check costs one extra document read (`get(config/app)`), which is negligible for one user; custom claims can replace it later if that ever matters. A typo in `ownerUid` locks the owner out until fixed in the console. Changing the owner is a console edit.

## ADR-012 Web shell toolchain
Context: M1 needs a deployable dark shell on the documented stack (React 19, Vite, Tailwind v4, shadcn/ui, TanStack Query). Decision:
- **Routing:** react-router in declarative mode, which is enough for a handful of screens.
- **shadcn/ui:** components are added by hand into `web/src/components/ui` (no CLI step in CI).
- **Fonts:** Inter and JetBrains Mono are self-hosted via `@fontsource-variable`.
- **Firebase config:** read at runtime from Firebase Hosting's reserved `/__/firebase/init.json`, so no Firebase config or API key sits in the repo or CI (and gitleaks never sees one). `authDomain` is set to the serving host, so the sign-in handler is same-origin and works without third-party storage. Pop-up sign-in falls back to redirect if the pop-up is blocked.
- **Shared code:** `@hireframe/shared` has a `source` export condition, so Vite, Vitest and TS read its sources directly, while Node (functions) uses `dist`.
- **CSP:** ships as `Content-Security-Policy-Report-Only` in M1. Other security headers are enforced. CSP enforcement moves to M8, once the real traffic of Google sign-in and App Check has been observed.
- **eslint-plugin-jsx-a11y:** not used, because it doesn't support ESLint 10 yet and the forks are unvetted. Accessibility is covered by role-based component tests, the Lighthouse ≥ 95 check (R7) and native elements (e.g. radio inputs for the theme switcher). It gets added back once upstream supports ESLint 10 (ROADMAP parking lot).
- **Theme:** dark by default; `light` and `system` (follows `prefers-color-scheme`) on request. `<html data-theme>` is the single source of truth.

Consequences: the production bundle only works when served by Firebase Hosting (by design). A local production build needs `web/.env.local` with the public reCAPTCHA site key.

## ADR-013 Local development on the demo-hireframe emulator project
Context: local work must never touch production data, and rules tests need emulators. Decision:
- `npm run dev` and `npm run test:rules` run `firebase emulators:exec --project demo-hireframe`. A `demo-*` project can't reach real Firebase resources.
- `npm run dev` seeds a fake owner (`owner@example.com`, linked to Google so the emulator's sign-in pop-up lists it) and a console-shaped `config/app` with Timestamps. The seed refuses to run against any non-`demo-*` project.
- Rules tests live in `tests/rules/` with their own Vitest config (`vitest.rules.config.ts`, run serially because both suites share one emulator), so `npm test` stays network-free.
- `firebase-tools` is a pinned devDependency, so local runs and CI use the same emulators. The emulators need Java 21.

Consequences: contributors need Java 21 installed. firebase-tools brings a large dependency tree (currently only moderate `npm audit` findings; CI fails on high). Its lockfile entries include npm deprecation notices containing a third-party maintainer's public contact address, so `scan:pii` skips the generated `package-lock.json` rather than allowlisting a person's address; every hand-written file is still scanned. `@firebase/firestore` pins `@grpc/grpc-js ~1.9.0`, which has high advisories (GHSA-m9gg-hp2v-232j, GHSA-f596-whhp-79r4; server-side, and grpc-js is not in the browser bundle). A root `overrides` entry forces the patched 1.14.5 (rules tests pass on it) so the `audit` gate stays at `high`; remove the override once Firebase bumps its pin.

*Addendum (M2.1):* two more scoped npm overrides, both under `firebase-tools` (dev-only, never in the web or functions bundles). Neither parent has a release that allows the fix, so a direct bump isn't possible, and `npm audit fix --force` would downgrade firebase-tools to 14.
- `get-uri` → `basic-ftp` 6.2.1 fixes GHSA-c475-qrg2-pj4r (high). It's the only high, and it failed the CI `audit` job. get-uri still pins `^5`.
- `gaxios` → `uuid` 11.1.1 fixes GHSA-w5hq-g745-h8pq (moderate, Dependabot alert #1). gaxios 6 pins `^9` and only uses `v4`.

The emulator suite (`npm run test:rules`) exercises firebase-tools with both overrides. Drop them when firebase-tools ships the fixed versions. `@opentelemetry/core` < 2.8.0 (moderate, via `@google-cloud/pubsub`) stays open: the fix is a major version, and moderate findings don't fail CI.

*Addendum (M3):* `braces` GHSA-vfj7-8cjw-p6xm (high, stack exhaustion on deeply nested patterns) reaches us only through `firebase-tools` → `chokidar@3` → `braces`. npm lists every version as affected, so no override can fix it, and forcing `chokidar@4` (no braces) under firebase-tools risks breaking the emulators' file watching. The CI `audit` job therefore splits: production dependencies (everything that ships in the web or functions bundles) fail on **high**, and the full tree including dev tools fails on **critical**. Dev tools only run on developer machines and in CI with trusted inputs. Revisit when braces or chokidar ship a fix, and restore a single `--audit-level=high`.

## ADR-014 Deploy: keyless, tag-only, London
Context: CLAUDE.md says deploys are CI-only on tagged releases, and there must be no long-lived keys. Decision:
- **Trigger:** `.github/workflows/deploy.yml` runs on `v*` tags in the GitHub `production` environment (owner approval required; only `v*` tags may deploy). It re-runs `check` and `test:rules`, builds, then deploys hosting, Firestore rules/indexes and Storage rules.
- **Auth:** Workload Identity Federation. The pool provider only accepts tokens whose `repository_id` is this repo, whose ref is `refs/tags/v*` and whose environment is `production`. The `github-deployer` service account holds only the roles the deploy needs (docs/RUNBOOK.md). There's no service-account key. `npm run deploy` refuses to run outside GitHub Actions on a `v*` tag.
- **Region:** `europe-west2` (London) for Firestore and Storage, and later for Functions. The Firestore location can't be changed.
- **No Cloud Functions in M1**: the `functions` block is added with the first function.
- **PR preview channels are parked:** Google sign-in and App Check (reCAPTCHA domain list) don't work cleanly on preview domains.
- **Sign-ups:** after the owner bootstrap, Firebase Auth is upgraded to Identity Platform (free at this scale, one-way) and "Enable create (sign-up)" is turned off, so strangers can't even create accounts.

Consequences: production auth and App Check are first exercised after merge and tag. That risk is reduced by the emulator tests, report-only CSP and `firebase hosting:rollback`. Adding Functions later needs extra deployer roles.

*The "Sign-ups" bullet is superseded by ADR-015.*

## ADR-015 Closing sign-ups without Identity Platform
Context: ADR-011 and ADR-014 assumed sign-ups could only be turned off after upgrading Firebase Auth to Identity Platform. During the v0.1.0 bootstrap, **Authentication → Settings → User actions** was already available, so no upgrade was needed. Decision: after bootstrap, untick both **Enable create (sign-up)** and **Enable deletion**. Deletion is also off because a deleted owner account couldn't be re-created while sign-ups are closed, and a new account would get a new UID anyway. The Identity Platform upgrade stays only as a fallback, for projects where User actions is missing. This supersedes ADR-014's "Sign-ups" bullet and the Identity Platform mention in ADR-011. Consequences: no one-way upgrade was made. A blocked sign-up still returns `auth/admin-restricted-operation`. Recovering a lost owner account is a short console procedure (RUNBOOK Recovery).

## ADR-016 Minimal `llm.call()` in M2, with a reserved spend cap
Context: `parseCv` and `addFact` call Anthropic in M2, but ROADMAP put `llm.call()` and the cost cap in M4. CLAUDE.md says every LLM call goes through `llm.call()`, which checks the cap first. Decision: pull a minimal `llm.call()` forward (`functions/src/llm/`).
- **One model per purpose** in `functions/src/config.ts`: Sonnet-class (`claude-sonnet-5-5`, effort `medium`) for `parseCv`, Haiku-class (`claude-haiku-4-5`, no effort parameter) for `addFact`. No beta features: no refusal fallback in M2.
- **Per attempt:** count tokens (free) → **reserve** the worst case (input +10% +500 tokens at the uncached rate, plus `max_tokens` of output, at the call's model price) on `usage/{yyyy-mm}` in a Firestore transaction (month in Europe/London). If spend + live reservations + this call would pass the cap, it throws before any API call → stream the request with a fixed JSON output schema and no tools → **settle** in one transaction: remove this reservation and add the actual cost, calls, tokens and per-purpose spend.
- **Time limits:** every send carries an AbortSignal for `MODELS[purpose].timeoutMs`, streamed body and SDK retries included (the SDK's own `timeout` stops counting once headers arrive). Each call also has a wall-clock `budgetMs` (parseCv 480 s, addFact 90 s); the output-validation retry runs only if the budget still allows a send, and is trimmed to what is left. Budget plus a 30 s margin fits each callable timeout (tested).
- **Crashed calls are charged:** a reservation older than 15 minutes belongs to a call that never settled (e.g. the callable was killed at its timeout). The next reserve or settle charges it as spent at its worst case, under `byPurpose.unsettled`, instead of dropping it. This is deliberate and fails safe: a crash can overstate the month's spend, never understate it, so repeated timeouts can't push real spend past the cap.
- **Failures:** a request the API rejected with a status code costs nothing; a dropped connection, timeout or abort is charged the worst case, because it may have been billed. Invalid JSON or schema errors get one retry with the issue paths and codes appended (FUNNEL rule); refusal and `max_tokens` fail without retry. The SDK retries 408/409/429/5xx twice.
- **Cap and FX:** `config/app.monthlyCapPence` (default 1500) and `config/app.fxUsdToGbp` (default 0.85, deliberately high so pence are overstated). Both are optional `AppConfigSchema` fields set in the console.
- A usage document that fails its schema blocks spending (fails closed).

Consequences: R11's "simulated overspend stops LLM calls before exceeding the cap" is covered from M2 (unit and emulator tests). M4 adds per-run caps, the 80% warning, batches, prompt caching and eval recording on top, and decides on the refusal fallback. A crashed call costs its worst case even if the real bill was lower. The emulator's fake transport records `fake:<model id>`, priced at the real model's rate, so fake spend is never mistaken for real spend.

## ADR-017 Cloud Functions build, runtime and deploy
Context: M2 adds the first functions. Cloud Build installs a function's `package.json` in the cloud and can't see the npm workspace package `@hireframe/shared`; the default runtime account has the Editor role; and local dev must not need App Check or an Anthropic key. Decision:
- **Bundle:** `scripts/build-functions.ts` uses esbuild to inline `@hireframe/shared` and the pure-JS dependencies (Anthropic SDK, zod, unpdf, mammoth) into `functions/deploy/index.js`. The generated `functions/deploy/package.json` lists only `firebase-functions` and `firebase-admin`, pinned exactly, so few transitive versions float at deploy time. `firebase.json` deploys from `functions/deploy` (`nodejs22`; `*.local` and source maps excluded). CI builds the bundle and imports it as a smoke test.
- **Options:** region `europe-west2`, one instance at most, and the dedicated `hireframe-fns` runtime account (`RUNTIME_SERVICE_ACCOUNT` in `functions/src/config.ts`, the full email: the `hireframe-fns@` shorthand made Secret Manager's `setIamPolicy` fail with HTTP 400 on the v0.2.0 deploy), applied in `functions/src/options.ts`. Every module that defines functions imports it first, because ES modules evaluate imports before their own body; each callable also states its region. The region and callable timeouts live in `packages/shared/src/callables.ts`, shared with the web client, which waits 20 s longer than the server. `functions/src/index.test.ts` and the CI bundle smoke test fail if any exported function leaves europe-west2.
- **Runtime account roles:** `datastore.user` and `firebaseappcheck.tokenVerifier` on the project, `storage.objectViewer` on the bucket, `secretmanager.secretAccessor` on `ANTHROPIC_API_KEY` only. **Deployer extra roles:** `cloudfunctions.developer`, `iam.serviceAccountUser` on `hireframe-fns` only, `secretmanager.viewer` on the secret.
- **Callables:** `enforceAppCheck` and `consumeAppCheckToken` (replay protection for calls that spend money) are on everywhere except the Functions emulator, which local dev runs without App Check; deployed functions never see `FUNCTIONS_EMULATOR`. The key comes from `defineSecret('ANTHROPIC_API_KEY')`.
- **Local dev:** the emulator uses a fake LLM transport that returns the fake CV's extraction, unless `LIVE=1` (key from the gitignored `functions/.secret.local`). `npm run dev` writes a placeholder secret so the emulator never calls Secret Manager.
- **Artifact Registry:** the first functions deploy needs a cleanup policy, and `firebase deploy --non-interactive` stops if none exists. The owner creates `gcf-artifacts` in europe-west2 with the `firebase-functions-cleanup` policy before the first deploy (RUNBOOK Part C), rather than CI passing `--force`, which would also skip other deploy safety prompts.

Consequences: the deploy bundle is about 5 MB (mostly pdf.js). Bundled dependencies are pinned through the workspace lockfile. The first `v0.2.0` deploy may still surface one missing deployer role (RUNBOOK Recovery).

*Addendum (M3):* the emulator's fakes (model transport, job APIs, watchlist) load only through `loadDevFakes()` behind `process.env.HIREFRAME_DEV_BUNDLE`, which `scripts/build-functions.ts` replaces at build time. `npm run dev` builds with it set; every other build, including deploys, drops the fakes as dead code. The bundle smoke test fails if fixture data appears in a production bundle.

*Addendum (M2.1):* the runtime account's bucket role is now `storage.objectUser`, so Reset profile can delete uploads (ADR-023). The v0.2.x deploys also needed, by hand:
- three more APIs (eventarc, firebaseextensions, cloudbilling);
- the deployer's `serviceAccountUser` on the App Engine default and default compute accounts;
- a one-time `allUsers` `run.invoker` binding per new callable, because the deployer can't set IAM.

All are in RUNBOOK Part C. M8 replaces the compute-account grant with a dedicated Cloud Build account (ROADMAP).

## ADR-018 Profile facts: extraction, evidence, merge and versions
Context: PRD R2 needs ≥ 60 atomic facts from a CV, each showing its source, re-uploads that never overwrite, and versioned edits. Decision:
- **Text extraction, not native PDF input:** unpdf (PDF) and mammoth (DOCX) extract the text, and the model gets it as tagged, untrusted data. That lets the server check evidence word for word, costs fewer tokens than page images, and makes scanned PDFs fail clearly ("upload the .docx"). The file type comes from its magic bytes, not the client.
- **Atomic facts:** the prompt requires one claim per fact, splits multi-claim bullets, and asks for the shortest verbatim evidence span. A soft `countCompound` hint is logged as a count only.
- **Evidence verification:** evidence must appear in the source text after whitespace, quote and dash normalisation. If not, the fact is kept with `evidenceVerified: false` and flagged in the UI, never dropped. `addFact` verifies evidence against the note.
- **Deterministic merge** (`mergeFacts`, pure): same type and text → unchanged (or flagged if only the dates changed); same type and token-Jaccard ≥ 0.6 on an active fact → flagged with `review.proposed`; archived matches are skipped, not revived; anything else is added. Facts missing from a new CV are counted, never archived.
- **Versions:** every fact has immutable snapshots at `profile/main/facts/{factId}/versions/{n}`. The server writes v1 with the fact.
- **Client edits enforced by rules**, not edit callables: an update must bump `version`, stamp server time and write the matching snapshot in the same batch; `review` can only be removed, and removing it is exactly `review_accepted` or `review_kept`. The web builders run against the real rules in tests.

Rejected: an LLM-driven merge (not testable offline; parking lot); callables for every edit (cold starts, more code, same guarantees).

Consequences: a CV of up to 200 facts writes in one atomic batch. Snapshots are built from the raw stored data so Timestamps compare exactly. A heuristic merge can produce an extra review item or a near-duplicate, but never lose data.

*Addendum (M2.1, ADR-022):* the merge gains an evidence-quote pass between "same text" and "similar text", and parseCv no longer reads a file whose bytes it has already parsed.

## ADR-019 Criteria versions and pointer
Context: PRD R3 needs one editable, versioned criteria document, and M4 must record which version judged each job. Decision:
- Immutable `criteria/v{n}` plus `criteria/current = { version }`, written together in one batch or transaction; rules allow v{n} only with the pointer moving from n-1 to n, and never allow updates or deletes. A save that started from an older version is refused (conflict).
- Content keys stay snake_case exactly as in FUNNEL.md; metadata (`version`, `createdAt`) is camelCase.
- `excluded_titles` is structured as `{ id, term, unless_prefixed_by? }`, so S1 (M4) can apply "unless preceded by" without parsing prose (semantics pinned in ADR-020). "Technical" is an allowed Business Analyst prefix, because "Technical Business Analyst" is a secondary-lane title. `excluded_keywords` is added (empty) for PRD R3's "excluded titles/keywords".
- v1 is seeded from the Criteria screen ("Start from default criteria"), not by a script, since there are no local credentials (ADR-011). `npm run dev` seeds the emulator.

Consequences: R3's "next run uses it" and "Re-score" can only be verified once runs exist (M4); `getCurrentCriteria` reads the pointer, then the version.

## ADR-020 Excluded-title matching
Context: FUNNEL.md said a title is allowed "when any listed word appears before the term". Read literally, that lets "Product Marketing Manager" and "Technical Support / Business Analyst" through. Read strictly, it would exclude the opportunistic-lane title "Junior Brand Manager". The PR #4 review asked for the rule to be pinned and tested now, before S1 (M4) depends on it. Decision: a pure `checkTitle` in `packages/shared/src/titles.ts`, used by the seed tests now and by S1 in M4:
- Whole words, case-insensitive; anything that isn't a letter or digit separates words.
- An occurrence of a term is allowed only when one of its `unless_prefixed_by` words comes **immediately** before it. Any occurrence that isn't allowed excludes the title.
- **Lanes win**, except over seniority: a title containing a lane title (slash alternatives expanded) is not excluded by a non-seniority rule. The seniority rules (`senior`, `lead`, `principal`, `head-of`, `director`) always apply. They are matched by rule ID, so editing a term keeps its class.
- `checkTitle` returns the excluding rule's ID, so a skipped job can show the rule that skipped it (PRD R6).

Rejected: adding "Brand" to the Manager prefixes (it changes the owner's criteria to fit the matcher); loose "anywhere before" matching.

Consequences: the matcher ships in M2, ahead of S1, because the seed tests need it. A tested invariant says no seed lane title is ever excluded. A seniority rule added from the Criteria screen under a new ID is treated as non-seniority until the list changes (parking lot).

## ADR-021 Web bundle split
Context: the M2 web build was one 1.08 MB chunk (Vite's warning threshold is 500 kB), and PRD R7 asks for "usable in < 2 s on 4G". Decision:
- Profile and Criteria screens load with `React.lazy` on first visit, with a skeleton fallback.
- The Functions and Storage SDKs load on first use (`getFunctionsClient`, `getStorageClient` in `services/firebase.ts`); the shell only needs app, auth, App Check and Firestore.
- Vendor chunks through Rolldown's `output.codeSplitting.groups` (Vite 8 deprecates `manualChunks`): `react`, `firestore`, `firebase` (app, auth, App Check), `zod`. They change less often than app code, so they stay cached across deploys. The Firebase patterns name only the eager packages, because a group also pulls in the dependencies of what it matches.
- `npm run check:bundle` (CI, after build) fails if any chunk is over 500 kB or the initial JS is over 310 kB gzip.

Consequences: initial JS went from 1,083 kB to about 974 kB minified (326 to about 292 kB gzip), and the largest chunk is Firestore at about 472 kB. Firestore and Auth are needed before the first screen (owner check), so they can't be deferred without changing the sign-in flow.

## ADR-022 Stable re-upload
Context: after v0.2.1, uploading the same CV as .docx and then as .pdf gave "Added 64, unchanged 77, flagged 53". The model words facts differently on every read. ADR-018's merge only matched on the same text, or on token-Jaccard ≥ 0.6, so most reworded facts were added again or flagged, although the CV line behind them hadn't changed. Decision:
- **Identical file, no read:** parseCv stores the SHA-256 of the uploaded bytes on the document. If an earlier *parsed* upload has the same hash, the new one is marked `duplicateOf` it, with an all-zero result. There is no model call and no fact is touched. Failed uploads don't count, so a failed read can be retried. Removed uploads do count: reading again would only skip the archived facts.
- **Evidence pass in `mergeFacts`**, between pass 1 (same type and text) and the similarity pass:
  - The key is the type plus the quote with case, accents, punctuation and *all* spacing removed. That survives PDF/DOCX extraction noise: ligatures, curly quotes, bullets, doubled spaces and words hyphenated across a line break.
  - Facts split from one bullet share a quote. So among the unmatched facts behind a quote, a single candidate (or several copies of the same text) matches, and otherwise the closest wording wins. A tie between different facts, or no shared word at all, is ambiguous and falls through to the similarity pass.
  - The outcome is the same as an exact match: unchanged, flagged if the dates differ, or skipped if the fact is archived. An archived fact is therefore never re-added under new wording.
- **Tests reproduce the bug:** two differently worded fake reads of the same CV. The old merge found 0 of 14 unchanged; the parseCv fixture went from "added 30, flagged 33, unchanged 0" to 0 / 0 / 63.

Rejected: lowering the similarity threshold, which would flag more unrelated facts; an LLM second opinion (still in the parking lot).

Consequences: a CV edit that changes a bullet's wording changes its quote too, so it is still added or flagged as before. A model that quotes a different span of the same line on the second read falls back to the similarity pass. The duplicate check only helps byte-identical files; the evidence pass covers the format switch. Uploads from before v0.2.2 have no hash.

## ADR-023 Removing an upload and resetting the profile
Context: there was no way to undo a bad upload (like the unstable v0.2.1 re-upload) or to start the profile over. SECURITY promises "delete all my data". Decision:
- **Remove upload uses the client-write path.** `planUploadRemoval` (pure, shared) picks the facts to change:
  - it archives facts with `sourceDocId` = the upload that are active, `version == 1` and not manual;
  - it drops every pending proposed change from that upload as a `review_kept` version;
  - it counts, and keeps, the facts the owner edited.

  `buildUploadRemoval` turns the plan into versioned batches of at most 240 facts (480 writes). The document's `removedAt` goes in the last batch, so a document is marked only after everything before it committed. A retry plans only what is left. One new rule lets the owner set `removedAt` and `updatedAt` to the server time, once, on a parsed or failed upload, and change nothing else. The file stays in Storage.
- **Reset profile is a callable**, `resetProfile`, because it must delete Storage objects and whole subcollections (`recursiveDelete`), which client rules shouldn't allow.
  - It is owner-only, with App Check enforced and consumed, and mounts no secrets.
  - It needs `{ confirm: 'RESET' }`, checked by zod on the server as well as in the UI.
  - It refuses while a CV is being read (a non-stalled `parsing` document), so a running parse can't write facts back afterwards.
  - It deletes facts with their versions, upload documents and everything under `profile/documents/`. It never touches config, criteria or usage.
- **IAM:** the runtime account moves from `storage.objectViewer` to `storage.objectUser` on the bucket. That is the narrowest built-in role that can delete objects; it can also create and overwrite them, which no function does.

Rejected: a removal callable, because the versioned client path already gives history, rules tests and no cold start; a soft-delete reset, because "delete my data" means gone.

Consequences: Remove upload is reversible from the Archived tab, but its proposed-change drops are not re-proposed unless the CV is uploaded again. Reset can't be undone: there is no backup until M8's weekly export. A new callable needs a one-time invoker binding (RUNBOOK Part C step 28).

*Addendum (M4, ADR-033):* Reset profile also deletes `profile/main`, which now holds the work-rights setting.

## ADR-024 Evidence links on facts
Context: some facts are best backed by something outside the CV, like a portfolio page, a certificate or a live dashboard. Decision: an optional `evidenceUrl` on the fact, which the owner sets in the Edit dialog.
- Https only, at most 500 characters, no whitespace. The check lives in `EvidenceUrlSchema` (zod `z.url` with the https protocol) and is mirrored in firestore.rules.
- It is on `FactSchema` only, not on `FactContent`/`FactDraft`. The model's output schema can't carry it, and a proposed change can't set it. Text injected into a CV or note can therefore never plant a link.
- Clearing the field removes it (`deleteField()`); every change is a normal versioned edit.
- The link opens in a new tab with `rel="noopener noreferrer"`.

Consequences: file attachments as evidence are parked (ROADMAP). Links are never fetched or checked server-side.

## ADR-025 Source access policy: robots.txt, keyed APIs and quotas
Context: CLAUDE.md said "Respect robots.txt and ToS". The M3 checks (2026-10-01) found that two keyed developer APIs listed in ARCHITECTURE are disallowed for crawlers. `www.reed.co.uk/robots.txt` has `Disallow: /api/` in its `User-agent: *` group, and `api.adzuna.com/robots.txt` is `Disallow: /`. robots.txt (RFC 9309) tells crawlers which pages to fetch. It doesn't govern a client that calls an API with keys issued to it under developer terms, and both providers issue keys precisely so their `/api/` gets called. Decision:
- **robots.txt applies to web pages and unkeyed public endpoints.**
  - The HTTP client fetches `/robots.txt` once per host per run and honours Allow/Disallow (longest match, `*` and `$`) and `Crawl-delay`.
  - A 4xx means "no rules" and a 5xx or unreachable file means "disallow all", as RFC 9309 says.
  - This covers Greenhouse, Lever (`Crawl-delay: 1`), Ashby, Workable and HN Algolia.
- **Keyed official APIs follow their developer terms instead.** Those hosts are marked `api-terms` in `functions/src/config.ts`: `www.reed.co.uk` and `api.adzuna.com`. Adding a host to that list needs an ADR.
- **Adzuna terms** (developer.adzuna.com/docs/terms_of_service, read 2026-10-01):
  - the limits are 25 hits/minute, 250/day, 1,000/week and 2,500/month;
  - job listings shown to users carry "Jobs by Adzuna" with the logo linked to adzuna.co.uk (at least 116×23 px);
  - personal research is allowed, and acquired data must be removed if the account ends.

  The code keeps 3 s between requests (20/min), at most 20 calls per run, and persisted day/week/month counters that stop at 225/day, 900/week and 2,250/month (10% headroom).
- **Reed terms** aren't published on the developer page; they are accepted at sign-up. Until their clauses are cited here, the basis is a conservative budget: at most 30 calls per run and 300 per day, 1 request per second. Secondary sources mention 1,000/day, unverified. No attribution requirement is known, and M5 revisits it with the terms.
- **Keys** (`REED_API_KEY`, `ADZUNA_APP_ID`, `ADZUNA_APP_KEY`) live in Secret Manager and are mounted only on `scanNow` (later `scheduledScan`). Logs never contain a full URL: the Adzuna key travels in the query string, so the client logs the host and a fixed path label only.

Consequences: CLAUDE.md's hard rule and the SECURITY threat row now say this. Adzuna attribution (and Reed's, if its terms require it) is an M5 task, because M3 shows counts, not listings. If either provider objects or changes its terms, the source is switched off with `config/app.disabledSources`.

**Addendum (M5): attribution on listings.**
- **Adzuna.** Every job whose `sources` include `adzuna` shows "Jobs by Adzuna" next to its listing, in Today, Jobs and Job detail: the logo (at least 116×23 px, self-hosted in `web/public/attribution/`, official artwork from adzuna.co.uk/press.html) linking to adzuna.co.uk. A job found by several sources shows it because one of them is Adzuna.
- **Reed.** No attribution clause was found (the terms are accepted at sign-up and aren't published, see the Reed terms bullet above), so a Reed job shows a plain "via Reed" link to its own listing, which also gives the owner the original posting. If Reed's terms ever require more, this is the place to change.
- Attribution is text and a link only: no hotlinked images, no tracking. The logo is a static asset so the page makes no request to Adzuna until the owner clicks.

## ADR-026 YC jobs and Work at a Startup: email alerts only
Context: ARCHITECTURE asked M3 to verify robots.txt and ToS for YC's job pages. `ycombinator.com/robots.txt` allows most paths (it disallows `/companies?*` and some others), and `workatastartup.com/robots.txt` allows everything. The YC Terms of Use (ycombinator.com/legal), which cover the jobs pages and Work at a Startup, say: "you will not engage in or use any data mining, robots, scraping or similar data gathering or extraction methods". Decision: no YC or Work at a Startup source module. Their jobs arrive through Work at a Startup email alerts via the Gmail bridge (M6, RUNBOOK one-time steps 5–6). Consequences: YC-company jobs are covered only when the company uses a watched ATS board, or through alerts. Lookup can't fetch YC pages; the user pastes the text.

## ADR-027 Workable: public widget endpoint, module in M3
Context: ARCHITECTURE listed Workable as "verify endpoint in M3". Workable's help centre ("Using the Workable API to display jobs on your careers page") documents `GET https://www.workable.com/api/accounts/{subdomain}?details=true` as a public, unauthenticated endpoint for an account's published jobs. `www.workable.com/robots.txt` allows `/api` (it disallows `/j/`, `/admin` and account paths), and `apply.workable.com/robots.txt` allows everything. Decision: a Workable source module ships in M3 alongside Greenhouse, Lever and Ashby. It is driven by watchlist companies whose `ats.type` is `workable`, under the same robots, rate-limit and retry rules (ADR-029). Consequences: ROADMAP M3 gains the module. Workable companies found by ATS detection are actually scanned instead of being dead entries. Workable rate-limits harder than the other boards: the first live detection run at 1 request/s got Cloudflare 429s (error 1015), so both `www.workable.com` and `apply.workable.com` (where the documented URL redirects) are spaced 5 s apart. Many companies also have a dormant Workable account with no jobs; detection never confirms an empty board. *Amendment (M3 review):* the documented URL answers with a redirect to `apply.workable.com/api/v1/widget/accounts/{subdomain}`, and a followed redirect skips the target host's robots check and spacing. Scans and detection therefore call that URL directly. `apply.workable.com/robots.txt` allows everything, and that host is the one spaced 5 s apart.

## ADR-028 Escape the City: email alerts only
Context: ARCHITECTURE asked M3 to verify Escape the City. `escapethecity.org/robots.txt` allows everything, but the Terms and Conditions (escapethecity.org/terms-and-conditions) say: "With the exception of accessing RSS feeds, you will not use any robot, spider, scraper or other automated means to access the Site for any purpose without our express written permission." No RSS feed is advertised (no feed link on the home page; `/rss` and `/feed` redirect to HTML pages). Decision: no module. Escape the City jobs arrive through its email alerts via the Gmail bridge (M6). Consequences: if Escape the City publishes a jobs RSS feed, a feed module is allowed by its terms and can be added with a new ADR.

## ADR-029 Ingest pipeline, source health and an ingest-only `scanNow`
Context: M3 adds the sources, but the funnel (S1–S3) and the schedule are M4. PRD R4 needs per-source counts and isolation of failures, CLAUDE.md needs timeouts, retries and zod at every boundary, and M3 must be demoable. Decision:
- **One HTTP client** (`functions/src/http/`) for every source:
  - **User-Agent** `HireframeBot/<version> (+https://github.com/herbianalfa-cloud/hireframe)`.
  - **Per-host spacing:** request starts are spaced by at least the larger of the configured interval (1 s; Adzuna 3 s) and robots `Crawl-delay`. It's in-memory, which is safe with one instance and the scan lock.
  - **Time limits:** a per-request `AbortSignal` timeout (20 s, HN 45 s), and a run deadline checked before every request.
  - **Retries:** at most 3 attempts with exponential backoff and jitter on 429, 5xx, network errors and timeouts. `Retry-After` is honoured up to 30 s; past that the request fails.
  - **Responses** are zod-parsed. A 404 or schema error is not retried.
- **Sources** implement `Source { id; fetch(ctx); health() }` (ARCHITECTURE), one fresh instance per run.
  - **Records survive a killed scan:** a scan killed at the callable timeout never runs its `finally`, so its lock goes stale (12 min) and its run stays `running`. The next scan that takes over the stale lock marks that run `failed` with code `timeout` in the same transaction, and the System screen shows a run still `running` 10 min after it started as timed out straight away. Reed and Adzuna call counts are saved as soon as each source finishes, so a crash later in the run can't lose them from the quota. A failed write batch is retried one write at a time, so one bad write never loses the rest; failed company updates are counted, not fatal.
  - **Paused hosts:** a Retry-After beyond the 30 s cap means "stay away". The client then sends that host nothing more: not this run's other boards or queries (checked again after the per-host queue, so requests already waiting stop too), and not later runs until the time passes (`sources/{id}.pausedHosts`). It logs `http.host_paused` once per host per run. Boards skipped that way count as neither attempts nor failures and aren't marked scanned, so rotation keeps them first. The System card shows "Paused until <time>". This came from the M3 real-seed scan: Workable blocked a machine for about 23 hours after bulk detection, and each board still sent a refused request.
  - **Board rotation:** each ATS host gets as many boards per run as fit in 60% of the fetch budget at its request interval (Workable at 5 s: 43; Greenhouse at 1 s: 216). A host with more rotates: the least recently scanned boards go first and the rest wait a run, reported as `deferred`.
  - Each item is validated on its own, and an invalid posting is counted, not fatal.
  - A failing ATS board is recorded on its company (`lastScan`, `broken` after 3 consecutive `not_found`), and the source reports `degraded`.
  - Sources run under `Promise.allSettled`, so one source throwing never fails the run (R4).
- **Health** lives in a new server-written collection `sources/{sourceId}`: status, last run, last success, consecutive failures, last error code, last counts and API quota counters. Clients read it; nobody but the Admin SDK writes it.
- **`scanNow` ships in M3, ingest-only:**
  - It fetches, normalises, dedupes (ADR-030) and writes new jobs at `stage: 's0'`, with no verdict and no `criteriaVersion`.
  - It's owner-only with App Check enforced and consumed, and mounts the Reed and Adzuna keys only.
  - A **single-flight lock** in `locks/scan` (a transaction) refuses a second scan while one runs (stale after 12 min). A **cooldown** (5 min) after a finished scan turns a double tap, which queues behind the single instance, into `skipped_recent` instead of a second round of API calls.
  - `config/app.disabledSources` turns a source off from the console.
- **No `scheduledScan` until M4**, so unscored jobs don't pile up twice a day. M4 adds the funnel to `scanNow`, adds the schedule and processes the `s0` backlog.
- **A minimal Sources panel** (Scan now, per-source health and counts, recent runs, job count) is pulled forward from M5 onto the System screen, so M3 can be tested end to end on a phone.

Consequences: jobs ingested in M3 wait at `s0` for M4. Reed and Adzuna store snippets only. Reed full text comes from its details endpoint for S2 survivors in M4, and Adzuna has no full-text API, so its jobs rely on a merged ATS duplicate for S3. A scan reads each candidate key once per run, and an unchanged job costs no write.

## ADR-030 Normalise and dedupe
Context: PRD R5 needs the same job from several sources to appear once with every source link. ARCHITECTURE said normalisation "strips seniority noise words". Stripping level words would merge "Senior Product Analyst" with "Product Analyst" at the same company and hide one of them. A missed merge costs a duplicate row and a few pence of triage; a wrong merge hides a job, which is the miss the system exists to prevent. Decision (pure code in `packages/shared`):
- **Titles:**
  - level words are **normalised, never stripped**: `Jr`→junior, `Grad`→graduate, `Sr`→senior, `Assoc`→associate;
  - non-level noise is stripped for matching: bracketed or trailing location, work mode, salary, contract and gender tags (`(Hybrid)`, `- London`, `| £35k`, `(m/f/d)`, `12-month FTC`);
  - display text is never changed.
- **Companies:** case, accents and punctuation folded, `&`→`and`, legal suffixes dropped (Ltd, Limited, plc, Inc, LLC, LLP, GmbH).
- **Location:** the first recognised city, with remote-only jobs keyed as `remote`.
- **Keys:** each job stores `keys[]`:
  - `d:` + a 64-bit FNV-1a hash of `company|title|city`. It's synchronous and pure; at 100k jobs the collision chance is about 3×10⁻¹⁰;
  - every source key (`greenhouse:{id}`, `lever:{id}`, `linkedin:{id}`, …);
  - keys derived from known job URLs, so an HN comment or an alert linking a Greenhouse posting matches it.
- **Matching:** jobs within a run are merged first. Existing jobs are found with `array-contains-any` on `keys` (chunks of 30), so no extra index collection is needed.
- **Conflict rule:** a job matching two existing jobs joins the one first seen, and the conflict is counted.

Consequences: fixtures pin both directions. The LinkedIn-alert + Greenhouse pair and "Product Analyst (Hybrid) - London" / "Product Analyst" merge; Senior/Junior at the same company stay apart. ARCHITECTURE's wording is corrected. Two genuinely different roles with the same title, company and city collapse into one, an accepted limit.

## ADR-031 Company watchlist: sourcing and ATS detection
Context: ARCHITECTURE said the watchlist is about 150 London/UK B2B SaaS companies and startups, "with ATS type + board token auto-detected from their careers page". Fetching careers pages means crawling arbitrary sites, and no automated collection of company lists is allowed. Decision:
- **Candidates** come from people, not crawlers. Claude drafts a list of well-known companies from general knowledge, and the owner prunes and extends it from lists read in a browser. It's a CSV in the gitignored `tmp/`.
- **Detection** probes only the official job-board APIs (`node scripts/detect-ats.ts`, same HTTP client, robots and rate limits):
  - Greenhouse `/v1/boards/{token}` and Workable return the board's name;
  - Lever (global and EU hosts) and Ashby only show that a board exists.
  - Tokens are guessed from the name and domain, or parsed from a careers URL the owner pastes, with no fetch. No careers page is fetched.
- **Verification:** `confirmed` needs exactly one board with open jobs whose name matches the company exactly after normalisation (a prefix isn't enough: the first live run matched "Wise" to "Wise Worksite Field Sales" and "Peak" to "Peak Physical Therapy"). Anything else found is `review`, which the owner checks on the human board page and marks keep or drop. A probe that fails for any reason other than "no such board" (rate limit, timeout) makes the row `unchecked`, never `not-found`, and `--write` won't run until those rows are re-detected or decided.
- **The seed** (`packages/shared/src/watchlist-seed.ts`) holds public facts only: name, domain, ATS type and board token. Companies without a detectable ATS stay as `none`, for matching aggregator jobs and M4 company fit.
- **`companies` is server-written.** `scanNow` creates missing seed companies and never overwrites existing ones, so console edits (e.g. `watch: false`) stick.
- **Auto-growth** (adding companies that appear in alerts or aggregators) moves to M6, when alerts exist.

Outcome of the first review (M3): 204 companies, 94 with a board (about 10 of them Workable, so rotation rarely applies). 110 have no board: wrong-company or dormant boards, 404s, nothing found, and 27 that Workable's rate limit left unchecked, which wait for `--recheck`. Consequences: detection relies on boards being named after the company. Unusual tokens need a pasted careers URL. A wrong board can only enter the seed through an owner-reviewed row.

## ADR-032 Funnel spend: a run budget lease, stage shares and caps
Context: ADR-009 said the S3 per-run cap should be lowered until "scheduled runs/month × S3 cap × max S3 cost" fits the monthly cap. With the models' list prices (platform.claude.com/docs/en/about-claude/pricing, checked 2026-10-03: Sonnet 5.5 $2/$10 per MTok, cache reads $0.20 and 5-minute writes $2.50; Haiku 4.5 $1/$5) and an S3 call's worst case of about 5p (4,000 output tokens, nothing cached), that formula allows about 4 deep reads a run. The typical S3 call costs about 1.5p and an S2 call about 0.15p. Separately, a reservation transaction per call on one `usage/{month}` document would contend at 300 S2 calls a run, and the scan callable has 540 s for ingest and the funnel together. Decision:
- **A lease per run.**
  - At funnel start, one transaction reserves `runBudgetPence` (or what the month has left) on `usage/{month}` as reservation `run-<runId>`.
  - Every `llm.call()` in the run uses an in-memory `UsageStore` (`functions/src/llm/lease.ts`). It reserves the call's worst case against the lease, in-flight calls included, and settles the actual cost. So a run's real spend can never pass its lease.
  - At the end, one transaction settles the lease with the actual spend, calls, tokens and per-purpose cost. A run killed mid-way leaves a stale reservation that is charged in full after 15 minutes, as ADR-016 does for any call.
  - `llm.call()` itself is unchanged, so "every LLM call goes through `llm.call()`" still holds.
- **The proven worst case is runs × lease.** The default lease is `floor(monthlyCap × 0.75 / 46)`: 46 is the most weekday runs a month can have, and the other 25% is for manual scans, re-scores and profile calls. That gives 24p at £15. Raising `config/app.monthlyCapPence` raises it, and `config/app.funnel.runBudgetPence` overrides it.
- **Stage shares and caps.** S2 may use at most 40% of the lease, so triage can't starve deep reads. Count caps are upper bounds: S1 ≤ 2,000, S2 ≤ 300, S3 ≤ 25 (FUNNEL's provisional 60 is lowered). At £15 a run holds about 60 S2 and 8–9 S3 calls; the rest waits, newest first for S2 and best triage score first for S3.
- **R11:** a run that starts with 80% of the month committed is flagged `spend_80`. From 90%, S3 is refused ("deep stages pause") while S2 continues up to the cap; S0/S1 always run.
- **Time:** the scan's fetch budget drops from 360 s to 300 s (Workable now rotates 36 boards a scan). No new S2 call starts after 400 s and no new S3 call after 450 s; the deep-read budget of 60 s plus a 30 s margin ends inside the 540 s callable (`config.test.ts`).
- **Rate limits:** each stage paces its request starts (triage 45/min, deep read 20/min) with 4 and 2 calls in flight. All of these are in `FUNNEL` (`functions/src/config.ts`), and the counts and rates can be overridden from `config/app.funnel`, which is parsed on its own so a typo can't fail the owner check.

Consequences: at the default cap, steady-state volume fits and a large backlog takes several runs. If verdicts lag, raising the monthly cap is the lever. A crashed run overstates the month by its unused lease, never understates it. FUNNEL's per-run caps are now budget-first.

## ADR-033 S1 rules and the work-rights setting
Context: FUNNEL's S1 needs "wording that excludes {profile.work_rights}", but nothing structured stored work rights; only free-text constraint facts did. Some criteria entries are prose labels ("Big Four graduate schemes", "sponsorship-restricted wording"), not patterns. Decision:
- **Work rights are an owner setting** on `profile/main`: `unrestricted`, `time_limited` or `needs_sponsorship`, plus an optional `validUntil` (YYYY-MM-DD) that only the prompts use. It's personal data, so it lives in Firebase only (ADR-010). The rules allow exactly these keys, server time and a fixed `createdAt`; Reset profile deletes the document.
- **Right-to-work patterns:** "indefinite leave / settled status / citizens only / no visa holders" blocks time-limited and sponsorship-needing rights. "No sponsorship / must already have the right to work" blocks only sponsorship-needing rights. Until the setting exists, S1 never skips on this; it flags `work_rights_unknown`.
- **Known labels expand in code:** the seed's blocker labels map to pattern sets (SC and DV clearance, driving licence, right to work), and any other blocker is matched as a phrase. A company entry is a company name unless it's a known group: Big Four graduate schemes (a Big Four company plus a graduate/trainee title cue), or train-and-deploy consultancies.
- **Rule order and IDs:** `title:<id>`, `company`, `keyword:<term>` (title and text), `location` (non-UK and not remote; remote jobs elsewhere go to S2), `freshness`, `blocker:<kind>`, `experience`.
- **Freshness** uses the posting date, or the first-seen date when there is none (a lower bound on age, flagged `freshness_unknown`). It is checked in S1 and again when a job leaves the S2 or S3 queue, so stale queued jobs skip for free. FUNNEL's "the only freshness check" is updated.
- **Experience:** S1 skips only a required minimum above `experience_cap_years`, as FUNNEL.md and ADR-009 say. The highest ask that survives (required at the cap, or preferred/ambiguous at any level) is stored for the luck penalty.

Consequences: S1 is pure and table-tested (`packages/shared/src/s1.test.ts`). Pattern lists will need tuning as real postings show gaps; the eval's tricky cases cover the known ones.

## ADR-034 Code-recomputed scores, verdict mapping and lane points
Context: FUNNEL says scores are "recomputed in code where possible" and verdicts follow fixed thresholds, but the rubric gives the wildcard lane 0 lane points, which makes `wildcard_fit` 6 almost unreachable (the most a wildcard job can score is 7). Model-set verdicts would also let injected text decide the outcome. Decision:
- **The model extracts; code decides.**
  - S3 returns requirements, each with level, type, match, gap type (when not met) and the fact aliases it relies on, plus the two rubric parts code can't judge (evidence 0–2, company fit 0–1) and the employer kind.
  - Code computes fit (lane points + must coverage × 3 + evidence + company fit + nice coverage, capped at 4 on a missing domain must-have and at 2 on a hard blocker), luck (FUNNEL's adjustments, with company size from the watchlist when known) and the verdict.
  - Verdict precedence is apply > wildcard > near_miss > skip, with thresholds from criteria. Near misses get a `shortfall` line from code.
  - The model's own fit, luck and verdict are stored only to flag drift above 2.
- **Citations are checked.** Facts appear as `F1…Fn` aliases (factId order). Unknown aliases are dropped, and a `met` or `partial` with no real fact becomes `missing`, flagged `unsupported_match`.
- **Lane points move into criteria** as optional `lane_points` (0–3 each), seeded primary 3, secondary 2, opportunistic 1, **wildcard 2**. They are code-only, never in a prompt. A strong wildcard job (fit ≥ 7, luck ≥ 5) is therefore `apply` by precedence; a moderate one (fit 6–6.9) is `wildcard`.
- With no must-haves extracted, coverage counts as half, rather than full marks.

Consequences: changing thresholds, lane points or exclusions re-scores without a model call (ADR-037). The model's output still drives fit through requirement matches, so prompt quality matters; the eval measures it.

*Addendum (M4 eval tuning, first live eval at 72.5%):* three scoring rules, all in code, applied on replay at no cost:
- **A missing must-have caps fit at 6.9**, below `apply_fit`. Any must-have the profile doesn't meet keeps a job out of Apply, and the near miss's `shortfall` names it.
- **A strong luck drag holds Apply back.** A single luck penalty (at most −2) couldn't stop an apply from fit ≥ 7 and luck ≥ 5. Now a big-brand employer, or an experience ask that survived S1 at or above `experience_cap_years`, makes the verdict `near_miss` ("Luck held back: …").
- **The hard-blocker cap (fit ≤ 2) applies only when the requirement's text matches one of `criteria.blockers` in code** (`hitsCriteriaBlocker`, the same patterns S1 uses). The model labelling something a hard blocker (a portfolio, say) is no longer enough; such a requirement counts as an ordinary missing must-have.

With those rules, a relabelled g21 (a strong wildcard job is Apply by precedence), and prompt changes (S3: "met" needs a fact showing that tool or skill or a clear equivalent; S2: skip only clear no's, pass uncertain roles with a low score), the live eval reached 85.0%. That is the baseline.

## ADR-035 S3 runs synchronously; caching, refusals and pacing
Context: ARCHITECTURE suggested Message Batches for deep reads. Batches are 50% cheaper (Sonnet 5.5 batch $1/$5 per MTok), but they're asynchronous (most finish within an hour, up to 24 h), cache hits inside a batch are best-effort, and they would need a poller function, a reservation that outlives the 15-minute TTL, and a second state machine. The 07:50 digest (M7) would often arrive before verdicts. Decision:
- **S3 runs inside the scan**, time-boxed (ADR-032); whatever doesn't fit waits for the next run. Batches go to the ROADMAP parking lot, to revisit if M4's run data shows S3 spend is the binding constraint.
- **Prompt caching on S3 only.** Its system prompt (instructions, facts, lanes, wildcards, company preferences, work rights) is identical for every job in a run and marked `cache_control: ephemeral` (5 minutes; calls in a run are seconds apart). S2's prompt is about 1,000 tokens, under Haiku 4.5's 4,096-token minimum (platform.claude.com/docs/en/build-with-claude/prompt-caching, checked 2026-10-03), so it isn't marked. Sonnet 5.5's minimum is 512 tokens.
- **No refusal fallback.** Server-side fallbacks need a beta header (ADR-016 allows none) and don't run on Batches. A refusal, `max_tokens` or output that fails zod twice puts the job up for review (`review: {stage, code}`), and no verdict is guessed.
- **Effort `low` for S3** (Sonnet 5.5 can't turn thinking off). The eval can compare effort levels later.

Consequences: verdicts appear when Scan now finishes. S3 costs about 1.5p per job rather than about 0.9p batched.

## ADR-036 Evals: a fake profile and recorded answers
Context: FUNNEL requires an eval with a ≥ 80% agreement gate in CI, with no Anthropic key in GitHub. Judging against the owner's real profile would need local admin credentials (ADR-011 has none), and the recordings would hold model output about real facts, which can't be committed. Decision:
- **The eval judges a fake candidate:** "Alex Example", the fake CV's facts with stable IDs and invented work rights (time-limited to 2028-06-30), with the public seed criteria. The owner labels 40 fake postings for "a candidate like this" (`evals/README.md`), blind to what each case was designed to test.
- **Recorded answers:** each request's key is a SHA-256 over model, effort, max tokens, system prompt, caching flag, messages and output JSON schema.
  - `npm run eval` replays `evals/recordings.jsonl`, with S1 and scoring running live, so CI checks every code change to rules, scoring and thresholds without a key.
  - A changed prompt, schema, model or case misses its recording and fails "recordings stale". `LIVE=1 npm run eval` (local, through `llm.call()` with a 150p cap) refreshes them.
- **Gates:** every case labelled; agreement ≥ 80% and not below `evals/baseline.json`; every injection case correct; the S1 title table (shared with `titles.test.ts`) at 100%.

Consequences: the eval measures prompt and logic quality on a stand-in, not on the owner's profile. Real-profile agreement comes from 👍/👎 in M5 (PRD's ≥ 85% after two weeks). A personal eval from an owner export is in the parking lot. Each prompt change costs about 40p to re-record.

## ADR-037 `scheduledScan`, `rescore` and their invocation
Context: PRD R4 needs scans at 07:30 and 17:30 on weekdays, and R3 needs "Re-score" with "next run uses the changed criteria". ARCHITECTURE described Re-score as "re-run S2–S3". Decision:
- **`scheduledScan`** (`onSchedule`, `30 7,17 * * 1-5`, Europe/London, 540 s, no retries) runs the same `runScan` as `scanNow`, with no cooldown. A busy lock is logged and the run skipped.
- **Every run reads the current criteria version** at funnel start and stamps `criteriaVersion` on each job it judges.
- **`rescore`** (owner callable, App Check consumed) takes the scan lock with no cooldown, records a `rescore` run, and covers jobs first seen in the last 14 days:
  - S1 runs again (free), so a rule change skips or un-skips straight away. This goes beyond ARCHITECTURE's "S2–S3".
  - Each judged job stores fingerprints of the exact S2 and S3 system prompts (plus model and prompt version). Where they still match, fit, luck and the verdict are recomputed in code from the stored output, with no model call. So changing thresholds, lane points, exclusions, the experience cap or freshness is free.
  - Changed lanes, wildcards, company preferences, facts or work rights change a fingerprint, and those jobs are queued for the model.
  - **Old verdicts stay until replaced:** a queued job keeps its verdict, scores and `criteriaVersion`, plus `rescoreQueuedAt`, until its new judgement is written in one update.
- **Invocation:**
  - the browser needs a public invoker binding on `rescore`, like every callable (RUNBOOK Part C step 28);
  - Cloud Scheduler needs `cloudscheduler.googleapis.com`, and the deployer needs `roles/cloudscheduler.admin`;
  - the scheduler's service account needs `run.invoker` on `scheduledScan`. The deploy account can't set IAM, so these are one-time manual steps (RUNBOOK Part E).

Consequences: re-scores of threshold-only changes are instant and free. A re-score with changed prompt inputs spends up to one run budget and may leave jobs queued for the next scheduled run.

**Addendum (v0.4.1): the schedule's invoker.** The first deploy of `scheduledScan` ended with no schedule:
- The Firebase CLI sets a new function's invoker *before* it creates the Cloud Scheduler job. The deploy account can't set IAM, so "Failed to set invoker" ended the deploy before the job existed, and the next deploy said "Skipped (No changes detected)".
- **Recovery** creates the job by hand under the exact name the CLI uses (`firebase-schedule-scheduledScan-europe-west2`), so later deploys update it (RUNBOOK Recovery).
- **The invoker must be exactly `hireframe-fns`.** Every deploy that changes the function rewrites the invoker unless the members are exactly that account; any extra member makes the deploy fail before it updates the schedule. Part E step 68 now binds `hireframe-fns` explicitly instead of copying whatever email the scheduler shows.
- v0.4.1 is the first deploy that changes the bundle, so RUNBOOK checks the job and the invoker before the tag.

## ADR-038 Dashboard data, job actions and feedback
Context: M5 turns M4's verdicts into the product (PRD R7). The owner needs to act on jobs (save, skip, mark applied) and say whether a verdict was right, and the PRD metric "verdict agreement ≥ 85%" needs that to be measurable. The jobs collection is otherwise server-written, so each client write is opened narrowly (ADR-011). Decision:
- **Client writes on `jobs/{jobId}` are limited to** `status` (between `new`, `saved`, `applied`, `skipped`; `CLIENT_JOB_STATUSES`), `appliedAt` and `appliedVerdict`, `feedback` and `updatedAt`. Nothing the funnel or ingest writes can change from the client, and a job in a server-owned status (`interview`, `offer`, `rejected`, Wave 2) can't be moved from the app. `validJobAction()` in `firestore.rules` enforces it, with tests in `tests/rules/jobs.rules.test.ts` that run the real builders (`web/src/services/job-writes.ts`).
- **Applied is stamped, not trusted.** Marking applied sets `appliedAt` to the server time and `appliedVerdict` to the job's own stored verdict in the same write (no `appliedVerdict` on a job that has none); leaving applied removes both.
- **Feedback** is `{agree, note? ≤ 280, verdict, expected?, at}`. `verdict` must equal the job's stored verdict, so a rating written after a re-score changed the verdict is rejected (the UI asks to retry) rather than recorded against the wrong judgement. `expected` is only for a 👎 and must differ from `verdict`. A new rating replaces the old one. Notes live on the job, never in events.
- **`events/{id}` is create-only**, written in the same batch as the job change: `job_status {from, to, verdict?}` or `job_feedback {agree, verdict, expected?}`, with the server time. The rules tie each event to the job as the batch leaves it (`get`/`getAfter`), so an event can't describe a change that didn't happen. Events are never updated or deleted, so metrics can be recomputed.
- **Agreement** (`verdictAgreement`, packages/shared/src/metrics.ts) over the last 14 days (`AGREEMENT_DAYS`):
  - an explicit 👍/👎 counts for or against the verdict it judged;
  - without one, Mark applied on an **Apply** verdict counts as agree;
  - skips and jobs with no action don't count;
  - there is **no implicit disagree**. This biases the rate upward (applying is a quiet 👍, ignoring is not a 👎), so the line shows the split (rated agree and disagree, applied) and the target stays 85% (`AGREEMENT_TARGET`).
- **Dashboard KPIs** (`todayKpis`): *to apply* (Apply verdicts with status `new` or `saved`), *to review* (near misses and wildcards, same statuses), *judged today* (non-skip verdicts since 00:00 Europe/London) and *applied this week* (since Monday 00:00 Europe/London) against `weekly_target`. The web service reads them as server-side counts (`getCountFromServer`), one read each, so the tiles stay exact beyond a page. Day and week boundaries are London calendar boundaries (`londonDayStart`, `londonWeekStart`), correct across the clock changes.
- **Spend meter** (`spendMeter`): spend over the month's `capPence` from `usage/{yyyy-mm}`; amber from 80% (`SPEND_WARN_FRACTION`, PRD R11), capped at the cap. A month with no usage document shows nothing spent against the default cap (`DEFAULT_MONTHLY_CAP_PENCE`, now in `packages/shared`).
- **Indexes** (six on `jobs`): `(verdict, status, judgedAt↓)`, `(verdict, judgedAt↓)`, `(status, judgedAt↓)`, `(status, appliedAt↓)`, `(review.stage, judgedAt↓)`, `(feedback.agree, feedback.at↓)`. Reads that the screens page through use `limit` and a cursor.
- **R7 measure ("loads usable in < 2 s on 4G")**: `hf:usable` is a `performance.measure` from navigation start to the first render of Today with tiles and the Apply list filled from Firestore, on Chrome Fast 4G, CPU 4× slowdown, signed in. Pass = the median of 3 **repeat visits** ≤ 2,000 ms; the median of 3 cold visits is recorded (target ≤ 3,000 ms) and doesn't gate. Levers if it fails, in order: start the Today queries during the owner check, Firestore persistent local cache, smaller initial chunks.
- **Keyboard shortcuts** are scoped to the focused list (WCAG 2.1.4): `j`/`k`/`a` act only while focus is inside it, never globally.
- **Parked:** 👎 → anonymised golden-set candidates (ROADMAP); a ⌘K palette.

Consequences: the owner's actions and ratings are recorded safely and can't touch verdicts. Agreement is a lower-effort proxy until enough explicit ratings exist. Re-scoring while a rating dialog is open fails the write instead of recording a stale rating.

## ADR-039 Funnel throughput: dated model IDs, back-pressure, cache-write worst case
Context: the first production run (v0.4.0) passed 422 jobs in S1, then S2 judged 30 and stopped, and S3 judged 5 of 8 at 14p of a 24p lease. The run took 135 s against a 400 s S2 deadline, and S2 had no errors (`s2.in` 30 = passed 8 + skipped 22, review 0). Two causes:
- **Dated model IDs were priced at the top rate.** `llm.call()` reserves at the requested model's price (`claude-haiku-4-5`) but settles at the price of the model the API reports, which for Haiku is the dated snapshot `claude-haiku-4-5-20251001`. That isn't a key in `PRICES_USD_PER_MTOK`, so `priceFor` fell back to `TOP_PRICE` (Sonnet 5.5's $2/$10) and every Haiku call settled at about 0.30p instead of 0.15p (1,476 in + 61 out at $2/$10 × 0.85 = 0.3028p). S2 hit its 40% share (9.6p) after 30 calls. Tests and fakes returned the alias, so none saw it. The deep read is priced correctly: the API reports `claude-sonnet-5-5`.
- **A refusal stopped the stage for good.** S3 reserves about 5.5p worst case per call against about 1.0p actual. With 2 in flight, a reservation is refused once used + 11p > 24p, and ADR-032's stop-on-refusal ended S3 at 14.3p with 3 candidates queued and 9.7p unspent.

Decision (amends ADR-016's price lookup and ADR-032's stop-on-refusal; the lease size is unchanged, so the monthly worst case of 46 × 24p plus the 25% manual share is unchanged):
- **F0. `priceFor` strips a trailing `-YYYYMMDD`** before the lookup and only then falls back to `TOP_PRICE`. The fallback is a `log.error` once per model per process, so a new ID can't hide.
- **F2. Back-pressure instead of stopping** (S2 and S3). Before a call the stage waits for in-flight calls to settle until the largest worst case reserved so far in that stage fits. It stops (`run_budget`) only when the call can't fit with nothing in flight, or at the deadline. A refusal while calls are in flight waits for one to settle and retries that job once; a second refusal with calls still in flight leaves that job queued and the stage keeps going. `llm.call()`'s reserve-or-refuse check and the lease are unchanged.
- **F4. Cached prompts reserve input at max(input, 5-minute cache write).** A cache write costs more than uncached input, so the old bound could be exceeded on the first call of a run.
- **F5. `budget.stops: {s2?, s3?}`** records each stage's own stop reason; `stoppedBy` stays as the first of them. System shows both.

Expected per run at 24p: S2 about 55–60 calls (against 30), S3 about 8–10 deep reads when that many candidates exist (against 5).

**`usage/{month}` is overstated, and isn't hand-corrected.** Every Haiku call since v0.2.0's `addFact` (and S2 triage since v0.4.0) settled at twice its cost, in `spendPence`, `byPurpose`, each run's `costPence` and the eval's reported cost. Reservations were always right, and the error is fail-safe (overstated, never understated). October's triage excess is about 4.6p (30 calls), plus about 0.1–0.2p per Add-fact note. A hand edit risks more than it saves: a `usage/{yyyy-mm}` document that fails its schema blocks every model call (ADR-016). Closed months don't matter and October corrects itself going forward. To compute the exact figure if ever needed, take `tokens['claude-haiku-4-5-20251001']` in the month's document and price it at Haiku's rates, against the top rate it was charged at.

Considered and dropped on this run's evidence:
- **F1, draining during the fetch:** the time box isn't the cause.
- **F3, a rate-limit pause:** there were no 429s. If either shows up, the per-stage stop reasons will name it (`deadline`, `model_errors`).

Parked (ROADMAP): `deepRead.maxTokens` 2,500 at the next forced re-record (keep 4,000 if real outputs exceed about 1,250 tokens), and Message Batches (ADR-035).

Consequences: S2 settles at about 0.15p a call and the spend meter is accurate for Haiku again. A truly new model still logs an error and is over-, never under-charged. The worst-case reservation per call is unchanged apart from F4, which can only raise it.
