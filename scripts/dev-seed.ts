import { CRITERIA_SEED_V1 } from '../packages/shared/src/criteria-seed.ts';

/**
 * Pure helpers for `npm run dev` (scripts/dev.ts): the fake owner and criteria v1 seeded into
 * the local emulators. Fake data only (CLAUDE.md); the project must be a `demo-*` project, which the
 * emulators guarantee can never reach real Firebase resources (ADR-013).
 */
export const DEV_OWNER = {
  uid: 'owner-dev',
  email: 'owner@example.com',
  displayName: 'Dev Owner',
  googleRawId: 'owner-dev-google',
} as const;

export function assertDemoProject(projectId: string | undefined): string {
  if (!projectId?.startsWith('demo-')) {
    throw new Error(
      `Refusing to seed project "${projectId ?? '(unset)'}": dev seeding only runs against a demo-* emulator project.`,
    );
  }
  return projectId;
}

/** Body for the Auth emulator `accounts:batchCreate` endpoint. The Google provider link
 * makes the owner selectable in the emulator's "Sign in with Google" pop-up. */
export function ownerAccountBody() {
  return {
    users: [
      {
        localId: DEV_OWNER.uid,
        email: DEV_OWNER.email,
        emailVerified: true,
        displayName: DEV_OWNER.displayName,
        providerUserInfo: [
          {
            providerId: 'google.com',
            rawId: DEV_OWNER.googleRawId,
            email: DEV_OWNER.email,
            displayName: DEV_OWNER.displayName,
          },
        ],
      },
    ],
  };
}

/** `config/app` in Firestore REST form, with Timestamps like a console-created doc. */
export function appConfigDocument(now: Date) {
  const timestamp = { timestampValue: now.toISOString() };
  return {
    fields: {
      ownerUid: { stringValue: DEV_OWNER.uid },
      schemaVersion: { integerValue: '1' },
      createdAt: timestamp,
      updatedAt: timestamp,
    },
  };
}

/** A Firestore REST value (https://firebase.google.com/docs/firestore/reference/rest/v1/Value). */
export type RestValue =
  | { stringValue: string }
  | { integerValue: string }
  | { doubleValue: number }
  | { booleanValue: boolean }
  | { timestampValue: string }
  | { arrayValue: { values: RestValue[] } }
  | { mapValue: { fields: Record<string, RestValue> } };

export function toRestValue(value: unknown): RestValue {
  if (typeof value === 'string') return { stringValue: value };
  if (typeof value === 'boolean') return { booleanValue: value };
  if (typeof value === 'number') {
    return Number.isInteger(value) ? { integerValue: String(value) } : { doubleValue: value };
  }
  if (value instanceof Date) return { timestampValue: value.toISOString() };
  if (Array.isArray(value)) return { arrayValue: { values: value.map(toRestValue) } };
  if (typeof value === 'object' && value !== null) {
    return { mapValue: { fields: toRestFields(value as Record<string, unknown>) } };
  }
  throw new Error(`Unsupported seed value: ${typeof value}`);
}

function toRestFields(data: Record<string, unknown>): Record<string, RestValue> {
  return Object.fromEntries(
    Object.entries(data)
      .filter(([, value]) => value !== undefined)
      .map(([key, value]) => [key, toRestValue(value)]),
  );
}

/** `criteria/v1` and `criteria/current`, as the Criteria screen's "Start from default" writes them. */
export function criteriaSeedDocuments(now: Date) {
  return {
    v1: {
      fields: toRestFields({ ...CRITERIA_SEED_V1, version: 1, createdAt: now, schemaVersion: 1 }),
    },
    current: { fields: toRestFields({ version: 1, updatedAt: now, schemaVersion: 1 }) },
  };
}

/**
 * One fake job "from a LinkedIn alert" (alerts arrive in M6), so the first local Scan now shows
 * the PRD R5 merge: the fake Greenhouse, Adzuna and HN postings of the same role join it instead
 * of creating a second job. Its keys are what the shared dedupe computes (dev-tools.test.ts).
 */
export const DEV_LINKEDIN_JOB_ID = 'dev-linkedin-alert-job';
export const DEV_LINKEDIN_JOB_KEYS = ['d:0e0d03aa2aa807d0', 'linkedin:4012345678'] as const;

export function linkedInJobDocuments(now: Date) {
  const url = 'https://www.linkedin.com/jobs/view/product-analyst-at-acme-analytics-4012345678';
  return {
    job: {
      fields: toRestFields({
        dedupeKey: DEV_LINKEDIN_JOB_KEYS[0],
        keys: [...DEV_LINKEDIN_JOB_KEYS],
        title: 'Product Analyst',
        company: 'Acme Analytics Ltd',
        location: 'London, England, United Kingdom',
        city: 'london',
        country: 'GB',
        remote: 'unknown',
        url,
        sources: [{ id: 'linkedin-alert', url, externalId: '4012345678', seenAt: now }],
        firstSeenAt: now,
        descriptionRef: `jobs/${DEV_LINKEDIN_JOB_ID}/description/raw`,
        descriptionKind: 'snippet',
        stage: 's0',
        status: 'new',
        createdAt: now,
        updatedAt: now,
        schemaVersion: 1,
      }),
    },
    description: {
      fields: toRestFields({
        text: 'Acme Analytics is hiring a Product Analyst.',
        kind: 'snippet',
        sourceId: 'linkedin-alert',
        fetchedAt: now,
        schemaVersion: 1,
      }),
    },
  };
}
