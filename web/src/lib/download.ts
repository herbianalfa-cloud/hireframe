/** How long the object URL lives: long enough for the browser to start the save. */
const REVOKE_AFTER_MS = 30_000;

/** Hands a blob to the browser as a file download. Nothing is opened or rendered. */
export function saveBlob(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = fileName;
  link.rel = 'noopener';
  document.body.append(link);
  link.click();
  link.remove();
  window.setTimeout(() => {
    URL.revokeObjectURL(url);
  }, REVOKE_AFTER_MS);
}
