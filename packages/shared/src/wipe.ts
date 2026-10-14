import { z } from 'zod';

/**
 * Delete all my data (ADR-057). The owner types DELETE; `resetProfile` also removes the profile
 * (facts, uploads, `profile/main`, `profile/cvHeader`) and is off unless ticked.
 */
export const WIPE_CONFIRMATION = 'DELETE';

/** What a source doc keeps through a wipe: its call counters and host pauses (ADR-025, ADR-057). */
export const KEPT_SOURCE_FIELDS = ['quota', 'pausedHosts'] as const;

/** Every field a kept-only source doc may carry. */
export const KEPT_ONLY_SOURCE_KEYS: ReadonlySet<string> = new Set([
  ...KEPT_SOURCE_FIELDS,
  'updatedAt',
  'schemaVersion',
]);

/** Whether a `sources/{id}` doc is the shape a wipe leaves: only kept fields, at least one kept. */
export function isKeptOnlySourceDoc(data: unknown): boolean {
  if (typeof data !== 'object' || data === null) return false;
  const keys = Object.keys(data);
  return (
    keys.length > 0 &&
    keys.every((key) => KEPT_ONLY_SOURCE_KEYS.has(key)) &&
    KEPT_SOURCE_FIELDS.some((field) => field in data)
  );
}

export const DeleteAllDataInputSchema = z.strictObject({
  confirm: z.literal(WIPE_CONFIRMATION),
  resetProfile: z.boolean(),
});
export type DeleteAllDataInput = z.infer<typeof DeleteAllDataInputSchema>;

/** The steps in the order a call runs them. The profile step is last and only when ticked. */
export const WIPE_STEPS = [
  'applications',
  'cvFiles',
  'cvs',
  'jobs',
  'runs',
  'events',
  'alertMessages',
  'companies',
  'sources',
] as const;
export type WipeStep = (typeof WIPE_STEPS)[number];

export const WIPE_STEP_LABELS: Record<WipeStep, string> = {
  applications: 'applications',
  cvFiles: 'CV files',
  cvs: 'CVs',
  jobs: 'jobs',
  runs: 'runs',
  events: 'events',
  alertMessages: 'alert messages',
  companies: 'companies',
  sources: 'sources',
};

export const DeleteAllDataResultSchema = z.object({
  /** True only when one call's pass found every step empty and deleted nothing. */
  done: z.boolean(),
  deleted: z.object({ documents: z.int().min(0), files: z.int().min(0) }),
  /** Steps not confirmed empty in this call's pass. */
  remaining: z.array(z.enum(WIPE_STEPS)),
  /** The profile counts, only on the call that ran the profile step. */
  profile: z
    .object({
      facts: z.int().min(0),
      documents: z.int().min(0),
      files: z.int().min(0),
    })
    .exactOptional(),
});
export type DeleteAllDataResult = z.infer<typeof DeleteAllDataResultSchema>;
