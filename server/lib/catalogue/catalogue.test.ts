import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { it, type TestContext } from 'node:test';
import type { QueryRunner } from 'typeorm';
import { DataSource } from 'typeorm';
import { createCatalogueDataSource } from './datasource';
import { catalogueEntityNames as names } from './entities';
import { CatalogueDatabase, CatalogueUnavailableError } from './lifecycle';
import {
  CatalogueIdentityConflictError,
  CatalogueRepository,
  assertSafeCanonicalGuid,
  saveSyncCheckpoint,
  upsertObservedTorrents,
} from './repository';
import type {
  CatalogueCategory,
  CatalogueTorrent,
  ObservedTorrent,
  SyncCheckpoint,
} from './types';

const instant = new Date('2026-10-24T12:00:00Z');
const later = new Date('2026-10-24T13:00:00Z');
const checkpoint = (trackerId = 'a', page = '1'): SyncCheckpoint => ({
  trackerId,
  categoryId: 5000,
  mode: 'recent',
  checkpoint: page,
  phase: 'page',
  status: 'idle',
  pagesProcessed: Number(page),
  cycleId: null,
  lastSuccessfulAt: instant,
  lastObservedAt: instant,
  updatedAt: instant,
  retryAfterAt: null,
  errorCode: null,
  lastHttpStatus: null,
});
const observation = (guid: string, trackerId = 'a'): ObservedTorrent => ({
  trackerId,
  canonicalGuid: guid,
  releaseName: 'Synthetic release',
  observedAt: instant,
});

async function verifyStorage(
  factory: () => DataSource,
  native: DataSource,
  t: TestContext
) {
  const postgres = native.options.type === 'postgres';
  const namespace = postgres ? '"catalogue".' : '';
  const nativeSnapshot = async () => ({
    users: await native.query('SELECT * FROM "user" ORDER BY "id"'),
    history: await native.query('SELECT * FROM "migrations" ORDER BY "id"'),
    schema: postgres
      ? await native.query(
          `SELECT table_name, column_name, data_type FROM information_schema.columns WHERE table_schema = 'public' ORDER BY table_name, ordinal_position`
        )
      : await native.query(
          `SELECT name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY name`
        ),
  });
  await native.query(
    `INSERT INTO "user" ("id", "email", "username", "avatar") VALUES (1, 'catalogue@example.invalid', 'native sentinel', 'sentinel')`
  );
  const before = await nativeSnapshot();
  const searchPath = postgres
    ? await native.query('SHOW search_path')
    : undefined;
  let connectionCount = 0;
  let database = new CatalogueDatabase(() => {
    connectionCount++;
    return factory();
  });
  try {
    assert.deepEqual(
      await Promise.all([
        database.initialize(),
        database.initialize(),
        database.initialize(),
      ]),
      [true, true, true]
    );
    assert.equal(connectionCount, 1);
    let db = database.getConnection();
    assert.equal(db.options.synchronize, false);
    assert.equal(db.subscribers.length, 0);
    assert.ok(
      db.entityMetadatas.every((entity) => entity.name.startsWith('Catalogue'))
    );
    assert.deepEqual(await db.runMigrations(), []);
    if (postgres) {
      assert.deepEqual(await db.query('SHOW search_path'), searchPath);
      assert.equal(
        (await db.query(`SELECT * FROM "catalogue"."catalogue_migrations"`))
          .length,
        1
      );
      assert.equal(
        (
          await db.query(
            `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'catalogue_migrations'`
          )
        ).length,
        0
      );
      assert.deepEqual(
        await db.query(
          `SELECT has_schema_privilege(current_user, 'catalogue', 'USAGE') AS "usageAllowed", has_schema_privilege(current_user, 'catalogue', 'CREATE') AS "createAllowed"`
        ),
        [{ usageAllowed: true, createAllowed: true }]
      );
    } else {
      assert.equal(
        (await db.query('PRAGMA journal_mode'))[0].journal_mode,
        'wal'
      );
      assert.equal((await db.query('PRAGMA foreign_keys'))[0].foreign_keys, 1);
      assert.equal(
        (await db.query('SELECT * FROM catalogue_migrations')).length,
        1
      );
      assert.equal(
        (await db.query(`SELECT name FROM sqlite_master WHERE name = 'media'`))
          .length,
        0
      );
    }
    const repository = new CatalogueRepository(db);
    for (const id of ['a', 'b', 'c'])
      await repository.saveTracker({
        id,
        name: id,
        connectorType: 'fixture',
        enabled: true,
      });

    await t.test(
      'seven torrents retain independent values, identities and many-to-many coverage',
      async () => {
        const seeders = [0, 5, 12, 0, 8, null, 2];
        const trackers = ['a', 'a', 'a', 'b', 'b', 'c', 'c'];
        const rows: CatalogueTorrent[] = [];
        for (let i = 0; i < seeders.length; i++) {
          const [row] = await repository.persistPage(
            [
              {
                ...observation(
                  i === 0 || i === 3 ? 'shared' : 'torrent-' + i,
                  trackers[i]
                ),
                seeders: seeders[i],
                categories: [5000, 5030, 5000],
              },
            ],
            checkpoint(trackers[i])
          );
          rows.push(row);
          const media = await repository.saveMediaAssociation({
            torrentId: row.id,
            mediaType: 'tv',
            idNamespace: 'tvdb',
            externalId: 91001,
            identificationStatus: i === 6 ? 'ambiguous' : 'resolved',
            provenance: 'fixture',
            parserVersion: null,
          });
          await repository.replaceCoverage(media.id, [
            {
              kind: 'season',
              completeness:
                i === 6 ? 'uncertain' : i === 5 ? 'incomplete' : 'presumed',
              seasonNumber: 1,
              episodeStart: null,
              episodeEnd: null,
              provenance: 'fixture',
            },
            ...(i === 0
              ? [
                  {
                    kind: 'season' as const,
                    completeness: 'verified' as const,
                    seasonNumber: 2,
                    episodeStart: null,
                    episodeEnd: null,
                    provenance: 'fixture',
                  },
                ]
              : []),
          ]);
        }
        assert.deepEqual(
          rows.map((row) => row.seeders),
          seeders
        );
        assert.equal(rows[0].seedersObservedAt?.getTime(), instant.getTime());
        assert.equal(rows[5].seedersObservedAt, null);
        assert.ok(
          rows.every(
            (row) =>
              row.leechers === null &&
              row.size === null &&
              row.publishedAt === null
          )
        );
        assert.notEqual(
          (await repository.findTorrentByGuid('a', 'shared'))?.id,
          (await repository.findTorrentByGuid('b', 'shared'))?.id
        );
        const media = await repository.findMediaAssociations({
          mediaType: 'tv',
          idNamespace: 'tvdb',
          externalId: 91001,
        });
        assert.equal(media.length, 7);
        assert.equal(
          (
            await repository.findCoverage(
              media.find((item) => item.torrentId === rows[0].id)!.id
            )
          ).length,
          2
        );
        assert.equal(
          media.filter((item) => item.identificationStatus === 'ambiguous')
            .length,
          1
        );
        assert.deepEqual(
          await Promise.all(
            media
              .slice(5)
              .map(
                async (item) =>
                  (await repository.findCoverage(item.id, 1))[0].completeness
              )
          ),
          ['incomplete', 'uncertain']
        );
        const categories = await db
          .getRepository<CatalogueCategory>(names.category)
          .findBy({ torrentId: rows[0].id });
        assert.deepEqual(
          categories.map((item) => item.categoryId).sort(),
          [5000, 5030]
        );
        const [unresolved] = await repository.persistPage(
          [observation('unresolved')],
          checkpoint()
        );
        assert.equal(
          await db
            .getRepository(names.media)
            .countBy({ torrentId: unresolved.id }),
          0
        );
      }
    );

    await t.test(
      'page replay, freshness, unknowns, explicit identity conflicts and atomic rollback',
      async () => {
        const record = {
          ...observation('replay'),
          infohash: 'a'.repeat(40),
          seeders: 9,
          categories: [5000],
          size: 9000000000,
          publishedAt: instant,
        };
        const [first] = await repository.persistPage(
          [record],
          checkpoint('a', '2')
        );
        const [replayed] = await repository.persistPage(
          [record, record],
          checkpoint('a', '2')
        );
        assert.equal(replayed.id, first.id);
        assert.equal(replayed.size, 9000000000);
        assert.equal(replayed.publishedAt?.getTime(), instant.getTime());
        const [updated] = await repository.persistPage(
          [
            {
              ...record,
              observedAt: later,
              infohash: null,
              seeders: null,
              categories: [5030],
            },
          ],
          checkpoint('a', '3')
        );
        assert.equal(updated.firstSeenAt.getTime(), instant.getTime());
        assert.equal(updated.lastSeenAt.getTime(), later.getTime());
        assert.equal(updated.seeders, null);
        assert.equal(updated.seedersObservedAt, null);
        assert.equal(updated.infohash, record.infohash);
        await repository.persistPage([record], checkpoint('a', '3'));
        assert.equal((await repository.findTorrent(first.id))?.seeders, null);
        assert.deepEqual(
          (
            await db
              .getRepository<CatalogueCategory>(names.category)
              .findBy({ torrentId: first.id })
          ).map((row) => row.categoryId),
          [5030]
        );
        assert.equal(
          (
            await repository.findTorrentByGuid('a', 'shared')
          )?.lastSeenAt.getTime(),
          instant.getTime()
        );
        await assert.rejects(
          repository.persistPage(
            [
              observation('rolled-back'),
              { ...record, infohash: 'b'.repeat(40) },
            ],
            checkpoint('a', '4')
          ),
          CatalogueIdentityConflictError
        );
        assert.equal(
          await repository.findTorrentByGuid('a', 'rolled-back'),
          null
        );
        assert.equal(
          (await repository.findSyncState('a', 5000, 'recent'))?.checkpoint,
          '3'
        );
        assert.equal(
          (await repository.findTorrent(first.id))?.infohash,
          record.infohash
        );
        await assert.rejects(
          repository.persistPage(
            [observation('https://tracker.invalid/download?apikey=SECRET')],
            checkpoint('a', '4')
          ),
          /Unsafe catalogue GUID/
        );
        assert.equal(
          (await repository.findSyncState('a', 5000, 'recent'))?.checkpoint,
          '3'
        );
        // Failure after an entire SQL chunk also rolls back the earlier chunk.
        const chunk = Array.from({ length: 55 }, (_, i) =>
          observation('chunk-' + i)
        );
        await assert.rejects(
          repository.persistPage(
            [...chunk, { ...record, infohash: 'c'.repeat(40) }],
            checkpoint('a', '4')
          ),
          CatalogueIdentityConflictError
        );
        assert.equal(await repository.findTorrentByGuid('a', 'chunk-0'), null);
        // A checkpoint constraint failure rolls back a successful torrent write.
        await assert.rejects(
          repository.persistPage([observation('bad-checkpoint')], {
            ...checkpoint(),
            pagesProcessed: -1,
          })
        );
        assert.equal(
          await repository.findTorrentByGuid('a', 'bad-checkpoint'),
          null
        );
        // Explicit manager API supports the required shared transaction boundary.
        await db.transaction(async (manager) => {
          await upsertObservedTorrents(manager, chunk);
          await saveSyncCheckpoint(manager, checkpoint('a', '4'));
        });
        assert.ok(await repository.findTorrentByGuid('a', 'chunk-54'));
        await assert.rejects(
          upsertObservedTorrents(db.manager, [record]),
          /active transaction/
        );
        await assert.rejects(
          saveSyncCheckpoint(db.manager, checkpoint()),
          /active transaction/
        );
        await Promise.all(
          ['parallel-1', 'parallel-2'].map((guid) =>
            repository.persistPage([observation(guid)], checkpoint())
          )
        );
        assert.equal(
          (await repository.findTrackerTorrents('a', 0, 1000)).length,
          62
        );
      }
    );

    await t.test(
      'database constraints and destination identities',
      async () => {
        await assert.rejects(
          repository.persistPage(
            [observation('orphan', 'missing')],
            checkpoint('missing')
          )
        );
        const first = await repository.findTorrentByGuid('a', 'shared');
        assert.ok(first);
        await assert.rejects(
          db.getRepository(names.torrent).insert({ ...first, id: undefined })
        );
        await assert.rejects(
          db.getRepository(names.torrent).update(first.id, { seeders: -1 })
        );
        await assert.rejects(
          db
            .getRepository(names.category)
            .insert({ torrentId: first.id, categoryId: 5000 })
        );
        const media = (
          await repository.findMediaAssociations({
            mediaType: 'tv',
            idNamespace: 'tvdb',
            externalId: 91001,
          })
        )[0];
        await assert.rejects(
          repository.replaceCoverage(media.id, [
            {
              kind: 'range',
              completeness: 'verified',
              seasonNumber: 1,
              episodeStart: 3,
              episodeEnd: 2,
              provenance: 'fixture',
            },
          ])
        );
        assert.equal((await repository.findCoverage(media.id)).length, 2);
        for (const arrType of ['radarr', 'sonarr'] as const) {
          const indexer = await repository.saveDestinationIndexer({
            arrType,
            serverId: 0,
            indexerId: 1,
            name: null,
            observedAt: instant,
            state: 'unverified',
          });
          await repository.saveDestinationTrackerLink({
            destinationIndexerId: indexer.id,
            trackerId: 'a',
            observedAt: instant,
            state: 'unverified',
          });
        }
        assert.equal(await db.getRepository(names.indexer).count(), 2);
        assert.equal(await db.getRepository(names.link).count(), 2);
        await db.getRepository(names.indexer).delete({ arrType: 'radarr' });
        assert.equal(await db.getRepository(names.link).count(), 1);
      }
    );

    await t.test(
      'all explicit coverage forms and collection modes remain distinguishable',
      async () => {
        const [torrent] = await repository.persistPage(
          [observation('coverage')],
          { ...checkpoint('a', '2'), mode: 'historical' }
        );
        assert.equal(
          (await repository.findSyncState('a', 5000, 'historical'))?.checkpoint,
          '2'
        );
        assert.equal(
          (await repository.findSyncState('a', 5000, 'recent'))?.checkpoint,
          '1'
        );
        const movie = await repository.saveMediaAssociation({
          torrentId: torrent.id,
          mediaType: 'movie',
          idNamespace: 'tmdb',
          externalId: 91002,
          identificationStatus: 'resolved',
          provenance: 'explicit fixture',
          parserVersion: null,
        });
        await repository.replaceCoverage(movie.id, [
          {
            kind: 'movie',
            completeness: 'verified',
            seasonNumber: null,
            episodeStart: null,
            episodeEnd: null,
            provenance: 'fixture',
          },
        ]);
        const tv = await repository.saveMediaAssociation({
          torrentId: torrent.id,
          mediaType: 'tv',
          idNamespace: 'tmdb',
          externalId: 91003,
          identificationStatus: 'ambiguous',
          provenance: 'explicit fixture',
          parserVersion: 'fixture-v1',
        });
        await repository.replaceCoverage(tv.id, [
          {
            kind: 'episode',
            completeness: 'verified',
            seasonNumber: 0,
            episodeStart: 1,
            episodeEnd: 1,
            provenance: 'fixture',
          },
          {
            kind: 'range',
            completeness: 'incomplete',
            seasonNumber: 1,
            episodeStart: 2,
            episodeEnd: 5,
            provenance: 'fixture',
          },
          {
            kind: 'partial',
            completeness: 'uncertain',
            seasonNumber: 2,
            episodeStart: null,
            episodeEnd: null,
            provenance: 'fixture',
          },
          {
            kind: 'unknown',
            completeness: 'uncertain',
            seasonNumber: null,
            episodeStart: null,
            episodeEnd: null,
            provenance: 'fixture',
          },
        ]);
        assert.equal(
          (await repository.findCoverage(movie.id))[0].kind,
          'movie'
        );
        assert.deepEqual(
          (await repository.findCoverage(tv.id)).map((row) => row.kind).sort(),
          ['episode', 'partial', 'range', 'unknown']
        );
        assert.equal(
          (await repository.findCoverage(tv.id, 0))[0].episodeEnd,
          1
        );
      }
    );

    await t.test('representative lookups use indexes', async () => {
      await repository.persistPage(
        Array.from({ length: 1200 }, (_, i) => observation('plan-' + i)),
        checkpoint()
      );
      const torrents = await repository.findTrackerTorrents('a', 0, 1000);
      await db.transaction(async (manager) => {
        await manager.getRepository(names.media).insert(
          torrents.map((row, i) => ({
            torrentId: row.id,
            mediaType: 'tv',
            idNamespace: 'tvdb',
            externalId: 100000 + i,
            identificationStatus: 'resolved',
            provenance: 'fixture',
            parserVersion: null,
          }))
        );
        const media = await manager
          .getRepository(names.media)
          .findBy({ provenance: 'fixture' });
        await manager.getRepository(names.coverage).insert(
          media.map((row) => ({
            mediaAssociationId: row.id,
            kind: 'season',
            completeness: 'presumed',
            seasonNumber: 1,
            episodeStart: null,
            episodeEnd: null,
            provenance: 'fixture',
          }))
        );
        // Spread scopes across categories to give the planner a representative table.
        await manager.getRepository(names.sync).insert(
          Array.from({ length: 1000 }, (_, i) => ({
            ...checkpoint(),
            categoryId: 10000 + i,
          }))
        );
      });
      if (postgres)
        await db.query(
          'ANALYZE "catalogue"."torrents", "catalogue"."torrent_media", "catalogue"."torrent_coverage", "catalogue"."sync_state"'
        );
      const queries = [
        [
          'torrents',
          '"tracker_id" = \'a\' AND "canonical_guid" = \'shared\'',
          'UQ_catalogue_torrent_identity',
        ],
        [
          'torrent_media',
          '"media_type" = \'tv\' AND "id_namespace" = \'tvdb\' AND "external_id" = 100001',
          'IDX_catalogue_media_identity',
        ],
        [
          'torrent_coverage',
          '"media_association_id" = 2 AND "season_number" = 1',
          'IDX_catalogue_coverage_selection',
        ],
        [
          'sync_state',
          '"tracker_id" = \'a\' AND "category_id" = 10500 AND "mode" = \'recent\'',
          'UQ_catalogue_sync_scope',
        ],
      ];
      for (const [table, predicate, index] of queries) {
        const plan = JSON.stringify(
          await db.query(
            `${postgres ? 'EXPLAIN (FORMAT JSON)' : 'EXPLAIN QUERY PLAN'} SELECT * FROM ${namespace}"${table}" WHERE ${predicate}`
          )
        );
        assert.ok(
          plan.includes(index) ||
            (!postgres &&
              table === 'torrents' &&
              /USING INDEX sqlite_autoindex_torrents/.test(plan)) ||
            (!postgres &&
              table === 'sync_state' &&
              /USING INDEX sqlite_autoindex_sync_state/.test(plan)),
          plan
        );
      }
    });

    const count = await db.getRepository(names.torrent).count();
    await database.shutdown();
    assert.throws(() => database.getConnection(), CatalogueUnavailableError);
    database = new CatalogueDatabase(factory);
    assert.equal(await database.initialize(), true);
    db = database.getConnection();
    assert.equal(await db.getRepository(names.torrent).count(), count);
    assert.deepEqual(await db.runMigrations(), []);
    assert.deepEqual(await nativeSnapshot(), before);
    if (postgres)
      assert.deepEqual(await native.query('SHOW search_path'), searchPath);
    else assert.deepEqual(await db.query('PRAGMA foreign_key_check'), []);
    await t.test(
      'migration down and recovery affect only catalogue tables',
      async () => {
        await db.undoLastMigration({ transaction: 'all' });
        assert.equal(
          await db
            .createQueryRunner()
            .hasTable(postgres ? 'catalogue.torrents' : 'torrents'),
          false
        );
        assert.deepEqual(await nativeSnapshot(), before);
        assert.equal((await db.runMigrations()).length, 1);
      }
    );
  } finally {
    await database.shutdown();
  }
}

it('SQLite catalogue storage with real native migrations in an independent file', async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'seerr-catalogue-'));
  const native = new DataSource({
    type: 'sqlite',
    database: path.join(directory, 'native.sqlite'),
    entities: [],
    synchronize: false,
    migrations: [path.resolve(__dirname, '../../migration/sqlite/*.ts')],
  });
  try {
    await native.initialize();
    await native.query('PRAGMA foreign_keys=OFF');
    await native.runMigrations();
    await native.query('PRAGMA foreign_keys=ON');
    await verifyStorage(
      () =>
        createCatalogueDataSource({
          type: 'sqlite',
          database: path.join(directory, 'catalogue.sqlite'),
          env: {},
        }),
      native,
      t
    );
  } finally {
    if (native.isInitialized) await native.destroy();
    await rm(directory, { recursive: true, force: true });
  }
});

it('GUID boundary rejects credentials without echoing them', () => {
  for (const guid of [
    '12345',
    'tracker:12345',
    'https://tracker.invalid/torrents/12345',
    'https://tracker.invalid/details?id=12345',
  ])
    assert.doesNotThrow(() => assertSafeCanonicalGuid(guid));
  for (const guid of [
    'https://tracker.invalid/download?id=1&apikey=SECRET',
    'https://user:SECRET@tracker.invalid/1',
    'https://tracker.invalid/passkey/SECRET/1',
    'https://tracker.invalid/passkey_SECRET/1',
    'https://tracker.invalid/1#SECRET',
    'https://tracker.invalid/1?x=SECRET',
    'https://tracker.invalid/1?%2561pikey=SECRET',
    'https://tracker.invalid/%25252561pikey/SECRET',
    'token:SECRET',
    ' raw-id ',
    '',
  ]) {
    assert.throws(
      () => assertSafeCanonicalGuid(guid),
      (error: Error) => error.message === 'Unsafe catalogue GUID'
    );
  }
});

it('connection and migration failures remain observable, recoverable and isolated', async (t) => {
  const directory = await mkdtemp(
    path.join(tmpdir(), 'seerr-catalogue-failure-')
  );
  let fail = true;
  const factory = () => {
    if (fail) throw new Error('password=DO-NOT-LOG');
    return createCatalogueDataSource({
      type: 'sqlite',
      database: path.join(directory, 'catalogue.sqlite'),
      env: {},
    });
  };
  const database = new CatalogueDatabase(factory);
  try {
    assert.equal(await database.initialize(), false);
    assert.deepEqual(database.getState(), {
      status: 'unavailable',
      error: 'connection',
    });
    assert.throws(() => database.getConnection(), CatalogueUnavailableError);
    assert.ok(!JSON.stringify(database.getState()).includes('DO-NOT-LOG'));
    fail = false;
    assert.equal(await database.initialize(), true);
    await database.shutdown();
    const broken = new CatalogueDatabase(() => {
      const db = factory();
      class Broken1792800000001 {
        async up(runner: QueryRunner): Promise<void> {
          await runner.query('CREATE TABLE partial_catalogue (id integer)');
          throw new Error('migration secret');
        }
        async down(runner: QueryRunner): Promise<void> {
          await runner.dropTable('partial_catalogue');
        }
      }
      db.setOptions({ migrations: [Broken1792800000001] });
      return db;
    });
    const output = t.mock.method(console, 'log', () => undefined);
    assert.equal(await broken.initialize(), false);
    assert.equal(
      output.mock.callCount(),
      0,
      'Raw migration errors must not reach stdout'
    );
    output.mock.restore();
    assert.deepEqual(broken.getState(), {
      status: 'unavailable',
      error: 'migration',
    });
    await broken.shutdown();
    assert.equal(await database.initialize(), true);
    assert.equal(
      await database
        .getConnection()
        .createQueryRunner()
        .hasTable('partial_catalogue'),
      false
    );
    assert.equal(
      (
        await database
          .getConnection()
          .query('SELECT * FROM catalogue_migrations')
      ).length,
      1
    );
  } finally {
    await database.shutdown();
    await rm(directory, { recursive: true, force: true });
  }
});

it('PostgreSQL configuration is injectable independently of the native test engine', () => {
  const db = createCatalogueDataSource({
    type: 'postgres',
    env: {
      DB_SOCKET_PATH: '/tmp/test-socket',
      DB_HOST: 'unused',
      DB_NAME: 'synthetic',
      DB_USER: 'synthetic',
      DB_PASS: 'synthetic-secret',
      DB_POOL_SIZE: '3',
      DB_CONNECT_TIMEOUT_MS: '4567',
      DB_USE_SSL: 'true',
      DB_SSL_REJECT_UNAUTHORIZED: 'false',
      DB_SSL_CA: 'synthetic-ca',
    },
  });
  assert.equal(db.options.type, 'postgres');
  if (db.options.type !== 'postgres') assert.fail();
  assert.equal(db.options.host, '/tmp/test-socket');
  assert.equal(db.options.port, undefined);
  assert.equal(db.options.schema, 'catalogue');
  assert.equal(db.options.poolSize, 3);
  assert.equal(db.options.connectTimeoutMS, 4567);
  assert.deepEqual(db.options.ssl, {
    rejectUnauthorized: false,
    ca: 'synthetic-ca',
    key: undefined,
    cert: undefined,
  });
  assert.equal(db.options.synchronize, false);
  assert.equal(db.options.logging, false);
});

// Reuse the native migration harness's explicitly disposable instance contract.
const postgresRequested =
  Boolean(process.env.CI) ||
  Object.keys(process.env).some((key) => key.startsWith('SEERR_MIGRATION_PG_'));
it(
  'real PostgreSQL catalogue schema, migrations, transactions and native isolation',
  {
    skip: postgresRequested
      ? false
      : 'Blocked: no disposable PostgreSQL instance; mandatory before PR1 completion.',
  },
  async (t) => {
    assert.equal(process.env.SEERR_MIGRATION_PG_DISPOSABLE, 'true');
    const port = Number(process.env.SEERR_MIGRATION_PG_PORT);
    assert.ok(Number.isInteger(port) && port > 0 && port <= 65535);
    const password = process.env.SEERR_MIGRATION_PG_PASSWORD;
    assert.ok(password);
    const env = {
      DB_HOST: '127.0.0.1',
      DB_PORT: String(port),
      DB_USER: 'seerr_migration_test',
      DB_PASS: password,
      DB_CONNECT_TIMEOUT_MS: '5000',
      DB_POOL_SIZE: '1',
    };
    const control = new DataSource({
      type: 'postgres',
      host: env.DB_HOST,
      port,
      username: env.DB_USER,
      password,
      database: 'seerr_migration_control',
      entities: [],
      synchronize: false,
      connectTimeoutMS: 5000,
      poolSize: 1,
    });
    const database = 'seerr_catalogue_' + randomUUID().replaceAll('-', '');
    let created = false;
    let native: DataSource | undefined;
    try {
      await control.initialize();
      assert.deepEqual(
        await control.query(
          'SELECT datname FROM pg_database WHERE NOT datistemplate ORDER BY datname'
        ),
        [{ datname: 'postgres' }, { datname: 'seerr_migration_control' }]
      );
      assert.deepEqual(
        await control.query(
          `SELECT n.nspname, c.relname FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname <> 'information_schema' AND n.nspname !~ '^pg_'`
        ),
        []
      );
      await control.query(`CREATE DATABASE "${database}" TEMPLATE template0`);
      created = true;
      assert.equal(control.options.type, 'postgres');
      if (control.options.type !== 'postgres') assert.fail();
      native = new DataSource({
        ...control.options,
        database,
        migrations: [path.resolve(__dirname, '../../migration/postgres/*.ts')],
      });
      await native.initialize();
      await native.runMigrations();
      assert.deepEqual(
        await native.query(
          `SELECT has_database_privilege(current_user, current_database(), 'CREATE') AS allowed`
        ),
        [{ allowed: true }]
      );
      await verifyStorage(
        () => createCatalogueDataSource({ type: 'postgres', database, env }),
        native,
        t
      );
    } finally {
      if (native?.isInitialized) await native.destroy();
      try {
        if (created) await control.query(`DROP DATABASE "${database}"`);
      } finally {
        if (control.isInitialized) await control.destroy();
      }
    }
  }
);
