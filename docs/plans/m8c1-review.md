# PR #39 (8C1) security and correctness review

## Context
- **Scope:** security and correctness review of PR #39, branch `feat/m8c1-billing-guard` at `b6681d9` (the same as the remote; `git ls-remote` matched, so no fetch was needed).
  - **Diff:** `origin/main...origin/feat/m8c1-billing-guard`.
  - **Read:** CLAUDE.md, SECURITY.md, m8c-plan §2 and §4 Phase 2, and the 8C1 handoff.
- **Read-only, as asked.** Nothing was edited, committed or fixed. The fixes below are for a later session.
- **Method:**
  - Read every changed file, plus the http client, the scan store and firebase-functions 7.4.0's Pub/Sub wrapper.
  - Ran URL-parsing and zod checks in `node -e`.
  - Read Cloud Run's metadata contract.
- **Verdict: no blockers.**
  - The dry-run guarantee holds in the code: no network call on any path.
  - Arming needs exactly `armed`.
  - The token never reaches a log.
  - Findings: 12 should-fix, 12 nits.
- **Timing:**
  - Before Saturday's spike: #7 and #8.
  - Before Monday's v0.9.1: the RUNBOOK fixes #9–#11, and ideally the code fixes #1–#6.
- Severity order: most severe first.

## Findings

### Should fix
1. **The forbidden-host list misses a trailing-dot FQDN.** This is pre-existing and outside the diff, but it is the trailing-dot case on the forbidden path, and it touches a hard rule.
   - **Where:** `functions/src/http/client.ts:285-289`.
   - **What:** `new URL('https://www.linkedin.com./x').hostname` is `www.linkedin.com.`, which neither equals nor ends with `.linkedin.com`, so it is **not refused** (checked with node). A board API redirect to that form would be followed. The plain-http check does refuse the trailing dot.
   - **Fix:** `const host = hostname.toLowerCase().replace(/\.+$/, '');`
   - **Tests:** add `https://www.linkedin.com./jobs/view/1` to `client.test.ts:360` (direct request) and to `:376` (as a redirect hop).

2. **On redirects, the forbidden-host refusal is no longer first.**
   - **Where:** `functions/src/http/client.ts:225`, `:233-239`.
   - **What:**
     - A redirect to `http://uk.linkedin.com/…` now fails `schemeAllowed` and throws `http_status`, with no `http.forbidden_host` line. Before this PR it threw `forbidden_host`.
     - On a PUT, the no-follow check also runs before the forbidden check.
     - No request is made either way, so the hard rule holds. But ADR-059 (`docs/DECISIONS.md:781`) says the refusal is "checked first, on every path".
   - **Fix (also closes #3a):** after cancelling the body, parse `Location` first, then:
     ```ts
     if (next && isForbidden(next.hostname)) {
       deps.log('warn', 'http.forbidden_host', { host: next.host, path: next.pathname, label });
       throw new HttpError('forbidden_host');
     }
     // A write is never replayed against a new location.
     if (init.method !== 'GET') throw new HttpError('http_status', response.status);
     if (!next || hop >= MAX_REDIRECTS || next.protocol !== 'https:') {
       throw new HttpError('http_status', response.status);
     }
     ```
   - **Test:** in `client.test.ts:376`, a hop to `http://uk.linkedin.com/jobs/view/1` gives `forbidden_host` and logs `http.forbidden_host`.

3. **Plain http to the metadata host is open to every client, including through redirects.**
   - **Where:** `functions/src/http/client.ts:233`, `:297`.
   - **(a) Redirects:** a redirect from any https host to `http://metadata.google.internal/…` is followed, because the redirect check reuses `schemeAllowed`. This contradicts the handoff (`docs/plans/m8c1-handoff-1.md:28`) and the PR body, which say "a redirect to plain http is refused for every host". ADR-059 instead says "redirects included".
   - **(b) Default list:** `plainHttpHosts ?? PLAIN_HTTP_HOSTS` gives the scan, Lookup and detect-ats clients plain http to the metadata host, which they never need.
   - **No leak today:** those clients never send `Metadata-Flavor: Google`, so the metadata server refuses them.
   - **Fix:**
     - Make redirects https-only (the code in #2).
     - Default the list to empty: `(deps.plainHttpHosts ?? []).includes(…)`.
     - Pass `plainHttpHosts: PLAIN_HTTP_HOSTS` only in `createBillingClient` (`billing/client.ts:61-79`).
     - Update the doc at `client.ts:92-96` and ADR-059 to say "the billing client only, never through a redirect".
   - **Tests:**
     - A default client gets `insecure_url` for `http://metadata.google.internal/x`.
     - A 302 from `https://api.example.com/a` to `http://metadata.google.internal/computeMetadata/v1/x` gives `http_status`, and no call reaches that host.

4. **Credentials follow cross-origin redirects.**
   - **Where:** `functions/src/http/client.ts:212`.
   - **What:**
     - The loop re-sends the caller's headers on every hop. So `billing.get`'s `Authorization: Bearer` (and, pre-existing, Reed's Basic key) would go to whatever origin a 3xx names.
     - The Fetch standard drops `Authorization` on a cross-origin redirect; this loop doesn't.
     - Likelihood is very low: Cloud Billing would have to redirect cross-origin. But `billing/client.ts:11-12` and ADR-059 (`DECISIONS.md:783`) promise "one `Authorization` header and nowhere else".
   - **Fix:** in `send`, keep `let hopHeaders = headers;`. When `next.origin !== target.origin`, drop `Authorization` and `Metadata-Flavor` (case-insensitive) before the next fetch.
   - **Tests:** a bearer GET redirected to another origin arrives without `Authorization`; a same-origin hop keeps it.

5. **The "real wrapper" wiring test calls the raw handler.**
   - **Where:** `functions/src/billing/endpoint.test.ts:34-36`, `:57`, `:66`, `:75`.
   - **What:**
     - In firebase-functions 7.4.0, `func.run = handler` (`node_modules/firebase-functions/lib/v2/providers/pubsub.js:145`). So `.run(event)` skips the wrapper: `new Message`, `addV1Compat`, `wrapTraceContext` and `withInit`.
     - I read the wrapper: it makes no network call, and no `onInit` is registered in `functions/src`. So the guarantee holds.
     - But the test doesn't prove what ADR-059 (`DECISIONS.md:779`) and the PR table claim. The plan itself called `.run` "the real wrapper".
   - **Fix:**
     - In all three tests, call the exported function instead: `const invoke = billingGuard as unknown as (event: unknown) => Promise<unknown>; await invoke(cloudEvent(25));`.
     - Add a fourth case: an attributes-only message (no `data`) through `invoke`. It logs `['billing_guard.invalid']`, resolves, and makes no fetch. This needs #13.

6. **The source guard is easy to bypass.**
   - **Where:** `functions/src/billing/endpoint.test.ts:97-114`.
   - **What:** it is a text denylist over `billing/*.ts` only. Ways around it:
     - A helper imported from outside `billing/` (for example `../scan/store.js`) brings in Firestore writes without any banned word.
     - REST through `fetch` matches nothing: `pubsub.googleapis.com/…:publish`, `firestore.googleapis.com`, or the function's own `run.app` URL. After K8, the guard account holds `run.invoker` on itself.
     - `topic.publishMessage(` slips past `\.publish\(`.
     - The comment stripper (`:110`) treats `/*` inside a string as a comment and hides code up to the next `*/`.
     - Lower-case `@google-cloud/firestore` and `@google-cloud/storage` imports with lower-case names aren't matched.
   - **Mitigation:**
     - IAM is the real backstop: the guard account has no publisher or Firestore role.
     - The transitive imports are clean today: zod, firebase-functions and `@hireframe/shared`, with no firebase-admin.
   - **Fix:** keep the denylist and add an allowlist layer:
     - Every import specifier must be one of `zod`, `node:timers/promises`, `firebase-functions/pubsub`, `@hireframe/shared`, `../options.js`, `../config.js`, `../log.js`, `../http/client.js`, `./client.js`, `./decide.js`, `./handler.js` or `./schema.js`, and there is no dynamic `import(`.
     - The only `https?://` literals are `http://metadata.google.internal/computeMetadata/v1` and `https://cloudbilling.googleapis.com/v1`.
     - No `fetch(` except `globalThis.fetch` in `endpoint.ts`.
     - Widen the publish pattern to `/\bpublish(Message)?\(/`.

7. **The project lookup uses a path Cloud Run doesn't document. Fix before the spike.**
   - **Where:** `functions/src/billing/client.ts:104`, which reads `project/?recursive=true`.
   - **What:**
     - Cloud Run's container contract documents the `project/project-id` leaf and says nothing about recursive queries.
     - Dry run never calls this path. Spike step C29b is its first real use.
     - The spike's failure branch (`docs/plans/m8c-plan.md:287`) covers only `permission_denied`.
   - **Fix:** add a branch to C29b/C30:
     > `billing_guard.failed` with `step: project` means the metadata path isn't served. Stop. Switch the client to `GET …/project/project-id` (a small text read with the same timeout, retry and deadline rules, then the project-ID pattern), redeploy to `$T`, and repeat C29b before judging `projectManager`.

     Or make that switch now.

8. **K12's gate can't show `mode`.**
   - **Where:** `docs/RUNBOOK.md:548`. The same command is in K13/C47 (`:552`) and spike steps C29a/C29b (`m8c-plan.md:285-286`).
   - **What:**
     - `gcloud functions logs read` prints each entry's text or `message` (`billing_guard.below`), not the structured fields.
     - So "only after that line shows `dry_run`" can't be confirmed from its output.
     - This is the first use of the command in the RUNBOOK.
   - **Fix:** use
     ```bash
     gcloud logging read 'resource.type="cloud_run_revision" AND resource.labels.service_name="billingguard"' --project=$P --freshness=10m --limit=10 --format='table(timestamp,severity,jsonPayload.event,jsonPayload.mode,jsonPayload.step,jsonPayload.code)'
     ```
     For C47 use `--freshness=1d`. In the spike, use `--project=$T`.

9. **K9's "diff prints nothing" contradicts K7.**
   - **Where:** `docs/RUNBOOK.md:535` (plan `:345`).
   - **What:**
     - C38b leaves a project-level `roles/eventarc.developer` binding for `$SA`, so the diff can't be empty when C38b ran.
     - If K6 had to create `$PSA`, Google may also bind `roles/pubsub.serviceAgent` to it at project level.
     - An operator holding to "nothing" might remove a binding that Pub/Sub push needs.
   - **Fix:** replace the check with:
     > The diff prints nothing, or only `roles/eventarc.developer serviceAccount:$SA` if K7 needed C38b (record it). A `roles/pubsub.serviceAgent serviceAccount:$PSA` line, if K6 created the agent, is Google's own binding: record it and never remove it. Any other line: stop.

10. **K10's C39a and C39b have no commands.**
    - **Where:** `docs/RUNBOOK.md:542-543`.
    - **What:** the commands exist only in `docs/plans/m8-plan.md:436-437`. The m8b review flagged the same gap (`docs/plans/m8b-review.md:30`).
    - **Fix:** inline them:
      ```bash
      for L in $R global; do gcloud eventarc triggers list --location=$L --project=$P --format='table(name,serviceAccount,destination.cloudRun.service,transport.pubsub.topic)'; done
      gcloud functions list --regions=$R --project=$P --format='table(name,serviceConfig.serviceAccountEmail,eventTrigger.serviceAccountEmail)'
      ```
    - **Expected:**
      - No row shows `$COMPUTE`.
      - The `billingguard` trigger shows `hireframe-billing-guard@…`.
      - Every function shows `hireframe-fns@…`, except `billingGuard`.

11. **K8's rollback isn't a command and names no member.**
    - **Where:** `docs/RUNBOOK.md:534` (plan `:340`).
    - **Fix:** `gcloud functions remove-invoker-policy-binding billingGuard --region=$R --member=serviceAccount:$GUARD --project=$P`

12. **Item 11, the scan and wipe locks: a real but narrow gap.**
    - **Where:** `functions/src/scan/store.ts:67-69`, `:86-89`, `:140-143` hold three copies of the stale rule.
    - **What:**
      - Only `liveLockHolder` (the advisory read) has ±1 ms boundary tests.
      - `acquireLock` and `acquireOrRefreshWipe` are the transactions that actually enforce exclusion. They are tested only at ±1–2 minutes, in the emulator: `tests/emulator/ingest.test.ts:384-411`, `scan.test.ts:165`, `wipe.test.ts:257` and `:276`.
      - All three copies agree today, so there is no live bug, only drift risk. They agree that:
        - `now < staleAt` is live;
        - a legacy lock falls back to `startedAt` + 12 minutes;
        - a lock without `runId` or `startedAt` is free.
      - `CHANGELOG.md:16` overstates the coverage.
    - **Fix:**
      - Add `export function lockLiveUntil(lock): Date | undefined`. It returns undefined unless the lock has a `runId` and a `startedAt`, and otherwise `staleAt ?? startedAt + SCAN.lockStaleMs`.
      - Add `isLockLive(lock, now)` on top of it.
      - Use it at all three sites.
      - Point the `store.test.ts` table at `isLockLive`, and keep the `liveLockHolder` cases.

### Nits
13. **An attributes-only message throws.**
    - **Where:** `functions/src/billing/schema.ts:30-31`, `endpoint.ts:32`.
    - **What:** `Message` sets `this.data = data.data` (`pubsub.js:46`), which is `undefined` for an attributes-only publish. `base64.length` then throws before `runGuard`'s `try`, which breaks "Never throws" (`handler.ts:37`). There is still no network call.
    - **Fix:** `parseBudgetMessage(base64: unknown)`, starting with `if (typeof base64 !== 'string' || base64.length > MAX_MESSAGE_BYTES * 2) return null;`. Add `undefined`, `null` and `42` cases to `decide.test.ts`.
14. **The plain-http check ignores the port and userinfo.**
    - **Where:** `functions/src/http/client.ts:297`.
    - **What:** it compares `hostname`, so `http://metadata.google.internal:8080/` passes. Userinfo also passes, though `fetch` then refuses a URL with credentials.
    - **Fix:** `url.protocol === 'http:' && url.username === '' && url.password === '' && list.includes(url.host)`.
    - **Tests:** add the forms you listed to `client.test.ts:462`:
      - refused: `:8080`, `u@…`, the trailing dot, `2852039166`, `[::ffff:169.254.169.254]` and the `%2e` suffix;
      - allowed: upper case.
      I evaluated each with node: today only the port and userinfo forms pass wrongly.
15. **The project-literal test skips two files.**
    - **Where:** `endpoint.test.ts:118`.
    - **What:** it skips `endpoint.ts` and `decide.ts`, yet the endpoint is where an override would land.
    - **Fix:** check all five files. Also ban `GCLOUD_PROJECT|GOOGLE_CLOUD_PROJECT|firebase-functions/params` in `billing/*.ts`.
16. **K7 tags before its own check and has no rollback.**
    - **Where:** `docs/RUNBOOK.md:529`.
    - **What:** the one-liner tags straight after `git log -1`, so "before tagging" can't be honoured.
    - **Fix:** split it:
      - run `git checkout main && git pull && git log -1`;
      - check the output, then run `git tag v0.9.1 && git push origin v0.9.1`.
    - **Rollback text:** "none needed for safety (no billing role); to remove the function, revert the export in a PR and release a patch".
17. **K1 points to the wrong step for C3.**
    - **Where:** `docs/RUNBOOK.md:509`.
    - **What:** C3's command is in Part J step 101, not step 77.
    - **Fix:** "Repeat Part G step 77 (C1, C2) and the C3 line of step 101."
18. **The CHANGELOG release notes are wrong in two places.**
    - **Where:** `CHANGELOG.md:8`.
    - **What:** "needs Part K after deploy" is wrong: K2–K6 must come before the tag. "a single idempotent PUT" is retried up to 3 times.
    - **Fix:** "needs RUNBOOK Part K: K1–K6 before the tag, K8–K13 after", and "one idempotent PUT, retried at most 3 times".
19. **Three docs are stale since the path logging (`7d78280`).**
    - `DECISIONS.md:783`: "logs a host, a label and a code" → "a host, a path, a label and a code".
    - `SECURITY.md:28`: "logs a host and a fixed label, never a URL" → "a host, the path and a fixed label, never the query string or headers".
    - `CHANGELOG.md:20`: "the host, the path and the label only" → "never the query string, headers or a token". (`http.host_paused` carries no path.)
20. **ARCHITECTURE still says every function runs as `hireframe-fns`.**
    - **Where:** `docs/ARCHITECTURE.md:107`.
    - **Fix:** "All functions except `billingGuard` (`hireframe-billing-guard`, ADR-059) …".
21. **The "NaN cost" test doesn't test NaN.**
    - **Where:** `decide.test.ts:107`.
    - **What:** it sends the string `'NaN'` (JSON has no NaN).
    - **Fix:** add raw-JSON cases `'{"costAmount":1e999,…}'` and `budgetAmount: 1e999`. zod 4.6.5 rejects both; I checked.
22. **The fake token uses Google's real prefix.**
    - **Where:** `testing.ts:5`.
    - **What:** `ya29.` is the prefix of real Google access tokens, and public-repo secret scanning can match it.
    - **Fix:** check Security → Secret scanning. Prefer `fake-access-token-must-never-be-logged`; the `not.toContain('ya29')` assertions can stay.
23. **A body-read timeout is misclassified (pre-existing).**
    - **Where:** `http/client.ts:342`, `:374`.
    - **What:** a timeout while reading the body escapes as a raw DOMException. It isn't retried, and the guard logs `unexpected`.
    - **Fix:** map `readBody` errors to `HttpError('timeout' | 'network')`.
24. **Record a property for arming in ADR-059** (`DECISIONS.md:780`).
    - **What:** once armed, anyone who can publish to `billing-guard` can trip the kill with a forged message. The guard can't authenticate messages. Publishers include:
      - project Owners and Editors (the compute account keeps Editor until v1.0.0);
      - the budget alert account that K13's topic link adds.
    - **Fix:**
      - Record this in the ADR. Name the budget alert account without its address, or the PII scan fails.
      - Add an arming check: `gcloud pubsub topics get-iam-policy billing-guard --project=$P` shows only the budget publisher.

## Checked and clean
1. **Dry run makes no network call.**
   - `disable` happens only when `mode === 'armed'`.
   - `would_disable`, `below`, `ignored` and `invalid` all return before `deps.billing()`.
   - Building the client sends nothing: the token is fetched lazily.
   - The wrapper and module init make no call: admin init is lazy, and no `onInit` is registered.
   - On the error paths, `.invalid` and #13's TypeError also make no call.
2. **Only the exact string `armed` arms.**
   - The check is `env.BILLING_GUARD_MODE === 'armed'`, read per invocation. The message can't reach it.
   - There is no `defineString` param.
   - The build wipes `functions/deploy/` and writes no `.env` (`scripts/build-functions.ts:30`). Both `.env*` and `functions/deploy/` are gitignored.
   - Tests cover `ARMED`, ` armed`, `armed `, `true`, `1`, `''` and `dry_run`.
3. **The target project comes only from the metadata server.**
   - `PROJECT_ID` is checked twice, then `encodeURIComponent` is applied. JS `$` means end of input, so a trailing `\n` fails.
   - The handler test proves the PUT goes to the project the metadata server reported.
   - No literal, and no `GCLOUD_PROJECT`.
4. **Plain http and the forbidden-host check.**
   - No parser differential: `fetch` uses the same WHATWG parser as the check.
   - Refused: suffixes and subdomains, `%2e`, `host@evil`, the trailing dot, and the decimal, hex, octal, IPv4-mapped and IPv6 forms of the metadata IP. Upper case normalises.
   - A redirect downgrade to another http host is refused.
   - The forbidden check runs first in `requestJson`, for GET and PUT.
5. **The access token never reaches a log or an error.**
   - It stays in the client's closure, and a test proves it is never sent to the metadata server.
   - Logs carry host, path, label and codes only. `HttpError` messages are codes.
   - A test covers the token inside a failed PUT's body.
   - The repo has no snapshot tests.
6. **The PUT.**
   - `{billingAccountName: ""}` is idempotent.
   - A 307 is refused and not retried.
   - At most 3 attempts, on 408, 425, 429, 5xx, timeouts and network errors.
   - Each attempt's timeout is clamped to the 45 s deadline, and a backoff sleep happens only if it fits.
   - 45 s is under the 60 s function timeout, and `config.test.ts` pins it.
7. **The endpoint.**
   - Trigger: Pub/Sub `messagePublished` on `billing-guard`, with `retry: false`.
   - Limits: a literal `maxInstances: 1`, 60 s from the shared table, 256 MiB.
   - Account: the guard's own, overriding the global `hireframe-fns`.
   - No secrets (the global options set none) and no other trigger.
   - `index.test.ts` asserts all of this.
8. **billingGuard can't cause its own trigger.**
   - The guard account has no publisher role.
   - Budget messages come on Google's schedule, not from anything the guard does.
   - Every loop is bounded: 3 attempts, 3 redirect hops and a deadline.
   - `maxInstances` is set.
9. **The PII allowlist isn't too broad.**
   - Matching is per email, against an exact address or an exact domain (`scripts/pii.ts:34-38`).
   - The `gcp-sa-pubsub` domain holds only Google service agents, like the existing Storage agent entry.
10. **The read counter is absent from production.**
    - Every entry point sits behind `import.meta.env.DEV`.
    - `READ_WARNING` is plain ASCII, so minification can't hide it from `check:bundle`, and any surviving counter code would pull it in.
    - In prod, `watchSnapshot` is `onSnapshot` plus a no-op, and `tally` is a plain await.
    - All 11 converted services are one to one, with no listener options dropped, and no read was added.
    - The tests stub `DEV` both ways.
11. **The RUNBOOK matches the plan, except #8–#11, #16 and #17.**
    - The commands in K3–K6, K8, K9, K12 and the Recovery entry match the plan exactly.
    - Every member is `serviceAccount:$VAR` from the setup block.
    - Only `add-`/`remove-iam-policy-binding` and `add-invoker-policy-binding`; never `set-iam-policy`; the `user:` owner binding is untouched.
    - The step 77 and step 27 references are right, and C14b matches m8-plan's C14b.
12. **ADR-059 and the CHANGELOG match the code, except #2–#5 and #18–#20.** They agree on:
    - the decision rule, the ignored forecast, the mode and no billing role in dry run;
    - the metadata project, the idempotent PUT and `already_disabled`;
    - the 45 s deadline, the log fields, the source test's scope and the endpoint shape.
13. **The C4 time tests assert the boundaries they claim:** the nonce, reservations, the London month rollover, freshness, the describe claim and the purge edge.

## After approval
- Nothing changes in this session; you asked for review only.
- To apply the fixes later, in a separate session, in this order:
  - code and tests: #1–#6, #12–#15 and #21–#23;
  - the RUNBOOK and plan: #7–#11, #16 and #17;
  - docs: #18–#20 and #24;
  - then correct the PR body's "redirect to plain http refused for every host" and "through the real wrapper" claims.

## Verification (for the fix session)
- Run the 7-step gate: `npm run check`, `npm run format:check`, `npm run test:rules`, `npm run build`, `npm run check:bundle`, `node scripts/smoke-functions-bundle.ts`, `npm run audit`.
- Each new test must fail with the old code first. Revert the one-line fix and watch the test go red.
- For #8, run the `gcloud logging read` form once against the throwaway project during the spike.

Sources: [Cloud Run container contract](https://docs.cloud.google.com/run/docs/container-contract), [GCP metadata server quirks](https://medium.com/@jaredhatfield/exploring-the-quirks-of-gcps-metadata-server-c69903632edb)
