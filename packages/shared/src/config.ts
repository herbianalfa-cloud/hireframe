import { z } from 'zod';

/**
 * `config/app` — owner allowlist and app-wide settings (docs/ARCHITECTURE.md).
 * Written only by the Admin SDK or the Firebase console (ADR-011); clients read it.
 *
 * Timestamps are `Date`s here so the schema stays SDK-agnostic: callers convert
 * Firestore `Timestamp`s to `Date` before parsing.
 * `monthlyCapPence` and `fxUsdToGbp` are optional console overrides of the defaults in
 * functions/src/config.ts (ADR-016). Later milestones add schedules and feature flags.
 */
export const AppConfigSchema = z.object({
  ownerUid: z.string().trim().min(1),
  schemaVersion: z.literal(1),
  monthlyCapPence: z.int().min(0).exactOptional(),
  fxUsdToGbp: z.number().positive().max(2).exactOptional(),
  createdAt: z.date(),
  updatedAt: z.date(),
});

export type AppConfig = z.infer<typeof AppConfigSchema>;
