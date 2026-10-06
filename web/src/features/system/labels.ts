import {
  isRunStalled,
  type FunnelSummary,
  type RescoreCounts,
  type Run,
  type RunStatus,
  type RunTrigger,
  type ScanNowResult,
  type ScanSourceId,
  type SourceStatus,
  type SourceHealth,
  type StopReason,
} from '@hireframe/shared';

export const SOURCE_LABELS: Readonly<Record<ScanSourceId, string>> = {
  greenhouse: 'Greenhouse',
  lever: 'Lever',
  ashby: 'Ashby',
  workable: 'Workable',
  reed: 'Reed',
  adzuna: 'Adzuna',
  hn: 'HN Who is hiring',
};

export const SOURCE_STATUS_LABELS: Readonly<Record<SourceStatus, string>> = {
  ok: 'OK',
  degraded: 'Degraded',
  failing: 'Failing',
  disabled: 'Off',
  skipped: 'Skipped',
};

export const RUN_STATUS_LABELS: Readonly<Record<RunStatus, string>> = {
  running: 'Running',
  succeeded: 'Succeeded',
  partial: 'Partial',
  failed: 'Failed',
};

export const RUN_TRIGGER_LABELS: Readonly<Record<RunTrigger, string>> = {
  manual: 'Scan now',
  schedule: 'Scheduled',
  rescore: 'Re-score',
};

/** Why the AI stages stopped early (ADR-032). */
export const STOP_TEXT: Readonly<Record<StopReason, string>> = {
  run_budget: 'run budget used; the rest waits for the next run',
  monthly_cap: 'monthly AI cap reached',
  deep_pause: 'deep reads paused near the monthly cap',
  deadline: 'out of time; the rest waits for the next run',
  no_criteria: 'no criteria yet',
  no_profile: 'no profile facts yet',
  model_errors: 'the AI service kept failing; the rest waits for the next run',
};

/** Pence with up to one decimal: "0.4p", "18p". */
export function penceText(pence: number): string {
  const rounded = Math.round(pence * 10) / 10;
  return `${rounded.toFixed(rounded < 10 && rounded % 1 !== 0 ? 1 : 0)}p`;
}

/** One line for the funnel part of a run (PRD R12: counts per stage and cost). */
export function funnelText(run: Run): string | null {
  const { s1, s2, s3 } = run.perStage;
  if (!s1 && !s2 && !s3) return null;
  const parts = [
    s1 ? `S1 ${String(s1.passed)} passed, ${String(s1.skipped)} skipped` : null,
    s2 ? `S2 ${String(s2.passed)} passed, ${String(s2.skipped + s2.expired)} skipped` : null,
    s3
      ? `S3 ${String(s3.apply)} apply, ${String(s3.near_miss)} near miss, ${String(s3.wildcard)} wildcard, ${String(s3.skip + s3.expired)} skip`
      : null,
  ].filter((part): part is string => part !== null);
  const queued = (s2?.queued ?? 0) + (s3?.queued ?? 0);
  const review = (s2?.review ?? 0) + (s3?.review ?? 0);
  if (queued > 0) parts.push(`${String(queued)} queued`);
  if (s3?.needsDescription) parts.push(`${String(s3.needsDescription)} waiting for a description`);
  if (review > 0) parts.push(`${String(review)} for review`);
  parts.push(penceText(run.costPence));
  return parts.join(' · ');
}

export function rescoreText(counts: RescoreCounts): string {
  const back = counts.queuedS2 + counts.queuedS3;
  return [
    plural(counts.jobs, 'job', 'jobs'),
    `${String(counts.s1Changed)} changed by rules`,
    `${String(counts.recomputed)} re-scored without AI`,
    `${String(back)} sent back to the AI`,
    `${String(counts.unchanged)} unchanged`,
  ].join(' · ');
}

function funnelResultText(funnel: FunnelSummary): string {
  const verdicts = `${String(funnel.s3.apply)} to apply, ${String(funnel.s3.near_miss)} near misses, ${String(funnel.s3.wildcard)} wildcards`;
  const queued = funnel.queued.s2 + funnel.queued.s3;
  return [
    ` Funnel: ${verdicts}, ${penceText(funnel.costPence)}.`,
    queued > 0 ? ` ${plural(queued, 'job waits', 'jobs wait')} for the next run.` : '',
    funnel.stoppedBy ? ` Stopped early: ${STOP_TEXT[funnel.stoppedBy]}.` : '',
  ].join('');
}

/** Plain-English reasons for the error codes a source or board can record. */
const ERROR_TEXT: Readonly<Record<string, string>> = {
  not_found: 'a board no longer exists',
  http_status: 'the site returned an error',
  rate_limited: 'the site asked us to slow down',
  timeout: 'the site timed out',
  network: 'the site could not be reached',
  invalid_json: 'the site sent something unexpected',
  schema: 'the response changed shape',
  too_large: 'the response was too large',
  robots_disallowed: 'robots.txt does not allow it',
  deadline: 'the scan ran out of time',
  host_paused: 'the site asked us to pause',
  no_key: 'API key missing',
  no_criteria: 'no criteria yet',
  quota_used: 'API quota used up for now',
  no_thread: 'no hiring thread found',
  disabled: 'turned off in config/app',
  internal: 'an internal error',
  funnel_failed: 'the funnel failed',
  funnel_write_failed: 'some verdicts could not be saved',
  funnel_sweep_failed: 'the clean-up of stale queued jobs failed; it will retry next run',
  unparsed: 'some alert emails could not be read; the sender may have changed its layout',
  deferred: 'some alert emails are waiting for the daily AI limit or the next try',
};

export function errorText(code: string | undefined): string | null {
  if (!code) return null;
  return ERROR_TEXT[code] ?? code.replace(/_/g, ' ');
}

function plural(n: number, one: string, many: string): string {
  return `${String(n)} ${n === 1 ? one : many}`;
}

/** What Scan now reports back. */
export function scanResultText(result: ScanNowResult, now: Date): string {
  if (result.status === 'skipped_recent') {
    const minutes = Math.max(
      0,
      Math.round((now.getTime() - Date.parse(result.lastFinishedAt)) / 60_000),
    );
    const ago = minutes < 1 ? 'moments ago' : `${plural(minutes, 'minute', 'minutes')} ago`;
    return `The last scan finished ${ago}, so this one was skipped. Try again in ${plural(result.retryAfterSeconds, 'second', 'seconds')}.`;
  }
  const { s0, runStatus } = result;
  const summary = `Scan finished: ${plural(s0.new, 'new job', 'new jobs')}, ${String(s0.merged)} merged into known jobs, ${String(s0.duplicate)} already known.${
    result.funnel ? funnelResultText(result.funnel) : ''
  }`;
  if (runStatus === 'succeeded') return summary;
  if (runStatus === 'failed') return `${summary} Every source failed; see below.`;
  return `${summary} Some sources had problems; see below.`;
}

export interface SystemAlert {
  id: string;
  level: 'warning' | 'danger';
  text: string;
}

/**
 * Error alerts for System (PRD R12), from what the screen already reads: failing sources, the
 * latest run's outcome and its spend flags. Pure, so it is tested without Firestore.
 */
export function systemAlerts(input: {
  sources: readonly { id: ScanSourceId; health: SourceHealth }[];
  /** Newest first. */
  runs: readonly { id: string; run: Run }[];
  now: Date;
}): SystemAlert[] {
  const alerts: SystemAlert[] = [];
  for (const { id, health } of input.sources) {
    if (health.status !== 'failing' && health.status !== 'degraded') continue;
    const why = errorText(health.lastErrorCode);
    alerts.push({
      id: `source:${id}`,
      level: health.status === 'failing' ? 'danger' : 'warning',
      text: `${SOURCE_LABELS[id]} is ${SOURCE_STATUS_LABELS[health.status].toLowerCase()}${
        why ? `: ${why}` : ''
      }.`,
    });
  }
  const latest = input.runs[0];
  if (latest) {
    const { run } = latest;
    if (isRunStalled(run, input.now)) {
      alerts.push({
        id: `run:${latest.id}`,
        level: 'danger',
        text: 'The latest run was stopped before it finished.',
      });
    } else if (run.status === 'failed') {
      alerts.push({ id: `run:${latest.id}`, level: 'danger', text: 'The latest run failed.' });
    } else if (run.status === 'partial') {
      alerts.push({
        id: `run:${latest.id}`,
        level: 'warning',
        text: 'The latest run finished only in part. Recent runs below has the detail.',
      });
    }
    const flags = run.flags ?? [];
    if (flags.includes('spend_80')) {
      alerts.push({
        id: 'spend:80',
        level: 'warning',
        text: '80% of the monthly AI cap is used.',
      });
    }
    if (flags.includes('deep_pause')) {
      alerts.push({
        id: 'spend:pause',
        level: 'warning',
        text: 'Deep reads are paused near the monthly cap.',
      });
    }
  }
  return alerts;
}
