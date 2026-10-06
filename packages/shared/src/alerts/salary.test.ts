import { describe, expect, it } from 'vitest';

import { parseSalaryText } from './salary.js';

describe('parseSalaryText', () => {
  it.each([
    ['£35K/yr - £45K/yr', { min: 35000, max: 45000, currency: 'GBP', period: 'year' }],
    ['£35K - £45K/yr', { min: 35000, max: 45000, currency: 'GBP', period: 'year' }],
    ['£30,000/yr', { min: 30000, currency: 'GBP', period: 'year' }],
    ['£15/hr', { min: 15, currency: 'GBP', period: 'hour' }],
    ['£15.50/hr', { min: 15.5, currency: 'GBP', period: 'hour' }],
    ['€3,000/mo', { min: 3000, currency: 'EUR', period: 'month' }],
    ['$120K/yr - $150K/yr', { min: 120000, max: 150000, currency: 'USD', period: 'year' }],
  ])('reads %s', (line, expected) => {
    expect(parseSalaryText(line)).toEqual(expected);
  });

  it.each([
    '',
    'Competitive salary',
    '£35K',
    '£35K/yr - $45K/yr',
    '£45K/yr - £35K/yr',
    '£35K/yr - £45K/mo',
    '£35K/wk',
    'Up to £35K/yr',
    '£35K/yr plus bonus',
  ])('leaves out %j', (line) => {
    expect(parseSalaryText(line)).toBeUndefined();
  });
});
