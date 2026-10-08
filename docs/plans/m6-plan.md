# M6 Gmail bridge + Lookup — plan

Two PRs, each branched from `main` (never stacked):
1. **`feat/m6a-gmail-bridge` → tag `v0.6.0`**: Apps Script bridge, `ingestEmailJobs`, alert parsers, the "needs description" state in the funnel.
2. (v0.6.1 was funnel-intake PR B.) **`feat/m6b-lookup` → tag `v0.6.2`**: one PR built in two sessions: (1) the funnel steps refactor, the `lookup` callable and the ATS board search; (2) the web (Lookup screen, Today section, Jobs filter, sheet control).

**Sequencing:**
- 6A branches from `main` now. It is merged and tagged only **after the Wed 7 Oct 17:30 scheduled run**, so that run still measures the pre-alert intake.
- Funnel-intake PR B (ADR-045, reserved) branches from `main` after 6A merges. Its cap sizing uses runs **without** alert volume, so it is revisited a week after 6A ships, with alert jobs in the intake.
- 6B branches after 6A merges.

Each session ends with `npm run check`, `npm run test:rules`, `npm run build` + `check:bundle`, the bundle smoke script, and a list of deviations from this plan.

**Sources:** the post-deploy steps below come from STATUS.md "Pending / known" (kept in the claude.ai Project, not the repo), RUNBOOK (Part C step 28, Part E step 68, Recovery), ADR-037's addendum and the M5 plan (step 3).

## Context
M6 is the "usable" milestone (ROADMAP): from here the owner relies on Hireframe daily. Two gaps stop that today:
- **LinkedIn, Work at a Startup, Escape the City, Wellfound and the other alert-only boards** (ADR-004, ADR-026, ADR-028) reach the owner's inbox but never reach Hireframe. `linkedin-alert` already exists as a source ID, `keysFromUrl` already reads LinkedIn job IDs, and dedupe already merges the LinkedIn-alert + Greenhouse fixture pair (`dedupe.test.ts`), but nothing ingests email.
- **No way to ask "have I seen this job?"** (PRD R8). The Lookup tab is a placeholder (`nav.ts`), and a LinkedIn job the owner finds by hand can't be judged, because LinkedIn can't be fetched (ADR-004).

What exists to build on:
- `normaliseRawJob`, `dedupeBatch`, `planIngest`, `buildNewJob` (`packages/shared/src/dedupe.ts`); `findJobsByKeys` and `writePlan` (`functions/src/scan/store.ts`).
- The scan lock `locks/scan` (`acquireLock`/`releaseLock`, ADR-029).
- `runFunnel` (`functions/src/funnel/run.ts`): S1 `applyHardRules`, S2/S3 via `llmCall`, `judge` → `s3Patch`, the `Hydrator` interface (Reed details), the expiry sweep (`staleQueuedSpec`).
- `llmCall` + `UsageStore` (ADR-016), the ATS source modules and the HTTP client (robots, UA, per-host spacing, ADR-029).
- Query specs + `indexServes` (ADR-040), lazy screens (ADR-021), `readJob`, `JobDetail`, `JobList`.

---

## PR 6A: Gmail bridge (`feat/m6a-gmail-bridge`, v0.6.0)

### How it works
1. **Gmail** (owner's own account): filters put alert emails under `hireframe/alerts` (RUNBOOK one-time steps 5–6).
2. **Apps Script** (`/apps-script`, clasp), every 30 min:
   - lists messages with `label:hireframe/alerts -label:hireframe/done`, oldest first, at most 20 per run;
   - for each, sends only `{ id, receivedAt, from, text, html }` (bodies capped, see Limits). No subject (the parser ignores it), and never To, Cc, Delivered-To or other headers;
   - POSTs batches signed to `ingestEmailJobs`, **batched by bytes**: each POST body stays under about 900 kB (`MAX_POST_BYTES`, under the server's 1 MB limit) and at most 5 messages. A single message that alone would pass the limit is truncated to fit (`html` first, then `text`) and sent on its own;
   - relabels a message `hireframe/done` (removing `hireframe/alerts`) **only** when the response says `processed`, `duplicate` or `unparsed` for that message ID. On `busy`, `deferred`, a non-2xx or a network error it leaves the label, so the next trigger retries.
3. **`ingestEmailJobs`** (HTTPS `onRequest`, not a callable):
   - verifies the signature and the nonce, then takes the scan lock as a short holder (see Lock), or answers 503 `busy`;
   - for each message: skips it if `alertMessages/{sha256(id)}` exists (`duplicate`); routes it by sender; parses it deterministically (LinkedIn) or with the cheap model (anyone else); normalises → `dedupeBatch` → `findJobsByKeys` → `planIngest` → `writePlan`. New jobs land at `s0`, as from a scan;
   - records `alertMessages/{hash}` (counts only), updates `sources/email` health, releases the lock, and answers per-message statuses.
4. **The next scan** runs S1–S3 on them as usual. A job with no description (every LinkedIn alert job) never gets a deep read on empty text: S3 sends it to the new **needs-description** state (`next: 'description'`) for free. PR 6B fills it.

### Signing and replay (SECURITY "Forged calls to webhooks")
- **Headers:** `X-Hireframe-Timestamp` (Unix seconds), `X-Hireframe-Nonce` (UUID v4 from `Utilities.getUuid()`), `X-Hireframe-Signature` (hex).
- **The secret is trimmed on both sides** (the server after reading Secret Manager, the script after reading Script Properties), so a trailing newline from `gcloud` or a paste can't make every signature fail. G1 creates it without one anyway.
- **Signature:** HMAC-SHA256 with the shared secret over `v1.<timestamp>.<nonce>.<raw body>`. That covers body + timestamp as asked, and the nonce too, so a nonce can't be swapped onto a captured request. The message builder is a pure function in `packages/shared/src/ingest.ts`, bundled into the Apps Script too, so both sides build the same string.
- **Verify** on `req.rawBody`, never on re-serialised JSON:
  - method POST, `Content-Type: application/json`, body ≤ 1 MB, all three headers well-formed;
  - |now − timestamp| ≤ 300 s;
  - expected and given signatures decoded to 32-byte buffers and compared with `crypto.timingSafeEqual`, after a length check that returns the same 401 (no early exit on the first differing byte);
  - **only then** the nonce: `nonces/{nonce}` is created with `create()` (fails if it exists) holding `expireAt = now + 10 min`. Already there → 401 `replay`.
  - The nonce TTL (10 min) is at least twice the skew (5 min), so a replay is always caught by one check or the other. `config.test.ts` pins that.
- **Cleanup:** a Firestore TTL policy on `nonces.expireAt` (a `fieldOverrides` entry in `firestore.indexes.json` with `ttl: true` and no indexes). Expired-but-not-yet-deleted nonces are harmless, because the timestamp check already rejects them.
- **Errors** carry no detail: 401 for every signature, skew or replay failure (the reason is logged as a fixed code), 413 too large, 400 malformed, 503 busy. Never echo the body.
- **Instances:** `maxInstances: 1`, stated on the function (not only inherited from the global options), so ingests never run in parallel.
- **Auth model:** the function is publicly invocable (`allUsers` run.invoker, like the callables) because Apps Script can't present a Google identity the function would accept without putting the owner's address in IAM; the HMAC is the authentication. No App Check (Apps Script can't produce a token).

### Parsing (server-side, so the script stays dumb)
- **Sender routing** (`packages/shared/src/alerts/route.ts`, pure): on the exact `From` address.
  - `jobalerts-noreply@linkedin.com` → the LinkedIn parser;
  - everything else → the model fallback.
  - The subject is never read.
- **Auto-forwarded alerts from the second Gmail account:**
  - LinkedIn alerts reach the primary inbox through a Gmail filter on the second account that auto-forwards them. Gmail keeps the original `From` and body (it rewrites only the envelope sender and adds `X-Forwarded-*` headers).
  - So a forwarded alert arrives with `From: jobalerts-noreply@linkedin.com` and routes and parses exactly like a direct one. The primary account's filter on that address labels it. The parser needs no forwarding logic, and no manual-forward (`---------- Forwarded message ---------`) handling is built.
  - The router never needs the owner's addresses, so none are in code or config. The script doesn't send `X-Forwarded-For` (it holds the second account's address).
  - Sender routing chooses a parser; it isn't trust. Anyone can email the inbox something alert-shaped, and the worst case is a fake job that goes through the funnel as untrusted text.
  - The same alert delivered to both accounts has two Gmail IDs but the same LinkedIn job IDs, so the second copy merges as `duplicate` and creates nothing.
- **LinkedIn parser** (`packages/shared/src/alerts/linkedin.ts`, pure, deterministic), one job per card:
  - **Job ID:** from the card's title link `/jobs/view/{id}` (including `/comm/jobs/view/{id}/?trackingId=…` and slugged `/jobs/view/{slug}-{id}`), the same regex as `keysFromUrl`. `externalId` = the ID; `url` = the canonical `https://www.linkedin.com/jobs/view/{id}` (the tracking URL is never stored; it can carry per-recipient tokens).
  - **Title:** the title link's text.
  - **Company and location:** the line `Company · Location (Work mode)`, split on the first ` · `. A trailing `(Hybrid)`, `(Remote)` or `(On-site)` becomes `remoteHint` (`hybrid`/`remote`/`onsite`) and is removed from `locationText`.
  - **Bare towns:** the email's header line `N new jobs in <country>` gives the alert's country. A location with no comma (e.g. `Reading`) becomes `Reading, <country>` before `parseLocation`, so `country` is `GB` for a UK alert rather than `unknown`. Locations that already name a region or country are left as they are. No header line → unchanged (S1 passes `unknown`).
  - **Salary (optional):** a salary line under the company line (e.g. `£35K/yr - £45K/yr`, `£30,000/yr`, `£15/hr`) → `salary` through a pure `parseSalaryText` (currency from the symbol, min/max, period). Anything it can't read is left out, never guessed.
  - **Badges:** `Easy Apply` → `easyApply: true` on the posting (below). Other badges ("Promoted", "Actively recruiting", "n connections", "Be an early applicant") are dropped.
  - **No description, no posted date:** `description: { kind: 'none', format: 'text', body: '' }` (new kind, below) and no `postedAt`. Freshness uses `firstSeenAt`, as for any job without a posting date (S1 flags `freshness_unknown`, ADR-033).
  - Links that aren't job titles (unsubscribe, settings, "See all jobs") are ignored. Repeats of an ID in one email collapse. At most 30 jobs per email. A LinkedIn alert with job links but no parsed card counts as `unparsed`.
- **Easy Apply is kept on the source, not in `flags`.** `flags` belong to the funnel and S1 rewrites them, so Easy Apply goes on the posting: `RawJob.easyApply?`, carried through `NormalisedJob` to `JobSourceRef.easyApply?: true` (`sourceRef`). It survives merges, since each source keeps its own ref. It is data only: no funnel or score change. The job sheet shows an "Easy Apply on LinkedIn" badge next to that source's link.
- **Model fallback for other senders** (Work at a Startup, Escape the City, Wellfound, WTTJ, Reed, Indeed alerts):
  - new purpose `alertParse` (Haiku, like `addFact`) through `llm.call()`, with the monthly cap and a daily cap (below);
  - the email text goes in an `<email>` tag it can't close (`functions/src/llm/untrusted.ts`), with "data, not instructions"; no tools; fixed schema `{ jobs: [{ title, company, location, linkIndex | null }] }`, at most 30;
  - **the model can't plant a URL:** links are extracted in code from the HTML (`href`s) and listed as numbered items; the model returns an index. An index out of range is dropped;
  - **allowlisted links** (host in `ALERT_LINK_HOSTS`: the ATS hosts, LinkedIn, Reed, Adzuna, Indeed, Wellfound, Work at a Startup, Escape the City, WTTJ; `functions/src/config.ts`) are canonicalised with tracking parameters dropped and used as usual: `job.url`, the source ref's `url`, and `keysFromUrl` keys (`greenhouse:…`, `reed:…`), so an alert linking a watched board merges with it;
  - **an https link on any other host keeps the job.** The link is stored on the source ref only (`sources[].url`, with `sources[].unverified: true`); it gives no keys and is never logged. The job's own `url` is then a LinkedIn search link for title + company (as for Lookup's paste), labelled "Search link". The sheet shows the unverified link with its host and an "unverified link" mark. A job with no https link at all gets the same search link;
  - source `email-alert` (new), `externalId` = a 64-bit hash of company|title|city (normalised, as the `d:` key), so it doesn't depend on a link;
  - zod failure twice, a refusal or `max_tokens` → that message is `unparsed` (relabelled, counted, never guessed).
- **Company:** each parsed job's company is matched to the watchlist (`normaliseCompany` equality, one `companies` read per request) to set `companyId`.
- **Limits** (`ALERTS` in `functions/src/config.ts`): 5 messages per request, 20 per script run, `text` ≤ 100k and `html` ≤ 300k characters (the script truncates; the server re-checks with zod), model calls only within 35 s of the request starting. Apps Script's `UrlFetchApp` gives up after about 60 s, so later messages come back `deferred` and stay labelled.

### Lock: email ingest and scans never write at once (ROADMAP M6)
- `locks/scan` gains `holder: 'scan' | 'rescore' | 'email' | 'lookup'` and `staleAt` (optional; old docs fall back to `startedAt + 12 min`). Email's `staleAt` is start + 3 min (the function's 120 s timeout plus a margin), so a killed ingest blocks scans for 3 minutes, not 12.
- Ingest acquires with no cooldown. A scan already holding the lock → 503 `busy`; the script retries in 30 min.
- **`scheduledScan` waits for a short holder:** if the lock is held by `email` or `lookup`, it retries every 15 s for up to 4 min before skipping (today it skips at once). A scan holder still makes it skip. So the 07:30 run is never lost to a 30-minute ingest.
- `scanNow` keeps refusing with `busy`; the System message names the holder ("Importing alerts, try again in a minute").

### The needs-description state
- `next` gains `'description'` (`WAIT_STATES = ['s2', 's3', 'description']`; `QUEUE_STAGES` stays `['s2', 's3']` for the model stages and the lease).
- `DESCRIPTION_KINDS` gains `'none'`.
- In `runS3`, a job whose `descriptionKind` is `'none'`, or whose stored text is under `FUNNEL.minDeepReadChars` (200), first tries the hydrators (Reed details today; 6B adds the ATS board search). With no text it gets `needsDescriptionPatch` (`next: 'description'`, flag `needs_description`), with no model call and no slot used. Counted as `s3.needsDescription` (optional on `S3CountsSchema`, so old runs parse).
- The expiry sweep also covers `next: 'description'` (`staleQueuedSpec` takes a `WaitState`; the `(next, sortAt desc)` index serves it), so an alert job nobody described expires after `freshness_days` like any queued job.
- **A merge that brings a full description releases the job.** Today a merge only adds a source and keys. Now `planIngest` also plans a description upgrade when the stored job's `descriptionKind` is `none` (or `snippet`) and an incoming member has `full` text:
  - it writes `description/raw`, sets `descriptionKind: 'full'`, adds `postedAt` if the job has none;
  - if the job is at `next: 'description'`, it sets `next: 's3'`, in the same batch.
  - `JobKeysProjectionSchema` (the `select` in `findJobsByKeys`) gains `descriptionKind`, `next` and `postedAt` for this. The same upgrade applies when email ingest, a scan or Lookup's ATS search does the merge.
  - In the other order (the ATS job is stored first and the alert merges into it), the job already has full text and never enters the state.
- A snippet-only job (Adzuna, HN) keeps today's behaviour: a deep read flagged `snippet_only`.
- 6A has no screen for these jobs; System shows "Waiting for a description: n" next to the queue counts. 6B adds the paste.

### Files
- **`/apps-script`** (new workspace, TypeScript, esbuild → `apps-script/build/Code.js` + `appsscript.json`; `.clasp.json` gitignored, `.clasp.json.example` committed):
  - `src/bridge.ts`: pure core with injected Gmail, fetch, clock, properties and signer: list → batch → sign → post → relabel by per-message status;
  - `src/main.ts`: Apps Script glue (Advanced Gmail service `Gmail.Users.Messages`, `UrlFetchApp`, `PropertiesService`, `Utilities.computeHmacSha256Signature` → hex, signed-byte safe), `run()` for the trigger and `setup()` that installs the 30-minute trigger once;
  - `appsscript.json`: scopes `gmail.modify` (read and relabel; GmailApp would need full `mail.google.com`), `script.external_request`, `script.scriptapp`. No MailApp scope until M7;
  - Script Properties `HIREFRAME_INGEST_URL`, `HIREFRAME_HMAC_SECRET` (never in code).
- **Shared:** `ingest.ts` (signed-message builder, request/response schemas, per-message statuses), `alerts/route.ts`, `alerts/linkedin.ts`, `alerts/salary.ts` (`parseSalaryText`), `alerts/links.ts` (href extraction, host allowlist check), `jobs.ts` (`JOB_SOURCE_IDS` + `email-alert`; `DESCRIPTION_KINDS` + `none`; `easyApply?` on `RawJobSchema` and `JobSourceRefSchema`; `SOURCE_KEY_PREFIX`; `RUN_TRIGGERS` unchanged), `dedupe.ts` (`easyApply` through `normaliseRawJob` and `sourceRef`), `funnel.ts` (`WAIT_STATES`, `next`, `needs_description` flag, `s3.needsDescription`), `usage.ts` (daily caps, below), `firestore.ts` (`nonces`, `alertMessages`, `sources/email`), `fixtures/alerts.ts` (fake LinkedIn alerts, plain and HTML: a UK header with full and bare-town locations, Hybrid/Remote/On-site, with and without salary, Easy Apply on some cards; the same alert as auto-forwarded from a second account; a fake WaaS alert; an injection alert).
- **Web (6A):** the job sheet's source line shows "Easy Apply on LinkedIn" when that source has `easyApply` (lazy sheet code only).
- **Functions:** `ingest/handler.ts` (`ingestEmailJobs`), `ingest/hmac.ts` (verify, `node:crypto`), `ingest/nonces.ts`, `ingest/run.ts` (the per-request pipeline, dependency-injected like `runScan`), `ingest/parse-llm.ts`, `ingest/store.ts`; `scan/store.ts` (lock holder and `staleAt`, `findJobsByKeys` through a spec); `scan/callables.ts` (scheduled wait for short holders); `funnel/run.ts` + `judgement.ts` (needs-description routing, sweep over three wait states); `funnel/queries.ts` (`staleQueuedSpec(WaitState)`, `jobsByKeysSpec`); `config.ts` (`ALERTS`, `ALERT_LINK_HOSTS`, `alertParse` model and `PURPOSE_CALLABLE`, `INGEST_HMAC_SECRET_NAME`, `HMAC` skew/TTL); `index.ts`; `dev-fakes.ts` (fake alert-parse answers).
- **Shared callables:** `CALLABLE_TIMEOUT_SECONDS.ingestEmailJobs = 120` (it isn't a callable, but the timeout table is where budgets are checked).
- **Rules / indexes:** explicit deny for `nonces` and `alertMessages` (default deny already, made explicit with tests); `sources/email` readable like the other `sources` docs; the TTL `fieldOverrides` entry. No new composite index.
- **Web:** System shows the `email` source card (last ingest, messages, jobs new/merged/duplicate, unparsed) and "Waiting for a description: n". Lazy System chunk only.
- **Scripts:** `npm run build:apps-script`; dev seed adds one alert-ingested job at `next: 'description'`; `scripts/sign-test-alert.ts` posts a fake alert, signed with the local placeholder secret, to the emulator (for `npm run dev` checks).
- **Docs:** ADR-046, ADR-047, ADR-048; ARCHITECTURE (Functions table, data model, Gmail bridge section, lock); FUNNEL (S3 needs-description routing, sweep); SECURITY (HMAC row detail, Gmail scopes, secrets checklist, "HMAC verified with a replay test" ticked); RUNBOOK Part G (below); ROADMAP (parking lot: deterministic Work at a Startup and Escape the City parsers; watchlist auto-growth, to judge later from System's needs-description count); CHANGELOG `0.6.0`, and fix the headings: today's `[Unreleased]` items were released as `[0.5.4]` (sort and filter) and `[0.5.5]` (expiry sweep and S2 skip-reasons panel); CLAUDE.md commands (`build:apps-script`, `sign-test-alert`).

### Data model changes (6A)
- `jobs`: `sources[].id` and `description/raw.sourceId` may be `email-alert`; `sources[].easyApply?: true`; `descriptionKind` may be `none`; `next` may be `description`; flag `needs_description`. LinkedIn alert jobs may carry `salary` and a `remote` mode from the card.
- `locks/scan`: `holder?`, `staleAt?`.
- `nonces/{nonce}` (new, server-only): `{ expireAt, schemaVersion }`, TTL on `expireAt`.
- `alertMessages/{sha256(gmail message id)}` (new, server-only): `{ sender: <sender domain>, parser: 'deterministic' | 'model', jobs, new, merged, duplicate, unverifiedLinks, status, at, expireAt (+30 days, TTL), schemaVersion }`. Counts and the sender's domain only: no subject, address, link or text.
- `sources/email` (new doc in an existing collection): `SourceHealth`, with `requests` = messages, `fetched` = jobs parsed, `invalid` = unparsed messages, plus `bySender: { [domain]: { messages, jobs, unparsed, unverifiedLinks, lastAt } }` (at most 20 domains; the rest under `other`). System shows these **counts per sender**.
- `jobs.sources[].unverified?: true` (off-allowlist link, model-parsed alerts only).
- `usage/{month}`: optional `daily: { [key]: { day: 'YYYY-MM-DD', spendPence } }` (keys `alertParse`, and `lookup` in 6B). Optional, so existing documents still parse (the schema fails closed).
- `runs`: none (an ingest every 30 minutes would flood Recent runs; `sources/email` carries its health instead).

### Daily caps (shared with 6B)
- A `dailyCapped(store, key, dailyCapPence)` wrapper around the `usage/{month}` `UsageStore`. In the **same** reserve transaction it checks the month (unchanged) and the day: `daily[key].spendPence` (when `day` is today, Europe/London) plus live reservations whose ID starts with `<key>-` plus this call ≤ the daily cap. Settle adds the actual cost to `daily[key]`. Stale reservations are charged as today by the existing path, and to the day as well.
- `alertParse` default 10p/day (`config/app.alerts.dailyCapPence` overrides, parsed on its own like `funnel`). At about 0.3p per email, that's about 30 non-LinkedIn alerts a day; over it, messages come back `deferred`.

### New queries (added to the specs)
- `jobsByKeysSpec(keys)` (functions): `keys array-contains-any` (≤ 30), select projection. `SpecOp` gains `array-contains-any`, treated as an equality filter by `indexServes` (an automatic single-field index serves it). This moves `findJobsByKeys` onto a spec, a first step on the ROADMAP item for the old `store.ts` queries.
- `staleQueuedSpec('description', before)` (functions): served by the existing `(next, sortAt desc)`.
- `needsDescriptionCountSpec` (web System): `next == 'description'`, count. Served without a composite.
- All in `functions/src/funnel/queries.test.ts` and `web/src/services/indexes.test.ts`.

### Tests (6A)
- **HMAC** (`ingest/hmac.test.ts`): a valid request passes; wrong secret, a changed body byte, a changed timestamp or nonce each fail; skew at 299 s passes and at 301 s fails (both directions); missing, non-hex, short and long signatures return 401 without throwing; the compare goes through `timingSafeEqual` (spy), and a length mismatch takes the same path; the nonce is written only after the signature checks.
- **Replay** (emulator, `tests/emulator/ingest.test.ts`): the same signed request twice → the second is 401 `replay` and writes nothing; a fresh nonce on the same body passes; an old timestamp with a new nonce fails on skew. `config.test.ts`: nonce TTL ≥ 2 × skew.
- **Secret whitespace:** a secret stored with a trailing newline (and leading/trailing spaces) on either side still verifies, because both sides trim; an otherwise different secret still fails.
- **Cross-implementation vector:** the Apps Script signer (with a byte-array fake of `computeHmacSha256Signature`, negative bytes included) and the server verifier agree on fixed vectors.
- **Apps Script core** (`apps-script/src/bridge.test.ts`): only whitelisted fields leave the script (no To/Cc/headers/subject); **byte batching**: every POST body (UTF-8 bytes, multi-byte characters included) ≤ 900 kB and ≤ 5 messages; six small messages → two POSTs; three 400 kB messages → three POSTs; one 2 MB message → truncated (`html` first, then `text`) to fit, sent alone, and still verifies on the server; relabel only on `processed`/`duplicate`/`unparsed`; `busy`, `deferred`, 5xx, network error and a timeout leave labels; caps on message count and body length.
- **Parsers** (`alerts/*.test.ts`, fake fixtures): IDs from every LinkedIn URL shape; title from the link text; `Company · Location (Hybrid)` split, with each work mode mapped to `remoteHint` and removed from the location; a bare town gets the header's country (`country: 'GB'`), a full location is untouched, no header line leaves it unchanged; salary forms (`£35K/yr - £45K/yr`, `£30,000/yr`, `£15/hr`, absent, unreadable → omitted); Easy Apply → `easyApply` on the source ref, other badges dropped; no `postedAt` and description kind `none`; repeated IDs collapse; tracking URLs never stored; non-job links ignored; the subject is not read (same result with any subject); only `jobalerts-noreply@linkedin.com` routes to the LinkedIn parser; the auto-forwarded copy parses identically to the direct one; injection text stays data in the title; caps.
- **Easy Apply through dedupe:** `normaliseRawJob` → `planIngest` → `sourceRef` keeps `easyApply`, on a new job and on a merge into an existing Greenhouse job.
- **Model fallback** (fake transport): link indexes out of range dropped; an off-allowlist https link keeps the job, sits only on the source ref with `unverified`, adds no key, gets a search-link `job.url`, and never reaches the log; `externalId` is the company|title|city hash; per-sender counts on `sources/email`; invalid output twice → `unparsed`; daily cap refusal → `deferred`, nothing written; the 35 s window → later messages `deferred`.
- **Pipeline** (`ingest/run.test.ts`): idempotency by message hash; lock busy → 503 and nothing parsed; `companyId` matched from the watchlist; health counts.
- **R5 AC end to end** (emulator): ingest the fake LinkedIn alert for the fixture role, then run a scan with the Greenhouse fixture of the same role → **one job** with both sources and `linkedin:4012345678` in `keys`; and the other order (scan first, then the alert).
- **Description upgrade on merge, both orders** (`dedupe.test.ts` for the plan, emulator for the writes): alert first (job at `next: 'description'`), then a scan merges the Greenhouse posting → full description written, `postedAt` added, `next: 's3'`; Greenhouse first, then the alert → the alert only adds its source, and the job never waits for a description. A job at `next: 'description'` merged with another snippet-only source stays waiting.
- **Funnel:** S3 sends `none` and short-text jobs to `next: 'description'` with no model call and no slot; the Reed hydrator still runs first; the sweep expires stale `description` jobs; S2 runs with empty text.
- **Lock:** short holders' `staleAt`; `scheduledScan` waits for `email`/`lookup` and skips on `scan`; ingest refused while a scan runs.
- **Logs:** fixture subjects, addresses and text never reach the log or the console, on success and on every failure path (the CV tests' pattern).
- **Rules:** `nonces` and `alertMessages` deny owner and anon reads and writes; `sources/email` owner-readable.
- **Usage:** the `daily` field parses when absent; daily cap math (pure); stale reservation charged to the day.
- **Bundle smoke:** `ingestEmailJobs` in europe-west2; no alert fixtures in the production bundle.
- `npm run eval` unchanged (no S2/S3 prompt change).

### PRD acceptance (6A)
- **R5 AC:** seeded duplicate fixtures (LinkedIn alert + Greenhouse listing of the same role) collapse to one job, now through the real email path (emulator test above), both orders.
- **R8 AC (half):** jobs ingested from LinkedIn alerts carry `linkedin:{id}` in `keys`, so 6B's match by ID has something to find.
- **R12:** the bridge's health on System; a silent bridge shows as a stale "last ingest".
- **SECURITY checklist:** "HMAC verified with a replay test" ticked; HMAC secret in Secret Manager.

### ADRs (6A)
- **ADR-046 Gmail bridge transport and signing:** Apps Script in TypeScript bundled by esbuild and pushed with clasp; Advanced Gmail service with `gmail.modify`, not GmailApp; the signed string, headers, skew, nonce store and TTL, raw-body verification, constant-time compare, uniform 401s; public invoker with HMAC as the authentication and no App Check; relabel only on a per-message success, idempotency by message hash; the 60 s UrlFetch limit and `deferred`.
- **ADR-047 Alert parsing:** routing on the exact `From` (`jobalerts-noreply@linkedin.com`), subject ignored, auto-forwarded copies handled because Gmail keeps `From` and body (no manual-forward parsing); the deterministic LinkedIn card parser (ID → `externalId`, canonical URL, no tracking URLs, `Company · Location (mode)`, the header country for bare towns, optional salary, no `postedAt` so freshness uses `firstSeenAt`); Easy Apply on the source ref rather than in funnel `flags`; model fallback for other senders with link indexes (the model can't plant a URL), the host allowlist, and off-allowlist links kept on the source ref only as unverified, with a hash `externalId`; deterministic Work at a Startup and Escape the City parsers parked; `email-alert` source; description kind `none`; the daily cap mechanism; no email text stored or logged.
- **ADR-048 One writer lock with short holders, and the needs-description state:** the lock's `holder` and `staleAt`, the scheduled wait for short holders (amends ADR-029/ADR-037); `next: 'description'`, S3 routing with no spend, the sweep covering it (amends ADR-043).

### Risks (6A)
- **LinkedIn changes its alert layout.** The parser is fixture-tested; a layout change shows as messages with 0 jobs. Mitigation: a LinkedIn email with links but 0 parsed jobs counts as `unparsed` and System shows the count; the fixture is refreshed from a real alert by the owner (with fake values), never committed raw.
- **The first deploy with a new `onRequest` function may fail at "Failed to set invoker"**, as `scheduledScan` did (ADR-037 addendum). If it does: bind the invoker by hand (step G5) and redeploy.
- **TTL policy deploy.** If the deployer can't apply `fieldOverrides.ttl`, create it in Cloud Shell (step G4). Until it exists nonces accumulate (tiny, harmless).
- **Freshness on `firstSeenAt`** understates a job's age: a role posted 3 weeks ago and first alerted today looks new for 14 days. Accepted (no posted date exists in the alert); a scan or Lookup that finds the ATS posting brings its real `postedAt` with the description upgrade on merge.
- **Bare-town country** comes from the alert's header, so a non-UK alert would mark its bare towns with that country (correct), and a missing header leaves them `unknown` (S1 passes them to S2).
- **Apps Script quotas** (UrlFetch calls/day, 6 min per run, trigger jitter): 48 runs × ≤ 4 POSTs is far below them.
- **Alert job volume** adds S2 calls inside the run lease. LinkedIn alerts are already filtered by the owner's alert setup; watch `s2.in` in the first week (the FUNNEL sizing method covers it).
- **`scheduledScan` wait** adds up to 4 minutes before a skip; the run's own deadlines start after the lock is taken.

---

## PR 6B: Lookup (`feat/m6b-lookup`, v0.6.2)

### Flows
1. **Match (no callable, no spend):** the owner pastes one URL or many lines of text. Pure `parseLookupInput` (`packages/shared/src/lookup.ts`) pulls every URL, then `keysFromUrl` + `canonicalUrl` per URL. The browser reads jobs (the owner can already read `jobs`):
   - keys in chunks of 30 with `array-contains-any`;
   - unmatched URLs with no key: `url == canonical`.

   Each line shows **Seen** (verdict badge, stage it stopped at, first seen and judged dates, opens the job sheet) or **Not seen yet**. Matching works even while a scan runs.
2. **Add unseen LinkedIn jobs from a results page:**
   - The owner copies the LinkedIn search results page (select all, copy, about 25 jobs) into the paste box. The paste handler reads `text/plain` and, when present, `text/html`. From the HTML it keeps only anchor `href`/text pairs, so each card's `/jobs/view/{id}` can be paired with its title. Nothing is fetched.
   - **The pasted HTML is parsed only with `DOMParser`** (`parseFromString(html, 'text/html')`, an inert document: no scripts run, no images load) and only to read `a[href]`. It is never inserted into the page: no `innerHTML`, no `dangerouslySetInnerHTML`, no node adopted into the live DOM. Only the `{href, text}` strings leave the helper, and they render as text.
   - Pure `parseResultsPage(text, links)` (shared) returns `{ title, company, location, age, linkedinId? }[]` (≤ 50). Ages like "3 days ago", "Reposted 1 week ago" and "Just now" become an approximate `postedAt` (flagged `posted_estimated`).
   - **Fallback:** when the deterministic parser finds no job in a long paste, the callable makes **one** cheap-model call (new purpose `pasteParse`, Haiku, through `llm.call()` under the monthly cap and the daily Lookup cap). The text is in a tag it can't close, with a fixed schema of rows; a LinkedIn ID can come only from an anchor index into the code-extracted links, never from the model's text. The preview shows its rows the same way.
   - Each parsed row is matched as in flow 1, by LinkedIn ID if paired, else by the `d:` key (company|title|city). The preview shows seen and new rows; the owner unticks any and presses **Add n jobs**.
3. **The `lookup` callable, `{ action: 'add', jobs }`.** Owner-only with App Check enforced and consumed, like every other callable (`ownerOptions`, `requireOwner`; it spends money, so the client never retries it):
   - takes the scan lock as a short holder for the create step only (dedupe against stored keys, create). If a scan holds the lock it waits up to 20 s, then returns `busy` with the expected finish ("A scan is running; adding will work in about n min"). Matching still works meanwhile;
   - creates each job as a `lookup`-source job with `addedAt` (server time), `stage: 's1'`, the S1 result stamped at once. S1 skips are final (rule shown);
   - releases the lock, then runs **S2 on title, company and location** (no description) for the survivors, through `llm.call()` with the daily Lookup cap, concurrency 4;
   - S2 passes → **ATS board search** for a full posting (below). Found → the description is saved (`kind: 'full'`, the board's `sourceId`), the board's key merges onto the job, and **S3 runs at once** (concurrency 2, no prompt caching for one-offs). Not found → `next: 'description'`;
   - returns per-job outcomes: skipped (S1 rule or S2 note), verdict, needs description, queued (cap reached), busy.
4. **Paste a description, `{ action: 'describe', jobId, text }`** (≤ 50k characters), for any job at `next: 'description'`, whether user-added or alert-ingested:
   - claims the job in a transaction (`next: 'description'` → `null`, `describingAt`; refused if the job has moved on);
   - writes `description/raw` (`kind: 'full'`, `sourceId: 'lookup'`, tagged untrusted like every posting);
   - re-runs S1 on the text (clearance, right-to-work and experience rules need it). A skip is final;
   - runs S3 (and S2 first if the job has no triage yet).
   - On a cap refusal it sets `next: 's3'`, so the next scan judges it inside the run lease; the UI says so.
5. **Single non-LinkedIn URL:** a Greenhouse, Lever, Ashby or Workable job URL that isn't seen is fetched from that board's **official API** (single-posting endpoint where one exists, else the board list filtered by ID) through the HTTP client (robots, UA, spacing), then added as in step 3 with its full text. Any other URL (careers pages, Indeed, Wellfound, YC) is never fetched (ADR-004, ADR-026, ADR-028, ADR-031): the UI asks for title, company and the description text.

### User-added jobs, spend and races
- **Marked by `addedAt`.** Only jobs added from Lookup carry it. A job matched or described from Lookup but ingested elsewhere doesn't. A later scan or alert that finds the same job merges into it and keeps `addedAt`.
- **Source `lookup`** (new): `externalId` = the LinkedIn ID when known, else the board's ID, else a hash of company|title|city. `url` = the posting URL, or `https://www.linkedin.com/jobs/view/{id}` when only the ID is known. With neither, a LinkedIn search link for title + company that the owner can click; it is never fetched, and the UI labels it "Search link" (not "Open posting"). The source ref is marked `searchLink: true` so the label survives.
- **Outside the run lease, under the monthly cap and a daily Lookup cap:** the `dailyCapped(store, 'lookup', cap)` wrapper from 6A. Default **25p/day** (`LOOKUP.dailyCapPence` in `functions/src/config.ts`, overridden by `config/app.lookup.dailyCapPence`). Reservations are `lookup-<id>`, settled per call (no lease).
- **Worst cases against 25p:** S3 reserves about 5.5p per call and costs about 1.5p; S2 reserves about 0.55p and costs about 0.15p. A 25-job paste spends about 4p on S2, which leaves room for about 10 deep reads that day.
- **Over the cap, jobs go to the front of the scan queues.** They fall back to `next: 's2'` or `'s3'`, and inside a scan **jobs with `addedAt` go first** in both queues: `runS2` and `runS3` read the user-added queued jobs first (`next == stage`, `orderBy addedAt desc`, limited to the stage's cap), then the usual order (S2 newest `sortAt`, S3 best triage score), without repeats. They are still judged inside the run lease and its stage shares.
- **Races with scans:** lookup's model calls run outside the lock. Every patch it writes after a model call is a transaction with a precondition: the job is still in the state lookup left it (same `stage`, `next` and no newer `judgedAt`). If a scan or re-score moved it, lookup's result is dropped and logged as a count; the job keeps whichever judgement landed first. That is at most one wasted call, never a double write.
- **Funnel step reuse:** S1 / S2 / S3 / `judge` move out of `runFunnel`'s closures into `functions/src/funnel/steps.ts` (`buildFunnelContext(criteria, facts, workRights)` → `{ systems, fingerprints, rules(job, text), triage(job, text, llmDeps), deepRead(job, text, llmDeps), judge(...) }`). `runFunnel` and `lookup` call the same code, so fingerprints match and a later re-score can reuse lookup's outputs. The refactor ships first in the PR, with `run.test.ts` unchanged and green.
- **ATS board search** (`functions/src/lookup/ats-search.ts`, also used as a second `Hydrator` in `runS3`, so alert jobs benefit too):
  - company → watched company with `ats.type !== 'none'` (exact `normaliseCompany` match, or `companyId`);
  - fetch that one board through the existing source module's `boardUrl` and item schema (one request, cached per call or run);
  - match by `normaliseTitle` equality, then city when several match. Exactly one match → its full text and source key. Zero or several → no match (never guess);
  - no LinkedIn host is ever requested: the HTTP client used by lookup refuses `linkedin.com` before any request (test).

### Screens (lazy)
- **Lookup** (`web/src/features/lookup/LookupPage.tsx`, `React.lazy` like the others; `nav.ts` copy updated): paste box + **Check**, a results list (seen / not seen), the results-page paste with preview and **Add**, per-job outcomes, and **Waiting for a description** (`next == 'description'`, newest first, 20 per page). Each waiting row has **Open on LinkedIn** (new tab, `rel="noopener noreferrer"`) and **Paste description** → **Judge**. States: empty, checking, busy, daily cap reached ("Lookup has spent today's 25p; these go first in the next scan"), errors.
- **Today:** an **Added by you** section under the three lists, hidden when empty. It shows the newest 5 by `addedAt` with their state (verdict, needs description, queued, skipped). It is a separate live query that starts after the tiles and Apply list, so `hf:usable` doesn't wait on it.
- **Jobs:** an **Added by you** filter that stands alone, like Needs review (ADR-044): `orderBy(addedAt desc)`, cursor paging, other filters disabled while on. Rows show the same states. No new tab.
- **Job sheet:** a job at `next: 'description'` shows "Needs a description" and the same Paste description control; the control's code lives in the Lookup chunk and is imported lazily from the sheet.
- **Services:** `web/src/services/lookup.ts` (match queries, the callable with no client retry, since it spends money), and specs in `jobs.ts` / `dashboard.ts`.

### Bundle and `hf:usable`
- Initial JS today: about 293.6 kB gzip of 300 kB (ADR-042), so about 6 kB spare.
- Lookup is a lazy route, and the parsers, DOMParser use and the callable client (Functions SDK on first use, ADR-021) ship only in its chunk. Expected initial delta: under 0.3 kB (the route entry).
- Today's chunk gains the section (about 1–2 kB, lazy chunk, not initial). Jobs' chunk gains the filter option.
- `check:bundle` must stay under 300 kB; the PR records initial JS and the Today/Jobs/Lookup chunk sizes before and after.
- `hf:usable` is re-measured (3 repeat visits, Fast 4G, CPU 4×): median ≤ 2,000 ms, as ADR-038 defines.

### Files (6B), one PR in two sessions
- **Session 1: server.**
  - Shared: `lookup.ts` (input parsing, results-page parser, age parsing, callable input/output schemas as a discriminated union), `jobs.ts` (`lookup` source, `addedAt?`, `searchLink?` on the source ref, `posted_estimated` flag), `callables.ts` (`lookup: 300`), `config.ts` (`AppConfig.lookup` as `unknown`, parsed on its own), `fixtures/results-page.ts` (fake 25-job page as plain text plus its HTML anchors).
  - Functions: `funnel/steps.ts` (the refactor, first commit, `run.test.ts` and eval unchanged), `funnel/run.ts` (uses steps; the ATS hydrator; user-added jobs first in both queues), `funnel/queries.ts` (`addedQueuedSpec`), `lookup/callable.ts` (`ownerOptions` + `requireOwner`), `lookup/run.ts` (add, describe; dependency-injected), `lookup/parse-llm.ts` (`pasteParse`), `lookup/ats-search.ts`, `lookup/store.ts` (claim and precondition patches), `http/scan-client.ts` (a forbidden-host list with `linkedin.com`), `config.ts` (`LOOKUP` with `dailyCapPence: 25`, `pasteParse` model), `index.ts`, `dev-fakes.ts`.
  - Indexes: `jobs (next, addedAt desc)`.
  - Ends with `check`, `test:rules`, `build`, the smoke script and a deviations list.
- **Session 2: web.** `features/lookup/*` (with `pasteAnchors.ts`, the DOMParser-only helper), `features/today/AddedByYou.tsx`, `features/jobs` (filter, sheet control, search-link and unverified-link labels), `services/lookup.ts`, `app/App.tsx` (route), `app/nav.ts`. Ends with the full gate including `check:bundle`.
- **Rules:** no new client writes (every job change goes through the callable).
- **Dev seed:** one user-added job with a verdict, one at `next: 'description'`.
- **Docs:** ADR-049; ARCHITECTURE (lookup function, data model, Lookup screen); FUNNEL (the lookup path, ATS hydrator); PRD unchanged; RUNBOOK Part H; ROADMAP (M6 done, parking lot); CHANGELOG `0.6.2`.

### Data model changes (6B)
- `jobs`: `addedAt?` (server time, set once by `lookup`), `describingAt?` (claim time, cleared on finish), sources and `description/raw.sourceId` may be `lookup`, `sources[].searchLink?: true`, flag `posted_estimated`.
- `usage/{month}.daily.lookup` and `byPurpose.pasteParse`.
- `config/app.lookup?: { dailyCapPence }` (default 25).
- Index `jobs (next, addedAt desc)`.

### New queries (added to the specs)
- `lookupKeysSpec(keys)` (web): `keys array-contains-any`, ≤ 30. Automatic index.
- `lookupUrlSpec(url)` (web): `url ==`. Automatic index.
- `needsDescriptionSpec` (web): `next == 'description'`, `orderBy sortAt desc`. Existing `(next, sortAt desc)`.
- `addedByYouSpec` (web, Today `limit 5` and Jobs pages): `orderBy addedAt desc` only. One ordered field and no filter is served by the automatic index (`indexServes` rule). Firestore leaves out documents without `addedAt`, which is exactly the filter.
- `addedQueuedSpec(stage)` (functions, S2 and S3): `next == stage`, `orderBy addedAt desc`. Needs the **new composite `jobs (next, addedAt desc)`**; checked in `queries.test.ts`.
- `watchedCompanyByIdSpec` / companies read (functions): document gets, no query.
- All four web specs go into `indexes.test.ts` ("serves every Lookup query"); `jobsByKeysSpec` is reused on the server.

### Tests (6B)
- **Parsers:** every LinkedIn URL form (`/jobs/view/{id}`, slugged, `/comm/…`, `currentJobId=` on search pages), ATS URLs, duplicates, junk lines; the results page (25 rows from the fake fixture, noise lines, "Promoted", ages, HTML anchor pairing, plain-text-only fallback, cap 50).
- **Match** (web services, emulator for the query, unit for the merge of results): a seen job by ID, by canonical URL, by `d:` key; unseen.
- **R8 AC end to end** (emulator): a fake LinkedIn alert is ingested through `ingestEmailJobs`, then `lookupKeysSpec` for `https://www.linkedin.com/jobs/view/{id}/` (and the slugged form) returns that job with its verdict, stage and dates.
- **Paste fallback:** a page the deterministic parser can't read → exactly one `pasteParse` call under the Lookup cap; an anchor index out of range gives no ID; a readable page → no model call.
- **Queue priority in scans** (`run.test.ts`): with user-added and ordinary jobs queued for S2 and S3, the user-added ones are judged first, newest `addedAt` first, then the usual order with no job read twice; caps and stage shares unchanged.
- **Callable options:** `lookup` has `enforceAppCheck` and `consumeAppCheckToken` outside the emulator and refuses a non-owner (`index.test.ts` and the handler test, as for the other callables).
- **Callable `add`:** S1 skip is final and costs nothing; S2 skip; S2 pass + ATS match → S3 → verdict with `addedAt`; S2 pass + no match → `next: 'description'`; two ATS matches → no match; daily cap (25p) reached mid-batch → the rest queued and reported; monthly cap → queued; lock busy for over 20 s → `busy`, nothing created; a seen job is never re-created.
- **Callable `describe`:** claim refused when the job moved on; S1 on the pasted text can skip (a clearance line); S3 runs and writes the verdict; cap refusal → `next: 's3'`; the injection fixture as a pasted description stays data (verdict computed in code, ADR-034).
- **Races:** a scan patch landing between lookup's model call and write → lookup's write is dropped, counted, and the scan's stays.
- **Never fetch LinkedIn:** the lookup HTTP client throws `forbidden_host` for any `linkedin.com` host before calling `fetch` (spy).
- **Daily cap:** concurrent lookups can't pass 25p together (transaction test, emulator); the day rolls over at London midnight.
- **Funnel refactor:** `run.test.ts` and `npm run eval` unchanged and green (same fingerprints, same recordings).
- **UI:** Lookup states, paste preview, keyboard flow, focus after Add, the paste handler with and without `text/html`; **pasted HTML never reaches the DOM**: a paste containing `<script>`, `<img onerror>` and `<iframe>` yields only anchor strings, the page's DOM gains no element from it, and a check that `features/lookup` contains no `innerHTML` or `dangerouslySetInnerHTML`; search links labelled "Search link"; Today's section hidden when empty and shown with states; Jobs filter stands alone and pages; the sheet's paste control; role-based a11y tests. Lighthouse a11y ≥ 95 on Lookup (manual).
- **Bundle:** `check:bundle`; the Lookup chunk is lazy (a test that `App.tsx` imports it via `lazy`).

### PRD acceptance (6B)
- **R8:** paste any job URL (LinkedIn included) → seen or not, verdict, stage, when. Unseen: public ATS APIs are tried; LinkedIn is never fetched and the owner pastes text; then the funnel runs. **AC:** LinkedIn `/jobs/view/{id}` URLs match jobs ingested from LinkedIn alert emails by job ID (emulator test above).
- **R7:** the Lookup screen (listed in R7) built; a11y ≥ 95; `hf:usable` still ≤ 2 s.
- **R11:** Lookup spend stays under the monthly cap, plus its own daily cap; the meter includes it.
- **R5:** user-added jobs dedupe through the same `keys[]`.

### ADRs (6B)
- **ADR-049 Lookup: matching in the browser, a callable that judges at once, user-added jobs:** client-side match by key and URL; results-page paste with HTML anchors for IDs (DOMParser only, never inserted) and no fetch, deterministic with one cheap-model fallback; search links labelled as such; `addedAt` as the marker and its query; S1/S2/S3 at once outside the run lease, under the monthly cap and a 25p daily cap; fallback to the front of the run queues (user-added first, the `(next, addedAt desc)` index; amends ADR-032's queue order); precondition patches instead of the lock for model results (the lock only for creates); the ATS board search as a hydrator for lookup and scans; `describe` and the claim; no LinkedIn host in the client; the funnel step extraction.

### Risks (6B)
- **The results-page text format changes or differs by locale/device.** The parser is fixture-tested and the preview shows what was understood before anything is added; nothing is created from a row the owner didn't confirm.
- **User-added jobs first in scans** take S2/S3 slots from scanned jobs on a heavy Lookup day. Bounded by the daily paste size (≤ 50 per paste) and the stage caps; System's queue counts show it.
- **Funnel refactor** could change prompts or fingerprints. Guard: eval recordings must replay unchanged ("recordings stale" would fail CI).
- **ATS board search** fetches whole boards (Greenhouse `content=true` can be large) for one job. One request per company, cached; the per-host spacing isn't shared across function instances (`lookup` and a scan in parallel can each hit a host once a second). Low volume; Workable stays at 5 s inside each client.
- **Lookup during a scan:** adding waits up to 20 s then says "busy"; matching still works.
- **Bundle creep:** Today and Jobs chunks grow slightly; initial JS shouldn't move.

---

## Post-deploy and manual steps

### Before 6A's tag (`v0.6.0`)
- **G1. Create the HMAC secret** in Cloud Shell. Generate it there; never paste it in chat or a file in the repo:
  ```bash
  gcloud config set project hireframe-f6b03
  printf '%s' "$(openssl rand -hex 32)" | gcloud secrets create INGEST_HMAC_SECRET --data-file=- --replication-policy=automatic
  ```
  Then let only the runtime account read it, and the deployer see it (ADR-017 pattern):
  ```bash
  gcloud secrets add-iam-policy-binding INGEST_HMAC_SECRET --member=serviceAccount:hireframe-fns@hireframe-f6b03.iam.gserviceaccount.com --role=roles/secretmanager.secretAccessor
  gcloud secrets add-iam-policy-binding INGEST_HMAC_SECRET --member=serviceAccount:github-deployer@hireframe-f6b03.iam.gserviceaccount.com --role=roles/secretmanager.viewer
  ```
- **G2. Invoker check on `scheduledScan`** (the bundle changes, so the deploy rewrites the invoker unless it's exact; M5 plan step 3):
  ```bash
  gcloud scheduler jobs describe firebase-schedule-scheduledScan-europe-west2 --location=europe-west2 --format='value(schedule,timeZone,httpTarget.oidcToken.serviceAccountEmail)'
  gcloud run services get-iam-policy scheduledscan --region=europe-west2 --flatten='bindings[].members' --filter='bindings.role:roles/run.invoker' --format='value(bindings.members)'
  ```
  The first must print `30 7,17 * * 1-5`, `Europe/London`, `hireframe-fns@…`; the second **only** `serviceAccount:hireframe-fns@…`. Otherwise RUNBOOK Recovery first.
- **G3.** Not before the **Wed 7 Oct 17:30** scheduled run has finished (System shows it): merge 6A, push `v0.6.0`, approve the deploy.

### After 6A's deploy
- **G4. TTL policies:** Firestore → **TTL** shows `nonces.expireAt` and `alertMessages.expireAt` as **Serving**. If missing:
  ```bash
  gcloud firestore fields ttls update expireAt --collection-group=nonces --enable-ttl
  gcloud firestore fields ttls update expireAt --collection-group=alertMessages --enable-ttl
  ```
- **G5. Invoker binding** for the new HTTPS function (RUNBOOK Part C step 28; add `ingestEmailJobs` to that list):
  ```bash
  gcloud functions add-invoker-policy-binding ingestEmailJobs --region=europe-west2 --member=allUsers --project=hireframe-f6b03
  ```
  Without it, Apps Script gets a 403. Public invocation is safe: the HMAC is checked first.
- **G6. Apps Script:** `npm run build:apps-script`, then `npx clasp login` (your Google account) and `npx clasp create --type standalone --rootDir apps-script/build` once, then `npx clasp push`. In the editor: **Services → Gmail API** on; **Project Settings → Script Properties**: `HIREFRAME_INGEST_URL` (the function URL from the Firebase console) and `HIREFRAME_HMAC_SECRET` (`gcloud secrets versions access latest --secret=INGEST_HMAC_SECRET` in Cloud Shell, copied straight into the property). Run `setup` once and accept the scopes. Run `run` once by hand.
- **G7. Gmail:** labels `hireframe/alerts` and `hireframe/done` in the primary account. A filter `from:jobalerts-noreply@linkedin.com` (plus any other alert senders you use: Work at a Startup, Escape the City, Wellfound, WTTJ, Reed, Indeed) → apply `hireframe/alerts`. **Second account:** keep its filter that auto-forwards `from:jobalerts-noreply@linkedin.com` to the primary; since Gmail keeps the original `From`, the primary's filter labels the forwarded copies too.
- **G8. Check:** label one real alert, run `run` in the editor → **System** shows the email card (jobs new/merged); the message is under `hireframe/done`. Next scan: those jobs get S1/S2, and LinkedIn ones end at "Waiting for a description".

### Before 6B's tag (`v0.6.2`)
- **H1.** Repeat G2 (invoker check on `scheduledScan`).
- **H2.** Merge 6B, push `v0.6.2`, approve.

### After 6B's deploy
- **H3. Invoker binding for `lookup`** (add it to step 28's list):
  ```bash
  gcloud functions add-invoker-policy-binding lookup --region=europe-west2 --member=allUsers --project=hireframe-f6b03
  ```
- **H4.** Firestore → Indexes: `jobs (next, addedAt desc)` says **Enabled** before the next scheduled run (until then the user-added-first read fails and the stage falls back to the usual order, logged).
- **H5. On the phone:** Lookup → paste a LinkedIn link from an alert → **Seen** with its verdict. Paste a results page → preview → Add → outcomes; one needs a description → paste it → verdict. Today shows **Added by you**.
- **H6.** `hf:usable` (3 repeat visits ≤ 2,000 ms median) and Lighthouse a11y ≥ 95 on Lookup, Today and Jobs; paste the numbers in the chat.
- **H7.** Optional: `config/app.lookup.dailyCapPence` (default 25p) and `config/app.alerts.dailyCapPence` (default 10p) to change the defaults.

## Verification
- **6A:** `npm run check` (lint, typecheck, unit incl. HMAC/parsers/bridge, PII scan, eval replay), `npm run test:rules` (rules + `tests/emulator/ingest.test.ts`, the R5 end-to-end and replay tests), `npm run build`, `node scripts/smoke-functions-bundle.ts`, `npm run build:apps-script`; locally `npm run dev` + `node scripts/sign-test-alert.ts` → System's email card counts it and a second post of the same request is refused as a replay. Steps G1–G8 after deploy.
- **6B:** the same, plus `npm run check:bundle` (≤ 300 kB initial, Lookup lazy) and the R8 end-to-end emulator test; locally Lookup against seeded and fake-alert jobs. Steps H1–H7 after deploy.

---

## Decisions from review (were questions)
1. **STATUS.md** lives in the claude.ai Project, not the repo; nothing else to fold in.
2. **ROADMAP items outside the brief:** (a) deterministic Work at a Startup and Escape the City parsers are **parked**; they go through the model fallback. (b) **Watchlist auto-growth is parked**; System's needs-description count is the evidence for judging it later. Both go to the ROADMAP parking lot in 6A.
3. **Pasted jobs with no LinkedIn ID** get a LinkedIn search link for title + company, labelled "Search link", never fetched.
4. **Results-page parsing** is deterministic, with one cheap-model fallback call (`pasteParse`) when it finds nothing.
5. **Over the daily Lookup cap**, jobs fall back to the scan queues **at the front** (user-added first in S2 and S3). The daily Lookup cap is **25p**.
6. **Off-allowlist links in model-parsed alerts keep the job:** the https link is stored on the source ref only, marked unverified, shown with its host, never logged; `externalId` = hash of company|title|city; System shows counts per sender.
7. **Lookup and the lock:** as planned (lock for the create step only, precondition writes for model results).
8. **Versions:** sort/filter and the sweep already shipped as `v0.5.4` and `v0.5.5`; 6A fixes the CHANGELOG headings. 6A = `v0.6.0`, 6B = `v0.6.2`.
9. **ADR-045** stays reserved for funnel-intake PR B; M6 uses ADR-046–049.
