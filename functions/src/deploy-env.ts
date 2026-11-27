/**
 * The env file that `scripts/build-functions.ts` writes into `functions/deploy/` so the deployed
 * functions read `BILLING_GUARD_MODE` (v1.0.1, ADR-059 addendum). Firebase loads
 * `.env.<projectId>` from the deploy source for that project only, so the emulator
 * (`demo-hireframe`) never loads it. Import-free on purpose: `scripts/` imports it with `.ts`.
 *
 * The committed source (`functions/deploy-env/hireframe-f6b03.env`) has a non-dot name so
 * `.gitignore` and the kit guard do not apply. It must be exactly one line.
 */

/** The production Firebase project; a test pins it to `.firebaserc` and the guard's service account. */
export const DEPLOY_ENV_PROJECT = 'hireframe-f6b03';

const LINE = /^BILLING_GUARD_MODE=(armed|dry_run)$/;

export function deployEnvFile(sourceText: string): { name: string; content: string } {
  const lines = sourceText.endsWith('\n')
    ? sourceText.slice(0, -1).split('\n')
    : sourceText.split('\n');
  const line = lines[0] ?? '';
  const match = lines.length === 1 ? LINE.exec(line) : null;
  const mode = match?.[1];
  if (!mode) {
    throw new Error(
      'deploy env source must be exactly one line: BILLING_GUARD_MODE=armed or BILLING_GUARD_MODE=dry_run',
    );
  }
  return { name: `.env.${DEPLOY_ENV_PROJECT}`, content: `BILLING_GUARD_MODE=${mode}\n` };
}
