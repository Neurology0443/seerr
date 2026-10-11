import {
  MediaType,
  MediaRequestStatus as R,
  MediaStatus as S,
} from '@server/constants/media';
import dataSource, { getRepository } from '@server/datasource';
import Media from '@server/entity/Media';
import { MediaDestinationSeasonStatus } from '@server/entity/MediaDestinationSeasonStatus';
import { MediaDestinationStatus } from '@server/entity/MediaDestinationStatus';
import { MediaRequest } from '@server/entity/MediaRequest';
import Season from '@server/entity/Season';
import SeasonRequest from '@server/entity/SeasonRequest';
import { User } from '@server/entity/User';
import { Permission } from '@server/lib/permissions';
import { enrichQuickRequestVisibility } from '@server/lib/quickRequestVisibility';
import {
  getSettings,
  type RadarrSettings,
  type SonarrSettings,
} from '@server/lib/settings';
import type { MovieResult, TvResult } from '@server/models/Search';
import { setupTestDb } from '@server/test/db';
import assert from 'node:assert/strict';
import { beforeEach, describe, it, mock } from 'node:test';

setupTestDb();
const server = (
  id: number,
  independentRequestDestination = false,
  isDefault = id === 1
) =>
  ({
    id,
    is4k: false,
    isDefault,
    independentRequestDestination,
    syncEnabled: true,
  }) as RadarrSettings & SonarrSettings;
const user = (permissions = Permission.ADMIN) => new User({ permissions });
const result = (
  media?: Media,
  type: 'movie' | 'tv' = media?.mediaType ?? 'movie'
) =>
  ({ id: media?.tmdbId ?? 123, mediaType: type, mediaInfo: media }) as
    | MovieResult
    | TvResult;
const project = async (media?: Media, actor = user(), type?: 'movie' | 'tv') =>
  (await enrichQuickRequestVisibility([result(media, type)], actor))[0]
    .quickRequestable;
const media = async (type = MediaType.MOVIE, status = S.UNKNOWN) =>
  getRepository(Media).save(
    new Media({ mediaType: type, tmdbId: 321, status, status4k: S.UNKNOWN })
  );
const destination = async (
  m: Media,
  id: number,
  status = S.UNKNOWN,
  seasons: [number, S][] = []
) => {
  const d = await getRepository(MediaDestinationStatus).save(
    new MediaDestinationStatus({ mediaId: m.id, serverId: id, status })
  );
  for (const [seasonNumber, state] of seasons)
    await getRepository(MediaDestinationSeasonStatus).save(
      new MediaDestinationSeasonStatus({
        destinationStatusId: d.id,
        seasonNumber,
        status: state,
      })
    );
  return d;
};
const request = async (
  m: Media,
  serverId: number | null,
  status: R,
  seasons: number[] = [],
  is4k = false
) => {
  const created = await getRepository(MediaRequest).save(
    new MediaRequest({
      media: m,
      type: m.mediaType,
      serverId: serverId ?? undefined,
      is4k,
      status: R.COMPLETED,
      requestedBy: await getRepository(User).findOneByOrFail({ id: 1 }),
      seasons: seasons.map(
        (seasonNumber) => new SeasonRequest({ seasonNumber, status: R.PENDING })
      ),
    })
  );
  await getRepository(MediaRequest)
    .createQueryBuilder()
    .update()
    .set({ status })
    .where('id = :id', { id: created.id })
    .callListeners(false)
    .execute();
};
beforeEach(() => {
  getSettings().radarr = [server(1), server(2, true)];
  getSettings().sonarr = [server(1), server(2, true)];
  getSettings().main.enableSpecialEpisodes = false;
});

describe('Quick Request local visibility', () => {
  it('restricts ordinary users to the configured Standard default, including independent defaults', async () => {
    const m = await media(MediaType.MOVIE, S.AVAILABLE);
    assert.equal(await project(m, user(Permission.REQUEST)), false);
    assert.equal(await project(m), true);
    getSettings().radarr = [server(1, true)];
    assert.equal(await project(m, user(Permission.REQUEST_MOVIE)), true);
    await destination(m, 1, S.AVAILABLE);
    assert.equal(await project(m, user(Permission.REQUEST)), false);
  });
  for (const type of [MediaType.MOVIE, MediaType.TV]) {
    it(`${type}: permissions, missing defaults, no Standard targets and Blocklist take precedence`, async () => {
      const m = await media(type);
      assert.equal(await project(m, user(0)), false);
      assert.equal(
        await project(
          m,
          user(
            type === MediaType.MOVIE
              ? Permission.REQUEST_TV
              : Permission.REQUEST_MOVIE
          )
        ),
        false
      );
      const key = type === MediaType.MOVIE ? 'radarr' : 'sonarr';
      getSettings()[key] = [server(2, true, false)];
      assert.equal(await project(m, user(Permission.REQUEST)), false);
      assert.equal(await project(m), true);
      getSettings()[key] = [{ ...server(1, true), is4k: true }];
      assert.equal(await project(m), false);
      getSettings()[key] = [];
      assert.equal(await project(m), false);
      getSettings()[key] = [server(1, true)];
      m.status = S.BLOCKLISTED;
      assert.equal(await project(m), false);
    });
  }
  for (const status of [
    S.UNKNOWN,
    S.DELETED,
    S.PENDING,
    S.PROCESSING,
    S.PARTIALLY_AVAILABLE,
    S.AVAILABLE,
  ]) {
    it(`movie: independent status ${status} with native AVAILABLE`, async () => {
      const m = await media(MediaType.MOVIE, S.AVAILABLE);
      await destination(m, 2, status);
      assert.equal(await project(m), [S.UNKNOWN, S.DELETED].includes(status));
    });
  }
  for (const status of [
    R.PENDING,
    R.APPROVED,
    R.COMPLETED,
    R.DECLINED,
    R.FAILED,
  ]) {
    it(`movie: request status ${status} occupies only active exact slots`, async () => {
      const m = await media(MediaType.MOVIE, S.AVAILABLE);
      await request(m, 2, status);
      assert.equal(await project(m), ![R.PENDING, R.APPROVED].includes(status));
      getSettings().radarr.push(server(3, true));
      assert.equal(await project(m), true);
    });
  }
  it('shares native Standard slots across native servers but separates 4K and deleted independent identities', async () => {
    const m = await media();
    getSettings().radarr = [server(1), server(2)];
    await request(m, 1, R.APPROVED, [], true);
    assert.equal(await project(m), true);
    await destination(m, 99);
    await request(m, 99, R.PENDING);
    assert.equal(await project(m), true);
    await request(m, null, R.PENDING);
    assert.equal(await project(m), false);
  });
  it('TV: explicitly loads native seasons through the QueryBuilder lookup and uses exact destination-season states', async () => {
    const m = await media(MediaType.TV, S.AVAILABLE);
    await getRepository(Season).save(
      new Season({
        media: Promise.resolve(m),
        seasonNumber: 2,
        status: S.AVAILABLE,
        status4k: S.UNKNOWN,
      })
    );
    await destination(m, 2, S.AVAILABLE, [[2, S.UNKNOWN]]);
    const fromList = (
      await Media.getRelatedMedia(user(), [
        { tmdbId: m.tmdbId, mediaType: m.mediaType },
      ])
    )[0];
    assert.equal(fromList.seasons, undefined);
    assert.equal(await project(fromList, user(Permission.REQUEST)), false);
    assert.equal(await project(fromList), true);
    await request(m, 2, R.PENDING, [2]);
    assert.equal(await project(fromList), false);
    getSettings().sonarr.push(server(3, true));
    assert.equal(await project(fromList), true);
  });
  it('TV: missing native seasons mean UNKNOWN instead of parent AVAILABLE', async () => {
    const m = await media(MediaType.TV, S.AVAILABLE);
    await destination(m, 2, S.AVAILABLE, [[2, S.AVAILABLE]]);
    assert.equal(await project(m, user(Permission.REQUEST)), true);
  });
  it('TV: historical request seasons contribute inventory without occupying slots', async () => {
    const m = await media(MediaType.TV, S.AVAILABLE);
    getSettings().sonarr = [server(1)];
    assert.equal(await project(m), false);
    await request(m, 1, R.COMPLETED, [3]);
    assert.equal(await project(m), true); // Local seasons intentionally have no TMDB episode counts.
    await request(m, 1, R.PENDING, [3]);
    assert.equal(await project(m), false);
  });
  it('TV: occupied FR season does not occupy independent EN, and missing EN season rows mean UNKNOWN', async () => {
    const m = await media(MediaType.TV);
    await destination(m, 2, S.AVAILABLE);
    await request(m, 1, R.PENDING, [2]);
    assert.equal(await project(m, user(Permission.REQUEST)), false);
    assert.equal(await project(m), true);
  });
  it('TV: excludes specials when disabled and falls back to known parent state on empty eligible inventory', async () => {
    const m = await media(MediaType.TV, S.AVAILABLE);
    getSettings().sonarr = [server(1)];
    await request(m, 1, R.COMPLETED, [0]);
    assert.equal(await project(m), false);
    getSettings().main.enableSpecialEpisodes = true;
    assert.equal(await project(m), true);
  });
  it('TV: empty registered and unregistered inventories retain controlled accessible parent-state fallback', async () => {
    getSettings().sonarr = [server(1, true), server(2, true)];
    assert.equal(
      await project(undefined, user(Permission.REQUEST_TV), 'tv'),
      true
    );
    const m = await media(MediaType.TV, S.AVAILABLE);
    assert.equal(await project(m, user(Permission.REQUEST_TV)), true);
    await destination(m, 1, S.AVAILABLE);
    assert.equal(await project(m, user(Permission.REQUEST)), false);
    assert.equal(await project(m), true);
    await destination(m, 2, S.AVAILABLE);
    assert.equal(await project(m), false);
  });
  it('bounds batch reads for 20 results and deleted-server requests, writes nothing, and skips reads for restrictions', async () => {
    const items = [];
    for (let i = 0; i < 20; i++) {
      const m = await getRepository(Media).save(
        new Media({
          mediaType: MediaType.TV,
          tmdbId: 1000 + i,
          status: S.AVAILABLE,
        })
      );
      await destination(m, 99);
      await request(m, 99, R.PENDING, [2]);
      items.push(result(m));
    }
    const queries: string[] = [];
    const spy = mock.method(dataSource.logger, 'logQuery', (query: string) =>
      queries.push(query)
    );
    try {
      assert.ok(
        (await enrichQuickRequestVisibility(items, user())).every(
          (item) => item.quickRequestable
        )
      );
      // TypeORM also batches the existing MediaRequest seasonCount relation.
      assert.equal(queries.length, 5);
      assert.ok(queries.every((query) => query.startsWith('SELECT')));
      assert.ok(items.every((item) => item.quickRequestable === undefined));
      queries.length = 0;
      await enrichQuickRequestVisibility(items, user(0));
      assert.equal(queries.length, 0);
    } finally {
      spy.mock.restore();
    }
  });
  it('returns the original unmodified results when a projection read fails', async () => {
    const items = [result(await media())];
    const spy = mock.method(
      getRepository(MediaRequest),
      'createQueryBuilder',
      () => {
        throw new Error('projection unavailable');
      }
    );
    try {
      assert.equal(await enrichQuickRequestVisibility(items, user()), items);
      assert.equal(items[0].quickRequestable, undefined);
    } finally {
      spy.mock.restore();
    }
  });
});
