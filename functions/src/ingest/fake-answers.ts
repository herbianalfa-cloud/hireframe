import { INJECTION_CARD, WAAS_MODEL_ANSWER } from '../../../packages/shared/src/fixtures/alerts.js';

/**
 * The emulator's fake model for `alertParse` (ADR-017): recognises the fake Work at a Startup
 * alert by its first role and answers with the recorded rows; anything else has no jobs. The
 * injection fixture comes back as one job whose title is the injected text, as a model that
 * ignored the instructions would answer. Only `npm run dev` bundles this.
 */
export function fakeAlertParse(user: string): unknown {
  if (user.includes('Founding Product Analyst')) return WAAS_MODEL_ANSWER;
  if (user.includes(INJECTION_CARD.title)) {
    return {
      jobs: [
        {
          title: INJECTION_CARD.title,
          company: INJECTION_CARD.company,
          location: INJECTION_CARD.location,
          linkIndex: null,
        },
      ],
    };
  }
  return { jobs: [] };
}
