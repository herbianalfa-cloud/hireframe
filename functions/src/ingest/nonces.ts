import { PATHS } from '@hireframe/shared';
import type { Firestore } from 'firebase-admin/firestore';

import { HMAC } from '../config.js';

/**
 * Request nonces (ADR-046): a verified request's nonce is created with `create()`, which fails if
 * it exists, so a captured request can't be replayed inside the skew window. The TTL (10 min) is
 * at least twice the skew (5 min), so a replay is always caught by the nonce or by the timestamp.
 * A Firestore TTL policy on `nonces.expireAt` deletes them; an expired one that is still stored
 * is harmless, because the timestamp check already rejects it.
 */
export interface NonceStore {
  /** True when the nonce was new; false when it had been used. */
  claim(nonce: string, now: Date): Promise<boolean>;
}

const ALREADY_EXISTS = 6;

export function firestoreNonceStore(db: Firestore): NonceStore {
  return {
    async claim(nonce, now) {
      try {
        await db.doc(PATHS.nonce(nonce)).create({
          expireAt: new Date(now.getTime() + HMAC.nonceTtlSeconds * 1000),
          schemaVersion: 1,
        });
        return true;
      } catch (error) {
        if (typeof error === 'object' && error !== null && 'code' in error) {
          if (error.code === ALREADY_EXISTS || error.code === 'already-exists') return false;
        }
        throw error;
      }
    },
  };
}
