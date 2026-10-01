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
  | 'add_fact.done'
  | 'profile.fact_invalid';

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
