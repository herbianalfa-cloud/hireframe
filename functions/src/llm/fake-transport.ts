import { FAKE_MODEL_PREFIX } from '../config.js';
import { fakeDeepRead, fakeTriage } from '../funnel/fake-answers.js';
import { fakeAlertParse } from '../ingest/fake-answers.js';
import { FAKE_CV_EXTRACTION, FAKE_CV_REVISED_EXTRACTION } from '../fixtures/fake-cv-response.js';
import { REVISED_MARKER } from '../fixtures/fake-cv-text.js';
import type { LlmTransport } from './transport.js';

/**
 * Emulator-only transport (ADR-017): local dev never calls Anthropic unless LIVE=1.
 * - parseCv returns the fake CV's recorded extraction (the revised one if the CV says so);
 * - addFact turns the note's first sentence into one achievement fact;
 * - triage and deepRead answer by the posting's title (funnel/fake-answers.ts).
 * Token counts are rough estimates so the usage meter still moves. The reported model is
 * `fake:<id>`, priced at the real model's rate, so fake spend is never mistaken for real spend.
 */
export function fakeTransport(): LlmTransport {
  const estimate = (text: string) => Math.ceil(text.length / 4);
  return {
    countTokens: (request) =>
      Promise.resolve(estimate(request.system + request.messages.map((m) => m.content).join(''))),

    send(request) {
      const user = request.messages[0]?.content ?? '';
      let output: unknown;
      if (request.purpose === 'parseCv') {
        output = user.includes(REVISED_MARKER) ? FAKE_CV_REVISED_EXTRACTION : FAKE_CV_EXTRACTION;
      } else if (request.purpose === 'triage') {
        output = fakeTriage(user);
      } else if (request.purpose === 'deepRead') {
        output = fakeDeepRead(request.system, user);
      } else if (request.purpose === 'alertParse') {
        output = fakeAlertParse(user);
      } else {
        const note = user.replace(/<\/?note>/g, '').trim();
        const sentence = (note.split(/(?<=[.!?])\s/)[0] ?? note).slice(0, 300).trim();
        output = {
          facts: [
            {
              type: 'achievement',
              text: sentence,
              evidence: sentence,
              dates: {},
              tags: [],
              lanes: [],
            },
          ],
        };
      }
      const text = JSON.stringify(output);
      return Promise.resolve({
        model: `${FAKE_MODEL_PREFIX}${request.model.id}`,
        stopReason: 'end_turn',
        text,
        tokens: { input: estimate(user), output: estimate(text), cacheRead: 0, cacheWrite: 0 },
      });
    },
  };
}
