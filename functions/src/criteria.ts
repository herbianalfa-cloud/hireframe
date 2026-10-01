import {
  CriteriaPointerSchema,
  CriteriaVersionSchema,
  criteriaVersionId,
  DOCS,
  PATHS,
  type CriteriaVersion,
} from '@hireframe/shared';
import type { Firestore } from 'firebase-admin/firestore';

import { timestampsToDates } from './timestamps.js';

/**
 * The criteria version the funnel should use (PRD R3, ADR-019): read `criteria/current`, then
 * `criteria/v{n}`. Null when no criteria exist yet. Throws if either document is invalid, so a
 * run never judges jobs against half-read criteria. Used by the funnel from M4.
 */
export async function getCurrentCriteria(firestore: Firestore): Promise<CriteriaVersion | null> {
  const pointerSnapshot = await firestore.doc(DOCS.criteriaCurrent).get();
  if (!pointerSnapshot.exists) return null;
  const pointer = CriteriaPointerSchema.parse(timestampsToDates(pointerSnapshot.data()));
  const versionSnapshot = await firestore
    .doc(PATHS.criteriaVersion(criteriaVersionId(pointer.version)))
    .get();
  return CriteriaVersionSchema.parse(timestampsToDates(versionSnapshot.data()));
}
