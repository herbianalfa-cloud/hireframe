/**
 * The three triggers (ADR-052), as data and one installer. `setup` is run by hand, once; no
 * trigger handler calls it, and nothing here deletes or reschedules a trigger. A handler that
 * already has a trigger is left as it is, so running `setup` again changes nothing.
 * Times are in the script's time zone, which appsscript.json sets to Europe/London; the digest
 * handlers still compute the day with Europe/London themselves.
 */
export type TriggerSpec =
  | { handler: string; everyMinutes: number }
  | { handler: string; atHour: number; nearMinute: number };

export const TRIGGERS: readonly TriggerSpec[] = [
  { handler: 'run', everyMinutes: 30 },
  { handler: 'digestMorning', atHour: 7, nearMinute: 50 },
  { handler: 'digestFallback', atHour: 8, nearMinute: 20 },
];

export interface TriggerApi {
  /** Handler names of the project's existing triggers. */
  existing: () => string[];
  createEvery: (handler: string, minutes: number) => void;
  createDaily: (handler: string, hour: number, nearMinute: number) => void;
}

/** Creates the triggers that are missing and returns their handler names. */
export function installTriggers(api: TriggerApi): string[] {
  const have = new Set(api.existing());
  const created: string[] = [];
  for (const spec of TRIGGERS) {
    if (have.has(spec.handler)) continue;
    if ('everyMinutes' in spec) api.createEvery(spec.handler, spec.everyMinutes);
    else api.createDaily(spec.handler, spec.atHour, spec.nearMinute);
    created.push(spec.handler);
  }
  return created;
}
