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
| AI | Anthropic API. Models in config: cheap triage model (Haiku class), deep model (Sonnet class). Prompt caching on profile + criteria. Message Batches for non-urgent deep reads | Cost/quality split |
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
| Reed | Reed Jobseeker API `/api/1.0/search` (free key, Basic auth) | UK; keyed API under its developer terms, budget ≤ 30 calls/run and ≤ 300/day (ADR-025). Snippets only; full text for S2 survivors in M4 |
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

- `config/app` — owner UID, schedules, model names, caps (in pence), `fxUsdToGbp` (converts Anthropic's USD costs to pence), feature flags. Fields so far: `ownerUid`, `schemaVersion`, `createdAt`, `updatedAt` (M1), optional `monthlyCapPence` and `fxUsdToGbp` overrides (M2, ADR-016) (`AppConfigSchema` in `packages/shared`). Written only by the Admin SDK or the Firebase console, never by clients (ADR-011)
- `criteria/v{n}` (immutable) + `criteria/current` pointer `{ version }` — content keys as in the FUNNEL.md seed; the owner writes a version and the pointer move in one batch (ADR-019)
- `profile/main/facts/{factId}` — `{ type, text, evidence, source: 'cv'|'manual', sourceDocId?, dates{start?,end?}, tags[], lanes[], status: 'active'|'archived', version, review?: {kind: 'changed', proposed, docId, at}, evidenceVerified, evidenceUrl? }`. Created by `parseCv`/`addFact`; the owner edits with a versioned client batch (ADR-018). `evidenceUrl` is an owner-set https link, never model-drafted (ADR-024)
- `profile/main/facts/{factId}/versions/{n}` — immutable `{ snapshot, change, at }`: the fact exactly as it was at version n
- `profile/main/documents/{docId}` — uploaded CV (file at Storage `profile/documents/{docId}/cv.{pdf|docx}`, max 5 MiB, immutable) and its parse status, summary, model, prompt version and cost; `sha256` of the file, `duplicateOf?` when the same file was already read (not read again, ADR-022), and `removedAt?` once the owner removed the upload (ADR-023)
- `companies/{companyId}` — `{ name, domain, ats: {type: 'greenhouse'|'lever'|'ashby'|'workable'|'none', token?, host?: 'eu'}, size?, stage?, hq, watch: bool, origin: 'seed'|'manual'|'detected', lastScannedAt?, lastScan?: {status: 'ok'|'not_found'|'error', jobs, consecutiveFailures, broken, errorCode?} }`. Server-written only (ADR-031); `broken` after 3 `not_found` runs in a row
- `jobs/{jobId}` — `{ dedupeKey, keys[], title, company, companyId?, location, city, country: 'GB'|'other'|'unknown', remote: 'remote'|'hybrid'|'onsite'|'unknown', url, sources[{id, url, externalId, seenAt}], postedAt?, firstSeenAt, descriptionRef, descriptionKind: 'full'|'snippet', salary?, stage: 's0'..'s3', verdict?, fitScore?, luckScore?, reason?, matchedFactIds[], gaps[{type, text}], criteriaVersion?, promptVersion?, status: 'new'|'saved'|'applied'|'skipped'|'interview'|'offer'|'rejected', feedback?: {agree: bool, note?} }`. M3 writes the ingest fields and leaves the job at `s0`; M4 adds the verdict fields and `criteriaVersion` when it judges the job (`JobSchema` in `packages/shared`)
- `jobs/{jobId}/description/raw` — `{ text, kind: 'full'|'snippet', sourceId, fetchedAt }`, untrusted text kept separate to keep list reads cheap. Purged after 60 days for `skip` jobs.
- `cvs/{cvId}` — `{ jobId, profileVersion, content (structured), storagePaths {docx, pdf}, notes, createdAt }`
- `runs/{runId}` — `{ trigger: 'schedule'|'manual', startedAt, finishedAt?, status: 'running'|'succeeded'|'partial'|'failed', perSource{ [sourceId]: {status, fetched, invalid, new, duplicate, merged, errors, requests, durationMs, errorCode?} }, perStage{ s0: {in, new, merged, duplicate, conflicts} }, costPence, errors[{sourceId?, code}] }` (codes only, never messages)
- `sources/{sourceId}` — rolling health for the System screen: `{ status: 'ok'|'degraded'|'failing'|'disabled'|'skipped', lastRunAt, lastOkAt?, consecutiveFailures, lastErrorCode?, lastCounts, quota?: {day, dayCount, week, weekCount, month, monthCount}, queryCursor? }`. Server-written only (ADR-029)
- `usage/{yyyy-mm}` — `{ spendPence, capPence, reservations{id: {pence, at}}, calls{model: n}, tokens{model: {input, output, cacheRead, cacheWrite}}, byPurpose{} }`, month in Europe/London. `llm.call()` reserves a call's worst case and settles its actual cost in transactions (ADR-016)
- `events/{eventId}` — append-only user actions (applied, skipped, feedback, criteria change) for analytics
- `locks/scan` — single-flight scan lock `{ runId?, startedAt?, lastFinishedAt? }` (kept out of `runs` so run queries never return it). Stale after 12 min; a manual scan within 5 min of the last one is skipped (ADR-029)

**Dedupe** (ADR-030, pure code in `packages/shared`): each job stores `keys[]` — `d:` + a 64-bit hash of `normCompany|normTitle|normCity`, every source key (`greenhouse:{id}`, `linkedin:{id}`, …) and keys derived from job URLs it links to. Jobs sharing any key are one job. Normalisation is for matching only, never display: level words are normalised (Jr → junior), never stripped, so Senior and Junior roles stay apart; bracketed or trailing location, work-mode, salary, contract and gender tags are dropped.

## Functions
| Function | Trigger | Does |
|---|---|---|
| `scheduledScan` | Cloud Scheduler 07:30 + 17:30 Mon–Fri Europe/London | Runs all sources → dedupe → funnel; single-flight lock in `locks/scan` (M4) |
| `scanNow` | Callable (owner, App Check) | Same, manual. M3 ships it ingest-only: sources → normalise → dedupe → new jobs at `s0`, run and source health; M4 adds the funnel (ADR-029). Mounts only the Reed and Adzuna keys |
| `ingestEmailJobs` | HTTPS, HMAC-signed, from Apps Script | Parses alert payloads → jobs |
| `getDigest` | HTTPS, HMAC-signed, from Apps Script | Returns digest HTML for latest morning run, or an explicit in-progress/failed notice |
| `lookup` | Callable | URL/text → match or run funnel |
| `parseCv` / `addFact` | Callable (owner, App Check) | Profile brain: CV → atomic facts merged into the profile; free-text note → facts (M2, ADR-018) |
| `resetProfile` | Callable (owner, App Check) | Hard-deletes every fact, version, upload document and uploaded file after the owner types RESET; refuses while a CV is being read (M2.1, ADR-023) |
| `rescore` | Callable | Re-run S2–S3 on last 14 days with current criteria |
| `generateCv` | Callable | Tailored CV + cover note |
| `weeklyBackup` | Scheduled Sun 03:00 | JSON export of all collections to Storage (keep 8) |

Timeouts: scan functions 540 s (no request starts after 360 s), memory 1 GiB, max instances 1. All functions run in `europe-west2` as the `hireframe-fns` service account and are bundled with esbuild for deploy (ADR-017). `parseCv` allows 540 s, `addFact` and `resetProfile` 120 s. Only the model callables mount the Anthropic key.

## Gmail bridge (Apps Script)
- Gmail filters label alert emails `hireframe/alerts` (LinkedIn, Wellfound, WaaS, WTTJ, Reed, etc.).
- Time trigger every 30 min: read unprocessed labelled threads → extract text + links → POST to `ingestEmailJobs` with HMAC-SHA256 signature + timestamp → relabel `hireframe/done`.
- Parsing of the email body into jobs happens server-side (cheap model or per-sender parser), so the script stays dumb.
- Time trigger 07:50 weekdays: GET `getDigest` (signed) → `MailApp.sendEmail` to self. Apps Script time triggers fire within a ±15 min window, so the digest can be requested before the morning run finishes; `getDigest` then returns an explicit "run in progress" or "run failed" notice, never nothing (R9).
- Shared secret stored in Apps Script Script Properties and Secret Manager. Never in code.

## Environments
- `local`: emulators on the `demo-hireframe` project (can't reach real resources), fake data seeded by `npm run dev`, no real API calls unless `LIVE=1` (ADR-013).
- `prod`: single Firebase project `hireframe-f6b03`, region `europe-west2`. (Staging not worth it for one user; guarded by emulator tests + eval gate + tagged deploys.)

## Web app config and deploy
- The web app reads its Firebase config from Hosting's `/__/firebase/init.json` at runtime; no Firebase config lives in the repo (ADR-012). App Check uses reCAPTCHA Enterprise; the public site key is a build-time variable.
- Components never import Firebase; `web/src/services/` wraps auth, access checks, Firestore reads and writes (with timeout + retry), Storage uploads and callables. Callables that spend money are never retried by the client.
- Deploy: `v*` tag → GitHub `production` environment approval → `check` + `test:rules` → build (including the functions bundle) → keyless Workload Identity Federation → `firebase deploy --only hosting,firestore,storage,functions` (ADR-014, ADR-017).

