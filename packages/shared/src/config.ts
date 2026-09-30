import { z } from 'zod';

/**
 * `config/app` — owner allowlist and app-wide settings (docs/ARCHITECTURE.md).
 * Written only by the Admin SDK or the Firebase console (ADR-011); clients read it.
 *
 * Timestamps are `Date`s here so the schema stays SDK-agnostic: callers convert
 * Firestore `Timestamp`s to `Date` before parsing.
 * Later milestones add schedules, models, caps and `fxUsdToGbp`.
 */
export const AppConfigSchema = z.object({
  ownerUid: z.string().trim().min(1),
  schemaVersion: z.literal(1),
  createdAt: z.date(),
  updatedAt: z.date(),
});

export type AppConfig = z.infer<typeof AppConfigSchema>;
