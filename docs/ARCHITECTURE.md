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
| Workable | Public account widget/jobs endpoint | Verify endpoint in M3 |
| Reed | Reed Jobseeker API (free key, Basic auth) | UK |
| Adzuna | Adzuna API (free app_id/app_key), country `gb` | UK aggregator |
| Hacker News "Who's Hiring" | HN Algolia API, latest monthly thread | Filter UK/London/remote-UK |
| YC jobs, Escape the City | **Verify robots.txt + ToS in M3.** If disallowed, use their email alerts instead | Don't assume |
| LinkedIn, Wellfound, Work at a Startup, Welcome to the Jungle | **Email alerts only**, via Gmail bridge | Never scraped |

**Company watchlist** (`companies` collection) drives the ATS boards: seeded with ~150 London/UK B2B SaaS and startups, with ATS type + board token auto-detected from their careers page. Grows automatically when a company appears in alerts/aggregators and its ATS is detectable.

Each source module implements:
```ts
interface Source { id: string; fetch(ctx): Promise<RawJob[]>; health(): SourceHealth }
```

## Data model (Firestore)
All docs carry `createdAt`, `updatedAt`, `schemaVersion`.

- `config/app` — owner UID, schedules, model names, caps (in pence), `fxUsdToGbp` (converts Anthropic's USD costs to pence), feature flags. M1 fields: `ownerUid`, `schemaVersion`, `createdAt`, `updatedAt` (`AppConfigSchema` in `packages/shared`). Written only by the Admin SDK or the Firebase console, never by clients (ADR-011)
- `criteria/{version}` + `criteria/current` pointer — see FUNNEL.md seed
- `profile/main/facts/{factId}` — `{ type, text, evidence, source: 'cv'|'manual', dates, tags[], lanes[], status: 'active'|'archived', version }`
- `profile/main/documents/{docId}` — uploaded CVs (file in Storage), parse status
- `companies/{companyId}` — `{ name, domain, ats: {type, token}, size?, stage?, hq, watch: bool, lastScannedAt }`
- `jobs/{jobId}` — `{ dedupeKey, title, company, companyId?, location, remote, url, sources[{id, url, externalId, seenAt}], postedAt, firstSeenAt, descriptionRef, salary?, stage: 's0'..'s3', verdict?, fitScore?, luckScore?, reason?, matchedFactIds[], gaps[{type, text}], criteriaVersion, promptVersion, status: 'new'|'saved'|'applied'|'skipped'|'interview'|'offer'|'rejected', feedback?: {agree: bool, note?} }`
- `jobs/{jobId}/description/raw` — full text (kept separate to keep list reads cheap). Purged after 60 days for `skip` jobs.
- `cvs/{cvId}` — `{ jobId, profileVersion, content (structured), storagePaths {docx, pdf}, notes, createdAt }`
- `runs/{runId}` — `{ trigger: 'schedule'|'manual', startedAt, finishedAt, status, perSource{}, perStage{}, costPence, errors[] }`
- `usage/{yyyy-mm}` — `{ spendPence, capPence, calls{model: n}, tokens{} }` (transactional increments)
- `events/{eventId}` — append-only user actions (applied, skipped, feedback, criteria change) for analytics
- `locks/scan` — single-flight scan lock (kept out of `runs` so run queries never return it)

**Dedupe key:** `hash(normCompany + '|' + normTitle + '|' + normCity)`; also match on any known `externalId` (e.g. LinkedIn job ID) or canonical URL. Normalisation strips seniority noise words only for matching, never for display.

## Functions
| Function | Trigger | Does |
|---|---|---|
| `scheduledScan` | Cloud Scheduler 07:30 + 17:30 Mon–Fri Europe/London | Runs all sources → dedupe → funnel; single-flight lock in `locks/scan` |
| `scanNow` | Callable (owner only) | Same, manual |
| `ingestEmailJobs` | HTTPS, HMAC-signed, from Apps Script | Parses alert payloads → jobs |
| `getDigest` | HTTPS, HMAC-signed, from Apps Script | Returns digest HTML for latest morning run, or an explicit in-progress/failed notice |
| `lookup` | Callable | URL/text → match or run funnel |
| `parseCv` / `addFact` | Callable | Profile brain |
| `rescore` | Callable | Re-run S2–S3 on last 14 days with current criteria |
| `generateCv` | Callable | Tailored CV + cover note |
| `weeklyBackup` | Scheduled Sun 03:00 | JSON export of all collections to Storage (keep 8) |

Timeouts: scan functions 540 s, memory 1 GiB, max instances 1.

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
- Components never import Firebase; `web/src/services/` wraps auth, access checks and Firestore reads (with timeout + retry).
- Deploy: `v*` tag → GitHub `production` environment approval → `check` + `test:rules` → build → keyless Workload Identity Federation → `firebase deploy --only hosting,firestore,storage` (ADR-014).

