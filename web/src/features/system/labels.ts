import type { RunStatus, ScanNowResult, ScanSourceId, SourceStatus } from '@hireframe/shared';

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
  const summary = `Scan finished: ${plural(s0.new, 'new job', 'new jobs')}, ${String(s0.merged)} merged into known jobs, ${String(s0.duplicate)} already known.`;
  if (runStatus === 'succeeded') return summary;
  if (runStatus === 'failed') return `${summary} Every source failed; see below.`;
  return `${summary} Some sources had problems; see below.`;
}
