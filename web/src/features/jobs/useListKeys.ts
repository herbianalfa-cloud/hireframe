import { useCallback, type KeyboardEvent } from 'react';

export interface ListKeyActions {
  /** `a`: toggle applied on the focused job. */
  onApplied: (jobId: string) => void;
  /** `s`: toggle skip on the focused job. */
  onSkip: (jobId: string) => void;
  /** `o`: open the focused job's posting. */
  onOpenPosting: (jobId: string) => void;
}

const FIELD_TAGS = new Set(['INPUT', 'TEXTAREA', 'SELECT']);

/**
 * Keyboard shortcuts for a job list (docs/DESIGN.md), active only while focus is inside it
 * (ADR-038, WCAG 2.1.4): `j`/`k` move between rows, `a` toggles applied, `s` toggles skip, `o` open posting.
 * Rows carry `data-job-row` and `data-job-id`. Spread the result on the list element.
 */
export function useListKeys(actions: ListKeyActions) {
  const { onApplied, onSkip, onOpenPosting } = actions;
  const onKeyDown = useCallback(
    (event: KeyboardEvent<HTMLElement>) => {
      if (event.ctrlKey || event.metaKey || event.altKey) return;
      const target = event.target as HTMLElement;
      if (FIELD_TAGS.has(target.tagName) || target.isContentEditable) return;
      const row = target.closest<HTMLElement>('[data-job-row]');
      const jobId = row?.dataset.jobId;
      if (event.key === 'j' || event.key === 'k') {
        const rows = [...event.currentTarget.querySelectorAll<HTMLElement>('[data-job-row]')];
        if (rows.length === 0) return;
        const at = row ? rows.indexOf(row) : -1;
        const next = event.key === 'j' ? Math.min(rows.length - 1, at + 1) : Math.max(0, at - 1);
        rows[next]?.focus();
        event.preventDefault();
        return;
      }
      if (!jobId) return;
      if (event.key === 'a') onApplied(jobId);
      else if (event.key === 's') onSkip(jobId);
      else if (event.key === 'o') onOpenPosting(jobId);
      else return;
      event.preventDefault();
    },
    [onApplied, onSkip, onOpenPosting],
  );
  return { onKeyDown };
}
