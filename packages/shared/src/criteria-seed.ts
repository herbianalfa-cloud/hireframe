import type { CriteriaContent } from './criteria.js';

/**
 * Criteria v1, from docs/FUNNEL.md "Seed criteria (v1)". `excluded_titles` is structured so the
 * S1 rules (M4) can apply "unless immediately preceded by" with `checkTitle` (titles.ts) instead
 * of parsing prose. "Technical" is an allowed prefix for Business Analyst because "Technical
 * Business Analyst" is a secondary-lane title.
 */
export const CRITERIA_SEED_V1: CriteriaContent = {
  lanes: {
    primary: [
      'Product Operations Associate',
      'Product Operations Analyst',
      'Product Analyst',
      'Technical Product Analyst',
      'Associate Product Manager',
      'Junior Product Manager',
      'Graduate Product Manager',
      'APM',
    ],
    secondary: [
      'Implementation Consultant',
      'Onboarding Specialist',
      'Client Integration Executive',
      'Associate Solutions Engineer',
      'Solutions Consultant',
      'Technical Account Manager',
      'Product Support Analyst',
      'Customer Solutions Engineer',
      'Junior/Graduate/Associate Business Analyst',
      'Technical Business Analyst',
    ],
    opportunistic: [
      'Insight Assistant',
      'Research Analyst',
      'Consumer Insight Analyst',
      'Audience Insight Analyst',
      'Category Insight Analyst',
      'Brand Assistant',
      'Junior Brand Manager',
    ],
  },
  wildcards: [
    'prompt engineer',
    'AI operations',
    'creative technologist',
    'game dev (Unity)',
    'product designer (junior)',
    'video/content production at tech companies',
  ],
  excluded_titles: [
    {
      id: 'business-analyst',
      term: 'Business Analyst',
      unless_prefixed_by: ['Junior', 'Graduate', 'Associate', 'Technical'],
    },
    { id: 'data-analyst', term: 'Data Analyst' },
    { id: 'product-owner', term: 'Product Owner' },
    { id: 'growth', term: 'Growth' },
    { id: 'performance-marketing', term: 'Performance Marketing' },
    { id: 'digital-marketing', term: 'Digital Marketing' },
    { id: 'senior', term: 'Senior' },
    { id: 'lead', term: 'Lead' },
    { id: 'principal', term: 'Principal' },
    { id: 'head-of', term: 'Head of' },
    { id: 'director', term: 'Director' },
    {
      id: 'manager',
      term: 'Manager',
      unless_prefixed_by: ['Product', 'Account', 'Associate', 'Junior'],
    },
  ],
  excluded_keywords: [],
  excluded_companies: [
    'Big Four graduate schemes',
    'Sparta Global and train-and-deploy consultancies',
  ],
  experience_cap_years: 2,
  blockers: [
    'SC clearance',
    'DV clearance',
    'driving licence required',
    'sponsorship-restricted wording',
  ],
  locations: { preferred: ['London'], accepted: ['UK-wide', 'remote-UK', 'hybrid-UK'] },
  company_prefs: {
    size: [20, 300],
    stages: ['Series A', 'Series B', 'Series C'],
    sectors_boost: ['B2B SaaS'],
    sectors_penalise: [],
  },
  freshness_days: 14,
  thresholds: { apply_fit: 7, apply_luck: 5, near_miss_fit: 5, wildcard_fit: 6 },
  weekly_target: 10,
};
