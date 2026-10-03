import { z } from 'zod';

/**
 * `config/app` — owner allowlist and app-wide settings (docs/ARCHITECTURE.md).
 * Written only by the Admin SDK or the Firebase console (ADR-011); clients read it.
 *
 * Timestamps are `Date`s here so the schema stays SDK-agnostic: callers convert
 * Firestore `Timestamp`s to `Date` before parsing.
 * `monthlyCapPence` and `fxUsdToGbp` are optional console overrides of the defaults in
 * functions/src/config.ts (ADR-016). `disabledSources` switches scan sources off without a
 * deploy (ADR-029). `funnel` holds optional per-run cap overrides (ADR-032); it is kept as
 * `unknown` here and parsed by the functions on its own, so a typo can't fail the owner check.
 */
export const AppConfigSchema = z.object({
  ownerUid: z.string().trim().min(1),
  schemaVersion: z.literal(1),
  monthlyCapPence: z.int().min(0).exactOptional(),
  fxUsdToGbp: z.number().positive().max(2).exactOptional(),
  /** Plain strings: a typo set in the console must never fail the owner check. Unknown IDs are ignored. */
  disabledSources: z.array(z.string()).max(20).exactOptional(),
  funnel: z.unknown().exactOptional(),
  createdAt: z.date(),
  updatedAt: z.date(),
});

export type AppConfig = z.infer<typeof AppConfigSchema>;
