import type { ComponentProps } from 'react';

import { cn } from '@/lib/utils';

// shadcn/ui Label: a native <label>, so the control is named and clicking it focuses the control.
export function Label({ className, ...props }: ComponentProps<'label'>) {
  return <label className={cn('text-sm font-medium text-foreground', className)} {...props} />;
}
