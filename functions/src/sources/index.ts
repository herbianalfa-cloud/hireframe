import type { ScanSourceId } from '@hireframe/shared';

import { createAdzunaSource } from './adzuna.js';
import { createAshbySource } from './ashby.js';
import { createGreenhouseSource } from './greenhouse.js';
import { createHnSource } from './hn.js';
import { createLeverSource } from './lever.js';
import { createReedSource } from './reed.js';
import type { Source } from './types.js';
import { createWorkableSource } from './workable.js';

/** Fresh source instances for one run (ARCHITECTURE "Sources", ADR-025–029). */
export function createSources(): Record<ScanSourceId, Source> {
  return {
    greenhouse: createGreenhouseSource(),
    lever: createLeverSource(),
    ashby: createAshbySource(),
    workable: createWorkableSource(),
    reed: createReedSource(),
    adzuna: createAdzunaSource(),
    hn: createHnSource(),
  };
}
