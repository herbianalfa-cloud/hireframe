import type { Application } from '@hireframe/shared';

import type { ApplicationView } from '@/services/applications';

const AT = new Date('2026-10-07T09:00:00Z');

/** A valid application for the fake candidate's job; override any field. */
export function makeApplication(
  jobId: string,
  overrides: Partial<Application> = {},
): ApplicationView {
  const application: Application = {
    jobId,
    job: { title: `Data Analyst ${jobId}`, company: 'Acme Analytics', verdict: 'apply' },
    stage: 'chosen',
    stageAt: AT,
    startedAt: AT,
    updatedAt: AT,
    questions: [],
    attempt: 0,
    cvIds: [],
    schemaVersion: 1,
    ...overrides,
  };
  return { id: jobId, application };
}

export const QUESTION_A = {
  id: 'q-02a7bdc3c99a',
  requirement: 'Experience with dbt',
  level: 'nice',
  type: 'tool',
  match: 'missing',
} as const;

export const QUESTION_B = {
  id: 'q-18d1be1df09b',
  requirement: 'Presenting analysis to non-technical stakeholders',
  level: 'must',
  type: 'skill',
  match: 'partial',
} as const;
