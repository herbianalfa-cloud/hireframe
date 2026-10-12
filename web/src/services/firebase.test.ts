import type { FirebaseStorage } from 'firebase/storage';
import { describe, expect, it } from 'vitest';

import { DOWNLOAD_TIME_LIMIT_MS, withDownloadLimit } from './firebase';

// A stand-in with the two retry windows the Storage SDK exposes (its defaults are 2 and 10 minutes).
const fakeStorage = () =>
  ({ maxOperationRetryTime: 120_000, maxUploadRetryTime: 600_000 }) as FirebaseStorage;

describe('withDownloadLimit', () => {
  it('ends the download and delete retry window at the download limit', () => {
    const storage = fakeStorage();
    expect(withDownloadLimit(storage)).toBe(storage);
    expect(storage.maxOperationRetryTime).toBe(DOWNLOAD_TIME_LIMIT_MS);
  });

  it('leaves the upload retry window alone', () => {
    const storage = withDownloadLimit(fakeStorage());
    expect(storage.maxUploadRetryTime).toBe(600_000);
  });
});
