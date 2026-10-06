import { INGEST_WIRE, utf8Length } from '../../packages/shared/src/signing.js';
import type { RequestSigner } from './sign.js';

/**
 * The Gmail bridge core (ADR-046), pure: Gmail, the network, the clock and the signer are
 * injected, so it is tested without Apps Script. Every trigger it lists alert messages
 * (`label:hireframe/alerts -label:hireframe/done`), oldest first and at most 20, sends only
 * `{ id, receivedAt, from, text, html }` (never a subject, To, Cc or any other header), POSTs
 * them in signed batches bounded by bytes, and relabels a message `done` only when the server
 * says it was `processed`, `duplicate` or `unparsed`. On `busy`, `deferred`, a non-2xx or a
 * network error the label stays, so the next trigger retries.
 */

export const LABELS = { alerts: 'hireframe/alerts', done: 'hireframe/done' } as const;
export const PENDING_QUERY = `label:${LABELS.alerts} -label:${LABELS.done}`;

export interface BridgeMessage {
  id: string;
  receivedAt: string;
  from: string;
  text: string;
  html: string;
}

export interface BridgeDeps {
  /** Pending message IDs, newest first (Gmail's order); the core takes the oldest. */
  listPendingIds(): string[];
  getMessage(id: string): BridgeMessage | null;
  /** Adds `hireframe/done` and removes `hireframe/alerts`. */
  markDone(id: string): void;
  /** One POST; may throw (network error, timeout). */
  post(body: string, headers: Record<string, string>): { status: number; body: string };
  signer: RequestSigner;
  /** UUID v4. */
  uuid(): string;
  /** Epoch ms. */
  now(): number;
  log?(event: string, fields: Record<string, number | string>): void;
}

export interface BridgeSummary {
  listed: number;
  sent: number;
  posts: number;
  relabelled: number;
  /** Why the run stopped early, if it did. */
  stopped?: 'busy' | 'http_error' | 'network_error' | 'bad_response';
}

const FINAL = new Set(['processed', 'duplicate', 'unparsed']);

/** The UTF-8 bytes of the POST body for these messages. */
export function bodyFor(messages: readonly BridgeMessage[]): string {
  return JSON.stringify({ messages });
}

const bytes = (messages: readonly BridgeMessage[]): number => utf8Length(bodyFor(messages));

/** Largest `length` in [0, max] for which `fits` holds, assuming it is monotone. */
function largest(max: number, fits: (length: number) => boolean): number {
  let low = 0;
  let high = max;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (fits(mid)) low = mid;
    else high = mid - 1;
  }
  return low;
}

/** The first `length` UTF-16 units, never ending on half of a surrogate pair. */
function cut(text: string, length: number): string {
  const end = text.charCodeAt(length - 1);
  return text.slice(0, end >= 0xd800 && end <= 0xdbff ? length - 1 : length);
}

/** Caps each body at the wire limits (characters), as the server's schema does. */
export function capBodies(message: BridgeMessage): BridgeMessage {
  // Fields are named one by one: nothing else on the object (a subject, a recipient) can leave.
  return {
    id: message.id,
    receivedAt: message.receivedAt,
    from: message.from.slice(0, INGEST_WIRE.fromChars),
    text: message.text.slice(0, INGEST_WIRE.textChars),
    html: message.html.slice(0, INGEST_WIRE.htmlChars),
  };
}

/**
 * A single message that alone would pass the POST limit is cut to fit: `html` first (the text
 * part carries the same cards), then `text`.
 */
export function fitToLimit(message: BridgeMessage, maxBytes: number): BridgeMessage {
  if (bytes([message]) <= maxBytes) return message;
  const html = largest(
    message.html.length,
    (length) => bytes([{ ...message, html: cut(message.html, length) }]) <= maxBytes,
  );
  let fitted = { ...message, html: cut(message.html, html) };
  if (bytes([fitted]) <= maxBytes) return fitted;
  fitted = { ...fitted, html: '' };
  const text = largest(
    message.text.length,
    (length) => bytes([{ ...fitted, text: cut(message.text, length) }]) <= maxBytes,
  );
  return { ...fitted, text: cut(message.text, text) };
}

/** Groups messages in order: at most 5 per POST and under the byte limit. */
export function batchByBytes(
  messages: readonly BridgeMessage[],
  maxBytes: number = INGEST_WIRE.maxPostBytes,
  maxMessages: number = INGEST_WIRE.messagesPerRequest,
): BridgeMessage[][] {
  const batches: BridgeMessage[][] = [];
  let current: BridgeMessage[] = [];
  for (const message of messages.map((m) => fitToLimit(capBodies(m), maxBytes))) {
    const together = [...current, message];
    if (current.length > 0 && (together.length > maxMessages || bytes(together) > maxBytes)) {
      batches.push(current);
      current = [message];
    } else current = together;
  }
  if (current.length > 0) batches.push(current);
  return batches;
}

interface ParsedResponse {
  results: { id: string; status: string }[];
}

function parseResponse(text: string): ParsedResponse | null {
  try {
    const value: unknown = JSON.parse(text);
    if (typeof value !== 'object' || value === null || !('results' in value)) return null;
    const { results } = value;
    if (!Array.isArray(results)) return null;
    const parsed: ParsedResponse['results'] = [];
    for (const entry of results as unknown[]) {
      if (typeof entry !== 'object' || entry === null) return null;
      const { id, status } = entry as { id?: unknown; status?: unknown };
      if (typeof id !== 'string' || typeof status !== 'string') return null;
      parsed.push({ id, status });
    }
    return { results: parsed };
  } catch {
    return null;
  }
}

export function runBridge(deps: BridgeDeps): BridgeSummary {
  const log = deps.log ?? (() => undefined);
  // Gmail lists newest first; the oldest messages go first, so a backlog drains in order.
  const ids = deps.listPendingIds().slice().reverse().slice(0, INGEST_WIRE.messagesPerRun);
  const messages: BridgeMessage[] = [];
  for (const id of ids) {
    const message = deps.getMessage(id);
    if (message) messages.push(message);
  }
  const summary: BridgeSummary = { listed: ids.length, sent: 0, posts: 0, relabelled: 0 };

  for (const batch of batchByBytes(messages)) {
    const body = bodyFor(batch);
    const headers = deps.signer.headers(body, Math.floor(deps.now() / 1000), deps.uuid());
    summary.posts += 1;
    let response: { status: number; body: string };
    try {
      response = deps.post(body, headers);
    } catch {
      log('bridge.post_failed', { reason: 'network_error' });
      return { ...summary, stopped: 'network_error' };
    }
    if (response.status === 503) {
      log('bridge.post_failed', { reason: 'busy' });
      return { ...summary, stopped: 'busy' };
    }
    if (response.status < 200 || response.status >= 300) {
      log('bridge.post_failed', { reason: 'http_error', status: response.status });
      return { ...summary, stopped: 'http_error' };
    }
    const parsed = parseResponse(response.body);
    if (!parsed) return { ...summary, stopped: 'bad_response' };
    summary.sent += batch.length;
    const sent = new Set(batch.map((message) => message.id));
    for (const { id, status } of parsed.results) {
      // Only messages in this batch, and only a final status, are relabelled.
      if (sent.has(id) && FINAL.has(status)) {
        deps.markDone(id);
        summary.relabelled += 1;
      }
    }
  }
  return summary;
}
