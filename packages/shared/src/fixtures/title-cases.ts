/**
 * Seed-criteria title cases with the rule each must hit (null = allowed) (ADR-020). Shared by
 * `titles.test.ts` and the eval's S1 title suite (`npm run eval`), so both check the same table.
 */
export const TITLE_CASES: readonly (readonly [title: string, excludedBy: string | null])[] = [
  // Asked for in the PR #4 review.
  ['Junior Brand Manager', null],
  ['Product Marketing Manager', 'manager'],
  ['Senior Product Analyst', 'senior'],
  // Business Analyst: only the listed words, immediately before the term, allow it.
  ['Business Analyst', 'business-analyst'],
  ['business analyst', 'business-analyst'],
  ['Technical Business Analyst', null],
  ['Junior Business Analyst', null],
  ['Business Analyst - Technical', 'business-analyst'],
  ['Technical Support / Business Analyst', 'business-analyst'],
  ['Senior Technical Business Analyst', 'senior'],
  ['Lead Technical Business Analyst', 'lead'],
  // Manager: "Product/Account/Associate/Junior" must come directly before it.
  ['Associate Product Manager', null],
  ['Technical Account Manager', null],
  ['Marketing Manager', 'manager'],
  ['Head of Product', 'head-of'],
  ['Data Analyst', 'data-analyst'],
  ['Product Analyst', null],
  // C4 sales titles (ADR-045). Sales Engineer, Pre-Sales and Solutions Consultant are the Solutions
  // lane under another name and contain no C4 term; guards the "plain Sales" trap.
  ['Sales Engineer', null],
  ['Pre-Sales Consultant', null],
  ['Pre Sales Solutions Consultant', null],
  ['Presales Engineer', null],
  ['Solutions Consultant', null],
  ['Sales Development Representative', 'sales-development'],
  ['Account Executive', 'account-executive'],
  ['Business Development Executive', 'business-development'],
  ['Sales Executive', 'sales-executive'],
  ['SDR', 'sdr'],
  // Wildcard and engineering-adjacent titles stay allowed (C3 was rejected).
  ['Unity Developer', null],
  ['Prompt Engineer', null],
  ['Junior Product Manager', null],
];
