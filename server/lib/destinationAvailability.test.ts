import {
  MediaRequestStatus,
  MediaStatus,
  MediaType,
} from '@server/constants/media';
import { getRepository } from '@server/datasource';
import Media from '@server/entity/Media';
import { MediaDestinationSeasonStatus } from '@server/entity/MediaDestinationSeasonStatus';
import { MediaDestinationStatus } from '@server/entity/MediaDestinationStatus';
import { MediaRequest } from '@server/entity/MediaRequest';
import SeasonRequest from '@server/entity/SeasonRequest';
import { User } from '@server/entity/User';
import {
  completeRequestsForDestination,
  rollupDestinationTvStatus,
  transitionDestinationSeasonStatus,
} from '@server/lib/destinationAvailability';
import { setupTestDb } from '@server/test/db';
import assert from 'node:assert/strict';
import { describe, it, mock } from 'node:test';

setupTestDb();
mock.method(MediaRequest, 'sendNotification', async () => undefined);

const setRequestStatusWithoutListeners = async (
  request: MediaRequest,
  status: MediaRequestStatus
): Promise<void> => {
  await getRepository(MediaRequest)
    .createQueryBuilder()
    .update(MediaRequest)
    .set({ status })
    .where('id = :id', { id: request.id })
    .callListeners(false)
    .execute();
};

const createRequest = async ({
  media,
  serverId,
  status = MediaRequestStatus.APPROVED,
  seasons = [],
}: {
  media: Media;
  serverId: number;
  status?: MediaRequestStatus;
  seasons?: number[];
}): Promise<MediaRequest> => {
  const requestedBy = await getRepository(User).findOneOrFail({
    where: { id: 1 },
  });
  const request = await getRepository(MediaRequest).save(
    new MediaRequest({
      type: media.mediaType,
      status: MediaRequestStatus.PENDING,
      media,
      requestedBy,
      is4k: false,
      serverId,
      seasons: seasons.map(
        (seasonNumber) =>
          new SeasonRequest({
            seasonNumber,
            status: MediaRequestStatus.APPROVED,
          })
      ),
    })
  );
  await setRequestStatusWithoutListeners(request, status);
  request.status = status;
  return request;
};

describe('destination availability', () => {
  it('rolls TV state up without allowing specials to determine the parent', () => {
    assert.strictEqual(
      rollupDestinationTvStatus(MediaStatus.UNKNOWN, [
        { seasonNumber: 0, status: MediaStatus.AVAILABLE },
        { seasonNumber: 1, status: MediaStatus.PROCESSING },
      ]),
      MediaStatus.PROCESSING
    );
    assert.strictEqual(
      rollupDestinationTvStatus(MediaStatus.UNKNOWN, [
        { seasonNumber: 1, status: MediaStatus.AVAILABLE },
        { seasonNumber: 2, status: MediaStatus.AVAILABLE },
      ]),
      MediaStatus.AVAILABLE
    );
    assert.strictEqual(
      rollupDestinationTvStatus(MediaStatus.UNKNOWN, [
        { seasonNumber: 1, status: MediaStatus.AVAILABLE },
        { seasonNumber: 2, status: MediaStatus.PROCESSING },
      ]),
      MediaStatus.PARTIALLY_AVAILABLE
    );
    assert.strictEqual(
      rollupDestinationTvStatus(MediaStatus.AVAILABLE, [
        { seasonNumber: 1, status: MediaStatus.DELETED },
      ]),
      MediaStatus.DELETED
    );
    assert.strictEqual(
      rollupDestinationTvStatus(MediaStatus.PENDING, [
        { seasonNumber: 1, status: MediaStatus.UNKNOWN },
      ]),
      MediaStatus.PENDING
    );
    assert.strictEqual(
      rollupDestinationTvStatus(MediaStatus.UNKNOWN, [
        { seasonNumber: 1, status: MediaStatus.UNKNOWN },
      ]),
      MediaStatus.UNKNOWN
    );
  });

  it('applies safe TV season transitions including zero-episode observations', () => {
    assert.strictEqual(
      transitionDestinationSeasonStatus(MediaStatus.AVAILABLE, {
        seasonNumber: 1,
        totalEpisodes: 0,
        availableEpisodes: 0,
        monitored: false,
      }),
      MediaStatus.AVAILABLE
    );
    assert.strictEqual(
      transitionDestinationSeasonStatus(MediaStatus.UNKNOWN, {
        seasonNumber: 1,
        totalEpisodes: 10,
        availableEpisodes: 4,
        monitored: true,
      }),
      MediaStatus.PARTIALLY_AVAILABLE
    );
    assert.strictEqual(
      transitionDestinationSeasonStatus(MediaStatus.PROCESSING, {
        seasonNumber: 1,
        totalEpisodes: 10,
        availableEpisodes: 0,
        monitored: false,
      }),
      MediaStatus.UNKNOWN
    );
    assert.strictEqual(
      transitionDestinationSeasonStatus(MediaStatus.PARTIALLY_AVAILABLE, {
        seasonNumber: 1,
        totalEpisodes: 10,
        availableEpisodes: 0,
        monitored: false,
      }),
      MediaStatus.DELETED
    );
  });

  it('completes only approved movie requests for the exact destination', async () => {
    const media = await getRepository(Media).save(
      new Media({ tmdbId: 101, mediaType: MediaType.MOVIE })
    );
    await getRepository(MediaDestinationStatus).save([
      new MediaDestinationStatus({
        mediaId: media.id,
        serverId: 10,
        status: MediaStatus.AVAILABLE,
      }),
      new MediaDestinationStatus({
        mediaId: media.id,
        serverId: 11,
        status: MediaStatus.AVAILABLE,
      }),
    ]);
    const exact = await createRequest({ media, serverId: 10 });
    const other = await createRequest({ media, serverId: 11 });
    const failed = await createRequest({
      media,
      serverId: 10,
      status: MediaRequestStatus.FAILED,
    });
    const declined = await createRequest({
      media,
      serverId: 10,
      status: MediaRequestStatus.DECLINED,
    });

    await completeRequestsForDestination(media.id, 10);

    const statuses = new Map(
      (
        await getRepository(MediaRequest).findByIds([
          exact.id,
          other.id,
          failed.id,
          declined.id,
        ])
      ).map((request) => [request.id, request.status])
    );
    assert.strictEqual(statuses.get(exact.id), MediaRequestStatus.COMPLETED);
    assert.strictEqual(statuses.get(other.id), MediaRequestStatus.APPROVED);
    assert.strictEqual(statuses.get(failed.id), MediaRequestStatus.FAILED);
    assert.strictEqual(statuses.get(declined.id), MediaRequestStatus.DECLINED);
  });

  it('does not complete an active movie request from DELETED state', async () => {
    const media = await getRepository(Media).save(
      new Media({ tmdbId: 102, mediaType: MediaType.MOVIE })
    );
    await getRepository(MediaDestinationStatus).save(
      new MediaDestinationStatus({
        mediaId: media.id,
        serverId: 12,
        status: MediaStatus.DELETED,
      })
    );
    const request = await createRequest({ media, serverId: 12 });

    await completeRequestsForDestination(media.id, 12);

    assert.strictEqual(
      (
        await getRepository(MediaRequest).findOneOrFail({
          where: { id: request.id },
        })
      ).status,
      MediaRequestStatus.APPROVED
    );
  });

  it('completes only available requested TV seasons on the exact destination', async () => {
    const media = await getRepository(Media).save(
      new Media({
        tmdbId: 201,
        tvdbId: 301,
        mediaType: MediaType.TV,
      })
    );
    const destination = await getRepository(MediaDestinationStatus).save(
      new MediaDestinationStatus({
        mediaId: media.id,
        serverId: 20,
        status: MediaStatus.PARTIALLY_AVAILABLE,
      })
    );
    const otherDestination = await getRepository(MediaDestinationStatus).save(
      new MediaDestinationStatus({
        mediaId: media.id,
        serverId: 21,
        status: MediaStatus.AVAILABLE,
      })
    );
    await getRepository(MediaDestinationSeasonStatus).save([
      new MediaDestinationSeasonStatus({
        destinationStatusId: destination.id,
        seasonNumber: 1,
        status: MediaStatus.AVAILABLE,
      }),
      new MediaDestinationSeasonStatus({
        destinationStatusId: destination.id,
        seasonNumber: 2,
        status: MediaStatus.PROCESSING,
      }),
      new MediaDestinationSeasonStatus({
        destinationStatusId: otherDestination.id,
        seasonNumber: 2,
        status: MediaStatus.AVAILABLE,
      }),
    ]);
    const request = await createRequest({
      media,
      serverId: 20,
      seasons: [1, 2],
    });
    const singleSeasonRequest = await createRequest({
      media,
      serverId: 20,
      seasons: [1],
    });

    await completeRequestsForDestination(media.id, 20);

    let updated = await getRepository(MediaRequest).findOneOrFail({
      where: { id: request.id },
      relations: { seasons: true },
    });
    assert.strictEqual(updated.status, MediaRequestStatus.APPROVED);
    assert.strictEqual(
      updated.seasons.find((season) => season.seasonNumber === 1)?.status,
      MediaRequestStatus.COMPLETED
    );
    assert.strictEqual(
      updated.seasons.find((season) => season.seasonNumber === 2)?.status,
      MediaRequestStatus.APPROVED
    );
    assert.strictEqual(
      (
        await getRepository(MediaRequest).findOneByOrFail({
          id: singleSeasonRequest.id,
        })
      ).status,
      MediaRequestStatus.COMPLETED
    );

    const season2 = await getRepository(
      MediaDestinationSeasonStatus
    ).findOneOrFail({
      where: { destinationStatusId: destination.id, seasonNumber: 2 },
    });
    season2.status = MediaStatus.AVAILABLE;
    await getRepository(MediaDestinationSeasonStatus).save(season2);
    await completeRequestsForDestination(media.id, 20);

    updated = await getRepository(MediaRequest).findOneOrFail({
      where: { id: request.id },
      relations: { seasons: true },
    });
    assert.strictEqual(updated.status, MediaRequestStatus.COMPLETED);
    assert.ok(
      updated.seasons.every(
        (season) => season.status === MediaRequestStatus.COMPLETED
      )
    );
  });
});
