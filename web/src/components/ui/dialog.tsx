import * as DialogPrimitive from '@radix-ui/react-dialog';
import { X } from 'lucide-react';
import type { ComponentProps } from 'react';

import { cn } from '@/lib/utils';

// shadcn/ui Dialog (Radix), adapted to the Hireframe tokens. `side="right"` renders it as a
// sheet (full width on phones), used for the fact history.
export const Dialog = DialogPrimitive.Root;
export const DialogTitle = ({
  className,
  ...props
}: ComponentProps<typeof DialogPrimitive.Title>) => (
  <DialogPrimitive.Title className={cn('pr-10 text-base font-semibold', className)} {...props} />
);
export const DialogDescription = ({
  className,
  ...props
}: ComponentProps<typeof DialogPrimitive.Description>) => (
  <DialogPrimitive.Description
    className={cn('mt-1 text-sm text-muted-foreground', className)}
    {...props}
  />
);

export function DialogContent({
  className,
  children,
  side = 'center',
  ...props
}: ComponentProps<typeof DialogPrimitive.Content> & { side?: 'center' | 'right' }) {
  return (
    <DialogPrimitive.Portal>
      <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-background/80 backdrop-blur-sm" />
      <DialogPrimitive.Content
        className={cn(
          'fixed z-50 overflow-y-auto border bg-surface p-5 shadow-lg md:p-6',
          side === 'center'
            ? 'top-1/2 left-1/2 max-h-[90dvh] w-[calc(100%-2rem)] max-w-lg -translate-x-1/2 -translate-y-1/2 rounded-lg'
            : 'inset-y-0 right-0 w-full max-w-md border-y-0 border-r-0',
          className,
        )}
        {...props}
      >
        {children}
        <DialogPrimitive.Close
          aria-label="Close"
          className="absolute top-2 right-2 inline-flex size-11 items-center justify-center rounded-md text-muted-foreground transition-colors duration-150 ease-out hover:bg-surface-raised hover:text-foreground"
        >
          <X aria-hidden="true" className="size-4" />
        </DialogPrimitive.Close>
      </DialogPrimitive.Content>
    </DialogPrimitive.Portal>
  );
}
