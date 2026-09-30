import type { ComponentProps } from 'react';

import { cn } from '@/lib/utils';

// shadcn/ui Textarea, adapted to the Hireframe tokens.
export function Textarea({ className, ...props }: ComponentProps<'textarea'>) {
  return (
    <textarea
      className={cn(
        'min-h-24 w-full rounded-md border bg-background px-3 py-2 text-sm text-foreground transition-colors duration-150 ease-out placeholder:text-muted-foreground disabled:opacity-50 aria-invalid:border-danger',
        className,
      )}
      {...props}
    />
  );
}
