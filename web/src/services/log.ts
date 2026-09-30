/**
 * Structured error log. Fields are scalar only and must never carry personal data
 * (emails, CV text, job descriptions): docs/SECURITY.md "Sensitive data in logs".
 */
export function logError(
  event: string,
  fields: Record<string, string | number | boolean> = {},
): void {
  console.error(JSON.stringify({ level: 'error', event, ...fields }));
}

/** Firebase errors carry a string `code` (`permission-denied`, `auth/popup-blocked`, …). */
export function errorCode(error: unknown): string | undefined {
  if (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    typeof error.code === 'string'
  ) {
    return error.code;
  }
  return undefined;
}
