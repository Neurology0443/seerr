import assert from 'node:assert/strict';
import type { TestContext } from 'node:test';
import { before, beforeEach, describe, it, mock } from 'node:test';

import ExternalAPI from '@server/api/externalapi';
import { MediaRequestStatus, MediaType } from '@server/constants/media';
import { getRepository } from '@server/datasource';
import Media from '@server/entity/Media';
import { MediaDestinationSeasonStatus } from '@server/entity/MediaDestinationSeasonStatus';
import { MediaDestinationStatus } from '@server/entity/MediaDestinationStatus';
import { MediaRequest } from '@server/entity/MediaRequest';
import { User } from '@server/entity/User';
import { Permission } from '@server/lib/permissions';
import { RequestTargetError } from '@server/lib/requestTarget';
import type { RadarrSettings, SonarrSettings } from '@server/lib/settings';
import { getSettings } from '@server/lib/settings';
import { MediaRequestSubscriber } from '@server/subscriber/MediaRequestSubscriber';
import { setupTestDb } from '@server/test/db';
import {
  dvrIdentityKey,
  withDvrIdentityLock,
} from '@server/utils/dvrIdentityLock';
import type { Express } from 'express';
import express from 'express';
import request from 'supertest';
import radarrRoutes from './radarr';
import sonarrRoutes from './sonarr';

type DvrKind = 'radarr' | 'sonarr';
type DvrSettings = RadarrSettings | SonarrSettings;

let app: Express;
let nextTmdbId = 70000;

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
      seasons: [],
      videos: { results: [{ type: 'Trailer', key: 'trailer' }] },
    };
  }
).mock;

mock.method(MediaRequest, 'sendNotification', async () => undefined);

setupTestDb();

before(() => {
  app = express();
  app.use(express.json());
  app.use('/radarr', radarrRoutes);
  app.use('/sonarr', sonarrRoutes);
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
  externalApiGetMock.resetCalls();
  const settings = getSettings();
  settings.radarr = [];
  settings.sonarr = [];
  settings.dvrIdCounters = { radarr: 0, sonarr: 0 };
});

const serverFixture = (
  kind: DvrKind,
  id: number,
  overrides: Partial<DvrSettings> = {}
): DvrSettings =>
  ({
    id,
    name: `${kind}-${id}`,
    hostname: 'localhost',
    port: kind === 'radarr' ? 7878 : 8989,
    apiKey: 'test',
    useSsl: false,
    activeProfileId: 1,
    activeProfileName: 'Any',
    activeDirectory: '/media',
    tags: [],
    is4k: false,
    isDefault: false,
    syncEnabled: false,
    independentRequestDestination: false,
    preventSearch: false,
    tagRequests: false,
    overrideRule: [],
    ...(kind === 'radarr'
      ? { minimumAvailability: 'released' }
      : {
          seriesType: 'standard',
          animeSeriesType: 'anime',
          enableSeasonFolders: true,
          monitorNewItems: 'all',
        }),
    ...overrides,
  }) as DvrSettings;

const setServers = (kind: DvrKind, servers: DvrSettings[]) => {
  const settings = getSettings();
  if (kind === 'radarr') {
    settings.radarr = servers as RadarrSettings[];
  } else {
    settings.sonarr = servers as SonarrSettings[];
  }
};

const getServers = (kind: DvrKind): DvrSettings[] =>
  kind === 'radarr' ? getSettings().radarr : getSettings().sonarr;

const serverPayload = (
  server: DvrSettings,
  overrides: Record<string, unknown> = {}
): Record<string, unknown> => {
  // IDs are path parameters for PUT and are assigned by the backend for POST.
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { id, ...payload } = server;
  return { ...payload, ...overrides };
};

const withoutIndependentFlag = (payload: Record<string, unknown>) => {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { independentRequestDestination, ...remaining } = payload;
  return remaining;
};

const mockSettingsSave = (t: TestContext) =>
  t.mock.method(getSettings(), 'save', async () => undefined);

const nextTurn = () => new Promise<void>((resolve) => setImmediate(resolve));

const pauseRequestBeforeInsert = (t: TestContext) => {
  const originalBeforeInsert = MediaRequestSubscriber.prototype.beforeInsert;
  let signalReached!: () => void;
  const reached = new Promise<void>((resolve) => {
    signalReached = resolve;
  });
  let resume!: () => void;
  const resumed = new Promise<void>((resolve) => {
    resume = resolve;
  });

  t.mock.method(
    MediaRequestSubscriber.prototype,
    'beforeInsert',
    async function (
      this: MediaRequestSubscriber,
      ...args: Parameters<typeof originalBeforeInsert>
    ) {
      signalReached();
      await resumed;
      return originalBeforeInsert.apply(this, args);
    }
  );

  return { reached, resume };
};

async function getPendingRequester(): Promise<User> {
  const requester = await getRepository(User).findOneByOrFail({ id: 1 });
  requester.permissions = Permission.REQUEST;
  requester.movieQuotaLimit = 10;
  return getRepository(User).save(requester);
}

const mediaTypeForKind = (kind: DvrKind) =>
  kind === 'radarr' ? MediaType.MOVIE : MediaType.TV;

async function seedHistoricalMedia(kind: DvrKind, serverId: number) {
  await getRepository(Media).save(
    new Media({
      mediaType: mediaTypeForKind(kind),
      tmdbId: nextTmdbId++,
      serviceId: serverId,
    })
  );
}

async function seedRequest(
  kind: DvrKind,
  serverId: number,
  status: MediaRequestStatus
) {
  const media = await getRepository(Media).save(
    new Media({
      mediaType: mediaTypeForKind(kind),
      tmdbId: nextTmdbId++,
    })
  );
  const requestedBy = await getRepository(User).findOneByOrFail({ id: 1 });
  await getRepository(MediaRequest)
    .createQueryBuilder()
    .insert()
    .into(MediaRequest)
    .values({
      status,
      type: mediaTypeForKind(kind),
      serverId,
      media,
      requestedBy,
      is4k: false,
    })
    .callListeners(false)
    .execute();
}

it('uses separate identity-lock namespaces for Radarr and Sonarr IDs', () => {
  assert.notStrictEqual(
    dvrIdentityKey('radarr', 5),
    dvrIdentityKey('sonarr', 5)
  );
});

for (const kind of ['radarr', 'sonarr'] as const) {
  describe(`${kind} destination settings`, () => {
    it('persists false when POST omits the independent flag', async (t) => {
      mockSettingsSave(t);
      const response = await request(app)
        .post(`/${kind}`)
        .send(withoutIndependentFlag(serverPayload(serverFixture(kind, 999))));

      assert.strictEqual(response.status, 201);
      assert.strictEqual(response.body.id, 0);
      assert.strictEqual(response.body.independentRequestDestination, false);
    });

    it('rejects independent POST without sync before allocating', async (t) => {
      mockSettingsSave(t);
      const response = await request(app)
        .post(`/${kind}`)
        .send(
          serverPayload(serverFixture(kind, 999), {
            independentRequestDestination: true,
            syncEnabled: false,
          })
        );

      assert.strictEqual(response.status, 400);
      assert.strictEqual(getSettings().dvrIdCounters[kind], 0);
      assert.strictEqual(getServers(kind).length, 0);
    });

    for (const invalidValue of ['true', null]) {
      it(`rejects POST independent value ${String(invalidValue)} before allocating`, async (t) => {
        mockSettingsSave(t);
        const response = await request(app)
          .post(`/${kind}`)
          .send(
            serverPayload(serverFixture(kind, 999), {
              independentRequestDestination: invalidValue,
            })
          );

        assert.strictEqual(response.status, 400);
        assert.strictEqual(getSettings().dvrIdCounters[kind], 0);
        assert.strictEqual(getServers(kind).length, 0);
      });
    }

    it('accepts independent POST with sync and native POST without sync', async (t) => {
      mockSettingsSave(t);
      const independent = await request(app)
        .post(`/${kind}`)
        .send(
          serverPayload(serverFixture(kind, 999), {
            independentRequestDestination: true,
            syncEnabled: true,
          })
        );
      const native = await request(app)
        .post(`/${kind}`)
        .send(
          serverPayload(
            serverFixture(kind, 999, { hostname: 'native-instance' })
          )
        );

      assert.strictEqual(independent.status, 201);
      assert.strictEqual(native.status, 201);
      assert.deepStrictEqual(
        getServers(kind).map((server) => server.id),
        [0, 1]
      );
      assert.strictEqual(
        await getRepository(MediaDestinationStatus).count(),
        0
      );
      assert.strictEqual(
        await getRepository(MediaDestinationSeasonStatus).count(),
        0
      );
    });

    it('rejects an independent POST sharing a native physical endpoint', async (t) => {
      const save = mockSettingsSave(t);
      const native = serverFixture(kind, 1);
      setServers(kind, [native]);

      const response = await request(app)
        .post(`/${kind}`)
        .send(
          serverPayload(serverFixture(kind, 999), {
            independentRequestDestination: true,
            syncEnabled: true,
          })
        );

      assert.strictEqual(response.status, 409);
      assert.deepStrictEqual(getServers(kind), [native]);
      assert.strictEqual(save.mock.callCount(), 0);
    });

    it('rejects a second independent POST sharing a physical endpoint', async (t) => {
      const save = mockSettingsSave(t);
      const independent = serverFixture(kind, 1, {
        independentRequestDestination: true,
        syncEnabled: true,
      });
      setServers(kind, [independent]);

      const response = await request(app)
        .post(`/${kind}`)
        .send(
          serverPayload(serverFixture(kind, 999), {
            independentRequestDestination: true,
            syncEnabled: true,
          })
        );

      assert.strictEqual(response.status, 409);
      assert.deepStrictEqual(getServers(kind), [independent]);
      assert.strictEqual(save.mock.callCount(), 0);
    });

    it('rejects a native PUT that collides with an independent endpoint', async (t) => {
      const save = mockSettingsSave(t);
      const independent = serverFixture(kind, 1, {
        hostname: 'independent-host',
        independentRequestDestination: true,
        syncEnabled: true,
      });
      const native = serverFixture(kind, 2, { hostname: 'native-host' });
      setServers(kind, [independent, native]);

      const response = await request(app)
        .put(`/${kind}/${native.id}`)
        .send(serverPayload(native, { hostname: independent.hostname }));

      assert.strictEqual(response.status, 409);
      assert.deepStrictEqual(getServers(kind), [independent, native]);
      assert.strictEqual(save.mock.callCount(), 0);
    });

    it('rejects an independent PUT that collides with another endpoint', async (t) => {
      const save = mockSettingsSave(t);
      const native = serverFixture(kind, 1, { hostname: 'native-host' });
      const independent = serverFixture(kind, 2, {
        hostname: 'independent-host',
        independentRequestDestination: true,
        syncEnabled: true,
      });
      setServers(kind, [native, independent]);

      const response = await request(app)
        .put(`/${kind}/${independent.id}`)
        .send(serverPayload(independent, { hostname: native.hostname }));

      assert.strictEqual(response.status, 409);
      assert.deepStrictEqual(getServers(kind), [native, independent]);
      assert.strictEqual(save.mock.callCount(), 0);
    });

    it('allows native duplicate physical endpoints as before', async (t) => {
      mockSettingsSave(t);
      const native = serverFixture(kind, 1);
      setServers(kind, [native]);

      const response = await request(app)
        .post(`/${kind}`)
        .send(serverPayload(serverFixture(kind, 999)));

      assert.strictEqual(response.status, 201);
      assert.strictEqual(getServers(kind).length, 2);
    });

    it('preserves the independent flag and ID when PUT omits it', async (t) => {
      mockSettingsSave(t);
      const currentServer = serverFixture(kind, 7, {
        independentRequestDestination: true,
        syncEnabled: true,
      });
      setServers(kind, [currentServer]);

      const response = await request(app)
        .put(`/${kind}/7`)
        .send(
          withoutIndependentFlag(
            serverPayload(currentServer, { name: 'renamed' })
          )
        );

      assert.strictEqual(response.status, 200);
      assert.strictEqual(response.body.id, 7);
      assert.strictEqual(response.body.independentRequestDestination, true);
    });

    if (kind === 'sonarr') {
      it('does not restore an optional field omitted from a complete PUT', async (t) => {
        mockSettingsSave(t);
        const currentServer = serverFixture(kind, 13, {
          activeAnimeProfileId: 42,
        } as Partial<SonarrSettings>);
        setServers(kind, [currentServer]);
        const payload = serverPayload(currentServer);
        delete payload.activeAnimeProfileId;

        const response = await request(app).put(`/${kind}/13`).send(payload);

        assert.strictEqual(response.status, 200);
        assert.ok(!('activeAnimeProfileId' in response.body));
        assert.ok(!('activeAnimeProfileId' in getServers(kind)[0]));
      });
    }

    it('accepts a valid boolean independent value on PUT', async (t) => {
      mockSettingsSave(t);
      const currentServer = serverFixture(kind, 11);
      setServers(kind, [currentServer]);

      const response = await request(app)
        .put(`/${kind}/11`)
        .send(
          serverPayload(currentServer, {
            independentRequestDestination: true,
            syncEnabled: true,
          })
        );

      assert.strictEqual(response.status, 200);
      assert.strictEqual(response.body.id, 11);
      assert.strictEqual(response.body.independentRequestDestination, true);
    });

    for (const invalidValue of ['false', null]) {
      it(`rejects PUT independent value ${String(invalidValue)} without mutation`, async (t) => {
        const save = mockSettingsSave(t);
        const currentServer = serverFixture(kind, 12);
        setServers(kind, [currentServer]);

        const response = await request(app)
          .put(`/${kind}/12`)
          .send(
            serverPayload(currentServer, {
              independentRequestDestination: invalidValue,
            })
          );

        assert.strictEqual(response.status, 400);
        assert.deepStrictEqual(getServers(kind), [currentServer]);
        assert.strictEqual(getServers(kind)[0].id, 12);
        assert.strictEqual(save.mock.callCount(), 0);
      });
    }

    it('blocks role changes after historical use but allows technical edits', async (t) => {
      mockSettingsSave(t);
      const currentServer = serverFixture(kind, 8);
      setServers(kind, [currentServer]);
      await seedHistoricalMedia(kind, 8);
      const historicalRequestLookup = t.mock.method(
        getRepository(MediaRequest),
        'existsBy'
      );

      const independentChange = await request(app)
        .put(`/${kind}/8`)
        .send(
          serverPayload(currentServer, {
            independentRequestDestination: true,
            syncEnabled: true,
          })
        );
      const is4kChange = await request(app)
        .put(`/${kind}/8`)
        .send(serverPayload(currentServer, { is4k: true }));
      const roleLookupCount = historicalRequestLookup.mock.callCount();
      const technicalChange = await request(app)
        .put(`/${kind}/8`)
        .send(serverPayload(currentServer, { hostname: 'new-host' }));

      assert.strictEqual(independentChange.status, 409);
      assert.strictEqual(is4kChange.status, 409);
      assert.strictEqual(roleLookupCount, 2);
      assert.strictEqual(technicalChange.status, 200);
      assert.strictEqual(technicalChange.body.hostname, 'new-host');
      assert.strictEqual(
        historicalRequestLookup.mock.callCount(),
        roleLookupCount
      );
    });

    it('uses the server identity lock for role changes', async (t) => {
      mockSettingsSave(t);
      const currentServer = serverFixture(kind, 14);
      setServers(kind, [currentServer]);
      let signalHeld!: () => void;
      const held = new Promise<void>((resolve) => {
        signalHeld = resolve;
      });
      let release!: () => void;
      const released = new Promise<void>((resolve) => {
        release = resolve;
      });
      const lock = withDvrIdentityLock(kind, 14, async () => {
        signalHeld();
        await released;
      });
      await held;

      let settled = false;
      const update = request(app)
        .put(`/${kind}/14`)
        .send(
          serverPayload(currentServer, {
            independentRequestDestination: true,
            syncEnabled: true,
          })
        )
        .then((response) => {
          settled = true;
          return response;
        });
      await nextTurn();
      await nextTurn();
      assert.strictEqual(settled, false);

      release();
      await lock;
      const response = await update;
      assert.strictEqual(response.status, 200);
      assert.strictEqual(response.body.independentRequestDestination, true);
    });

    it('uses the server identity lock for deletion', async (t) => {
      mockSettingsSave(t);
      setServers(kind, [serverFixture(kind, 15)]);
      let signalHeld!: () => void;
      const held = new Promise<void>((resolve) => {
        signalHeld = resolve;
      });
      let release!: () => void;
      const released = new Promise<void>((resolve) => {
        release = resolve;
      });
      const lock = withDvrIdentityLock(kind, 15, async () => {
        signalHeld();
        await released;
      });
      await held;

      let settled = false;
      const deletion = request(app)
        .delete(`/${kind}/15`)
        .then((response) => {
          settled = true;
          return response;
        });
      await nextTurn();
      await nextTurn();
      assert.strictEqual(settled, false);

      release();
      await lock;
      const response = await deletion;
      assert.strictEqual(response.status, 200);
      assert.strictEqual(getServers(kind).length, 0);
    });

    for (const status of [
      MediaRequestStatus.PENDING,
      MediaRequestStatus.APPROVED,
    ]) {
      it(`blocks DELETE with an exact active status ${status}`, async (t) => {
        mockSettingsSave(t);
        setServers(kind, [serverFixture(kind, 9)]);
        await seedRequest(kind, 9, status);

        const response = await request(app).delete(`/${kind}/9`);

        assert.strictEqual(response.status, 409);
        assert.strictEqual(getServers(kind).length, 1);
      });
    }

    for (const status of [
      MediaRequestStatus.COMPLETED,
      MediaRequestStatus.DECLINED,
      MediaRequestStatus.FAILED,
    ]) {
      it(`allows DELETE with only historical status ${status}`, async (t) => {
        mockSettingsSave(t);
        setServers(kind, [serverFixture(kind, 10)]);
        await seedRequest(kind, 10, status);

        const response = await request(app).delete(`/${kind}/10`);

        assert.strictEqual(response.status, 200);
        assert.strictEqual(getServers(kind).length, 0);
        assert.strictEqual(await getRepository(MediaRequest).count(), 1);
      });
    }
  });
}

describe('request creation identity locking', () => {
  for (const scenario of [
    {
      name: 'deletion',
      mutate: (server: DvrSettings) =>
        request(app).delete(`/radarr/${server.id}`),
    },
    {
      name: 'independent role change',
      mutate: (server: DvrSettings) =>
        request(app)
          .put(`/radarr/${server.id}`)
          .send(
            serverPayload(server, {
              independentRequestDestination: false,
            })
          ),
    },
    {
      name: '4K tier change',
      mutate: (server: DvrSettings) =>
        request(app)
          .put(`/radarr/${server.id}`)
          .send(serverPayload(server, { is4k: true })),
    },
  ]) {
    it(`holds the independent target stable against ${scenario.name}`, async (t) => {
      mockSettingsSave(t);
      const target = serverFixture('radarr', 30, {
        isDefault: true,
        syncEnabled: true,
        independentRequestDestination: true,
      });
      setServers('radarr', [target]);
      const requester = await getPendingRequester();
      const pause = pauseRequestBeforeInsert(t);

      const creation = MediaRequest.request(
        {
          mediaId: nextTmdbId++,
          mediaType: MediaType.MOVIE,
          serverId: target.id,
        },
        requester
      );
      await pause.reached;

      let mutationSettled = false;
      const mutation = scenario.mutate(target).then((response) => {
        mutationSettled = true;
        return response;
      });
      await nextTurn();
      await nextTurn();
      assert.strictEqual(mutationSettled, false);

      pause.resume();
      const created = await creation;
      const response = await mutation;

      assert.strictEqual(created.serverId, target.id);
      assert.strictEqual(response.status, 409);
      assert.strictEqual(
        await getRepository(MediaDestinationStatus).count({
          where: { mediaId: created.media.id, serverId: target.id },
        }),
        1
      );
      assert.strictEqual(getServers('radarr')[0].id, target.id);
      assert.strictEqual(
        getServers('radarr')[0].independentRequestDestination,
        true
      );
      assert.strictEqual(getServers('radarr')[0].is4k, false);
    });
  }

  it('rejects native creation when deletion wins before lock acquisition', async (t) => {
    mockSettingsSave(t);
    const target = serverFixture('radarr', 40, { isDefault: true });
    const fallback = serverFixture('radarr', 41, { isDefault: false });
    setServers('radarr', [target, fallback]);
    const requester = await getPendingRequester();
    let signalValidation!: () => void;
    const validationReached = new Promise<void>((resolve) => {
      signalValidation = resolve;
    });
    let resumeValidation!: () => void;
    const validationResumed = new Promise<void>((resolve) => {
      resumeValidation = resolve;
    });
    t.mock.method(getRepository(MediaRequest), 'existsBy', async () => {
      signalValidation();
      await validationResumed;
      return false;
    });

    const deletion = request(app).delete(`/radarr/${target.id}`);
    const deletionPromise = deletion.then((response) => response);
    await validationReached;
    const sendToRadarr = t.mock.method(
      MediaRequestSubscriber.prototype,
      'sendToRadarr',
      async () => undefined
    );
    const mediaId = nextTmdbId++;
    const creation = MediaRequest.request(
      {
        mediaId,
        mediaType: MediaType.MOVIE,
        serverId: target.id,
      },
      requester
    );
    const rejection = assert.rejects(creation, RequestTargetError);

    resumeValidation();
    const deletionResponse = await deletionPromise;
    assert.strictEqual(deletionResponse.status, 200);
    await rejection;
    assert.strictEqual(await getRepository(MediaRequest).count(), 0);
    assert.strictEqual(
      await getRepository(Media).count({
        where: { tmdbId: mediaId, mediaType: MediaType.MOVIE },
      }),
      0
    );
    assert.strictEqual(sendToRadarr.mock.callCount(), 0);
    assert.strictEqual(getServers('radarr')[0].id, fallback.id);
  });

  it('allows a default change without retargeting the locked creation', async (t) => {
    mockSettingsSave(t);
    const target = serverFixture('radarr', 50, {
      isDefault: true,
      syncEnabled: true,
      independentRequestDestination: true,
    });
    const nextDefault = serverFixture('radarr', 51, {
      hostname: 'next-default',
      syncEnabled: true,
      independentRequestDestination: true,
    });
    setServers('radarr', [target, nextDefault]);
    const requester = await getPendingRequester();
    const pause = pauseRequestBeforeInsert(t);

    const creation = MediaRequest.request(
      { mediaId: nextTmdbId++, mediaType: MediaType.MOVIE },
      requester
    );
    await pause.reached;

    const defaultChange = await request(app)
      .put(`/radarr/${nextDefault.id}`)
      .send(serverPayload(nextDefault, { isDefault: true }));
    assert.strictEqual(defaultChange.status, 200);
    assert.strictEqual(getServers('radarr')[1].isDefault, true);

    pause.resume();
    const created = await creation;
    assert.strictEqual(created.serverId, target.id);
    assert.strictEqual(
      await getRepository(MediaDestinationStatus).count({
        where: { mediaId: created.media.id, serverId: target.id },
      }),
      1
    );
    assert.strictEqual(
      await getRepository(MediaDestinationStatus).count({
        where: { mediaId: created.media.id, serverId: nextDefault.id },
      }),
      0
    );
  });
});
