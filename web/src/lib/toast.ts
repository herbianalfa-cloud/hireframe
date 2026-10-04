/**
 * A one-slot toast store, small enough to live in the main bundle. The card that renders it is
 * a lazy chunk (components/ui/toast-host.tsx), so nothing loads until the first action.
 */
export interface ToastInput {
  message: string;
  tone?: 'info' | 'error';
  /** An optional single action, e.g. Undo. */
  action?: { label: string; run: () => void };
}

export interface Toast extends ToastInput {
  id: number;
}

let current: Toast | null = null;
let nextId = 1;
const listeners = new Set<() => void>();

function emit(): void {
  listeners.forEach((listener) => {
    listener();
  });
}

/** Shows a toast, replacing any current one. Returns its id. */
export function showToast(input: ToastInput): number {
  const id = nextId++;
  current = { ...input, id };
  emit();
  return id;
}

/** Dismisses the toast with this id (a newer toast is left alone). */
export function dismissToast(id: number): void {
  if (current?.id !== id) return;
  current = null;
  emit();
}

export function getToast(): Toast | null {
  return current;
}

export function subscribeToasts(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
