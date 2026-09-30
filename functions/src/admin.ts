import { getApps, initializeApp } from 'firebase-admin/app';
import { getFirestore, type Firestore } from 'firebase-admin/firestore';
import { getStorage } from 'firebase-admin/storage';

/** Lazy Admin SDK handles, so importing a module never initialises Firebase. */
function app() {
  return getApps()[0] ?? initializeApp();
}

export function db(): Firestore {
  return getFirestore(app());
}

export function bucket() {
  return getStorage(app()).bucket();
}
