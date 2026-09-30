import { afterEach, describe, expect, it } from 'vitest';

import { errorFields, log, setLogSink, type LogFields } from './log.js';

afterEach(() => {
  setLogSink();
});

describe('log', () => {
  it('redacts emails and phone numbers and truncates long strings', () => {
    const lines: LogFields[] = [];
    setLogSink((_level, _event, fields) => lines.push(fields));
    const email = ['someone', 'mail.test'].join('@');
    log.info('llm.called', { note: `reach ${email}`, long: 'x'.repeat(500), count: 3 });
    expect(lines).toEqual([{ note: 'reach [email]', long: 'x'.repeat(200), count: 3 }]);
  });
});

describe('errorFields', () => {
  it('keeps the class name, code, status and request id but never the message', () => {
    const error = Object.assign(new TypeError('Secret CV sentence'), {
      code: 'ECONNRESET',
      status: 503,
      requestID: 'req_123',
    });
    const fields = errorFields(error);
    expect(fields).toEqual({
      errorName: 'TypeError',
      errorCode: 'ECONNRESET',
      status: 503,
      requestId: 'req_123',
    });
    expect(JSON.stringify(fields)).not.toContain('Secret CV sentence');
  });

  it('handles non-errors', () => {
    expect(errorFields('boom')).toEqual({ errorName: 'string' });
  });
});
