import { Timestamp } from 'firebase/firestore';

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === 'object' && value !== null && Object.getPrototypeOf(value) === Object.prototype
  );
}

/**
 * Recursively converts Firestore `Timestamp`s to `Date`s so shared zod schemas
 * (which use `z.date()`) can parse Firestore reads. Docs created in the Firebase
 * console, like the bootstrap `config/app`, store timestamps as `Timestamp`.
 */
export function timestampsToDates(value: unknown): unknown {
  if (value instanceof Timestamp) return value.toDate();
  if (Array.isArray(value)) return value.map(timestampsToDates);
  if (isPlainObject(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, inner]) => [key, timestampsToDates(inner)]),
    );
  }
  return value;
}
