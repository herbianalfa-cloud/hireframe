# Runbook

## One-time setup (user)
1. **GitHub:** create public repo `hireframe`, push this docs pack. Enable secret scanning + push protection, Dependabot, branch protection on `main` (PR required now; add required status checks after M0 CI has run once). *Done:* ruleset `protect-main` requires a PR, blocks force-push and deletion, and requires the `check`, `gitleaks` and `audit` CI jobs (plus `rules` from M1).
2. **Firebase:** new project → upgrade to Blaze → GCP Billing budget alerts at £5 and £10. Enable Google sign-in. Then follow **Firebase setup** below.
3. **Anthropic:** create API key at console.anthropic.com, set a monthly spend limit (e.g. £20).
4. **Reed:** free Jobseeker API key. **Adzuna:** free developer app_id + app_key.
5. **Gmail:** create labels `hireframe/alerts` and `hireframe/done`; filters that label job-alert senders (LinkedIn, Wellfound, Work at a Startup, Welcome to the Jungle, Reed, Indeed alerts).
6. **Job alerts:** set up LinkedIn/Wellfound/WaaS/WTTJ alerts for the lane titles in `FUNNEL.md`, UK/London, daily.
7. Secrets go into Secret Manager via `firebase functions:secrets:set`. Never paste them into chat or code.

## Firebase setup
Project `hireframe-f6b03`, region **europe-west2 (London)**. Part A and Part B are M1; Part C adds Cloud Functions (M2). Design: ADR-011 (owner allowlist), ADR-014 (deploy), ADR-017 (functions).

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
    for FN in parseCv addFact resetProfile; do
      gcloud functions add-invoker-policy-binding $FN --region=europe-west2 --member=allUsers
    done
    ```
    Running it again for an existing callable changes nothing. When a later milestone adds a callable, add its name to this list.
29. **Check the functions.** Firebase console → **Build → Functions**: `parseCv`, `addFact` and `resetProfile` are listed in `europe-west2`.
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
   - Nothing touches production. CV reading and "Add a fact" use a fake model, which always returns the fake CV's facts.
7. **Fake CVs to upload:** `node scripts/make-cv-fixtures.ts` writes `tmp/fixtures/fake-cv.pdf`, `fake-cv.docx` and a `fake-cv-revised` pair (one reworded bullet, to try **Accept change**).
8. **Real model locally (costs money):** put `ANTHROPIC_API_KEY=<key>` in `functions/.secret.local` (gitignored), then run `LIVE=1 npm run dev`. Only upload fake CVs.

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
