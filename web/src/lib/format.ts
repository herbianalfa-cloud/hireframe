const DATE_FORMAT = new Intl.DateTimeFormat('en-GB', {
  day: 'numeric',
  month: 'short',
  year: 'numeric',
});

/** "1 Oct 2026". */
export function formatDate(date: Date): string {
  return DATE_FORMAT.format(date);
}
