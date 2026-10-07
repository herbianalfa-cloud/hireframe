import { describe, expect, it } from 'vitest';

import { runBridge } from './bridge.js';
import { createSigner } from './sign.js';
import { decode, readMessage, type ReadMessage, type ReadPart, type ReadRuntime } from './read.js';

/** A fake Apps Script `Utilities`: strict about alphabet and padding, like the real one. */
const runtime: ReadRuntime = {
  base64DecodeWebSafe(data) {
    if (!/^[A-Za-z0-9_-]*={0,2}$/.test(data) || data.length % 4 !== 0) {
      throw new Error('Could not decode string');
    }
    return [...Buffer.from(data, 'base64url')];
  },
  base64Decode(data) {
    if (!/^[A-Za-z0-9+/]*={0,2}$/.test(data) || data.length % 4 !== 0) {
      throw new Error('Could not decode string');
    }
    return [...Buffer.from(data, 'base64')];
  },
  newBlob: (bytes) => ({
    getDataAsString: (charset) =>
      new TextDecoder(charset, { fatal: true }).decode(Uint8Array.from(bytes)),
  }),
};

const TEXT = 'Engineer · London £50k';
const utf8 = Buffer.from(TEXT, 'utf8');
const LATIN1_CAFE = Buffer.from([0x63, 0x61, 0x66, 0xe9]);

function part(data: unknown, charset?: string): ReadPart {
  return {
    mimeType: 'text/plain',
    ...(charset
      ? { headers: [{ name: 'Content-Type', value: `text/plain; charset="${charset}"` }] }
      : {}),
    body: { data },
  };
}

function gmail(payload: ReadPart): ReadMessage {
  return {
    internalDate: '1760000000000',
    payload: {
      ...payload,
      headers: [...(payload.headers ?? []), { name: 'From', value: 'a@b.c' }],
    },
  };
}

describe('decode', () => {
  it('reads a byte array as UTF-8, signed bytes included', () => {
    const signed = [...utf8].map((byte) => (byte > 127 ? byte - 256 : byte));
    expect(decode(runtime, signed)).toEqual({ text: TEXT, branch: 'bytes' });
  });

  it('reads padded and unpadded base64url', () => {
    expect(decode(runtime, utf8.toString('base64url'))?.text).toBe(TEXT);
    const unpadded = Buffer.from('ab', 'utf8').toString('base64url');
    expect(unpadded.length % 4).not.toBe(0);
    expect(decode(runtime, unpadded)).toEqual({ text: 'ab', branch: 'standard' });
  });

  it('reads standard base64 with + and /', () => {
    const standard = Buffer.from([0xfb, 0xff, 0xfe]).toString('base64');
    expect(standard).toMatch(/[+/]/);
    expect(decode(runtime, standard, 'ISO-8859-1')?.branch).toBe('standard');
    const text = Buffer.from('>>>???~~~', 'utf8').toString('base64');
    expect(text).toMatch(/[+/]/);
    expect(decode(runtime, text)).toEqual({ text: '>>>???~~~', branch: 'standard' });
  });

  it('honours the charset, and falls back to UTF-8 for a name it does not know', () => {
    expect(decode(runtime, LATIN1_CAFE.toString('base64url'), 'iso-8859-1')?.text).toBe('café');
    expect(decode(runtime, utf8.toString('base64url'), 'x-no-such-charset')?.text).toBe(TEXT);
  });

  it('returns null for data it cannot read', () => {
    expect(decode(runtime, '***')).toBeNull();
    expect(decode(runtime, 42)).toBeNull();
    expect(decode(runtime, undefined)).toBeNull();
  });
});

describe('readMessage', () => {
  const logged: [string, Record<string, number | string>][] = [];
  const log = (event: string, fields: Record<string, number | string>) => {
    logged.push([event, fields]);
  };

  it('skips an undecodable part and keeps the readable one', () => {
    const message = gmail({
      mimeType: 'multipart/alternative',
      parts: [part('***'), { mimeType: 'text/html', body: { data: utf8.toString('base64url') } }],
    });
    expect(readMessage(runtime, 'm1', message, log)).toMatchObject({ text: '', html: TEXT });
  });

  it('is null for a message with no readable part, and never throws', () => {
    expect(readMessage(runtime, 'm1', gmail(part('***')), log)).toBeNull();
    const hostile = {
      get internalDate(): string {
        throw new Error('boom');
      },
    } as ReadMessage;
    expect(readMessage(runtime, 'm1', hostile, log)).toBeNull();
  });

  it('logs only fixed codes, the type of data and the branch', () => {
    logged.length = 0;
    readMessage(runtime, 'm1', gmail(part(utf8.toString('base64url'))), log);
    readMessage(runtime, 'm2', gmail(part('***')), log);
    const text = JSON.stringify(logged);
    expect(text).not.toContain('Engineer');
    expect(text).not.toContain('***');
    expect(logged.map(([, fields]) => Object.keys(fields).sort())).toContainEqual([
      'branch',
      'code',
      'type',
    ]);
  });

  it('keeps going past one undecodable message: the good ones are still sent', () => {
    const messages: Record<string, ReadMessage> = {
      m1: gmail(part([...utf8])),
      m2: gmail(part('***')),
      m3: gmail(part(LATIN1_CAFE.toString('base64url'), 'iso-8859-1')),
    };
    const posted: { id: string; text: string }[] = [];
    const done: string[] = [];
    const summary = runBridge({
      listPendingIds: () => ['m3', 'm2', 'm1'],
      getMessage: (id) => readMessage(runtime, id, messages[id] ?? {}, log),
      markDone: (id) => {
        done.push(id);
      },
      post: (body) => {
        const sent = (JSON.parse(Buffer.from(body).toString('utf8')) as { messages: typeof posted })
          .messages;
        posted.push(...sent);
        return {
          status: 200,
          body: JSON.stringify({ results: sent.map(({ id }) => ({ id, status: 'processed' })) }),
        };
      },
      signer: createSigner('secret', () => [1, 2, 3]),
      uuid: () => '3b241101-e2bb-4255-8caf-4136c566a962',
      now: () => 1_760_000_000_000,
    });
    expect(posted.map(({ id, text }) => [id, text])).toEqual([
      ['m1', TEXT],
      ['m3', 'café'],
    ]);
    expect(done.sort()).toEqual(['m1', 'm3']);
    expect(summary).toMatchObject({ listed: 3, sent: 2, relabelled: 2, unreadable: 1 });
  });
});
