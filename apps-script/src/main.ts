import { runBridge, LABELS, PENDING_QUERY, type BridgeMessage } from './bridge.js';
import { toSignedBytes } from '../../packages/shared/src/signing.js';
import { readMessage, type ReadRuntime } from './read.js';
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

/** Installs the 30-minute trigger (replacing an earlier one), once. */
export function setup(): void {
  for (const trigger of ScriptApp.getProjectTriggers()) {
    if (trigger.getHandlerFunction() === 'run') ScriptApp.deleteTrigger(trigger);
  }
  ScriptApp.newTrigger('run').timeBased().everyMinutes(30).create();
}
