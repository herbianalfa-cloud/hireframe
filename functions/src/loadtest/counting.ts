/**
 * A Proxy around the Admin Firestore that counts documents read, documents written and the size
 * of each batch (plan B4). Only the paths the funnel, scan and wipe use are counted: `get`
 * (documents of a snapshot), `getAll`, `batch()` writes, and a transaction's reads and writes.
 * If the SDK's shape surprises it, a count simply stays at 0 and the report says "not measured".
 */
export interface Counters {
  reads: number;
  writes: number;
  batches: number[];
  /** Calls that reached a counted path at all; 0 means the proxy saw nothing. */
  observed: number;
}

export function newCounters(): Counters {
  return { reads: 0, writes: 0, batches: [], observed: 0 };
}

const WRITE_METHODS = new Set(['set', 'create', 'update', 'delete']);

function countSnapshot(result: unknown, counters: Counters): void {
  if (Array.isArray(result)) {
    counters.reads += result.length;
    counters.observed += 1;
    return;
  }
  const shaped = result as { size?: unknown; exists?: unknown } | null;
  if (shaped && typeof shaped.size === 'number') {
    counters.reads += shaped.size;
    counters.observed += 1;
  } else if (shaped && typeof shaped.exists === 'boolean') {
    counters.reads += 1;
    counters.observed += 1;
  }
}

function wrapBatch(batch: object, counters: Counters): object {
  let ops = 0;
  return new Proxy(batch, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, target) as unknown;
      if (typeof value !== 'function') return value;
      return (...args: unknown[]) => {
        if (typeof prop === 'string' && WRITE_METHODS.has(prop)) {
          ops += 1;
          counters.writes += 1;
          counters.observed += 1;
        }
        const out: unknown = (value as (...a: unknown[]) => unknown).apply(
          target,
          unwrapArgs(args),
        );
        if (prop === 'commit') {
          if (ops > 0) counters.batches.push(ops);
          ops = 0;
        }
        const self: unknown = receiver;
        return out === target ? self : out;
      };
    },
  });
}

function wrapTransaction(tx: object, counters: Counters): object {
  return new Proxy(tx, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, target) as unknown;
      if (typeof value !== 'function') return value;
      return (...args: unknown[]) => {
        const out: unknown = (value as (...a: unknown[]) => unknown).apply(
          target,
          unwrapArgs(args),
        );
        if (typeof prop === 'string' && WRITE_METHODS.has(prop)) {
          counters.writes += 1;
          counters.observed += 1;
        }
        if (out instanceof Promise) {
          return out.then((result: unknown) => {
            if (prop === 'get' || prop === 'getAll') countSnapshot(result, counters);
            return result;
          });
        }
        const self: unknown = receiver;
        return out === target ? self : out;
      };
    },
  });
}

const PROXIES = new WeakMap<object, object>();
const ORIGINALS = new WeakMap<object, object>();

/** Proxied refs passed back into the SDK must be the real objects. */
function unwrapArgs(args: unknown[]): unknown[] {
  return args.map((arg) =>
    typeof arg === 'object' && arg !== null ? (ORIGINALS.get(arg) ?? arg) : arg,
  );
}

/** Wraps `target` so results and chains stay counted. */
export function counted<T extends object>(target: T, counters: Counters): T {
  const existing = PROXIES.get(target);
  if (existing) return existing as T;
  const proxy = new Proxy(target, {
    get(inner, prop) {
      const value = Reflect.get(inner, prop, inner) as unknown;
      if (typeof value !== 'function') return value;
      return (...args: unknown[]) => {
        const real = unwrapArgs(args);
        if (prop === 'batch') {
          return wrapBatch((value as (...a: unknown[]) => object).apply(inner, real), counters);
        }
        if (prop === 'runTransaction') {
          const [update, ...rest] = real as [(tx: object) => Promise<unknown>, ...unknown[]];
          return (value as (...a: unknown[]) => unknown).apply(inner, [
            (tx: object) => update(wrapTransaction(tx, counters)),
            ...rest,
          ]);
        }
        const out: unknown = (value as (...a: unknown[]) => unknown).apply(inner, real);
        if (prop === 'getAll' && out instanceof Promise) {
          return out.then((result: unknown) => {
            countSnapshot(result, counters);
            return result;
          });
        }
        if (prop === 'get' && out instanceof Promise) {
          return out.then((result: unknown) => {
            countSnapshot(result, counters);
            return result;
          });
        }
        if (typeof out === 'object' && out !== null && !(out instanceof Promise)) {
          return counted(out, counters);
        }
        return out;
      };
    },
  });
  PROXIES.set(target, proxy);
  ORIGINALS.set(proxy, target);
  return proxy;
}
