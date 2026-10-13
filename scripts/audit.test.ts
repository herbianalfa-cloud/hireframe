import { describe, expect, it } from 'vitest';

import {
  evaluateAudit,
  loadAllowlist,
  parseAllowlist,
  runAudit,
  type AllowlistEntry,
} from './audit.ts';

const TODAY = '2026-10-13';
const BRACES = 'GHSA-vfj7-8cjw-p6xm';
const OTHER = 'GHSA-aaaa-bbbb-cccc';

const allowlist: AllowlistEntry[] = [
  {
    id: BRACES,
    roots: ['firebase-tools', '@google/clasp'],
    reason: 'dev tooling only',
    reviewBy: '2027-01-13',
  },
];

/** The shape of `npm audit --json` (v2) for the pieces the gate reads. */
function report(
  advisories: {
    name: string;
    id: string;
    severity?: string;
    effects?: string[];
    direct?: boolean;
  }[],
) {
  const vulnerabilities: Record<string, unknown> = {};
  for (const a of advisories) {
    vulnerabilities[a.name] = {
      name: a.name,
      severity: a.severity ?? 'high',
      isDirect: a.direct ?? false,
      via: [
        {
          source: 1,
          name: a.name,
          url: `https://github.com/advisories/${a.id}`,
          severity: a.severity ?? 'high',
        },
      ],
      effects: a.effects ?? [],
    };
  }
  return { vulnerabilities };
}

/** braces comes in through chokidar into firebase-tools, as in the real tree. */
const braces = (root: string) => [
  { name: 'braces', id: BRACES, effects: ['chokidar'] },
  { name: 'chokidar', id: BRACES, effects: [root] },
  { name: root, id: BRACES, direct: true },
];

describe('evaluateAudit', () => {
  it('passes an allowlisted advisory through an allowed root', () => {
    const result = evaluateAudit(report(braces('firebase-tools')), allowlist, TODAY);
    expect(result).toMatchObject({ ok: true, problems: [] });
    expect(result.advisories).toEqual([
      { id: BRACES, severity: 'high', package: 'braces', roots: ['firebase-tools'] },
    ]);
  });

  it('fails a new high advisory in a dev tool', () => {
    const result = evaluateAudit(
      report([...braces('firebase-tools'), { name: 'left-pad', id: OTHER, direct: true }]),
      allowlist,
      TODAY,
    );
    expect(result.ok).toBe(false);
    expect(result.problems).toHaveLength(1);
    expect(result.problems[0]).toMatchObject({ kind: 'not_allowlisted', advisory: { id: OTHER } });
  });

  it('fails an allowed advisory that arrives through a different root', () => {
    const result = evaluateAudit(report(braces('vite')), allowlist, TODAY);
    expect(result.problems).toEqual([
      expect.objectContaining({ kind: 'wrong_root', allowed: ['firebase-tools', '@google/clasp'] }),
    ]);
  });

  it('fails an expired entry, even though its advisory is still present', () => {
    const result = evaluateAudit(report(braces('firebase-tools')), allowlist, '2027-01-13');
    expect(result.ok).toBe(false);
    expect(result.problems).toEqual([expect.objectContaining({ kind: 'expired' })]);
  });

  it('fails an entry that no longer matches anything', () => {
    const result = evaluateAudit({ vulnerabilities: {} }, allowlist, TODAY);
    expect(result.problems).toEqual([expect.objectContaining({ kind: 'unused' })]);
  });

  it('does not fail on moderates', () => {
    const moderate = report([
      { name: 'sprintf-js', id: OTHER, severity: 'moderate', direct: true },
    ]);
    expect(evaluateAudit(moderate, [], TODAY)).toMatchObject({ ok: true, advisories: [] });
  });

  it('fails on a critical advisory that is not allowlisted', () => {
    const critical = report([{ name: 'x', id: OTHER, severity: 'critical', direct: true }]);
    expect(evaluateAudit(critical, [], TODAY).ok).toBe(false);
  });
});

describe('wrong_root', () => {
  it('fails an allowlisted advisory whose roots cannot be determined', () => {
    // No direct dependency is reachable from braces, so `roots` comes out empty.
    const result = evaluateAudit(
      report([{ name: 'braces', id: BRACES, effects: [] }]),
      allowlist,
      TODAY,
    );
    expect(result.ok).toBe(false);
    expect(result.problems).toEqual([
      expect.objectContaining({ kind: 'wrong_root', allowed: ['firebase-tools', '@google/clasp'] }),
    ]);
  });
});

describe('parseAllowlist', () => {
  const entry = {
    id: BRACES,
    roots: ['firebase-tools'],
    reason: 'dev tooling only',
    reviewBy: '2027-01-13',
  };
  const text = (value: unknown) => JSON.stringify(value);

  it('accepts a well-formed file, including an npm-<n> id', () => {
    const result = parseAllowlist(text([entry, { ...entry, id: 'npm-1234' }]));
    expect(result).toMatchObject({ ok: true });
  });

  it('fails closed on each kind of invalid file', () => {
    const bad: unknown[] = [
      { not: 'an array' },
      [{ ...entry, id: 'CVE-2024-0001' }],
      [{ ...entry, id: 'GHSA-xyz' }],
      [{ ...entry, roots: [] }],
      [{ ...entry, reviewBy: '13/01/2027' }],
      [{ ...entry, reviewBy: '2027-1-13' }],
      [{ ...entry, reviewBy: '2027-02-30' }],
      [{ ...entry, reviewBy: '2027-13-01' }],
      [{ ...entry, reason: '   ' }],
      [{ ...entry, extra: true }],
      [{ id: BRACES }],
    ];
    for (const value of bad) expect(parseAllowlist(text(value)).ok).toBe(false);
    expect(parseAllowlist('{not json').ok).toBe(false);
    expect(parseAllowlist('').ok).toBe(false);
  });
});

describe('loadAllowlist', () => {
  it('fails with audit_parse_error, not a stack trace, when the file is missing', () => {
    const result = loadAllowlist('no-such-allowlist.json');
    expect(result).toEqual({
      ok: false,
      message: 'audit_parse_error: no-such-allowlist.json could not be read',
    });
  });

  it('parses the text the reader gives', () => {
    expect(loadAllowlist('x.json', () => '[]')).toEqual({ ok: true, entries: [] });
  });
});

describe('runAudit', () => {
  it('evaluates valid JSON from a non-zero npm exit as normal', () => {
    // The injected exec returns stdout whatever npm's exit code was.
    const out = JSON.stringify(report(braces('@google/clasp')));
    expect(runAudit(() => out, allowlist, TODAY).ok).toBe(true);
  });

  it('fails with audit_parse_error on empty or unparsable output', () => {
    for (const out of ['', '   ', 'npm ERR! network', '{"vulnerabilities":']) {
      expect(runAudit(() => out, allowlist, TODAY).problems).toEqual([
        { kind: 'audit_parse_error' },
      ]);
    }
  });

  it('fails when the JSON has no vulnerabilities map (an npm error body)', () => {
    const result = runAudit(
      () => JSON.stringify({ error: { code: 'ENOAUDIT' } }),
      allowlist,
      TODAY,
    );
    expect(result.problems).toEqual([{ kind: 'audit_parse_error' }]);
  });

  it('fails when exec throws', () => {
    const result = runAudit(
      () => {
        throw new Error('spawn failed');
      },
      allowlist,
      TODAY,
    );
    expect(result.problems).toEqual([{ kind: 'audit_parse_error' }]);
  });
});
