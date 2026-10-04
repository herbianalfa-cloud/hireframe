import { Skeleton } from '@/components/ui/skeleton';

import { useAgreement } from './hooks';
import { agreementText } from './labels';

/** Verdict agreement over the last 14 days with its split (PRD metric, ADR-038). */
export function AgreementLine({ refreshKey }: { refreshKey: number }) {
  const state = useAgreement(refreshKey);
  if (state.status === 'loading') {
    return <Skeleton role="status" aria-label="Loading agreement" className="h-5 w-3/4" />;
  }
  if (state.status === 'error') {
    return <p className="text-sm text-muted-foreground">{state.message}</p>;
  }
  return <p className="text-sm text-muted-foreground">{agreementText(state.data)}</p>;
}
