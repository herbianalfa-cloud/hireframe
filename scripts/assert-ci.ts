/**
 * Guard for `npm run deploy`: deploys run only from the tag-triggered GitHub Actions
 * workflow (CLAUDE.md, ADR-014), never from a laptop.
 */
import { fileURLToPath } from 'node:url';

export function isCiDeploy(env: NodeJS.ProcessEnv): boolean {
  return env.GITHUB_ACTIONS === 'true' && (env.GITHUB_REF ?? '').startsWith('refs/tags/v');
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  if (!isCiDeploy(process.env)) {
    console.error(
      'deploy: refusing to run. Deploys run only in GitHub Actions on a v* tag (docs/RUNBOOK.md).',
    );
    process.exit(1);
  }
}
