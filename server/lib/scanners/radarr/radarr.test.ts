import type { RadarrMovie } from '@server/api/servarr/radarr';
import RadarrAPI from '@server/api/servarr/radarr';
import {
  MediaRequestStatus,
  MediaStatus,
  MediaType,
} from '@server/constants/media';
import { getRepository } from '@server/datasource';
import Media from '@server/entity/Media';
import { MediaDestinationStatus } from '@server/entity/MediaDestinationStatus';
import MediaRequest from '@server/entity/MediaRequest';
import { User } from '@server/entity/User';
import { radarrScanner } from '@server/lib/scanners/radarr';
import type { RadarrSettings } from '@server/lib/settings';
import { getSettings } from '@server/lib/settings';
import { setupTestDb } from '@server/test/db';
import { runWithMockTimers } from '@server/test/runWithMockTimers';
import assert from 'node:assert/strict';
import { beforeEach, describe, it, mock } from 'node:test';

let getMoviesImpl: () => Promise<RadarrMovie[]> = async () => [];
Object.defineProperty(RadarrAPI.prototype, 'getMovies', {
  set() {},
  get() {
    return async () => getMoviesImpl();
  },
  configurable: true,
});

let getLibraryMoviesByTmdbIdImpl: (
  tmdbId: number
) => Promise<RadarrMovie[]> = async () => [];
Object.defineProperty(RadarrAPI.prototype, 'getLibraryMoviesByTmdbId', {
  set() {},
  get() {
    return async (tmdbId: number) => getLibraryMoviesByTmdbIdImpl(tmdbId);
  },
  configurable: true,
});

mock.method(MediaRequest, 'sendNotification', async () => undefined);

setupTestDb();

function configureRadarr(overrides: Partial<RadarrSettings>[] = [{}]): void {
  const settings = getSettings();
  settings.radarr = overrides.map((o, i) => ({
    id: i,
    name: `Radarr ${i}`,
    hostname: 'localhost',
    port: 7878,
    apiKey: 'test-key',
    baseUrl: '',
    useSsl: false,
    activeProfileId: 1,
    activeDirectory: '/movies',
    is4k: false,
    minimumAvailability: 'released',
    tags: [],
    isDefault: i === 0,
    syncEnabled: true,
    preventSearch: false,
    externalUrl: '',
    ...o,
  })) as RadarrSettings[];
  settings.sonarr = [];
}

function fakeRadarrMovie(overrides: Partial<RadarrMovie> = {}): RadarrMovie {
  return {
    tmdbId: 550,
    id: 1,
    title: 'Test Movie',
    titleSlug: 'test-movie',
    monitored: true,
    hasFile: true,
    isAvailable: true,
    imdbId: 'tt0137523',
    folderName: '/movies/Test Movie (2024)',
    path: '/movies/Test Movie (2024)',
    profileId: 1,
    qualityProfileId: 1,
    added: '2024-01-01T00:00:00Z',
    tags: [],
    ...overrides,
  };
}

describe('Radarr Scanner', () => {
  beforeEach(() => {
    getMoviesImpl = async () => [];
    getLibraryMoviesByTmdbIdImpl = async () => [];
  });

  describe('unmonitored movie handling', () => {
    it('resets PROCESSING to UNKNOWN when movie is unmonitored and has no file', async () => {
      const mediaRepository = getRepository(Media);

      const media = new Media();
      media.tmdbId = 550;
      media.mediaType = MediaType.MOVIE;
      media.status = MediaStatus.PROCESSING;
      await mediaRepository.save(media);

      configureRadarr([{ syncEnabled: true }]);
      getMoviesImpl = async () => [
        fakeRadarrMovie({ monitored: false, hasFile: false }),
      ];

      await runWithMockTimers(() => radarrScanner.run());

      const updated = await mediaRepository.findOneOrFail({
        where: { tmdbId: 550 },
      });
      assert.strictEqual(updated.status, MediaStatus.UNKNOWN);
    });

    it('does not create new media entry when movie is unmonitored and has no file', async () => {
      const mediaRepository = getRepository(Media);
      configureRadarr([{ syncEnabled: true }]);

      getMoviesImpl = async () => [
        fakeRadarrMovie({ tmdbId: 777, monitored: false, hasFile: false }),
      ];

      await runWithMockTimers(() => radarrScanner.run());

      const media = await mediaRepository.findOne({
        where: { tmdbId: 777 },
      });
      assert.strictEqual(media, null);
    });

    it('sets AVAILABLE when movie has a file', async () => {
      const mediaRepository = getRepository(Media);

      const media = new Media();
      media.tmdbId = 551;
      media.mediaType = MediaType.MOVIE;
      media.status = MediaStatus.PROCESSING;
      await mediaRepository.save(media);

      configureRadarr([{ syncEnabled: true }]);
      getMoviesImpl = async () => [
        fakeRadarrMovie({ tmdbId: 551, monitored: true, hasFile: true }),
      ];

      await runWithMockTimers(() => radarrScanner.run());

      const updated = await mediaRepository.findOneOrFail({
        where: { tmdbId: 551 },
      });
      assert.strictEqual(updated.status, MediaStatus.AVAILABLE);
    });

    it('sets PROCESSING when movie is monitored but has no file', async () => {
      const mediaRepository = getRepository(Media);

      const media = new Media();
      media.tmdbId = 552;
      media.mediaType = MediaType.MOVIE;
      media.status = MediaStatus.UNKNOWN;
      await mediaRepository.save(media);

      configureRadarr([{ syncEnabled: true }]);
      getMoviesImpl = async () => [
        fakeRadarrMovie({ tmdbId: 552, monitored: true, hasFile: false }),
      ];

      await runWithMockTimers(() => radarrScanner.run());

      const updated = await mediaRepository.findOneOrFail({
        where: { tmdbId: 552 },
      });
      assert.strictEqual(updated.status, MediaStatus.PROCESSING);
    });

    it('preserves DELETED status when movie is monitored but has no file', async () => {
      const mediaRepository = getRepository(Media);

      const media = new Media();
      media.tmdbId = 553;
      media.mediaType = MediaType.MOVIE;
      media.status = MediaStatus.DELETED;
      await mediaRepository.save(media);

      configureRadarr([{ syncEnabled: true }]);
      getMoviesImpl = async () => [
        fakeRadarrMovie({ tmdbId: 553, monitored: true, hasFile: false }),
      ];

      await runWithMockTimers(() => radarrScanner.run());

      const updated = await mediaRepository.findOneOrFail({
        where: { tmdbId: 553 },
      });
      assert.strictEqual(updated.status, MediaStatus.DELETED);
    });

    it('keeps AVAILABLE status even when movie is unmonitored', async () => {
      const mediaRepository = getRepository(Media);

      const media = new Media();
      media.tmdbId = 554;
      media.mediaType = MediaType.MOVIE;
      media.status = MediaStatus.AVAILABLE;
      await mediaRepository.save(media);

      configureRadarr([{ syncEnabled: true }]);
      getMoviesImpl = async () => [
        fakeRadarrMovie({ tmdbId: 554, monitored: false, hasFile: true }),
      ];

      await runWithMockTimers(() => radarrScanner.run());

      const updated = await mediaRepository.findOneOrFail({
        where: { tmdbId: 554 },
      });
      assert.strictEqual(updated.status, MediaStatus.AVAILABLE);
    });
  });

  describe('orphaned movie cleanup', () => {
    it('skips cleanup when a standard server has sync disabled', async () => {
      const mediaRepository = getRepository(Media);

      const media = new Media();
      media.tmdbId = 950;
      media.mediaType = MediaType.MOVIE;
      media.status = MediaStatus.PROCESSING;
      await mediaRepository.save(media);

      configureRadarr([
        { syncEnabled: true, id: 0, hostname: 'server-a' },
        { syncEnabled: false, id: 1, hostname: 'server-b' },
      ]);

      getMoviesImpl = async () => [];

      await runWithMockTimers(() => radarrScanner.run());

      const updated = await mediaRepository.findOneOrFail({
        where: { tmdbId: 950 },
      });
      assert.strictEqual(updated.status, MediaStatus.PROCESSING);
    });

    it('resets PROCESSING to UNKNOWN when movie is not in any Radarr server', async () => {
      const mediaRepository = getRepository(Media);

      const media = new Media();
      media.tmdbId = 999;
      media.mediaType = MediaType.MOVIE;
      media.status = MediaStatus.PROCESSING;
      await mediaRepository.save(media);

      configureRadarr([{ syncEnabled: true }]);
      getMoviesImpl = async () => [fakeRadarrMovie({ tmdbId: 1, id: 99 })];

      await runWithMockTimers(() => radarrScanner.run());

      const updated = await mediaRepository.findOneOrFail({
        where: { tmdbId: 999 },
      });
      assert.strictEqual(updated.status, MediaStatus.UNKNOWN);
    });

    it('does not reset AVAILABLE movie when missing from Radarr', async () => {
      const mediaRepository = getRepository(Media);

      const media = new Media();
      media.tmdbId = 888;
      media.mediaType = MediaType.MOVIE;
      media.status = MediaStatus.AVAILABLE;
      await mediaRepository.save(media);

      configureRadarr([{ syncEnabled: true }]);
      getMoviesImpl = async () => [];

      await runWithMockTimers(() => radarrScanner.run());

      const updated = await mediaRepository.findOneOrFail({
        where: { tmdbId: 888 },
      });
      assert.strictEqual(updated.status, MediaStatus.AVAILABLE);
    });

    it('does not reset PROCESSING movie that still exists in Radarr', async () => {
      const mediaRepository = getRepository(Media);

      const media = new Media();
      media.tmdbId = 700;
      media.mediaType = MediaType.MOVIE;
      media.status = MediaStatus.PROCESSING;
      await mediaRepository.save(media);

      configureRadarr([{ syncEnabled: true }]);
      getMoviesImpl = async () => [
        fakeRadarrMovie({ tmdbId: 700, monitored: true, hasFile: false }),
      ];

      await runWithMockTimers(() => radarrScanner.run());

      const updated = await mediaRepository.findOneOrFail({
        where: { tmdbId: 700 },
      });
      assert.strictEqual(updated.status, MediaStatus.PROCESSING);
    });

    it('does not reset TV media that is missing from Radarr', async () => {
      const mediaRepository = getRepository(Media);

      // TV show stuck in processing so Radarr scanner should not touch it
      const media = new Media();
      media.tmdbId = 800;
      media.mediaType = MediaType.TV;
      media.status = MediaStatus.PROCESSING;
      await mediaRepository.save(media);

      configureRadarr([{ syncEnabled: true }]);
      getMoviesImpl = async () => [];

      await runWithMockTimers(() => radarrScanner.run());

      const updated = await mediaRepository.findOneOrFail({
        where: { tmdbId: 800 },
      });
      assert.strictEqual(updated.status, MediaStatus.PROCESSING);
    });

    it('only resets orphaned movies not found across all servers', async () => {
      const mediaRepository = getRepository(Media);

      const orphan = new Media();
      orphan.tmdbId = 901;
      orphan.mediaType = MediaType.MOVIE;
      orphan.status = MediaStatus.PROCESSING;
      await mediaRepository.save(orphan);

      const existing = new Media();
      existing.tmdbId = 902;
      existing.mediaType = MediaType.MOVIE;
      existing.status = MediaStatus.PROCESSING;
      await mediaRepository.save(existing);

      // Two servers but movie exists on server 1 only
      configureRadarr([
        { syncEnabled: true, id: 0, hostname: 'server-a' },
        { syncEnabled: true, id: 1, hostname: 'server-b' },
      ]);

      let callCount = 0;
      getMoviesImpl = async () => {
        callCount++;
        if (callCount === 1) {
          return [fakeRadarrMovie({ tmdbId: 902, id: 10 })];
        }
        return [fakeRadarrMovie({ tmdbId: 903, id: 11 })];
      };

      await runWithMockTimers(() => radarrScanner.run());

      const updatedOrphan = await mediaRepository.findOneOrFail({
        where: { tmdbId: 901 },
      });
      assert.strictEqual(updatedOrphan.status, MediaStatus.UNKNOWN);

      const updatedExisting = await mediaRepository.findOneOrFail({
        where: { tmdbId: 902 },
      });
      assert.strictEqual(updatedExisting.status, MediaStatus.AVAILABLE);
    });

    it('does not reset a movie added to Radarr after the scan started', async () => {
      const mediaRepository = getRepository(Media);

      const media = new Media();
      media.tmdbId = 910;
      media.mediaType = MediaType.MOVIE;
      media.status = MediaStatus.PROCESSING;
      await mediaRepository.save(media);

      configureRadarr([{ syncEnabled: true }]);
      getMoviesImpl = async () => [fakeRadarrMovie({ tmdbId: 111 })];
      getLibraryMoviesByTmdbIdImpl = async (tmdbId) => [
        fakeRadarrMovie({ tmdbId }),
      ];

      await radarrScanner.run();

      const updated = await mediaRepository.findOneOrFail({
        where: { tmdbId: 910 },
      });
      assert.strictEqual(updated.status, MediaStatus.PROCESSING);
    });

    it('does not reset a movie when the server cannot be reached', async () => {
      const mediaRepository = getRepository(Media);

      const media = new Media();
      media.tmdbId = 911;
      media.mediaType = MediaType.MOVIE;
      media.status = MediaStatus.PROCESSING;
      await mediaRepository.save(media);

      configureRadarr([{ syncEnabled: true }]);
      getMoviesImpl = async () => [fakeRadarrMovie({ tmdbId: 111 })];
      getLibraryMoviesByTmdbIdImpl = async () => {
        throw new Error('connect ECONNREFUSED');
      };

      await radarrScanner.run();

      const updated = await mediaRepository.findOneOrFail({
        where: { tmdbId: 911 },
      });
      assert.strictEqual(updated.status, MediaStatus.PROCESSING);
    });

    it('resets a movie when the server returns no row matching its id', async () => {
      const mediaRepository = getRepository(Media);

      const media = new Media();
      media.tmdbId = 912;
      media.mediaType = MediaType.MOVIE;
      media.status = MediaStatus.PROCESSING;
      await mediaRepository.save(media);

      configureRadarr([{ syncEnabled: true }]);
      getMoviesImpl = async () => [fakeRadarrMovie({ tmdbId: 111 })];
      getLibraryMoviesByTmdbIdImpl = async () => [
        fakeRadarrMovie({ tmdbId: 111 }),
        fakeRadarrMovie({ tmdbId: 222 }),
      ];

      await radarrScanner.run();

      const updated = await mediaRepository.findOneOrFail({
        where: { tmdbId: 912 },
      });
      assert.strictEqual(updated.status, MediaStatus.UNKNOWN);
    });
  });

  describe('4k orphaned movie cleanup', () => {
    it('resets 4k PROCESSING to UNKNOWN when movie is not in any Radarr server', async () => {
      const mediaRepository = getRepository(Media);

      const media = new Media();
      media.tmdbId = 960;
      media.mediaType = MediaType.MOVIE;
      media.status = MediaStatus.UNKNOWN;
      media.status4k = MediaStatus.PROCESSING;
      await mediaRepository.save(media);

      configureRadarr([{ syncEnabled: true, is4k: true }]);
      getMoviesImpl = async () => [fakeRadarrMovie({ tmdbId: 1, id: 99 })];

      await runWithMockTimers(() => radarrScanner.run());

      const updated = await mediaRepository.findOneOrFail({
        where: { tmdbId: 960 },
      });
      assert.strictEqual(updated.status4k, MediaStatus.UNKNOWN);
    });

    it('does not reset 4k AVAILABLE when movie is missing from Radarr', async () => {
      const mediaRepository = getRepository(Media);

      const media = new Media();
      media.tmdbId = 961;
      media.mediaType = MediaType.MOVIE;
      media.status = MediaStatus.UNKNOWN;
      media.status4k = MediaStatus.AVAILABLE;
      await mediaRepository.save(media);

      configureRadarr([{ syncEnabled: true, is4k: true }]);
      getMoviesImpl = async () => [];

      await runWithMockTimers(() => radarrScanner.run());

      const updated = await mediaRepository.findOneOrFail({
        where: { tmdbId: 961 },
      });
      assert.strictEqual(updated.status4k, MediaStatus.AVAILABLE);
    });
  });

  describe('orphaned request handling', () => {
    it('declines the approved request and resets media to UNKNOWN when the movie is orphaned', async () => {
      const mediaRepository = getRepository(Media);
      const requestRepository = getRepository(MediaRequest);
      const userRepository = getRepository(User);

      const requestedBy = await userRepository.findOneOrFail({
        where: { id: 1 },
      });

      const media = await mediaRepository.save(
        new Media({
          tmdbId: 1003596,
          mediaType: MediaType.MOVIE,
          status: MediaStatus.PROCESSING,
        })
      );

      const settings = getSettings();
      settings.radarr = [];
      settings.sonarr = [];
      const request = await requestRepository.save(
        new MediaRequest({
          type: MediaType.MOVIE,
          status: MediaRequestStatus.APPROVED,
          media,
          requestedBy,
          is4k: false,
        })
      );

      configureRadarr([{ syncEnabled: true }]);
      getMoviesImpl = async () => [fakeRadarrMovie({ tmdbId: 1, id: 99 })];

      await runWithMockTimers(() => radarrScanner.run());

      const updatedMedia = await mediaRepository.findOneOrFail({
        where: { tmdbId: 1003596 },
      });
      const updatedRequest = await requestRepository.findOneOrFail({
        where: { id: request.id },
      });

      assert.strictEqual(updatedMedia.status, MediaStatus.UNKNOWN);
      assert.strictEqual(updatedRequest.status, MediaRequestStatus.DECLINED);
    });

    it('does not decline the request when the movie still exists in Radarr', async () => {
      const mediaRepository = getRepository(Media);
      const requestRepository = getRepository(MediaRequest);
      const userRepository = getRepository(User);

      const requestedBy = await userRepository.findOneOrFail({
        where: { id: 1 },
      });

      const media = await mediaRepository.save(
        new Media({
          tmdbId: 700,
          mediaType: MediaType.MOVIE,
          status: MediaStatus.PROCESSING,
        })
      );

      const settings = getSettings();
      settings.radarr = [];
      settings.sonarr = [];
      const request = await requestRepository.save(
        new MediaRequest({
          type: MediaType.MOVIE,
          status: MediaRequestStatus.APPROVED,
          media,
          requestedBy,
          is4k: false,
        })
      );

      configureRadarr([{ syncEnabled: true }]);
      getMoviesImpl = async () => [
        fakeRadarrMovie({ tmdbId: 700, monitored: true, hasFile: false }),
      ];

      await runWithMockTimers(() => radarrScanner.run());

      const updatedRequest = await requestRepository.findOneOrFail({
        where: { id: request.id },
      });
      assert.strictEqual(updatedRequest.status, MediaRequestStatus.APPROVED);
    });

    it('skips cleanup and leaves the request approved when Radarr returns an empty list', async () => {
      const mediaRepository = getRepository(Media);
      const requestRepository = getRepository(MediaRequest);
      const userRepository = getRepository(User);

      const requestedBy = await userRepository.findOneOrFail({
        where: { id: 1 },
      });

      const media = await mediaRepository.save(
        new Media({
          tmdbId: 1234,
          mediaType: MediaType.MOVIE,
          status: MediaStatus.PROCESSING,
        })
      );

      const settings = getSettings();
      settings.radarr = [];
      settings.sonarr = [];
      const request = await requestRepository.save(
        new MediaRequest({
          type: MediaType.MOVIE,
          status: MediaRequestStatus.APPROVED,
          media,
          requestedBy,
          is4k: false,
        })
      );

      configureRadarr([{ syncEnabled: true }]);
      getMoviesImpl = async () => [];

      await runWithMockTimers(() => radarrScanner.run());

      const updatedMedia = await mediaRepository.findOneOrFail({
        where: { tmdbId: 1234 },
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
      media.mediaType = MediaType.MOVIE;

      await assert.rejects(
        () =>
          (
            radarrScanner as unknown as {
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
          tmdbId: 1003598,
          mediaType: MediaType.MOVIE,
          status: MediaStatus.PROCESSING,
          status4k: MediaStatus.PROCESSING,
        })
      );

      const settings = getSettings();
      settings.radarr = [];
      settings.sonarr = [];
      const standardRequest = await requestRepository.save(
        new MediaRequest({
          type: MediaType.MOVIE,
          status: MediaRequestStatus.APPROVED,
          media,
          requestedBy,
          is4k: false,
        })
      );
      const fourKRequest = await requestRepository.save(
        new MediaRequest({
          type: MediaType.MOVIE,
          status: MediaRequestStatus.APPROVED,
          media,
          requestedBy,
          is4k: true,
        })
      );

      configureRadarr([
        { syncEnabled: true, id: 0, hostname: 'server-standard' },
        { syncEnabled: true, id: 1, hostname: 'server-4k', is4k: true },
      ]);

      let callCount = 0;
      getMoviesImpl = async () => {
        callCount++;
        if (callCount === 1) {
          // standard server still has the movie
          return [
            fakeRadarrMovie({
              tmdbId: 1003598,
              id: 42,
              monitored: true,
              hasFile: false,
            }),
          ];
        }
        // 4k server: populated but the movie is absent, so 4k dimension orphaned
        return [fakeRadarrMovie({ tmdbId: 2, id: 88 })];
      };

      await runWithMockTimers(() => radarrScanner.run());

      const updatedMedia = await mediaRepository.findOneOrFail({
        where: { tmdbId: 1003598 },
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
    it('creates only minimal native identity when an independent movie is first discovered', async () => {
      configureRadarr([
        {
          id: 10,
          hostname: 'radarr-fr',
          independentRequestDestination: true,
        },
      ]);
      getMoviesImpl = async () => [
        fakeRadarrMovie({
          tmdbId: 549,
          monitored: false,
          hasFile: false,
        }),
      ];

      await runWithMockTimers(() => radarrScanner.run());

      const media = await getRepository(Media).findOneOrFail({
        where: { tmdbId: 549, mediaType: MediaType.MOVIE },
      });
      const destination = await getRepository(
        MediaDestinationStatus
      ).findOneOrFail({
        where: { mediaId: media.id, serverId: 10 },
      });
      assert.strictEqual(media.status, MediaStatus.UNKNOWN);
      assert.strictEqual(media.status4k, MediaStatus.UNKNOWN);
      assert.strictEqual(media.serviceId, null);
      assert.strictEqual(media.externalServiceId, null);
      assert.strictEqual(destination.status, MediaStatus.UNKNOWN);
    });

    it('stores exact availability and linkage without changing native state or another destination', async () => {
      const mediaRepository = getRepository(Media);
      const destinationRepository = getRepository(MediaDestinationStatus);
      const requestRepository = getRepository(MediaRequest);
      const requestedBy = await getRepository(User).findOneOrFail({
        where: { id: 1 },
      });
      const media = await mediaRepository.save(
        new Media({
          tmdbId: 550,
          mediaType: MediaType.MOVIE,
          status: MediaStatus.UNKNOWN,
          status4k: MediaStatus.UNKNOWN,
          serviceId: 99,
          externalServiceId: 999,
          externalServiceSlug: 'native-link',
        })
      );
      await destinationRepository.save([
        new MediaDestinationStatus({
          mediaId: media.id,
          serverId: 10,
          status: MediaStatus.PROCESSING,
        }),
        new MediaDestinationStatus({
          mediaId: media.id,
          serverId: 11,
          status: MediaStatus.PROCESSING,
        }),
      ]);
      const exactRequest = await requestRepository.save(
        new MediaRequest({
          type: MediaType.MOVIE,
          status: MediaRequestStatus.PENDING,
          media,
          requestedBy,
          is4k: false,
          serverId: 10,
        })
      );
      const otherRequest = await requestRepository.save(
        new MediaRequest({
          type: MediaType.MOVIE,
          status: MediaRequestStatus.PENDING,
          media,
          requestedBy,
          is4k: false,
          serverId: 11,
        })
      );
      await requestRepository
        .createQueryBuilder()
        .update(MediaRequest)
        .set({ status: MediaRequestStatus.APPROVED })
        .where('id IN (:...ids)', { ids: [exactRequest.id, otherRequest.id] })
        .callListeners(false)
        .execute();

      configureRadarr([
        {
          id: 10,
          hostname: 'radarr-fr',
          independentRequestDestination: true,
        },
      ]);
      getMoviesImpl = async () => [
        fakeRadarrMovie({ id: 77, titleSlug: 'exact-link' }),
      ];

      await runWithMockTimers(() => radarrScanner.run());

      const updatedMedia = await mediaRepository.findOneOrFail({
        where: { id: media.id },
      });
      const exactDestination = await destinationRepository.findOneOrFail({
        where: { mediaId: media.id, serverId: 10 },
      });
      const otherDestination = await destinationRepository.findOneOrFail({
        where: { mediaId: media.id, serverId: 11 },
      });
      assert.strictEqual(exactDestination.status, MediaStatus.AVAILABLE);
      assert.strictEqual(exactDestination.externalServiceId, 77);
      assert.strictEqual(exactDestination.externalServiceSlug, 'exact-link');
      assert.strictEqual(otherDestination.status, MediaStatus.PROCESSING);
      assert.strictEqual(updatedMedia.status, MediaStatus.UNKNOWN);
      assert.strictEqual(updatedMedia.status4k, MediaStatus.UNKNOWN);
      assert.strictEqual(updatedMedia.serviceId, 99);
      assert.strictEqual(updatedMedia.externalServiceId, 999);
      assert.strictEqual(updatedMedia.externalServiceSlug, 'native-link');
      assert.strictEqual(
        (
          await requestRepository.findOneOrFail({
            where: { id: exactRequest.id },
          })
        ).status,
        MediaRequestStatus.COMPLETED
      );
      assert.strictEqual(
        (
          await requestRepository.findOneOrFail({
            where: { id: otherRequest.id },
          })
        ).status,
        MediaRequestStatus.APPROVED
      );
    });

    it('declines only an exactly missing PROCESSING movie and ignores the other media type', async () => {
      const mediaRepository = getRepository(Media);
      const destinationRepository = getRepository(MediaDestinationStatus);
      const requestRepository = getRepository(MediaRequest);
      const requestedBy = await getRepository(User).findOneOrFail({
        where: { id: 1 },
      });
      const movie = await mediaRepository.save(
        new Media({ tmdbId: 700, mediaType: MediaType.MOVIE })
      );
      const show = await mediaRepository.save(
        new Media({
          tmdbId: 701,
          tvdbId: 702,
          mediaType: MediaType.TV,
        })
      );
      await destinationRepository.save([
        new MediaDestinationStatus({
          mediaId: movie.id,
          serverId: 10,
          status: MediaStatus.PROCESSING,
        }),
        new MediaDestinationStatus({
          mediaId: show.id,
          serverId: 10,
          status: MediaStatus.PROCESSING,
        }),
      ]);
      const request = await requestRepository.save(
        new MediaRequest({
          type: MediaType.MOVIE,
          status: MediaRequestStatus.PENDING,
          media: movie,
          requestedBy,
          is4k: false,
          serverId: 10,
        })
      );
      await requestRepository
        .createQueryBuilder()
        .update(MediaRequest)
        .set({ status: MediaRequestStatus.APPROVED })
        .where('id = :id', { id: request.id })
        .callListeners(false)
        .execute();

      configureRadarr([
        {
          id: 10,
          hostname: 'radarr-fr',
          independentRequestDestination: true,
        },
      ]);
      getMoviesImpl = async () => [fakeRadarrMovie({ tmdbId: 999 })];
      getLibraryMoviesByTmdbIdImpl = async () => [];

      await runWithMockTimers(() => radarrScanner.run());

      assert.strictEqual(
        (await requestRepository.findOneOrFail({ where: { id: request.id } }))
          .status,
        MediaRequestStatus.DECLINED
      );
      assert.strictEqual(
        (
          await destinationRepository.findOneOrFail({
            where: { mediaId: movie.id, serverId: 10 },
          })
        ).status,
        MediaStatus.UNKNOWN
      );
      assert.strictEqual(
        (
          await destinationRepository.findOneOrFail({
            where: { mediaId: show.id, serverId: 10 },
          })
        ).status,
        MediaStatus.PROCESSING
      );
    });

    it('marks confirmed missing AVAILABLE media deleted but preserves completed history', async () => {
      const media = await getRepository(Media).save(
        new Media({ tmdbId: 710, mediaType: MediaType.MOVIE })
      );
      await getRepository(MediaDestinationStatus).save(
        new MediaDestinationStatus({
          mediaId: media.id,
          serverId: 10,
          status: MediaStatus.AVAILABLE,
        })
      );
      const request = await getRepository(MediaRequest).save(
        new MediaRequest({
          type: MediaType.MOVIE,
          status: MediaRequestStatus.COMPLETED,
          media,
          requestedBy: await getRepository(User).findOneOrFail({
            where: { id: 1 },
          }),
          is4k: false,
          serverId: 10,
        })
      );
      configureRadarr([
        {
          id: 10,
          hostname: 'radarr-fr',
          independentRequestDestination: true,
        },
      ]);
      getMoviesImpl = async () => [fakeRadarrMovie({ tmdbId: 999 })];
      getLibraryMoviesByTmdbIdImpl = async () => [];

      await runWithMockTimers(() => radarrScanner.run());

      assert.strictEqual(
        (
          await getRepository(MediaDestinationStatus).findOneOrFail({
            where: { mediaId: media.id, serverId: 10 },
          })
        ).status,
        MediaStatus.DELETED
      );
      assert.strictEqual(
        (
          await getRepository(MediaRequest).findOneOrFail({
            where: { id: request.id },
          })
        ).status,
        MediaRequestStatus.COMPLETED
      );
    });

    it('does not clean up an omitted movie when exact lookup finds it, throws, or inventory is empty', async () => {
      const media = await getRepository(Media).save(
        new Media({ tmdbId: 720, mediaType: MediaType.MOVIE })
      );
      const destination = await getRepository(MediaDestinationStatus).save(
        new MediaDestinationStatus({
          mediaId: media.id,
          serverId: 10,
          status: MediaStatus.AVAILABLE,
        })
      );
      configureRadarr([
        {
          id: 10,
          hostname: 'radarr-fr',
          independentRequestDestination: true,
        },
      ]);
      getMoviesImpl = async () => [fakeRadarrMovie({ tmdbId: 999 })];
      getLibraryMoviesByTmdbIdImpl = async (tmdbId) => [
        fakeRadarrMovie({ tmdbId }),
      ];
      await runWithMockTimers(() => radarrScanner.run());
      assert.strictEqual(
        (
          await getRepository(MediaDestinationStatus).findOneByOrFail({
            id: destination.id,
          })
        ).status,
        MediaStatus.AVAILABLE
      );

      getLibraryMoviesByTmdbIdImpl = async () => {
        throw new Error('unreachable');
      };
      await runWithMockTimers(() => radarrScanner.run());
      assert.strictEqual(
        (
          await getRepository(MediaDestinationStatus).findOneByOrFail({
            id: destination.id,
          })
        ).status,
        MediaStatus.AVAILABLE
      );

      getMoviesImpl = async () => [];
      getLibraryMoviesByTmdbIdImpl = async () => [];
      await runWithMockTimers(() => radarrScanner.run());
      assert.strictEqual(
        (
          await getRepository(MediaDestinationStatus).findOneByOrFail({
            id: destination.id,
          })
        ).status,
        MediaStatus.AVAILABLE
      );
    });

    it('keeps native and independent presence bookkeeping isolated in one run', async () => {
      const nativeOrphan = await getRepository(Media).save(
        new Media({
          tmdbId: 800,
          mediaType: MediaType.MOVIE,
          status: MediaStatus.PROCESSING,
        })
      );
      const independentMedia = await getRepository(Media).save(
        new Media({ tmdbId: 801, mediaType: MediaType.MOVIE })
      );
      const independentDestination = await getRepository(
        MediaDestinationStatus
      ).save(
        new MediaDestinationStatus({
          mediaId: independentMedia.id,
          serverId: 10,
          status: MediaStatus.AVAILABLE,
        })
      );
      configureRadarr([
        { id: 9, hostname: 'radarr-native' },
        {
          id: 10,
          hostname: 'radarr-independent',
          independentRequestDestination: true,
        },
      ]);
      const inventories = [
        [fakeRadarrMovie({ tmdbId: 801 })],
        [fakeRadarrMovie({ tmdbId: 800 })],
      ];
      getMoviesImpl = async () => inventories.shift() ?? [];
      getLibraryMoviesByTmdbIdImpl = async (tmdbId) =>
        tmdbId === 801 ? [fakeRadarrMovie({ tmdbId })] : [];

      await runWithMockTimers(() => radarrScanner.run());

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
          tmdbId: 810,
          mediaType: MediaType.MOVIE,
          status: MediaStatus.PROCESSING,
        })
      );
      const destination = await getRepository(MediaDestinationStatus).save(
        new MediaDestinationStatus({
          mediaId: media.id,
          serverId: 10,
          status: MediaStatus.PROCESSING,
        })
      );
      configureRadarr([
        { id: 9, hostname: ' Ambiguous-Radarr ', baseUrl: '/radarr/' },
        {
          id: 10,
          hostname: 'ambiguous-radarr',
          baseUrl: 'radarr',
          independentRequestDestination: true,
        },
      ]);
      getMoviesImpl = async () => [fakeRadarrMovie({ tmdbId: 999 })];
      getLibraryMoviesByTmdbIdImpl = async () => [];

      await runWithMockTimers(() => radarrScanner.run());

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
    });
  });
});
