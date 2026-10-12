import TheMovieDb from '@server/api/themoviedb';
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
import { Permission } from '@server/lib/permissions';
import {
  getSettings,
  type RadarrSettings,
  type SonarrSettings,
} from '@server/lib/settings';
import { setupTestDb } from '@server/test/db';
import express from 'express';
import assert from 'node:assert/strict';
import { beforeEach, describe, it, mock } from 'node:test';
import request from 'supertest';
import discoverRoutes from './discover';
import searchRoutes from './search';

const page = {
  page: 2,
  total_pages: 7,
  total_results: 123,
  results: [
    { id: 10, media_type: 'movie', title: 'Movie', genre_ids: [] },
    { id: 20, media_type: 'tv', name: 'TV', genre_ids: [] },
    { id: 30, media_type: 'person', name: 'Person', known_for: [] },
    { id: 40, media_type: 'collection', title: 'Collection' },
  ],
};
const trendingPage = {
  ...page,
  results: [
    page.results[0],
    { ...page.results[1], id: 10 },
    { ...page.results[2], id: 10 },
    { ...page.results[3], id: 10 },
  ],
};
for (const method of ['getAllTrending', 'getMovieTrending', 'getTvTrending'])
  Object.defineProperty(TheMovieDb.prototype, method, {
    get: () => async () => ({
      ...trendingPage,
      results:
        method === 'getAllTrending'
          ? trendingPage.results
          : [trendingPage.results[method === 'getMovieTrending' ? 0 : 1]],
    }),
    set() {},
    configurable: true,
  });
for (const method of ['searchMulti', 'getDiscoverMovies'])
  Object.defineProperty(TheMovieDb.prototype, method, {
    get: () => async () =>
      method === 'searchMulti' ? page : { ...page, results: [page.results[0]] },
    set() {},
    configurable: true,
  });
const app = express();
app.use((req, _res, next) => {
  req.user = new User({
    id: 1,
    permissions: Number(req.headers['x-permissions'] ?? Permission.ADMIN),
  });
  next();
});
app.use('/search', searchRoutes);
app.use('/discover', discoverRoutes);
setupTestDb();
beforeEach(async () => {
  getSettings().main.hideRequested = false;
  const configured = { id: 1, is4k: false, isDefault: true };
  getSettings().radarr = [configured as RadarrSettings];
  getSettings().sonarr = [configured as SonarrSettings];
  await getRepository(Media).save(
    new Media({
      tmdbId: 10,
      mediaType: MediaType.MOVIE,
      status: MediaStatus.UNKNOWN,
    })
  );
  await getRepository(Media).save(
    new Media({
      tmdbId: 20,
      mediaType: MediaType.TV,
      status: MediaStatus.AVAILABLE,
    })
  );
});
describe('list API Quick Request mapping', () => {
  it('enriches Movie/TV only and preserves mixed response pagination', async () => {
    const response = await request(app).get('/search?query=fixture&page=2');
    assert.equal(response.status, 200);
    assert.deepEqual(
      [
        response.body.page,
        response.body.totalPages,
        response.body.totalResults,
      ],
      [2, 7, 123]
    );
    assert.equal(response.body.results[0].quickRequestable, true);
    assert.equal(response.body.results[1].quickRequestable, false);
    assert.ok(
      response.body.results
        .slice(2)
        .every((item: object) => !('quickRequestable' in item))
    );
  });
  it('calculates a fresh user-specific value for each response', async () => {
    assert.equal(
      (
        await request(app)
          .get('/search?query=fixture')
          .set('x-permissions', String(Permission.REQUEST_TV))
      ).body.results[0].quickRequestable,
      false
    );
    assert.equal(
      (
        await request(app)
          .get('/search?query=fixture')
          .set('x-permissions', String(Permission.REQUEST_MOVIE))
      ).body.results[0].quickRequestable,
      true
    );
  });
  for (const endpoint of [
    '/search?query=fixture&page=2',
    '/discover/movies?page=2',
  ]) {
    it(`${endpoint} remains usable with unchanged pagination when projection fails`, async () => {
      const spy = mock.method(
        getRepository(MediaRequest),
        'createQueryBuilder',
        () => {
          throw new Error('projection unavailable');
        }
      );
      try {
        const response = await request(app).get(endpoint);
        assert.equal(response.status, 200);
        assert.deepEqual(
          [
            response.body.page,
            response.body.totalPages,
            response.body.totalResults,
          ],
          [2, 7, 123]
        );
        assert.ok(
          response.body.results.every(
            (item: object) => !('quickRequestable' in item)
          )
        );
        assert.equal(response.body.results[0].title, 'Movie');
      } finally {
        spy.mock.restore();
      }
    });
  }
});

describe('Trending media identity', () => {
  const assertPagination = (body: {
    page: number;
    totalPages: number;
    totalResults: number;
  }) => {
    assert.deepEqual(
      [body.page, body.totalPages, body.totalResults],
      [2, 7, 123]
    );
  };

  // Both types use server #2, but their availability and slots belong to
  // distinct local media IDs even though TMDB uses the same numeric ID.
  const seedCollision = async (movieRequestable: boolean) => {
    getSettings().main.hideRequested = true;
    const independent = {
      id: 2,
      is4k: false,
      isDefault: false,
      independentRequestDestination: true,
      syncEnabled: true,
    };
    getSettings().radarr.push(independent as RadarrSettings);
    getSettings().sonarr.push(independent as SonarrSettings);
    const movieRepository = getRepository(Media);
    const movie = await movieRepository.findOneByOrFail({
      tmdbId: 10,
      mediaType: MediaType.MOVIE,
    });
    movie.status = movieRequestable
      ? MediaStatus.UNKNOWN
      : MediaStatus.AVAILABLE;
    await movieRepository.save(movie);
    const tv = await movieRepository.save(
      new Media({
        tmdbId: 10,
        mediaType: MediaType.TV,
        status: movieRequestable
          ? MediaStatus.AVAILABLE
          : MediaStatus.PROCESSING,
      })
    );
    await getRepository(Season).save(
      new Season({
        media: Promise.resolve(tv),
        seasonNumber: 2,
        status: MediaStatus.AVAILABLE,
      })
    );
    await getRepository(MediaDestinationStatus).save(
      new MediaDestinationStatus({
        mediaId: movie.id,
        serverId: 2,
        status: movieRequestable ? MediaStatus.DELETED : MediaStatus.UNKNOWN,
      })
    );
    const tvDestination = await getRepository(MediaDestinationStatus).save(
      new MediaDestinationStatus({
        mediaId: tv.id,
        serverId: 2,
        status: movieRequestable ? MediaStatus.UNKNOWN : MediaStatus.AVAILABLE,
      })
    );
    await getRepository(MediaDestinationSeasonStatus).save(
      new MediaDestinationSeasonStatus({
        destinationStatusId: tvDestination.id,
        seasonNumber: 2,
        status: MediaStatus.UNKNOWN,
      })
    );
    const occupied = movieRequestable ? tv : movie;
    const created = await getRepository(MediaRequest).save(
      new MediaRequest({
        media: occupied,
        type: occupied.mediaType,
        serverId: 2,
        is4k: false,
        requestedBy: await getRepository(User).findOneByOrFail({ id: 1 }),
        status: MediaRequestStatus.COMPLETED,
        seasons: movieRequestable
          ? [
              new SeasonRequest({
                seasonNumber: 2,
                status: MediaRequestStatus.PENDING,
              }),
            ]
          : [],
      })
    );
    await getRepository(MediaRequest)
      .createQueryBuilder()
      .update()
      .set({ status: MediaRequestStatus.PENDING })
      .where('id = :id', { id: created.id })
      .callListeners(false)
      .execute();
    return { movie, tv };
  };

  for (const movieRequestable of [false, true]) {
    for (const firstType of [MediaType.MOVIE, MediaType.TV]) {
      it(`mixed Trending isolates colliding identities with movie requestable=${movieRequestable} and ${firstType} retrieved first`, async () => {
        const { movie, tv } = await seedCollision(movieRequestable);
        const retrieve = Media.getRelatedMedia;
        const lookup = mock.method(
          Media,
          'getRelatedMedia',
          async (...args: Parameters<typeof Media.getRelatedMedia>) => {
            const loaded = await retrieve(...args);
            return loaded.sort(
              (a, b) =>
                Number(b.mediaType === firstType) -
                Number(a.mediaType === firstType)
            );
          }
        );
        try {
          const response = await request(app).get(
            '/discover/trending?mediaType=all&page=2'
          );
          assert.equal(response.status, 200);
          assertPagination(response.body);
          const [movieResult, tvResult, personResult, collectionResult] =
            response.body.results;
          assert.equal(movieResult.mediaType, 'movie');
          assert.equal(movieResult.title, 'Movie');
          assert.equal(movieResult.mediaInfo.id, movie.id);
          assert.equal(movieResult.mediaInfo.mediaType, MediaType.MOVIE);
          assert.equal(movieResult.mediaInfo.status, movie.status);
          assert.equal(
            movieResult.mediaInfo.hasActiveRequest,
            !movieRequestable
          );
          assert.equal(movieResult.quickRequestable, movieRequestable);
          assert.equal(tvResult.mediaType, 'tv');
          assert.equal(tvResult.name, 'TV');
          assert.equal(tvResult.mediaInfo.id, tv.id);
          assert.equal(tvResult.mediaInfo.mediaType, MediaType.TV);
          assert.equal(tvResult.mediaInfo.status, tv.status);
          assert.equal(tvResult.mediaInfo.hasActiveRequest, movieRequestable);
          assert.equal(tvResult.quickRequestable, !movieRequestable);
          assert.equal(personResult.mediaType, 'person');
          assert.equal(personResult.name, 'Person');
          assert.equal(collectionResult.mediaType, 'collection');
          assert.equal(collectionResult.title, 'Collection');
          for (const result of [personResult, collectionResult]) {
            assert.ok(!('mediaInfo' in result));
            assert.ok(!('quickRequestable' in result));
          }
          assert.equal(lookup.mock.callCount(), 1);
        } finally {
          lookup.mock.restore();
        }
      });
    }
  }

  for (const registeredType of [MediaType.MOVIE, MediaType.TV]) {
    it(`does not attach ${registeredType} media to an unregistered colliding result of the other type`, async () => {
      const repository = getRepository(Media);
      await repository.delete({ tmdbId: 10 });
      const registered = await repository.save(
        new Media({
          tmdbId: 10,
          mediaType: registeredType,
          status: MediaStatus.AVAILABLE,
        })
      );
      const response = await request(app).get('/discover/trending?page=2');
      assert.equal(response.status, 200);
      assertPagination(response.body);
      for (const result of response.body.results.slice(0, 2)) {
        const hasLocalMedia = result.mediaType === registeredType;
        assert.equal(
          result.mediaInfo?.id,
          hasLocalMedia ? registered.id : undefined
        );
        assert.equal(result.quickRequestable, !hasLocalMedia);
      }
    });
  }

  for (const type of [MediaType.MOVIE, MediaType.TV]) {
    it(`preserves ${type}-only Trending mapping, local identity and pagination`, async () => {
      const { movie, tv } = await seedCollision(false);
      const expected = type === MediaType.MOVIE ? movie : tv;
      const response = await request(app).get(
        `/discover/trending?mediaType=${type}&page=2&timeWindow=week`
      );
      assert.equal(response.status, 200);
      assertPagination(response.body);
      assert.equal(response.body.results.length, 1);
      assert.equal(response.body.results[0].mediaType, type);
      assert.equal(response.body.results[0].mediaInfo.id, expected.id);
      assert.equal(
        response.body.results[0].quickRequestable,
        type === MediaType.TV
      );
    });
  }
});
