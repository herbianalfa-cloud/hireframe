import { describe, expect, it } from 'vitest';

import { decideGuard, type GuardContext } from './decide.js';
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

/** The clock sits in October 2026, the month of `message()`'s costIntervalStart. */
const NOW = Date.parse('2026-10-19T10:00:00Z');
const ctx = (overrides: Partial<GuardContext> = {}): GuardContext => ({ now: NOW, ...overrides });

function encode(value: unknown): string {
  return Buffer.from(typeof value === 'string' ? value : JSON.stringify(value)).toString('base64');
}

describe('decideGuard (ADR-059)', () => {
  it('is below when the cost is under the budget', () => {
    expect(decideGuard(message({ costAmount: 24.99 }), 'armed', ctx())).toEqual({
      outcome: 'below',
    });
  });

  it('acts when the cost equals the budget', () => {
    expect(decideGuard(message({ costAmount: 25 }), 'armed', ctx())).toEqual({
      outcome: 'disable',
    });
  });

  it('acts when the cost is above the budget', () => {
    expect(decideGuard(message({ costAmount: 30 }), 'armed', ctx())).toEqual({
      outcome: 'disable',
    });
  });

  it('only says would_disable in dry run', () => {
    expect(decideGuard(message({ costAmount: 25 }), 'dry_run', ctx())).toEqual({
      outcome: 'would_disable',
    });
    expect(decideGuard(message({ costAmount: 1 }), 'dry_run', ctx())).toEqual({ outcome: 'below' });
  });

  it('ignores another budget, however high its cost', () => {
    expect(
      decideGuard(message({ budgetDisplayName: 'hireframe-5', costAmount: 99 }), 'armed', ctx()),
    ).toEqual({
      outcome: 'ignored',
      reason: 'wrong_budget',
    });
  });

  it('ignores another currency, however high the cost', () => {
    expect(decideGuard(message({ currencyCode: 'USD', costAmount: 99 }), 'armed', ctx())).toEqual({
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
    expect(decideGuard(forecast, 'armed', ctx())).toEqual({ outcome: 'below' });
  });

  it('tolerates extra fields', () => {
    expect(
      decideGuard(message({ costAmount: 25, somethingNew: { a: 1 } }), 'armed', ctx()),
    ).toEqual({
      outcome: 'disable',
    });
  });
});

describe('decideGuard: identity and staleness run before below/over', () => {
  const armed = (msg: BudgetMessage, context: GuardContext = ctx()) =>
    decideGuard(msg, 'armed', context);

  it('acts on a current-month message at the budget', () => {
    expect(armed(message({ costAmount: 25 }))).toEqual({ outcome: 'disable' });
  });

  it('ignores last month as stale_period, high cost or low', () => {
    const lastMonth = '2026-09-01T00:00:00Z';
    expect(armed(message({ costIntervalStart: lastMonth, costAmount: 25 }))).toEqual({
      outcome: 'ignored',
      reason: 'stale_period',
    });
    expect(armed(message({ costIntervalStart: lastMonth, costAmount: 1 }))).toEqual({
      outcome: 'ignored',
      reason: 'stale_period',
    });
  });

  it('ignores the same month of another year', () => {
    expect(armed(message({ costIntervalStart: '2025-10-01T00:00:00Z' }))).toEqual({
      outcome: 'ignored',
      reason: 'stale_period',
    });
  });

  it.each(['not a date', '', '2026-13-45', '2026-11-01T00:00:00Z', '2026-10-31T23:59:59Z'])(
    'ignores an unparseable or future start (%s)',
    (start) => {
      expect(armed(message({ costIntervalStart: start, costAmount: 99 }))).toEqual({
        outcome: 'ignored',
        reason: 'stale_period',
      });
    },
  );

  it('ignores stale in dry run too, never would_disable', () => {
    expect(
      decideGuard(
        message({ costIntervalStart: '2026-09-01T00:00:00Z', costAmount: 99 }),
        'dry_run',
        ctx(),
      ),
    ).toEqual({ outcome: 'ignored', reason: 'stale_period' });
  });

  describe('budgetId from the message attributes', () => {
    const configured = ctx({ expectedBudgetId: 'fake-budget-id-1' });

    it('acts when it matches', () => {
      expect(
        armed(message({ costAmount: 25 }), {
          ...configured,
          attributes: { budgetId: 'fake-budget-id-1' },
        }),
      ).toEqual({ outcome: 'disable' });
    });

    it.each([
      ['another id', { budgetId: 'fake-budget-id-2' }],
      ['no budgetId', { billingAccountId: 'x' }],
      ['no attributes', undefined],
    ])('ignores %s as wrong_budget_id, however high the cost', (_label, attributes) => {
      expect(armed(message({ costAmount: 99 }), { ...configured, attributes })).toEqual({
        outcome: 'ignored',
        reason: 'wrong_budget_id',
      });
    });

    it('is skipped when no ID is configured: the display name stays the identity', () => {
      expect(
        armed(message({ costAmount: 25 }), ctx({ attributes: { budgetId: 'anything' } })),
      ).toEqual({
        outcome: 'disable',
      });
      expect(armed(message({ costAmount: 25 }))).toEqual({ outcome: 'disable' });
    });

    it('treats an empty configured ID as not configured', () => {
      expect(armed(message({ costAmount: 25 }), ctx({ expectedBudgetId: '' }))).toEqual({
        outcome: 'disable',
      });
    });
  });

  it('checks in order: name, then budget ID, then currency, then period', () => {
    const everything = message({
      budgetDisplayName: 'other',
      currencyCode: 'USD',
      costIntervalStart: '2020-01-01T00:00:00Z',
    });
    const withId = ctx({ expectedBudgetId: 'a', attributes: { budgetId: 'b' } });
    expect(armed(everything, withId)).toEqual({ outcome: 'ignored', reason: 'wrong_budget' });
    expect(armed({ ...everything, budgetDisplayName: 'hireframe-kill' }, withId)).toEqual({
      outcome: 'ignored',
      reason: 'wrong_budget_id',
    });
    expect(armed({ ...everything, budgetDisplayName: 'hireframe-kill' })).toEqual({
      outcome: 'ignored',
      reason: 'wrong_currency',
    });
    expect(
      armed({ ...everything, budgetDisplayName: 'hireframe-kill', currencyCode: 'GBP' }),
    ).toEqual({
      outcome: 'ignored',
      reason: 'stale_period',
    });
  });

  it('forecast set with the cost at the budget: the actual cost decides', () => {
    expect(
      armed(message({ costAmount: 25, forecastThresholdExceeded: 1.5, alertThresholdExceeded: 1 })),
    ).toEqual({ outcome: 'disable' });
  });

  /**
   * Google's documented budget-notification example (field names and shapes from the schema),
   * with a fake billingAccountId and budgetId. A documented example, not a captured message; a
   * fixture from a real captured message is added alongside it once one has been captured.
   */
  describe('Google documented example, not a captured message', () => {
    const attributes = {
      billingAccountId: '000000-000000-000000',
      budgetId: 'fake-budget-id-1',
      schemaVersion: '1.0',
    };
    const payload = {
      budgetDisplayName: 'hireframe-kill',
      alertThresholdExceeded: 1.0,
      costAmount: 25.4,
      costIntervalStart: '2026-10-01T07:00:00Z',
      budgetAmount: 25.0,
      budgetAmountType: 'SPECIFIED_AMOUNT',
      currencyCode: 'GBP',
    };
    const parsed = () => parseBudgetMessage(encode(payload));

    it('parses, and with the clock in its month, at the budget and armed, decides disable', () => {
      const msg = parsed();
      expect(msg).not.toBeNull();
      if (!msg) return;
      expect(
        decideGuard(msg, 'armed', {
          now: Date.parse('2026-10-19T10:00:00Z'),
          attributes,
          expectedBudgetId: 'fake-budget-id-1',
        }),
      ).toEqual({ outcome: 'disable' });
    });

    it('the same message a month later is stale', () => {
      const msg = parsed();
      if (!msg) throw new Error('fixture must parse');
      expect(
        decideGuard(msg, 'armed', { now: Date.parse('2026-11-02T10:00:00Z'), attributes }),
      ).toEqual({
        outcome: 'ignored',
        reason: 'stale_period',
      });
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
