# 8C1 handoff after build session 1

Branch `feat/m8c1-billing-guard`, pushed. No PR yet. Plan: `docs/plans/m8c-plan.md` §2.

## Done (7 commits after the plan)
1. `feat: billing guard config and mode`: `BILLING_GUARD`, `guardMode(env)`; `billingGuard: 60` in the shared timeout table; `config.test.ts`.
2. `feat: billing guard budget message schema and decision rule`: `billing/schema.ts` (`parseBudgetMessage`), `billing/decide.ts`, `decide.test.ts`.
3. `feat: http client PUT and plain http for the metadata server only`: `putJson`, exact-host `plainHttpHosts` (default `PLAIN_HTTP_HOSTS` = `metadata.google.internal`), `insecure_url` error code; forbidden-host refusal runs first on every path; 10 new client tests.
4. `feat: billing client and guard handler`: `billing/client.ts`, `billing/handler.ts` (`runGuard`), `billing/testing.ts` (test helpers), `client.test.ts`, `handler.test.ts`; seven `billing_guard.*` events added to `log.ts`.
5. `feat: billingGuard endpoint, wiring test and source guard`: `billing/endpoint.ts`, export in `index.ts`, `billing/endpoint.test.ts` (dry-run wiring through the real wrapper, source guard), `index.test.ts` (billingGuard endpoint checks, secrets table).
6. `docs: ADR-059 and billingGuard rows`: ADR-059, ARCHITECTURE row, SECURITY "Billing" row.
7. `chore: allow the billing guard service accounts in the PII scan`.

Your three approval additions: plain http for the metadata host only (tests: other hosts refused, header sent); token never in logs or errors (test on a failed PUT); ADR-059 states the PUT is idempotent.

## Gate (after the last code commit)
| Step | Result |
|---|---|
| `npm run check` | pass: 182 files, 2651 tests (functions 1149 before the allowlist commit, which changes no code), PII scan clean, eval passed |
| `npm run format:check` | pass |
| `npm run test:rules` | pass: 18 files, 407 tests |
| `npm run build` | pass |
| `npm run check:bundle` | pass: 42 chunks, initial JS 295.0 kB gzip |
| `node scripts/smoke-functions-bundle.ts` | pass: `billingGuard` in europe-west2, index.js 1000 KiB |
| `npm run audit` | pass: 1 high advisory, allowlisted (braces via clasp and firebase-tools) |

## Differences from the plan
- **`http/client.ts` was touched** (`putJson`, exact-host plain http, `insecure_url`). The plan allowed a minimal extension; you approved it with the metadata-host rule. A PUT never follows a redirect, and a redirect to plain http is refused for every host.
- **Commit order:** config first (the decision rule needs the constants), then schema and decide.
- **No `HOST_POLICIES` entries** for the Google hosts. The billing client passes its own policy from `BILLING_GUARD.requestTimeoutMs`, so `API_TERMS_HOSTS` is unchanged.
- **Project ID** comes from the documented plain-text leaf `GET /computeMetadata/v1/project/project-id` through `getText` (changed after the Opus review; the first build used `?recursive=true`). It is checked against the GCP project-ID pattern before it enters a URL.
- **`index.test.ts` does not assert `eventTrigger.serviceAccountEmail`:** the manifest holds one `serviceAccountEmail`; firebase-tools copies it to the trigger. C14b reads both live.
- **Extras not in the plan:** a `still_enabled` failure if the PUT answer still shows billing on; the project-ID pattern check; the backoff sleep uses `scheduler.wait` (the source guard bans `setTimeout`); `billing/testing.ts`; the http client's own logs are routed to the structured logger.
- **PII allowlist:** added `hireframe-billing-guard@...` and `*@gcp-sa-pubsub.iam.gserviceaccount.com` (service accounts, in the plan and the config). The scan had flagged the committed plan and the new config.
- **Source guard and wiring test live in `billing/endpoint.test.ts`**, next to the endpoint; endpoint-shape checks are in `index.test.ts` as planned.
- Handler retry, timeout and deadline cases run through the real client with a scripted fetch and a fake clock; the simple paths use a fake `BillingClient`.

## Session 2 starts with
- **C4** fake-clock time tests, one per m8-plan C4 item.
- **C5** `web/src/services/read-counter.ts` (dev only, warns at 201 reads a minute), listener and `refetchInterval` audit, and the `check:bundle` grep.
- **CLAUDE.md** working-method step on the no-self-triggering rule. Check the commands list is still current.
- **RUNBOOK** Part K (K1 to K13) and the Recovery entry "`billingGuard` logs nothing after a publish".
- **CHANGELOG** 0.9.1, and date the `[0.9.0]` heading.
- Then the gate, the PR (body lists each C4 item with its test file), and the Opus self-review and security review sessions.
- Open item for the ADR: it records "which push-delivery option is live" only after the K12 result.
