/** Command-line options of `scripts/load-test.ts`, parsed without dependencies. */
export interface LoadTestArgs {
  jobs: number;
  s1Passes: number;
}

function positiveInt(name: string, value: string | undefined): number {
  const n = Number(value);
  if (value === undefined || !Number.isInteger(n) || n <= 0) {
    throw new Error(`${name} needs a positive whole number`);
  }
  return n;
}

export function parseLoadTestArgs(argv: readonly string[]): LoadTestArgs {
  const out: LoadTestArgs = { jobs: 1_000, s1Passes: 105 };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--jobs') out.jobs = positiveInt('--jobs', argv[++i]);
    else if (arg === '--s1-passes') out.s1Passes = positiveInt('--s1-passes', argv[++i]);
    else throw new Error(`Unknown option: ${arg ?? ''}`);
  }
  if (out.s1Passes > out.jobs) throw new Error('--s1-passes cannot exceed --jobs');
  return out;
}
