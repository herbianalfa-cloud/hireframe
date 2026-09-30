import { AppConfigSchema, DOCS, type AppConfig } from '@hireframe/shared';
import { HttpsError } from 'firebase-functions/https';

import { db } from './admin.js';
import { log } from './log.js';
import { timestampsToDates } from './timestamps.js';

/** The parts of a callable request the owner check needs. */
export interface OwnerCheckRequest {
  auth?: { uid: string } | undefined;
  app?: { alreadyConsumed?: boolean } | undefined;
}

export type ReadAppConfig = () => Promise<unknown>;

export const readAppConfigFromFirestore: ReadAppConfig = async () => {
  const snapshot = await db().doc(DOCS.appConfig).get();
  return snapshot.exists ? timestampsToDates(snapshot.data()) : undefined;
};

/**
 * Owner-only guard for callables (ADR-011). App Check is enforced by the callable options; this
 * also rejects replayed (already consumed) App Check tokens, then compares the caller's UID with
 * `config/app.ownerUid`. Any doubt means `permission-denied`, never access.
 */
export async function requireOwner(
  request: OwnerCheckRequest,
  readAppConfig: ReadAppConfig = readAppConfigFromFirestore,
): Promise<AppConfig> {
  const uid = request.auth?.uid;
  if (!uid) throw new HttpsError('unauthenticated', 'Sign in first.');
  if (request.app?.alreadyConsumed) {
    log.warn('owner.denied', { reason: 'app_check_replay' });
    throw new HttpsError('permission-denied', 'Not allowed.');
  }
  const parsed = AppConfigSchema.safeParse(await readAppConfig());
  if (!parsed.success) {
    log.error('owner.config_invalid', { issues: parsed.error.issues.length });
    throw new HttpsError('permission-denied', 'Not allowed.');
  }
  if (parsed.data.ownerUid !== uid) {
    log.warn('owner.denied', { reason: 'not_owner' });
    throw new HttpsError('permission-denied', 'Not allowed.');
  }
  return parsed.data;
}
