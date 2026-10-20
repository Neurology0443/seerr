import {
  applicationTables,
  migrateSqliteToPostgres,
  postgresOptionsFromEnv,
  runCli,
  utcTimestamp,
} from '@server/scripts/migrateSqliteToPostgres';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  copyFile,
  link,
  lstat,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { it, type TestContext } from 'node:test';
import type { QueryRunner } from 'typeorm';
import { DataSource } from 'typeorm';

const migrationRoot = path.resolve(__dirname, '../migration');
const secret = 'sensitive-sentinel-never-print';
const stamp = '2026-10-19 20:21:22.123456';
const settings = {
  clientId: 'client-sentinel',
  sessionSecret: secret,
  vapidPublic: 'public-sentinel',
  vapidPrivate: secret,
  main: { apiKey: secret },
  migrations: [
    '0007_migrate_arr_tags',
    '0008_migrate_blacklist_to_blocklist',
    '0009_add_independent_request_destination',
  ],
  radarr: [
    {
      id: 3,
      name: 'Movies',
      hostname: 'radarr.invalid',
      port: 7878,
      apiKey: secret,
      activeDirectory: '/movies',
      useSsl: false,
      is4k: false,
      isDefault: true,
      independentRequestDestination: true,
      syncEnabled: true,
    },
  ],
  sonarr: [
    {
      id: 4,
      name: 'TV',
      hostname: 'sonarr.invalid',
      port: 8989,
      apiKey: secret,
      activeDirectory: '/tv',
      useSsl: false,
      is4k: true,
      isDefault: true,
      independentRequestDestination: true,
      syncEnabled: true,
    },
  ],
  dvrIdCounters: { radarr: 100, sonarr: 100 },
};
const fakePg = {
  type: 'postgres' as const,
  host: '127.0.0.1',
  port: 1,
  username: 'unused',
  password: secret,
  database: 'unused',
};
const sqlite = (file: string) =>
  new DataSource({
    type: 'sqlite',
    database: file,
    entities: [],
    subscribers: [],
    synchronize: false,
    migrationsRun: false,
    dropSchema: false,
    migrations: [path.join(migrationRoot, 'sqlite/*.ts')],
  });
const inputs = async (db: string, config: string) => [
  await readFile(db),
  await readFile(config),
];

async function seed(file: string) {
  const db = sqlite(file);
  try {
    await db.initialize();
    await db.query('PRAGMA foreign_keys=OFF');
    await db.runMigrations();
    await db.query('PRAGMA foreign_keys=ON');
    await db.query(
      `INSERT INTO "user" (id, email, avatar, permissions, password, "recoveryLinkExpirationDate", "createdAt", "updatedAt") VALUES (1, 'one@example.invalid', 'avatar', 16777215, ?, ?, ?, ?), (2, 'two@example.invalid', 'avatar2', 0, NULL, NULL, ?, ?)`,
      [secret, stamp, stamp, stamp, stamp, stamp]
    );
    await db.query(
      `INSERT INTO user_settings (id, "userId", "notificationTypes", "discordIds", "telegramSendSilently", "watchlistSyncMovies", "watchlistSyncTv") VALUES (1, 1, ?, ?, 1, 0, NULL)`,
      ['{ "email": 2, "webpush": 4 }', '["123", "00456"]']
    );
    await db.query(
      `INSERT INTO user_push_subscription (id, endpoint, p256dh, auth, "userId", "createdAt") VALUES (1, 'https://one.invalid', ?, ?, 1, ?), (2, 'https://two.invalid', ?, ?, 2, NULL)`,
      [secret, secret, stamp, secret, secret]
    );
    await db.query(
      `INSERT INTO media (id, "mediaType", "tmdbId", status, status4k, "serviceId", "serviceId4k", "lastSeasonChange", "mediaAddedAt") VALUES (1, 'tv', 9001, 3, 5, 73, 4, ?, NULL), (2, 'movie', 9002, 5, 2, 3, 72, ?, ?)`,
      [stamp, '2026-10-19T22:21:22.123456+02:00', stamp]
    );
    await db.query(
      `INSERT INTO season (id, "mediaId", "seasonNumber", status, status4k) VALUES (1, 1, 1, 3, 5), (2, 1, 2, 1, 3)`
    );
    // All native lifecycle states, including a historical deleted destination.
    for (const [id, status] of [1, 2, 3, 4, 5].entries()) {
      await db.query(
        `INSERT INTO media_request (id, "mediaId", "requestedById", "modifiedById", type, status, "serverId", is4k, "isAutoRequest", "ignoreQuota", tags, "createdAt", "updatedAt") VALUES (?, ?, 1, 2, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          id + 1,
          id % 2 ? 2 : 1,
          id % 2 ? 'movie' : 'tv',
          status,
          id === 4 ? 73 : 4,
          id % 2,
          0,
          1,
          '4,2,004',
          stamp,
          stamp,
        ]
      );
      await db.query(
        `INSERT INTO season_request (id, "requestId", "seasonNumber", status) VALUES (?, ?, 1, ?)`,
        [id + 1, id + 1, status]
      );
    }
    await db.query(
      `INSERT INTO media_destination (id, "mediaId", "serverId", status, "externalServiceId", "externalServiceSlug", "createdAt", "updatedAt") VALUES (1, 1, 4, 5, 11, 'tv-a', ?, ?), (2, 1, 73, 3, 12, 'tv-b', ?, ?), (3, 2, 3, 5, 13, NULL, ?, ?), (4, 2, 72, 6, NULL, NULL, ?, ?)`,
      Array(8).fill(stamp)
    );
    await db.query(
      `INSERT INTO media_destination_season (id, "destinationStatusId", "seasonNumber", status) VALUES (1, 1, 1, 5), (2, 1, 2, 5), (3, 2, 1, 3), (4, 2, 2, 1)`
    );
    await db.query(
      `INSERT INTO watchlist (id, "ratingKey", "mediaType", title, "tmdbId", "requestedById", "mediaId") VALUES (1, 'key', 'tv', 'Title', 9001, 1, 1)`
    );
    await db.query(
      `INSERT INTO blocklist (id, "mediaType", "tmdbId", title, "userId", "mediaId", "blocklistedTags") VALUES (1, 'movie', 9002, 'Title', 1, 2, 'tag-a,tag-b')`
    );
    await db.query(
      `INSERT INTO issue (id, "issueType", "mediaId", "createdById", "modifiedById") VALUES (1, 1, 1, 1, 2)`
    );
    await db.query(
      `INSERT INTO issue_comment (id, message, "issueId", "userId") VALUES (1, ?, 1, 2)`,
      [secret]
    );
    await db.query(
      `INSERT INTO override_rule (id, "radarrServiceId", "sonarrServiceId", users, genre, tags) VALUES (1, 73, 4, '1,2', '18,28', '004,2')`
    );
    // More than one batch, with multiple empty generated tables tested below.
    for (let id = 1; id <= 205; id++)
      await db.query(
        `INSERT INTO discover_slider (id, type, "order", "isBuiltIn", enabled, title, data) VALUES (?, 1, ?, 0, 1, NULL, ?)`,
        [id, id, ' { "preserved": true } ']
      );
    await db.query(
      `INSERT INTO session (id, "expiredAt", json, "destroyedAt") VALUES ('session-A', 9007199254740993, ?, ?), ('session-a', 9223372036854775807, ?, NULL), ('é-session', 0, ?, ?)`,
      [secret, stamp, ' { "cookie": null } ', secret, '2026-10-19T20:21:22Z']
    );
    for (const table of applicationTables.filter((name) => name !== 'session'))
      await db.query('UPDATE sqlite_sequence SET seq = 500 WHERE name = ?', [
        table,
      ]);
    assert.deepEqual(await db.query('PRAGMA foreign_key_check'), []);
  } finally {
    if (db.isInitialized) await db.destroy();
  }
}

it('explicit connection settings and UTC timestamp conversion are strict', () => {
  for (const key of [
    'DB_TYPE',
    'DB_HOST',
    'DB_PORT',
    'DB_USER',
    'DB_PASS',
    'DB_NAME',
  ]) {
    const env: Partial<NodeJS.ProcessEnv> = {
      DB_TYPE: 'postgres',
      DB_HOST: '127.0.0.1',
      DB_PORT: '5432',
      DB_USER: 'user',
      DB_PASS: secret,
      DB_NAME: 'staging',
    };
    delete env[key];
    assert.throws(() => postgresOptionsFromEnv(env));
  }
  assert.equal(utcTimestamp(stamp), stamp);
  assert.equal(utcTimestamp('2026-10-19T22:21:22.123456+02:00'), stamp);
  assert.equal(
    utcTimestamp('2026-10-19T20:21:22Z'),
    '2026-10-19 20:21:22.000000'
  );
  for (const value of [
    '2026-02-30 01:00:00',
    '2026-01-01 24:00:00',
    '2026-01-01 12:00:00.1234567',
    'not a date',
  ])
    assert.throws(() => utcTimestamp(value));
});

async function cli(args: string[], env: Partial<NodeJS.ProcessEnv> = {}) {
  const child = spawn(
    process.execPath,
    [
      '-r',
      'ts-node/register',
      '-r',
      'tsconfig-paths/register',
      'server/scripts/migrateSqliteToPostgres.ts',
      ...args,
    ],
    {
      cwd: path.resolve(__dirname, '../..'),
      env: {
        ...process.env,
        ...env,
        TS_NODE_PROJECT: path.resolve(__dirname, '../tsconfig.json'),
      },
    }
  );
  let output = '';
  child.stdout.on('data', (data) => {
    output += data;
  });
  child.stderr.on('data', (data) => {
    output += data;
  });
  const code = await new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('close', resolve);
  });
  assert.ok(!output.includes(secret), 'CLI must not expose secrets.');
  return { code, output };
}

it('CLI reports configuration and argument failures with a nonzero exit', async () => {
  const usage = await cli([]);
  assert.equal(usage.code, 1);
  assert.match(usage.output, /Usage:/);
  const credentials = await cli(
    ['--sqlite', '/unused', '--settings', '/unused'],
    { DB_PASS: '' }
  );
  assert.equal(credentials.code, 1);
  assert.match(credentials.output, /DB_.*explicitly supplied/);
});

// Separate from other PostgreSQL test steps. Any opt-in, even malformed,
// requires the suite to execute and fail rather than silently skip.
const requested = Object.keys(process.env).some((key) =>
  key.startsWith('SEERR_TRANSFER_PG_')
);
it(
  'offline SQLite to PostgreSQL migration with real migrations and disposable cluster',
  {
    skip: requested
      ? false
      : 'Requires SEERR_TRANSFER_PG_* disposable PostgreSQL configuration.',
  },
  async (t) => {
    assert.equal(process.env.SEERR_TRANSFER_PG_DISPOSABLE, 'true');
    const port = Number(process.env.SEERR_TRANSFER_PG_PORT);
    assert.ok(Number.isInteger(port) && port > 0 && port <= 65535);
    const password = process.env.SEERR_TRANSFER_PG_PASSWORD;
    assert.ok(password);
    const connection = {
      type: 'postgres' as const,
      host: '127.0.0.1',
      port,
      username: 'seerr_migration_test',
      password,
      database: 'seerr_migration_control',
      ssl: false,
      connectTimeoutMS: 5000,
    };
    const control = new DataSource({
      ...connection,
      entities: [],
      subscribers: [],
      synchronize: false,
      migrationsRun: false,
      dropSchema: false,
    });
    const directory = await mkdtemp(path.join(tmpdir(), 'seerr-transfer-'));
    const baseline = path.join(directory, 'baseline.sqlite3');
    const config = path.join(directory, 'settings.json');
    let database: string | undefined;
    try {
      await control.initialize();
      assert.deepEqual(
        await control.query(
          `SELECT datname FROM pg_database WHERE NOT datistemplate ORDER BY datname`
        ),
        [{ datname: 'postgres' }, { datname: 'seerr_migration_control' }]
      );
      assert.deepEqual(
        await control.query(
          `SELECT n.nspname, c.relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname <> 'information_schema' AND n.nspname !~ '^pg_'`
        ),
        []
      );
      await seed(baseline);
      await writeFile(config, JSON.stringify(settings));

      async function staging(
        test: TestContext,
        run: (source: string, target: DataSource) => Promise<void>
      ) {
        database = `seerr_transfer_${randomUUID().replaceAll('-', '')}`;
        await control.query(`CREATE DATABASE "${database}" TEMPLATE template0`);
        const db = new DataSource({
          ...connection,
          database,
          entities: [],
          subscribers: [],
          synchronize: false,
          migrationsRun: false,
          dropSchema: false,
        });
        const file = path.join(directory, `${database}.sqlite3`);
        await copyFile(baseline, file);
        try {
          await db.initialize();
          await run(file, db);
        } finally {
          test.mock.restoreAll();
          if (db.isInitialized) await db.destroy();
          await control.query(`DROP DATABASE "${database}"`);
          database = undefined;
        }
      }
      const migrate = (file: string, db: DataSource) =>
        migrateSqliteToPostgres({
          sqlitePath: file,
          settingsPath: config,
          postgres: { ...connection, database: db.options.database as string },
        });

      await t.test(
        'preserves the complete dataset, all states, microseconds and ID high-water marks after reopening',
        async (test) =>
          staging(test, async (file, db) => {
            const before = await inputs(file, config);
            assert.equal((await lstat(file)).isSymbolicLink(), false);
            assert.equal((await lstat(file)).nlink, 1);
            const create = DataSource.prototype.initialize;
            test.mock.method(
              DataSource.prototype,
              'initialize',
              function (this: DataSource) {
                assert.deepEqual(this.options.entities, []);
                assert.deepEqual(this.options.subscribers, []);
                assert.equal(this.options.synchronize, false);
                assert.equal(this.options.dropSchema, false);
                assert.equal(this.options.migrationsRun, false);
                return create.call(this);
              }
            );
            const report = await migrate(file, db);
            assert.equal(report.validated, true);
            assert.deepEqual(
              Object.keys(report.counts).sort(),
              [...applicationTables].sort()
            );
            assert.equal(report.counts.discover_slider, 205);
            for (const count of Object.values(report.counts))
              assert.ok(count > 0);
            assert.deepEqual(await inputs(file, config), before);
            await assert.rejects(
              () => migrate(file, db),
              /destination is not empty/
            );
            await db.destroy();
            await db.initialize();
            assert.deepEqual(
              await db.query(
                `SELECT id, "expiredAt"::text AS expiration, "destroyedAt"::text AS destroyed FROM session ORDER BY id COLLATE "C"`
              ),
              [
                {
                  id: 'session-A',
                  expiration: '9007199254740993',
                  destroyed: stamp,
                },
                {
                  id: 'session-a',
                  expiration: '9223372036854775807',
                  destroyed: null,
                },
                {
                  id: 'é-session',
                  expiration: '0',
                  destroyed: '2026-10-19 20:21:22',
                },
              ]
            );
            assert.deepEqual(
              await db.query(
                `SELECT "serverId", status FROM media_destination WHERE "mediaId"=1 ORDER BY "serverId"`
              ),
              [
                { serverId: 4, status: 5 },
                { serverId: 73, status: 3 },
              ]
            );
            assert.deepEqual(
              await db.query(
                `SELECT "destinationStatusId", "seasonNumber", status FROM media_destination_season ORDER BY id`
              ),
              [
                { destinationStatusId: 1, seasonNumber: 1, status: 5 },
                { destinationStatusId: 1, seasonNumber: 2, status: 5 },
                { destinationStatusId: 2, seasonNumber: 1, status: 3 },
                { destinationStatusId: 2, seasonNumber: 2, status: 1 },
              ]
            );
            assert.deepEqual(
              await db.query(
                `SELECT id, status, "serverId" FROM media_request ORDER BY id`
              ),
              [1, 2, 3, 4, 5].map((status, index) => ({
                id: index + 1,
                status,
                serverId: index === 4 ? 73 : 4,
              }))
            );
            assert.equal(
              (
                await db.query(`SELECT "notificationTypes" FROM user_settings`)
              )[0].notificationTypes,
              '{ "email": 2, "webpush": 4 }'
            );
            assert.deepEqual(
              await db.query(
                `SELECT status, "status4k" FROM media ORDER BY id`
              ),
              [
                { status: 3, status4k: 5 },
                { status: 5, status4k: 2 },
              ]
            );
            assert.deepEqual(
              await db.query(
                `SELECT status, "status4k" FROM season ORDER BY id`
              ),
              [
                { status: 3, status4k: 5 },
                { status: 1, status4k: 3 },
              ]
            );
            assert.deepEqual(
              await db.query(
                `SELECT permissions, password, to_char("createdAt" AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS.US') AS created, to_char("updatedAt" AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS.US') AS updated, to_char("recoveryLinkExpirationDate" AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS.US') AS recovery FROM "user" WHERE id=1`
              ),
              [
                {
                  permissions: 16777215,
                  password: secret,
                  created: stamp,
                  updated: stamp,
                  recovery: stamp,
                },
              ]
            );
            assert.deepEqual(
              await db.query(
                `SELECT to_char("lastSeasonChange" AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS.US') AS changed, to_char("mediaAddedAt" AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS.US') AS added FROM media ORDER BY id`
              ),
              [
                { changed: stamp, added: null },
                { changed: stamp, added: stamp },
              ]
            );
            assert.equal(
              (await db.query(`SELECT tags FROM media_request WHERE id=1`))[0]
                .tags,
              '4,2,004'
            );
            assert.equal(
              (await db.query(`SELECT "discordIds" FROM user_settings`))[0]
                .discordIds,
              '["123", "00456"]'
            );
            const expectedMigrations = (
              await readdir(path.join(migrationRoot, 'postgres'))
            ).filter((name) => name.endsWith('.ts')).length;
            assert.equal(
              Number(
                (await db.query('SELECT count(*) FROM migrations'))[0].count
              ),
              expectedMigrations
            );
            for (const table of applicationTables.filter(
              (name) => name !== 'session'
            ))
              assert.equal(
                (
                  await db.query(
                    `SELECT nextval(pg_get_serial_sequence($1, 'id'))::text AS id`,
                    [`public."${table}"`]
                  )
                )[0].id,
                '501'
              );
            assert.equal(
              (
                await db.query(
                  `INSERT INTO "user" (email, avatar) VALUES ('new@example.invalid', 'avatar') RETURNING id`
                )
              )[0].id,
              502
            );
          })
      );

      await t.test(
        'handles empty tables and consumed identifiers in empty tables',
        async (test) =>
          staging(test, async (file, db) => {
            const source = sqlite(file);
            await source.initialize();
            try {
              await source.query('DELETE FROM issue_comment');
              await source.query('DELETE FROM issue');
              await source.query('DELETE FROM override_rule');
              await source.query(
                `DELETE FROM sqlite_sequence WHERE name='override_rule'`
              );
            } finally {
              await source.destroy();
            }
            const report = await migrate(file, db);
            assert.equal(report.counts.issue, 0);
            assert.equal(
              (
                await db.query(
                  `SELECT nextval(pg_get_serial_sequence('issue', 'id'))::text AS id`
                )
              )[0].id,
              '501'
            );
            assert.equal(
              (
                await db.query(
                  `SELECT nextval(pg_get_serial_sequence('override_rule', 'id'))::text AS id`
                )
              )[0].id,
              '1'
            );
          })
      );

      await t.test(
        'reads a standalone WAL-mode backup without creating sidecars, independent of local timezones',
        async (test) =>
          staging(test, async (file, db) => {
            const source = sqlite(file);
            await source.initialize();
            try {
              await source.query('PRAGMA journal_mode=WAL');
            } finally {
              await source.destroy();
            }
            const before = await inputs(file, config);
            const zone = process.env.TZ;
            process.env.TZ = 'Pacific/Honolulu';
            try {
              await db.query(
                `ALTER DATABASE "${db.options.database}" SET timezone TO 'Asia/Tokyo'`
              );
              await migrate(file, db);
            } finally {
              if (zone === undefined) delete process.env.TZ;
              else process.env.TZ = zone;
            }
            assert.deepEqual(await inputs(file, config), before);
            assert.deepEqual(
              (await readdir(directory)).filter((name) =>
                /-(wal|shm|journal)$/.test(name)
              ),
              []
            );
          })
      );
      await t.test(
        'rejects backup sidecars before modifying any destination schema',
        async (test) =>
          staging(test, async (file, db) => {
            await writeFile(file + '-wal', 'sidecar');
            const before = await inputs(file, config);
            try {
              await assert.rejects(() => migrate(file, db), /sidecar/);
              assert.deepEqual(await inputs(file, config), before);
              assert.deepEqual(
                await db.query(
                  `SELECT tablename FROM pg_tables WHERE schemaname='public'`
                ),
                []
              );
            } finally {
              await rm(file + '-wal');
            }
          })
      );
      for (const kind of ['symbolic link', 'hard link'])
        await t.test(
          `rejects a ${kind} to a valid backup before schema changes`,
          async (test) =>
            staging(test, async (file, db) => {
              const alias = file + '.alias';
              if (kind === 'symbolic link') await symlink(file, alias);
              else await link(file, alias);
              const before = await inputs(file, config);
              await assert.rejects(
                () => migrate(alias, db),
                /symbolic link|hard link/
              );
              // Both names of a multiply linked inode must be rejected.
              if (kind === 'hard link')
                await assert.rejects(() => migrate(file, db), /hard link/);
              assert.deepEqual(await inputs(file, config), before);
              assert.deepEqual(
                await db.query(
                  `SELECT tablename FROM pg_tables WHERE schemaname='public'`
                ),
                []
              );
            })
        );
      await t.test(
        'rejects aliases hiding real uncheckpointed WAL/SHM without modifying source files',
        async (test) =>
          staging(test, async (file, db) => {
            const source = sqlite(file);
            await source.initialize();
            try {
              await source.query('PRAGMA journal_mode=WAL');
              await source.query('PRAGMA wal_autocheckpoint=0');
              const checkpointed = await readFile(file);
              await source.query('UPDATE media SET status=6 WHERE id=1');
              assert.equal(
                (await source.query('SELECT status FROM media WHERE id=1'))[0]
                  .status,
                6
              );
              assert.deepEqual(
                await readFile(file),
                checkpointed,
                'The committed change must still be in the WAL.'
              );
              const aliases = await mkdtemp(path.join(directory, 'aliases-'));
              const alias = path.join(aliases, 'source.sqlite3');
              await symlink(file, alias);
              // A parent-directory alias must also check the actual database location.
              const parentAlias = path.join(aliases, 'parent');
              await symlink(path.dirname(file), parentAlias);
              const before = await Promise.all(
                [file, file + '-wal', file + '-shm', config].map((name) =>
                  readFile(name)
                )
              );
              assert.ok(before[1].length > 32 && before[2].length > 0);
              assert.deepEqual(await readdir(aliases), [
                'parent',
                'source.sqlite3',
              ]);
              await assert.rejects(() => migrate(alias, db), /symbolic link/);
              await assert.rejects(
                () => migrate(path.join(parentAlias, path.basename(file)), db),
                /sidecar/
              );
              assert.deepEqual(
                await Promise.all(
                  [file, file + '-wal', file + '-shm', config].map((name) =>
                    readFile(name)
                  )
                ),
                before
              );
              assert.deepEqual(
                await db.query(
                  `SELECT tablename FROM pg_tables WHERE schemaname='public'`
                ),
                []
              );
            } finally {
              await source.destroy();
            }
          })
      );
      for (const invalid of ['missing', 'corrupt', 'directory'])
        await t.test(`rejects ${invalid} settings file`, async (test) =>
          staging(test, async (file, db) => {
            const saved = await readFile(config);
            try {
              if (invalid === 'missing') await rm(config);
              if (invalid === 'corrupt')
                await writeFile(config, '{invalid json');
              await assert.rejects(
                () =>
                  migrateSqliteToPostgres({
                    sqlitePath: file,
                    settingsPath: invalid === 'directory' ? directory : config,
                    postgres: {
                      ...connection,
                      database: db.options.database as string,
                    },
                  }),
                /source preflight/
              );
              assert.deepEqual(
                await db.query(
                  `SELECT tablename FROM pg_tables WHERE schemaname='public'`
                ),
                []
              );
            } finally {
              await writeFile(config, saved);
            }
          })
        );

      const failures: [string, string | undefined, RegExp][] = [
        [
          'foreign key violation',
          'PRAGMA foreign_keys=OFF',
          /foreign_key_check/,
        ],
        [
          'incomplete migration history',
          'DELETE FROM migrations WHERE timestamp=1791000000000',
          /migration history/,
        ],
        ['unknown table', 'CREATE TABLE unexpected (id integer)', /structure/],
        [
          'unknown sqlite-prefixed table',
          'CREATE TABLE sqliteXhidden (id integer)',
          /structure/,
        ],
        [
          'unexpected trigger',
          'CREATE TRIGGER unexpected AFTER INSERT ON media BEGIN SELECT 1; END',
          /views or triggers/,
        ],
        [
          'oversized session key',
          `UPDATE session SET id=printf('%0300d', 1) WHERE id='session-A'`,
          /session.id/,
        ],
        [
          'blob in serialized text',
          `UPDATE session SET json=x'0102'`,
          /session.json/,
        ],
        [
          'unknown column',
          'ALTER TABLE media ADD COLUMN unexpected text',
          /structure/,
        ],
        [
          'invalid boolean',
          'UPDATE media_request SET is4k=2 WHERE id=1',
          /media_request.is4k/,
        ],
        [
          'int32 overflow',
          'UPDATE media SET "serviceId"=2147483648 WHERE id=1',
          /media.serviceId/,
        ],
        [
          'fractional integer',
          'UPDATE session SET "expiredAt"=1.5',
          /session.expiredAt/,
        ],
        [
          'timestamp precision loss',
          `UPDATE media SET "lastSeasonChange"='2026-01-01 01:00:00.1234567'`,
          /media.lastSeasonChange/,
        ],
        [
          'invalid date',
          `UPDATE "user" SET "recoveryLinkExpirationDate"='2026-02-30 01:00:00'`,
          /user.recoveryLinkExpirationDate/,
        ],
        [
          'unrepresentable text',
          `UPDATE issue_comment SET message=char(0)`,
          /issue_comment.message/,
        ],
        [
          'invalid UTF-8',
          `UPDATE issue_comment SET message=CAST(x'80' AS TEXT)`,
          /issue_comment.message/,
        ],
        [
          'sequence overflow',
          `UPDATE sqlite_sequence SET seq=2147483647 WHERE name='user'`,
          /AUTOINCREMENT/,
        ],
        ['corrupt file', undefined, /source preflight/],
        ['missing file', undefined, /source preflight/],
      ];
      for (const [label, sql, expected] of failures)
        await t.test(
          `rejects ${label} before changing PostgreSQL`,
          async (test) =>
            staging(test, async (file, db) => {
              if (sql) {
                const source = sqlite(file);
                await source.initialize();
                try {
                  await source.query(sql);
                  if (label === 'foreign key violation')
                    await source.query(
                      'UPDATE media_destination SET "mediaId"=99999 WHERE id=1'
                    );
                } finally {
                  await source.destroy();
                }
              } else if (label === 'corrupt file')
                await writeFile(file, 'not SQLite');
              else await rm(file);
              const before =
                label === 'missing file'
                  ? await readFile(config)
                  : await inputs(file, config);
              await assert.rejects(() => migrate(file, db), expected);
              assert.deepEqual(
                label === 'missing file'
                  ? await readFile(config)
                  : await inputs(file, config),
                before
              );
              assert.deepEqual(
                await db.query(
                  `SELECT tablename FROM pg_tables WHERE schemaname='public'`
                ),
                []
              );
            })
        );

      for (const [label, mutate] of [
        [
          'missing counter',
          (copy: typeof settings) => {
            delete (copy as Partial<typeof settings>).dvrIdCounters;
          },
        ],
        [
          'duplicate configured IDs',
          (copy: typeof settings) => {
            copy.radarr.push(copy.radarr[0]);
          },
        ],
        [
          'missing secret',
          (copy: typeof settings) => {
            copy.sessionSecret = '';
          },
        ],
        [
          'incomplete settings history',
          (copy: typeof settings) => {
            copy.migrations = [];
          },
        ],
      ] as const)
        await t.test(
          `rejects ${label} without modifying settings`,
          async (test) =>
            staging(test, async (file, db) => {
              const copy = structuredClone(settings);
              mutate(copy);
              await writeFile(config, JSON.stringify(copy));
              const before = await inputs(file, config);
              try {
                await assert.rejects(
                  () => migrate(file, db),
                  /source preflight/
                );
                assert.deepEqual(await inputs(file, config), before);
                assert.deepEqual(
                  await db.query(
                    `SELECT tablename FROM pg_tables WHERE schemaname='public'`
                  ),
                  []
                );
              } finally {
                await writeFile(config, JSON.stringify(settings));
              }
            })
        );

      for (const ddl of [
        'CREATE TABLE sentinel (id integer)',
        'CREATE SCHEMA occupied',
        'CREATE VIEW sentinel AS SELECT 1 AS id',
        'CREATE SEQUENCE sentinel',
        "CREATE TYPE sentinel AS ENUM ('value')",
        "CREATE FUNCTION sentinel() RETURNS integer LANGUAGE SQL AS 'SELECT 1'",
      ])
        await t.test(
          `rejects destination containing ${ddl.split(' ').slice(0, 2).join(' ')}`,
          async (test) =>
            staging(test, async (file, db) => {
              await db.query(ddl);
              const before = await inputs(file, config);
              await assert.rejects(
                () => migrate(file, db),
                /destination.*not empty|no custom schemas/
              );
              assert.deepEqual(await inputs(file, config), before);
              assert.deepEqual(
                await db.query(
                  `SELECT tablename FROM pg_tables WHERE schemaname='public' AND tablename='migrations'`
                ),
                []
              );
            })
        );

      for (const fault of [
        'mid-import',
        'unique conflict',
        'column verification',
        'transaction verification',
      ])
        await t.test(
          `rolls back application rows on ${fault} and rejects staging reuse`,
          async (test) =>
            staging(test, async (file, db) => {
              const before = await inputs(file, config);
              const create = DataSource.prototype.createQueryRunner;
              let inserted = 0;
              let tripped = false;
              test.mock.method(
                DataSource.prototype,
                'createQueryRunner',
                function (
                  this: DataSource,
                  ...args: Parameters<typeof create>
                ) {
                  const runner = create.apply(this, args);
                  const query = runner.query.bind(runner);
                  runner.query = (async (
                    sql: string,
                    parameters?: unknown[],
                    structured?: boolean
                  ) => {
                    if (sql.startsWith('INSERT INTO public.')) {
                      inserted++;
                      if (
                        fault === 'mid-import' &&
                        sql.startsWith('INSERT INTO public."media_request"')
                      ) {
                        tripped = true;
                        throw new Error(secret);
                      }
                      if (
                        fault === 'column verification' &&
                        sql.startsWith('INSERT INTO public."media_destination"')
                      ) {
                        const copy = [...parameters!];
                        const columns = /\((.*?)\) VALUES/
                          .exec(sql)![1]
                          .split(', ');
                        copy[columns.indexOf('"status"')] = '0';
                        tripped = true;
                        return structured
                          ? query(sql, copy, true)
                          : query(sql, copy);
                      }
                      if (
                        fault === 'unique conflict' &&
                        sql.startsWith('INSERT INTO public."user"')
                      ) {
                        // Corrupt only the transport, exercising the live PG unique constraint.
                        const copy = [...parameters!];
                        const columns = /\((.*?)\) VALUES/
                          .exec(sql)![1]
                          .split(', ');
                        const email = columns.indexOf('"email"');
                        copy[columns.length + email] = copy[email];
                        tripped = true;
                        return structured
                          ? query(sql, copy, true)
                          : query(sql, copy);
                      }
                    }
                    if (
                      !tripped &&
                      inserted > 0 &&
                      sql.startsWith('SELECT count(*)::text') &&
                      fault === 'transaction verification' &&
                      runner.isTransactionActive
                    ) {
                      tripped = true;
                      return [{ count: '-1' }];
                    }
                    return structured
                      ? query(sql, parameters, true)
                      : query(sql, parameters);
                  }) as QueryRunner['query'];
                  return runner;
                }
              );
              await assert.rejects(
                () => migrate(file, db),
                (error: Error) => {
                  assert.ok(!error.message.includes(secret));
                  assert.match(error.message, /data import|verification/);
                  return true;
                }
              );
              assert.ok(tripped && inserted > 0);
              test.mock.restoreAll();
              for (const table of applicationTables)
                assert.equal(
                  (
                    await db.query(
                      `SELECT count(*)::text AS count FROM "${table}"`
                    )
                  )[0].count,
                  '0'
                );
              assert.ok(
                Number(
                  (await db.query('SELECT count(*) FROM migrations'))[0].count
                ) > 0
              );
              await assert.rejects(
                () => migrate(file, db),
                /destination is not empty/
              );
              assert.deepEqual(await inputs(file, config), before);
            })
        );

      await t.test(
        'post-commit verification failure preserves imported and other-client data and fails the CLI',
        async (test) =>
          staging(test, async (file, db) => {
            const before = await inputs(file, config);
            const create = DataSource.prototype.createQueryRunner;
            let inserted = false;
            let afterCommit = false;
            const destructive: string[] = [];
            test.mock.method(
              DataSource.prototype,
              'createQueryRunner',
              function (this: DataSource, ...args: Parameters<typeof create>) {
                const runner = create.apply(this, args);
                const query = runner.query.bind(runner);
                const migrationConnection = this !== db;
                runner.query = (async (
                  sql: string,
                  parameters?: unknown[],
                  structured?: boolean
                ) => {
                  if (
                    migrationConnection &&
                    sql.startsWith('INSERT INTO public.')
                  )
                    inserted = true;
                  if (
                    migrationConnection &&
                    inserted &&
                    !afterCommit &&
                    !runner.isTransactionActive &&
                    sql.startsWith('SELECT count(*)::text')
                  ) {
                    afterCommit = true;
                    // This independent connection can only write after the import's
                    // ACCESS EXCLUSIVE locks have been released by a real commit.
                    await db.query(
                      `INSERT INTO "user" (id, email, avatar) VALUES (900, 'other-client@example.invalid', 'other-client')`
                    );
                  }
                  if (
                    migrationConnection &&
                    afterCommit &&
                    /^\s*(DELETE|TRUNCATE|DROP|ALTER|CREATE|UPDATE|INSERT|BEGIN|START TRANSACTION|ROLLBACK)\b/i.test(
                      sql
                    )
                  )
                    destructive.push(sql);
                  return structured
                    ? query(sql, parameters, true)
                    : query(sql, parameters);
                }) as QueryRunner['query'];
                return runner;
              }
            );
            const env = {
              DB_TYPE: 'postgres',
              DB_HOST: '127.0.0.1',
              DB_PORT: String(port),
              DB_USER: connection.username,
              DB_PASS: password,
              DB_NAME: db.options.database as string,
              DB_SOCKET_PATH: '',
              DB_USE_SSL: 'false',
            };
            const saved = Object.fromEntries(
              Object.keys(env).map((key) => [key, process.env[key]])
            );
            let output = '';
            test.mock.method(
              process.stdout,
              'write',
              (chunk: string | Uint8Array) => {
                output += String(chunk);
                return true;
              }
            );
            test.mock.method(
              process.stderr,
              'write',
              (chunk: string | Uint8Array) => {
                output += String(chunk);
                return true;
              }
            );
            let code: number;
            try {
              Object.assign(process.env, env);
              code = await runCli(['--sqlite', file, '--settings', config]);
            } finally {
              for (const [key, value] of Object.entries(saved)) {
                if (value === undefined) delete process.env[key];
                else process.env[key] = value;
              }
              test.mock.restoreAll();
            }
            assert.equal(code, 1);
            assert.ok(afterCommit);
            assert.deepEqual(
              destructive,
              [],
              'Post-commit failure must not issue compensating writes or resets.'
            );
            assert.match(output, /fresh connection verification/);
            assert.match(output, /invalid and not suitable for activation/);
            assert.ok(!output.includes(secret) && !output.includes(password));
            assert.ok(!output.includes('Verified all rows'));
            const source = sqlite(file);
            await source.initialize();
            try {
              for (const table of applicationTables) {
                const expected = (
                  await source.query(`SELECT count(*) AS count FROM "${table}"`)
                )[0].count;
                const actual = Number(
                  (
                    await db.query(
                      `SELECT count(*)::text AS count FROM "${table}"`
                    )
                  )[0].count
                );
                assert.equal(
                  actual,
                  expected + (table === 'user' ? 1 : 0),
                  `${table}: committed rows must be preserved`
                );
              }
            } finally {
              await source.destroy();
            }
            assert.equal(
              (await db.query(`SELECT avatar FROM "user" WHERE id=900`))[0]
                .avatar,
              'other-client'
            );
            await assert.rejects(
              () => migrate(file, db),
              /destination is not empty/
            );
            assert.deepEqual(await inputs(file, config), before);
          })
      );

      await t.test(
        'actual CLI fails on a non-empty staging destination without leaking secrets',
        async (test) =>
          staging(test, async (file, db) => {
            await db.query('CREATE TABLE sentinel (id integer)');
            const result = await cli(['--sqlite', file, '--settings', config], {
              DB_TYPE: 'postgres',
              DB_HOST: '127.0.0.1',
              DB_PORT: String(port),
              DB_USER: connection.username,
              DB_PASS: password,
              DB_NAME: db.options.database as string,
              DB_USE_SSL: 'false',
              DB_SOCKET_PATH: '',
            });
            assert.equal(result.code, 1);
            assert.match(result.output, /destination is not empty/);
            assert.ok(!result.output.includes(password));
          })
      );

      // No application module, entity listener, subscriber, job or Arr client was loaded.
      assert.deepEqual(
        Object.keys(require.cache).filter((file) =>
          /\/server\/(datasource\.|entity\/|subscriber\/|api\/|lib\/settings\/index\.)/.test(
            file
          )
        ),
        []
      );
      assert.deepEqual(
        (await readdir(directory)).filter((name) =>
          /-(wal|shm|journal)$/.test(name)
        ),
        []
      );
    } finally {
      try {
        if (database) await control.query(`DROP DATABASE "${database}"`);
      } finally {
        if (control.isInitialized) await control.destroy();
        await rm(directory, { recursive: true, force: true });
      }
    }
  }
);

// Preflight still rejects missing sources without needing any PostgreSQL server.
it('missing source never connects to the supplied PostgreSQL target', async () => {
  await assert.rejects(
    () =>
      migrateSqliteToPostgres({
        sqlitePath: '/definitely-missing-sqlite-backup',
        settingsPath: '/missing-settings',
        postgres: fakePg,
      }),
    /source preflight/
  );
});
