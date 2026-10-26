import { TrackerAdapterError, httpError } from '@server/api/trackers/errors';
import { normalizeTorznabPage } from '@server/api/trackers/torznab';
import { TR4KER_CONTRACT } from '@server/api/trackers/tr4ker';
import type {
  ReleaseRejection,
  TrackerAdapter,
} from '@server/api/trackers/types';
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { it, type TestContext } from 'node:test';
import { DataSource, type QueryRunner } from 'typeorm';
import {
  defaultTr4kerCollectionSettings as defaults,
  tr4kerCollectionDescription,
  type Tr4kerCollectionSettings,
  type TrackerCollectionDescription,
} from './collectionConfig';
import {
  DIAGNOSTIC_LIMIT,
  DIAGNOSTIC_RETENTION_MS,
  REPAIR_PAGE_LIMIT,
  persistReleaseDiagnostics,
  retainDiagnostics,
} from './collectionRepairs';
import {
  readCollectionCheckpoint,
  readCollectionState,
} from './collectionState';
import { CollectionStore } from './collectionStore';
import { CatalogueCollector, type CollectionTracker } from './collector';
import {
  createCatalogueDataSource,
  type CatalogueConnectionOptions,
} from './datasource';
import { catalogueEntityNames as names } from './entities';
import {
  CatalogueRepository,
  saveSyncCheckpoint,
  upsertObservedTorrents,
} from './repository';
import type {
  CatalogueReleaseDiagnostic,
  CatalogueSyncState,
  ObservedTorrent,
} from './types';

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
function rejection(
  id: number,
  field: ReleaseRejection['field'] = 'releaseName'
): ReleaseRejection {
  return {
    itemIndex: id,
    field,
    code: 'contract_incompatible',
    reason: field === 'releaseName' ? 'missing_title' : 'invalid_value',
    release: { guid: guid(id), infohash: null, title: null, fingerprint: null },
  };
}
function diagnosticFixture(
  trackerId: string,
  id: number,
  mode: 'recent' | 'historical' = 'historical'
): Omit<CatalogueReleaseDiagnostic, 'id'> {
  return {
    trackerId,
    categoryId: 2000,
    mode,
    diagnosticKey: `fixture:${id}`,
    releaseKey: createHash('sha256').update(guid(id)).digest('hex'),
    kind: 'release',
    guid: guid(id),
    infohash: null,
    title: null,
    fingerprint: null,
    field: 'releaseName',
    code: 'contract_incompatible',
    reason: 'missing_title',
    critical: true,
    firstSeenAt: new Date(instant),
    lastSeenAt: new Date(instant),
    occurrences: 1,
    status: 'quarantined',
    attempts: 0,
    nextAttemptAt: null,
    lastAttemptCycle: null,
    lastOutcome: 'source_data_unrepairable',
    resolvedAt: null,
    offset: null,
    itemPosition: null,
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
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
async function reserveNext(
  store: CollectionStore,
  trackerId: string,
  owner: string,
  settings: Tr4kerCollectionSettings
) {
  const tracker = { ...tr4kerCollectionDescription, trackerId };
  const claimed = await store.claimNext(tracker, owner, settings);
  if (!claimed) return null;
  const now = await store.reserveRequest(
    tracker,
    claimed.scope,
    owner,
    settings
  );
  if (now === null) {
    await store.release(claimed.scope, owner);
    return null;
  }
  return { scope: claimed.scope, now };
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
  async function setup(
    fetch?: Fetch,
    settings = {},
    description: Partial<TrackerCollectionDescription> = {}
  ) {
    now = instant;
    const id = `fixture-${randomUUID()}`;
    const calls: {
      mode: string;
      offset: number;
      category: string;
      limit?: number;
      at: number;
    }[] = [];
    const adapter: TrackerAdapter = {
      getCapabilities: async () => {
        throw new Error('Unmetered capabilities request');
      },
      fetchRecentPage: async (req) => {
        calls.push({ mode: 'recent', ...req, at: now });
        return fetch ? fetch(req) : page(id, req.offset, req.limit);
      },
      fetchHistoricalPage: async (req) => {
        calls.push({ mode: 'historical', ...req, at: now });
        return fetch ? fetch(req) : page(id, req.offset, req.limit);
      },
    };
    const tracker: CollectionTracker = {
      ...structuredClone(tr4kerCollectionDescription),
      ...description,
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
      'concurrent Recent and Historical responses commit independent diagnostics and checkpoints under the shared limiter',
      async () => {
        const entered = deferred();
        const finish = deferred();
        let id = '';
        const h = await setup(async (req) => {
          const mode = h.calls.at(-1)!.mode;
          if (mode === 'recent') {
            entered.resolve();
            await finish.promise;
          }
          const bad = rejection(mode === 'recent' ? 1002 : 1001);
          return {
            ...page(id, req.offset, 2),
            receivedCount: 3,
            anomalies: [bad],
            rejections: [bad],
          };
        });
        id = h.id;
        await h.enable('recent');
        await h.enable('historical');
        const other = new CatalogueCollector(db, [h.tracker], clock);
        await other.initialize();
        const recent = h.collector.tick();
        await entered.promise;
        now += 3000;
        try {
          await other.tick();
          const historical = await scope(id);
          assert.equal(h.calls.at(-1)!.mode, 'historical');
          finish.resolve();
          await recent;
          assert.deepEqual(await scope(id), historical);
          const rows = await db
            .getRepository<CatalogueReleaseDiagnostic>(names.diagnostic)
            .findBy({ trackerId: id });
          assert.equal(rows.length, 2);
          assert.equal(
            rows.find((row) => row.mode === 'recent')!.guid,
            guid(1002)
          );
          assert.equal(
            rows.find((row) => row.mode === 'historical')!.guid,
            guid(1001)
          );
          assert.ok(
            rows.every(
              (row) =>
                row.status === 'quarantined' &&
                row.attempts === 0 &&
                row.nextAttemptAt === null
            )
          );
          assert.equal(
            readCollectionCheckpoint(historical.checkpoint)?.dirty,
            false
          );
          assert.equal(h.calls[1].at - h.calls[0].at, 3000);
        } finally {
          finish.resolve();
          await recent;
        }
      }
    );
    await t.test(
      'a corrected repeated page resumes the pending offset without starting another Historical pass',
      async () => {
        let id = '';
        let repeated = false;
        const h = await setup(async (req) => {
          if (req.offset === 80 && !repeated) {
            repeated = true;
            return page(id, 0);
          }
          return page(id, req.offset, req.offset >= 160 ? 0 : 100);
        });
        id = h.id;
        await h.enable();
        await h.tick();
        await h.tick();
        const waiting = await scope(id);
        assert.equal(waiting.status, 'backoff');
        assert.equal(
          readCollectionCheckpoint(waiting.checkpoint)?.nextOffset,
          80
        );
        now = waiting.retryAfterAt!.getTime();
        await h.tick();
        for (let i = 0; i < 3; i++) await h.tick();
        assert.deepEqual(
          h.calls.map((call) => call.offset),
          [0, 80, 80, 160, 160, 240]
        );
        assert.equal(
          readCollectionState((await scope(id)).collectionState).coverage,
          'observed'
        );
        assert.equal((await scope(id)).nextRunAt, null);
        const diagnostic = await db
          .getRepository<CatalogueReleaseDiagnostic>(names.diagnostic)
          .findOneByOrFail({ trackerId: id, reason: 'repeated_page' });
        assert.equal(diagnostic.status, 'resolved');
        assert.equal(diagnostic.offset, 80);
      }
    );
    await t.test(
      'a fully quarantined page with broken overlap retries its pending offset without inventing a skipped region',
      async () => {
        let id = '';
        let failed = false;
        const h = await setup(async (req) => {
          if (req.offset === 80 && !failed) {
            failed = true;
            const response = page(id, 1080);
            response.records = response.records.map((record) => ({
              ...record,
              infohash: 'f'.repeat(40),
            }));
            return response;
          }
          return page(id, req.offset, req.offset >= 160 ? 0 : 100);
        });
        id = h.id;
        await new CatalogueRepository(db).persistPage(
          page(id, 1080).records,
          await scope(id)
        );
        await h.enable();
        await h.tick();
        await h.tick();
        const pending = await scope(id);
        assert.equal(
          readCollectionCheckpoint(pending.checkpoint)?.nextOffset,
          80
        );
        assert.equal(pending.status, 'backoff');
        now = pending.retryAfterAt!.getTime();
        await h.tick();
        for (let i = 0; i < 3; i++) await h.tick();
        assert.deepEqual(
          h.calls.map((call) => call.offset),
          [0, 80, 80, 160, 160, 240]
        );
        assert.equal(
          readCollectionCheckpoint((await scope(id)).checkpoint)?.dirty,
          false
        );
        assert.equal(
          readCollectionState((await scope(id)).collectionState).coverage,
          'partial'
        );
        assert.equal((await scope(id)).nextRunAt, null);
        assert.equal(
          await db
            .getRepository(names.diagnostic)
            .countBy({ trackerId: id, kind: 'scope', status: 'unresolved' }),
          0
        );
      }
    );
    await t.test(
      'large Historical collections with recurring and new source anomalies finish once without repair requests',
      async () => {
        let id = '';
        const pages = 12;
        const h = await setup(async (req) => {
          if (req.offset >= pages * 80) return page(id, req.offset, 0);
          const bad = [rejection(99999), rejection(100000 + req.offset / 80)];
          return {
            ...page(id, req.offset),
            contractStatus: 'partial',
            receivedCount: 102,
            anomalies: bad,
            rejections: bad,
          };
        });
        id = h.id;
        await h.enable();
        for (let i = 0; i < pages + 3; i++) await h.tick();
        const completed = await scope(id);
        assert.equal(
          readCollectionCheckpoint(completed.checkpoint)?.done,
          true
        );
        assert.equal(
          readCollectionCheckpoint(completed.checkpoint)?.dirty,
          false
        );
        assert.equal(
          readCollectionState(completed.collectionState).coverage,
          'partial'
        );
        assert.equal(completed.nextRunAt, null);
        assert.equal(completed.phase, 'complete');
        assert.equal(
          await db.getRepository(names.torrent).countBy({ trackerId: id }),
          pages * 80 + 20
        );
        const diagnostics = await db
          .getRepository<CatalogueReleaseDiagnostic>(names.diagnostic)
          .findBy({ trackerId: id });
        assert.equal(diagnostics.length, pages + 1);
        assert.equal(
          diagnostics.find((row) => row.guid === guid(99999))!.occurrences,
          pages
        );
        assert.ok(
          diagnostics.every(
            (row) =>
              row.status === 'quarantined' &&
              row.attempts === 0 &&
              row.nextAttemptAt === null
          )
        );
        await db.destroy();
        db = createCatalogueDataSource(connection);
        await db.initialize();
        const resumed = new CatalogueCollector(db, [h.tracker], clock);
        await resumed.initialize();
        for (let i = 0; i < 3; i++) {
          now += 86400000;
          assert.equal(await resumed.tick(), false);
          await resumed.initialize();
        }
        assert.equal(h.calls.length, pages + 3);
        assert.equal(h.calls.filter((call) => call.offset === 0).length, 1);
        assert.equal((await scope(id)).checkpoint, completed.checkpoint);
      }
    );
    await t.test(
      'filtered overlap uncertainty is non-repairable source data and cannot start a full rescan',
      async () => {
        let id = '';
        const h = await setup(async (req) => {
          if (req.offset >= 160) return page(id, req.offset, 0);
          if (req.offset === 0) {
            const bad = Array.from({ length: 20 }, (_, index) =>
              rejection(80 + index)
            );
            return {
              ...page(id, 0, 80),
              receivedCount: 100,
              contractStatus: 'partial',
              anomalies: bad,
              rejections: bad,
            };
          }
          return page(id, req.offset);
        });
        id = h.id;
        await h.enable();
        for (let i = 0; i < 5; i++) await h.tick();
        assert.equal(
          readCollectionState((await scope(id)).collectionState).coverage,
          'partial'
        );
        assert.equal(
          readCollectionCheckpoint((await scope(id)).checkpoint)?.dirty,
          false
        );
        assert.equal((await scope(id)).nextRunAt, null);
        const gap = await db
          .getRepository<CatalogueReleaseDiagnostic>(names.diagnostic)
          .findOneByOrFail({ trackerId: id, reason: 'source_data_overlap' });
        assert.equal(gap.status, 'quarantined');
        assert.equal(gap.nextAttemptAt, null);
      }
    );
    await t.test(
      'Recent and Historical source anomalies leave the other mode checkpoint, scheduling and repair counters unchanged',
      async () => {
        for (const affected of ['recent', 'historical'] as const) {
          let id = '';
          const h = await setup(
            async (req) => {
              if (h.calls.at(-1)?.mode === affected && req.offset === 0)
                return {
                  ...page(id, 0, 2),
                  receivedCount: 3,
                  anomalies: [rejection(999)],
                  rejections: [rejection(999)],
                };
              return page(id, req.offset, 0);
            },
            { recentPageLimit: 2 }
          );
          id = h.id;
          if (affected === 'recent') {
            await h.enable();
            for (let i = 0; i < 3; i++) await h.tick();
          }
          const other = affected === 'recent' ? 'historical' : 'recent';
          const before = await scope(id, other);
          await h.enable(affected);
          for (let i = 0; i < (affected === 'recent' ? 2 : 4); i++)
            await h.tick();
          assert.deepEqual(await scope(id, other), before);
          const diagnostics = await db
            .getRepository<CatalogueReleaseDiagnostic>(names.diagnostic)
            .findBy({ trackerId: id });
          assert.equal(diagnostics.length, 1);
          assert.equal(diagnostics[0].mode, affected);
          assert.equal(diagnostics[0].attempts, 0);
          const otherCollector = new CatalogueCollector(db, [h.tracker], clock);
          await otherCollector.initialize();
          assert.deepEqual(await scope(id, other), before);
          now += 86400000;
          await Promise.all([h.collector.tick(), otherCollector.tick()]);
          assert.deepEqual(await scope(id, other), before);
          assert.equal(
            h.calls.filter((call) => call.mode === 'historical').length,
            affected === 'recent' ? 3 : 4
          );
        }
      }
    );
    await t.test(
      'explicit cross-mode resolution matches the accepted GUID and validated field without touching unrelated state',
      async () => {
        const h = await setup(async (req) => page(h.id, req.offset, 0));
        await h.enable();
        for (let i = 0; i < 3; i++) await h.tick();
        const repository = db.getRepository<CatalogueReleaseDiagnostic>(
          names.diagnostic
        );
        await repository.insert([
          diagnosticFixture(h.id, 2),
          {
            ...diagnosticFixture(h.id, 2),
            diagnosticKey: 'fixture:categories',
            field: 'categories',
            reason: 'invalid_value',
          },
          diagnosticFixture(h.id, 3),
          diagnosticFixture(h.id, 2, 'recent'),
          {
            ...diagnosticFixture(h.id, 5),
            kind: 'scope',
            guid: null,
            releaseKey: null,
            diagnosticKey: 'scope:abnormal_overlap',
            field: 'page',
            reason: 'abnormal_overlap',
            status: 'unresolved',
            attempts: 2,
            nextAttemptAt: new Date(now + 60000),
          },
        ]);
        const hist = await scope(h.id);
        const histState = readCollectionState(hist.collectionState);
        histState.coverage = 'partial';
        const dirty = readCollectionCheckpoint(hist.checkpoint)!;
        dirty.dirty = true;
        await db.getRepository(names.sync).update(hist.id, {
          collectionState: JSON.stringify(histState),
          checkpoint: JSON.stringify(dirty),
          phase: 'repair',
          nextRunAt: new Date(now + 60000),
        });
        const untouched = await scope(h.id);
        const recent = await scope(h.id, 'recent');
        const checkpoint = {
          ...recent,
          checkpoint: hist.checkpoint,
          collectionState: JSON.stringify({
            ...readCollectionState(recent.collectionState),
            repairVersion: 2 as const,
          }),
        };
        const accepted = [
          {
            ...record(2, h.id),
            categories: undefined,
            observedAt: new Date(now),
          },
        ];
        await h.collector.store.write(async (manager) => {
          await upsertObservedTorrents(manager, accepted);
          const updated = await persistReleaseDiagnostics(
            manager,
            checkpoint,
            accepted,
            [],
            now
          );
          await saveSyncCheckpoint(manager, updated);
        });
        const rows = await repository.findBy({ trackerId: h.id });
        assert.equal(
          rows.find(
            (row) =>
              row.mode === 'historical' && row.diagnosticKey === 'fixture:2'
          )!.status,
          'resolved'
        );
        assert.equal(
          rows.find((row) => row.mode === 'recent')!.status,
          'resolved'
        );
        assert.equal(
          rows.find((row) => row.diagnosticKey === 'fixture:categories')!
            .status,
          'quarantined'
        );
        assert.equal(
          rows.find((row) => row.guid === guid(3))!.status,
          'quarantined'
        );
        assert.equal(
          rows.find((row) => row.reason === 'abnormal_overlap')!.status,
          'unresolved'
        );
        assert.equal(
          rows.find((row) => row.reason === 'abnormal_overlap')!.attempts,
          2
        );
        assert.deepEqual(await scope(h.id), untouched);
      }
    );
    await t.test(
      'old release-driven repair jobs are retired without requests, losing counters or promoting coverage',
      async () => {
        const h = await setup();
        await h.enable();
        await h.tick();
        const repository = db.getRepository<CatalogueReleaseDiagnostic>(
          names.diagnostic
        );
        await repository.insert(
          ['recent', 'historical'].map((mode) => ({
            ...diagnosticFixture(h.id, 999, mode as 'recent' | 'historical'),
            status: 'unresolved' as const,
            attempts: 2,
            nextAttemptAt: new Date(now + 30000),
          }))
        );
        const stored = await scope(h.id);
        const cp = readCollectionCheckpoint(stored.checkpoint)!;
        cp.repairRun = true;
        cp.dirty = true;
        const state = readCollectionState(stored.collectionState);
        state.repairVersion = 1;
        state.coverage = 'partial';
        await db.getRepository(names.sync).update(stored.id, {
          checkpoint: JSON.stringify(cp),
          collectionState: JSON.stringify(state),
          phase: 'repair',
          nextRunAt: new Date(now + 30000),
        });
        await db
          .getRepository(names.sync)
          .update(
            { trackerId: h.id, mode: 'recent' },
            { collectionState: JSON.stringify(state) }
          );
        const resumed = new CatalogueCollector(db, [h.tracker], clock);
        await resumed.initialize();
        const after = await scope(h.id);
        assert.equal(after.phase, 'complete');
        assert.equal(after.nextRunAt, null);
        assert.equal(
          readCollectionCheckpoint(after.checkpoint)?.nextOffset,
          cp.nextOffset
        );
        assert.equal(readCollectionCheckpoint(after.checkpoint)?.dirty, false);
        assert.equal(
          readCollectionState(after.collectionState).coverage,
          'partial'
        );
        assert.ok(
          (await repository.findBy({ trackerId: h.id })).every(
            (row) =>
              row.status === 'quarantined' &&
              row.attempts === 2 &&
              row.nextAttemptAt === null
          )
        );
        now += 86400000;
        assert.equal(await resumed.tick(), false);
        assert.equal(h.calls.length, 1);
      }
    );
    await t.test(
      'diagnostic page processing stays batched and loads only relevant rows with thousands of prior diagnoses',
      async () => {
        const h = await setup();
        await h.enable();
        await h.tick();
        const checkpoint = await scope(h.id);
        const repository = db.getRepository<CatalogueReleaseDiagnostic>(
          names.diagnostic
        );
        const incoming = Array.from({ length: 100 }, (_, index) =>
          rejection(9000 + index)
        );
        async function measured() {
          const queries: string[] = [];
          const returned: number[] = [];
          await h.collector.store.write(async (manager) => {
            const runner = manager.queryRunner!;
            const original = runner.query.bind(runner);
            const mock = t.mock.method(
              runner,
              'query',
              async (...args: Parameters<QueryRunner['query']>) => {
                const result = await original(...args);
                if (args[0].includes('release_diagnostics')) {
                  queries.push(args[0]);
                  if (/^SELECT/i.test(args[0]))
                    returned.push(
                      (Array.isArray(result) ? result : (result?.records ?? []))
                        .length
                    );
                }
                return result;
              }
            );
            try {
              await persistReleaseDiagnostics(
                manager,
                checkpoint,
                [{ ...record(100000, h.id), observedAt: new Date(now) }],
                incoming,
                now
              );
            } finally {
              mock.mock.restore();
            }
          });
          return { queries, returned };
        }
        const small = await measured();
        for (let start = 0; start < 4000; start += 100)
          await repository.insert(
            Array.from({ length: 100 }, (_, index) =>
              diagnosticFixture(
                h.id,
                100000 + start + index,
                (start + index) % 2 ? 'recent' : 'historical'
              )
            )
          );
        const unrelated = await repository.findOneByOrFail({
          trackerId: h.id,
          diagnosticKey: 'fixture:100001',
        });
        now += 3000;
        const large = await measured();
        assert.ok(
          large.queries.length <= 18,
          `Diagnostic SQL calls must be batched: ${large.queries.length}`
        );
        assert.ok(large.queries.length <= small.queries.length + 1);
        assert.ok(
          large.returned.every((count) => count <= 100),
          `No full-category materialization: ${large.returned}`
        );
        assert.deepEqual(
          await repository.findOneByOrFail({ id: unrelated.id }),
          unrelated
        );
        assert.equal(
          (
            await repository.findOneByOrFail({
              trackerId: h.id,
              guid: guid(9000),
            })
          ).occurrences,
          2
        );
        assert.equal(
          (
            await repository.findOneByOrFail({
              trackerId: h.id,
              diagnosticKey: 'fixture:100000',
            })
          ).status,
          'resolved'
        );
        assert.equal(await repository.countBy({ trackerId: h.id }), 4100);
        t.diagnostic(
          `Diagnostic SQL calls: baseline=${small.queries.length}, with 4000 prior rows=${large.queries.length}; maximum returned rows=${Math.max(...large.returned)}`
        );
        const runner = db.createQueryRunner();
        try {
          const indexes = await runner.getTable(
            connection.type === 'postgres'
              ? 'catalogue.release_diagnostics'
              : 'release_diagnostics'
          );
          assert.ok(
            indexes?.indices.some(
              (index) => index.name === 'IDX_catalogue_diagnostic_scope_state'
            )
          );
        } finally {
          await runner.release();
        }
      }
    );
    await t.test(
      'genuine failed region repairs remain bounded even when new source anomalies appear',
      async () => {
        let id = '';
        let repairing = false;
        const h = await setup(async (req) => {
          if (req.offset >= 160) return page(id, req.offset, 0);
          if (req.offset === 80) return page(id, 1080);
          const bad = rejection(99999 + h.calls.length);
          return repairing
            ? {
                ...page(id, 0),
                receivedCount: 101,
                anomalies: [bad],
                rejections: [bad],
              }
            : page(id, 0);
        });
        id = h.id;
        await h.enable();
        for (let i = 0; i < 5; i++) await h.tick();
        repairing = true;
        for (let attempt = 1; attempt <= 3; attempt++) {
          now = (await scope(id)).nextRunAt!.getTime();
          for (let i = 0; i < 5; i++) await h.tick(6000);
          const region = await db
            .getRepository<CatalogueReleaseDiagnostic>(names.diagnostic)
            .findOneByOrFail({ trackerId: id, reason: 'abnormal_overlap' });
          assert.equal(region.attempts, attempt);
          assert.equal(
            region.status,
            attempt === 3 ? 'quarantined' : 'unresolved'
          );
        }
        assert.equal(
          readCollectionCheckpoint((await scope(id)).checkpoint)?.dirty,
          false
        );
        assert.equal(
          readCollectionState((await scope(id)).collectionState).coverage,
          'partial'
        );
        assert.equal((await scope(id)).nextRunAt, null);
        const calls = h.calls.length;
        now += 86400000;
        await h.collector.initialize();
        assert.equal(await h.collector.tick(), false);
        assert.equal(h.calls.length, calls);
      }
    );
    await t.test(
      'different causes share a release key without conflating diagnostics and page rollback also rolls back diagnostics',
      async () => {
        const h = await setup();
        await h.enable();
        await h.tick();
        now += 3000;
        const claimed = await h.collector.store.claimNext(
          h.tracker,
          'diagnostic-owner',
          h.tracker.settings
        );
        assert.ok(claimed);
        const repository = new CatalogueRepository(db);
        const before = await scope(h.id);
        const cp = readCollectionCheckpoint(before.checkpoint)!;
        cp.nextOffset += 80;
        cp.pages++;
        const input = { ...before, checkpoint: JSON.stringify(cp) };
        const causes = [rejection(999), rejection(999, 'categories')];
        const records = [record(998, h.id)];
        await assert.rejects(
          repository.persistPage(records, input, {
            owner: 'diagnostic-owner',
            clock,
            onIdentityConflicts: () => input,
            beforeCheckpoint: async (manager, accepted, checkpoint) => {
              await persistReleaseDiagnostics(
                manager,
                checkpoint,
                accepted,
                causes,
                now
              );
              throw new Error('Synthetic commit failure');
            },
          }),
          /Synthetic commit failure/
        );
        assert.equal(
          await db.getRepository(names.diagnostic).countBy({ trackerId: h.id }),
          0
        );
        assert.equal(await repository.findTorrentByGuid(h.id, guid(998)), null);
        assert.equal((await scope(h.id)).checkpoint, before.checkpoint);
        await repository.persistPage(records, input, {
          owner: 'diagnostic-owner',
          clock,
          onIdentityConflicts: () => input,
          beforeCheckpoint: (manager, accepted, checkpoint) =>
            persistReleaseDiagnostics(
              manager,
              checkpoint,
              accepted,
              causes,
              now
            ),
        });
        const diagnostics = await db
          .getRepository<CatalogueReleaseDiagnostic>(names.diagnostic)
          .findBy({ trackerId: h.id });
        assert.equal(diagnostics.length, 2);
        assert.equal(new Set(diagnostics.map((row) => row.releaseKey)).size, 1);
        assert.notEqual(
          diagnostics[0].diagnosticKey,
          diagnostics[1].diagnosticKey
        );
        await h.collector.store.release(claimed.scope, 'diagnostic-owner');
      }
    );
    await t.test(
      'unidentified source rejections retain uncertainty without creating repair work',
      async () => {
        let id = '';
        const h = await setup(async (req) =>
          req.offset
            ? page(id, req.offset, 0)
            : {
                ...page(id, 0, 2),
                receivedCount: 3,
                anomalies: [
                  {
                    itemIndex: 2,
                    field: 'canonicalGuid',
                    code: 'contract_incompatible',
                  } as const,
                ],
              }
        );
        id = h.id;
        await h.enable();
        for (let i = 0; i < 4; i++) await h.tick();
        const rows = await db
          .getRepository<CatalogueReleaseDiagnostic>(names.diagnostic)
          .findBy({ trackerId: id });
        assert.equal(rows.length, 1);
        assert.equal(rows[0].releaseKey, null);
        assert.equal(rows[0].status, 'quarantined');
        assert.equal(rows[0].lastOutcome, 'source_data_unrepairable');
        assert.equal(rows[0].attempts, 0);
        assert.equal(rows[0].nextAttemptAt, null);
        assert.equal(
          readCollectionCheckpoint((await scope(id)).checkpoint)?.dirty,
          false
        );
        assert.equal(
          readCollectionState((await scope(id)).collectionState).coverage,
          'partial'
        );
        assert.equal((await scope(id)).nextRunAt, null);
        const calls = h.calls.length;
        now += 86400000;
        await h.collector.initialize();
        await h.collector.enqueueRecent('tv');
        await h.collector.tick();
        assert.equal(
          h.calls.filter((call) => call.mode === 'historical').length,
          calls
        );
      }
    );
    await t.test(
      'repair requests preserve Recent priority, concurrent ownership, Retry-After and maintenance spacing',
      async () => {
        let id = '';
        let repair = false;
        let fail = true;
        const h = await setup(
          async (req) => {
            if (h.calls.at(-1)?.mode === 'recent')
              return {
                ...page(id, req.offset),
                records: page(id, req.offset + 1000).records,
              };
            if (repair && fail) {
              fail = false;
              throw httpError(429, '120');
            }
            if (req.offset >= 160) return page(id, req.offset, 0);
            if (req.offset === 80 && !repair) return page(id, 1080);
            if (req.offset) return page(id, req.offset, 0);
            return repair ? page(id, 0, 3) : page(id, 0);
          },
          { recentPageLimit: 2 }
        );
        id = h.id;
        await h.enable();
        for (let i = 0; i < 5; i++) await h.tick();
        now = (await scope(id)).nextRunAt!.getTime();
        repair = true;
        const other = new CatalogueCollector(db, [h.tracker], clock);
        await other.initialize();
        await h.collector.enqueueRecent('movie');
        const count = h.calls.length;
        await Promise.all([h.collector.tick(), other.tick()]);
        assert.equal(h.calls.length, count + 1);
        assert.equal(h.calls.at(-1)?.mode, 'recent');
        now += 3000;
        await other.tick();
        assert.equal(h.calls.at(-1)?.mode, 'recent');
        now += 3000;
        await h.collector.tick();
        const failed = await scope(id);
        assert.equal(failed.status, 'backoff');
        assert.equal(failed.retryAfterAt!.getTime(), now + 120000);
        const attempts = await db
          .getRepository<CatalogueReleaseDiagnostic>(names.diagnostic)
          .findOneByOrFail({
            trackerId: id,
            kind: 'scope',
            reason: 'abnormal_overlap',
          });
        assert.equal(attempts.attempts, 1);
        now += 119999;
        assert.equal(await other.tick(), false);
        now++;
        await other.tick();
        assert.equal(h.calls.at(-1)?.offset, 0);
        const retried = h.calls.length;
        now += 3000;
        assert.equal(await h.collector.tick(), false);
        assert.equal(h.calls.length, retried);
        now += 3000;
        await other.tick();
        assert.equal(h.calls.length, retried + 1);
      }
    );
    await t.test(
      'a repair scan stops at its page budget and never turns an unverified region into observed coverage',
      async () => {
        const h = await setup();
        await h.enable();
        await h.tick();
        const stored = await scope(h.id);
        const cp = readCollectionCheckpoint(stored.checkpoint)!;
        cp.pages = REPAIR_PAGE_LIMIT - 1;
        cp.repairRun = true;
        cp.maintenance = true;
        cp.startedAt = now;
        await h.collector.store.write(async (manager) => {
          await persistReleaseDiagnostics(manager, stored, [], [], now, {
            region: 'abnormal_overlap',
          });
          await manager.getRepository(names.diagnostic).update(
            { trackerId: h.id, reason: 'abnormal_overlap' },
            {
              attempts: 3,
              lastAttemptCycle: stored.cycleId,
              lastOutcome: 'scanning',
            }
          );
        });
        await db.getRepository(names.sync).update(stored.id, {
          checkpoint: JSON.stringify(cp),
          phase: 'repair',
        });
        now += 6000;
        await h.collector.tick();
        const finished = await scope(h.id);
        assert.equal(readCollectionCheckpoint(finished.checkpoint)?.done, true);
        assert.equal(
          readCollectionCheckpoint(finished.checkpoint)?.dirty,
          false
        );
        assert.equal(
          readCollectionState(finished.collectionState).coverage,
          'partial'
        );
        assert.equal(
          (
            await db
              .getRepository<CatalogueReleaseDiagnostic>(names.diagnostic)
              .findOneByOrFail({
                trackerId: h.id,
                reason: 'scan_budget_exhausted',
              })
          ).status,
          'quarantined'
        );
        assert.equal(finished.nextRunAt, null);
        assert.equal(
          (
            await db
              .getRepository<CatalogueReleaseDiagnostic>(names.diagnostic)
              .findOneByOrFail({ trackerId: h.id, reason: 'abnormal_overlap' })
          ).status,
          'quarantined',
          'A page budget is not verification of the original region'
        );
      }
    );
    await t.test(
      'release diagnostics deduplicate real P2 rejections, persist safe identities and keep unknown releases separate',
      async () => {
        let id = '';
        const key = 'P3_DIAGNOSTIC_KEY_SENTINEL';
        const safeGuid = 'https://tr4ker.net/torrent/Unsupported_Format';
        const h = await setup(async (req) =>
          normalizeTorznabPage(
            `<rss xmlns:torznab="http://torznab.com/schemas/2015/feed"><channel>
        <item><guid>https://tr4ker.net/torrent/Valid-Release</guid><title>Valid</title></item>
        <item><guid>${safeGuid}</guid><title>Safe diagnostic title</title><torznab:attr name="infohash" value="${'a'.repeat(40)}"/></item>
        <item><guid>https://tr4ker.net/api/download?apikey=${key}</guid><title>${key}</title></item>
        <item><title>Unidentified</title></item>
        </channel></rss>`,
            { ...req, limit: 100, trackerId: id, observedAt: new Date(now) },
            TR4KER_CONTRACT,
            [key]
          )
        );
        id = h.id;
        const diagnostics = () =>
          db.getRepository<CatalogueReleaseDiagnostic>(names.diagnostic).find({
            where: { trackerId: id, kind: 'release' },
            order: { id: 'ASC' },
          });
        await h.enable();
        await h.tick();
        const first = await diagnostics();
        assert.equal(first.length, 3);
        assert.equal(
          first.find((row) => row.guid === safeGuid)?.infohash,
          'a'.repeat(40)
        );
        assert.equal(
          first.find((row) => row.guid === safeGuid)?.reason,
          'guid_path'
        );
        const unsafe = first.find((row) => row.reason === 'guid_query')!;
        assert.equal(unsafe.guid, null);
        assert.equal(unsafe.title, null);
        assert.match(unsafe.fingerprint!, /^[a-f0-9]{64}$/);
        await db.destroy();
        db = createCatalogueDataSource(connection);
        await db.initialize();
        const resumed = new CatalogueCollector(db, [h.tracker], clock);
        await resumed.initialize();
        now += (await scope(id)).retryAfterAt!.getTime() - now;
        await resumed.tick();
        const rows = await diagnostics();
        assert.equal(
          rows.length,
          4,
          'Known releases deduplicate; unidentified observations remain separate'
        );
        const repeated = rows.find((row) => row.guid === safeGuid)!;
        assert.equal(
          repeated.id,
          first.find((row) => row.guid === safeGuid)!.id
        );
        assert.equal(repeated.occurrences, 2);
        assert.equal(repeated.firstSeenAt.getTime(), instant);
        assert.ok(repeated.lastSeenAt > repeated.firstSeenAt);
        assert.equal(
          rows.filter((row) => row.reason === 'missing_guid').length,
          2
        );
        assert.doesNotMatch(
          JSON.stringify(rows),
          /SENTINEL|apikey|\/api\/download|<item>/
        );
        assert.equal(
          await db.getRepository(names.torrent).countBy({ trackerId: id }),
          1
        );
        assert.equal(
          readCollectionCheckpoint((await scope(id)).checkpoint)?.nextOffset,
          0
        );
      }
    );
    await t.test(
      'Historical source anomalies finish normally and resolve only on verified normal maintenance observations',
      async () => {
        let id = '';
        let corrected = false;
        const h = await setup(async (req) => {
          if (req.offset) return page(id, req.offset, 0);
          const a = rejection(2);
          const b = rejection(3);
          return {
            ...page(id, 0, 2),
            records: corrected
              ? [
                  record(1000, id),
                  record(2, id),
                  record(0, id),
                  record(1, id),
                  { ...record(4, id), infohash: record(3, id).infohash },
                ]
              : page(id, 0, 2).records,
            receivedCount: corrected ? 6 : 4,
            anomalies: corrected ? [b] : [a, b],
            rejections: corrected ? [b] : [a, b],
          };
        });
        id = h.id;
        const diagnostics = () =>
          db
            .getRepository<CatalogueReleaseDiagnostic>(names.diagnostic)
            .findBy({ trackerId: id, kind: 'release' });
        await h.enable();
        for (let i = 0; i < 4; i++) await h.tick();
        assert.equal(
          await db.getRepository(names.torrent).countBy({ trackerId: id }),
          2
        );
        assert.equal((await diagnostics()).length, 2);
        assert.ok(
          (await diagnostics()).every(
            (row) =>
              row.status === 'quarantined' &&
              row.attempts === 0 &&
              row.nextAttemptAt === null
          )
        );
        assert.equal(
          readCollectionCheckpoint((await scope(id)).checkpoint)?.dirty,
          false
        );
        assert.equal(
          readCollectionState((await scope(id)).collectionState).coverage,
          'partial'
        );
        assert.equal((await scope(id)).phase, 'complete');
        assert.equal((await scope(id)).nextRunAt, null);
        await db.destroy();
        db = createCatalogueDataSource(connection);
        await db.initialize();
        const resumed = new CatalogueCollector(db, [h.tracker], clock);
        await resumed.initialize();
        now += 86400000;
        assert.equal(await resumed.tick(), false);
        assert.equal(h.calls.length, 4);
        corrected = true;
        h.tracker.settings.maintenanceIntervalMinutes = 1;
        await resumed.initialize();
        for (let i = 0; i < 4; i++) {
          await resumed.tick();
          now += 6000;
        }
        const rows = await diagnostics();
        assert.equal(
          rows.find((row) => row.guid === guid(2))!.status,
          'resolved'
        );
        const bad = rows.find((row) => row.guid === guid(3))!;
        assert.equal(bad.status, 'quarantined');
        assert.equal(bad.occurrences, 2);
        assert.equal(bad.attempts, 0);
        assert.equal(bad.nextAttemptAt, null);
        assert.equal(
          readCollectionCheckpoint((await scope(id)).checkpoint)?.dirty,
          false
        );
        assert.equal(
          readCollectionState((await scope(id)).collectionState).coverage,
          'partial'
        );
        assert.equal((await scope(id)).phase, 'complete');
        assert.equal(
          h.calls.filter(
            (call) => call.mode === 'historical' && call.offset === 0
          ).length,
          2
        );
      }
    );
    await t.test(
      'legacy dirty and partial checkpoints preserve uncertainty without scheduling unproven repairs',
      async () => {
        const h = await setup();
        await h.enable();
        await h.tick();
        const stored = await scope(h.id);
        const cp = readCollectionCheckpoint(stored.checkpoint)!;
        cp.done = true;
        cp.dirty = true;
        const state = readCollectionState(stored.collectionState);
        delete state.repairVersion;
        await db.getRepository(names.sync).update(stored.id, {
          checkpoint: JSON.stringify(cp),
          collectionState: JSON.stringify(state),
          phase: 'complete',
          nextRunAt: null,
        });
        const resumed = new CatalogueCollector(db, [h.tracker], clock);
        await resumed.initialize();
        assert.equal((await scope(h.id)).phase, 'complete');
        assert.equal((await scope(h.id)).nextRunAt, null);
        assert.equal(
          readCollectionCheckpoint((await scope(h.id)).checkpoint)?.dirty,
          false
        );
        const legacy = await db
          .getRepository<CatalogueReleaseDiagnostic>(names.diagnostic)
          .findOneByOrFail({ trackerId: h.id, reason: 'legacy_uncertainty' });
        assert.equal(legacy.status, 'quarantined');
        assert.equal(legacy.guid, null);
        assert.equal(
          readCollectionState((await scope(h.id)).collectionState).coverage,
          'partial'
        );
      }
    );
    await t.test(
      'a clean legacy in-progress scan resumes without inventing a repair defect',
      async () => {
        let id = '';
        const h = await setup(async (req) =>
          page(id, req.offset, req.offset ? 0 : 2)
        );
        id = h.id;
        await h.enable();
        await h.tick();
        const before = await scope(id);
        const state = readCollectionState(before.collectionState);
        delete state.repairVersion;
        await db
          .getRepository(names.sync)
          .update(before.id, { collectionState: JSON.stringify(state) });
        const resumed = new CatalogueCollector(db, [h.tracker], clock);
        await resumed.initialize();
        assert.equal((await scope(id)).checkpoint, before.checkpoint);
        assert.equal(
          await db.getRepository(names.diagnostic).countBy({ trackerId: id }),
          0
        );
        for (let i = 0; i < 3; i++) {
          now += 3000;
          await resumed.tick();
        }
        assert.equal(
          readCollectionState((await scope(id)).collectionState).coverage,
          'observed'
        );
      }
    );
    await t.test(
      'diagnostic retention is bounded and evicted uncertainty remains an explicit quarantined coverage blocker',
      async () => {
        let id = '';
        const h = await setup(async (req) =>
          page(id, req.offset, req.offset ? 0 : 2)
        );
        id = h.id;
        const repository = db.getRepository<CatalogueReleaseDiagnostic>(
          names.diagnostic
        );
        const base = {
          trackerId: h.id,
          categoryId: 2000,
          mode: 'historical' as const,
          kind: 'release' as const,
          releaseKey: null,
          guid: null,
          infohash: null,
          title: null,
          fingerprint: null,
          field: 'canonicalGuid',
          code: 'contract_incompatible',
          reason: 'missing_guid',
          critical: true,
          firstSeenAt: new Date(instant),
          lastSeenAt: new Date(instant),
          occurrences: 1,
          status: 'unresolved' as const,
          attempts: 0,
          nextAttemptAt: new Date(instant + 30000),
          lastAttemptCycle: null,
          lastOutcome: 'pending',
          resolvedAt: null,
          offset: null,
          itemPosition: null,
        };
        const checkpoint = await scope(h.id);
        for (let start = 0; start < DIAGNOSTIC_LIMIT + 2; start += 100)
          await repository.insert(
            Array.from(
              { length: Math.min(100, DIAGNOSTIC_LIMIT + 2 - start) },
              (_, index) => ({
                ...base,
                diagnosticKey: `unknown:${start + index}`,
              })
            )
          );
        await h.collector.store.write((manager) =>
          retainDiagnostics(manager, checkpoint, now)
        );
        assert.equal(
          await repository.countBy({ trackerId: h.id, kind: 'release' }),
          DIAGNOSTIC_LIMIT
        );
        assert.equal(
          (
            await repository.findOneByOrFail({
              trackerId: h.id,
              reason: 'retention_uncertainty',
            })
          ).status,
          'quarantined'
        );
        const recentResolution = await repository.findOneByOrFail({
          trackerId: h.id,
          kind: 'release',
        });
        await repository.update(recentResolution.id, {
          status: 'resolved',
          lastSeenAt: new Date(instant - DIAGNOSTIC_RETENTION_MS - 1),
          resolvedAt: new Date(now),
        });
        await h.collector.store.write((manager) =>
          retainDiagnostics(manager, checkpoint, now)
        );
        assert.ok(
          await repository.findOneBy({ id: recentResolution.id }),
          'A recent resolution retains its history even when the rejection is old'
        );
        await repository.update(
          { trackerId: h.id, kind: 'release' },
          {
            status: 'resolved',
            lastSeenAt: new Date(instant - DIAGNOSTIC_RETENTION_MS - 1),
            resolvedAt: new Date(instant - DIAGNOSTIC_RETENTION_MS - 1),
          }
        );
        await h.collector.store.write((manager) =>
          retainDiagnostics(manager, checkpoint, now)
        );
        assert.equal(await repository.countBy({ trackerId: h.id }), 1);
        await repository.insert({
          ...base,
          diagnosticKey: 'evicted-and-reobserved',
          releaseKey: 'b'.repeat(64),
          guid: guid(999),
          field: 'releaseName',
          reason: 'missing_title',
          status: 'quarantined',
          nextAttemptAt: null,
          lastOutcome: 'source_data_unrepairable',
        });
        await h.enable();
        for (let i = 0; i < 4; i++) await h.tick();
        assert.equal(
          readCollectionCheckpoint((await scope(id)).checkpoint)?.dirty,
          false
        );
        assert.equal(
          readCollectionState((await scope(id)).collectionState).coverage,
          'partial'
        );
        assert.equal((await scope(id)).nextRunAt, null);
        const calls = h.calls.length;
        now += 86400000;
        await h.collector.initialize();
        assert.equal(await h.collector.tick(), false);
        assert.equal(h.calls.length, calls);
      }
    );
    await t.test(
      'Historical request retries recover at the same checkpoint without inventing a coverage gap',
      async () => {
        for (const scenario of [
          {
            error: new TrackerAdapterError('timeout', true),
            delay: 30000,
            gap: false,
          },
          { error: httpError(429, '120'), delay: 120000, gap: false },
          { error: httpError(503), delay: 30000, gap: false },
          {
            error: new TrackerAdapterError('timeout', true),
            delay: 30000,
            gap: true,
          },
        ]) {
          let id = '';
          let failed = false;
          const h = await setup(async (req) => {
            if (req.offset === 80 && !failed) {
              failed = true;
              throw scenario.error;
            }
            if (req.offset >= 160) return page(id, req.offset, 0);
            return {
              ...page(id, req.offset),
              anomalies:
                req.offset === 0 && scenario.gap
                  ? [
                      {
                        itemIndex: 100,
                        code: 'invalid_identity',
                        field: 'canonicalGuid',
                      } as const,
                    ]
                  : [],
            };
          });
          id = h.id;
          await h.enable();
          await h.tick();
          await h.tick();
          const backoff = await scope(id);
          const cp = readCollectionCheckpoint(backoff.checkpoint)!;
          assert.equal(cp.nextOffset, 80);
          assert.equal(cp.pages, 1);
          assert.equal(cp.dirty, false);
          assert.equal(backoff.status, 'backoff');
          assert.equal(
            backoff.retryAfterAt?.getTime(),
            instant + 3000 + scenario.delay
          );
          assert.equal(
            readCollectionState(backoff.collectionState).coverage,
            'partial'
          );
          await db.destroy();
          db = createCatalogueDataSource(connection);
          await db.initialize();
          const resumed = new CatalogueCollector(db, [h.tracker], clock);
          await resumed.initialize();
          assert.equal(await resumed.tick(), false);
          assert.equal(h.calls.length, 2);
          now = backoff.retryAfterAt!.getTime();
          await resumed.tick();
          assert.equal(h.calls.at(-1)?.offset, 80);
          assert.equal(
            readCollectionCheckpoint((await scope(id)).checkpoint)?.dirty,
            false
          );
          assert.equal(
            readCollectionState((await scope(id)).collectionState).failures,
            0
          );
          for (let i = 0; i < 3; i++) {
            now += 3000;
            await resumed.tick();
          }
          assert.equal(
            readCollectionCheckpoint((await scope(id)).checkpoint)?.done,
            true
          );
          assert.equal(
            readCollectionState((await scope(id)).collectionState).coverage,
            scenario.gap ? 'partial' : 'observed'
          );
          assert.deepEqual(
            h.calls.map((call) => call.offset),
            [0, 80, 80, 160, 160, 240]
          );
        }
      }
    );
    await t.test(
      'all critical normalized rejections keep progress pending and use bounded scope retries',
      async () => {
        for (const code of [
          'identity_conflict',
          'invalid_identity',
          'contract_incompatible',
        ] as const) {
          let id = '';
          let corrected = false;
          const h = await setup(async (req) =>
            corrected
              ? page(id, req.offset, req.offset === 0 ? 2 : 0)
              : {
                  ...page(id, req.offset, 0),
                  receivedCount: 2,
                  anomalies: [
                    { itemIndex: 0, code, field: 'infohash' } as const,
                    { itemIndex: 1, code, field: 'canonicalGuid' } as const,
                  ],
                  rejections: [
                    rejection(0, 'infohash'),
                    rejection(1, 'canonicalGuid'),
                  ],
                }
          );
          id = h.id;
          await h.enable();
          for (let attempt = 1; attempt <= 5; attempt++) {
            await h.collector.tick();
            const stored = await scope(id);
            const cp = readCollectionCheckpoint(stored.checkpoint)!;
            assert.equal(cp.nextOffset, 0);
            assert.equal(cp.pages, 0);
            assert.equal(stored.pagesProcessed, 0);
            assert.equal(cp.empty, null);
            assert.equal(cp.done, false);
            assert.equal(stored.lastSuccessfulAt, null);
            assert.equal(
              readCollectionState(stored.collectionState).failures,
              attempt
            );
            assert.equal(
              stored.status,
              attempt === 5 ? 'suspended' : 'backoff'
            );
            assert.equal(
              readCollectionState(stored.collectionState).coverage,
              'partial'
            );
            now = stored.retryAfterAt!.getTime();
          }
          assert.equal(
            (
              await db
                .getRepository(names.dispatch)
                .findOneByOrFail({ trackerId: id })
            ).suspended,
            false
          );
          assert.equal(
            await db.getRepository(names.torrent).countBy({ trackerId: id }),
            0
          );
          corrected = true;
          await h.collector.store.recover(id, 2000, 'historical');
          await h.tick();
          assert.equal(h.calls.at(-1)?.offset, 0);
          assert.equal(
            readCollectionCheckpoint((await scope(id)).checkpoint)?.nextOffset,
            80
          );
          for (let i = 0; i < 3; i++) await h.tick();
          assert.equal(
            readCollectionState((await scope(id)).collectionState).coverage,
            'observed'
          );
          assert.equal(
            await db.getRepository(names.torrent).countBy({ trackerId: id }),
            2
          );
        }
      }
    );
    await t.test(
      'repository rejection of every conflicting identity rolls back tentative progress and success state',
      async () => {
        let id = '';
        let corrected = false;
        const h = await setup(async (req) => {
          if (req.offset > 0) return page(id, req.offset, 0);
          const result = page(id, 0, 2);
          if (!corrected)
            result.records = result.records.map((record) => ({
              ...record,
              infohash: 'f'.repeat(40),
            }));
          return result;
        });
        id = h.id;
        const repository = new CatalogueRepository(db);
        await repository.persistPage(page(id, 0, 2).records, await scope(id));
        await h.enable();
        now += 1000;
        for (let attempt = 1; attempt <= 5; attempt++) {
          await h.collector.tick();
          const stored = await scope(id);
          const cp = readCollectionCheckpoint(stored.checkpoint)!;
          assert.equal(cp.nextOffset, 0);
          assert.equal(cp.pages, 0);
          assert.equal(stored.pagesProcessed, 0);
          assert.equal(stored.lastSuccessfulAt, null);
          assert.equal(stored.lastObservedAt, null);
          assert.equal(
            readCollectionState(stored.collectionState).failures,
            attempt
          );
          assert.equal(stored.status, attempt === 5 ? 'suspended' : 'backoff');
          assert.equal(
            (
              await repository.findTorrentByGuid(id, guid(0))
            )?.lastSeenAt.getTime(),
            instant
          );
          assert.equal(
            (await repository.findTorrentByGuid(id, guid(0)))?.infohash,
            record(0, id).infohash
          );
          now = stored.retryAfterAt!.getTime();
        }
        corrected = true;
        await h.collector.store.recover(id, 2000, 'historical');
        await h.tick();
        assert.equal(
          readCollectionCheckpoint((await scope(id)).checkpoint)?.nextOffset,
          80
        );
        for (let i = 0; i < 3; i++) await h.tick();
        assert.equal(
          readCollectionState((await scope(id)).collectionState).coverage,
          'observed'
        );
        assert.equal(
          await db.getRepository(names.torrent).countBy({ trackerId: id }),
          2
        );
      }
    );
    await t.test(
      'a rejected nonempty page cancels terminal confirmation and retains uncertainty until verified',
      async () => {
        let id = '';
        let reads = 0;
        const h = await setup(async (req) =>
          ++reads === 3
            ? {
                ...page(id, req.offset, 0),
                receivedCount: 2,
                anomalies: [
                  {
                    itemIndex: 0,
                    code: 'identity_conflict',
                    field: 'infohash',
                  } as const,
                ],
              }
            : page(id, req.offset, 0)
        );
        id = h.id;
        await h.enable();
        await h.tick();
        await h.tick();
        await h.tick();
        const rejected = await scope(id);
        const cp = readCollectionCheckpoint(rejected.checkpoint)!;
        assert.equal(cp.nextOffset, 80);
        assert.equal(cp.pages, 2);
        assert.equal(cp.empty, null);
        assert.equal(cp.done, false);
        assert.equal(rejected.status, 'backoff');
        now = rejected.retryAfterAt!.getTime();
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
        assert.equal(
          readCollectionCheckpoint((await scope(id)).checkpoint)?.done,
          true
        );
        assert.deepEqual(
          h.calls.map((call) => call.offset),
          [0, 0, 80, 80, 80, 160]
        );
        assert.equal(
          readCollectionState((await scope(id)).collectionState).coverage,
          'partial'
        );
        assert.equal(
          readCollectionCheckpoint((await scope(id)).checkpoint)?.dirty,
          false
        );
      }
    );
    await t.test(
      'native provenance accepts protocol-independent tracker fields while rejecting unsafe or malformed claims atomically',
      async () => {
        const h = await setup();
        const repository = new CatalogueRepository(db);
        const observation: ObservedTorrent = {
          ...record(0, h.id),
          provenance: {
            tmdbId: { source: 'tracker', field: 'api.attributes.tmdbId' },
            tvdbId: { source: 'tracker', field: '/metadata/tvdb_id' },
            season: { source: 'tracker', field: 'json:season_number' },
            episode: { source: 'tracker', field: '$.episode' },
          },
        };
        const checkpoint = await scope(h.id);
        const [saved] = await repository.persistPage([observation], checkpoint);
        assert.deepEqual(
          JSON.parse(saved.nativeProvenance!),
          observation.provenance
        );
        assert.equal(saved.nativeTmdbId, 42);
        assert.equal(saved.nativeTvdbId, 84);
        assert.equal(saved.nativeEpisode, 0);
        const invalidOrigins: unknown[] = [
          undefined,
          null,
          {},
          [],
          { source: 'SECRET', field: 'api.tmdbId' },
          { source: 'application', field: 'api.tmdbId' },
          { source: 'tracker', field: '' },
          { source: 'tracker', field: 42 },
          { source: 'tracker', field: 'x'.repeat(129) },
          {
            source: 'tracker',
            field: 'https://tracker.invalid/tmdb?apikey=SECRET',
          },
          { source: 'tracker', field: 'api:token/SECRET' },
          { source: 'tracker', field: 'api:api_key/SECRET' },
          { source: 'tracker', field: 'api:<tmdb>SECRET</tmdb>' },
          { source: 'tracker', field: 'api:tmdb%0ASECRET' },
          { source: 'tracker', field: 'api:tmdb\nSECRET' },
          { source: 'tracker', field: 'api:tmdb', rawValue: 'SECRET' },
        ];
        for (const origin of invalidOrigins) {
          const invalid = {
            ...record(1, h.id),
            trackerMetadata: {
              tmdbId: 42,
              tvdbId: null,
              season: null,
              episode: null,
            },
            provenance: { tmdbId: origin },
          } as ObservedTorrent;
          await assert.rejects(
            repository.persistPage([record(2, h.id), invalid], {
              ...checkpoint,
              pagesProcessed: 999,
            }),
            /Invalid catalogue native metadata provenance/
          );
          assert.equal(
            await db.getRepository(names.torrent).countBy({ trackerId: h.id }),
            1
          );
          assert.equal(
            (await scope(h.id)).pagesProcessed,
            checkpoint.pagesProcessed
          );
        }
        const [unknown] = await repository.persistPage(
          [
            {
              ...record(1, h.id),
              trackerMetadata: {
                tmdbId: null,
                tvdbId: null,
                season: null,
                episode: null,
              },
              provenance: undefined,
            },
          ],
          checkpoint
        );
        assert.equal(unknown.nativeTmdbId, null);
        assert.deepEqual(JSON.parse(unknown.nativeProvenance!), {});
        await db.destroy();
        db = createCatalogueDataSource(connection);
        await db.initialize();
        assert.deepEqual(
          JSON.parse(
            (await new CatalogueRepository(db).findTorrent(saved.id))!
              .nativeProvenance!
          ),
          observation.provenance
        );
      }
    );
    await t.test(
      'logical Recent schedules resolve each tracker category and isolate unsupported, suspended and unavailable work',
      async () => {
        const a = await setup(undefined, { recentPageLimit: 2 });
        const b = await setup(
          undefined,
          { recentPageLimit: 2 },
          {
            categories: [
              { id: 7100, requestCategory: 'movie', recentStaggerMs: 0 },
              { id: 9300, requestCategory: 'tv', recentStaggerMs: 10000 },
            ],
          }
        );
        const collector = new CatalogueCollector(
          db,
          [a.tracker, b.tracker],
          clock
        );
        await collector.enqueueRecent('movie');
        assert.ok((await scope(a.id, 'recent', 2000)).nextRunAt);
        assert.ok((await scope(b.id, 'recent', 7100)).nextRunAt);
        assert.equal((await scope(a.id, 'recent', 5000)).nextRunAt, null);
        assert.equal((await scope(b.id, 'recent', 9300)).nextRunAt, null);
        assert.equal(
          await db
            .getRepository(names.sync)
            .countBy({ trackerId: b.id, categoryId: 2000 }),
          0
        );
        assert.equal(
          await db
            .getRepository(names.sync)
            .countBy({ trackerId: b.id, categoryId: 5000 }),
          0
        );
        await collector.enqueueRecent('tv');
        for (let i = 0; i < 4; i++) {
          await collector.tick();
          now += 3000;
        }
        assert.deepEqual(
          a.calls.map((call) => call.category),
          ['movie', 'tv', 'movie', 'tv']
        );
        assert.deepEqual(
          b.calls.map((call) => call.category),
          ['movie', 'tv', 'movie', 'tv']
        );
        assert.equal((await scope(b.id, 'recent', 7100)).nextRunAt, null);
        assert.equal((await scope(b.id, 'recent', 9300)).nextRunAt, null);
        now += 900000;
        const enqueue = collector.store.enqueueRecent.bind(collector.store);
        const failure = t.mock.method(
          collector.store,
          'enqueueRecent',
          async (id: string, categoryId: number) => {
            if (id === a.id)
              throw new Error('Synthetic unavailable tracker SECRET');
            return enqueue(id, categoryId);
          }
        );
        try {
          await assert.rejects(
            collector.enqueueRecent('movie'),
            /Synthetic unavailable tracker/
          );
        } finally {
          failure.mock.restore();
        }
        assert.ok((await scope(b.id, 'recent', 7100)).nextRunAt);
        assert.equal((await scope(a.id, 'recent', 2000)).nextRunAt, null);
        await db
          .getRepository(names.dispatch)
          .update({ trackerId: a.id }, { suspended: true });
        await collector.enqueueRecent('movie');
        await collector.tick();
        assert.equal(a.calls.length, 4);
        assert.equal(b.calls.length, 5);
        now += 3000;
        await collector.tick();
        assert.equal(b.calls.length, 6);
        b.tracker.categories = b.tracker.categories.filter(
          (category) => category.requestCategory === 'tv'
        );
        now += 900000;
        await collector.enqueueRecent('movie');
        assert.equal(
          (await scope(b.id, 'recent', 7100)).nextRunAt,
          null,
          'An unsupported movie mapping must not be substituted'
        );
        await collector.enqueueRecent('tv');
        assert.ok((await scope(b.id, 'recent', 9300)).nextRunAt);
        assert.equal(
          await db.getRepository(names.sync).countBy({ trackerId: b.id }),
          4
        );
      }
    );
    await t.test(
      'ordered moving pages tolerate 21/19 overlaps and multiple ordinary front shifts',
      async () => {
        for (const shifts of [
          [0, -1],
          [0, 1],
          [0, -1, 2, -3, 3],
        ]) {
          let id = '';
          let index = 0;
          const h = await setup(async (req) =>
            index < shifts.length
              ? page(id, req.offset + shifts[index++])
              : page(id, req.offset, 0)
          );
          id = h.id;
          await h.enable();
          for (let i = 0; i < shifts.length; i++) await h.tick();
          const progress = readCollectionCheckpoint(
            (await scope(id)).checkpoint
          )!;
          assert.equal(progress.dirty, false);
          assert.equal(progress.nextOffset, shifts.length * 80);
          assert.deepEqual(
            h.calls.map((call) => call.offset),
            shifts.map((_, index) => index * 80)
          );
          assert.equal(
            readCollectionState(
              (await scope(id)).collectionState
            ).diagnostics.some((d) => d.code === 'abnormal_overlap'),
            false
          );
          if (shifts.length === 2) {
            const ids = new Set(
              page(id, 0).records.map((record) => record.canonicalGuid)
            );
            assert.equal(
              page(id, 80 + shifts[1]).records.filter((record) =>
                ids.has(record.canonicalGuid)
              ).length,
              shifts[1] === -1 ? 21 : 19
            );
          }
          for (let i = 0; i < 3; i++) await h.tick();
          assert.equal(
            readCollectionState((await scope(id)).collectionState).coverage,
            'observed'
          );
        }
      }
    );
    await t.test(
      'broken or reordered continuity remains partial across restart; a clean later pass repairs coverage',
      async () => {
        for (const reordered of [false, true]) {
          let id = '';
          let count = 0;
          let clean = false;
          const h = await setup(
            async (req) => {
              if (count++ >= 2) return page(id, req.offset, 0);
              const result = page(
                id,
                req.offset + (!clean && req.offset > 0 && !reordered ? 1000 : 0)
              );
              if (!clean && reordered && req.offset > 0)
                result.records.splice(
                  0,
                  20,
                  ...result.records.slice(0, 20).reverse()
                );
              return result;
            },
            { maintenanceIntervalMinutes: 1 }
          );
          id = h.id;
          await h.enable();
          await h.tick();
          await h.tick();
          assert.equal(
            readCollectionCheckpoint((await scope(id)).checkpoint)?.dirty,
            true
          );
          await db.destroy();
          db = createCatalogueDataSource(connection);
          await db.initialize();
          const resumed = new CatalogueCollector(db, [h.tracker], clock);
          await resumed.initialize();
          for (let i = 0; i < 3; i++) {
            await resumed.tick();
            now += 3000;
          }
          assert.equal(
            readCollectionState((await scope(id)).collectionState).coverage,
            'partial'
          );
          assert.equal(
            readCollectionCheckpoint((await scope(id)).checkpoint)?.done,
            true
          );
          clean = true;
          count = 0;
          now += 60000;
          for (let i = 0; i < 5; i++) {
            await resumed.tick();
            now += 6000;
          }
          const state = readCollectionState((await scope(id)).collectionState);
          assert.equal(state.coverage, 'observed');
          assert.ok(
            state.diagnostics.some((d) => d.code === 'abnormal_overlap')
          );
        }
      }
    );
    await t.test(
      'absent and malformed optional metadata retain reliable observation coverage and safe diagnostics',
      async () => {
        for (const malformed of [false, true]) {
          let id = '';
          let first = true;
          const h = await setup(async (req) => {
            if (!first) return page(id, req.offset, 0);
            first = false;
            return {
              ...page(id, req.offset, 2),
              records: page(id, req.offset, 2).records.map((record) => ({
                ...record,
                trackerMetadata: {
                  tmdbId: null,
                  tvdbId: null,
                  season: null,
                  episode: null,
                },
                provenance: {},
              })),
              anomalies: malformed
                ? [
                    {
                      itemIndex: 0,
                      code: 'invalid_field',
                      field: 'tmdbId',
                      rejectedValue: 'SECRET',
                      rawXml: '<xml>SECRET</xml>',
                      url: 'https://secret.invalid/',
                    } as const,
                  ]
                : [],
            };
          });
          id = h.id;
          await h.enable();
          for (let i = 0; i < 4; i++) await h.tick();
          const stored = await scope(id);
          const state = readCollectionState(stored.collectionState);
          assert.equal(state.coverage, 'observed');
          assert.equal(stored.status, 'idle');
          assert.equal(state.diagnostics.length, malformed ? 1 : 0);
          if (malformed)
            assert.deepEqual(state.diagnostics[0], {
              code: 'invalid_field',
              field: 'tmdbId',
              at: instant,
              count: 1,
            });
          assert.ok(!JSON.stringify(state).match(/SECRET|<xml>|https:/));
          assert.equal(
            await db.getRepository(names.torrent).countBy({ trackerId: id }),
            2
          );
        }
      }
    );
    await t.test(
      'critical rejection cannot be cleared by terminal emptiness; corrected reprocessing restores coverage',
      async () => {
        let id = '';
        let first = true;
        let corrected = false;
        const h = await setup(
          async (req) => {
            if (!first) return page(id, req.offset, 0);
            first = false;
            return {
              ...page(id, req.offset, corrected ? 3 : 2),
              receivedCount: 3,
              rejections: corrected ? [] : [rejection(2, 'canonicalGuid')],
              anomalies: corrected
                ? []
                : [
                    {
                      itemIndex: 2,
                      code: 'invalid_identity',
                      field: 'canonicalGuid',
                    } as const,
                  ],
            };
          },
          { maintenanceIntervalMinutes: 1 }
        );
        id = h.id;
        await h.enable();
        for (let i = 0; i < 4; i++) await h.tick();
        assert.equal(
          readCollectionState((await scope(id)).collectionState).coverage,
          'partial'
        );
        assert.equal(
          readCollectionCheckpoint((await scope(id)).checkpoint)?.done,
          true
        );
        first = true;
        corrected = true;
        now += 60000;
        for (let i = 0; i < 4; i++) await h.tick(6000);
        assert.equal(
          readCollectionState((await scope(id)).collectionState).coverage,
          'observed'
        );
        assert.ok(
          readCollectionState(
            (await scope(id)).collectionState
          ).diagnostics.some((d) => d.code === 'invalid_identity')
        );
      }
    );
    await t.test(
      'tracker descriptions isolate identities, category mappings, page limits and derived progression',
      async () => {
        const a = await setup(
          undefined,
          {},
          {
            name: 'Synthetic A',
            connectorType: 'mock-a',
            categories: [
              { id: 7100, requestCategory: 'tv', recentStaggerMs: 25 },
            ],
            pagination: { limit: 10, overlap: 2 },
          }
        );
        const b = await setup(
          undefined,
          {},
          {
            name: 'Synthetic B',
            connectorType: 'mock-b',
            categories: [
              { id: 9200, requestCategory: 'movie', recentStaggerMs: 500 },
            ],
            pagination: { limit: 12, overlap: 3 },
          }
        );
        for (const h of [a, b]) {
          const rows = await db
            .getRepository<CatalogueSyncState>(names.sync)
            .findBy({ trackerId: h.id });
          assert.deepEqual(
            rows.map((row) => row.categoryId),
            [h.tracker.categories[0].id, h.tracker.categories[0].id]
          );
          assert.equal(
            (
              await db
                .getRepository(names.tracker)
                .findOneByOrFail({ id: h.id })
            ).name,
            h.tracker.name
          );
          assert.equal(
            (
              await db
                .getRepository(names.tracker)
                .findOneByOrFail({ id: h.id })
            ).connectorType,
            h.tracker.connectorType
          );
          await h.enable('historical', h.tracker.categories[0].id);
        }
        const collector = new CatalogueCollector(
          db,
          [a.tracker, b.tracker],
          clock
        );
        await collector.tick();
        now += 3000;
        await collector.tick();
        assert.deepEqual(
          a.calls.map((call) => [call.category, call.offset, call.limit]),
          [
            ['tv', 0, 10],
            ['tv', 8, 10],
          ]
        );
        assert.deepEqual(
          b.calls.map((call) => [call.category, call.offset, call.limit]),
          [
            ['movie', 0, 12],
            ['movie', 9, 12],
          ]
        );
        a.tracker.pagination = { limit: 6, overlap: 1 };
        const changed = new CatalogueCollector(
          db,
          [a.tracker, b.tracker],
          clock
        );
        await changed.initialize();
        now += 3000;
        await changed.tick();
        assert.equal(a.calls.at(-1)?.offset, 0);
        assert.equal(a.calls.at(-1)?.limit, 6);
        assert.equal(b.calls.at(-1)?.offset, 18);
        assert.equal(b.calls.at(-1)?.limit, 12);
        const cp = readCollectionCheckpoint(
          (await scope(a.id, 'historical', 7100)).checkpoint
        )!;
        assert.deepEqual(cp.pagination, { limit: 6, overlap: 1 });
        assert.equal(cp.nextOffset, 5);
        assert.equal(
          readCollectionState(
            (await scope(a.id, 'historical', 7100)).collectionState
          ).coverage,
          'partial'
        );
        assert.ok(
          readCollectionState(
            (await scope(a.id, 'historical', 7100)).collectionState
          ).diagnostics.some((d) => d.code === 'pagination_changed')
        );
        now += 3000;
        await changed.tick();
        assert.equal(a.calls.at(-1)?.offset, 5);
        assert.equal(
          await db.getRepository(names.torrent).countBy({ trackerId: a.id }),
          18
        );
        for (const pagination of [
          { limit: 1, overlap: 1 },
          { limit: 10, overlap: 0 },
          { limit: 10, overlap: 10 },
          { limit: 10.5, overlap: 2 },
        ])
          assert.throws(
            () =>
              new CatalogueCollector(db, [{ ...a.tracker, pagination }], clock),
            /Invalid catalogue collection description/
          );
      }
    );
    await t.test(
      'v1 checkpoint continuity upgrades without restarting a compatible deep scan',
      async () => {
        const h = await setup();
        await h.enable();
        await h.tick();
        await h.tick();
        const stored = await scope(h.id);
        const legacy = JSON.parse(stored.checkpoint!);
        legacy.version = 1;
        delete legacy.pagination;
        await db
          .getRepository(names.sync)
          .update(stored.id, { checkpoint: JSON.stringify(legacy) });
        const resumed = new CatalogueCollector(db, [h.tracker], clock);
        await resumed.initialize();
        await resumed.tick();
        assert.equal(h.calls.at(-1)?.offset, 160);
        assert.equal(
          readCollectionCheckpoint((await scope(h.id)).checkpoint)?.version,
          2
        );
        assert.equal(
          readCollectionCheckpoint((await scope(h.id)).checkpoint)?.dirty,
          false
        );
      }
    );
    await t.test(
      'delayed SQL preparation cannot compress actual global or maintenance adapter starts',
      async () => {
        for (const maintenance of [false, true]) {
          const h = await setup(undefined, { maintenanceIntervalMinutes: 1 });
          await h.enable('historical', 2000, {
            phase: maintenance ? 'maintenance' : 'initial',
          });
          await h.enable('historical', 5000, {
            phase: maintenance ? 'maintenance' : 'initial',
          });
          const preparation = deferred();
          const release = deferred();
          let delayed = false;
          const original = CatalogueRepository.prototype.persistPage;
          const mock = t.mock.method(
            CatalogueRepository.prototype,
            'persistPage',
            async function (
              this: CatalogueRepository,
              ...args: Parameters<typeof original>
            ) {
              if (
                !delayed &&
                args[0].length === 0 &&
                args[1].trackerId === h.id &&
                args[1].categoryId === 2000
              ) {
                delayed = true;
                preparation.resolve();
                await release.promise;
              }
              return original.apply(this, args);
            }
          );
          try {
            const first = h.collector.tick();
            await preparation.promise;
            assert.equal(
              (
                await db
                  .getRepository(names.dispatch)
                  .findOneByOrFail({ trackerId: h.id })
              ).lastStart,
              null
            );
            const spacing = maintenance ? 6000 : 3000;
            now += spacing;
            const other = new CatalogueCollector(db, [h.tracker], clock);
            await other.tick();
            assert.equal(h.calls.length, 1);
            now += 1000;
            release.resolve();
            await first;
            assert.equal(
              h.calls.length,
              1,
              'Delayed preparation must obtain a fresh permit before calling the adapter'
            );
            now = h.calls[0].at + spacing;
            await h.collector.tick();
            assert.equal(h.calls.length, 2);
            assert.ok(h.calls[1].at - h.calls[0].at >= spacing);
          } finally {
            release.resolve();
            mock.mock.restore();
          }
        }
      }
    );
    await t.test(
      'preparation failure consumes no quota and a permit cannot be reused',
      async () => {
        const h = await setup();
        await h.enable();
        await h.enable('historical', 5000);
        const original = CatalogueRepository.prototype.persistPage;
        let failed = false;
        const mock = t.mock.method(
          CatalogueRepository.prototype,
          'persistPage',
          async function (
            this: CatalogueRepository,
            ...args: Parameters<typeof original>
          ) {
            if (!failed && args[0].length === 0 && args[1].trackerId === h.id) {
              failed = true;
              throw new Error('Synthetic preparation failure SECRET');
            }
            return original.apply(this, args);
          }
        );
        try {
          await h.collector.tick();
          assert.equal(h.calls.length, 0);
          assert.equal(
            (
              await db
                .getRepository(names.dispatch)
                .findOneByOrFail({ trackerId: h.id })
            ).lastStart,
            null
          );
          await h.collector.tick();
          assert.equal(h.calls.length, 1);
          assert.equal(h.calls[0].at, instant);
        } finally {
          mock.mock.restore();
        }
        const next = await setup();
        await next.enable('recent');
        await next.enable();
        const recent = await next.collector.store.claimNext(
          next.tracker,
          'recent',
          next.tracker.settings
        );
        assert.ok(recent);
        const historical = await next.collector.store.claimNext(
          next.tracker,
          'historical',
          next.tracker.settings
        );
        assert.ok(historical);
        assert.equal(
          await next.collector.store.reserveRequest(
            next.tracker,
            historical.scope,
            'historical',
            next.tracker.settings
          ),
          null
        );
        assert.equal(
          await next.collector.store.reserveRequest(
            next.tracker,
            recent.scope,
            'recent',
            next.tracker.settings
          ),
          instant
        );
        now += 3000;
        assert.equal(
          await next.collector.store.reserveRequest(
            next.tracker,
            recent.scope,
            'recent',
            next.tracker.settings
          ),
          null,
          'A dispatched request cannot get a second permit'
        );
        assert.equal(
          await next.collector.store.reserveRequest(
            next.tracker,
            historical.scope,
            'historical',
            next.tracker.settings
          ),
          now
        );
      }
    );
    await t.test(
      'slow and suspended trackers cannot block another tracker; stop/drain covers every in-flight operation',
      async () => {
        const slow = deferred();
        const aStarted = deferred();
        const bFinished = deferred();
        const a = await setup(async () => {
          aStarted.resolve();
          await slow.promise;
          throw httpError(401);
        });
        const b = await setup();
        await a.enable();
        await b.enable();
        const collector = new CatalogueCollector(
          db,
          [a.tracker, b.tracker],
          clock
        );
        const release = collector.store.release.bind(collector.store);
        t.mock.method(
          collector.store,
          'release',
          async (...args: Parameters<typeof release>) => {
            await release(...args);
            if (args[0].trackerId === b.id) bFinished.resolve();
          }
        );
        const first = collector.tick();
        await aStarted.promise;
        await bFinished.promise;
        await new Promise(setImmediate);
        assert.equal(a.calls.length, 1);
        assert.equal(b.calls.length, 1);
        now += 3000;
        await collector.tick();
        assert.equal(a.calls.length, 1);
        assert.equal(b.calls.length, 2);
        slow.resolve();
        await first;
        assert.equal(
          (
            await db
              .getRepository(names.dispatch)
              .findOneByOrFail({ trackerId: a.id })
          ).suspended,
          true
        );
        assert.equal(
          (
            await db
              .getRepository(names.dispatch)
              .findOneByOrFail({ trackerId: b.id })
          ).suspended,
          false
        );
        now += 3000;
        await collector.tick();
        assert.equal(b.calls.length, 3);
        await collector.store.recover(a.id);
        // Tracker-wide auth recovery also re-enables the other declared scopes.
        // Keep this fixture focused on the two Historical requests below.
        await db
          .getRepository(names.sync)
          .update({ trackerId: a.id }, { nextRunAt: null });
        await a.enable();
        const finishA = deferred();
        const finishB = deferred();
        const startA = deferred();
        const startB = deferred();
        a.adapter.fetchHistoricalPage = async (req) => {
          startA.resolve();
          await finishA.promise;
          return page(a.id, req.offset);
        };
        b.adapter.fetchHistoricalPage = async (req) => {
          startB.resolve();
          await finishB.promise;
          return page(b.id, req.offset);
        };
        now += 3000;
        const active = collector.tick();
        await Promise.all([startA.promise, startB.promise]);
        assert.equal(
          await collector.tick(),
          false,
          'Repeated ticks cannot duplicate either in-flight operation'
        );
        collector.stop();
        let drained = false;
        const drain = collector.drain().then(() => {
          drained = true;
        });
        await new Promise(setImmediate);
        assert.equal(drained, false);
        finishA.resolve();
        await new Promise(setImmediate);
        assert.equal(drained, false);
        finishB.resolve();
        await Promise.all([active, drain]);
        assert.equal(drained, true);
        assert.equal(await collector.tick(), false);
        assert.equal(collector.scopeRunning(2000), false);
        assert.equal((await scope(a.id)).leaseOwner, null);
        assert.equal((await scope(b.id)).leaseOwner, null);
      }
    );
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
        await db.undoLastMigration({ transaction: 'all' });
        await db.undoLastMigration({ transaction: 'all' });
        const categories = await db
          .getRepository(names.category)
          .findBy({ torrentId: torrent.id });
        assert.equal(categories.length, 1);
        assert.equal((await db.runMigrations()).length, 3);
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
                    field: 'native:season?apikey=SECRET',
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
        const lease = await reserveNext(
          h.collector.store,
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
        await h.collector.enqueueRecent('movie');
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
        await resumed.enqueueRecent('movie');
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
        const lease = await reserveNext(
          store,
          h.id,
          'sql-clock',
          h.tracker.settings
        );
        assert.ok(lease);
        assert.ok(lease.now >= before - 100 && lease.now <= Date.now() + 100);
        assert.equal(
          await reserveNext(
            new CollectionStore(db),
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
          return page(id, req.offset, req.limit);
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
        const first = await reserveNext(
          h.collector.store,
          h.id,
          'recent-owner',
          h.tracker.settings
        );
        assert.equal(first?.scope.mode, 'recent');
        now += 3000;
        const second = await reserveNext(
          new CollectionStore(db, clock),
          h.id,
          'historical-owner',
          h.tracker.settings
        );
        assert.equal(second?.scope.mode, 'historical');
        assert.equal((await scope(h.id, 'recent')).leaseOwner, 'recent-owner');
        assert.equal(
          await reserveNext(
            new CollectionStore(db, clock),
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
          await reserveNext(
            h.collector.store,
            h.id,
            'next',
            h.tracker.settings
          ),
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
            await reserveNext(restarted, h.id, 'restart', h.tracker.settings),
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
