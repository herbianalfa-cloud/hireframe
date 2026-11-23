import { AppConfigSchema } from '@hireframe/shared';

import { markOnce } from '@/lib/perf';

import { getFirebase, loadFirestoreBoot } from './firebase';
import { errorCode, logError } from './log';
import { isChunkLoadError, isTransient, withRetry, withTimeout } from './resilience';

/**
 * Owner check for the UI (ADR-011). Firestore rules are the real guard; this decides
 * what to render and never grants access by default.
 */
export type Access =
  | { status: 'owner' }
  | { status: 'denied' }
  // `chunk-load`: the Firestore chunk couldn't be fetched. Only a page reload recovers (the
  // browser caches the failed import), so the gate's Try again reloads for this kind.
  | { status: 'error'; message: string; kind?: 'chunk-load' };

/** `data` has its Firestore Timestamps converted to Dates already (firestore-boot.ts). */
export type AppConfigRead = { exists: false } | { exists: true; data: unknown };
export type ReadAppConfig = () => Promise<AppConfigRead>;

const READ_TIMEOUT_MS = 10_000;

export function evaluateAccess(uid: string, read: AppConfigRead): Access {
  if (!read.exists) return { status: 'denied' };
  const parsed = AppConfigSchema.safeParse(read.data);
  if (!parsed.success) {
    logError('access.config_invalid', { issues: parsed.error.issues.length });
    return { status: 'error', message: 'The app configuration is invalid. See the runbook.' };
  }
  return parsed.data.ownerUid === uid ? { status: 'owner' } : { status: 'denied' };
}

async function readAppConfigFromFirestore(): Promise<AppConfigRead> {
  const { db } = await getFirebase();
  const boot = await loadFirestoreBoot(); // already imported by getFirebase: the same promise
  return boot.readAppConfig(db);
}

export async function checkAccess(
  uid: string,
  readAppConfig: ReadAppConfig = readAppConfigFromFirestore,
): Promise<Access> {
  try {
    const read = await withRetry(
      () => withTimeout(readAppConfig(), READ_TIMEOUT_MS, 'config/app read'),
      {
        label: 'access.read_config',
        isRetryable: isTransient,
      },
    );
    return evaluateAccess(uid, read);
  } catch (error) {
    // Rules deny non-owners (and everyone before bootstrap) with permission-denied.
    if (errorCode(error) === 'permission-denied') return { status: 'denied' };
    const message = "Couldn't check access. Try again.";
    if (isChunkLoadError(error)) return { status: 'error', message, kind: 'chunk-load' };
    return { status: 'error', message };
  } finally {
    markOnce('hf:owner');
  }
}
