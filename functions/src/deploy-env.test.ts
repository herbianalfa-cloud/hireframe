import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { BILLING_GUARD, guardMode } from './config.js';
import { DEPLOY_ENV_PROJECT, deployEnvFile } from './deploy-env.js';

const sourceUrl = new URL('../deploy-env/hireframe-f6b03.env', import.meta.url);
const source = readFileSync(sourceUrl, 'utf8');

/** The emulator project of `npm run dev` (scripts/dev-seed.ts `assertDemoProject`). */
const EMULATOR_PROJECT = 'demo-hireframe';

describe('deployEnvFile', () => {
  it('turns the committed source into the armed env file', () => {
    expect(deployEnvFile(source)).toEqual({
      name: '.env.hireframe-f6b03',
      content: 'BILLING_GUARD_MODE=armed\n',
    });
  });

  it('allows the disarm path', () => {
    expect(deployEnvFile('BILLING_GUARD_MODE=dry_run\n').content).toBe(
      'BILLING_GUARD_MODE=dry_run\n',
    );
    expect(deployEnvFile('BILLING_GUARD_MODE=armed').content).toBe('BILLING_GUARD_MODE=armed\n');
  });

  it.each([
    ['empty', ''],
    ['a blank value', 'BILLING_GUARD_MODE=\n'],
    ['another value', 'BILLING_GUARD_MODE=true\n'],
    ['upper case', 'BILLING_GUARD_MODE=ARMED\n'],
    ['a padded value', 'BILLING_GUARD_MODE= armed\n'],
    ['another key', 'OTHER=armed\n'],
    ['an extra line', 'BILLING_GUARD_MODE=armed\nOTHER=1\n'],
    ['a comment', '# note\nBILLING_GUARD_MODE=armed\n'],
    ['a trailing comment', 'BILLING_GUARD_MODE=armed # on\n'],
    ['a blank line after', 'BILLING_GUARD_MODE=armed\n\n'],
    ['a secret-looking value', 'BILLING_GUARD_MODE=sk-ant-abc123\n'],
    ['quotes', 'BILLING_GUARD_MODE="armed"\n'],
    ['CRLF', 'BILLING_GUARD_MODE=armed\r\n'],
  ])('throws on %s', (_label, text) => {
    expect(() => deployEnvFile(text)).toThrow(/exactly one line/);
  });

  it('never names a file the emulator or a local run would load', () => {
    const { name } = deployEnvFile(source);
    expect(name).not.toBe('.env');
    expect(name).not.toBe('.env.local');
    expect(name).not.toBe('.env.prod');
    expect(name.startsWith('.env.demo-')).toBe(false);
  });

  it('names the production project, which is not the emulator project', () => {
    const { name } = deployEnvFile(source);
    const firebaserc = JSON.parse(
      readFileSync(new URL('../../.firebaserc', import.meta.url), 'utf8'),
    ) as { projects: Record<string, string> };
    const accountProject = BILLING_GUARD.serviceAccount.split('@')[1]?.split('.')[0];
    expect(name).toBe(`.env.${firebaserc.projects.prod ?? ''}`);
    expect(DEPLOY_ENV_PROJECT).toBe(firebaserc.projects.prod);
    expect(DEPLOY_ENV_PROJECT).toBe(accountProject);
    expect(DEPLOY_ENV_PROJECT).not.toBe(EMULATOR_PROJECT);
    expect(name).not.toContain(EMULATOR_PROJECT);
  });

  it('writes the key the guard reads, BILLING_GUARD.modeEnvVar', () => {
    const key = /^([^=]+)=/m.exec(deployEnvFile(source).content)?.[1];
    expect(key).toBe(BILLING_GUARD.modeEnvVar);
  });

  it('round-trips through guardMode to armed', () => {
    const value = /^BILLING_GUARD_MODE=(.*)$/m.exec(deployEnvFile(source).content)?.[1];
    expect(guardMode({ [BILLING_GUARD.modeEnvVar]: value })).toBe('armed');
  });
});
