export * from './atomicity.js';
export * from './callables.js';
export { AppConfigSchema, type AppConfig } from './config.js';
export * from './criteria.js';
export * from './dedupe.js';
export { CRITERIA_SEED_V1 } from './criteria-seed.js';
export * from './titles.js';
export { verifyEvidence } from './evidence.js';
export { decodeEntities, htmlToText, tidyText } from './html.js';
export * from './jobs.js';
export * from './normalise.js';
export { COLLECTIONS, DOCS, PATHS, STORAGE_PATHS, SUBCOLLECTIONS } from './firestore.js';
export * from './merge.js';
export { redactPii } from './pii.js';
export * from './profile.js';
export * from './removal.js';
export * from './usage.js';
export { WATCHLIST_SEED } from './watchlist-seed.js';

/**
 * Exhaustiveness guard for discriminated unions. The compiler rejects any call
 * where `value` is not `never`; at runtime it throws if an unhandled case slips through.
 */
export function assertNever(value: never, message = 'Unhandled case'): never {
  throw new Error(`${message}: ${JSON.stringify(value)}`);
}
