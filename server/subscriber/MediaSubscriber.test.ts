import assert from 'node:assert/strict';
import { beforeEach, describe, it, mock } from 'node:test';

import TheMovieDb from '@server/api/themoviedb';
import {
  MediaRequestStatus,
  MediaStatus,
  MediaType,
} from '@server/constants/media';
import { getRepository } from '@server/datasource';
import Media from '@server/entity/Media';
import { MediaDestinationStatus } from '@server/entity/MediaDestinationStatus';
import { MediaRequest } from '@server/entity/MediaRequest';
import Season from '@server/entity/Season';
import SeasonRequest from '@server/entity/SeasonRequest';
import { User } from '@server/entity/User';
import notificationManager, { Notification } from '@server/lib/notifications';
import type { RadarrSettings, SonarrSettings } from '@server/lib/settings';
import { getSettings } from '@server/lib/settings';
import { MediaRequestSubscriber } from '@server/subscriber/MediaRequestSubscriber';
import { setupTestDb } from '@server/test/db';

mock.method(MediaRequest, 'sendNotification', async () => undefined);
const sendNotificationMock = mock.method(
  notificationManager,
  'sendNotification',
  () => undefined
);
mock.method(
  MediaRequestSubscriber.prototype,
  'sendToRadarr',
  async () => undefined
);

Object.defineProperty(TheMovieDb.prototype, 'getMovie', {
  get() {
    return async ({ movieId }: { movieId: number }) => ({
      id: movieId,
      title: `Movie ${movieId}`,
      release_date: '2025-01-01',
      overview: '',
      poster_path: null,
      external_ids: {},
      keywords: { keywords: [] },
      genres: [],
    });
  },
  set() {},
  configurable: true,
});
mock.method(
  MediaRequestSubscriber.prototype,
  'sendToSonarr',
  async () => undefined
);

setupTestDb();

beforeEach(() => {
  getSettings().radarr = [
    {
      id: 101,
      is4k: false,
      isDefault: true,
      syncEnabled: true,
      independentRequestDestination: true,
    },
  ] as RadarrSettings[];
  getSettings().sonarr = [
    {
      id: 201,
      is4k: false,
      isDefault: true,
      syncEnabled: true,
      independentRequestDestination: true,
    },
  ] as SonarrSettings[];
});

async function requester() {
  return getRepository(User).findOneOrFail({
    where: { email: 'demo@seerr.dev' },
  });
}

describe('MediaSubscriber request isolation', () => {
  it('still completes a native movie request when native media becomes available', async () => {
    const mediaRepository = getRepository(Media);
    const requestRepository = getRepository(MediaRequest);
    const media = await mediaRepository.save(
      new Media({
        mediaType: MediaType.MOVIE,
        tmdbId: 95001,
        status: MediaStatus.PENDING,
        status4k: MediaStatus.UNKNOWN,
      })
    );
    const request = await requestRepository.save(
      new MediaRequest({
        type: MediaType.MOVIE,
        status: MediaRequestStatus.PENDING,
        media,
        requestedBy: await requester(),
        is4k: false,
      })
    );

    const initialNotifications = sendNotificationMock.mock.callCount();
    media.status = MediaStatus.AVAILABLE;
    await mediaRepository.save(media);

    const persisted = await requestRepository.findOneOrFail({
      where: { id: request.id },
    });
    assert.strictEqual(persisted.status, MediaRequestStatus.COMPLETED);
    assert.equal(
      sendNotificationMock.mock.callCount(),
      initialNotifications + 1
    );
    assert.equal(
      sendNotificationMock.mock.calls.at(-1)?.arguments[1]?.request?.id,
      request.id
    );
    assert.equal(
      sendNotificationMock.mock.calls.at(-1)?.arguments[0],
      Notification.MEDIA_AVAILABLE
    );
  });

  it('does not approve or complete independent movie requests from native state', async () => {
    const mediaRepository = getRepository(Media);
    const requestRepository = getRepository(MediaRequest);
    const media = await mediaRepository.save(
      new Media({
        mediaType: MediaType.MOVIE,
        tmdbId: 95002,
        status: MediaStatus.PENDING,
        status4k: MediaStatus.UNKNOWN,
      })
    );
    const pending = await requestRepository.save(
      new MediaRequest({
        type: MediaType.MOVIE,
        status: MediaRequestStatus.PENDING,
        media,
        requestedBy: await requester(),
        is4k: false,
        serverId: 101,
      })
    );
    const failed = await requestRepository.save(
      new MediaRequest({
        type: MediaType.MOVIE,
        status: MediaRequestStatus.FAILED,
        media,
        requestedBy: await requester(),
        is4k: false,
        serverId: 101,
      })
    );

    const initialNotifications = sendNotificationMock.mock.callCount();
    media.status = MediaStatus.AVAILABLE;
    await mediaRepository.save(media);

    const persistedPending = await requestRepository.findOneOrFail({
      where: { id: pending.id },
    });
    const persistedFailed = await requestRepository.findOneOrFail({
      where: { id: failed.id },
    });
    assert.strictEqual(persistedPending.status, MediaRequestStatus.PENDING);
    assert.strictEqual(persistedFailed.status, MediaRequestStatus.FAILED);
    assert.equal(sendNotificationMock.mock.callCount(), initialNotifications);
  });

  it('does not complete independent TV season requests from native season state', async () => {
    const mediaRepository = getRepository(Media);
    const requestRepository = getRepository(MediaRequest);
    const media = await mediaRepository.save(
      new Media({
        mediaType: MediaType.TV,
        tmdbId: 95003,
        status: MediaStatus.PROCESSING,
        status4k: MediaStatus.UNKNOWN,
        seasons: [
          new Season({
            seasonNumber: 1,
            status: MediaStatus.PROCESSING,
            status4k: MediaStatus.UNKNOWN,
          }),
        ],
      })
    );
    const request = await requestRepository.save(
      new MediaRequest({
        type: MediaType.TV,
        status: MediaRequestStatus.APPROVED,
        media,
        requestedBy: await requester(),
        is4k: false,
        serverId: 201,
        seasons: [
          new SeasonRequest({
            seasonNumber: 1,
            status: MediaRequestStatus.APPROVED,
          }),
        ],
      })
    );

    const initialNotifications = sendNotificationMock.mock.callCount();
    media.seasons[0].status = MediaStatus.AVAILABLE;
    media.status = MediaStatus.AVAILABLE;
    await mediaRepository.save(media);

    const persisted = await requestRepository.findOneOrFail({
      where: { id: request.id },
    });
    assert.strictEqual(persisted.status, MediaRequestStatus.APPROVED);
    assert.equal(sendNotificationMock.mock.callCount(), initialNotifications);
    assert.strictEqual(
      persisted.seasons[0].status,
      MediaRequestStatus.APPROVED
    );
    assert.strictEqual(
      await getRepository(MediaDestinationStatus).count({
        where: { mediaId: media.id, serverId: 201 },
      }),
      1
    );
  });
});
