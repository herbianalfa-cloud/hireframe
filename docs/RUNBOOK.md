# Runbook

## One-time setup (user)
1. **GitHub:** create public repo `hireframe`, push this docs pack. Enable secret scanning + push protection, Dependabot, branch protection on `main` (PR required now; add required status checks after M0 CI has run once). *Done:* ruleset `protect-main` requires a PR, blocks force-push and deletion, and requires the `check`, `gitleaks` and `audit` CI jobs (plus `rules` from M1).
2. **Firebase:** new project → upgrade to Blaze → GCP Billing budget alerts at £5 and £10. Enable Google sign-in. Then follow **Firebase setup** below.
3. **Anthropic:** create API key at console.anthropic.com, set a monthly spend limit (e.g. £20).
4. **Reed:** free Jobseeker API key. **Adzuna:** free developer app_id + app_key.
5. **Gmail:** create labels `hireframe/alerts` and `hireframe/done` in the primary account; filters that label job-alert senders (LinkedIn, Wellfound, Work at a Startup, Escape the City, Welcome to the Jungle, Reed, Indeed alerts) `hireframe/alerts`. Keep the second account's filter that auto-forwards `from:jobalerts-noreply@linkedin.com` to the primary; Gmail keeps the original sender, so the primary's filter labels the forwarded copies too. Part G installs the bridge.
6. **Job alerts:** set up LinkedIn/Wellfound/WaaS/WTTJ alerts for the lane titles in `FUNNEL.md`, UK/London, daily.
7. Secrets go into Secret Manager via `firebase functions:secrets:set`. Never paste them into chat or code.

## Firebase setup
Project `hireframe-f6b03`, region **europe-west2 (London)**. Part A and Part B are M1; Part C adds Cloud Functions (M2); Part D adds the job sources (M3); Part E adds the funnel and the schedule (M4); Part F adds the dashboard data (M5); Part G adds the Gmail bridge (M6). Design: ADR-011 (owner allowlist), ADR-014 (deploy), ADR-017 (functions).

### Part A: before the first deploy
1. **Create Firestore.**
   1. Open the Firebase console → **Build → Firestore Database** → **Create database**.
   2. Pick the **Standard** edition and Database ID **(default)**.
   3. Location **europe-west2**. This can never be changed.
   4. Choose **production mode**.
2. **Create Storage.**
   1. Enable the Storage API. In the Google Cloud console, go to **APIs & Services → Library**, search for **Cloud Storage for Firebase API** (`firebasestorage.googleapis.com`) → **Enable**. The deploy service account can't enable APIs, by design.
   2. In the **Firebase** console, go to **Build → Storage** → **Get started** → location **europe-west2** → **production mode**.
   3. Create the bucket here, not in the Cloud Storage console. A bucket made there isn't linked to Firebase, and deploys fail with "Firebase Storage has not been set up".
3. **Register the web app.**
   1. Go to ⚙️ **Project settings → General → Your apps** → click the **</>** (Web) icon.
   2. Nickname `hireframe-web`, and **tick "Also set up Firebase Hosting"**. The app reads its config from Hosting's `/__/firebase/init.json`, so nothing needs copying.
4. **Check authorized domains and the OAuth client.**
   1. Go to **Authentication → Settings → Authorized domains**.
   2. Keep `hireframe-f6b03.web.app` and `hireframe-f6b03.firebaseapp.com`.
   3. Delete `localhost`: local dev uses the emulators.
   4. The app serves Google sign-in from its own host (ADR-012), so the Google OAuth client must also trust `web.app`. In the Google Cloud console, go to **APIs & Services → Credentials**, and under **OAuth 2.0 Client IDs** open **Web client (auto created by Google Service)**.
   5. Under **Authorized JavaScript origins**, add `https://hireframe-f6b03.web.app`.
   6. Under **Authorized redirect URIs**, add `https://hireframe-f6b03.web.app/__/auth/handler` → **Save**. It can take a few minutes to apply.
5. **Create the reCAPTCHA Enterprise key.**
   1. In the Google Cloud console, search for **reCAPTCHA** (enable the API if asked) → **Create key**.
   2. Name `hireframe-web`, platform **Website**.
   3. Domains: `hireframe-f6b03.web.app` and `hireframe-f6b03.firebaseapp.com`.
   4. Leave the **checkbox challenge off**.
   5. Copy the key ID. It's public, not a secret.
6. **Register App Check.** Go to **Build → App Check → Apps** → `hireframe-web` → **reCAPTCHA Enterprise** → paste the key ID → **Save**. **Don't enforce yet.**
7. **Run the deploy identity block in Cloud Shell.** Open Cloud Shell from the Cloud console (the **>_** icon) and paste the block below. It prints the WIF provider and deploy service account names; both are safe to share.
   ```bash
   PROJECT_ID=hireframe-f6b03
   REPO_ID=1396685327   # GitHub repo id for herbianalfa-cloud/hireframe (survives renames)
   gcloud config set project $PROJECT_ID
   PROJECT_NUMBER=$(gcloud projects describe $PROJECT_ID --format='value(projectNumber)')
   gcloud services enable iamcredentials.googleapis.com sts.googleapis.com
   gcloud iam service-accounts create github-deployer --display-name="GitHub Actions deployer"
   SA=github-deployer@$PROJECT_ID.iam.gserviceaccount.com
   for ROLE in roles/firebasehosting.admin roles/firebaserules.admin roles/datastore.indexAdmin \
               roles/firebase.viewer roles/serviceusage.serviceUsageConsumer; do
     gcloud projects add-iam-policy-binding $PROJECT_ID --member="serviceAccount:$SA" --role="$ROLE" --condition=None
   done
   gcloud iam workload-identity-pools create github --location=global --display-name="GitHub"
   gcloud iam workload-identity-pools providers create-oidc hireframe-repo --location=global \
     --workload-identity-pool=github --issuer-uri="https://token.actions.githubusercontent.com" \
     --attribute-mapping="google.subject=assertion.sub,attribute.repository_id=assertion.repository_id,attribute.ref=assertion.ref,attribute.environment=assertion.environment" \
     --attribute-condition="assertion.repository_id=='$REPO_ID' && assertion.ref.startsWith('refs/tags/v') && assertion.environment=='production'"
   gcloud iam service-accounts add-iam-policy-binding $SA --role=roles/iam.workloadIdentityUser \
     --member="principalSet://iam.googleapis.com/projects/$PROJECT_NUMBER/locations/global/workloadIdentityPools/github/attribute.repository_id/$REPO_ID"
   # Lets Storage rules read config/app (cross-service rules).
   gcloud projects add-iam-policy-binding $PROJECT_ID --condition=None \
     --member="serviceAccount:service-$PROJECT_NUMBER@gcp-sa-firebasestorage.iam.gserviceaccount.com" \
     --role="roles/firebaserules.firestoreServiceAgent"
   echo "WIF provider: projects/$PROJECT_NUMBER/locations/global/workloadIdentityPools/github/providers/hireframe-repo"
   echo "Deploy SA:    $SA"
   ```
8. **Set up the GitHub `production` environment.**
   - The owner is the required reviewer, and only `v*` tags may deploy.
   - Environment variables: `GCP_WIF_PROVIDER`, `GCP_DEPLOY_SA`, `VITE_RECAPTCHA_SITE_KEY`. None of these are secrets.

### Part B: first deploy and owner bootstrap
9. **Deploy.** Push tag `v0.1.0` → GitHub **Actions → Deploy → Review deployments → Approve**.
10. **Sign in.** Open `https://hireframe-f6b03.web.app` and sign in with Google. You'll see **"No access"**, which is expected: nobody has access until the next step.
11. **Copy your UID.** Go to **Authentication → Users**. There should be exactly one user, and it should be you. Copy the **User UID**.
12. **Create `config/app`.** Go to **Firestore → Data** → **Start collection** `config` → document ID `app` → add these fields, then save:

    | Field | Type | Value |
    |---|---|---|
    | `ownerUid` | string | your UID |
    | `schemaVersion` | number | `1` |
    | `createdAt` | timestamp | now |
    | `updatedAt` | timestamp | now |
13. **Check the owner view.** Reload the app: you should see the shell.
14. **Check a non-owner.** Sign in with a different Google account in a private window: it should show "No access" only. Then delete that user under **Authentication → Users**.
15. **Close sign-ups and account deletion.**
    1. Go to **Authentication → Settings → User actions**. On this project it's already there. On older projects it only appears after **Upgrade to Identity Platform**.
    2. Untick **Enable create (sign-up)** and **Enable deletion** → **Save**.
    3. A new account now gets "Sign-ups are closed". Deletion is off because the owner account couldn't be re-created while sign-ups are closed.
16. **Enforce App Check.**
    1. Go to **App Check → APIs**.
    2. When Cloud Firestore shows mostly *Verified* requests, **Enforce** it. Then do the same for Cloud Storage.
    3. Reload the app to confirm it still works.

### Part C: Functions (M2)
Before the first deploy with Cloud Functions (`v0.2.0`). Design: ADR-016 (`llm.call()`), ADR-017 (functions build and runtime), ADR-023 (Reset profile). Do these in **Cloud Shell** (the **>_** icon in the Google Cloud console). Every block is safe to paste as is; it prints nothing secret. The deploy account can't change IAM or enable APIs, by design, so everything here is done once by hand.

17. **Pick the project.** Run `gcloud config set project hireframe-f6b03`.
18. **Enable the Functions APIs.** The last three aren't used by the app, but the Firebase CLI checks them before a functions deploy and the deploy account can't enable them itself.
    ```bash
    gcloud services enable cloudfunctions.googleapis.com run.googleapis.com cloudbuild.googleapis.com \
      artifactregistry.googleapis.com secretmanager.googleapis.com firebaseappcheck.googleapis.com \
      eventarc.googleapis.com firebaseextensions.googleapis.com cloudbilling.googleapis.com
    ```
19. **Create the runtime account** the functions run as (instead of the default account, which has Editor):
    `gcloud iam service-accounts create hireframe-fns --display-name="Hireframe functions runtime"`
20. **Grant the runtime account its roles.** First find your bucket name: Firebase console → **Build → Storage**, the name after `gs://` (for example `hireframe-f6b03.firebasestorage.app`). Put it in the first line, then paste the block. `storage.objectUser` lets the functions read uploaded CVs and delete them for **Reset profile**. It's the narrowest built-in role that can delete (ADR-023).
    ```bash
    BUCKET=hireframe-f6b03.firebasestorage.app   # replace with the name from the console if different
    PROJECT_ID=hireframe-f6b03
    FNS=hireframe-fns@$PROJECT_ID.iam.gserviceaccount.com
    for ROLE in roles/datastore.user roles/firebaseappcheck.tokenVerifier; do
      gcloud projects add-iam-policy-binding $PROJECT_ID --member="serviceAccount:$FNS" --role="$ROLE" --condition=None
    done
    gcloud storage buckets add-iam-policy-binding gs://$BUCKET --member="serviceAccount:$FNS" --role=roles/storage.objectUser
    ```
21. **Check the Anthropic secret's name.** The key is already in Secret Manager. Run
    `gcloud secrets describe ANTHROPIC_API_KEY --format='value(name)'`
    It must print a path ending in `/secrets/ANTHROPIC_API_KEY` (exact spelling; the code reads that name). If it's spelled differently, create a new secret with this exact name rather than renaming (secrets can't be renamed).
22. **Let only the runtime account read the key.**
    ```bash
    PROJECT_ID=hireframe-f6b03
    FNS=hireframe-fns@$PROJECT_ID.iam.gserviceaccount.com
    gcloud secrets add-iam-policy-binding ANTHROPIC_API_KEY --member="serviceAccount:$FNS" \
      --role=roles/secretmanager.secretAccessor
    ```
23. **Give the deploy account its new roles.** Besides deploying as `hireframe-fns`, the deploy must be allowed to act as two Google-managed accounts. The Firebase CLI pre-checks the App Engine default account. Cloud Build builds the functions as the default compute account; M8 moves builds to their own account (ROADMAP).
    ```bash
    PROJECT_ID=hireframe-f6b03
    PROJECT_NUMBER=$(gcloud projects describe $PROJECT_ID --format='value(projectNumber)')
    SA=github-deployer@$PROJECT_ID.iam.gserviceaccount.com
    FNS=hireframe-fns@$PROJECT_ID.iam.gserviceaccount.com
    gcloud projects add-iam-policy-binding $PROJECT_ID --member="serviceAccount:$SA" --role=roles/cloudfunctions.developer --condition=None
    gcloud iam service-accounts add-iam-policy-binding $FNS --member="serviceAccount:$SA" --role=roles/iam.serviceAccountUser
    gcloud secrets add-iam-policy-binding ANTHROPIC_API_KEY --member="serviceAccount:$SA" --role=roles/secretmanager.viewer
    for TARGET in $PROJECT_ID@appspot.gserviceaccount.com $PROJECT_NUMBER-compute@developer.gserviceaccount.com; do
      gcloud iam service-accounts add-iam-policy-binding $TARGET \
        --member="serviceAccount:$SA" --role=roles/iam.serviceAccountUser
    done
    ```
24. **Create the image repository with a cleanup policy**, so the deploy doesn't stop to ask for one (ADR-017):
    ```bash
    cat > cleanup.json <<'JSON'
    [{"name": "firebase-functions-cleanup", "action": {"type": "Delete"}, "condition": {"tagState": "any", "olderThan": "86400s"}}]
    JSON
    gcloud artifacts repositories create gcf-artifacts --repository-format=docker --location=europe-west2 \
      --description="Cloud Functions images"
    gcloud artifacts repositories set-cleanup-policies gcf-artifacts --location=europe-west2 --policy=cleanup.json
    rm cleanup.json
    ```
    If `create` says the repository already exists, just run the `set-cleanup-policies` line.
25. **Check that Storage rules can read Firestore.** Storage rules read `config/app` to find the owner, which needs the Storage service agent to have `roles/firebaserules.firestoreServiceAgent`. Part A step 7 grants it, but on this project it was missing at the v0.2.1 deploy and had to be granted by hand. This should print the role once:
    ```bash
    PROJECT_ID=hireframe-f6b03
    PROJECT_NUMBER=$(gcloud projects describe $PROJECT_ID --format='value(projectNumber)')
    AGENT=service-$PROJECT_NUMBER@gcp-sa-firebasestorage.iam.gserviceaccount.com
    gcloud projects get-iam-policy $PROJECT_ID --flatten='bindings[].members' \
      --filter="bindings.role=roles/firebaserules.firestoreServiceAgent AND bindings.members:$AGENT" \
      --format='value(bindings.role)'
    ```
    If it prints nothing, grant it:
    `gcloud projects add-iam-policy-binding $PROJECT_ID --condition=None --member="serviceAccount:$AGENT" --role=roles/firebaserules.firestoreServiceAgent`
26. **Check the Anthropic limit.** In the Anthropic console, the monthly spend limit should still be set (One-time setup step 3).
27. **Deploy.** Merge the PR, push the tag, then **Actions → Deploy → Review deployments → Approve**. If it fails with a 403, see Recovery.
28. **Let the browser call each new callable** (once per callable, after its first deploy). The Firebase CLI tries to make a new callable publicly invocable, but the deploy account can't set IAM, so the function stays private. The browser then gets a 403, which shows as a CORS error. Public invocation is safe: every callable still enforces App Check and checks the owner UID.
    ```bash
    for FN in parseCv addFact resetProfile scanNow rescore ingestEmailJobs; do
      gcloud functions add-invoker-policy-binding $FN --region=europe-west2 --member=allUsers --project=hireframe-f6b03
    done
    ```
    Running it again for an existing callable changes nothing. When a later milestone adds a callable, add its name to this list. `ingestEmailJobs` (M6) is an HTTPS function, not a callable: Apps Script gets a 403 without this binding. Public invocation is safe, because the request's HMAC is checked first (Part G).
29. **Check the functions.** Firebase console → **Build → Functions**: `parseCv`, `addFact` and `resetProfile` (and `scanNow` from M3) are listed in `europe-west2`.
30. **Seed your criteria.** Open the app → **Criteria** → **Start from default criteria**. Change one value and save: it should say "Saved as version 2".
31. **Read your CV.** **Profile** → upload your master CV (PDF or .docx, up to 5 MB) and wait for the summary. You should see **at least 60 facts**, each stating one claim and showing where it came from.
32. **Check versioning.** Edit one fact, then open its **History**: v1 and v2 are both there. Add an **Evidence link** (https only) while you're there.
33. **Check the merge.**
    1. Upload the same file again: it says it's the same file, nothing is read, and `usage/{yyyy-mm}` doesn't change.
    2. Upload the same CV in the other format (.docx if you used PDF): the summary says 0 added and 0 flagged, or very close.
    3. To try a flagged change, upload a copy with one bullet reworded and **Accept change**: its history shows "Accepted proposed change".
34. **Check Remove upload** on the reworded copy from step 33: the dialog previews the counts, the row then shows **Removed**, and the facts it added are under **Archived**.
35. **Add a fact from a note**, for example "Finished a SQL course on window functions".
36. **Check the meter.** Firestore → `usage/{yyyy-mm}`: `spendPence` roughly matches the calls so far, and `reservations` is empty.

To change the cap or the exchange rate later, add `monthlyCapPence` (number, pence) or `fxUsdToGbp` (number) to `config/app` in the Firestore console (ADR-016).

**Upgrading a v0.2.1 project to v0.2.2.** Before tagging:
1. Run step 23 again; only the compute-account line is new.
2. Swap the runtime account's bucket role (replace the bucket name if yours differs):
   ```bash
   BUCKET=hireframe-f6b03.firebasestorage.app
   FNS=hireframe-fns@hireframe-f6b03.iam.gserviceaccount.com
   gcloud storage buckets add-iam-policy-binding gs://$BUCKET --member="serviceAccount:$FNS" --role=roles/storage.objectUser
   gcloud storage buckets remove-iam-policy-binding gs://$BUCKET --member="serviceAccount:$FNS" --role=roles/storage.objectViewer
   ```
3. Do step 25.

Then deploy (step 27), do step 28 for `resetProfile`, and steps 33–34. To clean up the duplicates from the v0.2.1 re-upload, use **Remove upload** on the second upload, or **Reset profile** (Profile → Danger zone) and upload once more.

### Part D: Sources (M3)
Before the `v0.3.0` deploy. Design: ADR-025 (robots.txt and keyed APIs), ADR-029 (ingest and `scanNow`), ADR-031 (watchlist). The Reed and Adzuna keys are already in Secret Manager.

**A. Reed terms (optional)**
37. If your Reed sign-up email or developer page shows API terms, paste **only** the clauses about rate limits, attribution and permitted use into the PR or chat. **Never paste the key.** Without them, ADR-025's conservative budget (≤ 30 calls per scan, ≤ 300 a day) stays the basis.

**B. Check the secrets and grant access** (Cloud Shell, the **>_** icon)
38. Check the exact names; the code reads these spellings. Each line should print a path ending in the secret's name:
    ```bash
    gcloud config set project hireframe-f6b03
    for S in REED_API_KEY ADZUNA_APP_ID ADZUNA_APP_KEY; do gcloud secrets describe $S --format='value(name)'; done
    ```
    If one is spelled differently, create a new secret with the exact name (secrets can't be renamed).
39. Let the functions read the keys, and let the deployer see them. Paste this block; it prints nothing secret.
    ```bash
    PROJECT_ID=hireframe-f6b03
    gcloud config set project $PROJECT_ID
    FNS=hireframe-fns@$PROJECT_ID.iam.gserviceaccount.com
    SA=github-deployer@$PROJECT_ID.iam.gserviceaccount.com
    for S in REED_API_KEY ADZUNA_APP_ID ADZUNA_APP_KEY; do
      gcloud secrets add-iam-policy-binding $S --member="serviceAccount:$FNS" --role=roles/secretmanager.secretAccessor
      gcloud secrets add-iam-policy-binding $S --member="serviceAccount:$SA" --role=roles/secretmanager.viewer
    done
    ```
40. *(Optional, for local live scans)* Add three lines to `functions/.secret.local` (gitignored): `REED_API_KEY=…`, `ADZUNA_APP_ID=…`, `ADZUNA_APP_KEY=…`.

**C. Curate the watchlist** (about 30–45 minutes; ADR-031)
41. Open `tmp/watchlist-candidates.csv` in a spreadsheet app. It's a draft of well-known London/UK B2B SaaS companies and startups, all unverified. Delete rows you don't want, add companies you know (name, domain, hq), and paste a careers or job-board link in `careersUrl` where you have one. Save as CSV.
42. In the terminal run `node scripts/detect-ats.ts tmp/watchlist-candidates.csv`. It asks only the official job-board APIs (Greenhouse, Lever, Ashby, Workable), 1 request per second per site, so it takes several minutes. It never opens careers pages.
43. Open `tmp/watchlist-review.csv`. Each row has a `status`:
    - `confirmed`: exactly one board with open jobs, and its own name matches the company exactly. `decision` is already `keep`.
    - `review`: a board was found, but its name can't be confirmed, or there's more than one. Click `board_url`, check it's the right company and that it hires in the UK, then type `keep` (use this board), `keep-none` (keep the company, no board) or `drop`.
    - `not-found`: no board. Type `keep-none` to keep the company for matching aggregator jobs, or leave it blank to leave it out.
    - `unchecked`: a probe failed (usually Workable rate-limiting, see `failed_probes`), so "no board" isn't known. Later, run `node scripts/detect-ats.ts --recheck tmp/watchlist-review.csv`: it re-detects only the unchecked rows and merges them in, keeping your decisions and any columns you added (the previous file is saved as `.bak`). Or decide the row yourself.
44. Run `node scripts/detect-ats.ts --write tmp/watchlist-review.csv`. It writes `packages/shared/src/watchlist-seed.ts`, or lists the rows that still need a decision. Commit the seed.

**D. Try it locally**
45. Run `npm run dev`, sign in as **Dev Owner**, open **System** and click **Scan now**. Every source runs against fake APIs. The fake Acme "Product Analyst" posting merges into the seeded LinkedIn-alert job, and Senior and Junior roles at the same company stay separate.
46. Click **Scan now** again straight away. It says the last scan finished moments ago and skips. After 30 seconds, scan again: **0 new**, everything counted as known.
47. *(Optional)* `LIVE=1 npm run dev` scans the real public boards with the real seed into the emulator. Nothing reaches production.

**E. Deploy `v0.3.0`**
48. Merge the PR, push tag `v0.3.0`, then **Actions → Deploy → Review deployments → Approve**.
49. **Let the browser call `scanNow`** (new callable). In Cloud Shell:
    `gcloud functions add-invoker-policy-binding scanNow --region=europe-west2 --member=allUsers --project=hireframe-f6b03`
    If the deploy job failed at the IAM step for `scanNow`, open that run in GitHub Actions and click **Re-run failed jobs** (approve again if asked).
50. Open the app on your phone → **System** → **Scan now**. It takes 1–3 minutes. Every source card should be **OK**, or show why not.
51. In Firestore, check `jobs` has documents with `stage: s0`, `runs` has one `succeeded` or `partial` run, and `sources/adzuna.quota.dayCount` is 20 or less.
52. If a source breaks later, add `disabledSources` (an array of strings, e.g. `adzuna`) to `config/app` in the console. It's off from the next scan, with no deploy.

### Part E: Funnel (M4)
Before the `v0.4.0` deploy. Design: ADR-032 (run budget), ADR-033 (S1 and work rights), ADR-034 (scores), ADR-035 (S3 and caching), ADR-036 (evals), ADR-037 (`scheduledScan` and `rescore`). Cloud Shell is the **>_** icon in the Google Cloud console; every block prints nothing secret.

**A. Before the deploy**
53. **Check your Anthropic rate limits.** console.anthropic.com → **Settings → Limits**. Note the requests per minute for Claude Haiku 4.5 and Claude Sonnet 5.5. The funnel starts at most 45 a minute on Haiku and 20 on Sonnet. If yours are lower, add `triageRpm` and `deepReadRpm` (numbers) to a `funnel` map in `config/app` (step 72), or tell Claude the numbers (never a key).
54. **Turn on Cloud Scheduler and let the deploy account create the schedule.** The deploy account can't enable APIs or change IAM, so paste this in Cloud Shell:
    ```bash
    PROJECT_ID=hireframe-f6b03
    gcloud config set project $PROJECT_ID
    gcloud services enable cloudscheduler.googleapis.com
    SA=github-deployer@$PROJECT_ID.iam.gserviceaccount.com
    gcloud projects add-iam-policy-binding $PROJECT_ID --condition=None \
      --member="serviceAccount:$SA" --role=roles/cloudscheduler.admin
    ```
55. **Check the Anthropic spend limit** is still set (One-time setup step 3). No new secrets are needed: the runtime account can already read all four keys.

**B. Label the golden set** (about 40 minutes, on your laptop)
56. In the repo folder, run `node scripts/eval-labels.ts export`. It writes `tmp/golden-labels.csv`.
57. Open `evals/README.md` and read the fake candidate's summary (Alex Example).
58. Open the CSV in a spreadsheet. For each row, type one of `apply`, `near_miss`, `wildcard`, `skip` in the `verdict` column, judged for that candidate. Add a short `note` if you like. Save as CSV.
59. Run `node scripts/eval-labels.ts import tmp/golden-labels.csv`. It lists the rows where your label differs from the case's design. Re-read those; keep yours if you still agree.
60. Make sure `functions/.secret.local` has `ANTHROPIC_API_KEY=…` (Local setup step 8). Never paste the key into chat.
61. Run `LIVE=1 npm run eval`. It costs about £0.40 and prints agreement, the confusion matrix and cost. If agreement is under 80%, the prompts or rubric need tuning, never your labels. Once it passes, run `npm run eval -- --update-baseline`, then commit `evals/golden.jsonl`, `evals/recordings.jsonl` and `evals/baseline.json` (or ask Claude to).

**C. Try it locally**
62. Run `npm run dev` and sign in as **Dev Owner**. The fake CV's facts and a work-rights setting are already seeded; **Profile → Work rights** shows the setting.
63. **System → Scan now.** The run row shows S1/S2/S3 counts and cost. In the emulator UI (http://127.0.0.1:4000 → Firestore → `jobs`), jobs have a `verdict`, a `reason` or a `skip.ruleId`.
64. **Criteria** → change one threshold → **Save** → **Re-score last 14 days**. It reports the jobs re-scored without AI; a `rescore` run appears on System, and re-judged jobs carry the new `criteriaVersion`.

**D. Deploy `v0.4.0`**
65. Merge the PR, push tag `v0.4.0`, then **Actions → Deploy → Review deployments → Approve**.
66. **Wait for the new indexes.** Firebase console → **Firestore → Indexes**: all three new indexes on `jobs` must say **Enabled** (a few minutes) before the first scan.
67. **Let the browser call `rescore`** (new callable):
    `gcloud functions add-invoker-policy-binding rescore --region=europe-west2 --member=allUsers --project=hireframe-f6b03`
68. **Let the scheduler start `scheduledScan`.** In Cloud Shell, bind the runtime account explicitly (it must be the only invoker, see Recovery):
    ```bash
    PROJECT_ID=hireframe-f6b03
    FNS=hireframe-fns@$PROJECT_ID.iam.gserviceaccount.com
    gcloud functions add-invoker-policy-binding scheduledScan --region=europe-west2 --member=serviceAccount:$FNS --project=$PROJECT_ID
    ```
    Then in the Google Cloud console open **Cloud Scheduler** (region europe-west2), open the job whose name contains `scheduledScan`, check that **Auth** shows `hireframe-fns`, and click **Force run**. Within 10 minutes the app's **System** screen shows a run marked "Scheduled". If the job's last result says `PERMISSION_DENIED`, the binding is missing (see Recovery).
69. In the app: **Profile → Work rights**. Pick yours (and the end date, if time-limited) and save. Until you do, right-to-work wording is flagged, never skipped.
70. On your phone: **System → Scan now**. It takes 3–8 minutes; check the stage counts and cost. In Firestore, `usage/{yyyy-mm}.reservations` is empty afterwards.
71. Next weekday after 07:30, check that a "Scheduled" run is there.
72. *(Optional)* To tune limits without a deploy, add a map `funnel` to `config/app` with any of `runBudgetPence`, `s1MaxJobs`, `s2MaxJobs`, `s3MaxJobs`, `triageRpm`, `deepReadRpm`, `reedHydratePerRun` (numbers). Raising `monthlyCapPence` raises the per-run budget automatically. An invalid map is ignored (and logged), never fatal.

### Part F: Dashboard data (M5, PR 2 session 1)
Before the `v0.5.0` deploy. Design: ADR-038 (job actions, feedback, agreement), ADR-025 addendum (attribution). This session adds data and services only; the screens come next.
73. **Run the rules tests.** In the repo folder, run `npm run test:rules` (needs Java 21). All tests pass, including `tests/rules/jobs.rules.test.ts`.
74. *(Optional)* **Choose the agreement window and target.** The defaults are 14 days and 85% (`AGREEMENT_DAYS`, `AGREEMENT_TARGET` in `packages/shared/src/metrics.ts`). Tell Claude if you want different ones.
75. **Before the `v0.5.0` deploy**, the six new `jobs` indexes build after deploy; the dashboard queries fail with "requires an index" until each says **Enabled** (Firestore → Indexes). The screens' own steps follow in the next session.

### Part G: Gmail bridge (M6, PR 6A)
Design: ADR-046 (transport and signing), ADR-047 (parsing), ADR-048 (the lock and needs-description). Do 76 to 78 before the `v0.6.0` tag, which is merged only **after the Wed 7 Oct 17:30 scheduled run has finished** (System shows it), so that run still measures the intake without alert volume. The rest follow the deploy.

76. **Create the HMAC secret** (G1), in Cloud Shell. Generate it there; never paste it into chat or a file in the repo:
    ```bash
    gcloud config set project hireframe-f6b03
    printf '%s' "$(openssl rand -hex 32)" | gcloud secrets create INGEST_HMAC_SECRET --data-file=- --replication-policy=automatic
    ```
    Then let only the runtime account read it, and the deployer see it (the Part C pattern):
    ```bash
    gcloud secrets add-iam-policy-binding INGEST_HMAC_SECRET --member=serviceAccount:hireframe-fns@hireframe-f6b03.iam.gserviceaccount.com --role=roles/secretmanager.secretAccessor
    gcloud secrets add-iam-policy-binding INGEST_HMAC_SECRET --member=serviceAccount:github-deployer@hireframe-f6b03.iam.gserviceaccount.com --role=roles/secretmanager.viewer
    ```
77. **Check the invoker on `scheduledScan`** (G2). The bundle changes, so the deploy rewrites the invoker unless it is exact (Recovery, and Part E step 68):
    ```bash
    gcloud scheduler jobs describe firebase-schedule-scheduledScan-europe-west2 --location=europe-west2 --format='value(schedule,timeZone,httpTarget.oidcToken.serviceAccountEmail)'
    gcloud run services get-iam-policy scheduledscan --region=europe-west2 --flatten='bindings[].members' --filter='bindings.role:roles/run.invoker' --format='value(bindings.members)'
    ```
    The first must print `30 7,17 * * 1-5`, `Europe/London` and `hireframe-fns@…`; the second **only** `serviceAccount:hireframe-fns@…`. Otherwise fix it with Recovery first.
78. **Merge and deploy** (G3), not before the Wed 7 Oct 17:30 run has finished: merge 6A, push `v0.6.0`, approve the deploy (Part C step 27).
79. **TTL policies** (G4). Firestore → **TTL** shows `nonces.expireAt` and `alertMessages.expireAt` as **Serving**. If either is missing (the deploy account can't always apply `fieldOverrides`):
    ```bash
    gcloud firestore fields ttls update expireAt --collection-group=nonces --enable-ttl
    gcloud firestore fields ttls update expireAt --collection-group=alertMessages --enable-ttl
    ```
    Until they exist, spent nonces and old message records accumulate; they are tiny and harmless (an expired nonce is rejected by its timestamp anyway).
80. **Invoker binding** (G5) for the new HTTPS function: Part C step 28's loop now includes `ingestEmailJobs`. Run it, or just this one:
    ```bash
    gcloud functions add-invoker-policy-binding ingestEmailJobs --region=europe-west2 --member=allUsers --project=hireframe-f6b03
    ```
    If the deploy failed with "Failed to set invoker function ingestEmailJobs", run this and re-run the deploy.
81. **Apps Script** (G6). In the repo folder: `npm run build:apps-script`, then `npm exec -w apps-script clasp login` (your Google account), `npm exec -w apps-script clasp -- create --type standalone --rootDir apps-script/build` once (it writes the gitignored `apps-script/.clasp.json`; the committed `.clasp.json.example` shows its shape), then `npm exec -w apps-script clasp -- push`. In the Apps Script editor: **Services → Gmail API** on. **Project Settings → Script Properties:** `HIREFRAME_INGEST_URL` (the function URL, from the Firebase console → Functions) and `HIREFRAME_HMAC_SECRET`. For the secret, in Cloud Shell run `gcloud secrets versions access latest --secret=INGEST_HMAC_SECRET` and copy it straight into the property; don't paste it anywhere else. Run `setup` once and accept the scopes (read and change mail labels, send to external services, manage triggers). Run `run` once by hand.
82. **Gmail labels and filters** (G7). The labels `hireframe/alerts` and `hireframe/done` exist in the primary account (One-time setup step 5). A filter `from:jobalerts-noreply@linkedin.com` → apply `hireframe/alerts`, plus one for each other alert sender you use. On the second account, keep the filter that auto-forwards LinkedIn alerts to the primary.
83. **Check it** (G8). Label one real alert `hireframe/alerts` and run `run` in the editor. **System → Sources → Gmail alerts** shows the ingest (emails, jobs new and merged), and the message is under `hireframe/done`. After the next scan, those jobs have been through S1 and S2, and the LinkedIn ones end at **Waiting for a description** (the count is on System next to Jobs stored). If a message stays under `hireframe/alerts`, see Recovery.

### Recovery
- **Locked out after bootstrap** (typo in `ownerUid`): fix `config/app.ownerUid` in the Firestore console. Console edits bypass the rules.
- **App breaks right after enforcing App Check:** go to **App Check → APIs** → **Unenforce**, then check the site key and domains in the reCAPTCHA key.
- **Deploy fails with 403:** the `github-deployer` service account is missing a role. Grant the role named in the error with `gcloud projects add-iam-policy-binding` (never use a key file).
- **Deploy fails with "Firebase Storage has not been set up":** enable the API and create the bucket from the Firebase console (Part A step 2).
- **Google sign-in shows "Error 400: redirect_uri_mismatch":** the OAuth client is missing the `web.app` origin or redirect URI (Part A step 4).
- **Owner account lost or deleted:** briefly tick **Enable create (sign-up)**, then sign in. Set `config/app.ownerUid` to the new UID, then untick sign-up again.
- **Functions deploy stops with "could not set up cleanup policy":** the functions deployed, but the image repository has no cleanup policy. Do Part C step 24, then re-run the deploy.
- **Functions deploy fails with 403 on `iam.serviceAccounts.actAs` or a secret:** the deploy account is missing a role from Part C step 23. The error names the account it couldn't act as: the App Engine default, the default compute account, or `hireframe-fns`.
- **Functions deploy fails because an API is disabled** (eventarc, firebaseextensions, cloudbilling): enable it with Part C step 18.
- **A callable fails in the browser with a CORS error or 403:** it isn't publicly invocable yet. Do Part C step 28 for it.
- **Reset profile fails, and the logs show 403 on `storage.objects.delete`:** the runtime account still has `storage.objectViewer` instead of `storage.objectUser`. See "Upgrading a v0.2.1 project" in Part C.
- **The Storage rules deploy asks to grant `firebaserules.firestoreServiceAgent`, or the owner gets "permission denied" on uploads:** do the Part C step 25 check.
- **A source card shows Failing or Degraded:** its "Why" line names the cause. `a board no longer exists`: fix that company's `ats.token` in `companies/{id}` or set `watch` to false (boards missing 3 scans in a row are listed under **Broken job boards**). `the site asked us to slow down`: wait for the next scan; Adzuna's daily quota resets at midnight UK time. `robots.txt does not allow it` or a changed response shape: switch the source off with `disabledSources` and open an issue.
- **A source card says "Paused until <time>":** that site sent a long Retry-After (a rate limit), so scans skip it until then and it resumes on its own. If it keeps happening, switch the source off with `disabledSources` for a while.
- **Scan now says "A scan is already running"** long after the last one: a scan that died leaves `locks/scan` for 12 minutes, then the next scan takes over. "Importing alerts, try again in a minute" is the Gmail bridge holding the lock, which a killed ingest keeps for at most 3 minutes.
- **The Gmail bridge isn't ingesting** (System → Gmail alerts shows an old "Last ingest", or none): open the Apps Script project → **Executions**. A `run` that failed with a Script Property error is a missing `HIREFRAME_INGEST_URL` or `HIREFRAME_HMAC_SECRET` (Part G step 81); "label does not exist" is a missing Gmail label. A **403** from the function means the invoker binding is missing (step 80). A **401** means the secrets differ: set the script property to the secret's current value (`gcloud secrets versions access latest --secret=INGEST_HMAC_SECRET` in Cloud Shell); a 401 only on some runs can also be the trigger's clock being more than 5 minutes off. A **503 `busy`** is a scan or another ingest holding the lock; the next trigger retries, nothing is lost. The 30-minute trigger is gone after a project copy: run `setup` again.
- **System shows "Gmail alerts" Failing or Degraded, "some alert emails could not be read":** a sender changed its layout (the Unread count and the sender table say which). LinkedIn emails with job links but no readable card are counted, relabelled `hireframe/done` and not guessed. Send Claude a real alert with the values replaced by fake ones (never the raw email) so the parser and its fixture can be updated.
- **"…waiting for the daily AI limit":** alert emails from senders other than LinkedIn are read with the cheap model, capped at 10p a day (`config/app.alerts.dailyCapPence` overrides it). Over the cap they stay under `hireframe/alerts` and are tried again on the next trigger, so they catch up the next day.
- **Deploy fails with 403 on a Reed or Adzuna secret:** Part D step 39 hasn't run.
- **`scheduledScan` never runs, or Cloud Scheduler shows `PERMISSION_DENIED`:** the scheduler's service account can't invoke the function. Do Part E step 68. If the deploy failed creating the schedule, do Part E step 54 and re-run the deploy.
- **A new scheduled function has no schedule after its first deploy** (the deploy said "Failed to set invoker function <fn>", and a re-run says "Skipped (No changes detected)"). The Firebase CLI sets the function's invoker before it creates the Cloud Scheduler job. The deploy account can't set IAM, so the job is never created, and later deploys skip the unchanged function. In Cloud Shell:
  ```bash
  PROJECT_ID=hireframe-f6b03; REGION=europe-west2; FN=scheduledScan
  FNS=hireframe-fns@$PROJECT_ID.iam.gserviceaccount.com
  gcloud config set project $PROJECT_ID
  gcloud functions add-invoker-policy-binding $FN --region=$REGION --member=serviceAccount:$FNS
  URI=$(gcloud functions describe $FN --region=$REGION --gen2 --format='value(serviceConfig.uri)')
  gcloud scheduler jobs create http firebase-schedule-$FN-$REGION --location=$REGION --schedule='30 7,17 * * 1-5' --time-zone='Europe/London' --uri="$URI" --http-method=POST --oidc-service-account-email=$FNS --attempt-deadline=540s --max-retry-attempts=0
  gcloud scheduler jobs run firebase-schedule-$FN-$REGION --location=$REGION
  ```
  - Use exactly this job name, so later deploys update the job.
  - The schedule must match `SCHEDULE` in `functions/src/config.ts`.
  - The invoker must be **only** `hireframe-fns`. Any other member makes every later deploy that changes the function fail before it updates the schedule. Remove extras with `gcloud functions remove-invoker-policy-binding`.
  - Within 10 minutes, **System** shows a "Scheduled" run.
- **A scan fails with `FAILED_PRECONDITION` and "requires an index":** the funnel's indexes are still building or weren't deployed. Wait until **Firestore → Indexes** shows them Enabled (Part E step 66), then scan again.
- **Jobs stuck "for review":** the model's output was unusable after a retry (`jobs.review.code`: `refusal`, `max_tokens` or `schema`). Re-score picks them up again; if one keeps failing, open an issue with the job ID (never paste the posting into chat).
- **Runs keep stopping early with "run budget used":** System shows a reason per stage (Triage, Deep reads). A stage stops on the budget only when its next call can't fit even with nothing in flight, so the backlog is larger than one run's lease. It catches up over a few runs. To go faster, raise `config/app.monthlyCapPence` or set `config/app.funnel.runBudgetPence` (Part E step 72).
- **CI fails with "recordings stale":** a prompt, schema or golden case changed. Run `LIVE=1 npm run eval` locally and commit `evals/recordings.jsonl` (`evals/README.md`).
- **"The monthly AI spend cap has been reached":** check `usage/{yyyy-mm}` in Firestore. Raise `config/app.monthlyCapPence` deliberately, or wait for next month. Stale `reservations` entries expire on their own after 15 minutes.

## Local setup (per machine)
1. **Node 22:** run `nvm use` (it reads `.nvmrc`). `.npmrc` sets `engine-strict`, so other versions fail fast.
2. **gitleaks:** `brew install gitleaks`. The pre-commit hook is fail-closed: without gitleaks, commits are blocked.
3. **Java 21** (for the Firebase emulators): `brew install openjdk@21`.
4. **Install:** `npm ci` installs dependencies and the husky git hooks.
5. **Check:** `npm run check` must be clean before every PR. `npm run test:rules` runs the rules tests on the emulators.
6. **Run the app:** `npm run dev` builds the functions, starts the emulators (project `demo-hireframe`, UI on http://127.0.0.1:4000, including Functions) and the app on http://127.0.0.1:5173. Criteria v1 is seeded.
   - In the Google pop-up, pick **Dev Owner** to see the shell.
   - Pick **Add new account** to see "No access".
   - Nothing touches production. CV reading and "Add a fact" use a fake model, which always returns the fake CV's facts. The fake CV's facts and a work-rights setting are seeded. **System → Scan now** uses fake job APIs, a fake watchlist and one seeded LinkedIn-alert job, then runs the funnel on the fake model.
7. **Fake CVs to upload:** `node scripts/make-cv-fixtures.ts` writes `tmp/fixtures/fake-cv.pdf`, `fake-cv.docx` and a `fake-cv-revised` pair (one reworded bullet, to try **Accept change**).
8. **Real model and real job APIs locally (the model costs money):** put `ANTHROPIC_API_KEY=<key>` in `functions/.secret.local` (gitignored), plus `REED_API_KEY`, `ADZUNA_APP_ID` and `ADZUNA_APP_KEY` for those sources, then run `LIVE=1 npm run dev`. Only upload fake CVs. Live scans count against the Reed and Adzuna quotas.

## Building with Claude Code
Open the repo in Claude Code and start with:
> Read CLAUDE.md and every file in docs/. Summarise the plan back to me in 10 lines and list anything ambiguous or risky. Then plan milestone M0 in plan mode. Don't write code until I approve the plan.

Per milestone: "Plan M{n}" → review → approve → build → PR → you test locally (`npm run dev`) → merge → tag if release.

## Daily operation
- Morning: read digest (≤ 20 min). Apply to Apply-verdict jobs; 👍/👎 anything that looks wrong.
- Evening run adds more; check Today when convenient.
- Friday: glance at System (source health, spend) and Near misses for criteria tweaks.

## Incidents
| Symptom | Check | Fix |
|---|---|---|
| No digest | System → last run | Re-run with "Scan now"; check Apps Script executions log |
| Source shows red | Run log errors | Endpoint changed or rate-limited → fix module; run continues without it |
| Spend near cap | usage/{month} | Tighten S1 rules or lower S3 per-run cap; raise cap deliberately |
| Verdicts feel wrong | 👎 notes, eval report | Adjust criteria or rubric; add cases to golden set; re-run eval before deploy |
| Bad deploy | — | `firebase hosting:rollback`; redeploy functions from previous tag |
| Owner sees "No access" | Authentication → Users UID vs `config/app.ownerUid` | Fix `ownerUid` in the Firestore console (see Recovery) |
| Suspected key leak | GitHub alert | Rotate key immediately, update Secret Manager, purge from history |
| Personal data committed | `npm run scan:pii`, review | Remove it; if pushed, rewrite history as in ADR-010 and ask GitHub Support to purge cached commit views |
