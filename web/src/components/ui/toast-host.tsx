import { lazy, Suspense, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';

import { getToast, subscribeToasts } from '@/lib/toast';

const ToastCard = lazy(() => import('./toast-card'));

/**
 * Where toasts appear. The live region is always mounted (so a screen reader announces text
 * added to it) and sits in its own body child, outside the app root, so an open dialog neither
 * hides it nor blocks the pointer. On a phone it clears the bottom tab bar (min-h-14 plus the
 * safe-area inset, see Shell); from `md` up the sidebar takes the left 15rem.
 */
export function ToastHost() {
  const toast = useSyncExternalStore(subscribeToasts, getToast, getToast);
  return createPortal(
    <div
      role="status"
      aria-live="polite"
      aria-atomic="true"
      data-toast-region
      className="pointer-events-none fixed inset-x-0 bottom-[calc(4.5rem+env(safe-area-inset-bottom))] z-[60] flex justify-center px-4 md:bottom-6 md:left-60"
    >
      <Suspense fallback={null}>
        {toast ? <ToastCard key={toast.id} toast={toast} /> : null}
      </Suspense>
    </div>,
    document.body,
  );
}
