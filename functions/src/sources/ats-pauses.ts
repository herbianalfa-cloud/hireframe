import type { HostPause } from '../http/client.js';
import { ashbyBoardUrl } from './ashby.js';
import { greenhouseBoardUrl } from './greenhouse.js';
import { leverBoardUrl } from './lever.js';
import { workableBoardUrl } from './workable.js';

/**
 * Which ATS source's health record (`sources/{id}`) carries the pauses of a board host. The scan
 * reads and carries those records' `pausedHosts` into its own clients, so a pause the ATS search
 * is given (Lookup, or S3's hydrator) is saved there and honoured by the next scan too.
 */
export const ATS_SOURCE_IDS = ['greenhouse', 'lever', 'ashby', 'workable'] as const;
export type AtsSourceId = (typeof ATS_SOURCE_IDS)[number];

const HOST_OWNERS: ReadonlyMap<string, AtsSourceId> = new Map([
  [new URL(greenhouseBoardUrl('x')).host, 'greenhouse'],
  [new URL(leverBoardUrl('x')).host, 'lever'],
  [new URL(leverBoardUrl('x', 'eu')).host, 'lever'],
  [new URL(ashbyBoardUrl('x')).host, 'ashby'],
  [new URL(workableBoardUrl('x')).host, 'workable'],
]);

/** The pauses grouped by the ATS source that owns the host; hosts of no ATS are left out. */
export function pausesBySource(pauses: readonly HostPause[]): Map<AtsSourceId, HostPause[]> {
  const grouped = new Map<AtsSourceId, HostPause[]>();
  for (const pause of pauses) {
    const owner = HOST_OWNERS.get(pause.host);
    if (!owner) continue;
    grouped.set(owner, [...(grouped.get(owner) ?? []), pause]);
  }
  return grouped;
}

/** Two lists of pauses as one: one entry per host, the later end wins, ended ones dropped. */
export function mergePauses(
  a: readonly HostPause[],
  b: readonly HostPause[],
  nowMs: number,
): HostPause[] {
  const latest = new Map<string, number>();
  for (const { host, until } of [...a, ...b]) {
    if (until > nowMs) latest.set(host, Math.max(latest.get(host) ?? 0, until));
  }
  return [...latest].map(([host, until]) => ({ host, until }));
}
