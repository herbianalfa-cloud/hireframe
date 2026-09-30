/**
 * Fails if any tracked (or new, non-ignored) text file contains an email or phone number
 * that is not allowlisted. Enforces the "no personal data in the repo" rule (docs/SECURITY.md).
 * Run with `npm run scan:pii`.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

import { findPii, parseAllowlist } from './pii.ts';

const ALLOWLIST_PATH = 'scripts/pii-allowlist.txt';

const files = execFileSync(
  'git',
  ['ls-files', '-z', '--cached', '--others', '--exclude-standard'],
  {
    encoding: 'utf8',
  },
)
  .split('\0')
  .filter((file) => file !== '');

const allowlist = parseAllowlist(readFileSync(ALLOWLIST_PATH, 'utf8'));

let findingCount = 0;
for (const file of files) {
  let content: Buffer;
  try {
    content = readFileSync(file);
  } catch {
    continue; // tracked but deleted in the working tree
  }
  if (content.includes(0)) continue; // binary

  for (const finding of findPii(content.toString('utf8'), allowlist)) {
    console.error(`${file}:${String(finding.line)}  ${finding.kind}  ${finding.redacted}`);
    findingCount++;
  }
}

if (findingCount > 0) {
  console.error(
    `\nscan:pii: ${String(findingCount)} possible personal data finding(s). ` +
      `Remove them, use fake data, or (for non-personal addresses only) add to ${ALLOWLIST_PATH}.`,
  );
  process.exit(1);
}
console.log(`scan:pii: ${String(files.length)} files clean`);
