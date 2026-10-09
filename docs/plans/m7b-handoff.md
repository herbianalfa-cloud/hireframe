# M7B handoff: session 7B.1 (getDigest) to 7B.2 (Apps Script mailer)

Branch `feat/m7b-digest`, from `main` at e457a7b. Pushed; no PR, no merge, no tag. 7B.2 adds the
mailer, the end-of-7B docs, ADR-052 and the CHANGELOG 0.7.1 entry.

## What exists

`getDigest` is an HTTPS function (`functions/src/digest/endpoint.ts`): 60 s, 512 MiB,
`maxInstances: 1`, `concurrency: 1`, `cors: false`, publicly invocable. It mounts only
`INGEST_HMAC_SECRET` and makes no model call. It has no schedule and no event trigger.

Request: POST `application/json`, `{ "kind": "morning" | "fallback", "day": "YYYY-MM-DD" }`, the
London day. Headers are ingest's: `X-Hireframe-Timestamp`, `X-Hireframe-Nonce`,
`X-Hireframe-Signature`. The signed bytes are `digest.v1.<timestamp>.<nonce>.<raw body>`.

Response 200: `{ state: 'ready' | 'failed' | 'in_progress' | 'missing', subject, html, text }`.
Errors are `{ error: 'unauthorized' | 'too_large' | 'malformed' | 'internal' }` with 401 (signature,
skew, headers, replay), 400 (method, content type, JSON, schema, day), 413 and 500.

| File | Role |
|---|---|
| `functions/src/digest/endpoint.ts` | the function and its wiring |
| `handler.ts` | verify, claim nonce, parse, day check, build (testable without Firebase) |
| `build.ts` | reads through the store, picks the state, renders, validates the response |
| `state.ts` | pure: `chooseDigest`, `pickMorningRun`, `pickPreviousMorningRun`, `londonParts` |
| `render.ts` | pure: `renderDigest`, `cleanText`, `escapeHtml`, `jobLink` |
| `store.ts` | reads only: runs, jobs per verdict (+ exact count), usage, sources, waiting count |
| `packages/shared/src/digest.ts` | schemas, `DIGEST_WIRE`, `DIGEST_KINDS`, `DIGEST_STATES`, query specs |
| `packages/shared/src/signing.ts` | `SignaturePurpose`, `SIGNATURE_PREFIXES`, purpose argument |
| `functions/src/ingest/hmac.ts` | `signRequest(..., purpose)` and `verifyRequest(..., compare, purpose)` |

Tests: `state`, `render`, `build`, `handler`, `endpoint`, `queries` (all in `functions/src/digest/`),
`hmac.test.ts` (digest block), `signing.test.ts`, `digest.test.ts` (shared), `index.test.ts`,
`web/src/services/indexes.test.ts` ("serves every getDigest query") and
`tests/emulator/digest.test.ts`. The existing ingest tests are unchanged and pass.

`node scripts/sign-test-alert.ts digest [--kind fallback]` posts a signed digest request to the
emulator. It needs a run for today in the emulator to return `ready`; the dev seed has none (see
differences).

## Exported names 7B.2 needs

From `@hireframe/shared`:
- `signingPrefix(timestamp, nonce, purpose = 'ingest')` and `signingString(timestamp, nonce, body, purpose = 'ingest')`
- `SignaturePurpose` (`'ingest' | 'digest'`), `SIGNATURE_PURPOSES`, `SIGNATURE_PREFIXES`
- `DigestRequestSchema`, `DigestResponseSchema`, `DigestRequest`, `DigestResponse`, `DigestState`, `DigestKind`, `DIGEST_STATES`, `DIGEST_KINDS`, `DIGEST_ERROR_CODES`, `DIGEST_WIRE`
- `CALLABLE_TIMEOUT_SECONDS.getDigest` (60)

From `functions` (server side, for tests): `signRequest(secret, ts, nonce, body, purpose)` and
`verifyRequest(request, secret, now, compare, purpose)` in `functions/src/ingest/hmac.ts`.

For the mailer: `apps-script/src/sign.ts` `createSigner(secret, computeHmac)` still signs with the
`v1.` prefix. 7B.2 must add a `purpose` argument (the prefix call is
`signingPrefix(timestamp, nonce, purpose)`; the change is one argument, default `'ingest'`) and
create the digest signer with `'digest'`. I did not touch `apps-script/` in 7B.1.

7D fills the Pipeline line through `renderDigest`'s optional `pipeline: DigestPipeline` input
(`needsInput`, `generating`, `ready`, `appliedThisWeek`, `weeklyTarget`). `buildDigest` doesn't
read or pass it yet.

## Signing vector for bridge-compat.test.ts

```
secret    = 'c0ffee11'.repeat(8)           (the secret already used in bridge-compat.test.ts)
nonce     = 3b241101-e2bb-4255-8caf-4136c566a962
timestamp = 1760000000
body      = {"kind":"morning","day":"2026-10-07"}
signed    = digest.v1.1760000000.3b241101-e2bb-4255-8caf-4136c566a962.{"kind":"morning","day":"2026-10-07"}
signature = 4ff6dc7afc9c6fb781024ed08e74ad5d722a1c545dd183f87b19610c8e5a94d2

same inputs with the ingest prefix v1. (must NOT verify at the digest endpoint):
signature = a5408cc32b2074752944e5128744c06835e22da069dba160ba178c3fef6a31c8
```

Both are pinned in `functions/src/ingest/hmac.test.ts`. Server-side check:
`verifyRequest(request, secret, now, timingSafeEqual, 'digest')`.

What the mailer should do with each state (from the plan): `morning`: `ready`, `failed` and
`missing` are sent, `in_progress` is not. `fallback`: send whatever comes back.

## Differences from the plan

1. **The `day` must be the server's London day.** The plan didn't say. A signed request with
   another day gets the 400 `malformed` (logged as `reason: day`). The state logic needs "today"
   and "now" to agree, and a stale or replayed request is the likeliest cause. The mailer should
   send the day from its own London clock; the fallback at 08:20 is fine, and a request over
   midnight is not a case.
2. **`+n more` is exact.** The plan says limit 11. The store reads 11 and, only when the 11th
   row exists, runs one `count()` aggregation on the same query spec to get the total. Cost: at
   most three extra aggregation reads, and only on busy days.
3. **`verifyRequest` takes `purpose` as a fifth argument** (after `compare`), not a prefix
   string. The plan said "takes the prefix". The shared `SIGNATURE_PREFIXES` map turns the purpose
   into the prefix, so the strings live in one place. The body limit follows the purpose
   (`DIGEST_WIRE.serverMaxBytes` = 2,000 for the digest; ingest keeps 1,000,000).
4. **The query specs are in `packages/shared/src/digest.ts`**, not the functions package, so the
   web `indexes.test.ts` (which reads `firestore.indexes.json`) can check them. They are also
   checked in `functions/src/digest/queries.test.ts`. No new index: the job lists use the existing
   `(verdict, status, judgedAt desc)` composite; runs, waiting and sources are single-field or
   equality-only.
5. **Usage fallback.** With no `usage/{month}` document the digest shows 0p of
   `DEFAULT_MONTHLY_CAP_PENCE` (1500p). It doesn't read `config/app` (a `monthlyCapPence`
   override), to keep the function to one secret and the minimum reads. The document exists after
   the first model call of a month, and it holds the cap in force.
6. **In `in_progress` and `missing` the digest holds only the status notice and Spend.** There are
   no Run health or Errors sections, and the source and waiting-count reads are skipped. `failed`
   keeps Run health, Spend and Errors but no job lists. The plan listed the sections for the
   normal digest only.
7. **A run document that fails `RunSchema` is skipped and counted** (`store.invalid_doc`), so a
   corrupt morning run reads as no run (`in_progress` before 08:15, `missing` after). The
   emulator test caught this when its seed was incomplete. Say so if you'd rather treat it as
   `failed`.
8. **Run health "S2/S3 counts"** are the run's `perStage.s2` and `s3`. When a stage is absent the
   line is left out.
9. **The deep-reads-paused line** shows from 90% of the cap (`FUNNEL.deepPauseAtFraction`,
   SECURITY.md), and the warning from 80% (`SPEND_WARN_FRACTION`).
10. **Job text in the digest has URLs removed** (`http(s)://…`, `www.…` become `[link removed]`)
    and control characters turned to spaces, as well as being escaped. This makes "no posting
    URLs" true even when a reason or shortfall (model text) repeats one from an injected posting.
11. **Config additions:** `APP_ORIGIN` (`https://hireframe-f6b03.web.app`, the Hosting site in
    RUNBOOK) and a `DIGEST` block in `functions/src/config.ts`.
12. **`sign-test-alert.ts` has a `digest` mode** (the plan's Verification section lists it; the
    CLAUDE.md commands entry is left to 7B.2). The dev seed gains no run for today, so against
    `npm run dev` the answer is `missing` or `in_progress` depending on the clock.
13. **Not done, by instruction:** the Apps Script mailer (`digest.ts`, `main.ts`, scopes,
    `createSigner` purpose argument), ADR-052, the CHANGELOG 0.7.1 entry, PRD/ARCHITECTURE/
    SECURITY/RUNBOOK/CLAUDE.md edits. SECURITY.md's HMAC row and the checklist still describe
    ingest only.
