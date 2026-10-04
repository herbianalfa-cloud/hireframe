import type { Job } from '@hireframe/shared';

/**
 * "Jobs by Adzuna" (ADR-025): the official logo, self-hosted, linked to adzuna.co.uk. It sits on
 * a white chip so the green artwork reads in the dark theme. No request leaves the page until the
 * owner clicks.
 */
export function AdzunaAttribution() {
  return (
    <a
      href="https://www.adzuna.co.uk"
      aria-label="Jobs by Adzuna"
      target="_blank"
      rel="noopener noreferrer"
      className="inline-flex min-h-11 items-center gap-2 text-xs text-muted-foreground"
    >
      Jobs by
      <span className="rounded-sm bg-white px-1.5 py-1">
        <img
          src="/attribution/adzuna-logo.png"
          alt="Adzuna"
          width={116}
          height={30}
          className="block h-[30px] w-[116px]"
        />
      </span>
    </a>
  );
}

/** Attribution a listing owes its sources: Adzuna's logo, or a plain "via Reed" link. */
export function SourceAttribution({ job }: { job: Pick<Job, 'sources'> }) {
  const ids = new Set(job.sources.map((source) => source.id));
  const reed = job.sources.find((source) => source.id === 'reed');
  if (!ids.has('adzuna') && !reed) return null;
  return (
    <span className="flex flex-wrap items-center gap-x-4">
      {ids.has('adzuna') ? <AdzunaAttribution /> : null}
      {reed ? (
        <a
          href={reed.url}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex min-h-11 items-center text-xs text-muted-foreground underline underline-offset-4"
        >
          via Reed
        </a>
      ) : null}
    </span>
  );
}
