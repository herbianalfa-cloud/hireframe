import type { BlockedCode, CvIssueCode, Question } from '@hireframe/shared';
import {
  CircleCheck,
  Hourglass,
  Inbox,
  MessageCircleQuestion,
  Send,
  type LucideIcon,
} from 'lucide-react';

import type { PipelineStage } from '@/services/applications';

/** Every stage has a label and an icon besides its colour (never colour alone). */
export interface StageMeta {
  label: string;
  Icon: LucideIcon;
  /** Text and badge classes from the stage tokens (full class names, so Tailwind finds them). */
  text: string;
  badge: string;
  empty: string;
}

export const STAGE_META: Readonly<Record<PipelineStage, StageMeta>> = {
  chosen: {
    label: 'Chosen',
    Icon: Inbox,
    text: 'text-stage-chosen',
    badge: 'border-stage-chosen/40 bg-stage-chosen/10 text-stage-chosen',
    empty: 'Nothing is waiting here. Applications that are blocked show up in this list.',
  },
  needs_input: {
    label: 'Needs your input',
    Icon: MessageCircleQuestion,
    text: 'text-stage-input',
    badge: 'border-stage-input/40 bg-stage-input/10 text-stage-input',
    empty: 'No questions waiting for you.',
  },
  generating: {
    label: 'Generating',
    Icon: Hourglass,
    text: 'text-stage-generating',
    badge: 'border-stage-generating/40 bg-stage-generating/10 text-stage-generating',
    empty: 'No CVs are being written.',
  },
  ready: {
    label: 'Ready to send',
    Icon: Send,
    text: 'text-stage-ready',
    badge: 'border-stage-ready/40 bg-stage-ready/10 text-stage-ready',
    empty: 'No CVs are ready yet.',
  },
  applied: {
    label: 'Applied',
    Icon: CircleCheck,
    text: 'text-stage-applied',
    badge: 'border-stage-applied/40 bg-stage-applied/10 text-stage-applied',
    empty: 'No applications are marked applied.',
  },
};

/** Why an application is stuck in Chosen, in words, with what to do about it. */
export const BLOCKED_TEXT: Readonly<Record<BlockedCode, string>> = {
  cap: "This month's model budget is used up, so no CV can be written. Retry when it resets.",
  daily_cap: "Today's application budget is used up. Retry tomorrow.",
  no_deep_read:
    "This job hasn't had a full read yet, so there is nothing to tailor a CV against. Retry once it has.",
  cv_header_missing:
    'Your CV header is missing or can’t be used. Add your name and email on Profile, then retry.',
  invalid_output:
    "The model's drafts didn't pass the fact checks, twice. Retry to try again, or add a fact on Profile that covers what was missing.",
  attempts_exhausted: 'An earlier run stopped before it finished. Retry to start the CV again.',
  error: 'Something failed while writing the CV (a service error, or no usable facts). Retry.',
};

/** What each fact-check code means, for the "didn't pass" note. */
export const ISSUE_TEXT: Readonly<Record<CvIssueCode, string>> = {
  uncited: 'a claim had no supporting fact',
  unknown_fact: 'a cited fact no longer exists',
  wrong_fact_type: 'a fact was used in the wrong place',
  unsupported_number: 'a number was not in the cited fact',
  unsupported_text: 'wording was not in the cited fact',
  contact_in_text: 'contact details appeared in the text',
  too_long: "it didn't fit on one page",
  unsupported_char: 'a character the PDF font can’t print',
};

export const LEVEL_TEXT: Readonly<Record<Question['level'], string>> = {
  must: 'Must have',
  nice: 'Nice to have',
};

export const MATCH_TEXT: Readonly<Record<Question['match'], string>> = {
  met: 'Met',
  partial: 'Partly covered',
  missing: 'Not covered',
};
