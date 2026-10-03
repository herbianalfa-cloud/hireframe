/**
 * Labelling the golden set (ADR-036), in a spreadsheet:
 *   node scripts/eval-labels.ts export                     → tmp/golden-labels.csv
 *   node scripts/eval-labels.ts import tmp/golden-labels.csv → labels into evals/golden.jsonl
 * The export leaves out what each case was designed to test, so you label blind. The import
 * accepts apply, near_miss (or "near miss"), wildcard or skip, then lists the cases where your
 * label differs from the design so you can look again. Your label always wins.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';

export const GOLDEN = 'evals/golden.jsonl';
export const SHEET = 'tmp/golden-labels.csv';
const VERDICTS = ['apply', 'near_miss', 'wildcard', 'skip'] as const;
type Verdict = (typeof VERDICTS)[number];

interface GoldenLine {
  id: string;
  designedAs: Verdict;
  label: Verdict | null;
  note: string;
  posting: {
    title: string;
    company: string;
    location: string;
    postedDaysAgo: number | null;
    salary?: { min?: number; max?: number };
    companySize?: string;
    description: string;
  };
  [key: string]: unknown;
}

const COLUMNS = [
  'id',
  'title',
  'company',
  'location',
  'posted_days_ago',
  'salary',
  'company_size',
  'description',
  'verdict',
  'note',
] as const;

function cell(value: string): string {
  return /[",\n\r]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

export function readGolden(text: string): GoldenLine[] {
  return text
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line) as GoldenLine);
}

export function toCsv(cases: readonly GoldenLine[]): string {
  const rows = cases.map((c) => {
    const salary = c.posting.salary
      ? [c.posting.salary.min, c.posting.salary.max].filter((n) => n !== undefined).join('-')
      : '';
    return [
      c.id,
      c.posting.title,
      c.posting.company,
      c.posting.location,
      c.posting.postedDaysAgo === null ? 'unknown' : String(c.posting.postedDaysAgo),
      salary,
      c.posting.companySize ?? '',
      c.posting.description,
      c.label ?? '',
      c.note,
    ]
      .map(cell)
      .join(',');
  });
  return `${COLUMNS.join(',')}\n${rows.join('\n')}\n`;
}

/** RFC 4180 CSV: quoted cells may hold commas, doubled quotes and line breaks. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let value = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const char = text[i] ?? '';
    if (quoted) {
      if (char === '"' && text[i + 1] === '"') {
        value += '"';
        i++;
      } else if (char === '"') quoted = false;
      else value += char;
    } else if (char === '"') quoted = true;
    else if (char === ',') {
      row.push(value);
      value = '';
    } else if (char === '\n' || char === '\r') {
      if (char === '\r' && text[i + 1] === '\n') i++;
      row.push(value);
      rows.push(row);
      row = [];
      value = '';
    } else value += char;
  }
  if (value !== '' || row.length > 0) {
    row.push(value);
    rows.push(row);
  }
  return rows.filter((r) => r.some((c) => c.trim() !== ''));
}

export function normaliseVerdict(raw: string): Verdict | null | 'invalid' {
  const value = raw
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, '_');
  if (value === '') return null;
  return (VERDICTS as readonly string[]).includes(value) ? (value as Verdict) : 'invalid';
}

export interface ImportResult {
  cases: GoldenLine[];
  labelled: number;
  unlabelled: string[];
  differFromDesign: { id: string; designedAs: Verdict; label: Verdict }[];
  errors: string[];
}

export function applyLabels(cases: readonly GoldenLine[], csv: string): ImportResult {
  const [header = [], ...rows] = parseCsv(csv);
  const idAt = header.indexOf('id');
  const verdictAt = header.indexOf('verdict');
  const noteAt = header.indexOf('note');
  const errors: string[] = [];
  if (idAt < 0 || verdictAt < 0) errors.push('The sheet needs its id and verdict columns.');
  const byId = new Map<string, { label: Verdict | null; note: string }>();
  for (const row of rows) {
    const id = (row[idAt] ?? '').trim();
    const label = normaliseVerdict(row[verdictAt] ?? '');
    if (!cases.some((c) => c.id === id)) errors.push(`Unknown case "${id}".`);
    else if (label === 'invalid') {
      errors.push(`${id}: "${row[verdictAt] ?? ''}" isn't apply, near_miss, wildcard or skip.`);
    } else
      byId.set(id, { label, note: (noteAt >= 0 ? row[noteAt] : '')?.trim().slice(0, 300) ?? '' });
  }
  const next = cases.map((c) => {
    const update = byId.get(c.id);
    return update ? { ...c, label: update.label, note: update.note } : c;
  });
  return {
    cases: next,
    labelled: next.filter((c) => c.label !== null).length,
    unlabelled: next.filter((c) => c.label === null).map((c) => c.id),
    differFromDesign: next
      .filter(
        (c): c is GoldenLine & { label: Verdict } => c.label !== null && c.label !== c.designedAs,
      )
      .map((c) => ({ id: c.id, designedAs: c.designedAs, label: c.label })),
    errors,
  };
}

function main(args: readonly string[]): void {
  const [command, file = SHEET] = args;
  const cases = readGolden(readFileSync(GOLDEN, 'utf8'));
  if (command === 'export') {
    mkdirSync('tmp', { recursive: true });
    writeFileSync(SHEET, toCsv(cases));
    console.log(
      `eval-labels: wrote ${SHEET} (${String(cases.length)} postings). Read evals/README.md for the candidate, fill in the verdict column, save as CSV, then run: node scripts/eval-labels.ts import ${SHEET}`,
    );
    return;
  }
  if (command === 'import') {
    const result = applyLabels(cases, readFileSync(file, 'utf8'));
    if (result.errors.length > 0) {
      console.error(`eval-labels: nothing written.\n- ${result.errors.join('\n- ')}`);
      process.exitCode = 1;
      return;
    }
    writeFileSync(GOLDEN, result.cases.map((c) => JSON.stringify(c)).join('\n') + '\n');
    console.log(`eval-labels: ${String(result.labelled)} of ${String(cases.length)} labelled.`);
    if (result.unlabelled.length > 0)
      console.log(`Still unlabelled: ${result.unlabelled.join(', ')}`);
    if (result.differFromDesign.length > 0) {
      console.log(
        'These differ from what the case was written to test. Look again; keep yours if you agree:',
      );
      for (const d of result.differFromDesign) {
        console.log(`  ${d.id}: you said ${d.label}, designed as ${d.designedAs}`);
      }
    }
    return;
  }
  console.error('Usage: node scripts/eval-labels.ts export | import [file.csv]');
  process.exitCode = 1;
}

if (process.argv[1]?.endsWith('eval-labels.ts')) main(process.argv.slice(2));
