# PR #37 fix-commit review (`ff6234c...7eb7982`)

## Context
This is a read-only review of the 9 fix commits on PR #37 against `docs/plans/m8b-review.md`, the CLAUDE.md hard rules and `docs/SECURITY.md`. No code was changed. CI on head `7eb7982`: check, rules, gitleaks and audit are all green. I did not re-run the gate locally.

**Verdict:** no must-fix. 4 should-fix items, all small: 3 RUNBOOK edits and 1 emulator test. Merge once they're in.

## 1. Findings and tests against the fix plan
All fixed as planned unless noted.
- **M1** fixed: C10–C13, C3, C14 and C13b are now inline, and C15/C16 moved to J1. Gaps remain (SF2–SF4, nits below).
- **S1** fixed: `descriptionPurged` is projected (`scan/store.ts:305`), `descriptionUpgrade` returns early for a purged job unless it waits for a description (`dedupe.ts:328`), and `clearPurged` makes `writePlan` delete the field (`scan/store.ts:363`).
- **S2** fixed: `SHORT_LOCK_HOLDERS.includes` (`rescore.ts:114`).
- **S3** fixed: `profileSkipped` blocks both the profile step and `done` (`wipe/run.ts:125-132`).
- **S4** fixed: the jobs step needs 2 documents of cap (`perItem`). Tests use a cap of 5, not 3,000. That is fine: same logic.
- **S5** fixed: `running` moved to the parent and `onOpenChange` ignores a close while it's true. Close buttons render only when not running.
- **S6** fixed: zod on the cursor, the page rows and the candidate. A failed parse becomes `decidePurge(null)`, which returns `'kept'`.
- **S7** fixed: SECURITY, RUNBOOK and the dialog wording. But see SF4.
- **S8, S9** fixed.
- **N1–N7** fixed:
  - N4 goes further than planned: it also refuses a non-demo `GOOGLE_CLOUD_PROJECT` or `FIREBASE_CONFIG`.
  - N5 is done in the client (`dataCounts` subtracts the profile counts), not on the server. That's acceptable: the API totals stay as they are.
- **D1** kept and pinned by a test. The `callable.ts` two-tabs comment is reworded, and the ROADMAP parking-lot line is added.
- **T1–T7, T9, T10** present. **T8** is partial: it presses Escape only. The X and outside clicks go through the same `onOpenChange` guard, and the 20-pass cap and error stop are already covered by tests :112 and :124. Acceptable.

## 2. Hard rules and SECURITY
No violations:
- No new function or trigger, and nothing triggers itself.
- New loops are bounded (the retention ties test stops at 10 pages; the import walker uses a seen-set over a finite file tree).
- No secrets. Fixtures are fake.
- Zod is added at the Firestore read boundaries.
- The config literal moved into `WIPE`.
- Components still go through `services/`.

One convention slip: see nit N-f.

## 3. S1 emulator test: needed? Yes (should-fix, SF1)
- The dedupe unit tests pass `descriptionPurged: true` in directly, and `queries.test.ts` checks only the select list.
- No test covers the store step that turns Firestore's `descriptionPurgedAt` into `descriptionPurged` (`scan/store.ts:305`). Scan, ingest and Lookup all share this `findJobsByKeys`.
- If that mapping breaks, S1 comes back silently: descriptions get restored and no test fails. The `FieldValue.delete()` inside `batch.update` is standard and low risk, but it's cheap to cover in the same test.
- Template: `tests/emulator/ingest.test.ts:241` ("alert first: a job waiting for a description gets the ATS text…"). Add two cases:
  - (a) A purged snippet job (`descriptionPurgedAt` set, no `description/raw`) plus a matching full-text posting. Expect: no `description/raw`, still `snippet`, stamp kept.
  - (b) The same job at `next: 'description'`. Expect: `description/raw` written, `descriptionPurgedAt` gone, `next: 's3'`.

## 4. RUNBOOK Part J
- **SF2. No tag/deploy step.** Step 98 says "Before the tag" and 99 says "After the deploy", but nothing in between says to merge, push `v0.9.0` and approve the deploy (C4, Part C step 27). Steps 78 and 94.1 both have that line.
- **SF3. Part C step 28's loop (`RUNBOOK.md:168`) has no `deleteAllData`.** Step 99 says "as in Part C step 28", and step 28 says "add its name to this list". A rebuild from Part C would leave the wipe dialog failing with a CORS error.
- **SF4. C20c is optional, tucked into the restore drill, and has no expected output.** SECURITY, the RUNBOOK and the dialog now all state "7 days" as fact. Make C20c a required read in step 98, and state the expected value: `retentionDurationSeconds` 604800. If it differs, fix the wording before the tag.

The order of the rest works: J1 C1/C2 + C15/C16 → (tag) → C10 → C11/C12/C13 (C13b if no job) → C3/C14 + index → C17 READY before any real wipe → C18–C20.

## Nits (optional)
- **N-a.** Write C16's expected output as gcloud prints it: `retention: 4838400s`, `weeklyRecurrence: day: SUNDAY`.
- **N-b.** C12, C13, the optional `jobs run`, and C13b's `jobs create` and `jobs run` lack `--project=$P`. C3, C10, C11 and C14 in the same Part have it. It works if Cloud Shell's project is set, as in 94.4.
- **N-c.** C13b has no check after it. Add: "then re-run C12 and C13, expecting step 100's output."
- **N-d.** C14 prints memory and the service account, but the expected line doesn't name them. They should be `512MiB` and `hireframe-fns@…` for both functions.
- **N-e.** `RUNBOOK.md:556` says "Soft-deleted files can't be listed here". They can (`gcloud storage ls --soft-deleted`). What's true is that the runbook can't erase them early. Reword.
- **N-f.** `retention.invalid_doc` logs `{ jobId }` (`retention/store.ts:78`). It's the first production log that carries a document ID. It isn't PII (auto ID) and SECURITY allows scalar fields, but it breaks the counts-and-codes convention. `store.invalid_doc` uses `{ collection, count }`. Match that, or keep it and say why.
- **N-g.** The comment in `wipe/run.test.ts` "never deletes more than the cap" says events go first. `WIPE_STEPS` runs jobs before events, so call 1 deletes 2 jobs, 2 descriptions and 1 event. The assertions are right; the comment is wrong.
- **N-h.** The dialog's X stays visible but does nothing while running. Hiding or disabling it would be clearer.
- **N-i.** `m8b-plan.md:51` still says "two tabs run one after the other". It's a historical plan, so this is optional.

## Residual risk (no change in this PR)
Only the dedupe path clears `descriptionPurgedAt`. Lookup's `saveDescription` (`lookup/store.ts:161`) and the hydrator's `saveFullText` (`funnel/store.ts:282`) write a description and leave the stamp. If a purged job were ever re-queued and re-judged, it would never be purged again. Today neither path can reach a skip judged more than 60 days ago: re-score covers only 14 days, and Lookup's abandoned branch needs a job that was never judged. This is a parking-lot candidate: "a re-judgement clears `descriptionPurgedAt`".

## Next step after approval
Fix SF1–SF4 (plus any nits you want) as small commits on `feat/m8b-data-lifecycle`, add a CHANGELOG line, run the 7-step gate, push, and wait for CI to go green.
