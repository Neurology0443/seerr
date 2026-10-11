import TheMovieDb from '@server/api/themoviedb';
import { MediaStatus, MediaType } from '@server/constants/media';
import { getRepository } from '@server/datasource';
import Media from '@server/entity/Media';
import { MediaRequest } from '@server/entity/MediaRequest';
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
