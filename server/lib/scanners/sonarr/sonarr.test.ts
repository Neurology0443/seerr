import type { SonarrSeries } from '@server/api/servarr/sonarr';
import SonarrAPI from '@server/api/servarr/sonarr';
import TheMovieDb from '@server/api/themoviedb';
import type {
  TmdbTvDetails,
  TmdbTvSeasonResult,
} from '@server/api/themoviedb/interfaces';
import {
  MediaRequestStatus,
  MediaStatus,
  MediaType,
} from '@server/constants/media';
import { getRepository } from '@server/datasource';
import Media from '@server/entity/Media';
import { MediaDestinationSeasonStatus } from '@server/entity/MediaDestinationSeasonStatus';
import { MediaDestinationStatus } from '@server/entity/MediaDestinationStatus';
import MediaRequest from '@server/entity/MediaRequest';
import Season from '@server/entity/Season';
import SeasonRequest from '@server/entity/SeasonRequest';
import { User } from '@server/entity/User';
import * as destinationAvailability from '@server/lib/destinationAvailability';
import { persistConfirmedDestinationRemoval } from '@server/lib/destinationRemoval';
import { Notification } from '@server/lib/notifications';
import { sonarrScanner } from '@server/lib/scanners/sonarr';
import type { SonarrSettings } from '@server/lib/settings';
import { getSettings } from '@server/lib/settings';
import mediaRoutes from '@server/routes/media';
import settingsRoutes from '@server/routes/settings/sonarr';
import { setupTestDb } from '@server/test/db';
import {
  removalSnapshot,
  seedRemoval,
} from '@server/test/fixtures/destinationRemoval';
import { runWithMockTimers } from '@server/test/runWithMockTimers';
import { withDestinationOperationLock } from '@server/utils/destinationOperationLock';
import * as dvrIdentityLocks from '@server/utils/dvrIdentityLock';
import axios, { type AxiosInstance } from 'axios';
import express from 'express';
import assert from 'node:assert/strict';
import { beforeEach, describe, it, mock } from 'node:test';
import request from 'supertest';

let getSeriesImpl: () => Promise<SonarrSeries[]> = async () => [];
Object.defineProperty(SonarrAPI.prototype, 'getSeries', {
  set() {},
  get() {
    return async () => getSeriesImpl();
  },
  configurable: true,
});

let getLibrarySeriesByTvdbIdImpl: (
  tvdbId: number
) => Promise<SonarrSeries[]> = async () => [];
Object.defineProperty(SonarrAPI.prototype, 'getLibrarySeriesByTvdbId', {
  set() {},
  get() {
    return async (tvdbId: number) => getLibrarySeriesByTvdbIdImpl(tvdbId);
  },
  configurable: true,
});

function fakeTmdbShow(
  tmdbId: number,
  seasons: TmdbTvSeasonResult[] = [
    {
      id: 1,
      air_date: '2024-01-01',
      episode_count: 10,
      name: 'Season 1',
      overview: '',
      season_number: 1,
    },
  ]
): TmdbTvDetails {
  return {
    id: tmdbId,
    content_ratings: { results: [] },
    created_by: [],
    episode_run_time: [],
    first_air_date: '2024-01-01',
    genres: [],
    homepage: '',
    in_production: false,
    languages: ['en'],
    last_air_date: '2024-01-01',
    name: 'Test Show',
    networks: [],
    number_of_episodes: 10,
    number_of_seasons: 1,
    origin_country: ['US'],
    original_language: 'en',
    original_name: 'Test Show',
    overview: '',
    popularity: 0,
    production_companies: [],
    production_countries: [],
    spoken_languages: [],
    seasons,
    status: 'Ended',
    type: 'Scripted',
    vote_average: 0,
    vote_count: 0,
    aggregate_credits: { cast: [] },
    credits: { crew: [] },
    external_ids: {},
    keywords: { results: [] },
    videos: { results: [] },
  };
}

let getShowByTvdbIdImpl: (args: {
  tvdbId: number;
  language?: string;
}) => Promise<TmdbTvDetails> = async () => fakeTmdbShow(1);

TheMovieDb.prototype.getShowByTvdbId = async function (args) {
  return getShowByTvdbIdImpl(args);
};

TheMovieDb.prototype.getShowByTvdbIdForScan = async function (args) {
  return getShowByTvdbIdImpl(args);
};

let getTvShowImpl: (args: {
  tvId: number;
  language?: string;
}) => Promise<TmdbTvDetails> = async () => fakeTmdbShow(1);

Object.defineProperty(TheMovieDb.prototype, 'getTvShow', {
  set() {},
  get() {
    return async (args: { tvId: number; language?: string }) =>
      getTvShowImpl(args);
  },
  configurable: true,
});

Object.defineProperty(TheMovieDb.prototype, 'getTvShowForScan', {
  set() {},
  get() {
    return async (args: { tvId: number; language?: string }) =>
      getTvShowImpl(args);
  },
  configurable: true,
});

// both are assigned in the constructor, so the prototype stubs miss the instance
// sonarrScanner built when it was first imported
for (const method of ['getTvShow', 'getTvShowForScan'] as const) {
  Object.defineProperty(sonarrScanner.tmdb, method, {
    value: async (args: { tvId: number; language?: string }) =>
      getTvShowImpl(args),
    configurable: true,
  });
}

const sendNotificationMock = mock.method(
  MediaRequest,
  'sendNotification',
  async () => undefined
);

const availableNotifications = () =>
  sendNotificationMock.mock.calls.filter(
    (call) => call.arguments[2] === Notification.MEDIA_AVAILABLE
  );

setupTestDb();

function fakeSonarrSeries(overrides: Partial<SonarrSeries> = {}): SonarrSeries {
  return {
    tvdbId: 100,
    id: 1,
    title: 'Test Show',
    titleSlug: 'test-show',
    monitored: true,
    seasons: [
      {
        seasonNumber: 1,
        monitored: true,
        statistics: {
          episodeFileCount: 10,
          totalEpisodeCount: 10,
          episodeCount: 10,
          percentOfEpisodes: 100,
          sizeOnDisk: 0,
          previousAiring: undefined,
        },
      },
    ],
    ...overrides,
  } as SonarrSeries;
}

function configureSonarr(overrides: Partial<SonarrSettings>[] = [{}]): void {
  const settings = getSettings();
  settings.sonarr = overrides.map((o, i) => ({
    id: i,
    name: `Sonarr ${i}`,
    hostname: 'localhost',
    port: 8989,
    apiKey: 'test-key',
    baseUrl: '',
    useSsl: false,
    activeProfileId: 1,
    activeDirectory: '/tv',
    activeLanguageProfileId: 1,
    activeAnimeProfileId: undefined,
    activeAnimeDirectory: '',
    activeAnimeLanguageProfileId: undefined,
    animeTags: [],
    is4k: false,
    enableSeasonFolders: true,
    tags: [],
    isDefault: i === 0,
    syncEnabled: true,
    preventSearch: false,
    externalUrl: '',
    ...o,
  })) as SonarrSettings[];
  settings.radarr = [];
}

describe('Sonarr Scanner', () => {
  it('clears previous endpoint availability before an empty scan and rebuilds it only from fresh observations', async (t) => {
    const { media, destinations } = await seedRemoval(MediaType.TV);
    const settings = getSettings();
    const connectionA = { ...settings.sonarr[1] };
    settings.sonarr = [connectionA];
    t.mock.method(settings, 'save', async () => undefined);
    const before = await removalSnapshot();
    const notifications = sendNotificationMock.mock.callCount();
    const app = express();
    app.use(express.json());
    app.use('/settings', settingsRoutes);
    assert.equal(
      (
        await request(app)
          .put('/settings/2')
          .send({ ...connectionA, hostname: 'replacement' })
      ).status,
      200
    );
    const invalidated = await removalSnapshot();
    assert.deepEqual(invalidated.media, before.media);
    assert.deepEqual(invalidated.destinations[0], before.destinations[0]);
    assert.deepEqual(invalidated.requests, before.requests);
    assert.deepEqual(invalidated.seasonRequests, before.seasonRequests);
    assert.equal(invalidated.destinations[1].status, MediaStatus.UNKNOWN);
    assert.equal(invalidated.destinations[1].externalServiceId, null);
    assert.equal(invalidated.destinations[1].externalServiceSlug, null);
    assert.ok(
      invalidated.seasons
        .filter((row) => row.destinationStatusId === destinations[1].id)
        .every((row) => row.status === MediaStatus.UNKNOWN)
    );
    assert.deepEqual(
      invalidated.seasons.filter(
        (row) => row.destinationStatusId === destinations[0].id
      ),
      before.seasons.filter(
        (row) => row.destinationStatusId === destinations[0].id
      )
    );
    getSeriesImpl = async () => [];
    await runWithMockTimers(() => sonarrScanner.run());
    assert.deepEqual(await removalSnapshot(), invalidated);
    assert.equal(sendNotificationMock.mock.callCount(), notifications);
    getTvShowImpl = async () =>
      fakeTmdbShow(
        media.tmdbId,
        [1, 2].map((season_number) => ({
          id: season_number,
          season_number,
          episode_count: 10,
          name: `Season ${season_number}`,
          overview: '',
          air_date: '2024-01-01',
        }))
      );
    getSeriesImpl = async () => [
      fakeSonarrSeries({
        id: 42,
        tvdbId: media.tvdbId,
        titleSlug: 'replacement-media',
        seasons: [1, 2].map((seasonNumber) => ({
          seasonNumber,
          monitored: true,
          statistics: {
            episodeFileCount: 10,
            totalEpisodeCount: 10,
            episodeCount: 10,
            percentOfEpisodes: 100,
            sizeOnDisk: 0,
            previousAiring: undefined,
          },
        })),
      }),
    ];
    await runWithMockTimers(() => sonarrScanner.run());
    const fresh = await removalSnapshot();
    assert.deepEqual(fresh.media, before.media);
    assert.deepEqual(fresh.destinations[0], before.destinations[0]);
    assert.equal(fresh.destinations[1].status, MediaStatus.AVAILABLE);
    assert.equal(fresh.destinations[1].externalServiceId, 42);
    assert.equal(
      fresh.destinations[1].externalServiceSlug,
      'replacement-media'
    );
    assert.deepEqual(
      fresh.seasons.map((row) => [
        row.id,
        row.destinationStatusId,
        row.seasonNumber,
      ]),
      before.seasons.map((row) => [
        row.id,
        row.destinationStatusId,
        row.seasonNumber,
      ])
    );
    assert.ok(
      fresh.seasons
        .filter((row) => row.destinationStatusId === destinations[1].id)
        .every((row) => row.status === MediaStatus.AVAILABLE)
    );
    assert.equal(fresh.requests[2].status, MediaRequestStatus.COMPLETED);
  });

  for (const cleanup of [false, true]) {
    for (const restored of [false, true]) {
      it(
        `rejects superseded connection observations and allows a fresh scan (cleanup: ${cleanup}, restored: ${restored})`,
        { timeout: 10000 },
        async (t) => {
          const { media, destinations, requests } = await seedRemoval(
            MediaType.TV
          );
          const settings = getSettings();
          const connectionA = { ...settings.sonarr[1] };
          settings.sonarr = [connectionA];
          t.mock.method(settings, 'save', async () => undefined);
          await getRepository(MediaRequest).delete(requests[1].id);
          await getRepository(MediaDestinationStatus).update(
            destinations[1].id,
            {
              status: MediaStatus.PROCESSING,
            }
          );
          await getRepository(MediaDestinationSeasonStatus).update(
            { destinationStatusId: destinations[1].id },
            { status: MediaStatus.PROCESSING }
          );
          getShowByTvdbIdImpl = async ({ tvdbId }) =>
            fakeTmdbShow(tvdbId === 999 ? 999 : media.tmdbId);
          getTvShowImpl = async ({ tvId }) => fakeTmdbShow(tvId);
          const before = await removalSnapshot();
          const notifications = sendNotificationMock.mock.callCount();
          let captured!: () => void;
          let release!: () => void;
          const fetched = new Promise<void>((resolve) => {
            captured = resolve;
          });
          const resumed = new Promise<void>((resolve) => {
            release = resolve;
          });
          t.after(() => release());
          const inventory = cleanup
            ? [fakeSonarrSeries({ id: 999, tvdbId: 999 })]
            : [fakeSonarrSeries({ id: 42, tvdbId: media.tvdbId })];
          getSeriesImpl = async () => {
            captured();
            await resumed;
            return inventory;
          };
          const scanning = runWithMockTimers(() => sonarrScanner.run());
          await fetched;
          const app = express();
          app.use(express.json());
          app.use('/settings', settingsRoutes);
          assert.equal(
            (
              await request(app)
                .put('/settings/2')
                .send({
                  ...connectionA,
                  hostname: 'connection-b',
                  apiKey: 'key-b',
                })
            ).status,
            200
          );
          if (restored)
            assert.equal(
              (await request(app).put('/settings/2').send(connectionA)).status,
              200
            );
          const invalidated = await removalSnapshot();
          release();
          await scanning;
          assert.deepEqual(await removalSnapshot(), invalidated);
          assert.equal(invalidated.destinations[1].status, MediaStatus.UNKNOWN);
          assert.equal(invalidated.destinations[1].externalServiceId, null);
          assert.deepEqual(invalidated.requests, before.requests);
          assert.deepEqual(invalidated.seasonRequests, before.seasonRequests);
          assert.equal(sendNotificationMock.mock.callCount(), notifications);
          getSeriesImpl = async () => inventory;
          await runWithMockTimers(() => sonarrScanner.run());
          const after = await removalSnapshot();
          assert.deepEqual(
            after.media.find((row) => row.id === media.id),
            before.media.find((row) => row.id === media.id)
          );
          assert.deepEqual(after.destinations[0], before.destinations[0]);
          assert.equal(
            after.requests[0].status,
            cleanup ? MediaRequestStatus.APPROVED : MediaRequestStatus.COMPLETED
          );
          if (cleanup)
            assert.equal(after.destinations[1].status, MediaStatus.UNKNOWN);
          else assert.equal(after.destinations[1].externalServiceId, 42);
          assert.equal(
            sendNotificationMock.mock.callCount(),
            notifications + (cleanup ? 0 : 1)
          );
        }
      );
    }
  }

  it(
    'rejects orphan reconciliation when the connection changes during exact lookup',
    { timeout: 10000 },
    async (t) => {
      const { media, destinations, requests } = await seedRemoval(MediaType.TV);
      const settings = getSettings();
      const connectionA = { ...settings.sonarr[1] };
      settings.sonarr = [connectionA];
      t.mock.method(settings, 'save', async () => undefined);
      await getRepository(MediaDestinationStatus).update(destinations[1].id, {
        status: MediaStatus.PROCESSING,
      });
      getSeriesImpl = async () => [fakeSonarrSeries({ id: 999, tvdbId: 999 })];
      getShowByTvdbIdImpl = async () => fakeTmdbShow(999);
      getTvShowImpl = async ({ tvId }) => fakeTmdbShow(tvId);
      let lookedUp!: () => void;
      let release!: () => void;
      const entered = new Promise<void>((resolve) => {
        lookedUp = resolve;
      });
      const resumed = new Promise<void>((resolve) => {
        release = resolve;
      });
      t.after(() => release());
      getLibrarySeriesByTvdbIdImpl = async () => {
        lookedUp();
        await resumed;
        return [];
      };
      const notifications = sendNotificationMock.mock.callCount();
      const scanning = runWithMockTimers(() => sonarrScanner.run());
      await entered;
      const before = await removalSnapshot();
      const app = express();
      app.use(express.json());
      app.use('/settings', settingsRoutes);
      assert.equal(
        (
          await request(app)
            .put('/settings/2')
            .send({ ...connectionA, apiKey: 'connection-b' })
        ).status,
        200
      );
      release();
      await scanning;
      assert.deepEqual(await removalSnapshot(), before);
      assert.equal(sendNotificationMock.mock.callCount(), notifications);
      assert.equal(
        (
          await getRepository(MediaRequest).findOneByOrFail({
            id: requests[0].id,
          })
        ).status,
        MediaRequestStatus.APPROVED
      );
      assert.equal(
        (
          await getRepository(MediaDestinationStatus).findOneByOrFail({
            mediaId: media.id,
            serverId: 2,
          })
        ).externalServiceId,
        12
      );
    }
  );

  it(
    'keeps scanner freshness validation and persistence atomic with connection replacement',
    { timeout: 10000 },
    async (t) => {
      const { media } = await seedRemoval(MediaType.TV);
      const settings = getSettings();
      const connectionA = { ...settings.sonarr[1] };
      settings.sonarr = [connectionA];
      t.mock.method(settings, 'save', async () => undefined);
      getShowByTvdbIdImpl = async ({ tvdbId }) =>
        fakeTmdbShow(tvdbId === 999 ? 999 : media.tmdbId);
      getTvShowImpl = async ({ tvId }) => fakeTmdbShow(tvId);
      getSeriesImpl = async () => [
        fakeSonarrSeries({ id: 42, tvdbId: media.tvdbId }),
      ];
      let writing!: () => void;
      let release!: () => void;
      const entered = new Promise<void>((resolve) => {
        writing = resolve;
      });
      const resumed = new Promise<void>((resolve) => {
        release = resolve;
      });
      t.after(() => release());
      const originalUpdate =
        destinationAvailability.updateIndependentTvDestination;
      t.mock.method(
        destinationAvailability,
        'updateIndependentTvDestination',
        async (...args: Parameters<typeof originalUpdate>) => {
          writing();
          await resumed;
          assert.equal(settings.sonarr[0].hostname, connectionA.hostname);
          const result = await originalUpdate(...args);
          assert.equal(result.destination.externalServiceId, 42);
          return result;
        }
      );
      const scanning = runWithMockTimers(() => sonarrScanner.run());
      await entered;
      let attempted!: () => void;
      const queued = new Promise<void>((resolve) => {
        attempted = resolve;
      });
      const originalLock = dvrIdentityLocks.withDvrIdentityLock;
      t.mock.method(
        dvrIdentityLocks,
        'withDvrIdentityLock',
        (...args: Parameters<typeof originalLock>) => {
          attempted();
          return originalLock(...args);
        }
      );
      const app = express();
      app.use(express.json());
      app.use('/settings', settingsRoutes);
      let settled = false;
      const changing = request(app)
        .put('/settings/2')
        .send({ ...connectionA, hostname: 'connection-b' })
        .then((res) => {
          settled = true;
          return res;
        });
      await queued;
      assert.equal(settled, false);
      release();
      await scanning;
      assert.equal((await changing).status, 200);
      assert.equal(
        (
          await getRepository(MediaDestinationStatus).findOneByOrFail({
            mediaId: media.id,
            serverId: 2,
          })
        ).externalServiceId,
        null
      );
      assert.equal(settings.sonarr[0].hostname, 'connection-b');
    }
  );

  it('commits reconciliation and releases the destination before notification delivery and explicit removal', async (t) => {
    const { media, destinations, requests } = await seedRemoval(MediaType.TV);
    configureSonarr([{ id: 2, independentRequestDestination: true }]);
    await getRepository(MediaRequest).delete(requests[1].id);
    await getRepository(MediaDestinationStatus).update(destinations[1].id, {
      status: MediaStatus.PROCESSING,
    });
    await getRepository(MediaDestinationSeasonStatus).update(
      { destinationStatusId: destinations[1].id },
      { status: MediaStatus.PROCESSING }
    );
    getSeriesImpl = async () => [fakeSonarrSeries({ id: 999, tvdbId: 999 })];
    getShowByTvdbIdImpl = async () => fakeTmdbShow(999);
    getTvShowImpl = async () => fakeTmdbShow(999);
    let entered!: () => void;
    let release!: () => void;
    const notifying = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const delivered = new Promise<void>((resolve) => {
      release = resolve;
    });
    t.after(() => release());
    const notify = t.mock.method(
      MediaRequest,
      'sendNotification',
      async (
        declined: MediaRequest,
        _media: Media,
        notification: Notification
      ) => {
        assert.equal(notification, Notification.MEDIA_DECLINED);
        assert.equal(declined.id, requests[0].id);
        assert.equal(
          (
            await getRepository(MediaRequest).findOneByOrFail({
              id: declined.id,
            })
          ).status,
          MediaRequestStatus.DECLINED
        );
        assert.equal(
          (
            await getRepository(MediaDestinationStatus).findOneByOrFail({
              id: destinations[1].id,
            })
          ).status,
          MediaStatus.UNKNOWN
        );
        assert.equal(
          getRepository(Media).manager.queryRunner?.isTransactionActive ??
            false,
          false
        );
        entered();
        await delivered;
        throw new Error('notification delivery failed');
      }
    );
    t.mock.method(
      axios,
      'create',
      () =>
        ({
          interceptors: {
            request: { use: () => 0 },
            response: { use: () => 0 },
          },
          get: async () => ({ data: { id: 12, tmdbId: 550, tvdbId: 1234 } }),
          delete: async () => ({}),
        }) as unknown as AxiosInstance
    );
    const app = express();
    app.use(async (req, _res, next) => {
      req.user = await getRepository(User).findOneByOrFail({ id: 1 });
      next();
    });
    app.use('/media', mediaRoutes);
    const scanning = runWithMockTimers(() => sonarrScanner.run());
    await notifying;
    try {
      assert.equal(
        (await request(app).delete(`/media/${media.id}/file?serverId=2`))
          .status,
        204
      );
      const removed = await getRepository(
        MediaDestinationStatus
      ).findOneByOrFail({ id: destinations[1].id });
      assert.equal(removed.status, MediaStatus.DELETED);
      assert.equal(removed.externalServiceId, null);
    } finally {
      release();
    }
    await scanning;
    assert.equal(notify.mock.callCount(), 1);
    assert.equal(
      (
        await getRepository(MediaRequest).findOneByOrFail({
          id: requests[0].id,
        })
      ).status,
      MediaRequestStatus.DECLINED
    );
    await runWithMockTimers(() => sonarrScanner.run());
    assert.equal(notify.mock.callCount(), 1);
  });

  it('rejects stale inventory and season observations after removal, but allows fresh rediscovery', async () => {
    const { media, destinations } = await seedRemoval(MediaType.TV);
    configureSonarr([
      { id: 2, hostname: 'sonarr-en', independentRequestDestination: true },
    ]);
    getTvShowImpl = async () => fakeTmdbShow(media.tmdbId);
    const initialNotifications = sendNotificationMock.mock.callCount();
    const before = await removalSnapshot();
    let captured!: () => void;
    const inventoryCaptured = new Promise<void>((resolve) => {
      captured = resolve;
    });
    let resume!: () => void;
    const resumed = new Promise<void>((resolve) => {
      resume = resolve;
    });
    getSeriesImpl = async () => {
      const inventory = [fakeSonarrSeries({ id: 12, tvdbId: media.tvdbId })];
      captured();
      await resumed;
      return inventory;
    };
    const scanning = runWithMockTimers(() => sonarrScanner.run());
    await inventoryCaptured;
    try {
      await withDestinationOperationLock(MediaType.TV, media.tmdbId, 2, () =>
        persistConfirmedDestinationRemoval(
          media.id,
          2,
          getRepository(Media).manager
        )
      );
    } finally {
      resume();
    }
    await scanning;
    assert.equal(sendNotificationMock.mock.callCount(), initialNotifications);
    const after = await removalSnapshot();
    assert.equal(after.destinations[1].status, MediaStatus.DELETED);
    assert.equal(after.destinations[1].externalServiceId, null);
    assert.equal(after.destinations[1].externalServiceSlug, null);
    assert.ok(
      after.seasons
        .filter((season) => season.destinationStatusId === destinations[1].id)
        .every((season) => season.status === MediaStatus.DELETED)
    );
    assert.deepEqual(
      after.seasons.filter(
        (season) => season.destinationStatusId === destinations[0].id
      ),
      before.seasons.filter(
        (season) => season.destinationStatusId === destinations[0].id
      )
    );
    assert.deepEqual(after.media, before.media);
    assert.deepEqual(after.destinations[0], before.destinations[0]);
    assert.equal(after.requests[0].status, MediaRequestStatus.DECLINED);
    getSeriesImpl = async () => [
      fakeSonarrSeries({ id: 42, tvdbId: media.tvdbId, titleSlug: 're-added' }),
    ];
    await runWithMockTimers(() => sonarrScanner.run());
    const fresh = await removalSnapshot();
    assert.equal(fresh.destinations[1].status, MediaStatus.PARTIALLY_AVAILABLE);
    assert.equal(fresh.destinations[1].externalServiceId, 42);
    assert.equal(fresh.destinations[1].externalServiceSlug, 're-added');
    assert.equal(
      fresh.seasons.find(
        (season) =>
          season.destinationStatusId === destinations[1].id &&
          season.seasonNumber === 1
      )?.status,
      MediaStatus.AVAILABLE
    );
    assert.equal(fresh.requests[0].status, MediaRequestStatus.DECLINED);
  });

  beforeEach(() => {
    getSeriesImpl = async () => [];
    getLibrarySeriesByTvdbIdImpl = async () => [];
    getShowByTvdbIdImpl = async () => fakeTmdbShow(1);
    getTvShowImpl = async () => fakeTmdbShow(1);
  });

  describe('orphaned show cleanup', () => {
    it('skips cleanup when a standard server has sync disabled', async () => {
      const mediaRepository = getRepository(Media);

      const media = new Media();
      media.tmdbId = 1050;
      media.tvdbId = 550;
      media.mediaType = MediaType.TV;
      media.status = MediaStatus.PROCESSING;
      media.seasons = [
        new Season({
          seasonNumber: 1,
          status: MediaStatus.PROCESSING,
          status4k: MediaStatus.UNKNOWN,
        }),
      ];
      await mediaRepository.save(media);

      configureSonarr([
        { syncEnabled: true, id: 0, hostname: 'server-a' },
        { syncEnabled: false, id: 1, hostname: 'server-b' },
      ]);

      getSeriesImpl = async () => [];

      await runWithMockTimers(() => sonarrScanner.run());

      const updated = await mediaRepository.findOneOrFail({
        where: { tmdbId: 1050 },
        relations: ['seasons'],
      });
      assert.strictEqual(updated.status, MediaStatus.PROCESSING);
      assert.strictEqual(updated.seasons[0].status, MediaStatus.PROCESSING);
    });

    it('resets PROCESSING to UNKNOWN when show is not in any Sonarr server', async () => {
      const mediaRepository = getRepository(Media);

      const media = new Media();
      media.tmdbId = 1000;
      media.tvdbId = 500;
      media.mediaType = MediaType.TV;
      media.status = MediaStatus.PROCESSING;
      media.seasons = [
        new Season({
          seasonNumber: 1,
          status: MediaStatus.PROCESSING,
          status4k: MediaStatus.UNKNOWN,
        }),
      ];
      await mediaRepository.save(media);

      configureSonarr([{ syncEnabled: true }]);
      getSeriesImpl = async () => [fakeSonarrSeries({ tvdbId: 999 })];

      await runWithMockTimers(() => sonarrScanner.run());

      const updated = await mediaRepository.findOneOrFail({
        where: { tmdbId: 1000 },
        relations: ['seasons'],
      });
      assert.strictEqual(updated.status, MediaStatus.UNKNOWN);
      assert.strictEqual(updated.seasons[0].status, MediaStatus.UNKNOWN);
    });

    it('does not reset AVAILABLE show when missing from Sonarr', async () => {
      const mediaRepository = getRepository(Media);

      const media = new Media();
      media.tmdbId = 1001;
      media.tvdbId = 501;
      media.mediaType = MediaType.TV;
      media.status = MediaStatus.AVAILABLE;
      media.seasons = [
        new Season({
          seasonNumber: 1,
          status: MediaStatus.AVAILABLE,
          status4k: MediaStatus.UNKNOWN,
        }),
      ];
      await mediaRepository.save(media);

      configureSonarr([{ syncEnabled: true }]);
      getSeriesImpl = async () => [];

      await runWithMockTimers(() => sonarrScanner.run());

      const updated = await mediaRepository.findOneOrFail({
        where: { tmdbId: 1001 },
        relations: ['seasons'],
      });
      assert.strictEqual(updated.status, MediaStatus.AVAILABLE);
    });

    it('does not reset PROCESSING show that still exists in Sonarr', async () => {
      const mediaRepository = getRepository(Media);

      const media = new Media();
      media.tmdbId = 1;
      media.tvdbId = 200;
      media.mediaType = MediaType.TV;
      media.status = MediaStatus.PROCESSING;
      media.seasons = [
        new Season({
          seasonNumber: 1,
          status: MediaStatus.PROCESSING,
          status4k: MediaStatus.UNKNOWN,
        }),
      ];
      await mediaRepository.save(media);

      configureSonarr([{ syncEnabled: true }]);
      getSeriesImpl = async () => [
        fakeSonarrSeries({
          tvdbId: 200,
          seasons: [
            {
              seasonNumber: 1,
              monitored: true,
              statistics: {
                episodeFileCount: 0,
                totalEpisodeCount: 10,
                episodeCount: 10,
                percentOfEpisodes: 0,
                sizeOnDisk: 0,
                previousAiring: undefined,
              },
            },
          ],
        }),
      ];

      getShowByTvdbIdImpl = async () => fakeTmdbShow(1);
      getTvShowImpl = async () => fakeTmdbShow(1);

      await runWithMockTimers(() => sonarrScanner.run());

      const updated = await mediaRepository.findOneOrFail({
        where: { tmdbId: 1 },
        relations: ['seasons'],
      });
      assert.strictEqual(updated.status, MediaStatus.PROCESSING);
    });

    it('only resets season statuses that are PROCESSING on orphaned shows', async () => {
      const mediaRepository = getRepository(Media);

      const media = new Media();
      media.tmdbId = 1003;
      media.tvdbId = 503;
      media.mediaType = MediaType.TV;
      media.status = MediaStatus.PROCESSING;
      media.seasons = [
        new Season({
          seasonNumber: 1,
          status: MediaStatus.AVAILABLE,
          status4k: MediaStatus.UNKNOWN,
        }),
        new Season({
          seasonNumber: 2,
          status: MediaStatus.PROCESSING,
          status4k: MediaStatus.UNKNOWN,
        }),
      ];
      await mediaRepository.save(media);

      configureSonarr([{ syncEnabled: true }]);
      getSeriesImpl = async () => [fakeSonarrSeries({ tvdbId: 999 })];

      await runWithMockTimers(() => sonarrScanner.run());

      const updated = await mediaRepository.findOneOrFail({
        where: { tmdbId: 1003 },
        relations: ['seasons'],
      });
      assert.strictEqual(updated.status, MediaStatus.UNKNOWN);

      const s1 = updated.seasons.find((s) => s.seasonNumber === 1);
      const s2 = updated.seasons.find((s) => s.seasonNumber === 2);
      assert.strictEqual(s1?.status, MediaStatus.AVAILABLE);
      assert.strictEqual(s2?.status, MediaStatus.UNKNOWN);
    });

    it('does not reset movie media that is missing from Sonarr', async () => {
      const mediaRepository = getRepository(Media);

      const media = new Media();
      media.tmdbId = 1004;
      media.mediaType = MediaType.MOVIE;
      media.status = MediaStatus.PROCESSING;
      await mediaRepository.save(media);

      configureSonarr([{ syncEnabled: true }]);
      getSeriesImpl = async () => [];

      await runWithMockTimers(() => sonarrScanner.run());

      const updated = await mediaRepository.findOneOrFail({
        where: { tmdbId: 1004 },
      });
      assert.strictEqual(updated.status, MediaStatus.PROCESSING);
    });

    it('only resets orphaned shows not found across all servers', async () => {
      const mediaRepository = getRepository(Media);

      const orphan = new Media();
      orphan.tmdbId = 1010;
      orphan.tvdbId = 510;
      orphan.mediaType = MediaType.TV;
      orphan.status = MediaStatus.PROCESSING;
      orphan.seasons = [
        new Season({
          seasonNumber: 1,
          status: MediaStatus.PROCESSING,
          status4k: MediaStatus.UNKNOWN,
        }),
      ];
      await mediaRepository.save(orphan);

      const existing = new Media();
      existing.tmdbId = 2;
      existing.tvdbId = 511;
      existing.mediaType = MediaType.TV;
      existing.status = MediaStatus.PROCESSING;
      existing.seasons = [
        new Season({
          seasonNumber: 1,
          status: MediaStatus.PROCESSING,
          status4k: MediaStatus.UNKNOWN,
        }),
      ];
      await mediaRepository.save(existing);

      configureSonarr([
        { syncEnabled: true, id: 0, hostname: 'server-a' },
        { syncEnabled: true, id: 1, hostname: 'server-b' },
      ]);

      getSeriesImpl = async () => [fakeSonarrSeries({ tvdbId: 511 })];

      getShowByTvdbIdImpl = async () => fakeTmdbShow(2);
      getTvShowImpl = async () => fakeTmdbShow(2);

      await runWithMockTimers(() => sonarrScanner.run());

      const updatedOrphan = await mediaRepository.findOneOrFail({
        where: { tmdbId: 1010 },
        relations: ['seasons'],
      });
      assert.strictEqual(updatedOrphan.status, MediaStatus.UNKNOWN);

      const updatedExisting = await mediaRepository.findOneOrFail({
        where: { tmdbId: 2 },
        relations: ['seasons'],
      });
      assert.notStrictEqual(updatedExisting.status, MediaStatus.UNKNOWN);
    });

    it('does not reset a show added to Sonarr after the scan started', async () => {
      const mediaRepository = getRepository(Media);

      const media = new Media();
      media.tmdbId = 1020;
      media.tvdbId = 620;
      media.mediaType = MediaType.TV;
      media.status = MediaStatus.PROCESSING;
      await mediaRepository.save(media);

      configureSonarr([{ syncEnabled: true }]);
      getSeriesImpl = async () => [fakeSonarrSeries({ tvdbId: 111 })];
      getLibrarySeriesByTvdbIdImpl = async (tvdbId) => [
        fakeSonarrSeries({ tvdbId }),
      ];

      await sonarrScanner.run();

      const updated = await mediaRepository.findOneOrFail({
        where: { tmdbId: 1020 },
      });
      assert.strictEqual(updated.status, MediaStatus.PROCESSING);
    });

    it('does not reset a show when the server cannot be reached', async () => {
      const mediaRepository = getRepository(Media);

      const media = new Media();
      media.tmdbId = 1021;
      media.tvdbId = 621;
      media.mediaType = MediaType.TV;
      media.status = MediaStatus.PROCESSING;
      await mediaRepository.save(media);

      configureSonarr([{ syncEnabled: true }]);
      getSeriesImpl = async () => [fakeSonarrSeries({ tvdbId: 111 })];
      getLibrarySeriesByTvdbIdImpl = async () => {
        throw new Error('connect ECONNREFUSED');
      };

      await sonarrScanner.run();

      const updated = await mediaRepository.findOneOrFail({
        where: { tmdbId: 1021 },
      });
      assert.strictEqual(updated.status, MediaStatus.PROCESSING);
    });

    it('resets a show when the server returns no row matching its id', async () => {
      const mediaRepository = getRepository(Media);

      const media = new Media();
      media.tmdbId = 1022;
      media.tvdbId = 622;
      media.mediaType = MediaType.TV;
      media.status = MediaStatus.PROCESSING;
      await mediaRepository.save(media);

      configureSonarr([{ syncEnabled: true }]);
      getSeriesImpl = async () => [fakeSonarrSeries({ tvdbId: 111 })];
      getLibrarySeriesByTvdbIdImpl = async () => [
        fakeSonarrSeries({ tvdbId: 111 }),
        fakeSonarrSeries({ tvdbId: 222 }),
      ];

      await sonarrScanner.run();

      const updated = await mediaRepository.findOneOrFail({
        where: { tmdbId: 1022 },
      });
      assert.strictEqual(updated.status, MediaStatus.UNKNOWN);
    });

    it('skips shows without a tvdbId during cleanup', async () => {
      const mediaRepository = getRepository(Media);

      const media = new Media();
      media.tmdbId = 1020;
      media.mediaType = MediaType.TV;
      media.status = MediaStatus.PROCESSING;
      media.seasons = [];
      await mediaRepository.save(media);

      configureSonarr([{ syncEnabled: true }]);
      getSeriesImpl = async () => [fakeSonarrSeries({ tvdbId: 999 })];

      await runWithMockTimers(() => sonarrScanner.run());

      const updated = await mediaRepository.findOneOrFail({
        where: { tmdbId: 1020 },
      });
      assert.strictEqual(updated.status, MediaStatus.PROCESSING);
    });
  });

  describe('4k orphaned show cleanup', () => {
    it('resets 4k PROCESSING to UNKNOWN when show is not in any Sonarr server', async () => {
      const mediaRepository = getRepository(Media);

      const media = new Media();
      media.tmdbId = 1030;
      media.tvdbId = 530;
      media.mediaType = MediaType.TV;
      media.status = MediaStatus.UNKNOWN;
      media.status4k = MediaStatus.PROCESSING;
      media.seasons = [
        new Season({
          seasonNumber: 1,
          status: MediaStatus.UNKNOWN,
          status4k: MediaStatus.PROCESSING,
        }),
      ];
      await mediaRepository.save(media);

      configureSonarr([{ syncEnabled: true, is4k: true }]);
      getSeriesImpl = async () => [fakeSonarrSeries({ tvdbId: 999 })];

      await runWithMockTimers(() => sonarrScanner.run());

      const updated = await mediaRepository.findOneOrFail({
        where: { tmdbId: 1030 },
        relations: ['seasons'],
      });
      assert.strictEqual(updated.status4k, MediaStatus.UNKNOWN);
      assert.strictEqual(updated.seasons[0].status4k, MediaStatus.UNKNOWN);
    });

    it('does not reset 4k AVAILABLE season when show is orphaned', async () => {
      const mediaRepository = getRepository(Media);

      const media = new Media();
      media.tmdbId = 1031;
      media.tvdbId = 531;
      media.mediaType = MediaType.TV;
      media.status = MediaStatus.UNKNOWN;
      media.status4k = MediaStatus.PROCESSING;
      media.seasons = [
        new Season({
          seasonNumber: 1,
          status: MediaStatus.UNKNOWN,
          status4k: MediaStatus.AVAILABLE,
        }),
        new Season({
          seasonNumber: 2,
          status: MediaStatus.UNKNOWN,
          status4k: MediaStatus.PROCESSING,
        }),
      ];
      await mediaRepository.save(media);

      configureSonarr([{ syncEnabled: true, is4k: true }]);
      getSeriesImpl = async () => [fakeSonarrSeries({ tvdbId: 999 })];

      await runWithMockTimers(() => sonarrScanner.run());

      const updated = await mediaRepository.findOneOrFail({
        where: { tmdbId: 1031 },
        relations: ['seasons'],
      });
      const s1 = updated.seasons.find((s) => s.seasonNumber === 1);
      const s2 = updated.seasons.find((s) => s.seasonNumber === 2);
      assert.strictEqual(s1?.status4k, MediaStatus.AVAILABLE);
      assert.strictEqual(s2?.status4k, MediaStatus.UNKNOWN);
    });
  });

  describe('orphaned request handling', () => {
    it('declines the approved request and resets the show to UNKNOWN when orphaned', async () => {
      const mediaRepository = getRepository(Media);
      const requestRepository = getRepository(MediaRequest);
      const userRepository = getRepository(User);

      const requestedBy = await userRepository.findOneOrFail({
        where: { id: 1 },
      });

      const media = await mediaRepository.save(
        new Media({
          tmdbId: 2000,
          tvdbId: 555,
          mediaType: MediaType.TV,
          status: MediaStatus.PROCESSING,
          seasons: [
            new Season({
              seasonNumber: 1,
              status: MediaStatus.PROCESSING,
              status4k: MediaStatus.UNKNOWN,
            }),
          ],
        })
      );

      const settings = getSettings();
      settings.sonarr = [];
      settings.radarr = [];
      const request = await requestRepository.save(
        new MediaRequest({
          type: MediaType.TV,
          status: MediaRequestStatus.APPROVED,
          media,
          requestedBy,
          is4k: false,
        })
      );

      configureSonarr([{ syncEnabled: true }]);
      getSeriesImpl = async () => [fakeSonarrSeries({ tvdbId: 999 })];

      await runWithMockTimers(() => sonarrScanner.run());

      const updatedMedia = await mediaRepository.findOneOrFail({
        where: { tmdbId: 2000 },
      });
      const updatedRequest = await requestRepository.findOneOrFail({
        where: { id: request.id },
      });

      assert.strictEqual(updatedMedia.status, MediaStatus.UNKNOWN);
      assert.strictEqual(updatedRequest.status, MediaRequestStatus.DECLINED);
    });

    it('does not decline the request when the show still exists in Sonarr', async () => {
      const mediaRepository = getRepository(Media);
      const requestRepository = getRepository(MediaRequest);
      const userRepository = getRepository(User);

      const requestedBy = await userRepository.findOneOrFail({
        where: { id: 1 },
      });

      const media = await mediaRepository.save(
        new Media({
          tmdbId: 2001,
          tvdbId: 600,
          mediaType: MediaType.TV,
          status: MediaStatus.PROCESSING,
          seasons: [
            new Season({
              seasonNumber: 1,
              status: MediaStatus.PROCESSING,
              status4k: MediaStatus.UNKNOWN,
            }),
          ],
        })
      );

      const settings = getSettings();
      settings.sonarr = [];
      settings.radarr = [];
      const request = await requestRepository.save(
        new MediaRequest({
          type: MediaType.TV,
          status: MediaRequestStatus.APPROVED,
          media,
          requestedBy,
          is4k: false,
        })
      );

      configureSonarr([{ syncEnabled: true }]);
      getSeriesImpl = async () => [
        fakeSonarrSeries({
          tvdbId: 600,
          seasons: [
            {
              seasonNumber: 1,
              monitored: true,
              statistics: {
                episodeFileCount: 0,
                totalEpisodeCount: 10,
                episodeCount: 10,
                percentOfEpisodes: 0,
                sizeOnDisk: 0,
                previousAiring: undefined,
              },
            },
          ],
        }),
      ];
      getShowByTvdbIdImpl = async () => fakeTmdbShow(2001);
      getTvShowImpl = async () => fakeTmdbShow(2001);

      await runWithMockTimers(() => sonarrScanner.run());

      const updatedRequest = await requestRepository.findOneOrFail({
        where: { id: request.id },
      });
      assert.strictEqual(updatedRequest.status, MediaRequestStatus.APPROVED);
    });

    it('skips cleanup and leaves the request approved when Sonarr returns an empty list', async () => {
      const mediaRepository = getRepository(Media);
      const requestRepository = getRepository(MediaRequest);
      const userRepository = getRepository(User);

      const requestedBy = await userRepository.findOneOrFail({
        where: { id: 1 },
      });

      const media = await mediaRepository.save(
        new Media({
          tmdbId: 2005,
          tvdbId: 605,
          mediaType: MediaType.TV,
          status: MediaStatus.PROCESSING,
          seasons: [
            new Season({
              seasonNumber: 1,
              status: MediaStatus.PROCESSING,
              status4k: MediaStatus.UNKNOWN,
            }),
          ],
        })
      );

      const settings = getSettings();
      settings.sonarr = [];
      settings.radarr = [];
      const request = await requestRepository.save(
        new MediaRequest({
          type: MediaType.TV,
          status: MediaRequestStatus.APPROVED,
          media,
          requestedBy,
          is4k: false,
        })
      );

      configureSonarr([{ syncEnabled: true }]);
      getSeriesImpl = async () => [];

      await runWithMockTimers(() => sonarrScanner.run());

      const updatedMedia = await mediaRepository.findOneOrFail({
        where: { tmdbId: 2005 },
      });
      const updatedRequest = await requestRepository.findOneOrFail({
        where: { id: request.id },
      });

      assert.strictEqual(updatedMedia.status, MediaStatus.PROCESSING);
      assert.strictEqual(updatedRequest.status, MediaRequestStatus.APPROVED);
    });

    it('declineOrphanedRequests throws when the requests relation is not loaded', async () => {
      const media = new Media();
      media.id = 1;
      media.tmdbId = 123;
      media.mediaType = MediaType.TV;

      await assert.rejects(
        () =>
          (
            sonarrScanner as unknown as {
              declineOrphanedRequests: (
                m: Media,
                is4k: boolean
              ) => Promise<void>;
            }
          ).declineOrphanedRequests(media, false),
        /without the 'requests' relation loaded/
      );
    });

    it('declines only the 4k request when the 4k dimension is orphaned but standard still exists', async () => {
      const mediaRepository = getRepository(Media);
      const requestRepository = getRepository(MediaRequest);
      const userRepository = getRepository(User);

      const requestedBy = await userRepository.findOneOrFail({
        where: { id: 1 },
      });

      const media = await mediaRepository.save(
        new Media({
          tmdbId: 2002,
          tvdbId: 666,
          mediaType: MediaType.TV,
          status: MediaStatus.PROCESSING,
          status4k: MediaStatus.PROCESSING,
          seasons: [
            new Season({
              seasonNumber: 1,
              status: MediaStatus.PROCESSING,
              status4k: MediaStatus.PROCESSING,
            }),
          ],
        })
      );

      const settings = getSettings();
      settings.sonarr = [];
      settings.radarr = [];
      const standardRequest = await requestRepository.save(
        new MediaRequest({
          type: MediaType.TV,
          status: MediaRequestStatus.APPROVED,
          media,
          requestedBy,
          is4k: false,
        })
      );
      const fourKRequest = await requestRepository.save(
        new MediaRequest({
          type: MediaType.TV,
          status: MediaRequestStatus.APPROVED,
          media,
          requestedBy,
          is4k: true,
        })
      );

      configureSonarr([
        { syncEnabled: true, id: 0, hostname: 'server-standard' },
        { syncEnabled: true, id: 1, hostname: 'server-4k', is4k: true },
      ]);

      let callCount = 0;
      getSeriesImpl = async () => {
        callCount++;
        if (callCount === 1) {
          // standard server still has the show (processing, no files)
          return [
            fakeSonarrSeries({
              tvdbId: 666,
              seasons: [
                {
                  seasonNumber: 1,
                  monitored: true,
                  statistics: {
                    episodeFileCount: 0,
                    totalEpisodeCount: 10,
                    episodeCount: 10,
                    percentOfEpisodes: 0,
                    sizeOnDisk: 0,
                    previousAiring: undefined,
                  },
                },
              ],
            }),
          ];
        }
        // 4k server: populated but the show is absent, so 4k dimension orphaned
        return [fakeSonarrSeries({ tvdbId: 997 })];
      };

      getShowByTvdbIdImpl = async ({ tvdbId }) =>
        tvdbId === 666 ? fakeTmdbShow(2002) : fakeTmdbShow(997);
      getTvShowImpl = async ({ tvId }) => fakeTmdbShow(tvId);

      await runWithMockTimers(() => sonarrScanner.run());

      const updatedMedia = await mediaRepository.findOneOrFail({
        where: { tmdbId: 2002 },
      });
      const updatedStandard = await requestRepository.findOneOrFail({
        where: { id: standardRequest.id },
      });
      const updated4k = await requestRepository.findOneOrFail({
        where: { id: fourKRequest.id },
      });

      assert.strictEqual(updatedMedia.status, MediaStatus.PROCESSING);
      assert.strictEqual(updatedMedia.status4k, MediaStatus.UNKNOWN);
      assert.strictEqual(updatedStandard.status, MediaRequestStatus.APPROVED);
      assert.strictEqual(updated4k.status, MediaRequestStatus.DECLINED);
    });
  });

  describe('independent destination scanning', () => {
    it('scans canonically equivalent native configurations separately under upstream raw deduplication', async () => {
      configureSonarr([
        { id: 28, hostname: 'localhost', port: 8989, baseUrl: '' },
        { id: 29, hostname: 'localhost', port: 8989, baseUrl: '/' },
      ]);
      let inventoryCalls = 0;
      getSeriesImpl = async () => {
        inventoryCalls++;
        return [];
      };

      await runWithMockTimers(() => sonarrScanner.run());

      assert.strictEqual(inventoryCalls, 2);
    });

    it('creates minimal TV identity without native season state', async () => {
      configureSonarr([
        {
          id: 30,
          hostname: 'sonarr-en',
          independentRequestDestination: true,
        },
      ]);
      getSeriesImpl = async () => [fakeSonarrSeries({ tvdbId: 3999 })];
      getShowByTvdbIdImpl = async () => fakeTmdbShow(2999);

      await runWithMockTimers(() => sonarrScanner.run());

      const media = await getRepository(Media).findOneOrFail({
        where: { tmdbId: 2999, mediaType: MediaType.TV },
        relations: { seasons: true },
      });
      const destination = await getRepository(
        MediaDestinationStatus
      ).findOneOrFail({
        where: { mediaId: media.id, serverId: 30 },
      });
      assert.strictEqual(media.tvdbId, 3999);
      assert.strictEqual(media.status, MediaStatus.UNKNOWN);
      assert.strictEqual(media.status4k, MediaStatus.UNKNOWN);
      assert.strictEqual(media.seasons.length, 0);
      assert.strictEqual(destination.status, MediaStatus.AVAILABLE);
    });

    it('backfills a missing TVDB identity and later uses it for exact orphan cleanup', async () => {
      const media = await getRepository(Media).save(
        new Media({ tmdbId: 3650, mediaType: MediaType.TV })
      );
      const destination = await getRepository(MediaDestinationStatus).save(
        new MediaDestinationStatus({
          mediaId: media.id,
          serverId: 30,
          status: MediaStatus.PROCESSING,
        })
      );
      configureSonarr([
        {
          id: 30,
          hostname: 'sonarr-en',
          independentRequestDestination: true,
        },
      ]);
      getSeriesImpl = async () => [fakeSonarrSeries({ tvdbId: 4650 })];
      getShowByTvdbIdImpl = async () => fakeTmdbShow(3650);

      await runWithMockTimers(() => sonarrScanner.run());

      assert.strictEqual(
        (await getRepository(Media).findOneByOrFail({ id: media.id })).tvdbId,
        4650
      );
      assert.strictEqual(
        (
          await getRepository(MediaDestinationStatus).findOneByOrFail({
            id: destination.id,
          })
        ).status,
        MediaStatus.AVAILABLE
      );

      getSeriesImpl = async () => [fakeSonarrSeries({ tvdbId: 9999 })];
      getLibrarySeriesByTvdbIdImpl = async () => [];
      await runWithMockTimers(() => sonarrScanner.run());

      assert.strictEqual(
        (
          await getRepository(MediaDestinationStatus).findOneByOrFail({
            id: destination.id,
          })
        ).status,
        MediaStatus.DELETED
      );
    });

    it('does not overwrite or merge a conflicting TVDB identity', async () => {
      const media = await getRepository(Media).save(
        new Media({ tmdbId: 3660, mediaType: MediaType.TV })
      );
      const owner = await getRepository(Media).save(
        new Media({
          tmdbId: 3661,
          tvdbId: 4660,
          mediaType: MediaType.TV,
        })
      );
      const destination = await getRepository(MediaDestinationStatus).save(
        new MediaDestinationStatus({
          mediaId: media.id,
          serverId: 30,
          status: MediaStatus.AVAILABLE,
        })
      );
      configureSonarr([
        {
          id: 30,
          hostname: 'sonarr-en',
          independentRequestDestination: true,
        },
      ]);
      getSeriesImpl = async () => [fakeSonarrSeries({ tvdbId: 4660 })];
      getTvShowImpl = async () => fakeTmdbShow(3660);

      await runWithMockTimers(() => sonarrScanner.run());

      assert.strictEqual(
        (await getRepository(Media).findOneByOrFail({ id: media.id })).tvdbId,
        null
      );
      assert.strictEqual(
        (await getRepository(Media).findOneByOrFail({ id: owner.id })).tvdbId,
        4660
      );
      assert.strictEqual(
        (
          await getRepository(MediaDestinationStatus).findOneByOrFail({
            id: destination.id,
          })
        ).status,
        MediaStatus.AVAILABLE
      );
    });

    it('writes exact season states and linkage without changing native seasons or another destination', async () => {
      const mediaRepository = getRepository(Media);
      const destinationRepository = getRepository(MediaDestinationStatus);
      const media = await mediaRepository.save(
        new Media({
          tmdbId: 3000,
          tvdbId: 4000,
          mediaType: MediaType.TV,
          status: MediaStatus.UNKNOWN,
          status4k: MediaStatus.UNKNOWN,
          serviceId: 99,
          externalServiceId: 999,
          externalServiceSlug: 'native-show',
          seasons: [
            new Season({
              seasonNumber: 1,
              status: MediaStatus.UNKNOWN,
              status4k: MediaStatus.UNKNOWN,
            }),
          ],
        })
      );
      const otherDestination = await destinationRepository.save(
        new MediaDestinationStatus({
          mediaId: media.id,
          serverId: 31,
          status: MediaStatus.PROCESSING,
        })
      );
      await getRepository(MediaDestinationSeasonStatus).save(
        new MediaDestinationSeasonStatus({
          destinationStatusId: otherDestination.id,
          seasonNumber: 1,
          status: MediaStatus.PROCESSING,
        })
      );
      configureSonarr([
        {
          id: 30,
          hostname: 'sonarr-en',
          independentRequestDestination: true,
        },
      ]);
      getSeriesImpl = async () => [
        fakeSonarrSeries({
          tvdbId: 4000,
          id: 88,
          titleSlug: 'exact-show',
          seasons: [
            {
              seasonNumber: 1,
              monitored: true,
              statistics: {
                episodeFileCount: 10,
                totalEpisodeCount: 10,
                episodeCount: 10,
                percentOfEpisodes: 100,
                sizeOnDisk: 0,
                previousAiring: undefined,
              },
            },
            {
              seasonNumber: 2,
              monitored: true,
              statistics: {
                episodeFileCount: 4,
                totalEpisodeCount: 10,
                episodeCount: 10,
                percentOfEpisodes: 40,
                sizeOnDisk: 0,
                previousAiring: undefined,
              },
            },
            {
              seasonNumber: 3,
              monitored: true,
              statistics: {
                episodeFileCount: 0,
                totalEpisodeCount: 10,
                episodeCount: 10,
                percentOfEpisodes: 0,
                sizeOnDisk: 0,
                previousAiring: undefined,
              },
            },
          ],
        }),
      ];
      const tmdbSeasons = [1, 2, 3].map((seasonNumber) => ({
        id: seasonNumber,
        air_date: '2024-01-01',
        episode_count: 10,
        name: `Season ${seasonNumber}`,
        overview: '',
        season_number: seasonNumber,
      }));
      getTvShowImpl = async () => fakeTmdbShow(3000, tmdbSeasons);

      await runWithMockTimers(() => sonarrScanner.run());

      const destination = await destinationRepository.findOneOrFail({
        where: { mediaId: media.id, serverId: 30 },
      });
      const exactSeasons = await getRepository(
        MediaDestinationSeasonStatus
      ).find({
        where: { destinationStatusId: destination.id },
        order: { seasonNumber: 'ASC' },
      });
      assert.strictEqual(destination.status, MediaStatus.PARTIALLY_AVAILABLE);
      assert.strictEqual(destination.externalServiceId, 88);
      assert.strictEqual(destination.externalServiceSlug, 'exact-show');
      assert.deepStrictEqual(
        exactSeasons.map((season) => season.status),
        [
          MediaStatus.AVAILABLE,
          MediaStatus.PARTIALLY_AVAILABLE,
          MediaStatus.PROCESSING,
        ]
      );
      const unchangedOther = await destinationRepository.findOneOrFail({
        where: { id: otherDestination.id },
      });
      assert.strictEqual(unchangedOther.status, MediaStatus.PROCESSING);
      const updatedMedia = await mediaRepository.findOneOrFail({
        where: { id: media.id },
        relations: { seasons: true },
      });
      assert.strictEqual(updatedMedia.status, MediaStatus.UNKNOWN);
      assert.strictEqual(updatedMedia.status4k, MediaStatus.UNKNOWN);
      assert.strictEqual(updatedMedia.seasons[0].status, MediaStatus.UNKNOWN);
      assert.strictEqual(updatedMedia.serviceId, 99);
      assert.strictEqual(updatedMedia.externalServiceId, 999);
      assert.strictEqual(updatedMedia.externalServiceSlug, 'native-show');
    });

    it('completes requested TV seasons incrementally only on the exact destination', async () => {
      const initialNotifications = availableNotifications().length;
      const media = await getRepository(Media).save(
        new Media({
          tmdbId: 3100,
          tvdbId: 4100,
          mediaType: MediaType.TV,
        })
      );
      const requestRepository = getRepository(MediaRequest);
      const request = await requestRepository.save(
        new MediaRequest({
          type: MediaType.TV,
          status: MediaRequestStatus.PENDING,
          media,
          requestedBy: await getRepository(User).findOneOrFail({
            where: { id: 1 },
          }),
          is4k: false,
          serverId: 30,
          seasons: [
            new SeasonRequest({ seasonNumber: 1 }),
            new SeasonRequest({ seasonNumber: 2 }),
          ],
        })
      );
      const otherRequest = await requestRepository.save(
        new MediaRequest({
          type: MediaType.TV,
          status: MediaRequestStatus.PENDING,
          media,
          requestedBy: await getRepository(User).findOneOrFail({
            where: { id: 1 },
          }),
          is4k: false,
          serverId: 31,
          seasons: [new SeasonRequest({ seasonNumber: 1 })],
        })
      );
      await requestRepository
        .createQueryBuilder()
        .update(MediaRequest)
        .set({ status: MediaRequestStatus.APPROVED })
        .where('id IN (:...ids)', { ids: [request.id, otherRequest.id] })
        .callListeners(false)
        .execute();
      await getRepository(SeasonRequest)
        .createQueryBuilder()
        .update(SeasonRequest)
        .set({ status: MediaRequestStatus.APPROVED })
        .where('requestId = :requestId', { requestId: request.id })
        .callListeners(false)
        .execute();
      configureSonarr([
        {
          id: 30,
          hostname: 'sonarr-en',
          independentRequestDestination: true,
        },
      ]);
      const seasons = [1, 2].map((seasonNumber) => ({
        id: seasonNumber,
        air_date: '2024-01-01',
        episode_count: 10,
        name: `Season ${seasonNumber}`,
        overview: '',
        season_number: seasonNumber,
      }));
      getTvShowImpl = async () => fakeTmdbShow(3100, seasons);
      getSeriesImpl = async () => [
        fakeSonarrSeries({
          tvdbId: 4100,
          seasons: [
            {
              seasonNumber: 1,
              monitored: true,
              statistics: {
                episodeFileCount: 10,
                totalEpisodeCount: 10,
                episodeCount: 10,
                percentOfEpisodes: 100,
                sizeOnDisk: 0,
                previousAiring: undefined,
              },
            },
            {
              seasonNumber: 2,
              monitored: true,
              statistics: {
                episodeFileCount: 0,
                totalEpisodeCount: 10,
                episodeCount: 10,
                percentOfEpisodes: 0,
                sizeOnDisk: 0,
                previousAiring: undefined,
              },
            },
          ],
        }),
      ];

      await runWithMockTimers(() => sonarrScanner.run());

      let updated = await requestRepository.findOneOrFail({
        where: { id: request.id },
        relations: { seasons: true },
      });
      assert.strictEqual(updated.status, MediaRequestStatus.APPROVED);
      assert.equal(availableNotifications().length, initialNotifications);
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
          await getRepository(MediaDestinationStatus).findOneOrFail({
            where: { mediaId: media.id, serverId: 30 },
          })
        ).status,
        MediaStatus.PARTIALLY_AVAILABLE
      );

      getSeriesImpl = async () => [
        fakeSonarrSeries({
          tvdbId: 4100,
          seasons: [1, 2].map((seasonNumber) => ({
            seasonNumber,
            monitored: true,
            statistics: {
              episodeFileCount: 10,
              totalEpisodeCount: 10,
              episodeCount: 10,
              percentOfEpisodes: 100,
              sizeOnDisk: 0,
              previousAiring: undefined,
            },
          })),
        }),
      ];
      await runWithMockTimers(() => sonarrScanner.run());
      updated = await requestRepository.findOneOrFail({
        where: { id: request.id },
        relations: { seasons: true },
      });
      assert.strictEqual(updated.status, MediaRequestStatus.COMPLETED);
      assert.equal(availableNotifications().length, initialNotifications + 1);
      assert.equal(
        availableNotifications().at(-1)?.arguments[0]?.id,
        request.id
      );
      await runWithMockTimers(() => sonarrScanner.run());
      assert.equal(availableNotifications().length, initialNotifications + 1);
      assert.ok(
        updated.seasons.every(
          (season) => season.status === MediaRequestStatus.COMPLETED
        )
      );
      assert.strictEqual(
        (await requestRepository.findOneByOrFail({ id: otherRequest.id }))
          .status,
        MediaRequestStatus.APPROVED
      );
    });

    it('ignores zero-episode metadata and safely demotes confirmed unmonitored seasons', async () => {
      const media = await getRepository(Media).save(
        new Media({
          tmdbId: 3150,
          tvdbId: 4150,
          mediaType: MediaType.TV,
        })
      );
      const destination = await getRepository(MediaDestinationStatus).save(
        new MediaDestinationStatus({
          mediaId: media.id,
          serverId: 30,
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
      configureSonarr([
        {
          id: 30,
          hostname: 'sonarr-en',
          independentRequestDestination: true,
        },
      ]);
      getSeriesImpl = async () => [
        fakeSonarrSeries({
          tvdbId: 4150,
          seasons: [
            {
              seasonNumber: 1,
              monitored: false,
              statistics: {
                episodeFileCount: 0,
                totalEpisodeCount: 0,
                episodeCount: 0,
                percentOfEpisodes: 0,
                sizeOnDisk: 0,
                previousAiring: undefined,
              },
            },
          ],
        }),
      ];
      getTvShowImpl = async () =>
        fakeTmdbShow(3150, [
          {
            id: 1,
            air_date: '2024-01-01',
            episode_count: 0,
            name: 'Season 1',
            overview: '',
            season_number: 1,
          },
        ]);

      await runWithMockTimers(() => sonarrScanner.run());
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

      getTvShowImpl = async () => fakeTmdbShow(3150);
      getSeriesImpl = async () => [
        fakeSonarrSeries({
          tvdbId: 4150,
          seasons: [
            {
              seasonNumber: 1,
              monitored: false,
              statistics: {
                episodeFileCount: 0,
                totalEpisodeCount: 10,
                episodeCount: 10,
                percentOfEpisodes: 0,
                sizeOnDisk: 0,
                previousAiring: undefined,
              },
            },
          ],
        }),
      ];
      await runWithMockTimers(() => sonarrScanner.run());
      assert.strictEqual(
        (
          await getRepository(MediaDestinationStatus).findOneByOrFail({
            id: destination.id,
          })
        ).status,
        MediaStatus.DELETED
      );
      assert.strictEqual(
        (
          await getRepository(MediaDestinationSeasonStatus).findOneByOrFail({
            id: destinationSeason.id,
          })
        ).status,
        MediaStatus.DELETED
      );
    });

    it('does not destructively transition provider-only synthetic seasons', async () => {
      const media = await getRepository(Media).save(
        new Media({
          tmdbId: 3160,
          tvdbId: 4160,
          mediaType: MediaType.TV,
        })
      );
      const destination = await getRepository(MediaDestinationStatus).save(
        new MediaDestinationStatus({
          mediaId: media.id,
          serverId: 30,
          status: MediaStatus.PARTIALLY_AVAILABLE,
        })
      );
      const persistedSeasons = await getRepository(
        MediaDestinationSeasonStatus
      ).save([
        new MediaDestinationSeasonStatus({
          destinationStatusId: destination.id,
          seasonNumber: 1,
          status: MediaStatus.AVAILABLE,
        }),
        new MediaDestinationSeasonStatus({
          destinationStatusId: destination.id,
          seasonNumber: 2,
          status: MediaStatus.PARTIALLY_AVAILABLE,
        }),
        new MediaDestinationSeasonStatus({
          destinationStatusId: destination.id,
          seasonNumber: 3,
          status: MediaStatus.PROCESSING,
        }),
      ]);
      configureSonarr([
        {
          id: 30,
          hostname: 'sonarr-en',
          independentRequestDestination: true,
        },
      ]);
      getSeriesImpl = async () => [
        fakeSonarrSeries({ tvdbId: 4160, seasons: [] }),
      ];
      getTvShowImpl = async () =>
        fakeTmdbShow(
          3160,
          [1, 2, 3].map((seasonNumber) => ({
            id: seasonNumber,
            air_date: '2024-01-01',
            episode_count: 10,
            name: `Season ${seasonNumber}`,
            overview: '',
            season_number: seasonNumber,
          }))
        );

      await runWithMockTimers(() => sonarrScanner.run());

      const updatedSeasons = await getRepository(
        MediaDestinationSeasonStatus
      ).find({
        where: { destinationStatusId: destination.id },
        order: { seasonNumber: 'ASC' },
      });
      assert.deepStrictEqual(
        updatedSeasons.map((season) => season.status),
        persistedSeasons.map((season) => season.status)
      );
    });

    it('rolls up synthetic provider seasons as implicit UNKNOWN without persisting placeholders', async () => {
      const media = await getRepository(Media).save(
        new Media({
          tmdbId: 3170,
          tvdbId: 4170,
          mediaType: MediaType.TV,
        })
      );
      const destination = await getRepository(MediaDestinationStatus).save(
        new MediaDestinationStatus({
          mediaId: media.id,
          serverId: 30,
          status: MediaStatus.UNKNOWN,
        })
      );
      configureSonarr([
        {
          id: 30,
          hostname: 'sonarr-en',
          independentRequestDestination: true,
        },
      ]);
      getSeriesImpl = async () => [
        fakeSonarrSeries({
          tvdbId: 4170,
          seasons: [
            {
              seasonNumber: 1,
              monitored: true,
              statistics: {
                episodeFileCount: 10,
                totalEpisodeCount: 10,
                episodeCount: 10,
                percentOfEpisodes: 100,
                sizeOnDisk: 0,
                previousAiring: undefined,
              },
            },
          ],
        }),
      ];
      getTvShowImpl = async () =>
        fakeTmdbShow(
          3170,
          [1, 2].map((seasonNumber) => ({
            id: seasonNumber,
            air_date: '2024-01-01',
            episode_count: 10,
            name: `Season ${seasonNumber}`,
            overview: '',
            season_number: seasonNumber,
          }))
        );

      await runWithMockTimers(() => sonarrScanner.run());

      assert.strictEqual(
        (
          await getRepository(MediaDestinationStatus).findOneByOrFail({
            id: destination.id,
          })
        ).status,
        MediaStatus.PARTIALLY_AVAILABLE
      );
      let persistedSeasons = await getRepository(
        MediaDestinationSeasonStatus
      ).find({
        where: { destinationStatusId: destination.id },
        order: { seasonNumber: 'ASC' },
      });
      assert.deepStrictEqual(
        persistedSeasons.map((season) => [season.seasonNumber, season.status]),
        [[1, MediaStatus.AVAILABLE]]
      );

      await getRepository(MediaDestinationSeasonStatus).save(
        new MediaDestinationSeasonStatus({
          destinationStatusId: destination.id,
          seasonNumber: 2,
          status: MediaStatus.PROCESSING,
        })
      );
      await runWithMockTimers(() => sonarrScanner.run());

      assert.strictEqual(
        (
          await getRepository(MediaDestinationStatus).findOneByOrFail({
            id: destination.id,
          })
        ).status,
        MediaStatus.PARTIALLY_AVAILABLE
      );
      persistedSeasons = await getRepository(MediaDestinationSeasonStatus).find(
        {
          where: { destinationStatusId: destination.id },
          order: { seasonNumber: 'ASC' },
        }
      );
      assert.deepStrictEqual(
        persistedSeasons.map((season) => [season.seasonNumber, season.status]),
        [
          [1, MediaStatus.AVAILABLE],
          [2, MediaStatus.PROCESSING],
        ]
      );
    });

    it('preserves unresolved request-driven PENDING state when an exact scan has no positive evidence', async () => {
      configureSonarr([
        {
          id: 30,
          hostname: 'sonarr-en',
          independentRequestDestination: true,
        },
      ]);
      const media = await getRepository(Media).save(
        new Media({
          tmdbId: 3175,
          tvdbId: 4175,
          mediaType: MediaType.TV,
        })
      );
      const request = await getRepository(MediaRequest).save(
        new MediaRequest({
          type: MediaType.TV,
          status: MediaRequestStatus.PENDING,
          media,
          requestedBy: await getRepository(User).findOneOrFail({
            where: { id: 1 },
          }),
          is4k: false,
          serverId: 30,
          seasons: [new SeasonRequest({ seasonNumber: 1 })],
        })
      );
      getSeriesImpl = async () => [fakeSonarrSeries({ tvdbId: 9999 })];
      getLibrarySeriesByTvdbIdImpl = async () => [];

      await runWithMockTimers(() => sonarrScanner.run());

      const destination = await getRepository(
        MediaDestinationStatus
      ).findOneOrFail({
        where: { mediaId: media.id, serverId: 30 },
      });
      assert.strictEqual(destination.status, MediaStatus.PENDING);
      assert.strictEqual(
        (
          await getRepository(MediaDestinationSeasonStatus).findOneByOrFail({
            destinationStatusId: destination.id,
            seasonNumber: 1,
          })
        ).status,
        MediaStatus.PENDING
      );
      assert.strictEqual(
        (await getRepository(MediaRequest).findOneByOrFail({ id: request.id }))
          .status,
        MediaRequestStatus.PENDING
      );
    });

    it('declines a confirmed missing PROCESSING series and releases exact request-driven state', async () => {
      const media = await getRepository(Media).save(
        new Media({
          tmdbId: 3200,
          tvdbId: 4200,
          mediaType: MediaType.TV,
        })
      );
      const destination = await getRepository(MediaDestinationStatus).save(
        new MediaDestinationStatus({
          mediaId: media.id,
          serverId: 30,
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
      const requestRepository = getRepository(MediaRequest);
      const request = await requestRepository.save(
        new MediaRequest({
          type: MediaType.TV,
          status: MediaRequestStatus.PENDING,
          media,
          requestedBy: await getRepository(User).findOneOrFail({
            where: { id: 1 },
          }),
          is4k: false,
          serverId: 30,
          seasons: [new SeasonRequest({ seasonNumber: 1 })],
        })
      );
      await requestRepository
        .createQueryBuilder()
        .update(MediaRequest)
        .set({ status: MediaRequestStatus.APPROVED })
        .where('id = :id', { id: request.id })
        .callListeners(false)
        .execute();
      configureSonarr([
        {
          id: 30,
          hostname: 'sonarr-en',
          independentRequestDestination: true,
        },
      ]);
      getSeriesImpl = async () => [fakeSonarrSeries({ tvdbId: 9999 })];
      getLibrarySeriesByTvdbIdImpl = async () => [];

      await runWithMockTimers(() => sonarrScanner.run());

      assert.strictEqual(
        (await requestRepository.findOneOrFail({ where: { id: request.id } }))
          .status,
        MediaRequestStatus.DECLINED
      );
      assert.strictEqual(
        (
          await getRepository(MediaDestinationStatus).findOneByOrFail({
            id: destination.id,
          })
        ).status,
        MediaStatus.UNKNOWN
      );
      assert.strictEqual(
        (
          await getRepository(MediaDestinationSeasonStatus).findOneByOrFail({
            destinationStatusId: destination.id,
          })
        ).status,
        MediaStatus.UNKNOWN
      );
    });

    it('reconciles a stale PROCESSING parent to PENDING when another exact pending request remains', async () => {
      configureSonarr([
        {
          id: 30,
          hostname: 'sonarr-en',
          independentRequestDestination: true,
        },
      ]);
      const media = await getRepository(Media).save(
        new Media({
          tmdbId: 3250,
          tvdbId: 4250,
          mediaType: MediaType.TV,
        })
      );
      const requestRepository = getRepository(MediaRequest);
      const requestedBy = await getRepository(User).findOneByOrFail({ id: 1 });
      const approvedRequest = await requestRepository.save(
        new MediaRequest({
          type: MediaType.TV,
          status: MediaRequestStatus.PENDING,
          media,
          requestedBy,
          is4k: false,
          serverId: 30,
          seasons: [new SeasonRequest({ seasonNumber: 1 })],
        })
      );
      const pendingRequest = await requestRepository.save(
        new MediaRequest({
          type: MediaType.TV,
          status: MediaRequestStatus.PENDING,
          media,
          requestedBy,
          is4k: false,
          serverId: 30,
          seasons: [new SeasonRequest({ seasonNumber: 2 })],
        })
      );
      await requestRepository
        .createQueryBuilder()
        .update(MediaRequest)
        .set({ status: MediaRequestStatus.APPROVED })
        .where('id = :id', { id: approvedRequest.id })
        .callListeners(false)
        .execute();
      await getRepository(SeasonRequest)
        .createQueryBuilder()
        .update(SeasonRequest)
        .set({ status: MediaRequestStatus.APPROVED })
        .where('requestId = :requestId', { requestId: approvedRequest.id })
        .callListeners(false)
        .execute();
      const destination = await getRepository(
        MediaDestinationStatus
      ).findOneOrFail({
        where: { mediaId: media.id, serverId: 30 },
      });
      destination.status = MediaStatus.PROCESSING;
      await getRepository(MediaDestinationStatus).save(destination);
      const seasonStatuses = await getRepository(
        MediaDestinationSeasonStatus
      ).find({ where: { destinationStatusId: destination.id } });
      seasonStatuses.find((season) => season.seasonNumber === 1)!.status =
        MediaStatus.PROCESSING;
      await getRepository(MediaDestinationSeasonStatus).save(seasonStatuses);
      getSeriesImpl = async () => [fakeSonarrSeries({ tvdbId: 9999 })];
      getLibrarySeriesByTvdbIdImpl = async () => [];

      await runWithMockTimers(() => sonarrScanner.run());

      assert.strictEqual(
        (await requestRepository.findOneByOrFail({ id: approvedRequest.id }))
          .status,
        MediaRequestStatus.DECLINED
      );
      assert.strictEqual(
        (await requestRepository.findOneByOrFail({ id: pendingRequest.id }))
          .status,
        MediaRequestStatus.PENDING
      );
      assert.strictEqual(
        (
          await getRepository(MediaDestinationStatus).findOneByOrFail({
            id: destination.id,
          })
        ).status,
        MediaStatus.PENDING
      );
      assert.ok(
        (
          await getRepository(MediaDestinationSeasonStatus).find({
            where: { destinationStatusId: destination.id },
          })
        ).every((season) => season.status !== MediaStatus.PROCESSING)
      );
    });

    it('marks confirmed missing available series deleted while keeping completed history', async () => {
      const media = await getRepository(Media).save(
        new Media({
          tmdbId: 3300,
          tvdbId: 4300,
          mediaType: MediaType.TV,
        })
      );
      const destination = await getRepository(MediaDestinationStatus).save(
        new MediaDestinationStatus({
          mediaId: media.id,
          serverId: 30,
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
      const request = await getRepository(MediaRequest).save(
        new MediaRequest({
          type: MediaType.TV,
          status: MediaRequestStatus.COMPLETED,
          media,
          requestedBy: await getRepository(User).findOneOrFail({
            where: { id: 1 },
          }),
          is4k: false,
          serverId: 30,
          seasons: [
            new SeasonRequest({
              seasonNumber: 1,
              status: MediaRequestStatus.COMPLETED,
            }),
          ],
        })
      );
      configureSonarr([
        {
          id: 30,
          hostname: 'sonarr-en',
          independentRequestDestination: true,
        },
      ]);
      getSeriesImpl = async () => [fakeSonarrSeries({ tvdbId: 9999 })];
      getLibrarySeriesByTvdbIdImpl = async () => [];

      await runWithMockTimers(() => sonarrScanner.run());

      assert.strictEqual(
        (
          await getRepository(MediaDestinationStatus).findOneByOrFail({
            id: destination.id,
          })
        ).status,
        MediaStatus.DELETED
      );
      assert.strictEqual(
        (
          await getRepository(MediaDestinationSeasonStatus).findOneByOrFail({
            destinationStatusId: destination.id,
          })
        ).status,
        MediaStatus.DELETED
      );
      assert.strictEqual(
        (await getRepository(MediaRequest).findOneByOrFail({ id: request.id }))
          .status,
        MediaRequestStatus.COMPLETED
      );
    });

    it('does not clean up an omitted series after exact presence, errors, or an empty inventory', async () => {
      const media = await getRepository(Media).save(
        new Media({
          tmdbId: 3400,
          tvdbId: 4400,
          mediaType: MediaType.TV,
        })
      );
      const destination = await getRepository(MediaDestinationStatus).save(
        new MediaDestinationStatus({
          mediaId: media.id,
          serverId: 30,
          status: MediaStatus.AVAILABLE,
        })
      );
      configureSonarr([
        {
          id: 30,
          hostname: 'sonarr-en',
          independentRequestDestination: true,
        },
      ]);
      getSeriesImpl = async () => [fakeSonarrSeries({ tvdbId: 9999 })];
      getLibrarySeriesByTvdbIdImpl = async (tvdbId) => [
        fakeSonarrSeries({ tvdbId }),
      ];
      await runWithMockTimers(() => sonarrScanner.run());
      assert.strictEqual(
        (
          await getRepository(MediaDestinationStatus).findOneByOrFail({
            id: destination.id,
          })
        ).status,
        MediaStatus.AVAILABLE
      );

      getLibrarySeriesByTvdbIdImpl = async () => {
        throw new Error('unreachable');
      };
      await runWithMockTimers(() => sonarrScanner.run());
      assert.strictEqual(
        (
          await getRepository(MediaDestinationStatus).findOneByOrFail({
            id: destination.id,
          })
        ).status,
        MediaStatus.AVAILABLE
      );

      getSeriesImpl = async () => [];
      getLibrarySeriesByTvdbIdImpl = async () => [];
      await runWithMockTimers(() => sonarrScanner.run());
      assert.strictEqual(
        (
          await getRepository(MediaDestinationStatus).findOneByOrFail({
            id: destination.id,
          })
        ).status,
        MediaStatus.AVAILABLE
      );
    });

    it('keeps native and independent show presence bookkeeping isolated in one run', async () => {
      const nativeOrphan = await getRepository(Media).save(
        new Media({
          tmdbId: 3500,
          tvdbId: 4500,
          mediaType: MediaType.TV,
          status: MediaStatus.PROCESSING,
          seasons: [
            new Season({
              seasonNumber: 1,
              status: MediaStatus.PROCESSING,
              status4k: MediaStatus.UNKNOWN,
            }),
          ],
        })
      );
      const independentMedia = await getRepository(Media).save(
        new Media({
          tmdbId: 3501,
          tvdbId: 4501,
          mediaType: MediaType.TV,
        })
      );
      const independentDestination = await getRepository(
        MediaDestinationStatus
      ).save(
        new MediaDestinationStatus({
          mediaId: independentMedia.id,
          serverId: 30,
          status: MediaStatus.AVAILABLE,
        })
      );
      configureSonarr([
        { id: 29, hostname: 'sonarr-native' },
        {
          id: 30,
          hostname: 'sonarr-independent',
          independentRequestDestination: true,
        },
      ]);
      const inventories = [
        [fakeSonarrSeries({ tvdbId: 4501 })],
        [fakeSonarrSeries({ tvdbId: 4500 })],
      ];
      getSeriesImpl = async () => inventories.shift() ?? [];
      getLibrarySeriesByTvdbIdImpl = async (tvdbId) =>
        tvdbId === 4501 ? [fakeSonarrSeries({ tvdbId })] : [];
      getTvShowImpl = async ({ tvId }) => fakeTmdbShow(tvId);

      await runWithMockTimers(() => sonarrScanner.run());

      assert.strictEqual(
        (await getRepository(Media).findOneByOrFail({ id: nativeOrphan.id }))
          .status,
        MediaStatus.UNKNOWN
      );
      assert.strictEqual(
        (
          await getRepository(MediaDestinationStatus).findOneByOrFail({
            id: independentDestination.id,
          })
        ).status,
        MediaStatus.AVAILABLE
      );
    });

    it('skips a legacy ambiguous native and independent physical instance', async () => {
      const media = await getRepository(Media).save(
        new Media({
          tmdbId: 3600,
          tvdbId: 4600,
          mediaType: MediaType.TV,
          status: MediaStatus.PROCESSING,
        })
      );
      const destination = await getRepository(MediaDestinationStatus).save(
        new MediaDestinationStatus({
          mediaId: media.id,
          serverId: 30,
          status: MediaStatus.PROCESSING,
        })
      );
      configureSonarr([
        { id: 29, hostname: ' Ambiguous-Sonarr ', baseUrl: '/sonarr/' },
        {
          id: 30,
          hostname: 'ambiguous-sonarr',
          baseUrl: 'sonarr',
          independentRequestDestination: true,
        },
      ]);
      let inventoryCalls = 0;
      getSeriesImpl = async () => {
        inventoryCalls++;
        return [fakeSonarrSeries({ tvdbId: 9999 })];
      };
      getLibrarySeriesByTvdbIdImpl = async () => [];

      await runWithMockTimers(() => sonarrScanner.run());

      assert.strictEqual(
        (await getRepository(Media).findOneByOrFail({ id: media.id })).status,
        MediaStatus.PROCESSING
      );
      assert.strictEqual(
        (
          await getRepository(MediaDestinationStatus).findOneByOrFail({
            id: destination.id,
          })
        ).status,
        MediaStatus.PROCESSING
      );
      assert.strictEqual(inventoryCalls, 0);
    });
  });
});
