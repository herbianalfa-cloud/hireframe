/**
 * The scan schedule (PRD R4) and the next time it fires. Shared so Today can show "Next run"
 * from the same value Cloud Scheduler uses (ADR-051). Pure: callers pass `now`.
 */

/** PRD R4: 07:30 and 17:30 on weekdays, UK time (Cloud Scheduler handles the clock change). */
export const SCHEDULE = {
  cron: '30 7,17 * * 1-5',
  timeZone: 'Europe/London',
} as const;

export interface Schedule {
  readonly cron: string;
  readonly timeZone: string;
}

interface ParsedCron {
  minute: number;
  hours: number[];
  firstDay: number;
  lastDay: number;
}

const CRON_FORM = /^(\d{1,2}) (\d{1,2}(?:,\d{1,2})*) \* \* ([0-7])-([0-7])$/;
const SEARCH_DAYS = 8;

/** Only `M H1,H2 * * D1-D5` is supported, the one form the app uses. Anything else throws. */
function parseCron(cron: string): ParsedCron {
  const match = CRON_FORM.exec(cron);
  if (!match) throw new Error(`Unsupported cron form: ${cron}`);
  const minute = Number(match[1]);
  const hours = (match[2] ?? '').split(',').map(Number);
  const firstDay = Number(match[3]);
  const lastDay = Number(match[4]);
  if (minute > 59 || hours.some((hour) => hour > 23) || firstDay > lastDay) {
    throw new Error(`Unsupported cron form: ${cron}`);
  }
  return { minute, hours, firstDay, lastDay };
}

interface ZoneParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
}

function zoneParts(date: Date, timeZone: string): ZoneParts {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  })
    .formatToParts(date)
    .reduce<Record<string, number>>((acc, part) => {
      if (part.type !== 'literal') acc[part.type] = Number(part.value);
      return acc;
    }, {});
  return {
    year: parts.year ?? 0,
    month: parts.month ?? 0,
    day: parts.day ?? 0,
    hour: parts.hour ?? 0,
    minute: parts.minute ?? 0,
  };
}

/** The instant the zone's wall clock reads `hour:minute` on the given day, or null if it never does. */
function zoneInstant(day: ZoneParts, hour: number, minute: number, timeZone: string): Date | null {
  const utc = Date.UTC(day.year, day.month - 1, day.day, hour, minute);
  // The zone is at most an hour ahead of UTC in Europe/London; try both offsets.
  for (const candidate of [utc, utc - 3_600_000]) {
    const parts = zoneParts(new Date(candidate), timeZone);
    if (
      parts.year === day.year &&
      parts.month === day.month &&
      parts.day === day.day &&
      parts.hour === hour &&
      parts.minute === minute
    ) {
      return new Date(candidate);
    }
  }
  return null;
}

/** The first run strictly after `now`, in the schedule's time zone (it follows the clock change). */
export function nextScheduledRun(now: Date, schedule: Schedule = SCHEDULE): Date {
  const { minute, hours, firstDay, lastDay } = parseCron(schedule.cron);
  const today = zoneParts(now, schedule.timeZone);
  const sortedHours = [...hours].sort((a, b) => a - b);
  for (let offset = 0; offset < SEARCH_DAYS; offset++) {
    const date = new Date(Date.UTC(today.year, today.month - 1, today.day + offset));
    const weekday = date.getUTCDay();
    if (weekday < firstDay || weekday > lastDay) continue;
    const day: ZoneParts = {
      year: date.getUTCFullYear(),
      month: date.getUTCMonth() + 1,
      day: date.getUTCDate(),
      hour: 0,
      minute: 0,
    };
    for (const hour of sortedHours) {
      const at = zoneInstant(day, hour, minute, schedule.timeZone);
      if (at && at.getTime() > now.getTime()) return at;
    }
  }
  throw new Error(`No run within ${String(SEARCH_DAYS)} days: ${schedule.cron}`);
}
