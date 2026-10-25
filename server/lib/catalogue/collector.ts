import { TrackerAdapterError } from '@server/api/trackers/errors';
import type {
  NormalizedTrackerPage,
  TrackerAdapter,
} from '@server/api/trackers/types';
import { createHash, randomUUID } from 'node:crypto';
import type { DataSource } from 'typeorm';
import { In } from 'typeorm';
import {
  validateCollectionSettings,
  type Tr4kerCollectionSettings,
} from './collectionConfig';
import {
  diagnose,
  readCollectionCheckpoint,
  readCollectionState,
  type CollectionCheckpoint,
  type CollectionState,
} from './collectionState';
import { CollectionStore } from './collectionStore';
import { catalogueEntityNames as names } from './entities';
import { CatalogueRepository } from './repository';
import { CatalogueLeaseLostError, type CatalogueClock } from './transactions';
import type {
  CatalogueSyncState,
  CatalogueTorrent,
  SyncCheckpoint,
} from './types';

export interface CollectionTracker {
  trackerId: string;
  adapter: TrackerAdapter;
  settings: Tr4kerCollectionSettings;
}
const fingerprint = (guid: string) =>
  createHash('sha256').update(guid).digest('hex');
const backoff = (failures: number, settings: Tr4kerCollectionSettings) =>
  Math.min(
    settings.maxBackoffSeconds,
    settings.initialBackoffSeconds * 2 ** Math.min(failures - 1, 30)
  ) * 1000;
function retryAt(
  error: TrackerAdapterError,
  now: number,
  delay: number
): number {
  if (error.httpStatus === 429 && error.retryAfter) {
    const candidate =
      'seconds' in error.retryAfter
        ? now + error.retryAfter.seconds * 1000
        : Date.parse(error.retryAfter.date);
    if (
      Number.isSafeInteger(candidate) &&
      candidate > now &&
      candidate <= 8640000000000000
    )
      return candidate;
  }
  return now + delay;
}
function checkpointFor(
  scope: CatalogueSyncState,
  cp: CollectionCheckpoint,
  state: CollectionState,
  now: number
): SyncCheckpoint {
  const checkpoint: SyncCheckpoint & { id?: number } = { ...scope };
  delete checkpoint.id;
  return {
    ...checkpoint,
    checkpoint: JSON.stringify(cp),
    collectionState: JSON.stringify(state),
    updatedAt: new Date(now),
  };
}

// One coordinator chooses every page. The database arbitrates across processes;
// no local token buckets or speculative future reservations are used.
export class CatalogueCollector {
  readonly store: CollectionStore;
  private readonly repository: CatalogueRepository;
  private stopped = false;
  private active?: Promise<boolean>;
  private scopeCategory?: number;
  scopeRunning(categoryId: number): boolean {
    return this.scopeCategory === categoryId;
  }
  constructor(
    connection: DataSource,
    readonly trackers: CollectionTracker[],
    clock?: CatalogueClock
  ) {
    this.store = new CollectionStore(connection, clock);
    this.repository = new CatalogueRepository(connection);
    for (const tracker of trackers)
      validateCollectionSettings(tracker.settings);
  }
  async initialize(): Promise<void> {
    for (const tracker of this.trackers)
      await this.store.initialize(tracker.trackerId, tracker.settings);
  }
  enqueueRecent(categoryId: number): Promise<void> {
    return Promise.all(
      this.trackers.map((tracker) =>
        this.store.enqueueRecent(tracker.trackerId, categoryId)
      )
    ).then(() => undefined);
  }
  tick(): Promise<boolean> {
    if (this.stopped) return Promise.resolve(false);
    if (this.active) return this.active;
    this.active = this.dispatch().finally(() => {
      this.active = undefined;
    });
    return this.active;
  }
  stop(): void {
    this.stopped = true;
  }
  async drain(): Promise<void> {
    await this.active;
  }
  private async dispatch(): Promise<boolean> {
    let worked = false;
    for (const tracker of this.trackers) {
      if (this.stopped) break;
      const owner = randomUUID();
      const reserved = await this.store.reserveNext(
        tracker.trackerId,
        owner,
        tracker.settings
      );
      if (!reserved) continue;
      worked = true;
      const { scope, now } = reserved;
      this.scopeCategory = scope.categoryId;
      let renewal: NodeJS.Timeout | undefined;
      try {
        const deadline = now + 120000;
        renewal = setInterval(() => {
          if (!this.stopped)
            void this.store.renew(scope, owner, deadline).catch(() => false);
        }, 20000);
        renewal.unref();
        await this.collect(tracker, scope, owner, now);
      } catch (error) {
        if (!(error instanceof CatalogueLeaseLostError))
          await this.failure(tracker, scope, owner, error).catch(
            () => undefined
          );
      } finally {
        this.scopeCategory = undefined;
        if (renewal) clearInterval(renewal);
        await this.store.release(scope, owner).catch(() => undefined);
      }
    }
    return worked;
  }
  private async collect(
    tracker: CollectionTracker,
    scope: CatalogueSyncState,
    owner: string,
    now: number
  ): Promise<void> {
    const state = readCollectionState(scope.collectionState);
    let cp = readCollectionCheckpoint(scope.checkpoint);
    if (!cp || cp.done) {
      const invalid = !!scope.checkpoint && !cp;
      const repairThrough =
        scope.mode === 'recent' && cp && state.coverage === 'partial'
          ? Math.max(cp.repairThrough, cp.nextOffset - 80)
          : 0;
      cp = {
        version: 1,
        nextOffset: 0,
        pages: 0,
        startedAt: now,
        previous: [],
        knownStreak: 0,
        empty: null,
        terminalOffset: null,
        done: false,
        dirty: invalid,
        repairThrough,
        maintenance:
          scope.mode === 'historical' &&
          ['complete', 'maintenance'].includes(scope.phase),
      };
      if (invalid) diagnose(state, 'invalid_checkpoint', 'page', now);
      state.coverage = 'partial';
      scope.cycleId = randomUUID();
      scope.phase =
        scope.mode === 'recent'
          ? 'recent'
          : cp.maintenance
            ? 'maintenance'
            : 'initial';
    }
    scope.status = 'running';
    // Persist a new cycle before the request, so interruption cannot erase it.
    const beginning = checkpointFor(scope, cp, state, now);
    await this.repository.persistPage([], beginning, {
      owner,
      clock: this.store.clock,
      onIdentityConflicts: () => beginning,
    });
    Object.assign(scope, beginning);
    if (this.stopped) return;
    const request = {
      category:
        scope.categoryId === 2000 ? ('movie' as const) : ('tv' as const),
      offset: cp.nextOffset,
      limit: 100,
    };
    let timeout: NodeJS.Timeout | undefined;
    let page: NormalizedTrackerPage;
    try {
      page = await Promise.race([
        scope.mode === 'recent'
          ? tracker.adapter.fetchRecentPage(request)
          : tracker.adapter.fetchHistoricalPage(request),
        new Promise<never>((_resolve, reject) => {
          timeout = setTimeout(
            () => reject(new TrackerAdapterError('timeout', true)),
            90000
          );
          timeout.unref();
        }),
      ]);
    } finally {
      if (timeout) clearTimeout(timeout);
    }
    if (this.stopped) return;
    // Adapter observation time is local to its process. The reserved database
    // timestamp orders collector observations consistently across instances.
    const records = page.records.map((record) => ({
      ...record,
      observedAt: new Date(now),
    }));
    const hashes = records.map((record) => fingerprint(record.canonicalGuid));
    const unique = new Set(hashes);
    const overlap = hashes.filter((hash) => cp!.previous.includes(hash)).length;
    const repeated =
      hashes.length > 0 &&
      hashes.length === cp.previous.length &&
      hashes.every((hash) => cp!.previous.includes(hash));
    const critical =
      page.contractStatus !== 'compatible' ||
      page.anomalies.some(
        (a) =>
          ['canonicalGuid', 'infohash', 'releaseName', 'categories'].includes(
            a.field
          ) || a.code === 'identity_conflict'
      );
    for (const anomaly of page.anomalies)
      diagnose(state, anomaly.code, anomaly.field, now);
    const unstable =
      repeated ||
      unique.size !== hashes.length ||
      (cp.previous.length === 100 &&
        hashes.length > 0 &&
        overlap !== Math.min(20, hashes.length));
    if (unstable)
      diagnose(
        state,
        repeated ? 'repeated_page' : 'abnormal_overlap',
        'page',
        now
      );
    if (critical || unstable) {
      cp.dirty = true;
      cp.repairThrough = Math.max(cp.repairThrough, cp.nextOffset);
      state.coverage = 'partial';
    }
    const systematic =
      page.contractStatus === 'incompatible' ||
      repeated ||
      (page.contractStatus === 'partial' &&
        records.length < page.receivedCount / 2);
    if (systematic) {
      state.failures++;
      scope.status =
        state.failures >= tracker.settings.failureLimit
          ? 'suspended'
          : 'backoff';
      state.recoverable = scope.status !== 'suspended';
      scope.errorCode = repeated ? 'repeated_page' : 'contract_incompatible';
      scope.retryAfterAt = new Date(
        now + backoff(state.failures, tracker.settings)
      );
      // Keep the committed offset; valid observations can still be retained.
    } else {
      state.failures = 0;
      state.recoverable = true;
      scope.errorCode = critical || unstable ? 'partial_page' : null;
      scope.lastHttpStatus = null;
      scope.retryAfterAt = null;
      cp.pages++;
      if (page.receivedCount === 0 && records.length === 0 && !critical) {
        if (!cp.empty) cp.empty = { offset: cp.nextOffset, confirmations: 1 };
        else if (cp.nextOffset === cp.empty.offset) {
          cp.empty.confirmations = 2;
          cp.nextOffset += 80;
        } else {
          cp.terminalOffset = cp.empty.offset;
          if (scope.mode === 'historical') cp.done = true;
        }
      } else {
        cp.empty = null;
        cp.terminalOffset = null;
        cp.nextOffset += 80;
      }
      if (scope.mode === 'recent') {
        const existing = records.length
          ? await this.store.connection
              .getRepository<CatalogueTorrent>(names.torrent)
              .find({
                where: {
                  trackerId: scope.trackerId,
                  canonicalGuid: In(
                    records.map((record) => record.canonicalGuid)
                  ),
                },
              })
          : [];
        // Exclude GUIDs first discovered in this cycle, including overlap from
        // its previous page. Query before this page's persistence.
        const known = new Set(
          existing
            .filter((row) => row.firstSeenAt.getTime() < cp!.startedAt)
            .map((row) => row.canonicalGuid)
        );
        const boundary =
          hashes.length === 100 &&
          unique.size === 100 &&
          !critical &&
          !unstable &&
          records.filter((record) => known.has(record.canonicalGuid)).length >=
            80 &&
          records.slice(-20).every((record) => known.has(record.canonicalGuid));
        cp.knownStreak = boundary ? cp.knownStreak + 1 : 0;
        const corroborated =
          cp.knownStreak >= 2 &&
          request.offset >= cp.repairThrough &&
          !cp.dirty;
        if (corroborated || cp.pages >= tracker.settings.recentPageLimit) {
          cp.done = true;
          state.coverage = corroborated ? 'observed' : 'partial';
          if (!corroborated)
            cp.repairThrough = Math.max(cp.repairThrough, request.offset);
        }
      } else if (cp.done) state.coverage = cp.dirty ? 'partial' : 'observed';
      cp.previous = hashes.slice(0, 100);
      scope.pagesProcessed++;
      scope.lastSuccessfulAt = new Date(now);
      scope.nextRunAt = new Date(now + 1);
      if (records.length) scope.lastObservedAt = new Date(now);
      if (cp.done) {
        scope.status = 'idle';
        scope.phase = 'complete';
        scope.nextRunAt =
          scope.mode === 'historical' &&
          tracker.settings.maintenanceIntervalMinutes !== null
            ? new Date(
                now + tracker.settings.maintenanceIntervalMinutes * 60000
              )
            : null;
      }
    }
    let checkpoint = checkpointFor(scope, cp, state, now);
    await this.repository.persistPage(records, checkpoint, {
      owner,
      clock: this.store.clock,
      onIdentityConflicts: (count) => {
        diagnose(state, 'identity_conflict', 'infohash', now, count);
        cp!.dirty = true;
        cp!.repairThrough = Math.max(cp!.repairThrough, request.offset);
        checkpoint = checkpointFor(scope, cp!, state, now);
        return checkpoint;
      },
      afterPersist: systematic
        ? undefined
        : async (manager) => {
            await manager
              .getRepository(names.dispatch)
              .update({ trackerId: tracker.trackerId }, { failures: 0 });
          },
    });
  }
  private async failure(
    tracker: CollectionTracker,
    scope: CatalogueSyncState,
    owner: string,
    error: unknown
  ): Promise<void> {
    // Read the last committed state, never a tentative pagination decision.
    const stored = await this.repository.findSyncState(
      scope.trackerId,
      scope.categoryId,
      scope.mode
    );
    if (!stored) return;
    const now = await this.store.clock(this.store.connection.manager);
    const state = readCollectionState(stored.collectionState);
    const cp = readCollectionCheckpoint(stored.checkpoint);
    state.coverage = 'partial';
    state.failures++;
    if (cp) {
      cp.dirty = true;
      cp.repairThrough = Math.max(cp.repairThrough, cp.nextOffset);
    }
    const safe = error instanceof TrackerAdapterError ? error : null;
    const trackerError =
      safe &&
      ![
        'invalid_xml',
        'invalid_response',
        'invalid_request',
        'invalid_configuration',
        'torznab_error',
      ].includes(safe.code);
    const suspend =
      safe?.httpStatus === 401 ||
      safe?.httpStatus === 403 ||
      state.failures >= tracker.settings.failureLimit ||
      safe?.code === 'invalid_configuration' ||
      safe?.code === 'invalid_request';
    state.recoverable = !suspend;
    const checkpoint: SyncCheckpoint = {
      ...stored,
      checkpoint: cp ? JSON.stringify(cp) : stored.checkpoint,
      collectionState: JSON.stringify(state),
      updatedAt: new Date(now),
      status: suspend ? 'suspended' : 'backoff',
      errorCode: safe?.code ?? 'collection_failure',
      lastHttpStatus: safe?.httpStatus ?? null,
      retryAfterAt: new Date(
        safe
          ? retryAt(safe, now, backoff(state.failures, tracker.settings))
          : now + backoff(state.failures, tracker.settings)
      ),
    };
    // SQL update + scope state commit together. Never serialize the exception.
    await this.store.fail(
      stored,
      checkpoint,
      owner,
      trackerError
        ? (dispatch, dbNow) => {
            const failures = dispatch.failures + 1;
            const until = retryAt(
              safe!,
              dbNow,
              backoff(failures, tracker.settings)
            );
            return {
              failures,
              suspended:
                dispatch.suspended ||
                suspend ||
                failures >= tracker.settings.failureLimit,
              cooldownUntil: Math.max(dispatch.cooldownUntil ?? 0, until),
              errorCode: safe!.code,
              lastHttpStatus: safe!.httpStatus,
            };
          }
        : undefined
    );
  }
}
