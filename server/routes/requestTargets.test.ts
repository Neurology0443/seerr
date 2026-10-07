import assert from 'node:assert/strict';
import { before, beforeEach, describe, it } from 'node:test';

import TheMovieDb from '@server/api/themoviedb';
import type { TmdbTvDetails } from '@server/api/themoviedb/interfaces';
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
import Season from '@server/entity/Season';
import SeasonRequest from '@server/entity/SeasonRequest';
import { User } from '@server/entity/User';
import type {
  MovieRequestTarget,
  TvRequestTarget,
} from '@server/interfaces/api/requestInterfaces';
import type { RadarrSettings, SonarrSettings } from '@server/lib/settings';
import { getSettings } from '@server/lib/settings';
import { checkUser, isAuthenticated } from '@server/middleware/auth';
import { setupTestDb } from '@server/test/db';
import type { Express } from 'express';
import express from 'express';
import session from 'express-session';
import request from 'supertest';
import authRoutes from './auth';
import movieRoutes from './movie';
import tvRoutes from './tv';

Object.defineProperty(TheMovieDb.prototype, 'getTvShow', {
  get() {
    return async ({ tvId }: { tvId: number }) =>
      ({
        id: tvId,
        keywords: { results: [] },
        external_ids: {},
        seasons: [
          { season_number: 0, episode_count: 2 },
          { season_number: 1, episode_count: 10 },
          { season_number: 2, episode_count: 8 },
          { season_number: 3, episode_count: 0 },
        ],
      }) as unknown as TmdbTvDetails;
  },
  set() {},
  configurable: true,
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

let app: Express;

before(() => {
  app = express();
  app.use(express.json());
  app.use(
    session({
      secret: 'test-secret',
      resave: false,
      saveUninitialized: false,
    })
  );
  app.use(checkUser);
  app.use('/auth', authRoutes);
  app.use('/movie', isAuthenticated(), movieRoutes);
  app.use('/tv', isAuthenticated(), tvRoutes);
  app.use(
    (
      err: { status?: number; message?: string },
      _req: express.Request,
      res: express.Response,
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      _next: express.NextFunction
    ) =>
      res
        .status(err.status ?? 500)
        .json({ status: err.status ?? 500, message: err.message })
  );
});

beforeEach(() => {
  getSettings().radarr = [];
  getSettings().sonarr = [];
  getSettings().main.enableSpecialEpisodes = false;
});

setupTestDb();

async function login() {
  const prior = getSettings().main.localLogin;
  getSettings().main.localLogin = true;
  try {
    const agent = request.agent(app);
    const response = await agent
      .post('/auth/local')
      .send({ email: 'admin@seerr.dev', password: 'test1234' });
    assert.strictEqual(response.status, 200);
    return agent;
  } finally {
    getSettings().main.localLogin = prior;
  }
}

async function seedRequest(
  media: Media,
  serverId: number,
  status: MediaRequestStatus,
  seasons: number[] = [],
  is4k = false
) {
  const requestedBy = await getRepository(User).findOneByOrFail({ id: 1 });
  const requestRepository = getRepository(MediaRequest);
  const created = await requestRepository.save(
    new MediaRequest({
      type: media.mediaType,
      media,
      requestedBy,
      serverId,
      status: MediaRequestStatus.COMPLETED,
      is4k,
      seasons: seasons.map(
        (seasonNumber) =>
          new SeasonRequest({
            seasonNumber,
            status: MediaRequestStatus.PENDING,
          })
      ),
    })
  );

  if (status !== MediaRequestStatus.COMPLETED) {
    await requestRepository
      .createQueryBuilder()
      .update(MediaRequest)
      .set({ status })
      .where('id = :id', { id: created.id })
      .callListeners(false)
      .execute();
  }

  return created;
}

describe('GET /movie/:id/request-targets', () => {
  it('isolates independent states and slots from each other and native Standard', async () => {
    getSettings().radarr = [
      radarr(1, { name: 'Native', isDefault: true }),
      radarr(2, { name: 'FR', independentRequestDestination: true }),
      radarr(3, { name: 'EN', independentRequestDestination: true }),
    ];
    const media = await getRepository(Media).save(
      new Media({
        mediaType: MediaType.MOVIE,
        tmdbId: 51001,
        status: MediaStatus.UNKNOWN,
        status4k: MediaStatus.AVAILABLE,
      })
    );
    await getRepository(MediaDestinationStatus).save(
      new MediaDestinationStatus({
        mediaId: media.id,
        serverId: 2,
        status: MediaStatus.AVAILABLE,
      })
    );
    await seedRequest(media, 2, MediaRequestStatus.PENDING);

    const response = await (await login()).get('/movie/51001/request-targets');

    assert.strictEqual(response.status, 200);
    const native = response.body.find(
      (target: { serverId: number }) => target.serverId === 1
    );
    const french = response.body.find(
      (target: { serverId: number }) => target.serverId === 2
    );
    const english = response.body.find(
      (target: { serverId: number }) => target.serverId === 3
    );
    assert.deepStrictEqual(
      [french.status, english.status],
      [MediaStatus.AVAILABLE, MediaStatus.UNKNOWN]
    );
    assert.strictEqual(french.requestable, false);
    assert.strictEqual(english.requestable, true);
    assert.strictEqual(native.requestable, true);
  });

  it('shares native slots by tier but ignores inactive requests', async () => {
    getSettings().radarr = [
      radarr(10),
      radarr(11),
      radarr(12, { independentRequestDestination: true }),
      radarr(13, { is4k: true }),
    ];
    const media = await getRepository(Media).save(
      new Media({
        mediaType: MediaType.MOVIE,
        tmdbId: 51002,
        status: MediaStatus.UNKNOWN,
        status4k: MediaStatus.UNKNOWN,
      })
    );
    await seedRequest(media, 10, MediaRequestStatus.APPROVED);
    await seedRequest(media, 12, MediaRequestStatus.FAILED);

    const response = await (await login()).get('/movie/51002/request-targets');
    const byId = new Map<number, MovieRequestTarget>(
      (response.body as MovieRequestTarget[]).map((target) => [
        target.serverId,
        target,
      ])
    );

    assert.strictEqual(byId.get(10)?.requestable, false);
    assert.strictEqual(byId.get(11)?.requestable, false);
    assert.strictEqual(byId.get(12)?.requestable, true);
    assert.strictEqual(byId.get(13)?.requestable, true);
  });

  it('returns UNKNOWN targets without creating local state', async () => {
    getSettings().radarr = [
      radarr(20, { independentRequestDestination: true }),
    ];

    const response = await (await login()).get('/movie/59999/request-targets');

    assert.strictEqual(response.status, 200);
    assert.strictEqual(response.body[0].status, MediaStatus.UNKNOWN);
    assert.strictEqual(await getRepository(Media).count(), 0);
    assert.strictEqual(await getRepository(MediaDestinationStatus).count(), 0);
  });
});

describe('GET /tv/:id/request-targets', () => {
  it('isolates season state and occupation by destination and native tier', async () => {
    getSettings().sonarr = [
      sonarr(31, { name: 'Native' }),
      sonarr(32, { name: 'Native 4K', is4k: true }),
      sonarr(33, { name: 'FR', independentRequestDestination: true }),
      sonarr(34, { name: 'EN', independentRequestDestination: true }),
    ];
    const media = await getRepository(Media).save(
      new Media({
        mediaType: MediaType.TV,
        tmdbId: 52001,
        status: MediaStatus.PROCESSING,
        status4k: MediaStatus.PROCESSING,
        seasons: [
          new Season({
            seasonNumber: 1,
            status: MediaStatus.AVAILABLE,
            status4k: MediaStatus.UNKNOWN,
          }),
          new Season({
            seasonNumber: 2,
            status: MediaStatus.UNKNOWN,
            status4k: MediaStatus.AVAILABLE,
          }),
        ],
      })
    );
    const [french, english] = await getRepository(MediaDestinationStatus).save([
      new MediaDestinationStatus({
        mediaId: media.id,
        serverId: 33,
        status: MediaStatus.PROCESSING,
      }),
      new MediaDestinationStatus({
        mediaId: media.id,
        serverId: 34,
        status: MediaStatus.PROCESSING,
      }),
    ]);
    await getRepository(MediaDestinationSeasonStatus).save([
      new MediaDestinationSeasonStatus({
        destinationStatusId: french.id,
        seasonNumber: 1,
        status: MediaStatus.UNKNOWN,
      }),
      new MediaDestinationSeasonStatus({
        destinationStatusId: english.id,
        seasonNumber: 1,
        status: MediaStatus.AVAILABLE,
      }),
    ]);
    await seedRequest(media, 34, MediaRequestStatus.PENDING, [1]);
    await seedRequest(media, 31, MediaRequestStatus.APPROVED, [2]);

    const response = await (await login()).get('/tv/52001/request-targets');
    assert.strictEqual(response.status, 200);
    const byId = new Map<number, TvRequestTarget>(
      (response.body as TvRequestTarget[]).map((target) => [
        target.serverId,
        target,
      ])
    );
    const season = (serverId: number, seasonNumber: number) =>
      byId
        .get(serverId)
        ?.seasons.find((candidate) => candidate.seasonNumber === seasonNumber);

    assert.strictEqual(season(33, 1)?.requestable, true);
    assert.strictEqual(season(34, 1)?.requestable, false);
    assert.strictEqual(season(33, 2)?.status, MediaStatus.UNKNOWN);
    assert.strictEqual(season(31, 1)?.status, MediaStatus.AVAILABLE);
    assert.strictEqual(season(31, 2)?.requestable, false);
    assert.strictEqual(season(32, 1)?.status, MediaStatus.UNKNOWN);
    assert.strictEqual(season(32, 2)?.status, MediaStatus.AVAILABLE);
    assert.strictEqual(
      byId.get(33)?.requestable,
      byId.get(33)?.seasons.some((candidate) => candidate.requestable)
    );
  });

  it('does not create destination rows while reading missing TV state', async () => {
    getSettings().sonarr = [
      sonarr(40, { independentRequestDestination: true }),
    ];
    const media = await getRepository(Media).save(
      new Media({ mediaType: MediaType.TV, tmdbId: 52002 })
    );

    const response = await (await login()).get('/tv/52002/request-targets');

    assert.strictEqual(response.status, 200);
    assert.deepStrictEqual(
      response.body[0].seasons.map(
        (candidate: { status: MediaStatus }) => candidate.status
      ),
      [MediaStatus.UNKNOWN, MediaStatus.UNKNOWN]
    );
    assert.strictEqual(
      await getRepository(MediaDestinationStatus).count({
        where: { mediaId: media.id },
      }),
      0
    );
    assert.strictEqual(
      await getRepository(MediaDestinationSeasonStatus).count(),
      0
    );
  });
});
