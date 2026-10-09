import { describe, expect, it } from 'vitest';

import { TRIGGERS, installTriggers, type TriggerApi } from './triggers.js';

function fake(initial: string[] = []) {
  const triggers = [...initial];
  const calls: string[] = [];
  const api: TriggerApi = {
    existing: () => [...triggers],
    createEvery(handler, minutes) {
      triggers.push(handler);
      calls.push(`every ${String(minutes)}m ${handler}`);
    },
    createDaily(handler, hour, minute) {
      triggers.push(handler);
      calls.push(`daily ${String(hour)}:${String(minute)} ${handler}`);
    },
  };
  return { api, triggers, calls };
}

describe('installTriggers', () => {
  it('creates run every 30 minutes, the morning digest near 07:50 and the fallback near 08:20', () => {
    const { api, calls } = fake();
    expect(installTriggers(api)).toEqual(['run', 'digestMorning', 'digestFallback']);
    expect(calls).toEqual([
      'every 30m run',
      'daily 7:50 digestMorning',
      'daily 8:20 digestFallback',
    ]);
  });

  it('keeps exactly three triggers after running twice', () => {
    const { api, triggers } = fake();
    installTriggers(api);
    expect(installTriggers(api)).toEqual([]);
    expect([...triggers].sort()).toEqual(['digestFallback', 'digestMorning', 'run']);
  });

  it('adds only the digest triggers to the 6A project, which already has run', () => {
    const { api, triggers } = fake(['run']);
    expect(installTriggers(api)).toEqual(['digestMorning', 'digestFallback']);
    expect(triggers).toHaveLength(3);
  });

  it('has no delete in its interface, and exactly three specs', () => {
    expect(TRIGGERS).toHaveLength(3);
    expect(Object.keys(fake().api).sort()).toEqual(['createDaily', 'createEvery', 'existing']);
  });
});
