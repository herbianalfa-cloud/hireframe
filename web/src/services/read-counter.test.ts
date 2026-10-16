import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  createReadCounter,
  getReads,
  listenerReads,
  READ_WARNING,
  recordReads,
} from './read-counter';

function counter() {
  let now = 1_000_000;
  const warnings: string[] = [];
  const c = createReadCounter({ now: () => now, warn: (m) => warnings.push(m) });
  return { c, warnings, advance: (ms: number) => (now += ms) };
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('read counter (C5)', () => {
  it('warns at 201 reads in a minute, not at 200', () => {
    const at200 = counter();
    at200.c.add(200, 'jobs');
    expect(at200.warnings).toEqual([]);

    const at201 = counter();
    at201.c.add(200, 'jobs');
    at201.c.add(1, 'jobs');
    expect(at201.warnings).toHaveLength(1);
    expect(at201.warnings[0]).toContain(READ_WARNING);
    expect(at201.warnings[0]).toContain('201');
    expect(at201.warnings[0]).toContain('jobs');
  });

  it('warns once per crossing, not on every read of a loop', () => {
    const t = counter();
    t.c.add(250, 'loop');
    t.c.add(10, 'loop');
    t.c.add(10, 'loop');
    expect(t.warnings).toHaveLength(1);
  });

  it('forgets reads older than a minute, then warns again on a new crossing', () => {
    const t = counter();
    t.c.add(150, 'a');
    t.advance(60_000); // exactly a minute later the first reads have left the window
    expect(t.c.total()).toBe(0);
    t.c.add(150, 'b');
    expect(t.warnings).toEqual([]);
    t.c.add(51, 'b');
    expect(t.warnings).toHaveLength(1);
    t.advance(61_000);
    t.c.add(201, 'c');
    expect(t.warnings).toHaveLength(2);
  });

  it('counts a listener by its first delivery, then by changed documents only', () => {
    const recorded: number[] = [];
    const delivered = listenerReads('jobs', (count) => recorded.push(count));
    const docs = (n: number) => Array.from({ length: n }, (_, i) => ({ id: String(i) }));
    delivered({ docs: docs(50), docChanges: () => docs(50) }); // first: all 50
    delivered({ docs: docs(50), docChanges: () => docs(3) }); // later: the 3 changed
    delivered({ docs: docs(50), docChanges: () => [] }); // a metadata-only delivery: min 1
    expect(recorded).toEqual([50, 3, 1]);
  });

  it('counts an empty first delivery as 1, and a single-document listener as 1 each time', () => {
    const recorded: number[] = [];
    const list = listenerReads('empty', (count) => recorded.push(count));
    list({ docs: [], docChanges: () => [] });
    const single = listenerReads('criteria/current', (count) => recorded.push(count));
    single({ exists: () => true });
    single({ exists: () => true });
    expect(recorded).toEqual([1, 1, 1]);
  });

  it('counts a get by its documents (min 1), and a document or count answer as 1', () => {
    const recorded: number[] = [];
    const record = (count: number) => recorded.push(count);
    getReads({ docs: [{}, {}, {}], docChanges: () => [] }, 'jobs', record);
    getReads({ docs: [], docChanges: () => [] }, 'jobs', record);
    getReads({ exists: () => true }, 'config', record);
    getReads({ data: () => ({ count: 900 }) }, 'count', record);
    expect(recorded).toEqual([3, 1, 1, 1]);
  });

  it('does nothing outside dev', () => {
    vi.stubEnv('DEV', false);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    recordReads(10_000, 'loop');
    const recorded: number[] = [];
    listenerReads('x', (count) => recorded.push(count))({ docs: [{}], docChanges: () => [] });
    getReads({ docs: [{}] }, 'x', (count) => recorded.push(count));
    expect(warn).not.toHaveBeenCalled();
    expect(recorded).toEqual([]);
  });

  it('warns through the console in dev', () => {
    vi.stubEnv('DEV', true);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    recordReads(201, 'dev-loop');
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).toContain(READ_WARNING);
  });
});
