import assert from 'node:assert/strict';
import type { TestContext } from 'node:test';
import { before, beforeEach, describe, it } from 'node:test';

import { MediaRequestStatus, MediaType } from '@server/constants/media';
import { getRepository } from '@server/datasource';
import Media from '@server/entity/Media';
import { MediaDestinationSeasonStatus } from '@server/entity/MediaDestinationSeasonStatus';
import { MediaDestinationStatus } from '@server/entity/MediaDestinationStatus';
import { MediaRequest } from '@server/entity/MediaRequest';
import { User } from '@server/entity/User';
import type { RadarrSettings, SonarrSettings } from '@server/lib/settings';
import { getSettings } from '@server/lib/settings';
import { setupTestDb } from '@server/test/db';
import type { Express } from 'express';
import express from 'express';
import request from 'supertest';
import radarrRoutes from './radarr';
import sonarrRoutes from './sonarr';

type DvrKind = 'radarr' | 'sonarr';
type DvrSettings = RadarrSettings | SonarrSettings;

let app: Express;
let nextTmdbId = 70000;

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

const withoutIndependentFlag = (server: DvrSettings) => {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { independentRequestDestination, ...payload } = server;
  return payload;
};

const mockSettingsSave = (t: TestContext) =>
  t.mock.method(getSettings(), 'save', async () => undefined);

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

for (const kind of ['radarr', 'sonarr'] as const) {
  describe(`${kind} destination settings`, () => {
    it('persists false when POST omits the independent flag', async (t) => {
      mockSettingsSave(t);
      const response = await request(app)
        .post(`/${kind}`)
        .send(withoutIndependentFlag(serverFixture(kind, 999)));

      assert.strictEqual(response.status, 201);
      assert.strictEqual(response.body.id, 0);
      assert.strictEqual(response.body.independentRequestDestination, false);
    });

    it('rejects independent POST without sync before allocating', async (t) => {
      mockSettingsSave(t);
      const response = await request(app)
        .post(`/${kind}`)
        .send(
          serverFixture(kind, 999, {
            independentRequestDestination: true,
            syncEnabled: false,
          })
        );

      assert.strictEqual(response.status, 400);
      assert.strictEqual(getSettings().dvrIdCounters[kind], 0);
      assert.strictEqual(getServers(kind).length, 0);
    });

    it('accepts independent POST with sync and native POST without sync', async (t) => {
      mockSettingsSave(t);
      const independent = await request(app)
        .post(`/${kind}`)
        .send(
          serverFixture(kind, 999, {
            independentRequestDestination: true,
            syncEnabled: true,
          })
        );
      const native = await request(app)
        .post(`/${kind}`)
        .send(serverFixture(kind, 999));

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

    it('preserves the independent flag and ID when PUT omits it', async (t) => {
      mockSettingsSave(t);
      setServers(kind, [
        serverFixture(kind, 7, {
          independentRequestDestination: true,
          syncEnabled: true,
        }),
      ]);

      const response = await request(app)
        .put(`/${kind}/7`)
        .send({ name: 'renamed' });

      assert.strictEqual(response.status, 200);
      assert.strictEqual(response.body.id, 7);
      assert.strictEqual(response.body.independentRequestDestination, true);
    });

    it('blocks role changes after historical use but allows technical edits', async (t) => {
      mockSettingsSave(t);
      setServers(kind, [serverFixture(kind, 8)]);
      await seedHistoricalMedia(kind, 8);

      const independentChange = await request(app).put(`/${kind}/8`).send({
        independentRequestDestination: true,
        syncEnabled: true,
      });
      const is4kChange = await request(app)
        .put(`/${kind}/8`)
        .send({ is4k: true });
      const technicalChange = await request(app)
        .put(`/${kind}/8`)
        .send({ hostname: 'new-host' });

      assert.strictEqual(independentChange.status, 409);
      assert.strictEqual(is4kChange.status, 409);
      assert.strictEqual(technicalChange.status, 200);
      assert.strictEqual(technicalChange.body.hostname, 'new-host');
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
