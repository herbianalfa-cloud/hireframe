import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { pendingStateText } from '@/features/jobs/labels';
import { VerdictBadge } from '@/features/jobs/VerdictBadge';
import { formatDate } from '@/lib/format';
import type { JobView } from '@/services/jobs';

import { stageText } from './model';

/** What Lookup knows about a job it has seen: verdict or state, stage, dates, and a way in. */
export function SeenLine({ view, onOpen }: { view: JobView; onOpen: (jobId: string) => void }) {
  const { job } = view;
  const pending = pendingStateText(job);
  return (
    <div className="space-y-1">
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant="accent">Seen</Badge>
        {job.verdict ? <VerdictBadge verdict={job.verdict} /> : null}
        {pending ? <Badge>{pending}</Badge> : null}
        <span className="min-w-0 flex-1 text-sm font-medium">{job.title}</span>
        <Button
          variant="secondary"
          onClick={() => {
            onOpen(view.id);
          }}
        >
          Open job
          <span className="sr-only">: {job.title}</span>
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">
        {job.company} · {stageText(job.stage)} · first seen {formatDate(job.firstSeenAt)}
        {job.judgedAt ? ` · judged ${formatDate(job.judgedAt)}` : ''}
      </p>
    </div>
  );
}
