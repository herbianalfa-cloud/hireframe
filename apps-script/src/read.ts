import type { BridgeMessage } from './bridge.js';

/**
 * Reads a Gmail message into a `BridgeMessage` (ADR-046), pure over an injected runtime so it is
 * tested without Apps Script. The Advanced Gmail service's `payload.body.data` is not always a
 * base64url string (it can be a byte array, unpadded, or standard base64), so `decode` tries each
 * shape in turn. Nothing here throws: a part that can't be decoded is skipped, a message with no
 * readable part is `null`, and the log carries only a fixed code, `typeof data` and the branch
 * that worked, never content.
 */

export interface ReadRuntime {
  base64DecodeWebSafe(data: string): number[];
  base64Decode(data: string): number[];
  newBlob(bytes: number[]): { getDataAsString(charset: string): string };
}

export interface ReadPart {
  mimeType?: string;
  headers?: { name: string; value: string }[];
  body?: { data?: unknown };
  parts?: ReadPart[];
}

export interface ReadMessage {
  internalDate?: string;
  payload?: ReadPart;
}

export type Branch = 'bytes' | 'websafe' | 'standard';
export type Log = (event: string, fields: Record<string, number | string>) => void;

const DEFAULT_CHARSET = 'UTF-8';

function charsetOf(part: ReadPart): string {
  const header = part.headers?.find((entry) => entry.name.toLowerCase() === 'content-type');
  const match = /charset\s*=\s*"?([^";\s]+)/i.exec(header?.value ?? '');
  return match?.[1] ?? DEFAULT_CHARSET;
}

function isBytes(data: unknown): data is number[] {
  return Array.isArray(data) && data.every((byte) => typeof byte === 'number');
}

/** Standard base64 from base64url or standard text: `-_` mapped to `+/`, padded to a multiple of 4. */
function toStandard(data: string): string {
  const text = data.replace(/\s+/g, '').replace(/-/g, '+').replace(/_/g, '/');
  return text.padEnd(Math.ceil(text.length / 4) * 4, '=');
}

function text(runtime: ReadRuntime, bytes: number[], charset: string): string {
  try {
    return runtime.newBlob(bytes).getDataAsString(charset);
  } catch {
    // An unknown charset name: UTF-8 is the best remaining reading of the bytes.
    if (charset.toUpperCase() === DEFAULT_CHARSET) throw new Error('undecodable');
    return runtime.newBlob(bytes).getDataAsString(DEFAULT_CHARSET);
  }
}

/** The decoded text and the branch that worked, or `null` when nothing could read `data`. */
export function decode(
  runtime: ReadRuntime,
  data: unknown,
  charset: string = DEFAULT_CHARSET,
): { text: string; branch: Branch } | null {
  const attempts: [Branch, () => number[]][] = [];
  if (isBytes(data)) attempts.push(['bytes', () => data]);
  else if (typeof data === 'string') {
    attempts.push(['websafe', () => runtime.base64DecodeWebSafe(data)]);
    attempts.push(['standard', () => runtime.base64Decode(toStandard(data))]);
  }
  for (const [branch, bytes] of attempts) {
    try {
      return { text: text(runtime, bytes(), charset), branch };
    } catch {
      // Try the next shape.
    }
  }
  return null;
}

/** The first text/plain and text/html parts, walking multipart messages; unreadable parts are skipped. */
function bodies(
  runtime: ReadRuntime,
  payload: ReadPart | undefined,
  log: Log,
): { text: string; html: string } {
  const found = { text: '', html: '' };
  const take = (part: ReadPart, kind: 'text' | 'html') => {
    const data = part.body?.data;
    if (!data) return;
    const result = decode(runtime, data, charsetOf(part));
    if (result) {
      found[kind] = result.text;
      log('bridge.decode', { code: 'ok', type: typeof data, branch: result.branch });
    } else {
      log('bridge.decode', { code: 'part_skipped', type: typeof data, branch: 'none' });
    }
  };
  const walk = (part: ReadPart) => {
    if (part.mimeType === 'text/plain' && found.text === '') take(part, 'text');
    else if (part.mimeType === 'text/html' && found.html === '') take(part, 'html');
    for (const child of part.parts ?? []) walk(child);
  };
  if (payload) walk(payload);
  return found;
}

/** Never throws: `null` for a message that has no `From`, no date or no readable part. */
export function readMessage(
  runtime: ReadRuntime,
  id: string,
  message: ReadMessage,
  log: Log,
): BridgeMessage | null {
  try {
    const from = message.payload?.headers?.find((header) => header.name.toLowerCase() === 'from');
    const internal = Number(message.internalDate);
    if (!from || !Number.isFinite(internal)) return null;
    // Only `From` is read: not Subject, To, Cc, Delivered-To or any other header.
    const read = bodies(runtime, message.payload, log);
    if (read.text === '' && read.html === '') {
      log('bridge.read_failed', { code: 'no_readable_part' });
      return null;
    }
    return { id, receivedAt: new Date(internal).toISOString(), from: from.value, ...read };
  } catch {
    log('bridge.read_failed', { code: 'read_error' });
    return null;
  }
}
