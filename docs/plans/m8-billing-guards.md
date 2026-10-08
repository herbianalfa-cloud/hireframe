# M8 — billing guards (plan input)

Status: not planned yet. Input for the M8 plan session (Opus · High · Plan mode).
Written 8 Oct 2026 after a public case: a self-rescheduling Cloudflare Durable Object alarm ran unnoticed and cost US$10,811.

## Goal
A bug, a bad deploy or an attacker can cost pounds, never hundreds. Every guard is tested, not assumed.

## Facts
- Project `hireframe-f6b03`, Blaze, region europe-west2. The £10 budget is an alert only. Blaze has no hard cap.
- Anthropic spend is already capped three times: `llm.call()`, the per-run lease, the console limit.
- Scan functions have max instances 1, a 540 s timeout and a single-flight lock.
- No function is triggered by a Firestore write today.
- `lookup` and `ingestEmailJobs` are publicly invokable (`allUsers`). HMAC and App Check reject strangers after the function starts, so each rejected call is still billed.

## Work items

### 1. Instance and timeout audit
- List every deployed function: `scheduledScan`, `scanNow`, `ingestEmailJobs`, `lookup`, `parseCv`, `addFact`, `rescore`, `generateCv`, `weeklyBackup`, and `getDigest` when M7 adds it.
- Each one sets `maxInstances`, `timeoutSeconds` and `memory` explicitly in code. Proposed: `maxInstances` 1 for scans and backup, 2 for callables and HTTPS.
- Add a unit test that fails if any exported function has no `maxInstances`.
- Confirm no function has retry-on-failure enabled.

### 2. Hard rule in CLAUDE.md (done early, before the M7 plan session)
M7 adds background work, so this rule ships in the same PR as this note.
Added under "Hard rules":
> **No self-triggering code.** No function may be triggered by a Firestore, Storage or Pub/Sub event that it can itself cause. No function may reschedule or re-enqueue itself. Any loop over external calls or writes has a fixed maximum count and a deadline. Every new function sets `maxInstances`.

Add the same check to the self-review prompt in PLAYBOOK.md.

### 3. Billing kill switch
- Pattern: GCP budget → Pub/Sub topic → a small function that removes the billing account from the project (Google doc: "Disable billing usage with notifications"). Verify the current doc in the plan session.
- Proposed threshold: £25 actual GCP spend in a month (normal use is near the free tier). Decide in the plan.
- Effect when it fires: all paid services stop, including scans. Recovery is manual: re-link billing in the console. Write the RUNBOOK entry.
- Known limits: billing data lags by hours, so spend can pass the threshold before the switch fires. Google warns that resources can be lost when billing is removed; the weekly backup must be outside the risk (export a copy off-project or confirm Storage survives).
- The function's service account gets only the billing role it needs. ADR required.
- Test: publish a fake budget message to the topic in a throwaway project, not prod.

### 4. Alerts that reach a phone
- Budget thresholds at £2, £5 and £10, both actual and forecast.
- Confirm the alert email goes to herbianalfa@ and is not filtered.
- Add GCP spend this month to the System screen and the morning digest, next to the Anthropic meter, if the Billing export makes it cheap. Otherwise park it.

### 5. Time-dependent tests
The public case stayed hidden for 23 days because it depended on a 30-day expiry and a 7-day refresh window.
- Fake-clock tests for every piece of time logic: expiry sweep, describe-claim release (10 min), nonce store (10 min), lease and month rollover, `freshness_days`, 60-day purge, backup retention.
- Each test advances the clock past the boundary and asserts the code stops or does bounded work.

### 6. Client read loops
- A React effect or listener bug can loop Firestore reads from the browser.
- Check: no `onSnapshot` or query inside an effect with unstable dependencies; TanStack Query `refetchInterval` unset or at least 60 s.
- Optional: a dev-only counter that warns in the console above 200 reads a minute.

### 7. Stolen-account guards
A stolen Google account is the only route to a bill of thousands. No code cap applies to it.
- Set Compute Engine CPU and GPU quotas to 0 in every region for `hireframe-f6b03` (confirm first that Functions v2 and Cloud Build do not need them).
- Disable every GCP API the project does not use.
- Passkey or hardware key on herbianalfa@. Check the recovery phone and email.
- No service account key files anywhere (keyless deploy already). Remove Editor from the default compute service account (already on the M8 list).
- RUNBOOK: run `gcloud auth revoke` on the laptop when the login is not needed; prefer Cloud Shell.

### 8. Payment limit
- Put a virtual card with a low monthly limit (proposed £50) on the GCP billing account.
- A failed charge suspends the project. The balance is still owed in principle, but spending stops.
- RUNBOOK entry: what a suspension looks like and how to recover.

## Acceptance criteria
- CPU and GPU quotas show 0 in the console; unused APIs are disabled.
- A test fails when a function is exported without `maxInstances`.
- The kill switch removes billing in a test project when a fake over-budget message is published.
- RUNBOOK has a "Billing was disabled" recovery entry.
- CLAUDE.md and the PLAYBOOK self-review prompt contain the no-self-triggering rule.
- Fake-clock tests exist for every item in section 5.

## Out of scope
Rate limiting at the edge (Cloud Armor), a second billing account, moving off Firebase.
