import { runBridge, LABELS, PENDING_QUERY, type BridgeMessage } from './bridge.js';
import { toSignedBytes } from '../../packages/shared/src/signing.js';
import { createSigner } from './sign.js';

/**
 * Apps Script glue for the Gmail bridge (ADR-046): the Advanced Gmail service (`gmail.modify`:
 * read and relabel, where GmailApp would need the full mail scope), `UrlFetchApp`, Script
 * Properties and the HMAC primitive, wired into the pure core in bridge.ts. `run` is the trigger
 * handler; `setup` installs the 30-minute trigger once. Nothing here reads a header but `From`.
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

function decode(data: string | undefined): string {
  if (!data) return '';
  return Utilities.newBlob(Utilities.base64DecodeWebSafe(data)).getDataAsString('UTF-8');
}

/** The first text/plain and text/html parts, walking multipart messages. */
function bodies(payload: GmailPayload | undefined): { text: string; html: string } {
  const found = { text: '', html: '' };
  const walk = (part: GmailPayload) => {
    if (part.mimeType === 'text/plain' && found.text === '') found.text = decode(part.body?.data);
    else if (part.mimeType === 'text/html' && found.html === '') {
      found.html = decode(part.body?.data);
    }
    for (const child of part.parts ?? []) walk(child);
  };
  if (payload) walk(payload);
  return found;
}

function readMessage(id: string): BridgeMessage | null {
  const message = Gmail.Users.Messages.get('me', id, { format: 'full' });
  const from = message.payload?.headers?.find((header) => header.name.toLowerCase() === 'from');
  const internal = Number(message.internalDate);
  if (!from || !Number.isFinite(internal)) return null;
  // Only `From` is read: not Subject, To, Cc, Delivered-To or any other header.
  return {
    id,
    receivedAt: new Date(internal).toISOString(),
    from: from.value,
    ...bodies(message.payload),
  };
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
    getMessage: readMessage,
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
    log: (event, fields) => {
      Logger.log(`${event} ${JSON.stringify(fields)}`);
    },
  });
  Logger.log(`bridge.done ${JSON.stringify(summary)}`);
}

/** Installs the 30-minute trigger (replacing an earlier one), once. */
export function setup(): void {
  for (const trigger of ScriptApp.getProjectTriggers()) {
    if (trigger.getHandlerFunction() === 'run') ScriptApp.deleteTrigger(trigger);
  }
  ScriptApp.newTrigger('run').timeBased().everyMinutes(30).create();
}
