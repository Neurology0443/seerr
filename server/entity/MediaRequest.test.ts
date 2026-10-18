import assert from 'node:assert/strict';
import { beforeEach, describe, it, mock } from 'node:test';

import ExternalAPI from '@server/api/externalapi';
import { ANIME_KEYWORD_ID } from '@server/api/themoviedb/constants';
import Tvdb from '@server/api/tvdb';
import {
  MediaRequestStatus,
  MediaStatus,
  MediaType,
} from '@server/constants/media';
import { getRepository } from '@server/datasource';
import { Blocklist } from '@server/entity/Blocklist';
import Media from '@server/entity/Media';
import { MediaDestinationSeasonStatus } from '@server/entity/MediaDestinationSeasonStatus';
import { MediaDestinationStatus } from '@server/entity/MediaDestinationStatus';
import {
  BlocklistedMediaError,
  DuplicateMediaRequestError,
  MediaRequest,
  NoSeasonsAvailableError,
  QuotaRestrictedError,
  RequestPermissionError,
} from '@server/entity/MediaRequest';
import Season from '@server/entity/Season';
import SeasonRequest from '@server/entity/SeasonRequest';
import { User } from '@server/entity/User';
import { Notification } from '@server/lib/notifications';
import { Permission } from '@server/lib/permissions';
import { RequestTargetError } from '@server/lib/requestTarget';
import type { RadarrSettings, SonarrSettings } from '@server/lib/settings';
import { MetadataProviderType, getSettings } from '@server/lib/settings';
import { MediaRequestSubscriber } from '@server/subscriber/MediaRequestSubscriber';
import { setupTestDb } from '@server/test/db';
import type { TestContext } from 'node:test';

// get is a prototype method unlike getMovie, and replaces the cache lookup too
const externalApiGetMock = mock.method(
  ExternalAPI.prototype as unknown as {
    get: (endpoint: string) => Promise<unknown>;
  },
  'get',
  async (endpoint: string) => {
    const tmdbId = Number(endpoint.replace(/^\/(movie|tv)\//, ''));

    if (!tmdbId) {
      throw new Error(`Unstubbed external endpoint: ${endpoint}`);
    }

    return {
      id: tmdbId,
      external_ids: {},
      keywords: { results: [] },
      seasons: [1, 2, 3].map((season_number) => ({
        season_number,
        episode_count: 10,
      })),
      // Skips getMovie's localized fallback call
      videos: { results: [{ type: 'Trailer', key: 'trailer' }] },
    };
  }
).mock;

const sendNotificationMock = mock.method(
  MediaRequest,
  'sendNotification',
  async () => undefined
).mock;

setupTestDb();

beforeEach(() => {
  externalApiGetMock.resetCalls();
  sendNotificationMock.resetCalls();
  getSettings().metadataSettings = {
    tv: MetadataProviderType.TMDB,
    anime: MetadataProviderType.TMDB,
  };
  getSettings().main.enableSpecialEpisodes = false;
  getSettings().radarr = [
    {
      id: 10,
      isDefault: true,
      is4k: false,
      syncEnabled: true,
      independentRequestDestination: false,
    },
    {
      id: 11,
      isDefault: true,
      is4k: true,
      syncEnabled: true,
      independentRequestDestination: false,
    },
  ] as RadarrSettings[];
  getSettings().sonarr = [
    {
      id: 20,
      isDefault: true,
      is4k: false,
      syncEnabled: true,
      independentRequestDestination: false,
    },
    {
      id: 21,
      isDefault: true,
      is4k: true,
      syncEnabled: true,
      independentRequestDestination: false,
    },
  ] as SonarrSettings[];
});

function configureIndependentServers() {
  getSettings().radarr = [
    {
      id: 101,
      isDefault: true,
      is4k: false,
      syncEnabled: true,
      independentRequestDestination: true,
    },
    {
      id: 102,
      isDefault: false,
      is4k: false,
      syncEnabled: true,
      independentRequestDestination: true,
    },
    {
      id: 103,
      isDefault: false,
      is4k: true,
      syncEnabled: true,
      independentRequestDestination: true,
    },
  ] as RadarrSettings[];
  getSettings().sonarr = [
    {
      id: 201,
      isDefault: true,
      is4k: false,
      syncEnabled: true,
      independentRequestDestination: true,
    },
    {
      id: 202,
      isDefault: false,
      is4k: false,
      syncEnabled: true,
      independentRequestDestination: true,
    },
  ] as SonarrSettings[];
}

function configureMixedServers() {
  getSettings().radarr = [
    {
      id: 100,
      isDefault: true,
      is4k: false,
      syncEnabled: true,
      independentRequestDestination: false,
    },
    {
      id: 101,
      isDefault: false,
      is4k: false,
      syncEnabled: true,
      independentRequestDestination: true,
    },
  ] as RadarrSettings[];
  getSettings().sonarr = [
    {
      id: 200,
      isDefault: true,
      is4k: false,
      syncEnabled: true,
      independentRequestDestination: false,
    },
    {
      id: 201,
      isDefault: false,
      is4k: false,
      syncEnabled: true,
      independentRequestDestination: true,
    },
  ] as SonarrSettings[];
}

async function seedRequester(movieQuotaLimit: number): Promise<User> {
  const userRepository = getRepository(User);

  const requester = await userRepository.findOneOrFail({
    where: { email: 'demo@seerr.dev' },
  });
  requester.movieQuotaLimit = movieQuotaLimit;

  return userRepository.save(requester);
}

async function createRequester(
  email: string,
  permissions = Permission.REQUEST
): Promise<User> {
  return getRepository(User).save(new User({ email, permissions, avatar: '' }));
}

function requestMovies(mediaIds: number[], requester: User) {
  return Promise.allSettled(
    mediaIds.map((mediaId) =>
      MediaRequest.request(
        { mediaId, mediaType: MediaType.MOVIE, is4k: false },
        requester
      )
    )
  );
}

function rejections(results: PromiseSettledResult<MediaRequest>[]) {
  return results.filter(
    (result): result is PromiseRejectedResult => result.status === 'rejected'
  );
}

describe('MediaRequest.request', () => {
  it('DT-001 permits an auto-request after its independent target is DELETED', async () => {
    configureIndependentServers();
    const requester = await seedRequester(5);
    const media = await getRepository(Media).save(
      new Media({
        tmdbId: 98801,
        mediaType: MediaType.MOVIE,
        status: MediaStatus.UNKNOWN,
        status4k: MediaStatus.UNKNOWN,
      })
    );
    const previous = await getRepository(MediaRequest).save(
      new MediaRequest({
        media,
        type: MediaType.MOVIE,
        requestedBy: requester,
        serverId: 101,
        is4k: false,
        isAutoRequest: true,
        status: MediaRequestStatus.COMPLETED,
      })
    );
    await getRepository(MediaDestinationStatus).save(
      new MediaDestinationStatus({
        mediaId: media.id,
        serverId: 101,
        status: MediaStatus.DELETED,
      })
    );
    const created = await MediaRequest.request(
      {
        mediaId: media.tmdbId,
        mediaType: MediaType.MOVIE,
      },
      requester,
      { isAutoRequest: true }
    );
    assert.equal(created.serverId, 101);
    assert.notEqual(created.id, previous.id);
  });
  it('rejects the second of two concurrent requests at the movie quota', async () => {
    const requestRepository = getRepository(MediaRequest);
    const requester = await seedRequester(1);

    const results = await requestMovies([11111, 22222], requester);
    const rejected = rejections(results);

    assert.strictEqual(rejected.length, 1);
    assert.ok(rejected[0].reason instanceof QuotaRestrictedError);
    assert.strictEqual(await requestRepository.count(), 1);
    assert.strictEqual(externalApiGetMock.callCount(), 1);
  });

  it('rejects a concurrent duplicate request for the same movie', async () => {
    const requestRepository = getRepository(MediaRequest);
    const requester = await seedRequester(5);

    const results = await requestMovies([33333, 33333], requester);
    const rejected = rejections(results);

    assert.strictEqual(rejected.length, 1);
    assert.ok(rejected[0].reason instanceof DuplicateMediaRequestError);
    assert.strictEqual(await requestRepository.count(), 1);
    assert.strictEqual(externalApiGetMock.callCount(), 2);
  });

  it('rejects a duplicate request that omits is4k', async () => {
    const requestRepository = getRepository(MediaRequest);
    const requester = await seedRequester(5);
    const body = { mediaId: 66666, mediaType: MediaType.MOVIE };

    await MediaRequest.request(body, requester);

    await assert.rejects(
      () => MediaRequest.request(body, requester),
      DuplicateMediaRequestError
    );
    assert.strictEqual(await requestRepository.count(), 1);
  });

  it('rejects a concurrent duplicate request from a different user', async () => {
    const requestRepository = getRepository(MediaRequest);
    const requester = await seedRequester(5);
    const otherRequester = await createRequester('second@seerr.dev');

    const results = await Promise.allSettled(
      [requester, otherRequester].map((user) =>
        MediaRequest.request(
          { mediaId: 44444, mediaType: MediaType.MOVIE, is4k: false },
          user
        )
      )
    );
    const rejected = rejections(results);

    assert.strictEqual(rejected.length, 1);
    assert.ok(rejected[0].reason instanceof DuplicateMediaRequestError);
    assert.strictEqual(await requestRepository.count(), 1);
  });

  it('gives an overlapping season to only one of two concurrent users', async () => {
    const seasonRequestRepository = getRepository(SeasonRequest);
    const requester = await seedRequester(5);
    const otherRequester = await createRequester('second@seerr.dev');

    const results = await Promise.allSettled(
      [
        [requester, [1, 2]],
        [otherRequester, [2, 3]],
      ].map(([user, seasons]) =>
        MediaRequest.request(
          {
            mediaId: 55555,
            mediaType: MediaType.TV,
            seasons: seasons as number[],
            is4k: false,
          },
          user as User
        )
      )
    );

    assert.strictEqual(rejections(results).length, 0);
    assert.strictEqual(
      await seasonRequestRepository.count({ where: { seasonNumber: 2 } }),
      1
    );
    assert.strictEqual(await seasonRequestRepository.count(), 3);
  });

  it('creates one media row for concurrent 4k and non-4k requests', async () => {
    const mediaRepository = getRepository(Media);
    const requestRepository = getRepository(MediaRequest);
    const requester = await seedRequester(5);
    const otherRequester = await createRequester(
      'second@seerr.dev',
      Permission.REQUEST_4K
    );

    const results = await Promise.allSettled(
      [
        [requester, false],
        [otherRequester, true],
      ].map(([user, is4k]) =>
        MediaRequest.request(
          { mediaId: 88888, mediaType: MediaType.MOVIE, is4k: is4k as boolean },
          user as User
        )
      )
    );

    assert.strictEqual(rejections(results).length, 0);
    assert.strictEqual(await requestRepository.count(), 2);
    assert.strictEqual(
      await mediaRepository.count({
        where: { tmdbId: 88888, mediaType: MediaType.MOVIE },
      }),
      1
    );
  });

  it('allows only one concurrent movie request for the same independent destination', async () => {
    configureIndependentServers();
    const requester = await seedRequester(5);
    const results = await Promise.allSettled(
      [1, 2].map(() =>
        MediaRequest.request(
          {
            mediaId: 91001,
            mediaType: MediaType.MOVIE,
            serverId: 101,
          },
          requester
        )
      )
    );

    assert.strictEqual(rejections(results).length, 1);
    assert.ok(
      rejections(results)[0].reason instanceof DuplicateMediaRequestError
    );
  });

  it('allows the same movie on two independent destinations and creates one media row', async () => {
    configureIndependentServers();
    const requester = await seedRequester(5);
    const results = await Promise.allSettled(
      [101, 102].map((serverId) =>
        MediaRequest.request(
          { mediaId: 91002, mediaType: MediaType.MOVIE, serverId },
          requester
        )
      )
    );

    assert.strictEqual(rejections(results).length, 0);
    assert.strictEqual(await getRepository(MediaRequest).count(), 2);
    assert.strictEqual(
      await getRepository(Media).count({
        where: { tmdbId: 91002, mediaType: MediaType.MOVIE },
      }),
      1
    );
  });

  it('allows native and independent movie slots to coexist in either creation order', async () => {
    configureMixedServers();
    const requester = await seedRequester(5);

    const independentFirst = await MediaRequest.request(
      {
        mediaId: 91003,
        mediaType: MediaType.MOVIE,
        serverId: 101,
      },
      requester
    );
    const nativeSecond = await MediaRequest.request(
      {
        mediaId: 91003,
        mediaType: MediaType.MOVIE,
        serverId: 100,
      },
      requester
    );
    const nativeFirst = await MediaRequest.request(
      {
        mediaId: 91004,
        mediaType: MediaType.MOVIE,
        serverId: 100,
      },
      requester
    );
    const independentSecond = await MediaRequest.request(
      {
        mediaId: 91004,
        mediaType: MediaType.MOVIE,
        serverId: 101,
      },
      requester
    );

    assert.strictEqual(independentFirst.serverId, 101);
    assert.strictEqual(nativeSecond.serverId, 100);
    assert.strictEqual(nativeFirst.serverId, 100);
    assert.strictEqual(independentSecond.serverId, 101);
  });

  it('allows native and independent TV season slots to coexist', async () => {
    configureMixedServers();
    const requester = await seedRequester(5);

    const independent = await MediaRequest.request(
      {
        mediaId: 91005,
        mediaType: MediaType.TV,
        serverId: 201,
        seasons: [1],
      },
      requester
    );
    const native = await MediaRequest.request(
      {
        mediaId: 91005,
        mediaType: MediaType.TV,
        serverId: 200,
        seasons: [1],
      },
      requester
    );

    assert.deepStrictEqual(
      independent.seasons.map((season) => season.seasonNumber),
      [1]
    );
    assert.deepStrictEqual(
      native.seasons.map((season) => season.seasonNumber),
      [1]
    );
  });

  for (const historicalStatus of [
    MediaRequestStatus.FAILED,
    MediaRequestStatus.DECLINED,
    MediaRequestStatus.COMPLETED,
  ]) {
    it(`does not let historical status ${historicalStatus} occupy an independent movie slot`, async () => {
      configureIndependentServers();
      const requester = await seedRequester(5);
      const historical = await MediaRequest.request(
        {
          mediaId: 91100 + historicalStatus,
          mediaType: MediaType.MOVIE,
          serverId: 101,
        },
        requester
      );
      historical.status = historicalStatus;
      await getRepository(MediaRequest).save(historical);
      const destination = await getRepository(
        MediaDestinationStatus
      ).findOneOrFail({
        where: { mediaId: historical.media.id, serverId: 101 },
      });
      destination.status = MediaStatus.UNKNOWN;
      await getRepository(MediaDestinationStatus).save(destination);

      const replacement = await MediaRequest.request(
        {
          mediaId: 91100 + historicalStatus,
          mediaType: MediaType.MOVIE,
          serverId: 101,
        },
        requester
      );
      assert.strictEqual(replacement.serverId, 101);
    });
  }

  for (const blockedStatus of [MediaStatus.PROCESSING, MediaStatus.AVAILABLE]) {
    it(`blocks an independent movie when its destination is ${blockedStatus}`, async () => {
      configureIndependentServers();
      const requester = await seedRequester(5);
      const request = await MediaRequest.request(
        {
          mediaId: 91200 + blockedStatus,
          mediaType: MediaType.MOVIE,
          serverId: 101,
        },
        requester
      );
      request.status = MediaRequestStatus.FAILED;
      await getRepository(MediaRequest).save(request);
      const destination = await getRepository(
        MediaDestinationStatus
      ).findOneOrFail({
        where: { mediaId: request.media.id, serverId: 101 },
      });
      destination.status = blockedStatus;
      await getRepository(MediaDestinationStatus).save(destination);

      await assert.rejects(
        () =>
          MediaRequest.request(
            {
              mediaId: 91200 + blockedStatus,
              mediaType: MediaType.MOVIE,
              serverId: 101,
            },
            requester
          ),
        DuplicateMediaRequestError
      );
    });
  }

  it('isolates TV season slots and destination state by serverId', async () => {
    configureIndependentServers();
    const requester = await seedRequester(5);
    const first = await MediaRequest.request(
      {
        mediaId: 91301,
        mediaType: MediaType.TV,
        serverId: 201,
        seasons: [1],
      },
      requester
    );
    const second = await MediaRequest.request(
      {
        mediaId: 91301,
        mediaType: MediaType.TV,
        serverId: 202,
        seasons: [1],
      },
      requester
    );

    assert.deepStrictEqual(
      first.seasons.map((season) => season.seasonNumber),
      [1]
    );
    assert.deepStrictEqual(
      second.seasons.map((season) => season.seasonNumber),
      [1]
    );
    await assert.rejects(
      () =>
        MediaRequest.request(
          {
            mediaId: 91301,
            mediaType: MediaType.TV,
            serverId: 201,
            seasons: [1],
          },
          requester
        ),
      NoSeasonsAvailableError
    );
  });

  it('keeps native media and season statuses unchanged for independent requests', async () => {
    configureIndependentServers();
    const requester = await seedRequester(5);
    const request = await MediaRequest.request(
      {
        mediaId: 91401,
        mediaType: MediaType.TV,
        serverId: 201,
        seasons: [1],
      },
      requester
    );
    const media = await getRepository(Media).findOneOrFail({
      where: { id: request.media.id },
    });
    const destination = await getRepository(
      MediaDestinationStatus
    ).findOneOrFail({
      where: { mediaId: media.id, serverId: 201 },
    });
    const destinationSeason = await getRepository(
      MediaDestinationSeasonStatus
    ).findOneOrFail({
      where: { destinationStatusId: destination.id, seasonNumber: 1 },
    });

    assert.strictEqual(media.status, MediaStatus.UNKNOWN);
    assert.strictEqual(media.status4k, MediaStatus.UNKNOWN);
    assert.strictEqual(media.seasons.length, 0);
    assert.strictEqual(destination.status, MediaStatus.PENDING);
    assert.strictEqual(destinationSeason.status, MediaStatus.PENDING);
  });

  it('uses the independent server tier for permissions and persisted is4k', async () => {
    configureIndependentServers();
    const requester = await seedRequester(5);

    await assert.rejects(
      () =>
        MediaRequest.request(
          {
            mediaId: 91501,
            mediaType: MediaType.MOVIE,
            serverId: 103,
            is4k: false,
          },
          requester
        ),
      RequestPermissionError
    );

    const standard = await MediaRequest.request(
      {
        mediaId: 91502,
        mediaType: MediaType.MOVIE,
        serverId: 101,
        is4k: true,
      },
      requester
    );
    assert.strictEqual(standard.is4k, false);
  });

  it('uses the independent server tier for auto-approval in both directions', async (t) => {
    configureIndependentServers();
    t.mock.method(
      MediaRequestSubscriber.prototype,
      'sendToRadarr',
      async () => undefined
    );
    const fourKRequester = await createRequester(
      'auto-4k@seerr.dev',
      Permission.REQUEST_4K | Permission.AUTO_APPROVE_4K
    );
    const standardRequester = await createRequester(
      'auto-standard@seerr.dev',
      Permission.REQUEST | Permission.AUTO_APPROVE
    );

    const fourK = await MediaRequest.request(
      {
        mediaId: 91503,
        mediaType: MediaType.MOVIE,
        serverId: 103,
        is4k: false,
      },
      fourKRequester
    );
    const standard = await MediaRequest.request(
      {
        mediaId: 91504,
        mediaType: MediaType.MOVIE,
        serverId: 101,
        is4k: true,
      },
      standardRequester
    );

    assert.strictEqual(fourK.is4k, true);
    assert.strictEqual(fourK.status, MediaRequestStatus.APPROVED);
    assert.strictEqual(standard.is4k, false);
    assert.strictEqual(standard.status, MediaRequestStatus.APPROVED);
  });

  it('persists the resolved default serverId', async () => {
    configureIndependentServers();
    const requester = await seedRequester(5);
    const request = await MediaRequest.request(
      { mediaId: 91601, mediaType: MediaType.MOVIE },
      requester
    );
    getSettings().radarr[0].isDefault = false;
    getSettings().radarr[1].isDefault = true;

    const persisted = await getRepository(MediaRequest).findOneOrFail({
      where: { id: request.id },
    });
    assert.strictEqual(persisted.serverId, 101);
  });

  it('rejects creation when the resolved independent target is deleted before insert', async (t) => {
    configureIndependentServers();
    const requester = await seedRequester(5);
    const originalBeforeInsert = MediaRequestSubscriber.prototype.beforeInsert;
    let signalBeforeInsert!: () => void;
    const beforeInsertReached = new Promise<void>((resolve) => {
      signalBeforeInsert = resolve;
    });
    let resumeInsert!: () => void;
    const insertResume = new Promise<void>((resolve) => {
      resumeInsert = resolve;
    });
    t.mock.method(
      MediaRequestSubscriber.prototype,
      'beforeInsert',
      async function (
        this: MediaRequestSubscriber,
        ...args: Parameters<typeof originalBeforeInsert>
      ) {
        signalBeforeInsert();
        await insertResume;
        return originalBeforeInsert.apply(this, args);
      }
    );
    const sendToRadarr = t.mock.method(
      MediaRequestSubscriber.prototype,
      'sendToRadarr',
      async () => undefined
    );

    const creation = MediaRequest.request(
      {
        mediaId: 91801,
        mediaType: MediaType.MOVIE,
        serverId: 101,
      },
      requester
    );
    const rejection = assert.rejects(creation, RequestTargetError);
    await beforeInsertReached;
    getSettings().radarr = getSettings().radarr.filter(
      (server) => server.id !== 101
    );
    getSettings().radarr[0].isDefault = true;
    resumeInsert();
    await rejection;

    const media = await getRepository(Media).findOneOrFail({
      where: { tmdbId: 91801, mediaType: MediaType.MOVIE },
    });
    assert.strictEqual(await getRepository(MediaRequest).count(), 0);
    assert.strictEqual(
      await getRepository(MediaDestinationStatus).count({
        where: { mediaId: media.id },
      }),
      0
    );
    assert.strictEqual(media.status, MediaStatus.UNKNOWN);
    assert.strictEqual(media.status4k, MediaStatus.UNKNOWN);
    assert.strictEqual(sendToRadarr.mock.callCount(), 0);
    assert.strictEqual(sendNotificationMock.callCount(), 0);
  });

  for (const scenario of [
    {
      name: 'role',
      mediaId: 91802,
      mutate: (server: RadarrSettings) => {
        server.independentRequestDestination = false;
      },
    },
    {
      name: '4K tier',
      mediaId: 91803,
      mutate: (server: RadarrSettings) => {
        server.is4k = true;
      },
    },
  ]) {
    it(`rejects creation when the resolved independent target ${scenario.name} changes before insert`, async (t) => {
      configureIndependentServers();
      const requester = await seedRequester(5);
      const originalBeforeInsert =
        MediaRequestSubscriber.prototype.beforeInsert;
      let signalBeforeInsert!: () => void;
      const beforeInsertReached = new Promise<void>((resolve) => {
        signalBeforeInsert = resolve;
      });
      let resumeInsert!: () => void;
      const insertResume = new Promise<void>((resolve) => {
        resumeInsert = resolve;
      });
      t.mock.method(
        MediaRequestSubscriber.prototype,
        'beforeInsert',
        async function (
          this: MediaRequestSubscriber,
          ...args: Parameters<typeof originalBeforeInsert>
        ) {
          signalBeforeInsert();
          await insertResume;
          return originalBeforeInsert.apply(this, args);
        }
      );
      const sendToRadarr = t.mock.method(
        MediaRequestSubscriber.prototype,
        'sendToRadarr',
        async () => undefined
      );

      const creation = MediaRequest.request(
        {
          mediaId: scenario.mediaId,
          mediaType: MediaType.MOVIE,
          serverId: 101,
        },
        requester
      );
      const rejection = assert.rejects(creation, RequestTargetError);
      await beforeInsertReached;
      scenario.mutate(getSettings().radarr[0]);
      resumeInsert();
      await rejection;

      const media = await getRepository(Media).findOneOrFail({
        where: { tmdbId: scenario.mediaId, mediaType: MediaType.MOVIE },
      });
      assert.strictEqual(await getRepository(MediaRequest).count(), 0);
      assert.strictEqual(
        await getRepository(MediaDestinationStatus).count({
          where: { mediaId: media.id },
        }),
        0
      );
      assert.strictEqual(media.status, MediaStatus.UNKNOWN);
      assert.strictEqual(media.status4k, MediaStatus.UNKNOWN);
      assert.strictEqual(sendToRadarr.mock.callCount(), 0);
    });
  }

  it('keeps the originally resolved target when the default changes before insert', async (t) => {
    configureIndependentServers();
    const requester = await seedRequester(5);
    const originalBeforeInsert = MediaRequestSubscriber.prototype.beforeInsert;
    let signalBeforeInsert!: () => void;
    const beforeInsertReached = new Promise<void>((resolve) => {
      signalBeforeInsert = resolve;
    });
    let resumeInsert!: () => void;
    const insertResume = new Promise<void>((resolve) => {
      resumeInsert = resolve;
    });
    t.mock.method(
      MediaRequestSubscriber.prototype,
      'beforeInsert',
      async function (
        this: MediaRequestSubscriber,
        ...args: Parameters<typeof originalBeforeInsert>
      ) {
        signalBeforeInsert();
        await insertResume;
        return originalBeforeInsert.apply(this, args);
      }
    );

    const creation = MediaRequest.request(
      { mediaId: 91804, mediaType: MediaType.MOVIE },
      requester
    );
    await beforeInsertReached;
    getSettings().radarr[0].isDefault = false;
    getSettings().radarr[1].isDefault = true;
    resumeInsert();
    const created = await creation;

    assert.strictEqual(created.serverId, 101);
    assert.strictEqual(created.creationTarget, undefined);
    assert.strictEqual(
      await getRepository(MediaDestinationStatus).count({
        where: { mediaId: created.media.id, serverId: 101 },
      }),
      1
    );
    assert.strictEqual(
      await getRepository(MediaDestinationStatus).count({
        where: { mediaId: created.media.id, serverId: 102 },
      }),
      0
    );
  });

  it('keeps movie and TV quotas global across independent destinations', async () => {
    configureIndependentServers();
    const requester = await seedRequester(1);
    requester.tvQuotaLimit = 1;
    await getRepository(User).save(requester);

    await MediaRequest.request(
      {
        mediaId: 91611,
        mediaType: MediaType.MOVIE,
        serverId: 101,
      },
      requester
    );
    await assert.rejects(
      () =>
        MediaRequest.request(
          {
            mediaId: 91611,
            mediaType: MediaType.MOVIE,
            serverId: 102,
          },
          requester
        ),
      QuotaRestrictedError
    );

    await MediaRequest.request(
      {
        mediaId: 91612,
        mediaType: MediaType.TV,
        serverId: 201,
        seasons: [1],
      },
      requester
    );
    await assert.rejects(
      () =>
        MediaRequest.request(
          {
            mediaId: 91612,
            mediaType: MediaType.TV,
            serverId: 202,
            seasons: [1],
          },
          requester
        ),
      QuotaRestrictedError
    );
  });

  it('does not emit native availability for an approved independent request', async () => {
    configureIndependentServers();
    const media = await getRepository(Media).save(
      new Media({
        mediaType: MediaType.MOVIE,
        tmdbId: 91701,
        status: MediaStatus.AVAILABLE,
        status4k: MediaStatus.UNKNOWN,
      })
    );
    const request = new MediaRequest({
      id: 1,
      type: MediaType.MOVIE,
      status: MediaRequestStatus.APPROVED,
      media,
      requestedBy: await seedRequester(5),
      is4k: false,
      serverId: 101,
    });

    await request.notifyApprovedOrDeclined();

    assert.strictEqual(sendNotificationMock.callCount(), 1);
    assert.strictEqual(
      sendNotificationMock.calls[0].arguments[2],
      Notification.MEDIA_APPROVED
    );
  });
});

describe('PR8 real auto-request creation', () => {
  for (const independent of [false, true]) {
    it(`persists one Standard default target (independent=${independent})`, async () => {
      configureIndependentServers();
      getSettings().radarr[0].independentRequestDestination = independent;
      const requester = await seedRequester(5);
      const created = await MediaRequest.request(
        { mediaId: 98802, mediaType: MediaType.MOVIE, is4k: false },
        requester,
        { isAutoRequest: true }
      );
      assert.equal(created.serverId, 101);
      assert.equal(created.is4k, false);
      assert.equal(created.isAutoRequest, true);
      assert.equal(await getRepository(MediaRequest).count(), 1);
    });
  }

  it('blocks across defaults until the original destination is DELETED, then uses the new default', async () => {
    configureIndependentServers();
    const requester = await seedRequester(5);
    const previous = await MediaRequest.request(
      { mediaId: 98803, mediaType: MediaType.MOVIE },
      requester,
      { isAutoRequest: true }
    );
    await getRepository(MediaRequest).update(previous.id, {
      status: MediaRequestStatus.COMPLETED,
    });
    const destination = await getRepository(
      MediaDestinationStatus
    ).findOneByOrFail({ mediaId: previous.media.id, serverId: 101 });
    getSettings().radarr[0].isDefault = false;
    getSettings().radarr[1].isDefault = true;
    for (const status of [
      MediaStatus.AVAILABLE,
      MediaStatus.PROCESSING,
      MediaStatus.UNKNOWN,
    ]) {
      await getRepository(MediaDestinationStatus).update(destination.id, {
        status,
      });
      await assert.rejects(
        () =>
          MediaRequest.request(
            { mediaId: 98803, mediaType: MediaType.MOVIE },
            requester,
            { isAutoRequest: true }
          ),
        DuplicateMediaRequestError
      );
    }
    await getRepository(MediaDestinationStatus).update(destination.id, {
      status: MediaStatus.DELETED,
    });
    const created = await MediaRequest.request(
      { mediaId: 98803, mediaType: MediaType.MOVIE },
      requester,
      { isAutoRequest: true }
    );
    assert.equal(created.serverId, 102);
    assert.equal(
      (await getRepository(MediaRequest).findOneByOrFail({ id: previous.id }))
        .serverId,
      101
    );
    assert.equal(await getRepository(MediaRequest).count(), 2);
  });

  for (const mediaType of [MediaType.MOVIE, MediaType.TV]) {
    it(`rejects authoritative Blocklist membership for ${mediaType}`, async () => {
      configureIndependentServers();
      const requester = await seedRequester(5);
      await Blocklist.addToBlocklist({
        blocklistRequest: { tmdbId: 98804, mediaType },
      });
      await getRepository(Media).update(
        { tmdbId: 98804 },
        { status: MediaStatus.UNKNOWN, status4k: MediaStatus.UNKNOWN }
      );
      await assert.rejects(
        () =>
          MediaRequest.request(
            { mediaId: 98804, mediaType, seasons: 'all' },
            requester
          ),
        BlocklistedMediaError
      );
      assert.equal(await getRepository(MediaRequest).count(), 0);
    });
  }

  it('TV all filters only occupied and non-requestable seasons of the resolved target', async () => {
    configureIndependentServers();
    const requester = await seedRequester(5);
    const media = await getRepository(Media).save(
      new Media({
        tmdbId: 98805,
        mediaType: MediaType.TV,
        status: MediaStatus.AVAILABLE,
      })
    );
    const destinations = await getRepository(MediaDestinationStatus).save(
      [201, 202].map(
        (serverId) =>
          new MediaDestinationStatus({
            mediaId: media.id,
            serverId,
            status: MediaStatus.PARTIALLY_AVAILABLE,
          })
      )
    );
    await getRepository(MediaDestinationSeasonStatus).save([
      new MediaDestinationSeasonStatus({
        destinationStatusId: destinations[0].id,
        seasonNumber: 1,
        status: MediaStatus.AVAILABLE,
      }),
      new MediaDestinationSeasonStatus({
        destinationStatusId: destinations[1].id,
        seasonNumber: 3,
        status: MediaStatus.AVAILABLE,
      }),
    ]);
    await getRepository(MediaRequest).save(
      new MediaRequest({
        media,
        type: MediaType.TV,
        serverId: 201,
        requestedBy: requester,
        is4k: false,
        status: MediaRequestStatus.PENDING,
        seasons: [
          new SeasonRequest({
            seasonNumber: 2,
            status: MediaRequestStatus.PENDING,
          }),
        ],
      })
    );
    const created = await MediaRequest.request(
      { mediaId: media.tmdbId, mediaType: MediaType.TV, seasons: 'all' },
      requester,
      { isAutoRequest: true }
    );
    assert.equal(created.serverId, 201);
    assert.deepEqual(
      created.seasons.map((s) => s.seasonNumber),
      [3]
    );
    // A different user avoids the historical auto-request guard and exercises empty-season handling.
    const other = await createRequester('tv-other@seerr.dev');
    await assert.rejects(
      () =>
        MediaRequest.request(
          { mediaId: media.tmdbId, mediaType: MediaType.TV, seasons: 'all' },
          other,
          { isAutoRequest: true }
        ),
      NoSeasonsAvailableError
    );
    assert.equal(await getRepository(MediaRequest).count(), 2);
  });

  it('native TV all retains its existing season selection and quota checks', async () => {
    const requester = await seedRequester(5);
    const created = await MediaRequest.request(
      { mediaId: 98806, mediaType: MediaType.TV, seasons: 'all' },
      requester,
      { isAutoRequest: true }
    );
    assert.deepEqual(
      created.seasons.map((s) => s.seasonNumber),
      [1, 2, 3]
    );
    assert.equal(created.serverId, 20);
    assert.equal(created.is4k, false);
  });
});

describe('PR8 auto-request native rules', () => {
  for (const independent of [false, true]) {
    it(`enforces TV all quotas and preserves special-episode filtering (independent=${independent})`, async (t) => {
      configureIndependentServers();
      getSettings().sonarr[0].independentRequestDestination = independent;
      const requester = await seedRequester(5);
      requester.tvQuotaLimit = 2;
      await getRepository(User).save(requester);
      t.mock.method(
        ExternalAPI.prototype as unknown as {
          get: (endpoint: string) => Promise<unknown>;
        },
        'get',
        async () => ({
          id: 98807,
          external_ids: {},
          keywords: { results: [] },
          seasons: [0, 1, 2, 3].map((season_number) => ({
            season_number,
            episode_count: 10,
          })),
        })
      );
      const body = {
        mediaId: 98807,
        mediaType: MediaType.TV,
        seasons: 'all' as const,
      };
      await assert.rejects(
        () => MediaRequest.request(body, requester, { isAutoRequest: true }),
        QuotaRestrictedError
      );
      assert.equal(await getRepository(MediaRequest).count(), 0);
      requester.tvQuotaLimit = 5;
      await getRepository(User).save(requester);
      const oldSpecials = getSettings().main.enableSpecialEpisodes;
      t.after(() => {
        getSettings().main.enableSpecialEpisodes = oldSpecials;
      });
      getSettings().main.enableSpecialEpisodes = false;
      const created = await MediaRequest.request(body, requester, {
        isAutoRequest: true,
      });
      assert.deepEqual(
        created.seasons.map((s) => s.seasonNumber),
        [1, 2, 3]
      );
    });
  }
});

function configureAllSeasonMetadata(
  t: TestContext,
  {
    tv = MetadataProviderType.TVDB,
    anime = MetadataProviderType.TMDB,
    isAnime = false,
    specials = false,
    specialEpisodes = 1,
    fallback,
  }: {
    tv?: MetadataProviderType;
    anime?: MetadataProviderType;
    isAnime?: boolean;
    specials?: boolean;
    specialEpisodes?: number;
    fallback?: 'initialization' | 'metadata';
  } = {}
) {
  getSettings().metadataSettings = { tv, anime };
  getSettings().main.enableSpecialEpisodes = specials;
  t.mock.method(
    ExternalAPI.prototype as unknown as {
      get: (endpoint: string) => Promise<unknown>;
    },
    'get',
    async (endpoint: string) => ({
      id: Number(endpoint.replace('/tv/', '')),
      external_ids: { tvdb_id: 1234 },
      keywords: { results: isAnime ? [{ id: ANIME_KEYWORD_ID }] : [] },
      videos: { results: [{ type: 'Trailer', key: 'trailer' }] },
      seasons: [-1, 0, 1, 1.5, 2, 4].map((season_number) => ({
        season_number,
        episode_count:
          season_number === 4 ? 0 : season_number === 0 ? specialEpisodes : 10,
      })),
    })
  );
  const tvdb = new Tvdb();
  t.mock.method(tvdb, 'login', async () => ({ token: 'test-token' }));
  Object.defineProperty(tvdb, 'get', {
    value: async () => {
      if (fallback === 'metadata')
        throw new Error('TheTVDB metadata unavailable');
      return {
        data: {
          id: 1234,
          seasons: [0, 1, 2, 3, 4].map((number) => ({
            number,
            type: { type: 'official' },
          })),
          episodes: [...(specialEpisodes ? [0] : []), 1, 2, 3].map(
            (seasonNumber) => ({ seasonNumber })
          ),
        },
      };
    },
  });
  return t.mock.method(Tvdb, 'getInstance', async () => {
    if (fallback === 'initialization')
      throw new Error('TheTVDB initialization unavailable');
    return tvdb;
  });
}

async function persistedSeasonNumbers(created: MediaRequest) {
  const persisted = await getRepository(MediaRequest).findOneByOrFail({
    id: created.id,
  });
  return persisted.seasons
    .map((season) => season.seasonNumber)
    .sort((a, b) => a - b);
}

describe('PR8 corrected TV all inventory', () => {
  for (const independent of [false, true]) {
    it(`persists TheTVDB-only seasons (independent=${independent})`, async (t) => {
      configureAllSeasonMetadata(t);
      if (independent) configureIndependentServers();
      const requester = await seedRequester(5);
      const created = await MediaRequest.request(
        { mediaId: 99001, mediaType: MediaType.TV, seasons: 'all' },
        requester,
        { isAutoRequest: true }
      );
      assert.deepEqual(await persistedSeasonNumbers(created), [1, 2, 3]);
      assert.equal(created.serverId, independent ? 201 : 20);
    });
  }

  it('filters the configured provider inventory on FR while leaving EN independently requestable', async (t) => {
    configureAllSeasonMetadata(t);
    configureIndependentServers();
    const requester = await seedRequester(5);
    const media = await getRepository(Media).save(
      new Media({
        tmdbId: 99002,
        mediaType: MediaType.TV,
        status: MediaStatus.AVAILABLE,
      })
    );
    const fr = await getRepository(MediaDestinationStatus).save(
      new MediaDestinationStatus({
        mediaId: media.id,
        serverId: 201,
        status: MediaStatus.PARTIALLY_AVAILABLE,
      })
    );
    await getRepository(MediaDestinationSeasonStatus).save(
      [1, 2].map(
        (seasonNumber) =>
          new MediaDestinationSeasonStatus({
            destinationStatusId: fr.id,
            seasonNumber,
            status: MediaStatus.AVAILABLE,
          })
      )
    );
    const body = {
      mediaId: media.tmdbId,
      mediaType: MediaType.TV,
      seasons: 'all' as const,
    };
    const frRequest = await MediaRequest.request(body, requester, {
      isAutoRequest: true,
    });
    assert.deepEqual(await persistedSeasonNumbers(frRequest), [3]);
    // Explicitly requesting another destination remains independent of FR auto-history.
    const enRequest = await MediaRequest.request(
      { ...body, serverId: 202 },
      requester
    );
    assert.deepEqual(await persistedSeasonNumbers(enRequest), [1, 2, 3]);
    assert.equal(
      (await getRepository(Media).findOneByOrFail({ id: media.id })).status,
      MediaStatus.AVAILABLE
    );
    assert.deepEqual(
      (
        await getRepository(MediaDestinationSeasonStatus).findBy({
          destinationStatusId: fr.id,
        })
      )
        .filter((s) => s.seasonNumber < 3)
        .map((s) => s.status),
      [MediaStatus.AVAILABLE, MediaStatus.AVAILABLE]
    );
    const other = await createRequester('all-inventory-other@seerr.dev');
    await assert.rejects(
      () => MediaRequest.request(body, other),
      NoSeasonsAvailableError
    );
    assert.equal(await getRepository(MediaRequest).count(), 2);
  });

  it('uses TMDB when configured and does not resolve another provider for explicit seasons', async (t) => {
    const tvdb = configureAllSeasonMetadata(t, {
      tv: MetadataProviderType.TMDB,
    });
    const requester = await seedRequester(5);
    const created = await MediaRequest.request(
      { mediaId: 99003, mediaType: MediaType.TV, seasons: 'all' },
      requester
    );
    assert.deepEqual(await persistedSeasonNumbers(created), [1, 2]);
    assert.equal(tvdb.mock.callCount(), 0);
    getSettings().metadataSettings.tv = MetadataProviderType.TVDB;
    const explicit = await MediaRequest.request(
      { mediaId: 99003, mediaType: MediaType.TV, seasons: [7] },
      requester
    );
    assert.deepEqual(await persistedSeasonNumbers(explicit), [7]);
    assert.equal(tvdb.mock.callCount(), 0);
  });

  for (const animeProvider of [
    MetadataProviderType.TMDB,
    MetadataProviderType.TVDB,
  ]) {
    it(`respects the separate anime provider (${animeProvider})`, async (t) => {
      const tvdb = configureAllSeasonMetadata(t, {
        tv:
          animeProvider === MetadataProviderType.TMDB
            ? MetadataProviderType.TVDB
            : MetadataProviderType.TMDB,
        anime: animeProvider,
        isAnime: true,
      });
      const requester = await seedRequester(5);
      const created = await MediaRequest.request(
        { mediaId: 99005, mediaType: MediaType.TV, seasons: 'all' },
        requester
      );
      assert.deepEqual(
        await persistedSeasonNumbers(created),
        animeProvider === MetadataProviderType.TVDB ? [1, 2, 3] : [1, 2]
      );
      assert.equal(
        tvdb.mock.callCount(),
        animeProvider === MetadataProviderType.TVDB ? 1 : 0
      );
    });
  }

  for (const fallback of ['initialization', 'metadata'] as const) {
    it(`retains TMDB fallback on TheTVDB ${fallback} failure`, async (t) => {
      configureAllSeasonMetadata(t, { fallback });
      const requester = await seedRequester(5);
      const created = await MediaRequest.request(
        { mediaId: 99006, mediaType: MediaType.TV, seasons: 'all' },
        requester
      );
      assert.deepEqual(await persistedSeasonNumbers(created), [1, 2]);
    });
  }

  for (const independent of [false, true]) {
    for (const provider of [
      MetadataProviderType.TMDB,
      MetadataProviderType.TVDB,
    ]) {
      for (const specials of [false, true]) {
        it(`persists eligible specials only when enabled (independent=${independent}, provider=${provider}, enabled=${specials})`, async (t) => {
          configureAllSeasonMetadata(t, { tv: provider, specials });
          if (independent) configureIndependentServers();
          const requester = await seedRequester(5);
          const created = await MediaRequest.request(
            { mediaId: 99007, mediaType: MediaType.TV, seasons: 'all' },
            requester,
            { isAutoRequest: true }
          );
          const regular =
            provider === MetadataProviderType.TVDB ? [1, 2, 3] : [1, 2];
          assert.deepEqual(
            await persistedSeasonNumbers(created),
            specials ? [0, ...regular] : regular
          );
        });
      }
    }
  }

  for (const specialState of ['empty', 'available', 'active'] as const) {
    for (const independent of [false, true]) {
      it(`excludes ${specialState} specials on the resolved target (independent=${independent})`, async (t) => {
        configureAllSeasonMetadata(t, {
          specials: true,
          specialEpisodes: specialState === 'empty' ? 0 : 1,
        });
        if (independent) configureIndependentServers();
        const requester = await seedRequester(5);
        const media = await getRepository(Media).save(
          new Media({
            tmdbId: 99008,
            mediaType: MediaType.TV,
            status: MediaStatus.UNKNOWN,
          })
        );
        const serverId = independent ? 201 : 20;
        if (specialState === 'available') {
          if (independent) {
            const destination = await getRepository(
              MediaDestinationStatus
            ).save(
              new MediaDestinationStatus({
                mediaId: media.id,
                serverId,
                status: MediaStatus.PARTIALLY_AVAILABLE,
              })
            );
            await getRepository(MediaDestinationSeasonStatus).save(
              new MediaDestinationSeasonStatus({
                destinationStatusId: destination.id,
                seasonNumber: 0,
                status: MediaStatus.AVAILABLE,
              })
            );
          } else {
            await getRepository(Season).save(
              new Season({
                media: Promise.resolve(media),
                seasonNumber: 0,
                status: MediaStatus.AVAILABLE,
              })
            );
          }
        } else if (specialState === 'active') {
          await getRepository(MediaRequest).save(
            new MediaRequest({
              media,
              type: MediaType.TV,
              serverId,
              is4k: false,
              requestedBy: requester,
              status: MediaRequestStatus.PENDING,
              seasons: [
                new SeasonRequest({
                  seasonNumber: 0,
                  status: MediaRequestStatus.PENDING,
                }),
              ],
            })
          );
        }
        const created = await MediaRequest.request(
          { mediaId: media.tmdbId, mediaType: MediaType.TV, seasons: 'all' },
          requester,
          { isAutoRequest: true }
        );
        assert.deepEqual(await persistedSeasonNumbers(created), [1, 2, 3]);
      });
    }
  }
});
