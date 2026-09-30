# Runbook

## One-time setup (user)
1. **GitHub:** create public repo `hireframe`, push this docs pack. Enable secret scanning + push protection, Dependabot, branch protection on `main` (PR required now; add required status checks after M0 CI has run once). *Done:* ruleset `protect-main` requires a PR, blocks force-push and deletion, and requires the `check`, `gitleaks` and `audit` CI jobs (plus `rules` from M1).
2. **Firebase:** new project → upgrade to Blaze → GCP Billing budget alerts at £5 and £10. Enable Google sign-in. Then follow **Firebase setup (M1)** below.
3. **Anthropic:** create API key at console.anthropic.com, set a monthly spend limit (e.g. £20).
4. **Reed:** free Jobseeker API key. **Adzuna:** free developer app_id + app_key.
5. **Gmail:** create labels `hireframe/alerts` and `hireframe/done`; filters that label job-alert senders (LinkedIn, Wellfound, Work at a Startup, Welcome to the Jungle, Reed, Indeed alerts).
6. **Job alerts:** set up LinkedIn/Wellfound/WaaS/WTTJ alerts for the lane titles in `FUNNEL.md`, UK/London, daily.
7. Secrets go into Secret Manager via `firebase functions:secrets:set`. Never paste them into chat or code.

## Firebase setup (M1)
Project `hireframe-f6b03`, region **europe-west2 (London)**. Design: ADR-011 (owner allowlist), ADR-014 (deploy).

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

### Recovery
- **Locked out after bootstrap** (typo in `ownerUid`): fix `config/app.ownerUid` in the Firestore console. Console edits bypass the rules.
- **App breaks right after enforcing App Check:** go to **App Check → APIs** → **Unenforce**, then check the site key and domains in the reCAPTCHA key.
- **Deploy fails with 403:** the `github-deployer` service account is missing a role. Grant the role named in the error with `gcloud projects add-iam-policy-binding` (never use a key file).
- **Deploy fails with "Firebase Storage has not been set up":** enable the API and create the bucket from the Firebase console (Part A step 2).
- **Google sign-in shows "Error 400: redirect_uri_mismatch":** the OAuth client is missing the `web.app` origin or redirect URI (Part A step 4).
- **Owner account lost or deleted:** briefly tick **Enable create (sign-up)**, then sign in. Set `config/app.ownerUid` to the new UID, then untick sign-up again.

## Local setup (per machine)
1. **Node 22:** run `nvm use` (it reads `.nvmrc`). `.npmrc` sets `engine-strict`, so other versions fail fast.
2. **gitleaks:** `brew install gitleaks`. The pre-commit hook is fail-closed: without gitleaks, commits are blocked.
3. **Java 21** (for the Firebase emulators): `brew install openjdk@21`.
4. **Install:** `npm ci` installs dependencies and the husky git hooks.
5. **Check:** `npm run check` must be clean before every PR. `npm run test:rules` runs the rules tests on the emulators.
6. **Run the app:** `npm run dev` starts the emulators (project `demo-hireframe`, UI on http://127.0.0.1:4000) and the app on http://127.0.0.1:5173.
   - In the Google pop-up, pick **Dev Owner** to see the shell.
   - Pick **Add new account** to see "No access".
   - Nothing touches production.

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
