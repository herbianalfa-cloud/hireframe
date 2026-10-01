import { initializeApp, type FirebaseApp } from 'firebase/app';
import { initializeAppCheck, ReCaptchaEnterpriseProvider } from 'firebase/app-check';
import { connectAuthEmulator, getAuth, type Auth } from 'firebase/auth';
import { connectFirestoreEmulator, getFirestore, type Firestore } from 'firebase/firestore';
import type { Functions } from 'firebase/functions';
import type { FirebaseStorage } from 'firebase/storage';
import { FUNCTIONS_REGION } from '@hireframe/shared';
import { z } from 'zod';

import { isTransient, withRetry, withTimeout } from './resilience';

/**
 * Firebase bootstrap (ADR-012, ADR-013). Components never import this; they use the
 * other services.
 * - Dev (`vite` dev server): the `demo-hireframe` project on the local emulators, no App Check.
 *   A `demo-*` project cannot reach real Firebase resources.
 * - Prod (Firebase Hosting): config comes from the reserved `/__/firebase/init.json`, so no
 *   Firebase config lives in the repo or CI. App Check uses reCAPTCHA Enterprise.
 * Functions and Storage load on first use (ADR-021), so the app shell doesn't ship their SDKs.
 */
export interface FirebaseServices {
  app: FirebaseApp;
  auth: Auth;
  db: Firestore;
}

export const DEMO_PROJECT_ID = 'demo-hireframe';
const EMULATOR_HOST = '127.0.0.1';

const HostingConfigSchema = z.object({
  apiKey: z.string().min(1),
  appId: z.string().min(1),
  projectId: z.string().min(1),
  authDomain: z.string().min(1),
  storageBucket: z.string().min(1).exactOptional(),
  messagingSenderId: z.string().min(1).exactOptional(),
});

let services: Promise<FirebaseServices> | undefined;
let functionsClient: Promise<Functions> | undefined;
let storageClient: Promise<FirebaseStorage> | undefined;

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
  connectAuthEmulator(auth, `http://${EMULATOR_HOST}:9099`, { disableWarnings: true });
  connectFirestoreEmulator(db, EMULATOR_HOST, 8080);
  return Promise.resolve({ app, auth, db });
}

/** Callables client in London (ADR-017), loaded on first use. */
export function getFunctionsClient(): Promise<Functions> {
  functionsClient ??= Promise.all([getFirebase(), import('firebase/functions')])
    .then(([{ app }, sdk]) => {
      const functions = sdk.getFunctions(app, FUNCTIONS_REGION);
      if (import.meta.env.DEV) sdk.connectFunctionsEmulator(functions, EMULATOR_HOST, 5001);
      return functions;
    })
    .catch((error: unknown) => {
      functionsClient = undefined;
      throw error;
    });
  return functionsClient;
}

/** Storage client, loaded on first use. */
export function getStorageClient(): Promise<FirebaseStorage> {
  storageClient ??= Promise.all([getFirebase(), import('firebase/storage')])
    .then(([{ app }, sdk]) => {
      if (!import.meta.env.DEV) return sdk.getStorage(app);
      // Without a bucket name the Storage SDK has nothing to address; the emulator accepts any.
      const storage = sdk.getStorage(app, `gs://${DEMO_PROJECT_ID}.appspot.com`);
      sdk.connectStorageEmulator(storage, EMULATOR_HOST, 9199);
      return storage;
    })
    .catch((error: unknown) => {
      storageClient = undefined;
      throw error;
    });
  return storageClient;
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
  return { app, auth: getAuth(app), db: getFirestore(app) };
}
