import { spendMeter, type DigestState } from '@hireframe/shared';

import { APP_ORIGIN, FUNNEL } from '../config.js';
import { londonParts } from './state.js';

/**
 * The digest as `{ subject, html, text }` (ADR-052, PRD R9). Pure: the store's data goes in,
 * strings come out. One section model feeds both the HTML and the plain text, so they can't
 * disagree. Every job-derived string is HTML-escaped and stripped of URLs; links point only to
 * the app (`APP_ORIGIN/?job=<id>`), never to a posting. No images, no tracking.
 */

export interface DigestJobLine {
  id: string;
  title: string;
  company: string;
  fitScore?: number;
  luckScore?: number;
  reason?: string;
  shortfall?: string;
}

export interface DigestJobList {
  /** The jobs listed (at most `DIGEST.jobsPerVerdict`). */
  jobs: readonly DigestJobLine[];
  /** How many there are in all, so the digest can say "+n more". */
  total: number;
}

export interface DigestRunSummary {
  status: 'running' | 'succeeded' | 'partial' | 'failed';
  startedAt: Date;
  s2?: { in: number; passed: number; skipped: number; queued: number };
  s3?: {
    in: number;
    apply: number;
    near_miss: number;
    wildcard: number;
    skip: number;
    queued: number;
  };
  errors: readonly { sourceId?: string; code: string }[];
}

export interface DigestSourceLine {
  id: string;
  status: string;
  errorCode?: string;
}

/** Filled in by M7D; absent in 7B. */
export interface DigestPipeline {
  needsInput: number;
  generating: number;
  ready: number;
  appliedThisWeek: number;
  weeklyTarget: number;
}

export interface DigestInput {
  state: DigestState;
  /** The London day, `YYYY-MM-DD`. */
  day: string;
  /** The run's `partial` status adds a "some sources failed" notice. */
  partial: boolean;
  run?: DigestRunSummary;
  apply: DigestJobList;
  nearMiss: DigestJobList;
  wildcard: DigestJobList;
  sources: readonly DigestSourceLine[];
  waitingForDescription: number;
  spend: { spendPence: number; capPence: number };
  pipeline?: DigestPipeline;
}

export interface RenderedDigest {
  subject: string;
  html: string;
  text: string;
}

interface Line {
  text: string;
  href?: string;
}

interface Section {
  title: string;
  /** A sentence above the list. */
  notice?: string;
  lines: readonly Line[];
  /** Shown when there are no lines. */
  empty?: string;
}

const MAX_ERRORS = 10;
const MAX_SOURCES = 12;
const URLISH = /(?:https?:\/\/|www\.)\S*/gi;
const CONTROL = /[\u0000-\u001f\u007f\u2028\u2029]+/g;

/** Job-derived text as one clean line: no URLs, no control characters. */
export function cleanText(value: string): string {
  return value.replace(URLISH, '[link removed]').replace(CONTROL, ' ').replace(/\s+/g, ' ').trim();
}

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function jobLink(id: string): string {
  return `${APP_ORIGIN}/?job=${encodeURIComponent(id)}`;
}

function formatDay(day: string): string {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: 'UTC',
    weekday: 'short',
    day: 'numeric',
    month: 'short',
  }).format(new Date(`${day}T12:00:00Z`));
}

function formatTime(date: Date): string {
  const { minutes } = londonParts(date);
  return `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
}

function score(value: number | undefined): string | undefined {
  return value === undefined ? undefined : String(Math.round(value * 10) / 10);
}

function jobLine(job: DigestJobLine, kind: 'apply' | 'near_miss' | 'wildcard'): Line {
  const title = cleanText(job.title) || 'Untitled';
  const company = cleanText(job.company);
  const scores = [
    job.fitScore === undefined ? undefined : `fit ${score(job.fitScore) ?? ''}`,
    job.luckScore === undefined ? undefined : `luck ${score(job.luckScore) ?? ''}`,
  ].filter((part): part is string => part !== undefined);
  const why = cleanText((kind === 'near_miss' ? job.shortfall : job.reason) ?? '');
  const detail = [scores.join(' · '), why].filter((part) => part !== '').join(' — ');
  return {
    text: `${title}${company ? ` · ${company}` : ''}${detail ? ` (${detail})` : ''}`,
    href: jobLink(job.id),
  };
}

function jobSection(
  title: string,
  list: DigestJobList,
  kind: 'apply' | 'near_miss' | 'wildcard',
): Section {
  const lines = list.jobs.map((job) => jobLine(job, kind));
  const more = list.total - list.jobs.length;
  if (more > 0) lines.push({ text: `+${String(more)} more in the app`, href: APP_ORIGIN });
  return { title, lines, empty: 'None today' };
}

function runHealthSection(input: DigestInput): Section {
  const lines: Line[] = [];
  const { run } = input;
  if (run) {
    lines.push({ text: `Run: ${run.status}, started ${formatTime(run.startedAt)}` });
    if (run.s2) {
      const { s2 } = run;
      lines.push({
        text: `S2 (title and company check): ${String(s2.in)} in, ${String(s2.passed)} passed, ${String(s2.skipped)} skipped, ${String(s2.queued)} still queued`,
      });
    }
    if (run.s3) {
      const { s3 } = run;
      lines.push({
        text: `S3 (deep read): ${String(s3.in)} in, ${String(s3.apply)} apply, ${String(s3.near_miss)} near miss, ${String(s3.wildcard)} wildcard, ${String(s3.skip)} skip, ${String(s3.queued)} still queued`,
      });
    }
  }
  const failing = input.sources.filter((s) => s.status === 'failing' || s.status === 'degraded');
  for (const source of failing.slice(0, MAX_SOURCES)) {
    lines.push({
      text: `Source ${cleanText(source.id)}: ${cleanText(source.status)}${source.errorCode ? ` (${cleanText(source.errorCode)})` : ''}`,
    });
  }
  if (failing.length === 0) lines.push({ text: 'All sources healthy' });
  lines.push({
    text: `${String(input.waitingForDescription)} waiting for a description`,
  });
  return {
    title: 'Run health',
    notice: input.partial ? 'Some sources failed in this run.' : undefined,
    lines,
  };
}

function spendSection(spend: DigestInput['spend']): Section {
  const meter = spendMeter(spend.spendPence, spend.capPence);
  const percent = Math.round(meter.fraction * 100);
  const lines: Line[] = [
    {
      text: `${String(Math.round(spend.spendPence))}p of ${String(Math.round(spend.capPence))}p this month (${String(percent)}%)`,
    },
  ];
  if (meter.level === 'capped') {
    lines.push({ text: 'Monthly cap reached: AI calls are stopped until next month' });
  } else if (meter.level === 'warn') {
    lines.push({ text: 'Warning: 80% of the monthly cap is used' });
  }
  if (meter.fraction >= FUNNEL.deepPauseAtFraction) {
    lines.push({ text: 'Deep reads are paused' });
  }
  return { title: 'Spend', lines };
}

function errorsSection(run: DigestRunSummary | undefined): Section {
  const errors = run?.errors ?? [];
  const lines: Line[] = errors.slice(0, MAX_ERRORS).map((error) => ({
    text: `${error.sourceId ? `${cleanText(error.sourceId)}: ` : ''}${cleanText(error.code)}`,
  }));
  if (errors.length > MAX_ERRORS) {
    lines.push({ text: `+${String(errors.length - MAX_ERRORS)} more on the System screen` });
  }
  return { title: 'Errors', lines, empty: 'None today' };
}

function pipelineSection(pipeline: DigestPipeline): Section {
  return {
    title: 'Pipeline',
    lines: [
      {
        text: `${String(pipeline.needsInput)} need your input · ${String(pipeline.generating)} generating · ${String(pipeline.ready)} ready to send · ${String(pipeline.appliedThisWeek)} applied this week of ${String(pipeline.weeklyTarget)}`,
        href: `${APP_ORIGIN}/pipeline`,
      },
    ],
  };
}

const NOTICES: Record<Exclude<DigestState, 'ready'>, string> = {
  in_progress: "Today's scan has not finished yet. This digest will not include its results.",
  failed: "Today's scan failed or was cut off, so there are no new results in this digest.",
  missing: 'No scan started this morning, so there are no new results in this digest.',
};

function sectionsFor(input: DigestInput): Section[] {
  const sections: Section[] = [];
  if (input.state === 'ready') {
    sections.push(
      jobSection('Apply', input.apply, 'apply'),
      jobSection('Near misses', input.nearMiss, 'near_miss'),
      jobSection('Wildcards', input.wildcard, 'wildcard'),
    );
  } else {
    sections.push({ title: 'Status', lines: [{ text: NOTICES[input.state] }] });
  }
  if (input.state !== 'in_progress' && input.state !== 'missing') {
    sections.push(runHealthSection(input));
  }
  sections.push(spendSection(input.spend));
  if (input.state !== 'in_progress' && input.state !== 'missing') {
    sections.push(errorsSection(input.run));
  }
  if (input.pipeline) sections.push(pipelineSection(input.pipeline));
  return sections;
}

function subjectFor(input: DigestInput): string {
  const day = formatDay(input.day);
  switch (input.state) {
    case 'ready':
      return `Hireframe ${day}: ${String(input.apply.total)} apply, ${String(input.nearMiss.total)} near miss, ${String(input.wildcard.total)} wildcard`;
    case 'in_progress':
      return `Hireframe ${day}: scan still running`;
    case 'failed':
      return `Hireframe ${day}: scan failed`;
    case 'missing':
      return `Hireframe ${day}: no scan this morning`;
  }
}

function renderHtml(subject: string, sections: readonly Section[]): string {
  const body = sections
    .map((section) => {
      const items = section.lines
        .map((line) =>
          line.href
            ? `<li><a href="${escapeHtml(line.href)}">${escapeHtml(line.text)}</a></li>`
            : `<li>${escapeHtml(line.text)}</li>`,
        )
        .join('');
      const list =
        section.lines.length > 0
          ? `<ul style="margin:0 0 0 18px;padding:0">${items}</ul>`
          : `<p style="margin:0">${escapeHtml(section.empty ?? 'None today')}</p>`;
      const notice = section.notice
        ? `<p style="margin:0 0 4px"><strong>${escapeHtml(section.notice)}</strong></p>`
        : '';
      return `<h2 style="font-size:16px;margin:20px 0 6px">${escapeHtml(section.title)}</h2>${notice}${list}`;
    })
    .join('');
  return `<!doctype html><html lang="en-GB"><head><meta charset="utf-8"><title>${escapeHtml(subject)}</title></head><body style="font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.45;color:#1a1a1a;max-width:640px;margin:0 auto;padding:16px"><h1 style="font-size:20px;margin:0 0 4px">${escapeHtml(subject)}</h1>${body}<p style="margin:24px 0 0"><a href="${escapeHtml(APP_ORIGIN)}">Open Hireframe</a></p></body></html>`;
}

function renderText(subject: string, sections: readonly Section[]): string {
  const parts = sections.map((section) => {
    const lines = section.lines.map((line) => `- ${line.text}${line.href ? ` ${line.href}` : ''}`);
    const body = lines.length > 0 ? lines : [section.empty ?? 'None today'];
    return [section.title.toUpperCase(), ...(section.notice ? [section.notice] : []), ...body].join(
      '\n',
    );
  });
  return [subject, ...parts, `Open Hireframe: ${APP_ORIGIN}`].join('\n\n');
}

export function renderDigest(input: DigestInput): RenderedDigest {
  const subject = subjectFor(input);
  const sections = sectionsFor(input);
  return { subject, html: renderHtml(subject, sections), text: renderText(subject, sections) };
}
