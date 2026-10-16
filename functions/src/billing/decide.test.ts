import { describe, expect, it } from 'vitest';

import { decideGuard } from './decide.js';
import { parseBudgetMessage, type BudgetMessage } from './schema.js';

function message(overrides: Record<string, unknown> = {}): BudgetMessage {
  return {
    budgetDisplayName: 'hireframe-kill',
    costAmount: 1,
    budgetAmount: 25,
    currencyCode: 'GBP',
    costIntervalStart: '2026-10-01T00:00:00Z',
    ...overrides,
  };
}

function encode(value: unknown): string {
  return Buffer.from(typeof value === 'string' ? value : JSON.stringify(value)).toString('base64');
}

describe('decideGuard (ADR-059)', () => {
  it('is below when the cost is under the budget', () => {
    expect(decideGuard(message({ costAmount: 24.99 }), 'armed')).toEqual({ outcome: 'below' });
  });

  it('acts when the cost equals the budget', () => {
    expect(decideGuard(message({ costAmount: 25 }), 'armed')).toEqual({ outcome: 'disable' });
  });

  it('acts when the cost is above the budget', () => {
    expect(decideGuard(message({ costAmount: 30 }), 'armed')).toEqual({ outcome: 'disable' });
  });

  it('only says would_disable in dry run', () => {
    expect(decideGuard(message({ costAmount: 25 }), 'dry_run')).toEqual({
      outcome: 'would_disable',
    });
    expect(decideGuard(message({ costAmount: 1 }), 'dry_run')).toEqual({ outcome: 'below' });
  });

  it('ignores another budget, however high its cost', () => {
    expect(
      decideGuard(message({ budgetDisplayName: 'hireframe-5', costAmount: 99 }), 'armed'),
    ).toEqual({
      outcome: 'ignored',
      reason: 'wrong_budget',
    });
  });

  it('ignores another currency, however high the cost', () => {
    expect(decideGuard(message({ currencyCode: 'USD', costAmount: 99 }), 'armed')).toEqual({
      outcome: 'ignored',
      reason: 'wrong_currency',
    });
  });

  it('ignores a forecast: forecast set, cost below', () => {
    const forecast = message({
      costAmount: 3,
      forecastThresholdExceeded: 1.5,
      alertThresholdExceeded: 1,
    });
    expect(decideGuard(forecast, 'armed')).toEqual({ outcome: 'below' });
  });

  it('tolerates extra fields', () => {
    expect(decideGuard(message({ costAmount: 25, somethingNew: { a: 1 } }), 'armed')).toEqual({
      outcome: 'disable',
    });
  });
});

describe('parseBudgetMessage', () => {
  it('parses a valid message and keeps extra fields', () => {
    const parsed = parseBudgetMessage(encode({ ...message(), schemaVersion: '1.0' }));
    expect(parsed).toMatchObject({ costAmount: 1, schemaVersion: '1.0' });
  });

  it('accepts the optional threshold fields', () => {
    const parsed = parseBudgetMessage(
      encode(message({ alertThresholdExceeded: 0.5, forecastThresholdExceeded: 1 })),
    );
    expect(parsed).not.toBeNull();
  });

  it.each([
    ['not base64 json', '!!!not-base64!!!'],
    ['valid base64 of non-JSON', encode('hello')],
    ['a JSON array', encode([1, 2])],
    ['JSON null', encode('null')],
    ['empty', ''],
    ['too large', 'A'.repeat(20_000)],
    ['undefined (an attributes-only message)', undefined],
    ['null', null],
    ['a number', 42],
  ])('rejects %s', (_label, data) => {
    expect(parseBudgetMessage(data)).toBeNull();
  });

  it.each(['budgetDisplayName', 'costAmount', 'budgetAmount', 'currencyCode', 'costIntervalStart'])(
    'rejects a message without %s',
    (field) => {
      const rest = Object.fromEntries(Object.entries(message()).filter(([key]) => key !== field));
      expect(parseBudgetMessage(encode(rest))).toBeNull();
    },
  );

  it('rejects amounts that overflow to Infinity in raw JSON', () => {
    const raw = (cost: string, budget: string) =>
      encode(
        `{"budgetDisplayName":"b","costAmount":${cost},"budgetAmount":${budget},"currencyCode":"GBP","costIntervalStart":"2026-10-01T00:00:00Z"}`,
      );
    expect(parseBudgetMessage(raw('1e999', '25'))).toBeNull();
    expect(parseBudgetMessage(raw('1', '1e999'))).toBeNull();
    expect(parseBudgetMessage(raw('1', '25'))).not.toBeNull();
  });

  it.each([
    ['a negative cost', { costAmount: -1 }],
    ['a NaN cost', { costAmount: 'NaN' }],
    ['a string cost', { costAmount: '30' }],
    ['a null cost', { costAmount: null }],
    ['a zero budget', { budgetAmount: 0 }],
    ['a negative budget', { budgetAmount: -25 }],
    ['an empty name', { budgetDisplayName: '' }],
    ['a numeric currency', { currencyCode: 826 }],
  ])('rejects %s', (_label, overrides) => {
    expect(parseBudgetMessage(encode(message(overrides)))).toBeNull();
  });
});
