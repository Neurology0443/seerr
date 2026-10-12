import type { MediaType } from '@server/constants/media';
import { getSettings } from '@server/lib/settings';
import AsyncLock from '@server/utils/asyncLock';
import {
  hasDvrConnectionChanged,
  type DvrConnectionSettings,
} from '@server/utils/dvrIdentityLock';

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
  connectionInvalidated: boolean;
}>();

// Register before fetching inventory, not before writing it. Invalidations live
// only for that scan; a later scan can rediscover genuinely re-added media.
export const beginDestinationScan = (
  mediaType: MediaType,
  serverId: number,
  connection?: DvrConnectionSettings
) => {
  // Snapshot the API connection, including a server captured earlier in a run.
  const observedConnection = connection ? { ...connection } : undefined;
  const scan = {
    mediaType,
    serverId,
    removedTmdbIds: new Set<number>(),
    connectionInvalidated: false,
  };
  let active = true;
  scans.add(scan);
  return {
    // Call inside destination -> identity locks, keeping the check and writes
    // atomic with settings mutation. Invalidation can never be reversed by ABA.
    isFresh: (tmdbId: number): boolean => {
      if (
        !active ||
        scan.connectionInvalidated ||
        scan.removedTmdbIds.has(tmdbId)
      )
        return false;
      if (!observedConnection) return true;
      const current = getSettings()[
        mediaType === 'movie' ? 'radarr' : 'sonarr'
      ].find((server) => server.id === serverId);
      return (
        current?.independentRequestDestination === true &&
        !hasDvrConnectionChanged(observedConnection, current)
      );
    },
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

// Called synchronously with connection replacement/deletion under identity.
// Invalidating active observations is equivalent to advancing their generation:
// restoring the previous connection cannot make an invalidated scan fresh.
export const invalidateDestinationConnectionScans = (
  mediaType: MediaType,
  serverId: number
): void => {
  for (const scan of scans) {
    if (scan.mediaType === mediaType && scan.serverId === serverId)
      scan.connectionInvalidated = true;
  }
};
