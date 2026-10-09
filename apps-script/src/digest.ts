import { utf8Bytes } from '../../packages/shared/src/signing.js';
import type { RequestSigner } from './sign.js';

/**
 * The digest mailer core (ADR-052), pure: the clock, the network, the properties, the lock, the
 * signer and the mail are injected, so it is tested without Apps Script. It has no trigger API:
 * the three triggers are installed by `setup` (triggers.ts), and nothing here creates, deletes or
 * reschedules one, and nothing retries. Each handler makes at most one POST per run.
 *
 * - `digestMorning` (07:50): weekdays in London only; if the digest was not sent today, POST
 *   `morning`. `ready`, `failed` and `missing` are mailed; `in_progress` is not, so the fallback
 *   handles it. A failed request mails nothing: the fallback runs 30 minutes later.
 * - `digestFallback` (08:20): the same checks, POST `fallback`, mail whatever comes back. If the
 *   request itself fails, or the full digest can't be sent, it mails a plain text "Hireframe
 *   digest unavailable (code)" itself, so the digest is never silently absent. It waits up to
 *   120 s for the lock and throws (visible in Executions) if it still can't get it.
 * - `digestNow`: a manual test; mails the fallback digest and leaves `lastDigestDay` alone.
 * Both triggered handlers hold the script lock, so their ±15 minute windows can't double-send.
 */

export const LAST_DIGEST_DAY = 'lastDigestDay';
/** How long the morning handler waits for the script lock before it skips. */
export const LOCK_WAIT_MS = 20_000;
/** How long the fallback and `digestNow` wait for the lock before they throw. */
export const LOCK_WAIT_LONG_MS = 120_000;
/** A digest whose html is longer than this is mailed as text only (the server caps it too). */
export const HTML_MAX = 100_000;

// The state names the server sends (packages/shared/src/digest.ts `DIGEST_STATES`; a test checks).
export const DIGEST_STATE_NAMES = ['ready', 'failed', 'in_progress', 'missing'] as const;
export type DigestStateName = (typeof DIGEST_STATE_NAMES)[number];
export type DigestKindName = 'morning' | 'fallback';

export interface DigestMail {
  subject: string;
  text: string;
  html?: string;
}

export interface DigestDeps {
  /** Epoch ms. */
  now: () => number;
  /** London calendar time, computed with Europe/London explicitly, never the script time zone. */
  london: {
    /** `YYYY-MM-DD` */
    day: (ms: number) => string;
    /** ISO weekday: 1 = Monday … 7 = Sunday. */
    isoWeekday: (ms: number) => number;
  };
  props: { get: (name: string) => string | null; set: (name: string, value: string) => void };
  /** One POST of the body's UTF-8 bytes (the bytes that were signed); may throw. */
  post: (
    body: readonly number[],
    headers: Record<string, string>,
  ) => {
    status: number;
    body: string;
  };
  signer: RequestSigner;
  /** UUID v4. */
  uuid: () => string;
  /** Sends to the owner's own address only; may throw. */
  sendMail: (mail: DigestMail) => void;
  lock: { tryLock: (waitMs: number) => boolean; release: () => void };
  log?: (event: string, fields: Record<string, number | string>) => void;
}

export type DigestSkip =
  'weekend' | 'already_sent' | 'locked' | 'in_progress' | 'request_failed' | 'send_failed';

export interface DigestOutcome {
  sent: boolean;
  skipped?: DigestSkip;
  /** The server's state for a digest that was mailed, or `unavailable` for the self-sent notice. */
  state?: DigestStateName | 'unavailable';
}

type Fetched = { ok: true; state: DigestStateName; mail: DigestMail } | { ok: false; code: string };

const SUBJECT_MAX = 200;

/** A fixed, log-safe code for a failed request: a status or a failure class, never a message. */
function fetchDigest(deps: DigestDeps, kind: DigestKindName, day: string): Fetched {
  const body = utf8Bytes(JSON.stringify({ kind, day }));
  let response: { status: number; body: string };
  try {
    const headers = deps.signer.headers(body, Math.floor(deps.now() / 1000), deps.uuid());
    response = deps.post(body, headers);
  } catch {
    return { ok: false, code: 'network_error' };
  }
  if (response.status < 200 || response.status >= 300) {
    return { ok: false, code: `http_${String(response.status)}` };
  }
  try {
    const parsed: unknown = JSON.parse(response.body);
    if (typeof parsed === 'object' && parsed !== null) {
      const { state, subject, html, text } = parsed as Record<string, unknown>;
      if (
        typeof state === 'string' &&
        (DIGEST_STATE_NAMES as readonly string[]).includes(state) &&
        typeof subject === 'string' &&
        subject.trim() !== '' &&
        subject.length <= SUBJECT_MAX &&
        typeof html === 'string' &&
        html !== '' &&
        typeof text === 'string' &&
        text !== ''
      ) {
        return {
          ok: true,
          state: state as DigestStateName,
          // A subject is one line.
          mail: {
            subject: subject.replace(/[\r\n]+/g, ' ').trim(),
            // Too large to trust: text only.
            ...(html.length > HTML_MAX ? {} : { html }),
            text,
          },
        };
      }
    }
  } catch {
    // fall through to bad_response
  }
  return { ok: false, code: 'bad_response' };
}

function unavailableMail(code: string, day: string): DigestMail {
  return {
    subject: `Hireframe digest unavailable (${code})`,
    text:
      `The Hireframe digest for ${day} could not be fetched (${code}).\n\n` +
      'Open the app and check System for the last run, or the Apps Script project’s Executions.',
  };
}

/**
 * Runs `work` while holding the script lock. If it can't be had, the morning skips (`locked`);
 * the others throw, so the failure shows in Executions.
 */
function locked(
  deps: DigestDeps,
  patience: 'skip' | 'throw',
  work: () => DigestOutcome,
): DigestOutcome {
  const waitMs = patience === 'skip' ? LOCK_WAIT_MS : LOCK_WAIT_LONG_MS;
  if (!deps.lock.tryLock(waitMs)) {
    deps.log?.('digest.skipped', { reason: 'locked' });
    if (patience === 'throw') throw new Error('digest_lock_unavailable');
    return { sent: false, skipped: 'locked' };
  }
  try {
    return work();
  } finally {
    deps.lock.release();
  }
}

function send(deps: DigestDeps, mail: DigestMail): boolean {
  try {
    deps.sendMail(mail);
    return true;
  } catch {
    deps.log?.('digest.send_failed', { reason: 'send_error' });
    return false;
  }
}

function due(deps: DigestDeps): { day: string } | DigestOutcome {
  const now = deps.now();
  if (deps.london.isoWeekday(now) > 5) {
    deps.log?.('digest.skipped', { reason: 'weekend' });
    return { sent: false, skipped: 'weekend' };
  }
  const day = deps.london.day(now);
  if (deps.props.get(LAST_DIGEST_DAY) === day) {
    deps.log?.('digest.skipped', { reason: 'already_sent' });
    return { sent: false, skipped: 'already_sent' };
  }
  return { day };
}

export function digestMorning(deps: DigestDeps): DigestOutcome {
  return locked(deps, 'skip', () => {
    const check = due(deps);
    if (!('day' in check)) return check;
    const fetched = fetchDigest(deps, 'morning', check.day);
    if (!fetched.ok) {
      // No retry: the 08:20 fallback is the second chance.
      deps.log?.('digest.request_failed', { kind: 'morning', code: fetched.code });
      return { sent: false, skipped: 'request_failed' };
    }
    if (fetched.state === 'in_progress') {
      deps.log?.('digest.skipped', { reason: 'in_progress' });
      return { sent: false, skipped: 'in_progress' };
    }
    if (!send(deps, fetched.mail)) return { sent: false, skipped: 'send_failed' };
    deps.props.set(LAST_DIGEST_DAY, check.day);
    deps.log?.('digest.sent', { kind: 'morning', state: fetched.state });
    return { sent: true, state: fetched.state };
  });
}

export function digestFallback(deps: DigestDeps): DigestOutcome {
  return locked(deps, 'throw', () => {
    const check = due(deps);
    if (!('day' in check)) return check;
    const fetched = fetchDigest(deps, 'fallback', check.day);
    if (!fetched.ok) deps.log?.('digest.request_failed', { kind: 'fallback', code: fetched.code });
    let state: DigestStateName | 'unavailable' = fetched.ok ? fetched.state : 'unavailable';
    let sent = send(deps, fetched.ok ? fetched.mail : unavailableMail(fetched.code, check.day));
    if (!sent && fetched.ok) {
      // The full digest couldn't be mailed (say, it was too big): a plain notice is still better.
      sent = send(deps, unavailableMail('send_failed', check.day));
      state = 'unavailable';
    }
    // Nothing follows the fallback, so a mail that can't be sent fails the execution visibly.
    if (!sent) throw new Error('digest_send_failed');
    deps.props.set(LAST_DIGEST_DAY, check.day);
    deps.log?.('digest.sent', { kind: 'fallback', state });
    return { sent: true, state };
  });
}

/** A manual test: any day of the week, and `lastDigestDay` is neither read nor written. */
export function digestNow(deps: DigestDeps): DigestOutcome {
  return locked(deps, 'throw', () => {
    const now = deps.now();
    const day = deps.london.day(now);
    deps.log?.('digest.now', { day, isoWeekday: deps.london.isoWeekday(now) });
    const fetched = fetchDigest(deps, 'fallback', day);
    if (!fetched.ok) deps.log?.('digest.request_failed', { kind: 'now', code: fetched.code });
    const mail = fetched.ok ? fetched.mail : unavailableMail(fetched.code, day);
    if (!send(deps, mail)) throw new Error('digest_send_failed');
    return { sent: true, state: fetched.ok ? fetched.state : 'unavailable' };
  });
}
