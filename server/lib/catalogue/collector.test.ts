import { TrackerAdapterError, httpError } from '@server/api/trackers/errors';
import type { TrackerAdapter } from '@server/api/trackers/types';
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { it, type TestContext } from 'node:test';
import { DataSource, type QueryRunner } from 'typeorm';
import { defaultTr4kerCollectionSettings as defaults } from './collectionConfig';
import {
  readCollectionCheckpoint,
  readCollectionState,
} from './collectionState';
import { CollectionStore } from './collectionStore';
import { CatalogueCollector } from './collector';
import {
  createCatalogueDataSource,
  type CatalogueConnectionOptions,
} from './datasource';
import { catalogueEntityNames as names } from './entities';
import { CatalogueRepository } from './repository';
import type { CatalogueSyncState } from './types';

type Fetch = TrackerAdapter['fetchHistoricalPage'];
const instant = 1800000000000;
const guid = (id: number) => `https://tr4ker.net/torrent/release-${id}`;
function record(id: number, trackerId: string) {
  return {
    trackerId,
    canonicalGuid: guid(id),
    infohash: createHash('sha1').update(String(id)).digest('hex'),
    releaseName: `Release ${id}`,
    categories: [2000],
    size: null,
    publishedAt: null,
    seeders: 0,
    leechers: null,
    observedAt: new Date(instant),
    trackerMetadata: { tmdbId: 42, tvdbId: 84, season: 1, episode: 0 },
    provenance: {
      tmdbId: { source: 'tracker' as const, field: 'torznab:attr/tmdbid' },
      tvdbId: { source: 'tracker' as const, field: 'torznab:attr/tvdbid' },
      season: { source: 'tracker' as const, field: 'torznab:attr/season' },
      episode: { source: 'tracker' as const, field: 'torznab:attr/episode' },
    },
  };
}
function page(trackerId: string, offset: number, count = 100) {
  return {
    trackerId,
    category: 'movie' as const,
    offset,
    limit: 100,
    observedAt: new Date(instant),
    receivedCount: count,
    contractStatus: 'compatible' as const,
    anomalies: [],
    records: Array.from({ length: count }, (_, i) =>
      record(offset + i, trackerId)
    ),
  };
}
interface WorkerResult {
  reserved?: { scope: CatalogueSyncState; now: number } | null;
  error?: string;
  committed?: boolean;
}
async function worker(
  connection: CatalogueConnectionOptions,
  input: object
): Promise<WorkerResult> {
  return new Promise((resolve, reject) => {
    let result: WorkerResult | undefined;
    const child = fork(
      path.join(__dirname, 'fixtures/collectionWorker.ts'),
      [JSON.stringify({ connection, ...input })],
      {
        execArgv: ['-r', 'ts-node/register', '-r', 'tsconfig-paths/register'],
        env: {
          ...process.env,
          TS_NODE_PROJECT: path.resolve('server/tsconfig.json'),
        },
        stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
      }
    );
    let stderr = '';
    child.stderr?.on('data', (data) => {
      stderr += data;
    });
    child.on('message', (message) => {
      result = message as WorkerResult;
    });
    child.on('error', reject);
    child.on('exit', (code) =>
      code === 0 && result
        ? resolve(result)
        : reject(
            new Error(`Collection test worker failed (${code}): ${stderr}`)
          )
    );
  });
}
async function verify(
  connection: CatalogueConnectionOptions,
  t: TestContext
): Promise<void> {
  let db = createCatalogueDataSource(connection);
  try {
    await db.initialize();
    if (connection.type === 'postgres')
      await db.query('CREATE SCHEMA "catalogue"');
    await db.runMigrations();
  } catch (error) {
    if (db.isInitialized) await db.destroy();
    throw error;
  }
  let now = instant;
  const clock = async () => now;
  const scope = async (
    id: string,
    mode: 'recent' | 'historical' = 'historical',
    categoryId = 2000
  ) =>
    db
      .getRepository<CatalogueSyncState>(names.sync)
      .findOneByOrFail({ trackerId: id, categoryId, mode });
  async function setup(fetch?: Fetch, settings = {}) {
    now = instant;
    const id = `fixture-${randomUUID()}`;
    const calls: {
      mode: string;
      offset: number;
      category: string;
      at: number;
    }[] = [];
    const adapter: TrackerAdapter = {
      getCapabilities: async () => {
        throw new Error('Unmetered capabilities request');
      },
      fetchRecentPage: async (req) => {
        calls.push({ mode: 'recent', ...req, at: now });
        return fetch ? fetch(req) : page(id, req.offset);
      },
      fetchHistoricalPage: async (req) => {
        calls.push({ mode: 'historical', ...req, at: now });
        return fetch ? fetch(req) : page(id, req.offset);
      },
    };
    const tracker = {
      trackerId: id,
      adapter,
      settings: { ...defaults, ...settings, enabled: true },
    };
    const collector = new CatalogueCollector(db, [tracker], clock);
    await collector.initialize();
    await db
      .getRepository(names.sync)
      .update({ trackerId: id }, { nextRunAt: null });
    async function enable(
      mode: 'recent' | 'historical' = 'historical',
      categoryId = 2000,
      extra = {}
    ) {
      await db
        .getRepository(names.sync)
        .update(
          { trackerId: id, categoryId, mode },
          { nextRunAt: new Date(now), ...extra }
        );
    }
    async function tick(milliseconds = 3000) {
      const worked = await collector.tick();
      now += milliseconds;
      return worked;
    }
    return { id, calls, adapter, tracker, collector, enable, tick };
  }
  try {
    await t.test(
      'P1 to P3 migration preserves existing identities and category foreign keys',
      async () => {
        const h = await setup();
        const repository = new CatalogueRepository(db);
        const [torrent] = await repository.persistPage(
          [record(999999, h.id)],
          await scope(h.id)
        );
        await db.undoLastMigration({ transaction: 'all' });
        const categories = await db
          .getRepository(names.category)
          .findBy({ torrentId: torrent.id });
        assert.equal(categories.length, 1);
        assert.equal((await db.runMigrations()).length, 1);
        const reopened = await repository.findTorrentByGuid(h.id, guid(999999));
        assert.equal(reopened?.id, torrent.id);
        assert.equal(reopened?.nativeTmdbId, null);
        assert.deepEqual(
          await db
            .getRepository(names.category)
            .findBy({ torrentId: torrent.id }),
          categories
        );
      }
    );
    await t.test(
      'nullable native claims, season-only metadata and allowlisted provenance retain freshness',
      async () => {
        const h = await setup();
        const repository = new CatalogueRepository(db);
        const raw = {
          ...record(0, h.id),
          trackerMetadata: {
            tmdbId: null,
            tvdbId: null,
            season: 1,
            episode: null,
          },
        };
        const [stored] = await repository.persistPage([raw], await scope(h.id));
        assert.equal(stored.nativeTmdbId, null);
        assert.equal(stored.nativeTvdbId, null);
        assert.equal(stored.nativeSeason, 1);
        assert.equal(stored.nativeEpisode, null);
        assert.deepEqual(JSON.parse(stored.nativeProvenance!), {
          season: { source: 'tracker', field: 'torznab:attr/season' },
        });
        await assert.rejects(
          repository.persistPage(
            [
              {
                ...raw,
                provenance: {
                  season: {
                    source: 'tracker',
                    field: 'SECRET-unvalidated-attribute',
                  },
                },
              },
            ],
            await scope(h.id)
          ),
          /Invalid catalogue native metadata provenance/
        );
        const newer = {
          ...raw,
          observedAt: new Date(instant + 1000),
          trackerMetadata: {
            tmdbId: null,
            tvdbId: null,
            season: null,
            episode: null,
          },
        };
        await repository.persistPage([newer], await scope(h.id));
        await repository.persistPage([raw], await scope(h.id));
        assert.equal(
          (await repository.findTorrent(stored.id))?.nativeSeason,
          null
        );
        assert.equal(
          (
            await repository.findTorrent(stored.id)
          )?.nativeObservedAt?.getTime(),
          instant + 1000
        );
      }
    );
    await t.test(
      'maintenance pacing spans both categories and stays within ten starts per minute',
      async () => {
        const h = await setup(undefined, { maintenanceIntervalMinutes: 1 });
        await h.enable('historical', 2000, { phase: 'maintenance' });
        await h.enable('historical', 5000, { phase: 'maintenance' });
        for (let i = 0; i < 50; i++) await h.tick();
        const times = h.calls.map((c) => c.at);
        assert.equal(new Set(h.calls.map((c) => c.category)).size, 2);
        assert.ok(
          times.every((time, i) => i === 0 || time - times[i - 1] >= 6000)
        );
        for (const start of times)
          assert.ok(
            times.filter((time) => time >= start && time < start + 60000)
              .length <= 10
          );
      }
    );
    await t.test(
      'leases renew within a bounded lifetime; expired ownership cannot be renewed or write',
      async () => {
        const h = await setup();
        await h.enable();
        const lease = await h.collector.store.reserveNext(
          h.id,
          'owner',
          h.tracker.settings
        );
        assert.ok(lease);
        now += 30000;
        assert.equal(
          await h.collector.store.renew(lease.scope, 'owner', instant + 120000),
          true
        );
        assert.equal(
          await h.collector.store.renew(
            lease.scope,
            'stranger',
            instant + 120000
          ),
          false
        );
        now += 60001;
        assert.equal(
          await h.collector.store.renew(lease.scope, 'owner', instant + 120000),
          false
        );
        await assert.rejects(
          new CatalogueRepository(db).persistPage(
            [record(1, h.id)],
            await scope(h.id),
            {
              owner: 'owner',
              clock,
              onIdentityConflicts: () => {
                throw new Error('Unexpected conflict');
              },
            }
          ),
          {
            name: 'Error',
            message: 'Catalogue collection lease is no longer valid',
          }
        );
        assert.equal(
          await db.getRepository(names.torrent).countBy({ trackerId: h.id }),
          0
        );
      }
    );
    await t.test(
      'overlapping Historical pages progress 0/80/160; replay is idempotent and metadata survives reopen',
      async () => {
        const h = await setup();
        await h.enable();
        for (let i = 0; i < 3; i++) assert.equal(await h.tick(), true);
        assert.deepEqual(
          h.calls.map((c) => c.offset),
          [0, 80, 160]
        );
        assert.equal(
          readCollectionCheckpoint((await scope(h.id)).checkpoint)?.nextOffset,
          240
        );
        assert.equal(
          await db.getRepository(names.torrent).countBy({ trackerId: h.id }),
          260
        );
        const repository = new CatalogueRepository(db);
        const state = await scope(h.id);
        await repository.persistPage(page(h.id, 160).records, state);
        assert.equal(
          await db.getRepository(names.torrent).countBy({ trackerId: h.id }),
          260
        );
        const saved = (await repository.findTorrentByGuid(h.id, guid(160)))!;
        assert.equal(saved.nativeTmdbId, 42);
        assert.equal(saved.nativeTvdbId, 84);
        assert.equal(saved.nativeEpisode, 0);
        assert.equal(saved.seeders, 0);
        assert.equal(saved.firstSeenAt.getTime(), instant + 3000);
        const older = record(160, h.id);
        older.trackerMetadata.tmdbId = 999;
        await repository.persistPage([older], state);
        assert.equal(
          (await repository.findTorrentByGuid(h.id, guid(160)))?.nativeTmdbId,
          42
        );
        assert.equal(await db.getRepository(names.media).count(), 0);
        assert.equal(await db.getRepository(names.coverage).count(), 0);
        await db.destroy();
        db = createCatalogueDataSource(connection);
        await db.initialize();
        const reopened = await new CatalogueRepository(db).findTorrentByGuid(
          h.id,
          guid(160)
        );
        assert.equal(reopened?.nativeEpisode, 0);
        assert.equal(reopened?.nativeObservedAt?.getTime(), instant + 6000);
        assert.equal(
          JSON.parse(reopened!.nativeProvenance!).tvdbId.field,
          'torznab:attr/tvdbid'
        );
        const resumed = new CatalogueCollector(db, [h.tracker], clock);
        await resumed.initialize();
        await resumed.tick();
        assert.equal(h.calls.at(-1)?.offset, 240);
      }
    );
    await t.test(
      'terminal emptiness requires two reads plus a subsequent offset; total is irrelevant',
      async () => {
        let id = '';
        const h = await setup(async (req) => ({
          ...page(id, req.offset, 0),
          total: 1001,
        }));
        id = h.id;
        await h.enable();
        await h.tick();
        assert.equal(
          readCollectionCheckpoint((await scope(id)).checkpoint)?.done,
          false
        );
        await h.tick();
        assert.equal(
          readCollectionCheckpoint((await scope(id)).checkpoint)?.done,
          false
        );
        await h.tick();
        const stored = await scope(id);
        assert.deepEqual(
          h.calls.map((c) => c.offset),
          [0, 0, 80]
        );
        assert.equal(
          readCollectionCheckpoint(stored.checkpoint)?.terminalOffset,
          0
        );
        assert.equal(stored.nextRunAt, null);
        assert.equal(
          readCollectionState(stored.collectionState).coverage,
          'observed'
        );
      }
    );
    await t.test(
      'a nonempty response resets terminal confirmation and preserves unobserved torrents',
      async () => {
        let id = '';
        let n = 0;
        const h = await setup(async (req) =>
          page(id, req.offset, ++n === 2 ? 1 : 0)
        );
        id = h.id;
        await h.enable();
        await h.tick();
        await h.tick();
        assert.equal(
          readCollectionCheckpoint((await scope(id)).checkpoint)?.empty,
          null
        );
        await h.tick();
        await h.tick();
        await h.tick();
        assert.deepEqual(
          h.calls.map((c) => c.offset),
          [0, 0, 80, 80, 160]
        );
        const torrent = await new CatalogueRepository(db).findTorrentByGuid(
          id,
          guid(0)
        );
        assert.equal(torrent?.lastSeenAt.getTime(), instant + 3000);
        assert.equal(torrent?.seeders, 0);
      }
    );
    await t.test(
      'moving pages and repeated pages retain partial coverage with bounded retries',
      async () => {
        let id = '';
        let shift = 0;
        const h = await setup(async (req) =>
          page(id, Math.max(0, req.offset + shift))
        );
        id = h.id;
        await h.enable();
        await h.tick();
        shift = -2;
        await h.tick();
        shift = 3;
        await h.tick();
        assert.equal(
          readCollectionState((await scope(id)).collectionState).coverage,
          'partial'
        );
        shift = -80;
        await h.tick();
        // Force the previous full page to repeat forever at the same requested offset.
        const offset = h.calls.at(-1)!.offset + shift;
        h.adapter.fetchHistoricalPage = async () => page(id, offset);
        for (let i = 0; i < 5; i++) {
          now += 1000000;
          await h.tick();
        }
        const stored = await scope(id);
        assert.equal(stored.status, 'suspended');
        assert.ok(
          readCollectionState(stored.collectionState).diagnostics.some(
            (d) => d.code === 'repeated_page'
          )
        );
        assert.ok(
          (await db.getRepository(names.torrent).countBy({ trackerId: id })) >
            100
        );
      }
    );
    await t.test(
      'Recent first run is partial; one known GUID cannot terminate and a stable boundary needs successive pages',
      async () => {
        const h = await setup(undefined, { recentPageLimit: 3 });
        await h.enable('recent');
        for (let i = 0; i < 3; i++) await h.tick();
        let stored = await scope(h.id, 'recent');
        assert.equal(
          readCollectionState(stored.collectionState).coverage,
          'partial'
        );
        assert.equal(readCollectionCheckpoint(stored.checkpoint)?.done, true);
        now += 900000;
        await h.collector.enqueueRecent(2000);
        await h.tick();
        await h.tick();
        assert.equal(
          readCollectionCheckpoint((await scope(h.id, 'recent')).checkpoint)
            ?.done,
          false,
          'The earlier partial range must be revisited'
        );
        await h.tick();
        stored = await scope(h.id, 'recent');
        assert.equal(
          readCollectionState(stored.collectionState).coverage,
          'observed'
        );
        const one = await setup(undefined, { recentPageLimit: 2 });
        await new CatalogueRepository(db).persistPage(
          [record(0, one.id)],
          await scope(one.id, 'recent')
        );
        now += 1000;
        await one.enable('recent');
        await one.tick();
        assert.equal(
          readCollectionCheckpoint((await scope(one.id, 'recent')).checkpoint)
            ?.done,
          false
        );
        await one.tick();
        assert.equal(
          readCollectionState((await scope(one.id, 'recent')).collectionState)
            .coverage,
          'partial'
        );
      }
    );
    await t.test(
      'interrupted Recent work resumes its committed offset and retains partial coverage until reprocessed',
      async () => {
        const h = await setup(undefined, { recentPageLimit: 3 });
        await new CatalogueRepository(db).persistPage(
          page(h.id, 0, 260).records,
          await scope(h.id, 'recent')
        );
        now += 1000;
        await h.enable('recent');
        await h.tick();
        h.adapter.fetchRecentPage = async () => {
          throw new TrackerAdapterError('timeout', true);
        };
        await h.tick();
        assert.equal(
          readCollectionCheckpoint((await scope(h.id, 'recent')).checkpoint)
            ?.nextOffset,
          80
        );
        now += 30000;
        h.adapter.fetchRecentPage = async (req) => page(h.id, req.offset);
        const resumed = new CatalogueCollector(db, [h.tracker], clock);
        await resumed.initialize();
        await resumed.tick();
        now += 3000;
        await resumed.tick();
        assert.equal(
          readCollectionState((await scope(h.id, 'recent')).collectionState)
            .coverage,
          'partial'
        );
        assert.equal(
          readCollectionCheckpoint((await scope(h.id, 'recent')).checkpoint)
            ?.done,
          true
        );
        now += 900000;
        await resumed.enqueueRecent(2000);
        for (let i = 0; i < 3; i++) {
          await resumed.tick();
          now += 3000;
        }
        assert.equal(
          readCollectionState((await scope(h.id, 'recent')).collectionState)
            .coverage,
          'observed'
        );
      }
    );
    await t.test(
      'production reservations use database time and retain the shared cooldown in a fresh store',
      async () => {
        const h = await setup();
        await h.enable('historical', 2000, { nextRunAt: new Date(0) });
        const store = new CollectionStore(db);
        const before = Date.now();
        const lease = await store.reserveNext(
          h.id,
          'sql-clock',
          h.tracker.settings
        );
        assert.ok(lease);
        assert.ok(lease.now >= before - 100 && lease.now <= Date.now() + 100);
        assert.equal(
          await new CollectionStore(db).reserveNext(
            h.id,
            'sql-clock-2',
            h.tracker.settings
          ),
          null
        );
      }
    );
    await t.test(
      'contract rejection and persisted infohash conflicts isolate individual records',
      async () => {
        let id = '';
        const h = await setup(async (req) => ({
          ...page(id, req.offset, 2),
          anomalies: [
            { itemIndex: 2, code: 'identity_conflict', field: 'infohash' },
          ],
          receivedCount: 3,
        }));
        id = h.id;
        await new CatalogueRepository(db).persistPage(
          [{ ...record(0, id), infohash: 'f'.repeat(40) }],
          await scope(id)
        );
        await h.enable();
        await h.tick();
        assert.equal(
          await db.getRepository(names.torrent).countBy({ trackerId: id }),
          2
        );
        assert.equal(
          (await new CatalogueRepository(db).findTorrentByGuid(id, guid(0)))
            ?.infohash,
          'f'.repeat(40)
        );
        const state = readCollectionState((await scope(id)).collectionState);
        assert.equal(state.coverage, 'partial');
        assert.equal((await scope(id)).status, 'running');
        assert.ok(
          state.diagnostics.some((d) => d.code === 'identity_conflict')
        );
        assert.ok(!JSON.stringify(state).includes(guid(0)));
      }
    );
    await t.test(
      'incompatible pages do not advance and suspension is confined to the scope',
      async () => {
        let id = '';
        const h = await setup(async (req) => ({
          ...page(id, req.offset, 0),
          contractStatus: 'incompatible',
          receivedCount: 100,
          anomalies: [
            { itemIndex: 0, code: 'invalid_identity', field: 'canonicalGuid' },
          ],
        }));
        id = h.id;
        await h.enable();
        for (let i = 0; i < 5; i++) {
          await h.tick();
          now += 1000000;
        }
        const stored = await scope(id);
        assert.equal(stored.status, 'suspended');
        assert.equal(
          readCollectionCheckpoint(stored.checkpoint)?.nextOffset,
          0
        );
        const dispatch = await db
          .getRepository(names.dispatch)
          .findOneByOrFail({ trackerId: id });
        assert.equal(dispatch.suspended, false);
        await h.collector.store.recover(id, 2000, 'historical');
        assert.equal(
          readCollectionState((await scope(id)).collectionState).coverage,
          'partial'
        );
      }
    );
    await t.test(
      'page writes and checkpoint roll back together; restart safely replays the failed page',
      async () => {
        const h = await setup();
        await h.enable();
        await h.tick();
        let injected = false;
        let wroteTorrents = false;
        const original = db.createQueryRunner.bind(db);
        const runners: {
          runner: QueryRunner;
          original: QueryRunner['query'];
        }[] = [];
        const spy = t.mock.method(
          db,
          'createQueryRunner',
          (...args: Parameters<typeof original>) => {
            const runner = original(...args);
            const query = runner.query;
            runner.query = async function (
              ...params: Parameters<typeof query>
            ) {
              if (
                String(params[0]).startsWith('INSERT INTO') &&
                String(params[0]).includes('torrents')
              )
                wroteTorrents = true;
              if (
                !injected &&
                wroteTorrents &&
                String(params[0]).startsWith('INSERT INTO') &&
                String(params[0]).includes('sync_state')
              ) {
                injected = true;
                throw new Error('Synthetic checkpoint failure SECRET');
              }
              return Reflect.apply(query, runner, params);
            };
            runners.push({ runner, original: query });
            return runner;
          }
        );
        try {
          await h.tick();
        } finally {
          spy.mock.restore();
          for (const item of runners) item.runner.query = item.original;
        }
        assert.equal(injected, true);
        assert.equal(
          await db.getRepository(names.torrent).countBy({ trackerId: h.id }),
          100
        );
        assert.equal(
          readCollectionCheckpoint((await scope(h.id)).checkpoint)?.nextOffset,
          80
        );
        now += 30000;
        const resumed = new CatalogueCollector(db, [h.tracker], clock);
        await resumed.initialize();
        await resumed.tick();
        assert.equal(h.calls.at(-1)?.offset, 80);
        assert.equal(
          await db.getRepository(names.torrent).countBy({ trackerId: h.id }),
          180
        );
        assert.equal(
          readCollectionState((await scope(h.id)).collectionState).coverage,
          'partial'
        );
        assert.ok(!(await scope(h.id)).collectionState?.includes('SECRET'));
      }
    );
    await t.test(
      'maintenance requires an explicit interval, starts at zero, resumes progress and shares 6s spacing',
      async () => {
        let id = '';
        const h = await setup(async (req) => page(id, req.offset, 0), {
          maintenanceIntervalMinutes: 1,
        });
        id = h.id;
        await h.enable();
        await h.tick();
        await h.tick();
        await h.tick();
        now += 60000;
        h.adapter.fetchHistoricalPage = async (req) => {
          h.calls.push({ mode: 'historical', ...req, at: now });
          return page(id, req.offset);
        };
        await h.tick();
        assert.equal(h.calls.at(-1)?.offset, 0);
        assert.equal((await scope(id)).phase, 'maintenance');
        assert.equal(await h.collector.tick(), false); // only 3 seconds elapsed
        now += 3000;
        const resumed = new CatalogueCollector(db, [h.tracker], clock);
        await resumed.initialize();
        await resumed.tick();
        assert.equal(h.calls.at(-1)?.offset, 80);
        await h.enable('historical', 5000, { phase: 'maintenance' });
        now += 3000;
        assert.equal(await resumed.tick(), false);
        now += 3000;
        assert.equal(await resumed.tick(), true);
      }
    );
    await t.test(
      'pending Recent wins a SQL reservation while in-flight scopes leave remaining capacity to Historical',
      async () => {
        const h = await setup();
        await h.enable();
        await h.enable('recent');
        const first = await h.collector.store.reserveNext(
          h.id,
          'recent-owner',
          h.tracker.settings
        );
        assert.equal(first?.scope.mode, 'recent');
        now += 3000;
        const second = await new CollectionStore(db, clock).reserveNext(
          h.id,
          'historical-owner',
          h.tracker.settings
        );
        assert.equal(second?.scope.mode, 'historical');
        assert.equal((await scope(h.id, 'recent')).leaseOwner, 'recent-owner');
        assert.equal(
          await new CollectionStore(db, clock).reserveNext(
            h.id,
            'too-early',
            h.tracker.settings
          ),
          null
        );
      }
    );
    await t.test(
      'shared global pacing, Recent priority, remaining Historical capacity and no downtime bursts',
      async () => {
        const h = await setup();
        await h.enable();
        await h.enable('recent', 5000, { nextRunAt: new Date(now + 3000) });
        assert.equal(await h.collector.tick(), true);
        assert.equal(h.calls.at(-1)?.mode, 'historical');
        assert.equal(await h.collector.tick(), false);
        now += 3000;
        await h.collector.tick();
        assert.equal(h.calls.at(-1)?.mode, 'recent');
        now += 900000;
        assert.equal(await h.collector.tick(), true);
        assert.equal(await h.collector.tick(), false);
        for (let i = 0; i < 45; i++) {
          now += 3000;
          await h.collector.tick();
        }
        const times = h.calls.map((c) => c.at);
        assert.ok(times.every((n, i) => i === 0 || n - times[i - 1] >= 3000));
        for (const start of times)
          assert.ok(
            times.filter((n) => n >= start && n < start + 60000).length <= 20
          );
      }
    );
    await t.test(
      'competing processes share quotas, reclaim expired leases, and fence the former owner',
      async () => {
        const h = await setup();
        await h.enable();
        const results = await Promise.all(
          ['old-a', 'old-b'].map((owner) =>
            worker(connection, {
              action: 'reserve',
              trackerId: h.id,
              owner,
              now,
            })
          )
        );
        assert.equal(results.filter((r) => r.reserved).length, 1);
        assert.ok(results.every((r) => !r.error));
        const oldOwner = results[0].reserved ? 'old-a' : 'old-b';
        assert.equal(
          (
            await worker(connection, {
              trackerId: h.id,
              owner: 'early',
              now: now + 3000,
            })
          ).reserved,
          null
        );
        now += 60001;
        const takeover = await worker(connection, {
          trackerId: h.id,
          owner: 'new-owner',
          now,
        });
        assert.ok(takeover.reserved);
        const checkpoint = await scope(h.id);
        const stale = await worker(connection, {
          action: 'commit',
          owner: oldOwner,
          checkpoint,
          records: [record(0, h.id)],
          now,
        });
        assert.equal(stale.error, 'CatalogueLeaseLostError');
        assert.equal(
          await db.getRepository(names.torrent).countBy({ trackerId: h.id }),
          0
        );
        await h.collector.store.release(checkpoint, 'new-owner');
        assert.equal(
          await h.collector.store.reserveNext(h.id, 'next', h.tracker.settings),
          null,
          'Restart must retain global request spacing'
        );
      }
    );
    await t.test(
      '429 Retry-After seconds/date/invalid, timeout/503, auth and restart-persistent suspension',
      async () => {
        for (const error of [
          httpError(429, '120'),
          httpError(429, new Date(instant + 1800000).toUTCString()),
          httpError(429, 'bad'),
          httpError(503),
          new TrackerAdapterError('timeout', true),
          new TrackerAdapterError('invalid_xml'),
        ]) {
          const h = await setup(async () => {
            throw error;
          });
          await h.enable();
          await h.tick();
          const stored = await scope(h.id);
          const expected = error.retryAfter
            ? 'seconds' in error.retryAfter
              ? 120000
              : 1800000
            : 30000;
          assert.equal(stored.retryAfterAt?.getTime(), instant + expected);
          assert.equal(await h.collector.tick(), false);
          await db.destroy();
          db = createCatalogueDataSource(connection);
          await db.initialize();
          const restarted = new CollectionStore(db, clock);
          assert.equal(
            await restarted.reserveNext(h.id, 'restart', h.tracker.settings),
            null
          );
        }
        for (const status of [401, 403]) {
          const h = await setup(async () => {
            throw httpError(status);
          });
          await h.enable();
          await h.tick();
          assert.equal((await scope(h.id)).status, 'suspended');
          now += 9999999;
          assert.equal(await h.collector.tick(), false);
          await h.collector.store.recover(h.id);
          assert.equal((await scope(h.id)).status, 'idle');
          assert.equal(
            readCollectionState((await scope(h.id)).collectionState).coverage,
            'partial'
          );
        }
        const h = await setup(async () => {
          throw httpError(503);
        });
        await h.enable();
        for (let i = 0; i < 5; i++) {
          await h.tick();
          now += 1000000;
        }
        assert.equal((await scope(h.id)).status, 'suspended');
      }
    );
    await t.test(
      'one tracker failure does not prevent another tracker; compatible success resets failures',
      async () => {
        const a = await setup(async () => {
          throw httpError(503);
        });
        const b = await setup();
        await a.enable();
        await b.enable();
        const collector = new CatalogueCollector(
          db,
          [a.tracker, b.tracker],
          clock
        );
        await collector.tick();
        assert.equal(b.calls.length, 1);
        assert.equal(
          readCollectionState((await scope(a.id)).collectionState).failures,
          1
        );
        a.adapter.fetchHistoricalPage = async (req) => page(a.id, req.offset);
        now += 30000;
        await collector.tick();
        assert.equal(
          readCollectionState((await scope(a.id)).collectionState).failures,
          0
        );
      }
    );
  } finally {
    await db.destroy();
  }
}
it('P3 SQLite collection, persistence and cross-process coordination', async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'seerr-p3-'));
  try {
    await verify(
      {
        type: 'sqlite',
        database: path.join(directory, 'catalogue.sqlite'),
        env: {},
      },
      t
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
const postgresRequested =
  Boolean(process.env.CI) ||
  Object.keys(process.env).some((key) => key.startsWith('SEERR_MIGRATION_PG_'));
it(
  'P3 real PostgreSQL collection, persistence and cross-process coordination',
  {
    skip: postgresRequested
      ? false
      : 'Blocked: a disposable PostgreSQL instance is required for P3 validation',
  },
  async (t) => {
    assert.equal(process.env.SEERR_MIGRATION_PG_DISPOSABLE, 'true');
    const port = Number(process.env.SEERR_MIGRATION_PG_PORT);
    assert.ok(port > 0 && port <= 65535);
    const password = process.env.SEERR_MIGRATION_PG_PASSWORD;
    assert.ok(password);
    const control = new DataSource({
      type: 'postgres',
      host: '127.0.0.1',
      port,
      username: 'seerr_migration_test',
      password,
      database: 'seerr_migration_control',
      entities: [],
    });
    const database = `seerr_p3_${randomUUID().replaceAll('-', '')}`;
    let created = false;
    try {
      await control.initialize();
      assert.deepEqual(
        await control.query(
          'SELECT datname FROM pg_database WHERE NOT datistemplate ORDER BY datname'
        ),
        [{ datname: 'postgres' }, { datname: 'seerr_migration_control' }]
      );
      await control.query(`CREATE DATABASE "${database}" TEMPLATE template0`);
      created = true;
      await verify(
        {
          type: 'postgres',
          database,
          env: {
            DB_HOST: '127.0.0.1',
            DB_PORT: String(port),
            DB_USER: 'seerr_migration_test',
            DB_PASS: password,
          },
        },
        t
      );
    } finally {
      if (created) await control.query(`DROP DATABASE "${database}"`);
      if (control.isInitialized) await control.destroy();
    }
  }
);
