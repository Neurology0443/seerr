import { MediaStatus, MediaType } from '@server/constants/media';
import { getRepository } from '@server/datasource';
import Media from '@server/entity/Media';
import { MediaDestinationSeasonStatus } from '@server/entity/MediaDestinationSeasonStatus';
import { MediaDestinationStatus } from '@server/entity/MediaDestinationStatus';
import { MediaRequest } from '@server/entity/MediaRequest';
import { User } from '@server/entity/User';
import { getSettings } from '@server/lib/settings';
import { setupTestDb } from '@server/test/db';
import {
  removalServer,
  removalSnapshot,
  seedRemoval,
} from '@server/test/fixtures/destinationRemoval';
import { withDestinationOperationLock } from '@server/utils/destinationOperationLock';
import * as dvrIdentityLocks from '@server/utils/dvrIdentityLock';
import {
  withDvrIdentityLock,
  withDvrSettingsMutationLock,
} from '@server/utils/dvrIdentityLock';
import axios, { type AxiosInstance, type AxiosRequestConfig } from 'axios';
import express from 'express';
import * as OpenApiValidator from 'express-openapi-validator';
import assert from 'node:assert/strict';
import path from 'node:path';
import { afterEach, before, describe, it, mock } from 'node:test';
import request from 'supertest';
import mediaRoutes from './media';
import radarrRoutes from './settings/radarr';
import sonarrRoutes from './settings/sonarr';

setupTestDb();
const app = express();
before(() => {
  app.use(express.json());
  app.use(async (req, _res, next) => {
    req.user = await getRepository(User).findOneByOrFail({
      id: req.header('X-User') === '2' ? 2 : 1,
    });
    next();
  });
  app.use('/media', mediaRoutes);
  app.use(
    OpenApiValidator.middleware({
      apiSpec: path.join(__dirname, '../../seerr-api.yml'),
      validateRequests: true,
      ignoreUndocumented: true,
    })
  );
  app.use('/api/v1/media', mediaRoutes);
  app.use('/settings/radarr', radarrRoutes);
  app.use('/settings/sonarr', sonarrRoutes);
  app.use(
    (
      err: { status?: number; message?: string },
      _req: express.Request,
      res: express.Response,
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      _next: express.NextFunction
    ) => {
      res.status(err.status ?? 500).json({ message: err.message });
    }
  );
});
afterEach(() => mock.restoreAll());

const arrMock = (
  type: MediaType,
  failure?: unknown,
  absent = false,
  lookup?: 'mismatch' | 'inconclusive' | 'failed'
) => {
  const calls: { url?: string; method: string; path: string }[] = [];
  mock.method(
    axios,
    'create',
    (config: AxiosRequestConfig) =>
      ({
        interceptors: { request: { use: () => 0 }, response: { use: () => 0 } },
        get: async (path: string) => {
          if (config.baseURL?.includes('themoviedb.org')) {
            return {
              data: {
                external_ids: { tvdb_id: 1234 },
                videos: { results: [{ type: 'Trailer', key: 'test' }] },
              },
            };
          }
          calls.push({ url: config.baseURL, method: 'GET', path });
          if (lookup === 'failed') throw { response: { status: 503 } };
          if (lookup === 'inconclusive') return { data: null };
          if (absent) {
            if (/\d+$/.test(path)) throw { response: { status: 404 } };
            return { data: [] };
          }
          const record = { id: 12, tmdbId: 550, tvdbId: 1234 };
          if (lookup === 'mismatch')
            record[type === MediaType.MOVIE ? 'tmdbId' : 'tvdbId'] = 999;
          return {
            data:
              path.endsWith('/lookup') ||
              path === '/movie' ||
              path === '/series'
                ? [record]
                : record,
          };
        },
        delete: async (path: string) => {
          calls.push({ url: config.baseURL, method: 'DELETE', path });
          if (failure) throw failure;
          return {};
        },
      }) as unknown as AxiosInstance
  );
  mock.method(MediaRequest, 'sendNotification', async () => undefined);
  return calls;
};

for (const type of [MediaType.MOVIE, MediaType.TV]) {
  describe(`exact ${type} removal`, () => {
    it('releases DVR and destination locks before slow notifications and preserves success on notification failure', async () => {
      const { media, requests } = await seedRemoval(type);
      arrMock(type);
      let entered!: () => void;
      const notificationEntered = new Promise<void>((resolve) => {
        entered = resolve;
      });
      let release!: () => void;
      const notificationReleased = new Promise<void>((resolve) => {
        release = resolve;
      });
      const notify = mock.method(
        MediaRequest,
        'sendNotification',
        async (declined: MediaRequest) => {
          assert.equal(declined.id, requests[0].id);
          const snapshot = await removalSnapshot();
          assert.equal(snapshot.destinations[1].status, MediaStatus.DELETED);
          assert.equal(snapshot.destinations[1].externalServiceId, null);
          assert.equal(
            getRepository(Media).manager.queryRunner?.isTransactionActive ??
              false,
            false
          );
          entered();
          await notificationReleased;
          throw new Error('notification delivery failed');
        }
      );
      const removing = request(app)
        .delete(`/media/${media.id}/file?serverId=2`)
        .then((response) => response);
      await notificationEntered;
      try {
        const kind = type === MediaType.MOVIE ? 'radarr' : 'sonarr';
        await withDvrIdentityLock(kind, 2, () =>
          withDvrSettingsMutationLock(kind, async () => undefined)
        );
        await withDestinationOperationLock(
          type,
          media.tmdbId,
          2,
          async () => undefined
        );
      } finally {
        release();
      }
      assert.equal((await removing).status, 204);
      assert.equal(notify.mock.callCount(), 1);
      assert.equal(
        (await request(app).delete(`/media/${media.id}/file?serverId=2`))
          .status,
        204
      );
      assert.equal(notify.mock.callCount(), 1);
    });

    it('accepts the integer query after OpenAPI request coercion', async () => {
      const { media } = await seedRemoval(type);
      const calls = arrMock(type);
      assert.equal(
        (
          await request(app)
            .delete(`/api/v1/media/${media.id}/file?serverId=2`)
            .set('X-API-Key', 'test')
        ).status,
        204
      );
      assert.equal(calls.filter((call) => call.method === 'DELETE').length, 1);
    });
    for (const mutation of ['connection update', 'deletion'] as const) {
      it(
        `allows FR removal while EN removal blocks an EN ${mutation}`,
        { timeout: 10000 },
        async (t) => {
          const { media, requests } = await seedRemoval(type);
          const settings = getSettings();
          const kind = type === MediaType.MOVIE ? 'radarr' : 'sonarr';
          const originalServer = { ...settings[kind][1] };
          // Deletion is allowed once the remaining approved request is declined.
          await getRepository(MediaRequest).delete(requests[1].id);
          mock.method(settings, 'save', async () => undefined);
          mock.method(MediaRequest, 'sendNotification', async () => undefined);
          let started!: () => void;
          let release!: () => void;
          const reached = new Promise<void>((resolve) => {
            started = resolve;
          });
          const remote = new Promise<void>((resolve) => {
            release = resolve;
          });
          t.after(() => release());
          const deletedServers: string[] = [];
          mock.method(
            axios,
            'create',
            (config: AxiosRequestConfig) =>
              ({
                interceptors: {
                  request: { use: () => 0 },
                  response: { use: () => 0 },
                },
                get: async (path: string) => ({
                  data: {
                    id: Number(path.split('/').at(-1)),
                    tmdbId: 550,
                    tvdbId: 1234,
                  },
                }),
                delete: async () => {
                  deletedServers.push(config.baseURL!);
                  if (config.baseURL === 'http://server-2:7878/api/v3') {
                    started();
                    await remote;
                    assert.equal(
                      settings[kind][1].hostname,
                      originalServer.hostname
                    );
                  }
                  return {};
                },
              }) as unknown as AxiosInstance
          );
          const removing = request(app)
            .delete(`/media/${media.id}/file?serverId=2`)
            .then((res) => res);
          await reached;
          let attempted!: () => void;
          const mutationAttempted = new Promise<void>((resolve) => {
            attempted = resolve;
          });
          const originalLock = dvrIdentityLocks.withDvrIdentityLock;
          mock.method(
            dvrIdentityLocks,
            'withDvrIdentityLock',
            (...args: Parameters<typeof originalLock>) => {
              if (args[0] === kind && args[1] === 2) attempted();
              return originalLock(...args);
            }
          );
          let settled = false;
          const changing = (
            mutation === 'deletion'
              ? request(app).delete(`/settings/${kind}/2`)
              : request(app)
                  .put(`/settings/${kind}/2`)
                  .send({ ...originalServer, hostname: 'replacement-instance' })
          ).then((res) => {
            settled = true;
            return res;
          });
          await mutationAttempted;
          try {
            assert.equal(settled, false);
            assert.equal(settings[kind][1].hostname, originalServer.hostname);
            // Neither the pending Arr response nor a queued EN settings mutation
            // may hold the settings lock needed by FR.
            assert.equal(
              (
                await request(app)
                  .put(`/settings/${kind}/1`)
                  .send({ ...settings[kind][0], name: 'French' })
              ).status,
              200
            );
            assert.equal(
              (await request(app).delete(`/media/${media.id}/file?serverId=1`))
                .status,
              204
            );
            assert.deepEqual(deletedServers, [
              'http://server-2:7878/api/v3',
              'http://server-1:7878/api/v3',
            ]);
            assert.equal(settled, false);
          } finally {
            release();
          }
          assert.equal((await removing).status, 204);
          assert.equal((await changing).status, 200);
          if (mutation === 'deletion')
            assert.equal(
              settings[kind].some((server) => server.id === 2),
              false
            );
          else assert.equal(settings[kind][1].hostname, 'replacement-instance');
          assert.equal(
            (
              await getRepository(MediaDestinationStatus).findOneByOrFail({
                mediaId: media.id,
                serverId: 2,
              })
            ).status,
            mutation === 'deletion' ? MediaStatus.DELETED : MediaStatus.UNKNOWN
          );
        }
      );
    }

    it(
      'serializes removals of different media on the same server',
      { timeout: 10000 },
      async (t) => {
        const { media } = await seedRemoval(type);
        const other = await getRepository(Media).save(
          new Media({ tmdbId: 551, tvdbId: 1235, mediaType: type }),
          { listeners: false }
        );
        await getRepository(MediaDestinationStatus).save(
          new MediaDestinationStatus({
            mediaId: other.id,
            serverId: 2,
            status: MediaStatus.AVAILABLE,
            externalServiceId: 22,
          })
        );
        mock.method(MediaRequest, 'sendNotification', async () => undefined);
        let entered!: () => void;
        let release!: () => void;
        const started = new Promise<void>((resolve) => {
          entered = resolve;
        });
        const remote = new Promise<void>((resolve) => {
          release = resolve;
        });
        t.after(() => release());
        const deletions: string[] = [];
        mock.method(
          axios,
          'create',
          () =>
            ({
              interceptors: {
                request: { use: () => 0 },
                response: { use: () => 0 },
              },
              get: async (path: string) => {
                const id = Number(path.split('/').at(-1));
                return {
                  data: {
                    id,
                    tmdbId: id === 12 ? 550 : 551,
                    tvdbId: id === 12 ? 1234 : 1235,
                  },
                };
              },
              delete: async (path: string) => {
                deletions.push(path);
                if (path.endsWith('/12')) {
                  entered();
                  await remote;
                }
                return {};
              },
            }) as unknown as AxiosInstance
        );
        const first = request(app)
          .delete(`/media/${media.id}/file?serverId=2`)
          .then((res) => res);
        await started;
        let attempted!: () => void;
        const secondAttempted = new Promise<void>((resolve) => {
          attempted = resolve;
        });
        const originalLock = dvrIdentityLocks.withDvrIdentityLock;
        mock.method(
          dvrIdentityLocks,
          'withDvrIdentityLock',
          (...args: Parameters<typeof originalLock>) => {
            attempted();
            return originalLock(...args);
          }
        );
        const second = request(app)
          .delete(`/media/${other.id}/file?serverId=2`)
          .then((res) => res);
        await secondAttempted;
        assert.deepEqual(deletions, [
          type === MediaType.MOVIE ? '/movie/12' : '/series/12',
        ]);
        release();
        assert.equal((await first).status, 204);
        assert.equal((await second).status, 204);
        assert.deepEqual(
          deletions,
          type === MediaType.MOVIE
            ? ['/movie/12', '/movie/22']
            : ['/series/12', '/series/22']
        );
      }
    );
    for (const lookup of ['mismatch', 'inconclusive', 'failed'] as const) {
      it(`does not delete or mutate DB when exact lookup is ${lookup}`, async () => {
        const { media } = await seedRemoval(type);
        const before = await removalSnapshot();
        const calls = arrMock(type, undefined, false, lookup);
        assert.equal(
          (await request(app).delete(`/media/${media.id}/file?serverId=2`))
            .status,
          500
        );
        assert.equal(
          calls.filter((call) => call.method === 'DELETE').length,
          0
        );
        assert.deepEqual(await removalSnapshot(), before);
      });
    }
    for (const is4k of [false, true]) {
      it(`isolates EN state, linkage, seasons and lifecycle (4K=${is4k})`, async () => {
        const { media } = await seedRemoval(type, is4k);
        const before = await removalSnapshot();
        const calls = arrMock(type);
        const result = await request(app).delete(
          `/media/${media.id}/file?serverId=2&is4k=${!is4k}`
        );
        assert.equal(result.status, 204);
        assert.ok(
          calls.every((call) => call.url === 'http://server-2:7878/api/v3')
        );
        assert.deepEqual(
          calls
            .filter((call) => call.method === 'DELETE')
            .map((call) => call.path),
          [type === MediaType.MOVIE ? '/movie/12' : '/series/12']
        );
        const after = await removalSnapshot();
        assert.deepEqual(after.media, before.media);
        assert.deepEqual(after.destinations[0], before.destinations[0]);
        assert.equal(after.destinations[1].status, MediaStatus.DELETED);
        assert.equal(after.destinations[1].externalServiceId, null);
        assert.equal(after.destinations[1].externalServiceSlug, null);
        assert.deepEqual(
          after.seasons.filter(
            (s) => s.destinationStatusId === before.destinations[0].id
          ),
          before.seasons.filter(
            (s) => s.destinationStatusId === before.destinations[0].id
          )
        );
        assert.ok(
          after.seasons
            .filter((s) => s.destinationStatusId === before.destinations[1].id)
            .every((s) => s.status === MediaStatus.DELETED)
        );
        assert.equal(after.requests[0].status, 3);
        for (let i = 1; i < before.requests.length; i++)
          assert.equal(after.requests[i].status, before.requests[i].status);
        assert.equal(after.seasonRequests.length, before.seasonRequests.length);
        for (let i = 0; i < before.seasonRequests.length; i++)
          assert.equal(
            after.seasonRequests[i].status,
            i === 0 ? 3 : before.seasonRequests[i].status
          );
        // Repeat through authoritative absence with no linkage remaining.
        mock.restoreAll();
        const repeatCalls = arrMock(type, undefined, true);
        assert.equal(
          (await request(app).delete(`/media/${media.id}/file?serverId=2`))
            .status,
          204
        );
        assert.equal(
          repeatCalls.filter((call) => call.method === 'DELETE').length,
          0
        );
        assert.deepEqual(
          (await removalSnapshot()).destinations[0],
          before.destinations[0]
        );
      });
    }
    for (const failure of [
      { code: 'ETIMEDOUT' },
      { code: 'ECONNRESET' },
      ...[401, 403, 500].map((status) => ({ response: { status } })),
    ]) {
      it(`preserves all DB state on remote failure ${JSON.stringify(failure)}`, async () => {
        const { media } = await seedRemoval(type);
        const before = await removalSnapshot();
        arrMock(type, failure);
        const notify = mock.method(
          MediaRequest,
          'sendNotification',
          async () => undefined
        );
        assert.equal(
          (await request(app).delete(`/media/${media.id}/file?serverId=2`))
            .status,
          500
        );
        assert.deepEqual(await removalSnapshot(), before);
        assert.equal(notify.mock.callCount(), 0);
      });
    }
    it('commits confirmed DELETE 404 absence', async () => {
      const { media } = await seedRemoval(type);
      arrMock(type, { response: { status: 404 } });
      assert.equal(
        (await request(app).delete(`/media/${media.id}/file?serverId=2`))
          .status,
        204
      );
      assert.equal(
        (
          await getRepository(MediaDestinationStatus).findOneByOrFail({
            mediaId: media.id,
            serverId: 2,
          })
        ).status,
        MediaStatus.DELETED
      );
    });
    for (const query of [
      '',
      '0',
      '-2',
      '1.2',
      'x',
      '2&serverId=1',
      '999',
      '9007199254740993',
    ]) {
      it(`rejects invalid/unconfigured explicit serverId=${query}`, async () => {
        const { media } = await seedRemoval(type);
        const before = await removalSnapshot();
        const calls = arrMock(type);
        assert.equal(
          (
            await request(app).delete(
              `/media/${media.id}/file?serverId=${query}`
            )
          ).status,
          400
        );
        assert.equal(calls.length, 0);
        assert.deepEqual(await removalSnapshot(), before);
      });
    }
    for (const variant of [
      'native',
      'deleted',
      'wrong-type',
      'missing-state',
      'invalid-linkage',
    ]) {
      it(`rejects ${variant} targets without fallback or DB mutation`, async () => {
        const { media } = await seedRemoval(type);
        const settings = getSettings();
        const servers =
          type === MediaType.MOVIE ? settings.radarr : settings.sonarr;
        if (variant === 'native')
          servers[1].independentRequestDestination = false;
        if (variant === 'deleted' || variant === 'wrong-type') {
          servers.splice(1, 1);
          if (variant === 'wrong-type') {
            if (type === MediaType.MOVIE) settings.sonarr = [removalServer(2)];
            else settings.radarr = [removalServer(2)];
          }
        }
        if (variant === 'missing-state')
          await getRepository(MediaDestinationStatus).delete({
            mediaId: media.id,
            serverId: 2,
          });
        if (variant === 'invalid-linkage')
          await getRepository(MediaDestinationStatus).update(
            { mediaId: media.id, serverId: 2 },
            { externalServiceId: -1 }
          );
        const before = await removalSnapshot();
        const calls = arrMock(type);
        assert.equal(
          (await request(app).delete(`/media/${media.id}/file?serverId=2`))
            .status,
          400
        );
        assert.equal(calls.length, 0);
        assert.deepEqual(await removalSnapshot(), before);
      });
    }
    it('requires MANAGE_REQUESTS', async () => {
      const { media } = await seedRemoval(type);
      const before = await removalSnapshot();
      const calls = arrMock(type);
      assert.equal(
        (
          await request(app)
            .delete(`/media/${media.id}/file?serverId=2`)
            .set('X-User', '2')
        ).status,
        403
      );
      assert.equal(calls.length, 0);
      assert.deepEqual(await removalSnapshot(), before);
    });
  });
}

describe('native compatibility and Clear Data', () => {
  for (const is4k of [false, true]) {
    it(`preserves native whole-series and season cleanup (4K=${is4k})`, async () => {
      const { media } = await seedRemoval(MediaType.TV);
      getSettings().sonarr.push(removalServer(is4k ? 98 : 99, false, is4k));
      const before = await removalSnapshot();
      const calls = arrMock(MediaType.TV);
      assert.equal(
        (await request(app).delete(`/media/${media.id}/file?is4k=${is4k}`))
          .status,
        204
      );
      const after = await removalSnapshot();
      assert.ok(
        calls.every(
          (call) => call.url === `http://server-${is4k ? 98 : 99}:7878/api/v3`
        )
      );
      assert.equal(
        after.media[0][is4k ? 'status4k' : 'status'],
        MediaStatus.DELETED
      );
      assert.equal(
        after.media[0].seasons[0][is4k ? 'status4k' : 'status'],
        MediaStatus.DELETED
      );
      assert.equal(
        after.media[0].seasons[0][is4k ? 'status' : 'status4k'],
        before.media[0].seasons[0][is4k ? 'status' : 'status4k']
      );
      assert.equal(
        after.media[0][is4k ? 'externalServiceId4k' : 'externalServiceId'],
        null
      );
      assert.deepEqual(after.destinations, before.destinations);
      assert.deepEqual(after.seasons, before.seasons);
    });
  }
  for (const is4k of [false, true]) {
    it(`preserves native removal (4K=${is4k}) and independent state`, async () => {
      const { media } = await seedRemoval();
      getSettings().radarr.push(removalServer(is4k ? 98 : 99, false, is4k));
      const before = await removalSnapshot();
      const calls = arrMock(MediaType.MOVIE);
      assert.equal(
        (await request(app).delete(`/media/${media.id}/file?is4k=${is4k}`))
          .status,
        204
      );
      const after = await removalSnapshot();
      assert.ok(
        calls.every(
          (call) => call.url === `http://server-${is4k ? 98 : 99}:7878/api/v3`
        )
      );
      assert.equal(
        after.media[0][is4k ? 'status4k' : 'status'],
        MediaStatus.DELETED
      );
      assert.equal(after.media[0][is4k ? 'serviceId4k' : 'serviceId'], null);
      assert.equal(
        after.media[0][is4k ? 'status' : 'status4k'],
        before.media[0][is4k ? 'status' : 'status4k']
      );
      assert.deepEqual(after.destinations, before.destinations);
    });
  }
  it('rejects an independent default on the native path', async () => {
    const { media } = await seedRemoval();
    await getRepository(Media).update(media.id, { serviceId: null });
    const before = await removalSnapshot();
    const calls = arrMock(MediaType.MOVIE);
    assert.equal(
      (await request(app).delete(`/media/${media.id}/file?is4k=false`)).status,
      409
    );
    assert.equal(calls.length, 0);
    assert.deepEqual(await removalSnapshot(), before);
  });
  it('re-resolves after waiting for configuration identity changes', async () => {
    const { media } = await seedRemoval();
    const before = await removalSnapshot();
    const calls = arrMock(MediaType.MOVIE);
    let release!: () => void;
    let started!: () => void;
    const ready = new Promise<void>((resolve) => {
      started = resolve;
    });
    const held = withDvrIdentityLock('radarr', 2, async () => {
      started();
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      getSettings().radarr = [removalServer(1)];
    });
    await ready;
    const result = request(app)
      .delete(`/media/${media.id}/file?serverId=2`)
      .then((response) => response);
    release();
    await held;
    assert.equal((await result).status, 400);
    assert.equal(calls.length, 0);
    assert.deepEqual(await removalSnapshot(), before);
  });
  it('cascades normal Clear Data without contacting Arr or other media', async () => {
    const { media } = await seedRemoval(MediaType.TV);
    const other = await getRepository(Media).save(
      new Media({ tmdbId: 999, mediaType: MediaType.MOVIE })
    );
    const otherDestination = await getRepository(MediaDestinationStatus).save(
      new MediaDestinationStatus({ mediaId: other.id, serverId: 1 })
    );
    const calls = arrMock(MediaType.TV);
    assert.equal((await request(app).delete(`/media/${media.id}`)).status, 204);
    assert.equal(
      await getRepository(MediaDestinationStatus).count({
        where: { mediaId: media.id },
      }),
      0
    );
    assert.equal(await getRepository(MediaDestinationSeasonStatus).count(), 0);
    assert.equal(await getRepository(MediaRequest).count(), 0);
    assert.deepEqual(
      await getRepository(MediaDestinationStatus).findOneBy({
        id: otherDestination.id,
      }),
      otherDestination
    );
    assert.equal(calls.length, 0);
  });
  it('preserves the BLOCKLISTED Clear Data exception', async () => {
    const { media } = await seedRemoval();
    await getRepository(Media).update(media.id, {
      status: MediaStatus.BLOCKLISTED,
    });
    const destinations = await getRepository(MediaDestinationStatus).find();
    const calls = arrMock(MediaType.MOVIE);
    assert.equal((await request(app).delete(`/media/${media.id}`)).status, 204);
    assert.equal(
      (await getRepository(Media).findOneByOrFail({ id: media.id })).status,
      MediaStatus.BLOCKLISTED
    );
    assert.deepEqual(
      await getRepository(MediaDestinationStatus).find(),
      destinations
    );
    assert.equal(calls.length, 0);
  });
});
