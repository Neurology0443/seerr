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
  declineRequestsForDestination,
  markMissingMovieDestination,
  markMissingTvDestination,
  rollupDestinationTvStatus,
  transitionDestinationSeasonStatus,
} from '@server/lib/destinationAvailability';
import { Notification } from '@server/lib/notifications';
import { setupTestDb } from '@server/test/db';
import assert from 'node:assert/strict';
import { describe, it, mock } from 'node:test';
import { Repository, type EntityManager } from 'typeorm';

setupTestDb();
const sendNotificationMock = mock.method(
  MediaRequest,
  'sendNotification',
  async () => undefined
);

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
    assert.strictEqual(
      rollupDestinationTvStatus(MediaStatus.PROCESSING, [
        { seasonNumber: 1, status: MediaStatus.PENDING },
      ]),
      MediaStatus.PENDING
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

  for (const terminalStatus of [
    MediaRequestStatus.FAILED,
    MediaRequestStatus.DECLINED,
    MediaRequestStatus.COMPLETED,
  ]) {
    it(`does not overwrite ${terminalStatus} when movie completion loses after candidate selection`, async (t) => {
      const media = await getRepository(Media).save(
        new Media({ tmdbId: 110 + terminalStatus, mediaType: MediaType.MOVIE })
      );
      await getRepository(MediaDestinationStatus).save(
        new MediaDestinationStatus({
          mediaId: media.id,
          serverId: 13,
          status: MediaStatus.AVAILABLE,
        })
      );
      const candidate = await createRequest({ media, serverId: 13 });
      const requestRepository = getRepository(MediaRequest) as unknown as {
        find: (options: unknown) => Promise<MediaRequest[]>;
      };
      const originalFind = requestRepository.find.bind(requestRepository);
      t.mock.method(requestRepository, 'find', async (options: unknown) => {
        const requests = await originalFind(options);
        await setRequestStatusWithoutListeners(candidate, terminalStatus);
        return requests;
      });

      await completeRequestsForDestination(media.id, 13);

      assert.strictEqual(
        (
          await getRepository(MediaRequest).findOneByOrFail({
            id: candidate.id,
          })
        ).status,
        terminalStatus
      );
    });
  }

  it('does not decline or mutate children when orphan decline loses after candidate selection', async (t) => {
    const media = await getRepository(Media).save(
      new Media({
        tmdbId: 220,
        tvdbId: 320,
        mediaType: MediaType.TV,
      })
    );
    await getRepository(MediaDestinationStatus).save(
      new MediaDestinationStatus({
        mediaId: media.id,
        serverId: 22,
        status: MediaStatus.PROCESSING,
      })
    );
    const candidate = await createRequest({
      media,
      serverId: 22,
      seasons: [1],
    });
    const requestRepository = getRepository(MediaRequest) as unknown as {
      find: (options: unknown) => Promise<MediaRequest[]>;
    };
    const originalFind = requestRepository.find.bind(requestRepository);
    t.mock.method(requestRepository, 'find', async (options: unknown) => {
      const requests = await originalFind(options);
      await setRequestStatusWithoutListeners(
        candidate,
        MediaRequestStatus.FAILED
      );
      return requests;
    });

    await declineRequestsForDestination(media.id, 22);

    const updated = await getRepository(MediaRequest).findOneOrFail({
      where: { id: candidate.id },
      relations: { seasons: true },
    });
    assert.strictEqual(updated.status, MediaRequestStatus.FAILED);
    assert.strictEqual(updated.seasons[0].status, MediaRequestStatus.APPROVED);
  });

  it('stops TV child completion when the parent becomes ineligible after candidate selection', async (t) => {
    const media = await getRepository(Media).save(
      new Media({
        tmdbId: 221,
        tvdbId: 321,
        mediaType: MediaType.TV,
      })
    );
    const destination = await getRepository(MediaDestinationStatus).save(
      new MediaDestinationStatus({
        mediaId: media.id,
        serverId: 23,
        status: MediaStatus.AVAILABLE,
      })
    );
    await getRepository(MediaDestinationSeasonStatus).save(
      new MediaDestinationSeasonStatus({
        destinationStatusId: destination.id,
        seasonNumber: 1,
        status: MediaStatus.AVAILABLE,
      })
    );
    const candidate = await createRequest({
      media,
      serverId: 23,
      seasons: [1],
    });
    const requestRepository = getRepository(MediaRequest) as unknown as {
      find: (options: unknown) => Promise<MediaRequest[]>;
    };
    const originalFind = requestRepository.find.bind(requestRepository);
    t.mock.method(requestRepository, 'find', async (options: unknown) => {
      const requests = await originalFind(options);
      await setRequestStatusWithoutListeners(
        candidate,
        MediaRequestStatus.DECLINED
      );
      return requests;
    });

    await completeRequestsForDestination(media.id, 23);

    const updated = await getRepository(MediaRequest).findOneOrFail({
      where: { id: candidate.id },
      relations: { seasons: true },
    });
    assert.strictEqual(updated.status, MediaRequestStatus.DECLINED);
    assert.strictEqual(updated.seasons[0].status, MediaRequestStatus.APPROVED);
  });

  it('preserves completed TV seasons while declining active siblings', async () => {
    const media = await getRepository(Media).save(
      new Media({
        tmdbId: 222,
        tvdbId: 322,
        mediaType: MediaType.TV,
      })
    );
    await getRepository(MediaDestinationStatus).save(
      new MediaDestinationStatus({
        mediaId: media.id,
        serverId: 24,
        status: MediaStatus.PROCESSING,
      })
    );
    const request = await createRequest({
      media,
      serverId: 24,
      seasons: [1, 2, 3],
    });
    const savedRequest = await getRepository(MediaRequest).findOneOrFail({
      where: { id: request.id },
      relations: { seasons: true },
    });
    const completedSeason = savedRequest.seasons.find(
      (season) => season.seasonNumber === 1
    )!;
    const pendingSeason = savedRequest.seasons.find(
      (season) => season.seasonNumber === 3
    )!;
    completedSeason.status = MediaRequestStatus.COMPLETED;
    pendingSeason.status = MediaRequestStatus.PENDING;
    await getRepository(SeasonRequest).save([completedSeason, pendingSeason]);

    await declineRequestsForDestination(media.id, 24);

    const updated = await getRepository(MediaRequest).findOneOrFail({
      where: { id: request.id },
      relations: { seasons: true },
    });
    assert.strictEqual(updated.status, MediaRequestStatus.DECLINED);
    assert.strictEqual(
      updated.seasons.find((season) => season.seasonNumber === 1)?.status,
      MediaRequestStatus.COMPLETED
    );
    assert.strictEqual(
      updated.seasons.find((season) => season.seasonNumber === 2)?.status,
      MediaRequestStatus.DECLINED
    );
    assert.strictEqual(
      updated.seasons.find((season) => season.seasonNumber === 3)?.status,
      MediaRequestStatus.DECLINED
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

  it('rolls back every confirmed TV orphan mutation when a later season write fails', async (t) => {
    const media = await getRepository(Media).save(
      new Media({
        tmdbId: 230,
        tvdbId: 330,
        mediaType: MediaType.TV,
      })
    );
    const destination = await getRepository(MediaDestinationStatus).save(
      new MediaDestinationStatus({
        mediaId: media.id,
        serverId: 25,
        status: MediaStatus.AVAILABLE,
      })
    );
    const destinationSeason = await getRepository(
      MediaDestinationSeasonStatus
    ).save(
      new MediaDestinationSeasonStatus({
        destinationStatusId: destination.id,
        seasonNumber: 1,
        status: MediaStatus.AVAILABLE,
      })
    );
    const request = await createRequest({
      media,
      serverId: 25,
      seasons: [1],
    });
    const repositoryPrototype = Repository.prototype as unknown as {
      save: (...args: unknown[]) => Promise<unknown>;
      metadata: { target: unknown };
    };
    const originalSave = repositoryPrototype.save;
    t.mock.method(
      repositoryPrototype,
      'save',
      async function (this: typeof repositoryPrototype, ...args: unknown[]) {
        if (
          this.metadata.target === MediaDestinationSeasonStatus &&
          (Array.isArray(args[0]) ? args[0] : [args[0]]).some(
            (season) =>
              season instanceof MediaDestinationSeasonStatus &&
              season.status === MediaStatus.DELETED
          )
        ) {
          throw new Error('injected destination-season failure');
        }
        return originalSave.apply(this, args);
      }
    );

    await assert.rejects(
      markMissingTvDestination(media.id, 25),
      /injected destination-season failure/
    );

    assert.strictEqual(
      (
        await getRepository(MediaDestinationStatus).findOneByOrFail({
          id: destination.id,
        })
      ).status,
      MediaStatus.AVAILABLE
    );
    assert.strictEqual(
      (
        await getRepository(MediaDestinationSeasonStatus).findOneByOrFail({
          id: destinationSeason.id,
        })
      ).status,
      MediaStatus.AVAILABLE
    );
    const persistedRequest = await getRepository(MediaRequest).findOneOrFail({
      where: { id: request.id },
      relations: { seasons: true },
    });
    assert.strictEqual(persistedRequest.status, MediaRequestStatus.APPROVED);
    assert.strictEqual(
      persistedRequest.seasons[0].status,
      MediaRequestStatus.APPROVED
    );
  });

  it('notifies once per successful transactional TV orphan decline and preserves completed children', async () => {
    const media = await getRepository(Media).save(
      new Media({
        tmdbId: 231,
        tvdbId: 331,
        mediaType: MediaType.TV,
      })
    );
    const destination = await getRepository(MediaDestinationStatus).save(
      new MediaDestinationStatus({
        mediaId: media.id,
        serverId: 26,
        status: MediaStatus.PROCESSING,
      })
    );
    await getRepository(MediaDestinationSeasonStatus).save(
      new MediaDestinationSeasonStatus({
        destinationStatusId: destination.id,
        seasonNumber: 1,
        status: MediaStatus.PROCESSING,
      })
    );
    const request = await createRequest({
      media,
      serverId: 26,
      seasons: [1, 2],
    });
    const siblingRequest = await createRequest({
      media,
      serverId: 26,
      seasons: [3],
    });
    const persistedRequest = await getRepository(MediaRequest).findOneOrFail({
      where: { id: request.id },
      relations: { seasons: true },
    });
    persistedRequest.seasons[0].status = MediaRequestStatus.COMPLETED;
    await getRepository(SeasonRequest).save(persistedRequest.seasons[0]);
    const initialNotifications = sendNotificationMock.mock.callCount();

    await markMissingTvDestination(media.id, 26);

    const updatedRequest = await getRepository(MediaRequest).findOneOrFail({
      where: { id: request.id },
      relations: { seasons: true },
    });
    assert.strictEqual(updatedRequest.status, MediaRequestStatus.DECLINED);
    assert.strictEqual(
      (
        await getRepository(MediaRequest).findOneByOrFail({
          id: siblingRequest.id,
        })
      ).status,
      MediaRequestStatus.DECLINED
    );
    assert.strictEqual(
      updatedRequest.seasons[0].status,
      MediaRequestStatus.COMPLETED
    );
    assert.strictEqual(
      updatedRequest.seasons[1].status,
      MediaRequestStatus.DECLINED
    );
    assert.strictEqual(
      sendNotificationMock.mock.callCount(),
      initialNotifications + 2
    );
    const declineNotifications =
      sendNotificationMock.mock.calls.slice(initialNotifications);
    assert.ok(
      declineNotifications.every(
        (call) => call.arguments[2] === Notification.MEDIA_DECLINED
      )
    );
    assert.deepStrictEqual(
      declineNotifications
        .map((call) => call.arguments[0]!.id)
        .sort((first, second) => first - second),
      [request.id, siblingRequest.id].sort((first, second) => first - second)
    );
  });

  it('does not notify a TV orphan request that loses its decline CAS', async (t) => {
    const media = await getRepository(Media).save(
      new Media({
        tmdbId: 232,
        tvdbId: 332,
        mediaType: MediaType.TV,
      })
    );
    await getRepository(MediaDestinationStatus).save(
      new MediaDestinationStatus({
        mediaId: media.id,
        serverId: 27,
        status: MediaStatus.PROCESSING,
      })
    );
    const request = await createRequest({
      media,
      serverId: 27,
      seasons: [1],
    });
    const repositoryPrototype = Repository.prototype as unknown as {
      find: (...args: unknown[]) => Promise<MediaRequest[]>;
      manager: EntityManager;
      metadata: { target: unknown };
    };
    const originalFind = repositoryPrototype.find;
    let raced = false;
    t.mock.method(
      repositoryPrototype,
      'find',
      async function (this: typeof repositoryPrototype, ...args: unknown[]) {
        const requests = await originalFind.apply(this, args);
        if (
          !raced &&
          this.metadata.target === MediaRequest &&
          requests.some((candidate) => candidate.id === request.id)
        ) {
          raced = true;
          await this.manager
            .createQueryBuilder()
            .update(MediaRequest)
            .set({ status: MediaRequestStatus.FAILED })
            .where('id = :id', { id: request.id })
            .callListeners(false)
            .execute();
        }
        return requests;
      }
    );
    const initialNotifications = sendNotificationMock.mock.callCount();

    await markMissingTvDestination(media.id, 27);

    assert.strictEqual(
      (await getRepository(MediaRequest).findOneByOrFail({ id: request.id }))
        .status,
      MediaRequestStatus.FAILED
    );
    assert.strictEqual(
      sendNotificationMock.mock.callCount(),
      initialNotifications
    );
  });

  it('keeps committed TV orphan state when decline notification delivery fails', async (t) => {
    const media = await getRepository(Media).save(
      new Media({
        tmdbId: 233,
        tvdbId: 333,
        mediaType: MediaType.TV,
      })
    );
    await getRepository(MediaDestinationStatus).save(
      new MediaDestinationStatus({
        mediaId: media.id,
        serverId: 28,
        status: MediaStatus.PROCESSING,
      })
    );
    const request = await createRequest({
      media,
      serverId: 28,
      seasons: [1],
    });
    sendNotificationMock.mock.mockImplementation(async () => {
      throw new Error('notification delivery failed');
    });
    t.after(() => {
      sendNotificationMock.mock.mockImplementation(async () => undefined);
    });

    await markMissingTvDestination(media.id, 28);

    assert.strictEqual(
      (await getRepository(MediaRequest).findOneByOrFail({ id: request.id }))
        .status,
      MediaRequestStatus.DECLINED
    );
    assert.strictEqual(
      (
        await getRepository(MediaDestinationStatus).findOneOrFail({
          where: { mediaId: media.id, serverId: 28 },
        })
      ).status,
      MediaStatus.UNKNOWN
    );
  });

  it('notifies once when movie orphan decline wins its CAS', async () => {
    const media = await getRepository(Media).save(
      new Media({ tmdbId: 234, mediaType: MediaType.MOVIE })
    );
    await getRepository(MediaDestinationStatus).save(
      new MediaDestinationStatus({
        mediaId: media.id,
        serverId: 29,
        status: MediaStatus.PROCESSING,
      })
    );
    const request = await createRequest({ media, serverId: 29 });
    const initialNotifications = sendNotificationMock.mock.callCount();

    await markMissingMovieDestination(media.id, 29);

    assert.strictEqual(
      (await getRepository(MediaRequest).findOneByOrFail({ id: request.id }))
        .status,
      MediaRequestStatus.DECLINED
    );
    assert.strictEqual(
      sendNotificationMock.mock.callCount(),
      initialNotifications + 1
    );
    assert.strictEqual(
      sendNotificationMock.mock.calls.at(-1)?.arguments[2],
      Notification.MEDIA_DECLINED
    );
  });
});
