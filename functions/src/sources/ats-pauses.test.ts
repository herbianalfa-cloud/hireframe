import { describe, expect, it } from 'vitest';

import { mergePauses, pausesBySource } from './ats-pauses.js';

describe('ATS host pauses', () => {
  it('files a pause under the source that owns the board host, and drops other hosts', () => {
    const grouped = pausesBySource([
      { host: 'boards-api.greenhouse.io', until: 10 },
      { host: 'api.eu.lever.co', until: 20 },
      { host: 'api.lever.co', until: 30 },
      { host: 'www.linkedin.com', until: 40 },
    ]);
    expect(grouped.get('greenhouse')).toEqual([{ host: 'boards-api.greenhouse.io', until: 10 }]);
    expect(grouped.get('lever')).toHaveLength(2);
    expect([...grouped.keys()]).toEqual(['greenhouse', 'lever']);
  });

  it('merges to one entry a host, the later end wins, ended pauses go', () => {
    expect(
      mergePauses(
        [
          { host: 'a', until: 100 },
          { host: 'b', until: 5 },
        ],
        [{ host: 'a', until: 200 }],
        50,
      ),
    ).toEqual([{ host: 'a', until: 200 }]);
  });
});
