/**
 * Everything the emulator fakes (ADR-017, ADR-029): the model transport, the job APIs and the
 * watchlist. Loaded only through `loadDevFakes()` (callable.ts), and only `npm run dev` builds
 * a bundle that contains it, so production bundles never carry fixture data.
 */
export { fakeTransport } from './llm/fake-transport.js';
export { fakeFetch } from './sources/fake-fetch.js';
export { FAKE_SEED } from './sources/fixtures.js';
