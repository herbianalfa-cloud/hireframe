import { ScanNowInputSchema, type LockHolder, type ScanNowResult } from '@hireframe/shared';
import { HttpsError } from 'firebase-functions/https';

import type { ScanResult } from './run.js';

/**
 * The `scanNow` request handling around `runScan` (ADR-029), kept apart from the callable so it is
 * testable without Firebase: input validation and the busy → `failed-precondition` mapping. The
 * owner check runs before this (`requireOwner`, auth.ts).
 */
export async function scanNowHandler(
  data: unknown,
  scan: () => Promise<ScanResult>,
): Promise<ScanNowResult> {
  if (!ScanNowInputSchema.safeParse(data ?? {}).success) {
    throw new HttpsError('invalid-argument', 'Unexpected input.');
  }
  const result = await scan();
  if (result.status === 'busy') {
    throw new HttpsError('failed-precondition', busyMessage(result.holder));
  }
  return result;
}

/** What the System screen says when the lock is held: a short holder gets its own wording. */
export function busyMessage(holder: LockHolder | undefined): string {
  if (holder === 'email') return 'Importing alerts, try again in a minute.';
  if (holder === 'lookup') return 'Adding a job from Lookup, try again in a minute.';
  return 'A scan is already running.';
}

/** A mounted secret, or undefined when it's empty or the local-dev placeholder. */
export function secretValue(value: string): string | undefined {
  const trimmed = value.trim();
  return trimmed === '' || trimmed === 'emulator-placeholder' ? undefined : trimmed;
}
