import { useEffect, useState } from 'react';

import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { dismissToast, type Toast } from '@/lib/toast';

const SHOW_MS = 5000;
/** A toast with an action stays longer, so there is time to reach it (WCAG 2.2.1). */
const SHOW_WITH_ACTION_MS = 8000;

/** The visible toast. Never takes focus; a timer dismisses it unless the pointer or focus is on it. */
export default function ToastCard({ toast }: { toast: Toast }) {
  const [held, setHeld] = useState(false);
  useEffect(() => {
    if (held) return;
    const timer = setTimeout(
      () => {
        dismissToast(toast.id);
      },
      toast.action ? SHOW_WITH_ACTION_MS : SHOW_MS,
    );
    return () => {
      clearTimeout(timer);
    };
  }, [toast, held]);

  const { action } = toast;
  return (
    <div
      role={toast.tone === 'error' ? 'alert' : undefined}
      onPointerEnter={() => {
        setHeld(true);
      }}
      onPointerLeave={() => {
        setHeld(false);
      }}
      onFocus={() => {
        setHeld(true);
      }}
      onBlur={() => {
        setHeld(false);
      }}
      className={cn(
        'pointer-events-auto flex min-h-11 max-w-sm items-center gap-3 rounded-lg border bg-surface-raised py-1 pr-1 pl-4 text-sm shadow-lg',
        toast.tone === 'error' && 'border-danger/50 text-danger',
      )}
    >
      <span className="flex-1">{toast.message}</span>
      {action ? (
        <Button
          variant="ghost"
          onClick={() => {
            dismissToast(toast.id);
            action.run();
          }}
        >
          {action.label}
        </Button>
      ) : null}
    </div>
  );
}
