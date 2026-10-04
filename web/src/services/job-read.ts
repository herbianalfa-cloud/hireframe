import { JobSchema, type Job } from '@hireframe/shared';
import type { DocumentData, DocumentSnapshot } from 'firebase/firestore';

import { timestampsToDates } from './timestamps';

export interface JobView {
  id: string;
  job: Job;
  /** The document as stored, which the action builders read. */
  raw: DocumentData;
}

export type JobRead = { ok: true; view: JobView } | { ok: false; fields: string[] };

/**
 * Parse one job document. Our own pending write has server timestamps that aren't known yet:
 * by default they read as `null`, which fails the schema and would drop the job for the length
 * of its own write. `estimate` gives them the local time until the server confirms.
 * On failure, returns the failing field paths (never values: they may be job text).
 */
export function readJob(item: DocumentSnapshot): JobRead {
  const raw = item.data({ serverTimestamps: 'estimate' });
  if (!raw) return { ok: false, fields: [] };
  const parsed = JobSchema.safeParse(timestampsToDates(raw));
  if (parsed.success) return { ok: true, view: { id: item.id, job: parsed.data, raw } };
  const fields = [...new Set(parsed.error.issues.map((issue) => issue.path.join('.') || '(root)'))];
  return { ok: false, fields: fields.slice(0, 8) };
}
