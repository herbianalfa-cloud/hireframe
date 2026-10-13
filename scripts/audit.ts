/**
 * The dependency audit gate (ADR-013 addendum, M8). Runs `npm audit --json` on the full tree and
 * fails on any high or critical advisory that is not in `audit-allowlist.json`. Moderates never
 * fail. Run with `npm run audit`.
 *
 * npm exits non-zero whenever it finds anything, so the exit code is ignored: the JSON is the
 * result. Output that is empty or not JSON fails with `audit_parse_error`.
 */
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export interface AllowlistEntry {
  /** The advisory, e.g. `GHSA-vfj7-8cjw-p6xm`. */
  id: string;
  /** The direct dependencies this advisory may come in through. */
  roots: string[];
  reason: string;
  /** `YYYY-MM-DD`: the entry fails the gate from this day on, so it gets looked at again. */
  reviewBy: string;
}

export interface Advisory {
  id: string;
  severity: 'high' | 'critical';
  /** The package the advisory is about. */
  package: string;
  /** Direct dependencies it reaches the tree through. */
  roots: string[];
}

export type AuditProblem =
  | { kind: 'not_allowlisted'; advisory: Advisory }
  | { kind: 'wrong_root'; advisory: Advisory; allowed: string[] }
  | { kind: 'expired'; entry: AllowlistEntry }
  | { kind: 'unused'; entry: AllowlistEntry }
  | { kind: 'audit_parse_error' };

export interface AuditResult {
  ok: boolean;
  advisories: Advisory[];
  problems: AuditProblem[];
}

interface NpmVia {
  source?: number;
  name?: string;
  url?: string;
  severity?: string;
}
interface NpmVulnerability {
  name: string;
  severity: string;
  isDirect: boolean;
  via: (string | NpmVia)[];
  effects: string[];
}

const GHSA = /GHSA-[a-z0-9]{4}-[a-z0-9]{4}-[a-z0-9]{4}/i;
const isSevere = (severity: string | undefined): severity is 'high' | 'critical' =>
  severity === 'high' || severity === 'critical';

/** Direct dependencies that `name` reaches the tree through (itself, if direct). */
function rootsOf(name: string, vulnerabilities: Record<string, NpmVulnerability>): string[] {
  const roots = new Set<string>();
  const seen = new Set<string>();
  const walk = (current: string) => {
    if (seen.has(current)) return;
    seen.add(current);
    const entry = vulnerabilities[current];
    if (!entry) return;
    if (entry.isDirect) roots.add(current);
    for (const parent of entry.effects) walk(parent);
  };
  walk(name);
  return [...roots].sort();
}

/** The high and critical advisories in `npm audit --json` output (v2 format). */
export function advisoriesFrom(json: unknown): Advisory[] | null {
  if (typeof json !== 'object' || json === null || !('vulnerabilities' in json)) return null;
  const vulnerabilities = json.vulnerabilities as Record<string, NpmVulnerability>;
  if (typeof vulnerabilities !== 'object') return null;
  const found = new Map<string, Advisory>();
  for (const [name, vulnerability] of Object.entries(vulnerabilities)) {
    for (const via of vulnerability.via) {
      if (typeof via === 'string' || !isSevere(via.severity)) continue;
      const match = via.url?.match(GHSA)?.[0];
      // GHSA ids are `GHSA-` plus lowercase groups. An advisory with no GHSA id is keyed by its
      // npm number, so it can't be missed.
      const id = match
        ? `GHSA-${match.slice(5).toLowerCase()}`
        : `npm-${String(via.source ?? via.name ?? name)}`;
      const advisory: Advisory = {
        id,
        severity: via.severity,
        package: via.name ?? name,
        roots: rootsOf(name, vulnerabilities),
      };
      const previous = found.get(advisory.id);
      if (previous) {
        previous.roots = [...new Set([...previous.roots, ...advisory.roots])].sort();
      } else found.set(advisory.id, advisory);
    }
  }
  return [...found.values()];
}

/** Pure: what the gate says about one audit result, an allowlist and today (`YYYY-MM-DD`). */
export function evaluateAudit(
  json: unknown,
  allowlist: readonly AllowlistEntry[],
  today: string,
): AuditResult {
  const advisories = advisoriesFrom(json);
  if (!advisories) return { ok: false, advisories: [], problems: [{ kind: 'audit_parse_error' }] };
  const problems: AuditProblem[] = [];
  const byId = new Map(allowlist.map((entry) => [entry.id, entry]));
  const used = new Set<string>();
  for (const advisory of advisories) {
    const entry = byId.get(advisory.id);
    if (!entry) {
      problems.push({ kind: 'not_allowlisted', advisory });
      continue;
    }
    used.add(entry.id);
    if (!advisory.roots.every((root) => entry.roots.includes(root))) {
      problems.push({ kind: 'wrong_root', advisory, allowed: entry.roots });
    }
  }
  for (const entry of allowlist) {
    if (entry.reviewBy <= today) problems.push({ kind: 'expired', entry });
    if (!used.has(entry.id)) problems.push({ kind: 'unused', entry });
  }
  return { ok: problems.length === 0, advisories, problems };
}

/** Runs the audit with an injected `npm audit --json` (stdout, whatever the exit code). */
export function runAudit(
  exec: () => string,
  allowlist: readonly AllowlistEntry[],
  today: string,
): AuditResult {
  let json: unknown;
  try {
    const out = exec();
    if (out.trim() === '') throw new Error('empty');
    json = JSON.parse(out);
  } catch {
    return { ok: false, advisories: [], problems: [{ kind: 'audit_parse_error' }] };
  }
  return evaluateAudit(json, allowlist, today);
}

export function describeProblem(problem: AuditProblem): string {
  switch (problem.kind) {
    case 'not_allowlisted':
      return `${problem.advisory.severity} ${problem.advisory.id} in ${problem.advisory.package} (via ${problem.advisory.roots.join(', ') || 'unknown'}) is not in audit-allowlist.json`;
    case 'wrong_root':
      return `${problem.advisory.id} now reaches the tree through ${problem.advisory.roots.join(', ')}; the allowlist covers only ${problem.allowed.join(', ')}`;
    case 'expired':
      return `allowlist entry ${problem.entry.id} was due for review by ${problem.entry.reviewBy}`;
    case 'unused':
      return `allowlist entry ${problem.entry.id} matches nothing any more; remove it`;
    case 'audit_parse_error':
      return 'audit_parse_error: `npm audit --json` gave no JSON to read';
  }
}

function npmAuditJson(): string {
  const result = spawnSync('npm', ['audit', '--json'], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  return result.stdout;
}

function main(): void {
  const allowlist = JSON.parse(readFileSync('audit-allowlist.json', 'utf8')) as AllowlistEntry[];
  const today = new Date().toISOString().slice(0, 10);
  const result = runAudit(npmAuditJson, allowlist, today);
  for (const advisory of result.advisories) {
    console.log(
      `${advisory.severity} ${advisory.id} ${advisory.package} via ${advisory.roots.join(', ')}`,
    );
  }
  if (!result.ok) {
    for (const problem of result.problems) console.error(`audit: ${describeProblem(problem)}`);
    process.exit(1);
  }
  console.log(
    `audit: ${String(result.advisories.length)} high/critical advisories, all allowlisted`,
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
