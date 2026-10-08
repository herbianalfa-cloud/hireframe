import { redactPii } from '@hireframe/shared';
import { logger } from 'firebase-functions';

/**
 * Structured logger for functions (docs/SECURITY.md "Sensitive data in logs").
 * - Event names come from a fixed list; fields are scalars only.
 * - Strings are redacted (emails, phone numbers) and truncated.
 * - Never pass CV text, fact text, job descriptions or raw error messages: log counts, codes
 *   and IDs instead. Tests assert that no fixture CV text ever reaches the log.
 */
export type LogEvent =
  | 'owner.denied'
  | 'owner.config_invalid'
  | 'callable.failed'
  | 'llm.called'
  | 'llm.failed'
  | 'llm.output_invalid'
  | 'llm.unknown_model_price'
  | 'llm.spend_cap'
  | 'parse_cv.started'
  | 'parse_cv.done'
  | 'parse_cv.failed'
  | 'parse_cv.duplicate'
  | 'add_fact.done'
  | 'profile.fact_invalid'
  | 'profile.reset'
  | 'http.retry'
  | 'http.failed'
  | 'http.robots_blocked'
  | 'http.host_paused'
  | 'http.forbidden_host'
  | 'scan.started'
  | 'scan.done'
  | 'scan.refused'
  | 'scan.waiting'
  | 'scan.failed'
  | 'source.done'
  | 'source.failed'
  | 'ingest.invalid_item'
  | 'ingest.write_failed'
  | 'dedupe.conflict'
  | 'watchlist.seeded'
  | 'store.invalid_doc'
  | 'ingest.keys_truncated'
  | 'scan.recovered'
  | 'funnel.started'
  | 'funnel.done'
  | 'funnel.failed'
  | 'funnel.review'
  | 'funnel.score_drift'
  | 'funnel.sweep_drift'
  | 'funnel.unsupported_match'
  | 'funnel.overrides_invalid'
  | 'hydrate.failed'
  | 'rescore.started'
  | 'rescore.done'
  | 'ingest.refused'
  | 'ingest.started'
  | 'ingest.done'
  | 'ingest.failed'
  | 'ingest.message'
  | 'ingest.parse_failed'
  | 'lookup.started'
  | 'lookup.done'
  | 'lookup.failed'
  | 'lookup.busy'
  | 'lookup.dropped'
  | 'lookup.ats_failed'
  | 'lookup.pauses_not_saved';

export type LogFields = Record<string, string | number | boolean>;
type Level = 'info' | 'warn' | 'error';
type Sink = (level: Level, event: LogEvent, fields: LogFields) => void;

const MAX_STRING = 200;

const defaultSink: Sink = (level, event, fields) => {
  logger[level](event, { event, ...fields });
};

let sink: Sink = defaultSink;

/** Tests capture log output through this; pass nothing to restore the real logger. */
export function setLogSink(next?: Sink): void {
  sink = next ?? defaultSink;
}

function sanitise(fields: LogFields): LogFields {
  return Object.fromEntries(
    Object.entries(fields).map(([key, value]) => [
      key,
      typeof value === 'string' ? redactPii(value).slice(0, MAX_STRING) : value,
    ]),
  );
}

export const log = {
  info: (event: LogEvent, fields: LogFields = {}) => {
    sink('info', event, sanitise(fields));
  },
  warn: (event: LogEvent, fields: LogFields = {}) => {
    sink('warn', event, sanitise(fields));
  },
  error: (event: LogEvent, fields: LogFields = {}) => {
    sink('error', event, sanitise(fields));
  },
};

/** A safe description of an unknown error: its class name and code, never its message. */
export function errorFields(error: unknown): LogFields {
  const fields: LogFields = { errorName: error instanceof Error ? error.name : typeof error };
  if (typeof error === 'object' && error !== null) {
    if ('code' in error && (typeof error.code === 'string' || typeof error.code === 'number')) {
      fields.errorCode = error.code;
    }
    if ('status' in error && typeof error.status === 'number') fields.status = error.status;
    if ('requestID' in error && typeof error.requestID === 'string') {
      fields.requestId = error.requestID;
    }
  }
  return fields;
}
