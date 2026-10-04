import type { Verdict } from '@hireframe/shared';

import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';

import { VERDICT_CLASSES, VERDICT_ICONS, VERDICT_LABELS } from './labels';

export function VerdictBadge({ verdict }: { verdict: Verdict }) {
  const Icon = VERDICT_ICONS[verdict];
  return (
    <Badge className={cn(VERDICT_CLASSES[verdict])}>
      <Icon aria-hidden="true" />
      {VERDICT_LABELS[verdict]}
    </Badge>
  );
}
