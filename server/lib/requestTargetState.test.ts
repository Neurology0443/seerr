import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';

import {
  MediaRequestStatus,
  MediaStatus,
  MediaType,
} from '@server/constants/media';
import { getRepository } from '@server/datasource';
import Media from '@server/entity/Media';
import { MediaDestinationStatus } from '@server/entity/MediaDestinationStatus';
import { MediaRequest } from '@server/entity/MediaRequest';
import SeasonRequest from '@server/entity/SeasonRequest';
import { User } from '@server/entity/User';
import downloadTracker, {
  type DownloadingItem,
} from '@server/lib/downloadtracker';
import {
  classifyActiveRequestTargets,
  getConfiguredRequestTargetState,
  getRequestTargetState,
  serializeMediaRequest,
} from '@server/lib/requestTargetState';
import type { RadarrSettings, SonarrSettings } from '@server/lib/settings';
import { getSettings } from '@server/lib/settings';
import { setupTestDb } from '@server/test/db';

setupTestDb();

beforeEach(() => {
  getSettings().radarr = [];
  getSettings().sonarr = [];
});

const radarr = (
  id: number,
  overrides: Partial<RadarrSettings> = {}
): RadarrSettings =>
  ({
    id,
    name: `Radarr ${id}`,
    hostname: 'localhost',
    port: 7878,
    apiKey: 'test',
    useSsl: false,
    activeProfileId: 1,
    activeDirectory: '/movies',
    is4k: false,
    minimumAvailability: 'released',
    isDefault: false,
    syncEnabled: true,
    independentRequestDestination: false,
    preventSearch: false,
    tagRequests: false,
    tags: [],
    ...overrides,
  }) as RadarrSettings;

const sonarr = (
  id: number,
  overrides: Partial<SonarrSettings> = {}
): SonarrSettings =>
  ({
    id,
    name: `Sonarr ${id}`,
    hostname: 'localhost',
    port: 8989,
    apiKey: 'test',
    useSsl: false,
    activeProfileId: 1,
    activeDirectory: '/tv',
    is4k: false,
    isDefault: false,
    syncEnabled: true,
    independentRequestDestination: false,
    preventSearch: false,
    tagRequests: false,
    enableSeasonFolders: true,
    seriesType: 'standard',
    animeSeriesType: 'anime',
    monitorNewItems: 'all',
    tags: [],
    animeTags: [],
    ...overrides,
  }) as SonarrSettings;

async function seedRequest({
  type = MediaType.MOVIE,
  serverId = 1,
  is4k = false,
  status = MediaStatus.PROCESSING,
  status4k = MediaStatus.AVAILABLE,
}: {
  type?: MediaType;
  serverId?: number | null;
  is4k?: boolean;
  status?: MediaStatus;
  status4k?: MediaStatus;
} = {}) {
  const media = await getRepository(Media).save(
    new Media({
      mediaType: type,
      tmdbId: type === MediaType.MOVIE ? 41001 : 42001,
      status,
      status4k,
    })
  );
  const requestedBy = await getRepository(User).findOneByOrFail({ id: 1 });
  const request = await getRepository(MediaRequest).save(
    new MediaRequest({
      type,
      status: MediaRequestStatus.COMPLETED,
      media,
      requestedBy,
      serverId: serverId as number,
      is4k,
    })
  );

  return { media, request };
}

describe('getRequestTargetState', () => {
  it('refreshes persisted native status instead of using the request snapshot', async () => {
    getSettings().radarr = [radarr(1)];
    const seeded = await seedRequest({
      serverId: 1,
      status: MediaStatus.PENDING,
    });
    await getRepository(Media).update(
      { id: seeded.media.id },
      { status: MediaStatus.PROCESSING }
    );

    assert.strictEqual(seeded.request.media.status, MediaStatus.PENDING);
    assert.strictEqual(
      (
        await getRequestTargetState(
          seeded.request,
          getRepository(MediaRequest).manager
        )
      )?.status,
      MediaStatus.PROCESSING
    );
  });

  it('reads native Standard and 4K status from their native fields', async () => {
    getSettings().radarr = [radarr(1), radarr(2, { is4k: true })];
    const standard = await seedRequest({ serverId: 1 });
    const fourK = await seedRequest({ serverId: 2, is4k: true });

    assert.strictEqual(
      (
        await getRequestTargetState(
          standard.request,
          getRepository(MediaRequest).manager
        )
      )?.status,
      MediaStatus.PROCESSING
    );
    assert.strictEqual(
      (
        await getRequestTargetState(
          fourK.request,
          getRepository(MediaRequest).manager
        )
      )?.status,
      MediaStatus.AVAILABLE
    );
  });

  it('uses only exact independent destination state and treats a missing row as UNKNOWN', async () => {
    getSettings().radarr = [
      radarr(11, { independentRequestDestination: true }),
      radarr(12, { independentRequestDestination: true }),
    ];
    const exact = await seedRequest({
      serverId: 11,
      status: MediaStatus.AVAILABLE,
    });
    const missing = await seedRequest({
      serverId: 12,
      status: MediaStatus.AVAILABLE,
    });
    await getRepository(MediaDestinationStatus).save(
      new MediaDestinationStatus({
        mediaId: exact.media.id,
        serverId: 11,
        status: MediaStatus.DELETED,
      })
    );

    const exactTarget = await getRequestTargetState(
      exact.request,
      getRepository(MediaRequest).manager
    );
    const missingTarget = await getRequestTargetState(
      missing.request,
      getRepository(MediaRequest).manager
    );

    assert.strictEqual(exactTarget?.isIndependent, true);
    assert.strictEqual(exactTarget?.status, MediaStatus.DELETED);
    assert.strictEqual(missingTarget?.isIndependent, true);
    assert.strictEqual(missingTarget?.status, MediaStatus.UNKNOWN);
    assert.deepEqual(missingTarget?.downloadStatus, []);
    assert.equal(missingTarget?.serviceUrl, undefined);
  });

  it('classifies deleted servers only through the historical destination row', async () => {
    const independent = await seedRequest({ serverId: 21 });
    const native = await seedRequest({ serverId: 22 });
    await getRepository(MediaDestinationStatus).save(
      new MediaDestinationStatus({
        mediaId: independent.media.id,
        serverId: 21,
        status: MediaStatus.AVAILABLE,
      })
    );

    const independentTarget = await getRequestTargetState(
      independent.request,
      getRepository(MediaRequest).manager
    );
    const nativeTarget = await getRequestTargetState(
      native.request,
      getRepository(MediaRequest).manager
    );

    assert.deepStrictEqual(independentTarget, {
      serverId: 21,
      name: 'Deleted Radarr server (#21)',
      downloadStatus: [],
      is4k: false,
      isIndependent: true,
      deleted: true,
      status: MediaStatus.AVAILABLE,
    });
    assert.strictEqual(nativeTarget?.isIndependent, false);
    assert.strictEqual(nativeTarget?.status, MediaStatus.PROCESSING);
  });

  it('returns null for legacy requests and exact placeholders for deleted TV targets', async () => {
    getSettings().sonarr = [sonarr(99, { isDefault: true })];
    const legacy = await seedRequest({ serverId: null });
    const deleted = await seedRequest({
      type: MediaType.TV,
      serverId: 44,
    });

    assert.strictEqual(
      await getRequestTargetState(
        legacy.request,
        getRepository(MediaRequest).manager
      ),
      null
    );
    assert.strictEqual(
      (
        await getRequestTargetState(
          deleted.request,
          getRepository(MediaRequest).manager
        )
      )?.name,
      'Deleted Sonarr server (#44)'
    );
  });

  it('reflects a configured server rename without retargeting to the default', async () => {
    getSettings().radarr = [
      radarr(51, { name: 'Renamed', isDefault: false }),
      radarr(52, { name: 'Current default', isDefault: true }),
    ];
    const seeded = await seedRequest({ serverId: 51 });

    const target = await getRequestTargetState(
      seeded.request,
      getRepository(MediaRequest).manager
    );

    assert.strictEqual(target?.serverId, 51);
    assert.strictEqual(target?.name, 'Renamed');
  });
});

describe('configured request target state', () => {
  const media = new Media({
    id: 9001,
    mediaType: MediaType.TV,
    status: MediaStatus.UNKNOWN,
    status4k: MediaStatus.UNKNOWN,
  });
  const request = ({
    serverId,
    is4k = false,
    status = MediaRequestStatus.PENDING,
    seasons = [],
  }: {
    serverId: number;
    is4k?: boolean;
    status?: MediaRequestStatus;
    seasons?: number[];
  }) =>
    new MediaRequest({
      type: MediaType.TV,
      serverId,
      is4k,
      status,
      media,
      seasons: seasons.map(
        (seasonNumber) => new SeasonRequest({ seasonNumber })
      ),
    });

  it('classifies only active requests as slot owners', async () => {
    getSettings().sonarr = [
      sonarr(61),
      sonarr(62, { independentRequestDestination: true }),
    ];
    const classified = await classifyActiveRequestTargets(
      [
        request({ serverId: 61, status: MediaRequestStatus.PENDING }),
        request({ serverId: 62, status: MediaRequestStatus.APPROVED }),
        request({ serverId: 61, status: MediaRequestStatus.COMPLETED }),
        request({ serverId: 61, status: MediaRequestStatus.DECLINED }),
        request({ serverId: 62, status: MediaRequestStatus.FAILED }),
      ],
      getRepository(MediaRequest).manager
    );

    assert.strictEqual(classified.length, 2);
    assert.deepStrictEqual(
      classified.map(({ isIndependent }) => isIndependent),
      [false, true]
    );
  });

  it('isolates independent and native slots and includes the TV season', async () => {
    const native = sonarr(71);
    const nativePeer = sonarr(72);
    const french = sonarr(73, { independentRequestDestination: true });
    const english = sonarr(74, { independentRequestDestination: true });
    getSettings().sonarr = [native, nativePeer, french, english];
    const activeRequests = await classifyActiveRequestTargets(
      [
        request({ serverId: 71, seasons: [1] }),
        request({ serverId: 73, seasons: [2] }),
      ],
      getRepository(MediaRequest).manager
    );
    const state = (server: SonarrSettings, seasonNumber: number) =>
      getConfiguredRequestTargetState({
        server,
        nativeStatus: MediaStatus.UNKNOWN,
        destinationStatus: MediaStatus.UNKNOWN,
        activeRequests,
        seasonNumber,
      });

    assert.strictEqual(state(native, 1).requestable, false);
    assert.strictEqual(state(nativePeer, 1).requestable, false);
    assert.strictEqual(state(native, 2).requestable, true);
    assert.strictEqual(state(french, 2).requestable, false);
    assert.strictEqual(state(french, 1).requestable, true);
    assert.strictEqual(state(english, 2).requestable, true);
  });

  it('combines persisted status requestability with slot occupation', () => {
    const server = radarr(81, { independentRequestDestination: true });
    const state = (status: MediaStatus) =>
      getConfiguredRequestTargetState({
        server,
        destinationStatus: status,
      }).requestable;

    assert.strictEqual(state(MediaStatus.UNKNOWN), true);
    assert.strictEqual(state(MediaStatus.DELETED), true);
    assert.strictEqual(state(MediaStatus.PENDING), false);
    assert.strictEqual(state(MediaStatus.AVAILABLE), false);
    assert.strictEqual(state(MediaStatus.PROCESSING), false);
    assert.strictEqual(state(MediaStatus.PARTIALLY_AVAILABLE), false);
  });
});

const downloading = (
  downloadId: string,
  type = MediaType.MOVIE,
  seasonNumber?: number
): DownloadingItem => ({
  downloadId,
  mediaType: type,
  externalId: 100,
  size: 1000,
  sizeLeft: 500,
  status: 'downloading',
  timeLeft: '00:05:00',
  title: downloadId,
  estimatedCompletionTime: new Date('2026-01-01'),
  ...(seasonNumber === undefined
    ? {}
    : {
        episode: {
          id: 1,
          seasonNumber,
          episodeNumber: 1,
          absoluteEpisodeNumber: 1,
        },
      }),
});

describe('independent request serialization', () => {
  for (const type of [MediaType.MOVIE, MediaType.TV]) {
    it(`normalizes ${type} external URLs while preserving proxy paths`, async () => {
      const server =
        type === MediaType.MOVIE
          ? radarr(1, { independentRequestDestination: true, baseUrl: '/arr' })
          : sonarr(1, { independentRequestDestination: true, baseUrl: '/arr' });
      if (type === MediaType.MOVIE)
        getSettings().radarr = [server as RadarrSettings];
      else getSettings().sonarr = [server as SonarrSettings];
      const { media, request } = await seedRequest({ type });
      await getRepository(MediaDestinationStatus).save(
        new MediaDestinationStatus({
          mediaId: media.id,
          serverId: 1,
          status: MediaStatus.PROCESSING,
          externalServiceSlug: 'exact-slug',
        })
      );
      const path = type === MediaType.MOVIE ? 'movie' : 'series';
      for (const [externalUrl, base] of [
        ['https://example.com', 'https://example.com'],
        ['https://example.com/', 'https://example.com'],
        ['https://example.com/arr', 'https://example.com/arr'],
        ['https://example.com/arr/', 'https://example.com/arr'],
        ['', `http://localhost:${type === MediaType.MOVIE ? 7878 : 8989}/arr`],
      ]) {
        server.externalUrl = externalUrl;
        assert.equal(
          (
            await getRequestTargetState(
              request,
              getRepository(MediaRequest).manager
            )
          )?.serviceUrl,
          `${base}/${path}/exact-slug`
        );
      }
    });
  }

  it('loads persisted TV seasons and exposes no progress when none can be established', async (t) => {
    getSettings().sonarr = [sonarr(2, { independentRequestDestination: true })];
    const { media, request } = await seedRequest({
      type: MediaType.TV,
      serverId: 2,
    });
    await getRepository(MediaDestinationStatus).save(
      new MediaDestinationStatus({
        mediaId: media.id,
        serverId: 2,
        status: MediaStatus.PROCESSING,
        externalServiceId: 100,
      })
    );
    const queue = [1, 2].map((season) =>
      downloading(`en-s${season}`, MediaType.TV, season)
    );
    const progress = t.mock.method(
      downloadTracker,
      'getSeriesProgress',
      (serverId: number, externalId: number) => {
        assert.equal(serverId, 2);
        assert.equal(externalId, 100);
        return queue;
      }
    );
    const manager = getRepository(MediaRequest).manager;
    for (const seasons of [undefined, []]) {
      assert.deepEqual(
        (await getRequestTargetState({ ...request, seasons }, manager))
          ?.downloadStatus,
        []
      );
    }
    await getRepository(SeasonRequest).save(
      new SeasonRequest({
        request,
        seasonNumber: 1,
        status: MediaRequestStatus.COMPLETED,
      })
    );
    for (const seasons of [undefined, []]) {
      assert.deepEqual(
        (await getRequestTargetState({ ...request, seasons }, manager))
          ?.downloadStatus,
        [queue[0]]
      );
    }
    assert.deepEqual(
      (
        await getRequestTargetState(
          { ...request, id: undefined, seasons: undefined },
          manager
        )
      )?.downloadStatus,
      []
    );
    assert.equal(progress.mock.callCount(), 5);
    assert.equal(
      (
        await getRepository(MediaDestinationStatus).findOneByOrFail({
          mediaId: media.id,
          serverId: 2,
        })
      ).status,
      MediaStatus.PROCESSING
    );
  });

  it('isolates movie status, queue and links on the same media and reflects renames', async (t) => {
    getSettings().radarr = [
      radarr(1, {
        name: 'FR',
        independentRequestDestination: true,
        externalUrl: 'https://fr.example/arr/',
      }),
      radarr(2, {
        name: 'EN',
        independentRequestDestination: true,
        hostname: 'en.example',
        baseUrl: '/radarr',
        isDefault: true,
      }),
    ];
    const { media, request: french } = await seedRequest();
    const english = new MediaRequest({ ...french, serverId: 2 });
    media.serviceUrl = 'https://native.example/movie/native';
    media.downloadStatus = [downloading('native')];
    await getRepository(MediaDestinationStatus).save(
      [1, 2].map(
        (serverId) =>
          new MediaDestinationStatus({
            mediaId: media.id,
            serverId,
            externalServiceId: 100,
            externalServiceSlug: serverId === 1 ? 'fr-slug' : 'en-slug',
            status:
              serverId === 1 ? MediaStatus.AVAILABLE : MediaStatus.PROCESSING,
          })
      )
    );
    const progress = t.mock.method(
      downloadTracker,
      'getMovieProgress',
      (serverId: number, externalId: number) => {
        assert.equal(externalId, 100);
        return [downloading(serverId === 1 ? 'fr' : 'en')];
      }
    );
    const manager = getRepository(MediaRequest).manager;
    const fr = (await serializeMediaRequest(french, manager)).target!;
    const en = (await serializeMediaRequest(english, manager)).target!;
    assert.equal(fr.status, MediaStatus.AVAILABLE);
    assert.equal(en.status, MediaStatus.PROCESSING);
    assert.deepEqual(fr.downloadStatus, [downloading('fr')]);
    assert.deepEqual(en.downloadStatus, [downloading('en')]);
    assert.equal(fr.serviceUrl, 'https://fr.example/arr/movie/fr-slug');
    assert.equal(en.serviceUrl, 'http://en.example:7878/radarr/movie/en-slug');
    assert.deepEqual(
      progress.mock.calls.map((call) => call.arguments),
      [
        [1, 100],
        [2, 100],
      ]
    );
    getSettings().radarr[0].name = 'Français';
    assert.equal(
      (await getRequestTargetState(french, manager))?.name,
      'Français'
    );
    assert.equal(french.serverId, 1);
    await getRepository(MediaDestinationStatus).update(
      { mediaId: media.id, serverId: 1 },
      { externalServiceId: null, externalServiceSlug: null }
    );
    const unlinked = await getRequestTargetState(french, manager);
    assert.deepEqual(unlinked?.downloadStatus, []);
    assert.equal(unlinked?.serviceUrl, undefined);
    assert.equal(unlinked?.status, MediaStatus.AVAILABLE);
    assert.equal(
      (await getRepository(Media).findOneByOrFail({ id: media.id })).status,
      media.status
    );
  });

  it('filters TV progress by requested seasons on the exact Sonarr server', async (t) => {
    getSettings().sonarr = [
      sonarr(1, {
        name: 'FR',
        independentRequestDestination: true,
        externalUrl: 'https://fr.example/sonarr/',
      }),
      sonarr(2, {
        name: 'EN',
        independentRequestDestination: true,
        externalUrl: 'https://en.example',
      }),
    ];
    const { media, request } = await seedRequest({
      type: MediaType.TV,
      serverId: 2,
    });
    request.seasons = [1, 3].map(
      (seasonNumber) => new SeasonRequest({ seasonNumber })
    );
    await getRepository(MediaDestinationStatus).save(
      new MediaDestinationStatus({
        mediaId: media.id,
        serverId: 2,
        status: MediaStatus.PROCESSING,
        externalServiceId: 100,
        externalServiceSlug: 'show',
      })
    );
    await getRepository(MediaDestinationStatus).save(
      new MediaDestinationStatus({
        mediaId: media.id,
        serverId: 1,
        status: MediaStatus.AVAILABLE,
        externalServiceId: 100,
        externalServiceSlug: 'french-show',
      })
    );
    const queue = [1, 2, 3].map((season) =>
      downloading(`en-s${season}`, MediaType.TV, season)
    );
    const progress = t.mock.method(
      downloadTracker,
      'getSeriesProgress',
      (serverId: number, externalId: number) => {
        assert.equal(externalId, 100);
        return serverId === 2
          ? [...queue, downloading('no-episode', MediaType.TV)]
          : [downloading('fr', MediaType.TV, 1)];
      }
    );
    const manager = getRepository(MediaRequest).manager;
    const target = await getRequestTargetState(request, manager);
    assert.deepEqual(target?.downloadStatus, [queue[0], queue[2]]);
    assert.deepEqual(progress.mock.calls[0].arguments, [2, 100]);
    assert.equal(target?.serviceUrl, 'https://en.example/series/show');
    const french = await getRequestTargetState(
      { ...request, serverId: 1 },
      manager
    );
    assert.equal(
      french?.serviceUrl,
      'https://fr.example/sonarr/series/french-show'
    );
    assert.deepEqual(french?.downloadStatus, [
      downloading('fr', MediaType.TV, 1),
    ]);
    assert.equal(french?.status, MediaStatus.AVAILABLE);
    getSettings().sonarr[1].externalUrl = '';
    assert.equal(
      (await getRequestTargetState(request, manager))?.serviceUrl,
      'http://localhost:8989/series/show'
    );
    progress.mock.mockImplementation(() => []);
    assert.deepEqual(
      (await getRequestTargetState(request, manager))?.downloadStatus,
      []
    );
    assert.equal(
      (await getRequestTargetState(request, manager))?.status,
      MediaStatus.PROCESSING
    );
    getSettings().sonarr = [getSettings().sonarr[0]];
    progress.mock.resetCalls();
    const deleted = await getRequestTargetState(request, manager);
    assert.equal(deleted?.name, 'Deleted Sonarr server (#2)');
    assert.equal(deleted?.status, MediaStatus.PROCESSING);
    assert.deepEqual(deleted?.downloadStatus, []);
    assert.equal(deleted?.serviceUrl, undefined);
    assert.equal(progress.mock.callCount(), 0);
  });

  it('keeps native linkage on Media and leaves it out of target', async (t) => {
    getSettings().radarr = [radarr(1)];
    const { request } = await seedRequest();
    request.media.serviceUrl = 'https://native';
    request.media.downloadStatus = [downloading('native')];
    const progress = t.mock.method(
      downloadTracker,
      'getMovieProgress',
      () => []
    );
    const serialized = await serializeMediaRequest(
      request,
      getRepository(MediaRequest).manager
    );
    assert.equal(serialized.media.serviceUrl, 'https://native');
    assert.deepEqual(serialized.media.downloadStatus, [downloading('native')]);
    assert.equal(serialized.target?.serviceUrl, undefined);
    assert.equal(serialized.target?.downloadStatus, undefined);
    assert.equal(progress.mock.callCount(), 0);
  });
});
