# Architecture

## Overview
```
 Sources ──► Ingest (Cloud Functions, scheduled) ──► Normalise + Dedupe ──► Funnel (rules → Haiku → Sonnet)
   │                                                                              │
   │ Gmail alerts via Apps Script bridge ──(HMAC webhook)──►                      ▼
   │                                                                  Firestore (jobs, runs, profile…)
   ▼                                                                              │
 Digest ◄── Apps Script pulls digest (HMAC) and emails user            Web app (React, Firebase Hosting)
```

## Stack
| Layer | Choice | Why |
|---|---|---|
| Web | React 19, TypeScript strict, Vite, Tailwind v4, shadcn/ui, TanStack Query + Table, Framer Motion (sparingly) | Known stack (Fridger) + premium component base |
| Backend | Firebase: Auth, Firestore, Storage, Hosting, Cloud Functions v2 (Node 22, TS) | Known stack; scheduled functions |
| Plan | **Blaze (pay-as-you-go)** — required for scheduled functions and outbound HTTP. Budget alert at £5/£10 | Usage stays near free tier |
| AI | Anthropic API. Models in config: cheap triage model (Haiku 4.5), deep model (Sonnet 5.5, effort low). Prompt caching on the S3 system prompt (profile facts + criteria). Deep reads run inside the scan; Message Batches are parked (ADR-035) | Cost/quality split |
| Gmail | Google Apps Script in the user's own account (see ADR-003) | Avoids OAuth app verification and 7-day token expiry |
| CV output | Structured CV JSON → `.docx` via `docx` (npm) and `.pdf` via `@react-pdf/renderer` | Both formats from one source of truth; ATS-safe single column |
| Validation | Zod everywhere | Boundaries are untrusted |
| Tests | Vitest, Firebase emulator suite, `@firebase/rules-unit-testing`, Playwright (smoke) | |
| CI | GitHub Actions: lint, typecheck, test, rules tests, gitleaks, build; deploy on tag | |

## Repo layout
```
/web                 React app
/functions           Cloud Functions (scanners, funnel, lookup, cv, digest API)
/packages/shared     Types, zod schemas, pure logic (dedupe, rules, scoring math)
/apps-script         Gmail bridge (clasp project)
/evals               Golden set (fake/anonymised) + eval runner
/docs                This documentation
```

## Sources (Wave 1)
| Source | Access | Notes |
|---|---|---|
| Greenhouse | `boards-api.greenhouse.io/v1/boards/{token}/jobs?content=true` | Public job board API |
| Lever | `api.lever.co/v0/postings/{company}?mode=json` | Public |
| Ashby | `api.ashbyhq.com/posting-api/job-board/{name}?includeCompensation=true` | Public |
| Workable | `apply.workable.com/api/v1/widget/accounts/{subdomain}?details=true`, where the documented `www.workable.com/api/accounts/{subdomain}` redirects; called directly so its robots.txt and 5 s spacing apply | Verified in M3 (ADR-027) |
| Reed | Reed Jobseeker API `/api/1.0/search` (free key, Basic auth) | UK; keyed API under its developer terms, budget ≤ 30 search calls/run and ≤ 300/day (ADR-025). Search returns snippets; before a deep read, `/api/1.0/jobs/{id}` swaps in the full text (≤ 20 calls/run, same daily quota, M4) |
| Adzuna | Adzuna API (free app_id/app_key), country `gb` | UK aggregator; keyed API under its terms: 3 s between calls, ≤ 20/run, persisted day/week/month quotas under 250/1,000/2,500 (ADR-025). Snippets only; "Jobs by Adzuna" attribution on listings (M5) |
| Hacker News "Who's Hiring" | HN Algolia API, latest monthly thread | Keeps UK, London and remote-UK/Europe/anywhere postings |
| YC jobs / Work at a Startup, Escape the City | **Email alerts only**, via Gmail bridge | Checked in M3: their terms forbid automated access (ADR-026, ADR-028) |
| LinkedIn, Wellfound, Welcome to the Jungle | **Email alerts only**, via Gmail bridge | Never scraped |

**Company watchlist** (`companies` collection) drives the ATS boards: seeded with 204 London/UK B2B SaaS companies and startups, 94 of them with a detected board (the rest are kept for matching aggregator jobs) (`packages/shared/src/watchlist-seed.ts`). Candidates come from people; `node scripts/detect-ats.ts` finds each one's ATS type and board token by probing only the official board APIs (or parsing a careers URL the owner pastes), and the owner reviews the result. No careers page is fetched (ADR-031). `scanNow` creates missing seed companies and never overwrites existing ones. From M6 it grows when a company appears in alerts or aggregators and its ATS is detectable.

Each source module implements (`functions/src/sources/types.ts`):
```ts
interface Source { id: string; fetch(ctx): Promise<RawJob[]>; health(): SourceHealth }
```
Every request goes through one HTTP client (ADR-029): `HireframeBot` User-Agent, per-host spacing (≥ 1 s, robots `Crawl-delay` honoured), robots.txt for web pages and unkeyed endpoints (keyed APIs follow their terms, ADR-025), a per-request timeout and a run deadline, at most 3 attempts with backoff on 429/5xx, and zod on every response. Each posting is validated on its own, so one odd posting never loses a board, and one failing source never fails a run.

## Data model (Firestore)
All docs carry `createdAt`, `updatedAt`, `schemaVersion`.

- `config/app` — owner UID, schedules, model names, caps (in pence), `fxUsdToGbp` (converts Anthropic's USD costs to pence), feature flags. Fields so far: `ownerUid`, `schemaVersion`, `createdAt`, `updatedAt` (M1), optional `monthlyCapPence` and `fxUsdToGbp` overrides (M2, ADR-016), an optional `lookup: { dailyCapPence }` (default 25, M6, ADR-049), `disabledSources` (M3, ADR-029), and an optional `funnel` map of per-run overrides (`runBudgetPence`, `s1MaxJobs`, `s2MaxJobs`, `s3MaxJobs`, `triageRpm`, `deepReadRpm`, `reedHydratePerRun`; M4, ADR-032) (`AppConfigSchema` in `packages/shared`). Written only by the Admin SDK or the Firebase console, never by clients (ADR-011)
- `criteria/v{n}` (immutable) + `criteria/current` pointer `{ version }` — content keys as in the FUNNEL.md seed, plus optional `lane_points` (M4, ADR-034); the owner writes a version and the pointer move in one batch (ADR-019)
- `profile/main` — the owner's work-rights setting `{ workRights: 'unrestricted'|'time_limited'|'needs_sponsorship', validUntil?: 'YYYY-MM-DD', createdAt, updatedAt, schemaVersion }`, written by the owner from the Profile screen (M4, ADR-033); Reset profile deletes it
- `profile/main/facts/{factId}` — `{ type, text, evidence, source: 'cv'|'manual', sourceDocId?, dates{start?,end?}, tags[], lanes[], status: 'active'|'archived', version, review?: {kind: 'changed', proposed, docId, at}, evidenceVerified, evidenceUrl? }`. Created by `parseCv`/`addFact`; the owner edits with a versioned client batch (ADR-018). `evidenceUrl` is an owner-set https link, never model-drafted (ADR-024)
- `profile/main/facts/{factId}/versions/{n}` — immutable `{ snapshot, change, at }`: the fact exactly as it was at version n
- `profile/main/documents/{docId}` — uploaded CV (file at Storage `profile/documents/{docId}/cv.{pdf|docx}`, max 5 MiB, immutable) and its parse status, summary, model, prompt version and cost; `sha256` of the file, `duplicateOf?` when the same file was already read (not read again, ADR-022), and `removedAt?` once the owner removed the upload (ADR-023)
- `companies/{companyId}` — `{ name, domain, ats: {type: 'greenhouse'|'lever'|'ashby'|'workable'|'none', token?, host?: 'eu'}, size?, stage?, hq, watch: bool, origin: 'seed'|'manual'|'detected', lastScannedAt?, lastScan?: {status: 'ok'|'not_found'|'error', jobs, consecutiveFailures, broken, errorCode?} }`. Server-written only (ADR-031); `broken` after 3 `not_found` runs in a row
- `jobs/{jobId}` — `{ dedupeKey, keys[], title, company, companyId?, location, city, country: 'GB'|'other'|'unknown', remote: 'remote'|'hybrid'|'onsite'|'unknown', url, sources[{id, url, externalId, seenAt, easyApply?, unverified?, searchLink?}], postedAt?, firstSeenAt, descriptionRef, descriptionKind: 'full'|'snippet'|'none', salary?, stage: 's0'..'s3', status: 'new'|'saved'|'applied'|'skipped'|'interview'|'offer'|'rejected', appliedAt?, appliedVerdict?, feedback?: {agree, note? ≤ 280, verdict, expected?, at} }` plus owner fields (M5, ADR-038): the owner may change only `status` (between `new`, `saved`, `applied`, `skipped`), `appliedAt`/`appliedVerdict` (set with applied to the server time and the job's verdict, removed on leaving it), `feedback` (names the verdict it judged) and `updatedAt` plus the funnel's fields (M4, `JobFunnelFieldsSchema`, all optional, written only by the funnel):
  - verdict: `verdict?`, `fitScore?`, `luckScore?`, `reason?`, `shortfall?`, `matchedFactIds[]`, `gaps[{type, text}]`, `talkingPoints[]`, `skip?: {stage, ruleId?, note?}`, `review?: {stage, code}`, `criteriaVersion?`, `promptVersion?`, `judgedAt?`, `costPence?`;
  - queue: `stage` is the last stage that ran, `next?: 's2'|'s3'|'description'|null` what it waits for (`description`: an alert job or a Lookup job with no text, M6, ADR-048), `addedAt?` (server time, set once by `lookup`: the mark of a job the owner added; user-added jobs are read first by the S2 and S3 queues through the `(next, addedAt desc)` index, ADR-049), `describingAt?` (the claim while a pasted description is judged), `sortAt?` (posting date, else first seen), `rescoreQueuedAt?`;
  - alert sources (M6, ADR-047): `sources[].id` may be `linkedin-alert` (the deterministic LinkedIn parser) or `email-alert` (any other sender, through the model). `easyApply: true` is the LinkedIn badge on that source. `unverified: true` marks `url` as an off-allowlist link from a model-parsed alert (shown with its host, never trusted: no keys); `searchLink: true` marks a LinkedIn search link built from the title and company, not a posting;
  - inputs: `flags[]`, `experienceAsk?`, `triage?` (the S2 output), `deep?` (the validated S3 output with fact IDs) and `inputs?: {s2?, s3?}`, fingerprints of the prompts that produced them, so a re-score can reuse them (ADR-037).

  M3 writes the ingest fields and leaves the job at `s0` (`JobSchema` in `packages/shared`)
- `jobs/{jobId}/description/raw` — `{ text, kind: 'full'|'snippet'|'none', sourceId, fetchedAt }`, untrusted text kept separate to keep list reads cheap. Purged after 60 days for `skip` jobs.
- `cvs/{cvId}` — `{ jobId, profileVersion, content (structured), storagePaths {docx, pdf}, notes, createdAt }`
- `runs/{runId}` — `{ trigger: 'schedule'|'manual'|'rescore', startedAt, finishedAt?, status: 'running'|'succeeded'|'partial'|'failed', perSource{ [sourceId]: {status, fetched, invalid, new, duplicate, merged, errors, requests, durationMs, errorCode?} }, perStage{ s0: {in, new, merged, duplicate, conflicts}, s1: {in, passed, skipped, byRule}, s2: {in, passed, skipped, expired, review, queued, costPence, durationMs}, hydrate: {attempted, ok, failed}, s3: {in, apply, near_miss, wildcard, skip, expired, review, queued, drift, recomputed, needsDescription?, costPence, durationMs}, rescore? }, costPence, budget?: {leasePence, usedPence, stoppedBy?}, flags?: ['spend_80'|'deep_pause'], errors[{sourceId?, code}] }` (codes only, never messages)
- `sources/{sourceId}` — rolling health for the System screen: `{ status: 'ok'|'degraded'|'failing'|'disabled'|'skipped', lastRunAt, lastOkAt?, consecutiveFailures, lastErrorCode?, lastCounts, quota?: {day, dayCount, week, weekCount, month, monthCount}, queryCursor? }`. Server-written only (ADR-029)
- `usage/{yyyy-mm}` — `{ spendPence, capPence, reservations{id: {pence, at}}, calls{model: n}, tokens{model: {input, output, cacheRead, cacheWrite}}, byPurpose{} }`, month in Europe/London. `llm.call()` reserves a call's worst case and settles its actual cost in transactions (ADR-016); a funnel run reserves one lease (`run-<runId>`) and settles the run's aggregated spend once (ADR-032)
- `events/{eventId}` — append-only owner actions for analytics, created from the client in the same batch as the job change (M5, ADR-038): `{ type: 'job_status', jobId, from, to, verdict?, at, schemaVersion }` `{ type: 'job_feedback', jobId, agree, verdict, expected?, at, schemaVersion }`, or `{ type: 'job_feedback_removed', jobId, agree, verdict, at, schemaVersion }` (the rating taken back). Create-only: never updated or deleted. Criteria changes are recorded by the criteria versions themselves
- `locks/scan` — the single-writer lock `{ runId?, startedAt?, lastFinishedAt?, holder?: 'scan'|'rescore'|'email'|'lookup', staleAt? }` (kept out of `runs` so run queries never return it). A scan or re-score holds it for a run (stale after 12 min); `email` (alert ingest, stale after 3 min) and `lookup` (the create step of `add`, stale after 2 min) hold it briefly, and a scheduled scan waits up to 4 min for either. A manual scan within 5 min of the last scan is skipped; a short holder never starts that cooldown (ADR-029, ADR-048)
- `nonces/{nonce}` — server-only: `{ expireAt, schemaVersion }`, a signed request's nonce, created with `create()` so a replay fails; TTL policy on `expireAt`, 10 min (M6, ADR-046)
- `alertMessages/{sha256(gmail message id)}` — server-only: `{ sender (the domain), parser: 'deterministic'|'model', jobs, new, merged, duplicate, unverifiedLinks, status: 'processed'|'unparsed', at, expireAt, schemaVersion }`. Counts and the sender's domain only, no subject, address, link or text; TTL policy on `expireAt`, 30 days (M6, ADR-047)

**Dedupe** (ADR-030, pure code in `packages/shared`): each job stores `keys[]` — `d:` + a 64-bit hash of `normCompany|normTitle|normCity`, every source key (`greenhouse:{id}`, `linkedin:{id}`, …) and keys derived from job URLs it links to. Jobs sharing any key are one job. Normalisation is for matching only, never display: level words are normalised (Jr → junior), never stripped, so Senior and Junior roles stay apart; bracketed or trailing location, work-mode, salary, contract and gender tags are dropped.

## Functions
| Function | Trigger | Does |
|---|---|---|
| `scheduledScan` | Cloud Scheduler 07:30 + 17:30 Mon–Fri Europe/London | Runs all sources → dedupe → funnel; single-flight lock in `locks/scan`, no cooldown, no retries (M4, ADR-037). Mounts the Anthropic, Reed and Adzuna keys |
| `scanNow` | Callable (owner, App Check) | Same, manual: sources → normalise → dedupe → new jobs at `s0` → the funnel (S1 on new jobs and the backlog, S2/S3 queues), run and source health (ADR-029, ADR-032). Mounts the Anthropic, Reed and Adzuna keys |
| `ingestEmailJobs` | HTTPS (publicly invocable; the HMAC is the authentication), from Apps Script | Verifies the signature on the raw body and the nonce, takes the scan lock as a short holder, parses each alert (LinkedIn deterministically, other senders with the cheap model), normalises → dedupes → writes jobs at `s0`, records handled messages and `sources/email` health, answers a status per message (M6, ADR-046–048). 120 s timeout, `maxInstances: 1`. Mounts the HMAC secret and the Anthropic key |
| `lookup` | Callable (owner, App Check) | Three actions (M6, ADR-049). `add`: jobs the owner picked from a pasted results page or a job-board URL → dedupe against stored keys → create (`addedAt`, source `lookup`, S1 at once) under the scan lock as the short holder `lookup` → S2 on title, company and location → the ATS board search → S3 when there is text, each write a precondition transaction; caps and the 200 s deadline queue the rest for the next scan. `describe`: a pasted description for a job at `next: 'description'`. `parse`: the one cheap-model read of a results page the deterministic parser couldn't. 300 s. Mounts the Anthropic key only
| `getDigest` | HTTPS, HMAC-signed, from Apps Script | Returns digest HTML for latest morning run, or an explicit in-progress/failed notice |
| `parseCv` / `addFact` | Callable (owner, App Check) | Profile brain: CV → atomic facts merged into the profile; free-text note → facts (M2, ADR-018) |
| `resetProfile` | Callable (owner, App Check) | Hard-deletes every fact, version, upload document and uploaded file after the owner types RESET; refuses while a CV is being read (M2.1, ADR-023) |
| `rescore` | Callable (owner, App Check) | Re-judges jobs first seen in the last 14 days with the current criteria: S1 again, verdicts recomputed in code where the prompt fingerprints match, the rest queued for the model; old verdicts stay until replaced (M4, ADR-037). Mounts the Anthropic and Reed keys |
| `generateCv` | Callable | Tailored CV + cover note |
| `weeklyBackup` | Scheduled Sun 03:00 | JSON export of all collections to Storage (keep 8) |

Timeouts: `ingestEmailJobs` 120 s (its model calls start only within 15 s of the request, and the last one may take 35 s, so a response always arrives within 50 s: Apps Script's `UrlFetchApp` gives up at about 60 s; later messages come back `deferred`). Scan functions and `rescore` 540 s (no fetch starts after 300 s, no S2 call after 400 s, no S3 call after 450 s), memory 1 GiB, max instances 1. All functions run in `europe-west2` as the `hireframe-fns` service account and are bundled with esbuild for deploy (ADR-017). `parseCv` allows 540 s, `addFact` and `resetProfile` 120 s, `lookup` 300 s (no model call starts after 200 s). Only functions that call the model mount the Anthropic key.

**Firestore indexes** (`firestore.indexes.json`): `jobs (stage, firstSeenAt desc)` for the S1 backlog, `jobs (next, sortAt desc)` for the S2 queue and `jobs (next, triage.triageScore desc, sortAt desc)` for the S3 queue. M5 adds six for the dashboard (ADR-038): `jobs (verdict, status, judgedAt desc)` and `(verdict, judgedAt desc)` for the Today and Jobs lists, `(status, judgedAt desc)` for the status filter, `(status, appliedAt desc)` for applied this week and agreement, `(review.stage, judgedAt desc)` for jobs needing review, and `(feedback.agree, feedback.at desc)` for ratings. Three more (v0.5.1) cover "needs review" combined with a verdict and/or status. Range counts order descending to use these. `web/src/services/indexes.test.ts` checks every dashboard and Jobs query against the file (ADR-040).

## Gmail bridge (Apps Script)
Built in M6 (PR 6A; ADR-046, ADR-047, ADR-048). The digest half (`getDigest`, the 07:50 trigger) is M7.
```
Gmail ──filters──► hireframe/alerts ──Apps Script (every 30 min)──► ingestEmailJobs ──► jobs at s0 ──► next scan: S1–S3
```
- **Gmail** (the owner's own account): filters label alert emails `hireframe/alerts` (LinkedIn, Wellfound, Work at a Startup, Escape the City, WTTJ, Reed, Indeed). The second account auto-forwards its LinkedIn alerts to the primary; Gmail keeps the original `From` and body, so a forwarded alert is parsed like a direct one.
- **Apps Script** (`/apps-script`, TypeScript, esbuild → `Code.js`, pushed with clasp; Advanced Gmail service, scope `gmail.modify`): lists pending messages (oldest first, at most 20 a run), sends only `{ id, receivedAt, from, text, html }` in signed POSTs bounded by bytes (each under about 900 kB, at most 5 messages), and relabels a message `hireframe/done` only when the server says `processed`, `duplicate` or `unparsed` for it. `busy`, `deferred`, a non-2xx or a network error leave the label, so the next trigger retries.
- **`ingestEmailJobs`**: verifies HMAC-SHA256 over `v1.<timestamp>.<nonce>.<raw body>` (skew ≤ 300 s, nonce stored 10 min, constant-time compare, uniform 401s), takes the scan lock as the short holder `email` (a scan already running → 503 `busy`), skips messages already in `alertMessages`, routes each by the exact `From` address (LinkedIn → the deterministic card parser; anyone else → one cheap-model call with the email as untrusted data and links offered by index), then normalises → `dedupeBatch` → `findJobsByKeys` → `planIngest` → `writePlan`, exactly as a scan does. New jobs land at `s0`; the next scan's funnel judges them. A job with no description (every LinkedIn alert job) goes to `next: 'description'` at S3, free, until a merge brings a full description (the ATS posting arriving in a scan) or, from 6B, the owner pastes one.
- **Health**: `sources/email` carries the last ingest, its counts and per-sender totals; System shows them, and a silent bridge shows as a stale "last ingest".
- Parsing of the email body into jobs is server-side, so the script stays dumb. Nothing from an email is logged or kept beyond the jobs it produced.
- Shared secret in Script Properties and Secret Manager (`INGEST_HMAC_SECRET`). Never in code.

## Lookup (M6, 6B)

```
paste ──► browser matches by key / URL (no callable, no spend) ──► Seen | Not seen
                                                            └─► add ──► lookup (callable)
lookup add:  dedupe ─► create (lock, short) ─► S1 ─► S2 ─► ATS board search ─► S3 ─► verdict | needs description | queued
```

- **The funnel steps are shared** (`functions/src/funnel/steps.ts`): `runFunnel` and `lookup` call the same S1 rules, S2 triage, S3 deep read and judgement, so prompts, fingerprints and scoring match (ADR-049).
- **User-added jobs** carry `addedAt` and the source `lookup`; their key is the LinkedIn ID when known, else the board's ID, else a hash of company|title|city, plus every key their URL yields, so a later scan or alert merges into them and keeps `addedAt`. A pasted job with no ID gets a LinkedIn search link (`searchLink: true`), never fetched.
- **Spend** goes through `llm.call()` under the monthly cap and the daily Lookup cap (25p, `usage/{month}.daily.lookup`, the same transaction as the month's). Over a cap, the clock (200 s) or three errors in a row, jobs stay queued (`next: 's2'`/`'s3'`) and the next scan reads them first (`jobs (next, addedAt desc)`).
- **Races:** model calls run outside the lock, so every write after one is a precondition transaction on the job's `stage`, `next` and `judgedAt`; if a scan moved the job, Lookup's write is dropped and counted.
- **Never fetched:** LinkedIn (and Indeed, Wellfound, Glassdoor): the HTTP client refuses those hosts before any request. Job-board URLs (Greenhouse, Lever, Ashby, Workable) are read from the official board APIs; any other URL is never fetched.

**The screens** (all lazy, `web/src/features/lookup/`, `web/src/services/lookup.ts`):
- **Lookup** (`/lookup`): one paste box and **Check**. Links are matched in the browser (`keys array-contains-any`, then `url ==`); a pasted LinkedIn results page is read by `parseResultsPage` (the real copy format: doubled title line, company, location, badges, a doubled age), with job IDs from the HTML's anchors (`pasteAnchors.ts`, `DOMParser` only, never inserted into the page). Seen rows show verdict or state, stage and dates; new rows are previewed and added with one `lookup` call. Below, **Waiting for a description** lists `next == 'description'` jobs (from Lookup or an email alert) with Open on LinkedIn and Paste description.
- **Today** shows **Added by you** (newest 5 by `addedAt`, a live query mounted after `hf:usable`); **Jobs** has an **Added by you** filter that stands alone; the **job sheet** shows the paste control for a job that needs a description (lazy import of `PasteDescription`).
- The callable client never retries (`lookupAdd`, `lookupDescribe`, `lookupParse`); all job changes go through the callable, so there are no new client writes or rules.

## Environments
- `local`: emulators on the `demo-hireframe` project (can't reach real resources), fake data seeded by `npm run dev`, no real API calls unless `LIVE=1` (ADR-013).
- `prod`: single Firebase project `hireframe-f6b03`, region `europe-west2`. (Staging not worth it for one user; guarded by emulator tests + eval gate + tagged deploys.)

## Web app config and deploy
- The web app reads its Firebase config from Hosting's `/__/firebase/init.json` at runtime; no Firebase config lives in the repo (ADR-012). App Check uses reCAPTCHA Enterprise; the public site key is a build-time variable.
- Components never import Firebase; `web/src/services/` wraps auth, access checks, Firestore reads and writes (with timeout + retry), Storage uploads and callables. Callables that spend money are never retried by the client.
- Deploy: `v*` tag → GitHub `production` environment approval → `check` + `test:rules` → build (including the functions bundle) → keyless Workload Identity Federation → `firebase deploy --only hosting,firestore,storage,functions` (ADR-014, ADR-017).

