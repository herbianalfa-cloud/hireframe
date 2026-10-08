import { TriangleAlert } from 'lucide-react';

import { Skeleton } from '@/components/ui/skeleton';
import { percentText, poundsText } from '@/features/jobs/labels';

import { useSpend } from './hooks';

/**
 * This month's AI spend against the cap; amber from 80% (PRD R11). Used on System, and in its
 * compact form as the chip in Today's summary bar.
 */
export function SpendMeter({ compact = false }: { compact?: boolean }) {
  const state = useSpend();
  if (state.status === 'loading') {
    return (
      <Skeleton role="status" aria-label="Loading spend" className={compact ? 'h-6' : 'h-12'} />
    );
  }
  if (state.status === 'error') {
    return <p className="text-sm text-muted-foreground">{state.message}</p>;
  }
  const { meter } = state.data;
  const colour =
    meter.level === 'ok'
      ? 'bg-accent'
      : meter.level === 'warn'
        ? 'bg-verdict-near-miss'
        : 'bg-danger';
  if (compact) {
    const warn = meter.level !== 'ok';
    return (
      <div className="flex items-center gap-2 text-sm">
        {warn ? (
          <TriangleAlert
            aria-hidden="true"
            className={`size-4 ${meter.level === 'warn' ? 'text-verdict-near-miss' : 'text-danger'}`}
          />
        ) : null}
        <span className="font-mono tabular-nums">
          {poundsText(meter.spendPence)}
          <span className="text-muted-foreground"> of {poundsText(meter.capPence)}</span>
        </span>
        <div
          role="progressbar"
          aria-label="AI spend this month"
          aria-valuemin={0}
          aria-valuemax={meter.capPence}
          aria-valuenow={Math.min(meter.spendPence, meter.capPence)}
          aria-valuetext={`${poundsText(meter.spendPence)} of ${poundsText(meter.capPence)}`}
          className="h-1.5 w-16 overflow-hidden rounded-full bg-surface-raised"
        >
          <div className={`h-full ${colour}`} style={{ width: percentText(meter.fraction) }} />
        </div>
        {warn ? (
          <span className={meter.level === 'warn' ? 'text-verdict-near-miss' : 'text-danger'}>
            {meter.level === 'warn' ? `${percentText(meter.fraction)} used` : 'Cap reached'}
          </span>
        ) : null}
      </div>
    );
  }
  return (
    <div>
      <p className="font-mono text-2xl tabular-nums">
        {poundsText(meter.spendPence)}
        <span className="text-sm text-muted-foreground"> of {poundsText(meter.capPence)}</span>
      </p>
      <div
        role="progressbar"
        aria-label="AI spend this month"
        aria-valuemin={0}
        aria-valuemax={meter.capPence}
        aria-valuenow={Math.min(meter.spendPence, meter.capPence)}
        aria-valuetext={`${poundsText(meter.spendPence)} of ${poundsText(meter.capPence)}`}
        className="mt-2 h-2 overflow-hidden rounded-full bg-surface-raised"
      >
        <div className={`h-full ${colour}`} style={{ width: percentText(meter.fraction) }} />
      </div>
      {meter.level !== 'ok' ? (
        <p
          className={`mt-2 flex items-center gap-1 text-xs ${
            meter.level === 'warn' ? 'text-verdict-near-miss' : 'text-danger'
          }`}
        >
          <TriangleAlert aria-hidden="true" className="size-3" />
          {meter.level === 'warn'
            ? `${percentText(meter.fraction)} of the monthly cap used`
            : 'Monthly cap reached: deep reads are paused'}
        </p>
      ) : null}
    </div>
  );
}
