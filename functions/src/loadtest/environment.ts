/**
 * The load test's guard: it only runs against a `demo-*` emulator project, never live, and only
 * with both emulators up. Every variable the Admin SDK or the Functions runtime could take a
 * project from must be unset or `demo-*`, so a pre-set one can't point it at a real project.
 */
const PROJECT_VARIABLES = ['GCLOUD_PROJECT', 'GOOGLE_CLOUD_PROJECT'] as const;

function configProject(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed === 'object' && parsed !== null && 'projectId' in parsed) {
      const { projectId } = parsed;
      return typeof projectId === 'string' ? projectId : '';
    }
    return '';
  } catch {
    return '';
  }
}

export function assertLoadTestEnvironment(env: NodeJS.ProcessEnv): string {
  const project = env.GCLOUD_PROJECT ?? '';
  if (!project.startsWith('demo-')) {
    throw new Error(
      `Refusing to run the load test against "${project || '(unset)'}": it only runs against a demo-* emulator project.`,
    );
  }
  for (const name of PROJECT_VARIABLES) {
    const value = env[name];
    if (value !== undefined && value !== '' && !value.startsWith('demo-')) {
      throw new Error(`Refusing to run the load test: ${name} is not a demo-* project.`);
    }
  }
  const fromConfig = configProject(env.FIREBASE_CONFIG);
  if (fromConfig !== undefined && !fromConfig.startsWith('demo-')) {
    throw new Error('Refusing to run the load test: FIREBASE_CONFIG is not a demo-* project.');
  }
  if (env.LIVE === '1') throw new Error('The load test never makes live calls: unset LIVE.');
  if (!env.FIRESTORE_EMULATOR_HOST || !env.FIREBASE_STORAGE_EMULATOR_HOST) {
    throw new Error('The Firestore and Storage emulators must be running.');
  }
  return project;
}
