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

it(`request SQL and destination reconciliation on real ${postgres ? 'PostgreSQL' : 'SQLite'} after reopening persisted requests`, async (t) => {
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
          interceptors: {
            request: { use: () => 0 },
            response: { use: () => 0 },
          },
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

    const { default: Media } = await import('@server/entity/Media');
    const { default: SeasonRequest } =
      await import('@server/entity/SeasonRequest');
    const { MediaDestinationSeasonStatus } =
      await import('@server/entity/MediaDestinationSeasonStatus');
    const { radarrScanner } = await import('@server/lib/scanners/radarr');
    const { sonarrScanner } = await import('@server/lib/scanners/sonarr');
    const { runWithMockTimers } =
      await import('@server/test/runWithMockTimers');
    t.mock.method(MediaRequest, 'sendNotification', async () => undefined);
    // Keep another title in each inventory so cleanup is eligible, with no
    // metadata/network dependency and no changes to the omitted targets.
    await dataSource.getRepository(Media).update(2, { tvdbId: 92002 });
    t.mock.method(
      sonarrScanner.tmdb,
      'getTvShowForScan',
      async ({ tvId }: { tvId: number }) => ({
        id: tvId,
        keywords: { results: [] },
        seasons:
          tvId === 92004 ? [{ season_number: 1, episode_count: 10 }] : [],
      })
    );
    await dataSource.query(
      `INSERT INTO "season" ("mediaId", "seasonNumber", "status", "status4k") VALUES (4, 1, ${S.AVAILABLE}, ${S.PROCESSING})`
    );
    await dataSource
      .getRepository(MediaRequest)
      .createQueryBuilder()
      .insert()
      .values({
        id: 17,
        type: M.TV,
        media: { id: 4 },
        serverId: 3,
        status: R.APPROVED,
        requestedBy: { id: 1 },
      })
      .callListeners(false)
      .execute();
    await dataSource.getRepository(SeasonRequest).insert([
      { request: { id: 8 }, seasonNumber: 1, status: R.APPROVED },
      { request: { id: 9 }, seasonNumber: 1, status: R.APPROVED },
      { request: { id: 17 }, seasonNumber: 1, status: R.APPROVED },
    ]);
    const tvDestination = await dataSource
      .getRepository(MediaDestinationStatus)
      .findOneByOrFail({ mediaId: 4, serverId: 1 });
    await dataSource.getRepository(MediaDestinationSeasonStatus).insert({
      destinationStatusId: tvDestination.id,
      seasonNumber: 1,
      status: S.AVAILABLE,
    });
    const otherTvDestination = await dataSource
      .getRepository(MediaDestinationStatus)
      .save({
        mediaId: 4,
        serverId: 3,
        status: S.PROCESSING,
      });
    await dataSource.getRepository(MediaDestinationSeasonStatus).insert({
      destinationStatusId: otherTvDestination.id,
      seasonNumber: 1,
      status: S.PROCESSING,
    });
    const reconciliationSnapshot = async () =>
      Promise.all([
        ...['media', 'media_request', 'season_request', 'season'].map((table) =>
          dataSource.query(`SELECT * FROM "${table}" ORDER BY "id"`)
        ),
        dataSource.query(
          'SELECT * FROM "media_destination" WHERE "mediaId" IN (3, 4) ORDER BY "id"'
        ),
        dataSource.query(
          'SELECT * FROM "media_destination_season" ORDER BY "id"'
        ),
      ]);

    for (const type of [M.MOVIE, M.TV]) {
      const scanner = type === M.MOVIE ? radarrScanner : sonarrScanner;
      const targetId = type === M.MOVIE ? 3 : 1;
      getSettings().radarr =
        type === M.MOVIE
          ? [{ ...server(targetId, true), syncEnabled: true }]
          : [];
      getSettings().sonarr =
        type === M.TV
          ? ([
              { ...server(targetId, true), syncEnabled: true },
            ] as unknown as SonarrSettings[])
          : [];
      let inventory: unknown =
        type === M.MOVIE
          ? [
              {
                id: 900,
                tmdbId: 92001,
                hasFile: true,
                monitored: true,
                titleSlug: 'sentinel',
              },
            ]
          : [
              {
                id: 900,
                tvdbId: 92002,
                monitored: true,
                seasons: [],
                titleSlug: 'sentinel',
              },
            ];
      let exactResponse: unknown = [];
      let exactLookups = 0;
      t.mock.method(
        axios,
        'create',
        () =>
          ({
            interceptors: {
              request: { use: () => 0 },
              response: { use: () => 0 },
            },
            get: async (_url: string, config?: { params?: unknown }) => {
              if (config?.params) {
                exactLookups++;
                return { data: exactResponse };
              }
              return { data: inventory };
            },
          }) as unknown as AxiosInstance
      );
      // Warm the unrelated sentinel destination before comparing full snapshots.
      exactResponse =
        type === M.MOVIE
          ? [{ id: 42, tmdbId: 92003 }]
          : [{ id: 42, tvdbId: 92004 }];
      await dataSource.getRepository(Media).update(4, { tvdbId: 92004 });
      await runWithMockTimers(() => scanner.run());

      for (const status of [S.PROCESSING, S.AVAILABLE]) {
        await t.test(
          `${type} ${S[status]} preserves requests and every destination after malformed exact lookup`,
          async () => {
            await dataSource
              .getRepository(MediaDestinationStatus)
              .update(
                { mediaId: type === M.MOVIE ? 3 : 4, serverId: targetId },
                { status }
              );
            const beforeReconciliation = await reconciliationSnapshot();
            for (const records of [
              null,
              [null],
              [{}],
              [{ id: 42 }],
              [{ id: 42, tmdbId: '92003', tvdbId: '92004' }],
              [{ id: 0, tmdbId: 9999, tvdbId: 9999 }],
              [{ id: 42, tmdbId: 0, tvdbId: 0 }],
              [{ id: 42, tmdbId: 9999, tvdbId: 9999 }, {}],
            ]) {
              exactResponse = records;
              exactLookups = 0;
              await runWithMockTimers(() => scanner.run());
              assert.ok(
                exactLookups > 0,
                'The omitted target must be checked against its exact Arr instance.'
              );
              assert.deepEqual(
                await reconciliationSnapshot(),
                beforeReconciliation,
                `Invalid lookup mutated persisted state: ${JSON.stringify(records)}`
              );
            }
          }
        );
      }
      await t.test(
        `${type} malformed inventory cannot change availability or complete requests`,
        async () => {
          const trustedInventory = inventory;
          exactResponse =
            type === M.MOVIE
              ? [
                  { id: 900, tmdbId: 92001 },
                  { id: 42, tmdbId: 92003 },
                ]
              : [
                  { id: 900, tvdbId: 92002 },
                  { id: 42, tvdbId: 92004 },
                ];
          const beforeInventory = await reconciliationSnapshot();
          const observations =
            type === M.MOVIE
              ? [
                  { id: 42, tmdbId: 92003, monitored: false },
                  { id: 42, tmdbId: 92003, hasFile: 'false', monitored: true },
                  { id: 42, tmdbId: 92003, hasFile: false },
                ]
              : [
                  { totalEpisodeCount: 10 },
                  { totalEpisodeCount: 10, episodeFileCount: '0' },
                  { totalEpisodeCount: '10', episodeFileCount: 10 },
                ].map((statistics) => ({
                  id: 42,
                  tvdbId: 92004,
                  monitored: true,
                  seasons: [{ seasonNumber: 1, monitored: false, statistics }],
                }));
          try {
            for (const observation of observations) {
              inventory = [observation];
              await runWithMockTimers(() => scanner.run());
              assert.deepEqual(
                await reconciliationSnapshot(),
                beforeInventory,
                `Invalid inventory mutated persisted state: ${JSON.stringify(observation)}`
              );
            }
          } finally {
            inventory = trustedInventory;
          }
        }
      );
      await t.test(
        `${type} confirmed absence still reconciles only the exact destination`,
        async () => {
          const mediaId = type === M.MOVIE ? 3 : 4;
          const requestId = type === M.MOVIE ? 6 : 8;
          const destination = await dataSource
            .getRepository(MediaDestinationStatus)
            .findOneByOrFail({ mediaId, serverId: targetId });
          await dataSource
            .getRepository(MediaDestinationStatus)
            .update(destination.id, { status: S.PROCESSING });
          const beforeAbsence = await reconciliationSnapshot();
          exactResponse = [];
          await runWithMockTimers(() => scanner.run());
          assert.equal(
            (
              await dataSource
                .getRepository(MediaRequest)
                .findOneByOrFail({ id: requestId })
            ).status,
            R.DECLINED
          );
          const afterAbsence = await reconciliationSnapshot();
          // Only this approved request, its seasons and destination may change.
          const excludedIds = [[], [requestId], [], [], [destination.id], []];
          for (const index of [0, 1, 3, 4]) {
            const retain = (row: { id: number }) =>
              !excludedIds[index].includes(row.id);
            assert.deepEqual(
              afterAbsence[index].filter(retain),
              beforeAbsence[index].filter(retain)
            );
          }
          const retainSeasonRequest = (row: { requestId: number }) =>
            row.requestId !== requestId;
          assert.deepEqual(
            afterAbsence[2].filter(retainSeasonRequest),
            beforeAbsence[2].filter(retainSeasonRequest)
          );
          const retainDestinationSeason = (row: {
            destinationStatusId: number;
          }) => row.destinationStatusId !== destination.id;
          assert.deepEqual(
            afterAbsence[5].filter(retainDestinationSeason),
            beforeAbsence[5].filter(retainDestinationSeason)
          );
          if (type === M.TV) {
            assert.equal(
              (
                await dataSource
                  .getRepository(SeasonRequest)
                  .findOneByOrFail({ request: { id: requestId } })
              ).status,
              R.DECLINED
            );
            assert.equal(
              (
                await dataSource
                  .getRepository(MediaDestinationSeasonStatus)
                  .findOneByOrFail({
                    destinationStatusId: destination.id,
                    seasonNumber: 1,
                  })
              ).status,
              S.DELETED
            );
          }
        }
      );
    }
    for (const type of [M.MOVIE, M.TV]) {
      const mediaId = type === M.MOVIE ? 3 : 4;
      const invalidId = type === M.MOVIE ? 3 : 1;
      const validId = type === M.MOVIE ? 2 : 3;
      const requestId = type === M.MOVIE ? 5 : 17;
      const scanner = type === M.MOVIE ? radarrScanner : sonarrScanner;
      const configured = [invalidId, validId].map((id) => ({
        ...server(id, true),
        hostname: `correction-${id}`,
        syncEnabled: true,
      }));
      getSettings().radarr = type === M.MOVIE ? configured : [];
      getSettings().sonarr =
        type === M.TV ? (configured as unknown as SonarrSettings[]) : [];
      const destination = await dataSource
        .getRepository(MediaDestinationStatus)
        .findOneByOrFail({ mediaId, serverId: validId });
      await dataSource
        .getRepository(MediaDestinationStatus)
        .update(destination.id, { status: S.PROCESSING });
      if (type === M.TV)
        await dataSource
          .getRepository(MediaDestinationSeasonStatus)
          .update(
            { destinationStatusId: destination.id },
            { status: S.PROCESSING }
          );
      const validInventory =
        type === M.MOVIE
          ? [
              {
                id: 52,
                tmdbId: 92003,
                titleSlug: 'valid',
                hasFile: true,
                monitored: true,
              },
            ]
          : [
              {
                id: 52,
                tvdbId: 92004,
                titleSlug: 'valid',
                monitored: true,
                seasons: [
                  {
                    seasonNumber: 1,
                    monitored: true,
                    statistics: { totalEpisodeCount: 10, episodeFileCount: 10 },
                  },
                ],
              },
            ];
      const invalidInventories = [
        { label: 'malformed inventory', records: [{}] },
        ...(type === M.TV
          ? [
              {
                label: 'contradictory counters',
                records: [
                  {
                    id: 51,
                    tvdbId: 92004,
                    titleSlug: 'invalid',
                    monitored: true,
                    seasons: [
                      {
                        seasonNumber: 1,
                        monitored: false,
                        statistics: {
                          totalEpisodeCount: 10,
                          episodeFileCount: 11,
                        },
                      },
                    ],
                  },
                ],
              },
            ]
          : []),
      ];
      const protectedSnapshot = async () => {
        const rows = await reconciliationSnapshot();
        return [
          rows[0],
          rows[3],
          rows[1].filter((row: { id: number }) => row.id !== requestId),
          rows[2].filter(
            (row: { requestId: number }) => row.requestId !== requestId
          ),
          rows[4].filter((row: { id: number }) => row.id !== destination.id),
          rows[5].filter(
            (row: { destinationStatusId: number }) =>
              row.destinationStatusId !== destination.id
          ),
        ];
      };

      for (const invalid of invalidInventories) {
        await t.test(
          `${type} ${invalid.label} preserves A while B synchronizes on consecutive runs`,
          async (scenario) => {
            const scanned: number[] = [];
            let exactLookups = 0;
            let observedInventory: unknown = validInventory;
            t.mock.method(
              axios,
              'create',
              (options: { baseURL?: string }) =>
                ({
                  interceptors: {
                    request: { use: () => 0 },
                    response: { use: () => 0 },
                  },
                  get: async (_url: string, config?: { params?: unknown }) => {
                    if (config?.params) {
                      exactLookups++;
                      return { data: [] };
                    }
                    const id = options.baseURL?.includes(
                      `correction-${invalidId}:`
                    )
                      ? invalidId
                      : validId;
                    scanned.push(id);
                    return {
                      data:
                        id === invalidId ? invalid.records : observedInventory,
                    };
                  },
                }) as unknown as AxiosInstance
            );
            const before = await protectedSnapshot();
            if (type === M.TV && invalid.label === 'malformed inventory') {
              for (const [label, fileCount, expected] of [
                ['absent', undefined, S.PROCESSING],
                ['partial', 3, S.PARTIALLY_AVAILABLE],
              ] as const) {
                await scenario.test(
                  `valid B accepts ${label} statistics without completing an unsatisfied request`,
                  async () => {
                    observedInventory = [
                      {
                        id: 52,
                        tvdbId: 92004,
                        titleSlug: 'valid',
                        monitored: true,
                        seasons: [
                          {
                            seasonNumber: 1,
                            monitored: true,
                            statistics:
                              fileCount === undefined
                                ? undefined
                                : {
                                    totalEpisodeCount: 10,
                                    episodeFileCount: fileCount,
                                  },
                          },
                        ],
                      },
                    ];
                    await runWithMockTimers(() => scanner.run());
                    assert.deepEqual(scanned.slice(-2), [invalidId, validId]);
                    assert.equal(
                      (
                        await dataSource
                          .getRepository(MediaDestinationStatus)
                          .findOneByOrFail({ id: destination.id })
                      ).status,
                      expected
                    );
                    assert.equal(
                      (
                        await dataSource
                          .getRepository(MediaDestinationSeasonStatus)
                          .findOneByOrFail({
                            destinationStatusId: destination.id,
                            seasonNumber: 1,
                          })
                      ).status,
                      expected
                    );
                    assert.equal(
                      (
                        await dataSource
                          .getRepository(MediaRequest)
                          .findOneByOrFail({ id: requestId })
                      ).status,
                      R.APPROVED
                    );
                    assert.equal(
                      (
                        await dataSource
                          .getRepository(SeasonRequest)
                          .findOneByOrFail({ request: { id: requestId } })
                      ).status,
                      R.APPROVED
                    );
                    assert.deepEqual(await protectedSnapshot(), before);
                  }
                );
              }
              assert.deepEqual(scanned, [
                invalidId,
                validId,
                invalidId,
                validId,
              ]);
              scanned.length = 0;
              observedInventory = validInventory;
            }
            for (let run = 1; run <= 2; run++) {
              await runWithMockTimers(() => scanner.run());
              assert.deepEqual(
                scanned,
                Array.from({ length: run }, () => [invalidId, validId]).flat()
              );
              assert.equal(
                exactLookups,
                0,
                'Invalid A must not trigger orphan lookups.'
              );
              assert.equal(scanner.status().running, false);
              assert.deepEqual(await protectedSnapshot(), before);
              assert.equal(
                (
                  await dataSource
                    .getRepository(MediaDestinationStatus)
                    .findOneByOrFail({ id: destination.id })
                ).status,
                S.AVAILABLE
              );
              assert.equal(
                (
                  await dataSource
                    .getRepository(MediaRequest)
                    .findOneByOrFail({ id: requestId })
                ).status,
                R.COMPLETED
              );
              if (type === M.TV) {
                assert.equal(
                  (
                    await dataSource
                      .getRepository(MediaDestinationSeasonStatus)
                      .findOneByOrFail({
                        destinationStatusId: destination.id,
                        seasonNumber: 1,
                      })
                  ).status,
                  S.AVAILABLE
                );
                assert.equal(
                  (
                    await dataSource
                      .getRepository(SeasonRequest)
                      .findOneByOrFail({ request: { id: requestId } })
                  ).status,
                  R.COMPLETED
                );
              }
            }
          }
        );
      }
    }
    await t.test(
      'reconciliation states survive closing and reopening the database',
      async () => {
        const persisted = await reconciliationSnapshot();
        await dataSource.destroy();
        await dataSource.initialize();
        assert.deepEqual(await reconciliationSnapshot(), persisted);
      }
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
