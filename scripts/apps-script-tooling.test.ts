/**
 * The Gmail bridge's deploy tool is a pinned dependency, not whatever `npx` fetches the day it runs
 * (RUNBOOK Part G6): clasp holds a Google login and pushes code that reads mail.
 */
import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

const manifest = JSON.parse(readFileSync('apps-script/package.json', 'utf8')) as {
  devDependencies?: Record<string, string>;
};
const lock = JSON.parse(readFileSync('package-lock.json', 'utf8')) as {
  packages: Record<string, { version?: string }>;
};

describe('clasp', () => {
  it('is an exact-pinned devDependency of apps-script', () => {
    const range = manifest.devDependencies?.['@google/clasp'];
    expect(range).toMatch(/^\d+\.\d+\.\d+$/);
    expect(lock.packages['node_modules/@google/clasp']?.version).toBe(range);
  });

  it('is run through the workspace in the docs, never bare npx', () => {
    for (const file of ['docs/RUNBOOK.md', 'CLAUDE.md', 'scripts/build-apps-script.ts']) {
      expect(readFileSync(file, 'utf8'), file).not.toMatch(/npx clasp/);
    }
    expect(readFileSync('docs/RUNBOOK.md', 'utf8')).toContain('npm exec -w apps-script clasp');
  });
});

describe('the Apps Script manifest and source (ADR-052)', () => {
  const appsscript = JSON.parse(readFileSync('apps-script/appsscript.json', 'utf8')) as {
    timeZone: string;
    oauthScopes: string[];
  };

  it('asks for exactly these scopes: mail read/relabel, fetch, triggers, send mail, own address', () => {
    expect([...appsscript.oauthScopes].sort()).toEqual([
      'https://www.googleapis.com/auth/gmail.modify',
      'https://www.googleapis.com/auth/script.external_request',
      'https://www.googleapis.com/auth/script.scriptapp',
      'https://www.googleapis.com/auth/script.send_mail',
      'https://www.googleapis.com/auth/userinfo.email',
    ]);
  });

  it('keeps the script time zone at Europe/London for the trigger hours', () => {
    expect(appsscript.timeZone).toBe('Europe/London');
  });

  it('only setup touches triggers: no other source file or handler mentions the trigger API', () => {
    for (const file of ['bridge.ts', 'digest.ts', 'read.ts', 'sign.ts', 'triggers.ts']) {
      const source = readFileSync(`apps-script/src/${file}`, 'utf8');
      expect(source, file).not.toMatch(/ScriptApp|newTrigger|deleteTrigger/);
    }
    const main = readFileSync('apps-script/src/main.ts', 'utf8');
    const outsideSetup = main.slice(0, main.indexOf('export function setup'));
    expect(outsideSetup).not.toMatch(/ScriptApp|newTrigger|deleteTrigger/);
    expect(main).not.toMatch(/deleteTrigger/);
  });

  it('mails only the effective user: no address is written in the source', () => {
    const main = readFileSync('apps-script/src/main.ts', 'utf8');
    expect(main).toContain('Session.getEffectiveUser().getEmail()');
    expect(main.match(/to:/g)).toHaveLength(1);
    expect(main).toMatch(/to: ownAddress\(\)/);
    for (const file of ['main.ts', 'digest.ts']) {
      expect(readFileSync(`apps-script/src/${file}`, 'utf8'), file).not.toMatch(/@[a-z0-9-]+\./i);
    }
  });

  it('computes the London day with Europe/London named, not the script time zone', () => {
    const main = readFileSync('apps-script/src/main.ts', 'utf8');
    expect(main).toContain("const LONDON = 'Europe/London'");
    expect(main).not.toMatch(/Session\.getScriptTimeZone/);
  });

  it('defines the five global handlers in the build footer', () => {
    const build = readFileSync('scripts/build-apps-script.ts', 'utf8');
    for (const name of ['run', 'setup', 'digestMorning', 'digestFallback', 'digestNow']) {
      expect(build).toContain(`function ${name}()`);
    }
  });
});
