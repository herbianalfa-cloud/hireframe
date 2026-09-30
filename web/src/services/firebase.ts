import { initializeApp, type FirebaseApp } from 'firebase/app';
import { initializeAppCheck, ReCaptchaEnterpriseProvider } from 'firebase/app-check';
import { connectAuthEmulator, getAuth, type Auth } from 'firebase/auth';
import { connectFirestoreEmulator, getFirestore, type Firestore } from 'firebase/firestore';
import { connectFunctionsEmulator, getFunctions, type Functions } from 'firebase/functions';
import { connectStorageEmulator, getStorage, type FirebaseStorage } from 'firebase/storage';
import { z } from 'zod';

import { isTransient, withRetry, withTimeout } from './resilience';

/**
 * Firebase bootstrap (ADR-012, ADR-013). Components never import this; they use the
 * other services.
 * - Dev (`vite` dev server): the `demo-hireframe` project on the local emulators, no App Check.
 *   A `demo-*` project cannot reach real Firebase resources.
 * - Prod (Firebase Hosting): config comes from the reserved `/__/firebase/init.json`, so no
 *   Firebase config lives in the repo or CI. App Check uses reCAPTCHA Enterprise.
 */
export interface FirebaseServices {
  app: FirebaseApp;
  auth: Auth;
  db: Firestore;
  storage: FirebaseStorage;
  functions: Functions;
}

export const DEMO_PROJECT_ID = 'demo-hireframe';
const EMULATOR_HOST = '127.0.0.1';
/** Callables run in London (ADR-014, ADR-017). */
export const FUNCTIONS_REGION = 'europe-west2';

const HostingConfigSchema = z.object({
  apiKey: z.string().min(1),
  appId: z.string().min(1),
  projectId: z.string().min(1),
  authDomain: z.string().min(1),
  storageBucket: z.string().min(1).exactOptional(),
  messagingSenderId: z.string().min(1).exactOptional(),
});

let services: Promise<FirebaseServices> | undefined;

export function getFirebase(): Promise<FirebaseServices> {
  services ??= (import.meta.env.DEV ? initEmulators() : initHosted()).catch((error: unknown) => {
    services = undefined; // allow a retry from the UI
    throw error;
  });
  return services;
}

function initEmulators(): Promise<FirebaseServices> {
  const app = initializeApp({
    projectId: DEMO_PROJECT_ID,
    apiKey: 'demo-api-key',
    appId: 'demo-app',
    // Required by pop-up sign-in; the Auth emulator serves the handler itself.
    authDomain: `${DEMO_PROJECT_ID}.firebaseapp.com`,
  });
  const auth = getAuth(app);
  const db = getFirestore(app);
  // Without a bucket name the Storage SDK has nothing to address; the emulator accepts any.
  const storage = getStorage(app, `gs://${DEMO_PROJECT_ID}.appspot.com`);
  const functions = getFunctions(app, FUNCTIONS_REGION);
  connectAuthEmulator(auth, `http://${EMULATOR_HOST}:9099`, { disableWarnings: true });
  connectFirestoreEmulator(db, EMULATOR_HOST, 8080);
  connectStorageEmulator(storage, EMULATOR_HOST, 9199);
  connectFunctionsEmulator(functions, EMULATOR_HOST, 5001);
  return Promise.resolve({ app, auth, db, storage, functions });
}

async function fetchHostingConfig(): Promise<z.infer<typeof HostingConfigSchema>> {
  const response = await withRetry(
    async () => {
      const res = await withTimeout(fetch('/__/firebase/init.json'), 5000, 'init.json');
      if (!res.ok)
        throw Object.assign(new Error(`init.json ${String(res.status)}`), { code: 'unavailable' });
      return res;
    },
    { label: 'firebase.init_json', isRetryable: isTransient },
  );
  return HostingConfigSchema.parse(await response.json());
}

async function initHosted(): Promise<FirebaseServices> {
  const siteKey = import.meta.env.VITE_RECAPTCHA_SITE_KEY;
  if (!siteKey) throw new Error('VITE_RECAPTCHA_SITE_KEY is not set for this build');

  const config = await fetchHostingConfig();
  // Serve the auth handler from our own host so sign-in works without third-party storage.
  const app = initializeApp({ ...config, authDomain: window.location.host });
  initializeAppCheck(app, {
    provider: new ReCaptchaEnterpriseProvider(siteKey),
    isTokenAutoRefreshEnabled: true,
  });
  return {
    app,
    auth: getAuth(app),
    db: getFirestore(app),
    storage: getStorage(app),
    functions: getFunctions(app, FUNCTIONS_REGION),
  };
}
