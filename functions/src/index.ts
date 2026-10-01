/**
 * Cloud Functions entry point (docs/ARCHITECTURE.md "Functions", ADR-017). Global options
 * (region, runtime account, max instances) are set in ./options.ts.
 */
export { addFact, parseCv } from './profile/callables.js';
