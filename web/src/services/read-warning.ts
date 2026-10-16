/** The dev-only read counter's warning text. Its own file so `scripts/check-bundle.ts` can import it without Vite's types. */
export const READ_WARNING = 'Firestore reads above 200 a minute (dev only)';
