import { cva, type VariantProps } from 'class-variance-authority';
import type { ComponentProps } from 'react';

import { cn } from '@/lib/utils';

// shadcn/ui Badge, adapted to the Hireframe tokens. Colour is never the only signal:
// callers put an icon or text next to every coloured badge.
const badgeVariants = cva(
  'inline-flex items-center gap-1 rounded-sm border px-2 py-0.5 text-xs font-medium [&_svg]:size-3 [&_svg]:shrink-0',
  {
    variants: {
      variant: {
        default: 'bg-surface-raised text-muted-foreground',
        accent: 'border-accent/40 bg-accent/10 text-accent',
        success: 'border-verdict-apply/40 bg-verdict-apply/10 text-verdict-apply',
        warning: 'border-verdict-near-miss/40 bg-verdict-near-miss/10 text-verdict-near-miss',
        danger: 'border-danger/40 bg-danger/10 text-danger',
      },
    },
    defaultVariants: { variant: 'default' },
  },
);

type BadgeProps = ComponentProps<'span'> & VariantProps<typeof badgeVariants>;

export function Badge({ className, variant, ...props }: BadgeProps) {
  return <span className={cn(badgeVariants({ variant }), className)} {...props} />;
}
