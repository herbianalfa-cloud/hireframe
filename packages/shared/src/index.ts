export { AppConfigSchema, type AppConfig } from './config.js';
export { COLLECTIONS, DOCS, SUBCOLLECTIONS } from './firestore.js';

/**
 * Exhaustiveness guard for discriminated unions. The compiler rejects any call
 * where `value` is not `never`; at runtime it throws if an unhandled case slips through.
 */
export function assertNever(value: never, message = 'Unhandled case'): never {
  throw new Error(`${message}: ${JSON.stringify(value)}`);
}
