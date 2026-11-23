import { existsSync, readFileSync } from 'node:fs';

import { applyReserve, applySettle, emptyUsage, type UsageStore } from '../llm/usage-store.js';
import { EVAL_NOW } from './cases.js';

/** What both eval suites share: the in-memory spend store and the local API key. */
export const SECRETS_FILE = 'functions/.secret.local';

/** A usage store that enforces `capPence` for one run and keeps nothing. */
export function memoryUsage(capPence: number): UsageStore {
  let usage = emptyUsage(capPence, EVAL_NOW);
  return {
    reserve(input) {
      usage = applyReserve(usage, input);
      return Promise.resolve();
    },
    settle(input) {
      usage = applySettle(usage, input);
      return Promise.resolve();
    },
  };
}

export function apiKey(): string {
  const fromEnv = process.env.ANTHROPIC_API_KEY?.trim();
  if (fromEnv) return fromEnv;
  if (existsSync(SECRETS_FILE)) {
    const line = readFileSync(SECRETS_FILE, 'utf8')
      .split(/\r?\n/)
      .find((entry) => entry.startsWith('ANTHROPIC_API_KEY='));
    const key = line?.slice('ANTHROPIC_API_KEY='.length).trim();
    if (key) return key;
  }
  throw new Error(`LIVE=1 needs ANTHROPIC_API_KEY in the environment or in ${SECRETS_FILE}.`);
}
