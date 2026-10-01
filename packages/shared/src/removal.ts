import type { Fact } from './profile.js';

/**
 * "Remove upload" (ADR-023): undo what one CV upload did to the profile, without touching
 * anything the owner changed since. Pure, so the Profile screen can preview the counts and
 * tests/rules can replay the exact batches.
 */
export interface UploadRemovalPlan {
  /** Facts the upload added that are still exactly as it left them: archived. */
  archive: string[];
  /** Facts with a pending proposed change from the upload: the change is dropped. */
  dropReviews: string[];
  /** Active facts from the upload that the owner edited (or wrote): kept. */
  skippedEdited: number;
}

export function planUploadRemoval(
  facts: readonly { id: string; fact: Fact }[],
  docId: string,
): UploadRemovalPlan {
  const plan: UploadRemovalPlan = { archive: [], dropReviews: [], skippedEdited: 0 };
  for (const { id, fact } of facts) {
    if (fact.sourceDocId === docId && fact.status === 'active') {
      // Already-archived facts are ignored, so a retry after a partial failure counts nothing twice.
      if (fact.version === 1 && fact.source !== 'manual') plan.archive.push(id);
      else plan.skippedEdited++;
    } else if (fact.review?.docId === docId) {
      plan.dropReviews.push(id);
    }
  }
  return plan;
}
