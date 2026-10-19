import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { it, type TestContext } from 'node:test';
import type { DataSourceOptions, QueryRunner } from 'typeorm';
import { DataSource, QueryFailedError } from 'typeorm';

const migrationRoot = path.resolve(__dirname, '../migration');
const destinationMigration = '1791000000000-AddMediaDestinationTables.ts';
const destinationTables = ['media_destination', 'media_destination_season'];

async function snapshotNative(queryRunner: QueryRunner) {
  const tables = (await queryRunner.getTables())
    .filter((table) => !destinationTables.includes(table.name))
    .sort((a, b) => a.name.localeCompare(b.name));
  return {
    tableNames: tables.map((table) => table.name),
    // Capture the entire native schema, not a blacklist of custom column names.
    schema: JSON.parse(JSON.stringify(tables)),
    data: await Promise.all(
      tables
        // Only migration bookkeeping may change. Preserve native SQLite
        // AUTOINCREMENT counters too, excluding the migration/custom counters.
        .filter((table) => table.name !== 'migrations')
        .map(async (table) => ({
          table: table.name,
          rows: await queryRunner.query(
            table.name === 'sqlite_sequence'
              ? `SELECT * FROM "sqlite_sequence" WHERE "name" NOT IN ('migrations', 'media_destination', 'media_destination_season') ORDER BY "name"`
              : `SELECT * FROM ${queryRunner.connection.driver.escape(table.name)} ORDER BY "id"`
          ),
        }))
    ),
  };
}

async function runMigrations(dataSource: DataSource) {
  // Match SQLite production startup; checks below run with FK enforcement ON.
  if (dataSource.options.type === 'sqlite') {
    await dataSource.query('PRAGMA foreign_keys=OFF');
    try {
      return await dataSource.runMigrations();
    } finally {
      await dataSource.query('PRAGMA foreign_keys=ON');
    }
  }
  return dataSource.runMigrations();
}

async function verifyMigrations(options: DataSourceOptions, t: TestContext) {
  const directory = path.join(migrationRoot, options.type);
  const files = (await readdir(directory))
    .filter((file) => file.endsWith('.ts'))
    .sort();
  assert.ok(files.includes(destinationMigration));
  const nativeMigrations = files
    .filter((file) => file !== destinationMigration)
    .map((file) => path.join(directory, file));
  assert.ok(nativeMigrations.length > 0);

  let dataSource = new DataSource({ ...options, migrations: nativeMigrations });
  let queryRunner: QueryRunner | undefined;
  try {
    await dataSource.initialize();
    assert.equal(
      (await runMigrations(dataSource)).length,
      nativeMigrations.length
    );
    queryRunner = dataSource.createQueryRunner();
    assert.equal(await queryRunner.hasTable('media_destination'), false);
    assert.equal(await queryRunner.hasTable('media_destination_season'), false);

    // Synthetic native history, inserted with SQL without entities/subscribers.
    await queryRunner.query(
      `INSERT INTO "user" ("id", "email", "username", "avatar") VALUES (1, 'migration@example.invalid', 'migration sentinel', 'avatar sentinel')`
    );
    await queryRunner.query(
      `INSERT INTO "media" ("id", "mediaType", "tmdbId", "status", "status4k") VALUES (1, 'tv', 91001, 3, 5), (2, 'movie', 91002, 2, 1)`
    );
    await queryRunner.query(
      `INSERT INTO "season" ("id", "mediaId", "seasonNumber", "status", "status4k") VALUES (1, 1, 1, 3, 5)`
    );
    await queryRunner.query(
      `INSERT INTO "media_request" ("id", "mediaId", "requestedById", "type", "status", "serverId", "is4k") VALUES (1, 1, 1, 'tv', 2, 73, false)`
    );
    await queryRunner.query(
      `INSERT INTO "season_request" ("id", "requestId", "seasonNumber", "status") VALUES (1, 1, 1, 2)`
    );
    const before = await snapshotNative(queryRunner);
    await queryRunner.release();
    queryRunner = undefined;
    await dataSource.destroy();

    // Reopen the same disposable DB with every real migration registered.
    dataSource = new DataSource({
      ...options,
      migrations: files.map((file) => path.join(directory, file)),
    });
    await dataSource.initialize();
    const applied = await runMigrations(dataSource);
    assert.deepEqual(
      applied.map((migration) => migration.name),
      ['AddMediaDestinationTables1791000000000']
    );
    queryRunner = dataSource.createQueryRunner();
    const db = queryRunner;

    await t.test(
      'creates only the destination tables and preserves native schema/data',
      async () => {
        assert.deepEqual(await snapshotNative(db), before);
        assert.deepEqual(
          (await db.getTables()).map((table) => table.name).sort(),
          [...before.tableNames, ...destinationTables].sort()
        );
        for (const [name, columns, unique, foreignKey] of [
          [
            'media_destination',
            [
              'id',
              'mediaId',
              'serverId',
              'status',
              'externalServiceId',
              'externalServiceSlug',
              'createdAt',
              'updatedAt',
            ],
            ['mediaId', 'serverId'],
            {
              columnNames: ['mediaId'],
              referencedTableName: 'media',
              referencedColumnNames: ['id'],
              onDelete: 'CASCADE',
            },
          ],
          [
            'media_destination_season',
            [
              'id',
              'destinationStatusId',
              'seasonNumber',
              'status',
              'createdAt',
              'updatedAt',
            ],
            ['destinationStatusId', 'seasonNumber'],
            {
              columnNames: ['destinationStatusId'],
              referencedTableName: 'media_destination',
              referencedColumnNames: ['id'],
              onDelete: 'CASCADE',
            },
          ],
        ] as const) {
          const table = await db.getTable(name);
          assert.ok(table);
          assert.deepEqual(
            table.columns.map((column) => column.name),
            [...columns]
          );
          assert.deepEqual(
            table.uniques.map((constraint) => constraint.columnNames),
            [[...unique]]
          );
          assert.deepEqual(
            table.foreignKeys.map(
              ({
                columnNames,
                referencedTableName,
                referencedColumnNames,
                onDelete,
              }) => ({
                columnNames,
                referencedTableName,
                referencedColumnNames,
                onDelete,
              })
            ),
            [foreignKey]
          );
        }
        const destination = await db.getTable('media_destination');
        assert.ok(
          destination?.indices.some(
            (index) =>
              index.name === 'IDX_media_destination_server' &&
              index.columnNames.join() === 'serverId'
          )
        );
      }
    );

    const rejectsConstraint =
      (kind: 'unique' | 'foreign key') => (error: unknown) => {
        if (!(error instanceof QueryFailedError)) return false;
        const driverError = error.driverError as {
          code: string;
          message: string;
        };
        return options.type === 'postgres'
          ? driverError.code === (kind === 'unique' ? '23505' : '23503')
          : driverError.code === 'SQLITE_CONSTRAINT' &&
              driverError.message.includes(
                kind === 'unique'
                  ? 'UNIQUE constraint failed'
                  : 'FOREIGN KEY constraint failed'
              );
      };

    await t.test(
      'enforces the composite uniques while allowing distinct pairs',
      async () => {
        await db.query(
          `INSERT INTO "media_destination" ("id", "mediaId", "serverId") VALUES (10, 1, 100), (11, 1, 101), (20, 2, 100)`
        );
        await assert.rejects(
          () =>
            db.query(
              `INSERT INTO "media_destination" ("id", "mediaId", "serverId") VALUES (99, 1, 100)`
            ),
          rejectsConstraint('unique')
        );
        await db.query(
          `INSERT INTO "media_destination_season" ("id", "destinationStatusId", "seasonNumber") VALUES (10, 10, 1), (11, 10, 2), (20, 11, 1), (30, 20, 1)`
        );
        await assert.rejects(
          () =>
            db.query(
              `INSERT INTO "media_destination_season" ("id", "destinationStatusId", "seasonNumber") VALUES (99, 10, 1)`
            ),
          rejectsConstraint('unique')
        );
      }
    );

    await t.test('rejects dangling foreign keys', async () => {
      if (options.type === 'sqlite') {
        assert.deepEqual(await db.query('PRAGMA foreign_keys'), [
          { foreign_keys: 1 },
        ]);
      }
      await assert.rejects(
        () =>
          db.query(
            `INSERT INTO "media_destination" ("id", "mediaId", "serverId") VALUES (99, 99999, 100)`
          ),
        rejectsConstraint('foreign key')
      );
      await assert.rejects(
        () =>
          db.query(
            `INSERT INTO "media_destination_season" ("id", "destinationStatusId", "seasonNumber") VALUES (99, 99999, 1)`
          ),
        rejectsConstraint('foreign key')
      );
    });

    await t.test(
      'cascades destination and media deletion without touching other rows',
      async () => {
        await db.query(`DELETE FROM "media_destination" WHERE "id" = 10`);
        assert.deepEqual(
          await db.query(
            `SELECT "id" FROM "media_destination_season" ORDER BY "id"`
          ),
          [{ id: 20 }, { id: 30 }]
        );
        assert.deepEqual(
          await db.query(`SELECT "id" FROM "media" ORDER BY "id"`),
          [{ id: 1 }, { id: 2 }]
        );
        await db.query(`DELETE FROM "media" WHERE "id" = 1`);
        assert.deepEqual(
          await db.query(`SELECT "id" FROM "media_destination" ORDER BY "id"`),
          [{ id: 20 }]
        );
        assert.deepEqual(
          await db.query(
            `SELECT "id" FROM "media_destination_season" ORDER BY "id"`
          ),
          [{ id: 30 }]
        );
        assert.deepEqual(
          await db.query(`SELECT "id" FROM "media" ORDER BY "id"`),
          [{ id: 2 }]
        );
        assert.equal((await db.query(`SELECT * FROM "user"`)).length, 1);
        if (options.type === 'sqlite') {
          assert.deepEqual(await db.query('PRAGMA foreign_key_check'), []);
        }
      }
    );
  } finally {
    await queryRunner?.release();
    if (dataSource.isInitialized) await dataSource.destroy();
  }
}

it('real SQLite file migrations', async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'seerr-migrations-'));
  try {
    await verifyMigrations(
      {
        type: 'sqlite',
        database: path.join(directory, 'migration.sqlite3'),
        entities: [],
        synchronize: false,
        migrationsRun: false,
        dropSchema: false,
      },
      t
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

// Only a newly provisioned disposable instance may opt in. No application DB_*
// variables, application datasource, schema synchronization or Cypress seeding.
const postgresRequested =
  Boolean(process.env.CI) ||
  Object.keys(process.env).some((key) => key.startsWith('SEERR_MIGRATION_PG_'));

it(
  'real PostgreSQL migrations',
  {
    skip: postgresRequested
      ? false
      : 'PostgreSQL not provisioned locally; requires a fresh disposable instance and SEERR_MIGRATION_PG_* configuration (mandatory in CI).',
  },
  async (t) => {
    assert.equal(
      process.env.SEERR_MIGRATION_PG_DISPOSABLE,
      'true',
      'A fresh disposable PostgreSQL instance must be explicitly configured, including in CI.'
    );
    const port = Number(process.env.SEERR_MIGRATION_PG_PORT);
    assert.ok(
      Number.isInteger(port) && port > 0 && port <= 65535,
      'SEERR_MIGRATION_PG_PORT is required.'
    );
    const password = process.env.SEERR_MIGRATION_PG_PASSWORD;
    assert.ok(password, 'SEERR_MIGRATION_PG_PASSWORD is required.');
    const options: DataSourceOptions = {
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
      entities: [],
      synchronize: false,
      migrationsRun: false,
      dropSchema: false,
    };
    const control = new DataSource(options);
    const database = `seerr_migration_${randomUUID().replaceAll('-', '')}`;
    let created = false;
    try {
      await control.initialize();
      // Refuse shared/populated instances before creating anything. All migration
      // SQL subsequently targets a DB created here from the pristine template0.
      assert.deepEqual(
        await control.query(
          `SELECT datname FROM pg_database WHERE NOT datistemplate ORDER BY datname`
        ),
        [{ datname: 'postgres' }, { datname: 'seerr_migration_control' }]
      );
      const queryRunner = control.createQueryRunner();
      try {
        assert.deepEqual(
          await queryRunner.getTables(),
          [],
          'The disposable control database must be empty.'
        );
      } finally {
        await queryRunner.release();
      }
      await control.query(`CREATE DATABASE "${database}" TEMPLATE template0`);
      created = true;
      await verifyMigrations({ ...options, database }, t);
    } finally {
      try {
        // Never reset/drop a supplied database, and never force other sessions off.
        if (created) await control.query(`DROP DATABASE "${database}"`);
      } finally {
        if (control.isInitialized) await control.destroy();
      }
    }
  }
);
