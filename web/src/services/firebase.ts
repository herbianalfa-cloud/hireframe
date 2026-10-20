import { initializeApp, type FirebaseApp } from 'firebase/app';
import {
  initializeAppCheck,
  onTokenChanged,
  ReCaptchaEnterpriseProvider,
  type AppCheck,
} from 'firebase/app-check';
import { connectAuthEmulator, getAuth, type Auth } from 'firebase/auth';
import type { Firestore } from 'firebase/firestore';
import type { Functions } from 'firebase/functions';
import type { FirebaseStorage } from 'firebase/storage';
import { FUNCTIONS_REGION } from '@hireframe/shared';
import { z } from 'zod';

import { markOnce } from '@/lib/perf';

import type * as FirestoreBoot from './firestore-boot';
import { isTransient, withRetry, withTimeout } from './resilience';

/**
 * Firebase bootstrap (ADR-012, ADR-013). Components never import this; they use the
 * other services.
 * - Dev (`vite` dev server): the `demo-hireframe` project on the local emulators, no App Check.
 *   A `demo-*` project cannot reach real Firebase resources.
 * - Prod (Firebase Hosting): config comes from the reserved `/__/firebase/init.json`, so no
 *   Firebase config lives in the repo or CI. App Check uses reCAPTCHA Enterprise.
 * Functions and Storage load on first use (ADR-021), so the app shell doesn't ship their SDKs.
 * Firestore loads once the core (app, App Check, Auth) is up (ADR-066), so its chunk is not in
 * the initial JS. `getFirebaseCore` never waits for it; `getFirebase` does.
 */
export interface FirebaseCore {
  app: FirebaseApp;
  auth: Auth;
}

export interface FirebaseServices extends FirebaseCore {
  app: FirebaseApp;
  auth: Auth;
  db: Firestore;
}

export const DEMO_PROJECT_ID = 'demo-hireframe';
const EMULATOR_HOST = '127.0.0.1';

/**
 * A CV download, the `cvs` read and the file together. Without it a blocked or stalled download
 * kept the Storage SDK retrying for minutes with the button spinning (the live bucket had no CORS
 * setting on 12 Oct 2026). The Storage client's own retry window is set to the same value.
 */
export const DOWNLOAD_TIME_LIMIT_MS = 30_000;

const HostingConfigSchema = z.object({
  apiKey: z.string().min(1),
  appId: z.string().min(1),
  projectId: z.string().min(1),
  authDomain: z.string().min(1),
  storageBucket: z.string().min(1).exactOptional(),
  messagingSenderId: z.string().min(1).exactOptional(),
});

let core: Promise<FirebaseCore> | undefined;
let services: Promise<FirebaseServices> | undefined;
let firestoreBoot: Promise<typeof FirestoreBoot> | undefined;
let functionsClient: Promise<Functions> | undefined;
let storageClient: Promise<FirebaseStorage> | undefined;

/** App, App Check and Auth: everything but Firestore. Marks `hf:firebase`. */
export function getFirebaseCore(): Promise<FirebaseCore> {
  core ??= (import.meta.env.DEV ? initEmulators() : initHosted()).then(
    (ready) => {
      markOnce('hf:firebase');
      return ready;
    },
    (error: unknown) => {
      core = undefined; // allow a retry from the UI
      throw error;
    },
  );
  return core;
}

/** The Firestore boot module (and with it the `firestore` chunk), imported once. */
export function loadFirestoreBoot(): Promise<typeof FirestoreBoot> {
  firestoreBoot ??= import('./firestore-boot').catch((error: unknown) => {
    firestoreBoot = undefined; // the next call imports again
    throw error;
  });
  return firestoreBoot;
}

/**
 * The core plus Firestore. The Firestore import starts when the core is ready, so its evaluation
 * overlaps Auth's restore request instead of competing with the core's own start (ADR-066). A
 * failed import resets only this promise; the core stays resolved.
 */
export function getFirebase(): Promise<FirebaseServices> {
  services ??= getFirebaseCore()
    .then(async (ready) => {
      const boot = await loadFirestoreBoot();
      const db = boot.connectDb(ready.app);
      markOnce('hf:firestore');
      return { ...ready, db };
    })
    .catch((error: unknown) => {
      services = undefined;
      throw error;
    });
  return services;
}

function initEmulators(): Promise<FirebaseCore> {
  const app = initializeApp({
    projectId: DEMO_PROJECT_ID,
    apiKey: 'demo-api-key',
    appId: 'demo-app',
    // Required by pop-up sign-in; the Auth emulator serves the handler itself.
    authDomain: `${DEMO_PROJECT_ID}.firebaseapp.com`,
  });
  const auth = getAuth(app);
  connectAuthEmulator(auth, `http://${EMULATOR_HOST}:9099`, { disableWarnings: true });
  return Promise.resolve({ app, auth });
}

/** Callables client in London (ADR-017), loaded on first use. */
export function getFunctionsClient(): Promise<Functions> {
  functionsClient ??= Promise.all([getFirebaseCore(), import('firebase/functions')])
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

/**
 * Downloads and deletes retry for 2 minutes by default, which made a blocked download spin for
 * minutes. Uploads have their own, longer window (`maxUploadRetryTime`).
 */
export function withDownloadLimit(storage: FirebaseStorage): FirebaseStorage {
  storage.maxOperationRetryTime = DOWNLOAD_TIME_LIMIT_MS;
  return storage;
}

/** Storage client, loaded on first use. */
export function getStorageClient(): Promise<FirebaseStorage> {
  storageClient ??= Promise.all([getFirebaseCore(), import('firebase/storage')])
    .then(([{ app }, sdk]) => {
      if (!import.meta.env.DEV) return withDownloadLimit(sdk.getStorage(app));
      // Without a bucket name the Storage SDK has nothing to address; the emulator accepts any.
      const storage = sdk.getStorage(app, `gs://${DEMO_PROJECT_ID}.appspot.com`);
      sdk.connectStorageEmulator(storage, EMULATOR_HOST, 9199);
      return withDownloadLimit(storage);
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

/** Marks `hf:appcheck` at the first token callback, then stops listening. */
function markOnFirstAppCheckToken(appCheck: AppCheck): void {
  const state: { unsubscribe?: () => void; done: boolean } = { done: false };
  const first = () => {
    markOnce('hf:appcheck');
    state.done = true;
    state.unsubscribe?.();
  };
  state.unsubscribe = onTokenChanged(appCheck, first, first);
  if (state.done) state.unsubscribe();
}

async function initHosted(): Promise<FirebaseCore> {
  const siteKey = import.meta.env.VITE_RECAPTCHA_SITE_KEY;
  if (!siteKey) throw new Error('VITE_RECAPTCHA_SITE_KEY is not set for this build');

  const config = await fetchHostingConfig();
  // Serve the auth handler from our own host so sign-in works without third-party storage.
  const app = initializeApp({ ...config, authDomain: window.location.host });
  const appCheck = initializeAppCheck(app, {
    provider: new ReCaptchaEnterpriseProvider(siteKey),
    isTokenAutoRefreshEnabled: true,
  });
  markOnFirstAppCheckToken(appCheck);
  return { app, auth: getAuth(app) };
}
