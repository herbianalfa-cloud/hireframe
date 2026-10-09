import { runBridge, LABELS, PENDING_QUERY, type BridgeMessage } from './bridge.js';
import { toSignedBytes } from '../../packages/shared/src/signing.js';
import { readMessage, type ReadRuntime } from './read.js';
import { digestFallback, digestMorning, digestNow, type DigestDeps } from './digest.js';
import { createSigner } from './sign.js';
import { installTriggers } from './triggers.js';

/**
 * Apps Script glue for the Gmail bridge (ADR-046): the Advanced Gmail service (`gmail.modify`:
 * read and relabel, where GmailApp would need the full mail scope), `UrlFetchApp`, Script
 * Properties and the HMAC primitive, wired into the pure core in bridge.ts. `run` is the trigger
 * handler; `setup` installs the three triggers once (triggers.ts). Nothing here reads a header but
 * `From`. The digest handlers (ADR-052) mail only to `Session.getEffectiveUser()`, the account the
 * script runs as, and compute the day with Europe/London explicitly.
 */

const PAGE = 100;
const MAX_PAGES = 2;

function property(name: string): string {
  const value = PropertiesService.getScriptProperties().getProperty(name);
  if (value === null || value.trim() === '') throw new Error(`Script property ${name} is not set`);
  return value;
}

function labelId(name: string): string {
  const found = (Gmail.Users.Labels.list('me').labels ?? []).find((label) => label.name === name);
  if (!found) throw new Error(`Gmail label ${name} does not exist`);
  return found.id;
}

const runtime: ReadRuntime = {
  base64DecodeWebSafe: (data) => Utilities.base64DecodeWebSafe(data),
  base64Decode: (data) => Utilities.base64Decode(data),
  newBlob: (bytes) => Utilities.newBlob(bytes),
};

const log = (event: string, fields: Record<string, number | string>) => {
  Logger.log(`${event} ${JSON.stringify(fields)}`);
};

function readGmailMessage(id: string): BridgeMessage | null {
  try {
    return readMessage(runtime, id, Gmail.Users.Messages.get('me', id, { format: 'full' }), log);
  } catch {
    log('bridge.read_failed', { code: 'get_error' });
    return null;
  }
}

export function run(): void {
  const url = property('HIREFRAME_INGEST_URL');
  const secret = property('HIREFRAME_HMAC_SECRET');
  const alerts = labelId(LABELS.alerts);
  const done = labelId(LABELS.done);
  const summary = runBridge({
    listPendingIds() {
      const ids: string[] = [];
      let pageToken: string | undefined;
      for (let page = 0; page < MAX_PAGES; page++) {
        const result = Gmail.Users.Messages.list('me', {
          q: PENDING_QUERY,
          maxResults: PAGE,
          ...(pageToken ? { pageToken } : {}),
        });
        for (const message of result.messages ?? []) ids.push(message.id);
        pageToken = result.nextPageToken;
        if (!pageToken) break;
      }
      return ids;
    },
    getMessage: readGmailMessage,
    markDone(id) {
      Gmail.Users.Messages.modify({ addLabelIds: [done], removeLabelIds: [alerts] }, 'me', id);
    },
    post(body, headers) {
      const response = UrlFetchApp.fetch(url, {
        method: 'post',
        contentType: 'application/json; charset=utf-8',
        // The same bytes that were signed, never a string the runtime might re-encode.
        payload: toSignedBytes(body),
        headers,
        muteHttpExceptions: true,
      });
      return { status: response.getResponseCode(), body: response.getContentText() };
    },
    signer: createSigner(secret, (value, key) =>
      Utilities.computeHmacSha256Signature(toSignedBytes(value), toSignedBytes(key)),
    ),
    uuid: () => Utilities.getUuid(),
    now: () => Date.now(),
    log,
  });
  Logger.log(`bridge.done ${JSON.stringify(summary)}`);
}

const LONDON = 'Europe/London';

/** Mail goes to the account the script runs as; no address is in the code or the properties. */
function ownAddress(): string {
  const address = Session.getEffectiveUser().getEmail();
  if (address.trim() === '') throw new Error('The effective user has no email address');
  return address;
}

function digestDeps(): DigestDeps {
  const url = property('HIREFRAME_DIGEST_URL');
  const secret = property('HIREFRAME_HMAC_SECRET');
  const scriptProperties = PropertiesService.getScriptProperties();
  const lock = LockService.getScriptLock();
  return {
    now: () => Date.now(),
    london: {
      day: (ms) => Utilities.formatDate(new Date(ms), LONDON, 'yyyy-MM-dd'),
      isoWeekday: (ms) => Number(Utilities.formatDate(new Date(ms), LONDON, 'u')),
    },
    props: {
      get: (name) => scriptProperties.getProperty(name),
      set: (name, value) => void scriptProperties.setProperty(name, value),
    },
    post(body, headers) {
      const response = UrlFetchApp.fetch(url, {
        method: 'post',
        contentType: 'application/json; charset=utf-8',
        payload: toSignedBytes(body),
        headers,
        muteHttpExceptions: true,
      });
      return { status: response.getResponseCode(), body: response.getContentText() };
    },
    signer: createSigner(
      secret,
      (value, key) =>
        Utilities.computeHmacSha256Signature(toSignedBytes(value), toSignedBytes(key)),
      'digest',
    ),
    uuid: () => Utilities.getUuid(),
    sendMail: ({ subject, text, html }) => {
      MailApp.sendEmail({
        to: ownAddress(),
        subject,
        body: text,
        ...(html === undefined ? {} : { htmlBody: html }),
      });
    },
    lock: {
      tryLock: (waitMs) => lock.tryLock(waitMs),
      release: () => {
        lock.releaseLock();
      },
    },
    log,
  };
}

function report(outcome: unknown): void {
  Logger.log(`digest.done ${JSON.stringify(outcome)}`);
}

export function digestMorningHandler(): void {
  report(digestMorning(digestDeps()));
}

export function digestFallbackHandler(): void {
  report(digestFallback(digestDeps()));
}

/** A manual test: mails today's digest now, on any day, and leaves `lastDigestDay` alone. */
export function digestNowHandler(): void {
  report(digestNow(digestDeps()));
}

/**
 * Installs the three triggers (`run` every 30 minutes, `digestMorning` near 07:50,
 * `digestFallback` near 08:20) that are missing. Run by hand, once; no handler calls it, and it
 * deletes nothing.
 */
export function setup(): void {
  const created = installTriggers({
    existing: () => ScriptApp.getProjectTriggers().map((trigger) => trigger.getHandlerFunction()),
    createEvery: (handler, minutes) => {
      ScriptApp.newTrigger(handler).timeBased().everyMinutes(minutes).create();
    },
    createDaily: (handler, hour, nearMinute) => {
      ScriptApp.newTrigger(handler)
        .timeBased()
        .atHour(hour)
        .nearMinute(nearMinute)
        .everyDays(1)
        .create();
    },
  });
  Logger.log(`setup.done ${JSON.stringify({ created })}`);
}
