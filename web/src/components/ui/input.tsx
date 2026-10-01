import type { ComponentProps } from 'react';

import { cn } from '@/lib/utils';

// shadcn/ui Input, adapted to the Hireframe tokens. h-11 keeps the 44 px touch target.
export function Input({ className, type = 'text', ...props }: ComponentProps<'input'>) {
  return (
    <input
      type={type}
      className={cn(
        'h-11 w-full min-w-0 rounded-md border bg-background px-3 text-sm text-foreground transition-colors duration-150 ease-out placeholder:text-muted-foreground disabled:opacity-50 aria-invalid:border-danger',
        className,
      )}
      {...props}
    />
  );
}
