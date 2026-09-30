import type { Fact, FactChange, ParseErrorCode } from '@hireframe/shared';

type FactType = Fact['type'];
type Lane = Fact['lanes'][number];

export const TYPE_LABELS: Record<FactType, { singular: string; plural: string }> = {
  skill: { singular: 'Skill', plural: 'Skills' },
  experience: { singular: 'Experience', plural: 'Experience' },
  achievement: { singular: 'Achievement', plural: 'Achievements' },
  metric: { singular: 'Metric', plural: 'Metrics' },
  education: { singular: 'Education', plural: 'Education' },
  project: { singular: 'Project', plural: 'Projects' },
  constraint: { singular: 'Constraint', plural: 'Constraints' },
  preference: { singular: 'Preference', plural: 'Preferences' },
};

export const LANE_LABELS: Record<Lane, string> = {
  primary: 'Primary',
  secondary: 'Secondary',
  opportunistic: 'Opportunistic',
  wildcard: 'Wildcard',
};

export const CHANGE_LABELS: Record<FactChange, string> = {
  created: 'Created',
  edit: 'Edited',
  archive: 'Archived',
  unarchive: 'Restored',
  review_accepted: 'Accepted proposed change',
  review_kept: 'Kept current',
};

export const PARSE_ERROR_MESSAGES: Record<ParseErrorCode, string> = {
  file_missing: "The file didn't finish uploading. Upload it again.",
  file_too_large: 'The file is larger than 5 MB.',
  file_type: 'That file type is not supported. Use a PDF or Word (.docx) file.',
  no_text: 'No text could be read from the file. It may be a scan or image-only PDF.',
  spend_cap: 'The monthly spend cap has been reached. Try again next month or raise the cap.',
  model_failed: "The model couldn't read this CV. Try again in a moment.",
  internal: 'Something went wrong while reading the CV. Try again.',
};

/** "2019 – present", "2019", or undefined when the fact has no dates. */
export function formatFactDates(dates: Fact['dates']): string | undefined {
  if (dates.start && dates.end) return `${dates.start} – ${dates.end}`;
  if (dates.start) return `From ${dates.start}`;
  if (dates.end) return `Until ${dates.end}`;
  return undefined;
}

export function sourceLabel(fact: Pick<Fact, 'source'>): string {
  return fact.source === 'cv' ? 'From your CV' : 'Added by you';
}
