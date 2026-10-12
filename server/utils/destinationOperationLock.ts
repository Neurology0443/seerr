import type { MediaType } from '@server/constants/media';
import AsyncLock from '@server/utils/asyncLock';

// Separate from the native request lock: hold this only in detached Arr work,
// removal, or scanner persistence, never in an awaited request subscriber.
const destinationOperationLock = new AsyncLock();

export const withDestinationOperationLock = <T>(
  mediaType: MediaType,
  tmdbId: number,
  serverId: number,
  operation: () => Promise<T>
): Promise<T> =>
  destinationOperationLock.dispatch(
    `${mediaType}:${tmdbId}:${serverId}`,
    operation
  );

const scans = new Set<{
  mediaType: MediaType;
  serverId: number;
  removedTmdbIds: Set<number>;
}>();

// Register before fetching inventory, not before writing it. Invalidations live
// only for that scan; a later scan can rediscover genuinely re-added media.
export const beginDestinationScan = (
  mediaType: MediaType,
  serverId: number
) => {
  const scan = { mediaType, serverId, removedTmdbIds: new Set<number>() };
  let active = true;
  scans.add(scan);
  return {
    isFresh: (tmdbId: number): boolean =>
      active && !scan.removedTmdbIds.has(tmdbId),
    close: (): void => {
      active = false;
      scans.delete(scan);
    },
  };
};

// Called after committed removal while the destination operation lock is held.
export const invalidateDestinationScans = (
  mediaType: MediaType,
  tmdbId: number,
  serverId: number
): void => {
  for (const scan of scans) {
    if (scan.mediaType === mediaType && scan.serverId === serverId) {
      scan.removedTmdbIds.add(tmdbId);
    }
  }
};
