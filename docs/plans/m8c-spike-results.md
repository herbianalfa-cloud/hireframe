# 8C Phase 1 spike results

Run Sat 17 Oct 2026 in the throwaway project `hireframe-guard-test-2050` (deleted afterwards). Plan: `m8c-plan.md` §4 Phase 1.

## Results

1. **Path F passes.** Cloud Build finished SUCCESS as the compute account holding only:
   - `roles/logging.logWriter` (project)
   - `roles/artifactregistry.writer` (on the `gcf-artifacts` repo)
   - `roles/storage.objectViewer` with condition `resource.name.startsWith("projects/_/buckets/gcf-v2-")` (title `gcf-sources`)

   `roles/cloudbuild.builds.builder` is not needed. gcloud warns about it; answer the continue prompt without granting. CPU/GPU quota 0 does not block builds. No per-bucket grant is needed.
2. **Quota default.** A new project starts with `CPUS_ALL_REGIONS` and `GPUS_ALL_REGIONS` = 0 (default 32), and the console refuses an equal value. Prod still needs a real edit in Phase 3.
3. **C24c check fix.** `gcloud compute project-info describe` rejects `--filter`. Use:
   `gcloud compute project-info describe --project=$T --flatten=quotas --format='value(quotas.metric,quotas.limit)' | grep -E '^(CPUS_ALL_REGIONS|GPUS_ALL_REGIONS)\s'`
4. **Spike-only.** A gcloud deploy of a firebase-functions v2 event function needs `--set-env-vars FUNCTION_SIGNATURE_TYPE=cloudevent` (firebase-tools sets it in `cloudfunctionsv2.js`). Without it: `Malformed Pub/Sub event: missing 'message' property`. Prod (`firebase deploy`) is not affected.
5. **Invoker propagation.** After `add-invoker-policy-binding`, the first 4 deliveries got 403 (`run.routes.invoke`) for about 1 minute, then 200. In RUNBOOK K8/K12, wait 2 minutes before a test publish.
6. **`billing.projectManager` alone is not enough.** `billing_guard.failed`, step `read`, code `permission_denied` (GET `billingInfo` needs `resourcemanager.projects.get`). With `roles/browser` added on the project: `billing_guard.disabled`, `billingEnabled` False. Below-budget message: `billing_guard.below`, mode armed, no project step error.

## Decision pending (Beeb)

Per m8c-plan decision 2, arming leaves M8. Options for v1.0.1:

- Grant the prod guard `billing.projectManager` + `roles/browser` (tested).
- Change the code to skip the read (untested).

**Recommendation:** `roles/browser`.
