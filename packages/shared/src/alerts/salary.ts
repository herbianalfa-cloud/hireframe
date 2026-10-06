import type { Salary } from '../jobs.js';

/**
 * A salary line from an alert card: `£35K/yr - £45K/yr`, `£30,000/yr`, `£15/hr`. The whole line
 * must read, or nothing is returned: a salary is never guessed (ADR-047).
 */

const CURRENCIES: Readonly<Record<string, string>> = { '£': 'GBP', $: 'USD', '€': 'EUR' };
const PERIODS: Readonly<Record<string, NonNullable<Salary['period']>>> = {
  yr: 'year',
  year: 'year',
  mo: 'month',
  month: 'month',
  day: 'day',
  hr: 'hour',
  hour: 'hour',
};

const AMOUNT = String.raw`([£$€])\s?(\d[\d,]*(?:\.\d+)?)\s?([kK])?`;
const PERIOD = String.raw`(?:\s?(?:\/|per\s)\s?(yr|year|mo|month|day|hr|hour))`;
// `£35K/yr - £45K/yr` repeats the period; `£35K - £45K/yr` and `£30,000/yr` state it once.
const LINE = new RegExp(
  String.raw`^${AMOUNT}${PERIOD}?(?:\s?(?:-|–|—|to)\s?${AMOUNT}${PERIOD}?)?$`,
  'i',
);

function amount(digits: string, thousands: string | undefined): number | undefined {
  const value = Number(digits.replace(/,/g, ''));
  if (!Number.isFinite(value)) return undefined;
  return thousands ? value * 1000 : value;
}

export function parseSalaryText(line: string): Salary | undefined {
  const match = LINE.exec(line.trim());
  if (!match) return undefined;
  const [, symbol1, digits1, k1, period1, symbol2, digits2, k2, period2] = match;
  const currency = CURRENCIES[symbol1 ?? ''];
  const periods = [period1, period2].filter((p): p is string => p !== undefined);
  const first = periods[0]?.toLowerCase();
  const period = first ? PERIODS[first] : undefined;
  const min = amount(digits1 ?? '', k1);
  if (!currency || !period || min === undefined) return undefined;
  if (periods.some((p) => PERIODS[p.toLowerCase()] !== period)) return undefined;
  if (digits2 === undefined) return { min, currency, period };
  const max = amount(digits2, k2);
  if (max === undefined || symbol2 !== symbol1 || max < min) return undefined;
  return { min, max, currency, period };
}
