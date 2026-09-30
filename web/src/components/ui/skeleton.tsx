import type { ComponentProps } from 'react';

import { cn } from '@/lib/utils';

/** Loading placeholder. Decorative: pair a group of them with a labelled status region. */
export function Skeleton({ className, ...props }: ComponentProps<'div'>) {
  return (
    <div
      aria-hidden="true"
      className={cn('animate-pulse rounded-md bg-surface-raised', className)}
      {...props}
    />
  );
}
