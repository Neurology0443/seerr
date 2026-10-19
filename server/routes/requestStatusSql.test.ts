import type { AxiosInstance } from 'axios';
import type { NextFunction, Request, Response } from 'express';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { it } from 'node:test';
import type { DataSourceOptions } from 'typeorm';
import { DataSource } from 'typeorm';

import type { RadarrSettings, SonarrSettings } from '@server/lib/settings';

// Separate opt-in from migration tests: CI runs this after those tests, on the
// same pristine disposable instance. Never use application DB_* credentials.
const postgres = Object.keys(process.env).some((key) =>
  key.startsWith('SEERR_REQUEST_PG_')
);

it(`request list/count SQL on real ${postgres ? 'PostgreSQL' : 'SQLite'} after reopening persisted requests`, async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'seerr-request-sql-'));
  const previousConfig = process.env.CONFIG_DIRECTORY;
  const previousDbType = process.env.DB_TYPE;
  process.env.CONFIG_DIRECTORY = directory;
  // Entity decorators resolve database-specific types at import time.
  process.env.DB_TYPE = postgres ? 'postgres' : 'sqlite';
  let control: DataSource | undefined;
  let created = false;
  let application: DataSource | undefined;
  const database = `seerr_requests_${randomUUID().replaceAll('-', '')}`;

  try {
    let options: DataSourceOptions = {
      type: 'sqlite',
      database: path.join(directory, 'requests.sqlite3'),
    };
    if (postgres) {
      assert.equal(process.env.SEERR_REQUEST_PG_DISPOSABLE, 'true');
      const port = Number(process.env.SEERR_REQUEST_PG_PORT);
      assert.ok(Number.isInteger(port) && port > 0 && port <= 65535);
      const password = process.env.SEERR_REQUEST_PG_PASSWORD;
      assert.ok(password, 'SEERR_REQUEST_PG_PASSWORD is required.');
      options = {
        type: 'postgres',
        host: '127.0.0.1',
        port,
        username: 'seerr_migration_test',
        password,
        database: 'seerr_migration_control',
        ssl: false,
        connectTimeoutMS: 5000,
        poolSize: 1,
        extra: { options: '-c statement_timeout=10000' },
      };
      control = new DataSource(options);
      await control.initialize();
      assert.deepEqual(
        await control.query(
          'SELECT datname FROM pg_database WHERE NOT datistemplate ORDER BY datname'
        ),
        [{ datname: 'postgres' }, { datname: 'seerr_migration_control' }]
      );
      assert.deepEqual(
        await control.query(`
          SELECT n.nspname, c.relname FROM pg_catalog.pg_class c
          JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname <> 'information_schema' AND n.nspname !~ '^pg_'
        `),
        []
      );
      await control.query(`CREATE DATABASE "${database}" TEMPLATE template0`);
      created = true;
      options = { ...options, database };
    }

    const { default: applicationDataSource } =
      await import('@server/datasource');
    const dataSource = new DataSource({
      ...options,
      entities: applicationDataSource.options.entities,
      subscribers: applicationDataSource.options.subscribers,
      synchronize: false,
      migrationsRun: false,
      dropSchema: false,
      migrations: [`server/migration/${options.type}/**/*.ts`],
    });
    application = dataSource;
    t.mock.method(
      applicationDataSource,
      'getRepository',
      dataSource.getRepository.bind(dataSource)
    );
    await dataSource.initialize();
    await dataSource.runMigrations();

    const {
      MediaRequestStatus: R,
      MediaStatus: S,
      MediaType: M,
    } = await import('@server/constants/media');
    const { MediaRequest } = await import('@server/entity/MediaRequest');
    const { MediaDestinationStatus } =
      await import('@server/entity/MediaDestinationStatus');
    const { User } = await import('@server/entity/User');
    const { getSettings } = await import('@server/lib/settings');
    const { default: axios } = await import('axios');
    t.mock.method(
      axios,
      'create',
      () =>
        ({
          interceptors: { request: { use: () => 0 } },
          get: async () => ({ data: [] }),
        }) as unknown as AxiosInstance
    );
    const server = (id: number, independent: boolean, is4k = false) =>
      ({
        id,
        name: `Server ${id}`,
        hostname: 'localhost',
        port: 7878,
        apiKey: 'test',
        is4k,
        independentRequestDestination: independent,
      }) as RadarrSettings;
    getSettings().radarr = [server(1, false), server(2, true), server(3, true)];
    // Deliberately overlap Radarr/Sonarr IDs with different destination roles.
    getSettings().sonarr = [
      server(1, true),
      server(2, false),
    ] as unknown as SonarrSettings[];

    // Synthetic persisted history: no request lifecycle or external Arr calls.
    await dataSource.query(
      `INSERT INTO "user" ("id", "email", "avatar", "permissions") VALUES (1, 'request-sql@example.invalid', '', 2)`
    );
    await dataSource.query(`INSERT INTO "media" ("id", "mediaType", "tmdbId", "status", "status4k") VALUES
      (1, 'movie', 92001, ${S.PROCESSING}, ${S.AVAILABLE}),
      (2, 'tv', 92002, ${S.AVAILABLE}, ${S.PROCESSING}),
      (3, 'movie', 92003, ${S.AVAILABLE}, ${S.AVAILABLE}),
      (4, 'tv', 92004, ${S.AVAILABLE}, ${S.AVAILABLE})`);
    const fixtures = (
      [
        // mediaId, type, serverId, is4k, request status, effective media status
        [1, M.MOVIE, 1, false, R.APPROVED, S.PROCESSING],
        [1, M.MOVIE, 1, true, R.COMPLETED, S.AVAILABLE],
        [2, M.TV, 2, false, R.COMPLETED, S.AVAILABLE],
        [2, M.TV, 2, true, R.APPROVED, S.PROCESSING],
        [3, M.MOVIE, 2, false, R.APPROVED, S.AVAILABLE],
        [3, M.MOVIE, 3, false, R.APPROVED, S.PROCESSING],
        [1, M.MOVIE, 2, true, R.APPROVED, S.UNKNOWN],
        [4, M.TV, 1, false, R.APPROVED, S.PARTIALLY_AVAILABLE],
        [2, M.TV, 1, true, R.APPROVED, S.UNKNOWN],
        [3, M.MOVIE, 99, false, R.COMPLETED, S.DELETED],
        [1, M.MOVIE, 98, true, R.COMPLETED, S.AVAILABLE],
        [1, M.MOVIE, null, true, R.APPROVED, S.AVAILABLE],
        [3, M.MOVIE, 3, false, R.PENDING, S.PROCESSING],
        [3, M.MOVIE, 3, false, R.DECLINED, S.PROCESSING],
        [3, M.MOVIE, 3, false, R.FAILED, S.PROCESSING],
        [3, M.MOVIE, 2, false, R.COMPLETED, S.AVAILABLE],
      ] as const
    ).map(([mediaId, type, serverId, is4k, status, effective], index) => ({
      id: index + 1,
      mediaId,
      type,
      serverId,
      is4k,
      status,
      effective,
    }));
    await dataSource
      .getRepository(MediaRequest)
      .createQueryBuilder()
      .insert()
      .values(
        fixtures.map((fixture) => ({
          id: fixture.id,
          type: fixture.type,
          is4k: fixture.is4k,
          status: fixture.status,
          serverId: fixture.serverId as number,
          media: { id: fixture.mediaId },
          requestedBy: { id: 1 },
        }))
      )
      .callListeners(false)
      .execute();
    await dataSource.getRepository(MediaDestinationStatus).insert([
      { mediaId: 3, serverId: 2, status: S.AVAILABLE },
      { mediaId: 3, serverId: 3, status: S.PROCESSING },
      { mediaId: 4, serverId: 1, status: S.PARTIALLY_AVAILABLE },
      { mediaId: 3, serverId: 99, status: S.DELETED },
      // Configured native server must ignore a stale destination row.
      { mediaId: 1, serverId: 1, status: S.DELETED },
    ]);
    await dataSource.destroy();
    await dataSource.initialize();

    const { default: express } = await import('express');
    const { default: request } = await import('supertest');
    const { default: routes } = await import('@server/routes/request');
    const app = express();
    const admin = await dataSource
      .getRepository(User)
      .findOneByOrFail({ id: 1 });
    app.use((req, _res, next) => {
      req.user = admin;
      next();
    });
    app.use('/api/v1/request', routes);
    app.use(
      (
        error: { message: string; status?: number },
        _req: Request,
        res: Response,
        // Express identifies error middleware by its four-argument signature.
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        _next: NextFunction
      ) => {
        res.status(error.status ?? 500).json({ message: error.message });
      }
    );
    const sql: string[] = [];
    t.mock.method(dataSource.logger, 'logQuery', (query: string) => {
      sql.push(query);
    });
    const snapshot = async () =>
      Promise.all(
        ['media', 'media_request', 'media_destination'].map((table) =>
          dataSource.query(`SELECT * FROM "${table}" ORDER BY "id"`)
        )
      );
    const before = await snapshot();
    const ids = (rows: { id: number }[]) =>
      rows.map(({ id }) => id).sort((a, b) => a - b);

    await t.test(
      'unfiltered list executes CASE and paginates before serialization',
      async () => {
        const response = await request(app).get(
          '/api/v1/request?take=2&skip=1&sortDirection=asc'
        );
        assert.equal(response.status, 200, JSON.stringify(response.body));
        assert.equal(response.body.pageInfo.results, fixtures.length);
        assert.deepEqual(ids(response.body.results), [2, 3]);
      }
    );
    for (const [filter, expected] of [
      [
        'available',
        fixtures.filter(
          (f) => f.status === R.COMPLETED && f.effective === S.AVAILABLE
        ),
      ],
      [
        'processing',
        fixtures.filter(
          (f) => f.status === R.APPROVED && f.effective !== S.AVAILABLE
        ),
      ],
      [
        'deleted',
        fixtures.filter(
          (f) => f.status === R.COMPLETED && f.effective === S.DELETED
        ),
      ],
    ] as const) {
      await t.test(
        `${filter} list preserves exact target and native status rules`,
        async () => {
          const response = await request(app).get(
            `/api/v1/request?filter=${filter}&take=100`
          );
          assert.equal(response.status, 200, JSON.stringify(response.body));
          assert.equal(response.body.pageInfo.results, expected.length);
          assert.deepEqual(ids(response.body.results), ids([...expected]));
          for (const row of response.body.results) {
            assert.equal(
              row.target.status,
              expected.find((f) => f.id === row.id)?.effective
            );
          }
        }
      );
    }
    await t.test(
      'counts preserve effective statuses and native lifecycle totals',
      async () => {
        const response = await request(app).get('/api/v1/request/count');
        assert.equal(response.status, 200, JSON.stringify(response.body));
        assert.deepEqual(response.body, {
          total: 16,
          movie: 12,
          tv: 4,
          pending: 1,
          approved: 8,
          declined: 1,
          processing: 6,
          available: 2,
          completed: 5,
        });
      }
    );
    await t.test(
      'generated joins and CASE/COALESCE quote the mixed-case alias',
      () => {
        const queries = sql.filter((query) =>
          query.includes('JOIN "media_destination" "targetDestination"')
        );
        assert.ok(
          queries.some((query) => query.includes('SELECT COUNT(DISTINCT'))
        );
        assert.ok(queries.some((query) => query.includes('COALESCE(')));
        for (const query of queries) {
          assert.doesNotMatch(query, /\btargetDestination\./);
          assert.match(query, /"targetDestination"\."mediaId"/);
          assert.match(query, /"targetDestination"\."serverId"/);
          if (query.includes('COALESCE(')) {
            assert.match(query, /COALESCE\("targetDestination"\."status",/);
            assert.match(
              query,
              /WHEN "targetDestination"\."id" IS NOT NULL THEN "targetDestination"\."status"/
            );
          }
        }
      }
    );
    await t.test(
      'custom mixed-case aliases preserve every effective status',
      async () => {
        const { addEffectiveTargetStatusJoin } =
          await import('@server/lib/requestTargetState');
        const query = dataSource
          .getRepository(MediaRequest)
          .createQueryBuilder('RequestAlias')
          .innerJoin('RequestAlias.media', 'MediaAlias');
        const status = addEffectiveTargetStatusJoin(query, {
          request: 'RequestAlias',
          media: 'MediaAlias',
          destination: 'HistoricalDestination',
        });
        const rows = await query
          .select('RequestAlias.id', 'id')
          .addSelect(status, 'status')
          .orderBy('RequestAlias.id', 'ASC')
          .getRawMany<{ id: number; status: number }>();
        assert.deepEqual(
          rows,
          fixtures.map((fixture) => ({
            id: fixture.id,
            status: fixture.effective,
          }))
        );
      }
    );
    assert.deepEqual(
      await snapshot(),
      before,
      'GET requests must not mutate persisted state.'
    );
  } finally {
    try {
      if (application?.isInitialized) await application.destroy();
      if (created) await control!.query(`DROP DATABASE "${database}"`);
    } finally {
      if (control?.isInitialized) await control.destroy();
      if (previousConfig === undefined) delete process.env.CONFIG_DIRECTORY;
      else process.env.CONFIG_DIRECTORY = previousConfig;
      if (previousDbType === undefined) delete process.env.DB_TYPE;
      else process.env.DB_TYPE = previousDbType;
      await rm(directory, { recursive: true, force: true });
    }
  }
});
