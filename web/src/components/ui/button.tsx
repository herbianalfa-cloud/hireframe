import { Slot } from '@radix-ui/react-slot';
import { cva, type VariantProps } from 'class-variance-authority';
import type { ComponentProps } from 'react';

import { cn } from '@/lib/utils';

// shadcn/ui Button, adapted to the Hireframe tokens. Sizes keep 44×44 px touch targets.
const buttonVariants = cva(
  'inline-flex shrink-0 items-center justify-center gap-2 rounded-md text-sm font-medium whitespace-nowrap transition-colors duration-150 ease-out disabled:pointer-events-none disabled:opacity-50 [&_svg]:size-4 [&_svg]:shrink-0',
  {
    variants: {
      variant: {
        default: 'bg-accent text-accent-foreground hover:bg-accent/90',
        secondary: 'border bg-surface-raised text-foreground hover:bg-surface-raised/70',
        // Solid text uses the page background: 8:1 on the dark green, 5:1 on the light one.
        apply: 'bg-verdict-apply text-background hover:bg-verdict-apply/90',
        applyOutline:
          'border border-verdict-apply bg-transparent text-verdict-apply hover:bg-verdict-apply/10',
        ghost: 'text-muted-foreground hover:bg-surface-raised hover:text-foreground',
        danger: 'border border-danger/50 bg-danger/10 text-danger hover:bg-danger/20',
      },
      size: {
        default: 'h-11 px-4',
        icon: 'size-11',
      },
    },
    defaultVariants: { variant: 'default', size: 'default' },
  },
);

type ButtonProps = ComponentProps<'button'> &
  VariantProps<typeof buttonVariants> & { asChild?: boolean };

export function Button({ className, variant, size, asChild = false, ...props }: ButtonProps) {
  const Comp = asChild ? Slot : 'button';
  return <Comp className={cn(buttonVariants({ variant, size, className }))} {...props} />;
}
