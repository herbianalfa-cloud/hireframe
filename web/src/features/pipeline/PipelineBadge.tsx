import type { TodoCount } from '@/services/pipeline-todo';

/** The count as text: "3", "50+". Empty at 0, so the badge shows nothing. */
export function todoText(state: TodoCount): string {
  if (state.status !== 'ready' || state.count === 0) return '';
  return `${String(state.count)}${state.capped ? '+' : ''}`;
}

/** The nav link's accessible name: "Pipeline, 3 to do". Just "Pipeline" while loading or at 0. */
export function pipelineLabel(label: string, state: TodoCount): string {
  if (state.status === 'error') return `${label}, to-do count unavailable`;
  const text = todoText(state);
  return text ? `${label}, ${text} to do` : label;
}

/**
 * The pipeline count beside a nav item. A small skeleton until it is read, a number from 1, "–"
 * when the read failed, nothing at 0. Decorative for assistive tech: the link's own name carries
 * the count (`pipelineLabel`).
 */
export function PipelineBadge({ state }: { state: TodoCount }) {
  if (state.status === 'loading') {
    return (
      <span
        aria-hidden="true"
        data-testid="pipeline-badge-skeleton"
        className="inline-block h-4 w-5 animate-pulse rounded-full bg-muted"
      />
    );
  }
  if (state.status === 'error') {
    return (
      <span
        aria-hidden="true"
        className="inline-flex h-4 min-w-5 items-center justify-center rounded-full border px-1 font-mono text-[11px] leading-none text-muted-foreground"
      >
        –
      </span>
    );
  }
  const text = todoText(state);
  if (!text) return null;
  return (
    <span
      aria-hidden="true"
      className="inline-flex h-4 min-w-5 items-center justify-center rounded-full border bg-surface-raised px-1 font-mono text-[11px] leading-none text-foreground tabular-nums"
    >
      {text}
    </span>
  );
}
