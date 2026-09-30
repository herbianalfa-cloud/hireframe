/**
 * Pure helpers for `npm run dev` (scripts/dev.ts): the fake owner seeded into the local
 * emulators. Fake data only (CLAUDE.md); the project must be a `demo-*` project, which the
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
