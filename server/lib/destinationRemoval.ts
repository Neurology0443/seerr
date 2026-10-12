import { MediaStatus, MediaType } from '@server/constants/media';
import Media from '@server/entity/Media';
import { MediaDestinationSeasonStatus } from '@server/entity/MediaDestinationSeasonStatus';
import { MediaDestinationStatus } from '@server/entity/MediaDestinationStatus';
import type { MediaRequest } from '@server/entity/MediaRequest';
import { declineRequestsForDestination } from '@server/lib/destinationAvailability';
import { invalidateDestinationScans } from '@server/utils/destinationOperationLock';
import type { EntityManager } from 'typeorm';

// Call only after the exact Arr instance confirms removal or absence.
// The HTTP call must finish before this transaction begins.
export const persistConfirmedDestinationRemoval = async (
  mediaId: number,
  serverId: number,
  manager: EntityManager
): Promise<MediaRequest[]> => {
  const { declinedRequests, media } = await manager.transaction(async (tx) => {
    const destination = await tx.findOneOrFail(MediaDestinationStatus, {
      where: { mediaId, serverId },
    });
    const media = await tx.findOneOrFail(Media, { where: { id: mediaId } });
    const declined = await declineRequestsForDestination(mediaId, serverId, tx);

    // Reconciliation can release request-driven states; explicit removal wins.
    await tx.update(
      MediaDestinationStatus,
      { id: destination.id, mediaId, serverId },
      {
        status: MediaStatus.DELETED,
        externalServiceId: null,
        externalServiceSlug: null,
      }
    );
    if (media.mediaType === MediaType.TV) {
      await tx.update(
        MediaDestinationSeasonStatus,
        {
          destinationStatusId: destination.id,
        },
        { status: MediaStatus.DELETED }
      );
    }
    return { declinedRequests: declined, media };
  });
  invalidateDestinationScans(media.mediaType, media.tmdbId, serverId);
  return declinedRequests;
};
