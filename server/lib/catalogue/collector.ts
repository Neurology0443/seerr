import { diagnosticIdentity } from '@server/api/trackers/diagnostics';
import { TrackerAdapterError } from '@server/api/trackers/errors';
import type {
  NormalizedTrackerPage,
  PageRequest,
  ReleaseRejection,
  TrackerAdapter,
} from '@server/api/trackers/types';
import { createHash, randomUUID } from 'node:crypto';
import type { DataSource } from 'typeorm';
import { In } from 'typeorm';
import {
  validateCollectionDescription,
  validateCollectionSettings,
  type Tr4kerCollectionSettings,
  type TrackerCollectionDescription,
} from './collectionConfig';
import { persistReleaseDiagnostics, prepareRepairs } from './collectionRepairs';
import {
  diagnose,
  pageContinuity,
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

export interface CollectionTracker extends TrackerCollectionDescription {
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
  private readonly active = new Map<string, Promise<boolean>>();
  private readonly scopeCategories = new Map<string, number>();
  scopeRunning(categoryId: number, trackerId?: string): boolean {
    return trackerId === undefined
      ? [...this.scopeCategories.values()].includes(categoryId)
      : this.scopeCategories.get(trackerId) === categoryId;
  }
  constructor(
    connection: DataSource,
    readonly trackers: CollectionTracker[],
    clock?: CatalogueClock
  ) {
    this.store = new CollectionStore(connection, clock);
    this.repository = new CatalogueRepository(connection);
    if (
      new Set(trackers.map((tracker) => tracker.trackerId)).size !==
      trackers.length
    )
      throw new Error('Duplicate catalogue tracker');
    for (const tracker of trackers) {
      validateCollectionSettings(tracker.settings);
      validateCollectionDescription(tracker);
    }
  }
  async initialize(): Promise<void> {
    for (const tracker of this.trackers)
      await this.store.initialize(tracker, tracker.settings);
  }
  enqueueRecent(mediaCategory: PageRequest['category']): Promise<void> {
    return Promise.allSettled(
      this.trackers.flatMap((tracker) =>
        tracker.categories
          .filter((category) => category.requestCategory === mediaCategory)
          .map((category) =>
            this.store.enqueueRecent(tracker.trackerId, category.id)
          )
      )
    ).then((results) => {
      const failed = results.find((result) => result.status === 'rejected');
      if (failed?.status === 'rejected') throw failed.reason;
    });
  }
  tick(): Promise<boolean> {
    if (this.stopped) return Promise.resolve(false);
    const launched: Promise<boolean>[] = [];
    for (const tracker of this.trackers) {
      if (this.active.has(tracker.trackerId)) continue;
      const work = this.dispatch(tracker).finally(() => {
        this.active.delete(tracker.trackerId);
      });
      this.active.set(tracker.trackerId, work);
      launched.push(work);
    }
    // Each tracker has at most one local operation. Subsequent ticks can serve
    // responsive trackers while another request remains in flight.
    return Promise.allSettled(launched).then((results) => {
      const failed = results.find((result) => result.status === 'rejected');
      if (failed?.status === 'rejected') throw failed.reason;
      return results.some(
        (result) => result.status === 'fulfilled' && result.value
      );
    });
  }
  stop(): void {
    this.stopped = true;
  }
  async drain(): Promise<void> {
    await Promise.allSettled([...this.active.values()]);
  }
  private async dispatch(tracker: CollectionTracker): Promise<boolean> {
    if (this.stopped) return false;
    const owner = randomUUID();
    const claimed = await this.store.claimNext(
      tracker,
      owner,
      tracker.settings
    );
    if (!claimed) return false;
    const { scope, now } = claimed;
    this.scopeCategories.set(tracker.trackerId, scope.categoryId);
    let renewal: NodeJS.Timeout | undefined;
    try {
      const deadline = now + 120000;
      renewal = setInterval(() => {
        if (!this.stopped)
          void this.store.renew(scope, owner, deadline).catch(() => false);
      }, 20000);
      renewal.unref();
      return await this.collect(tracker, scope, owner, now);
    } catch (error) {
      if (!(error instanceof CatalogueLeaseLostError))
        await this.failure(tracker, scope, owner, error).catch(() => undefined);
      return false;
    } finally {
      this.scopeCategories.delete(tracker.trackerId);
      if (renewal) clearInterval(renewal);
      await this.store.release(scope, owner).catch(() => undefined);
    }
  }
  private async collect(
    tracker: CollectionTracker,
    scope: CatalogueSyncState,
    owner: string,
    now: number
  ): Promise<boolean> {
    const { limit, overlap } = tracker.pagination;
    const step = limit - overlap;
    const state = readCollectionState(scope.collectionState);
    let cp = readCollectionCheckpoint(scope.checkpoint);
    const repairRun = scope.mode === 'historical' && scope.phase === 'repair';
    const paginationChanged =
      cp != null &&
      (cp.pagination.limit !== limit || cp.pagination.overlap !== overlap);
    if (!cp || cp.done || paginationChanged) {
      const invalid = !!scope.checkpoint && !cp;
      const repairThrough =
        scope.mode === 'recent' && cp && state.coverage === 'partial'
          ? Math.max(
              cp.repairThrough,
              cp.nextOffset - (cp.pagination.limit - cp.pagination.overlap)
            )
          : 0;
      cp = {
        version: 2,
        pagination: { ...tracker.pagination },
        nextOffset: 0,
        pages: 0,
        startedAt: now,
        previous: [],
        knownStreak: 0,
        empty: null,
        terminalOffset: null,
        done: false,
        dirty: false,
        repairThrough,
        maintenance:
          scope.mode === 'historical' &&
          ['complete', 'maintenance', 'repair'].includes(scope.phase),
        repairRun,
        scanUncertain: false,
      };
      if (invalid) diagnose(state, 'invalid_checkpoint', 'page', now);
      if (paginationChanged) diagnose(state, 'pagination_changed', 'page', now);
      state.coverage = 'partial';
      scope.cycleId = randomUUID();
      scope.phase =
        scope.mode === 'recent'
          ? 'recent'
          : cp.repairRun
            ? 'repair'
            : cp.maintenance
              ? 'maintenance'
              : 'initial';
    }
    scope.status = 'running';
    // Persist a new cycle before the request, so interruption cannot erase it.
    let beginning = checkpointFor(scope, cp, state, now);
    await this.repository.persistPage([], beginning, {
      owner,
      clock: this.store.clock,
      onIdentityConflicts: () => beginning,
      beforeCheckpoint: async (manager, _accepted, checkpoint) => {
        beginning = await prepareRepairs(
          manager,
          checkpoint,
          now,
          paginationChanged
            ? 'pagination_changed'
            : scope.checkpoint && !readCollectionCheckpoint(scope.checkpoint)
              ? 'invalid_checkpoint'
              : undefined,
          tracker.settings.maintenanceIntervalMinutes
        );
        return beginning;
      },
    });
    Object.assign(scope, beginning);
    Object.assign(state, readCollectionState(beginning.collectionState));
    cp = readCollectionCheckpoint(beginning.checkpoint)!;
    if (cp.done) return false;
    if (this.stopped) return false;
    const category = tracker.categories.find(
      (category) => category.id === scope.categoryId
    )!;
    const request = {
      category: category.requestCategory,
      offset: cp.nextOffset,
      limit,
    };
    const fetch = (
      scope.mode === 'recent'
        ? tracker.adapter.fetchRecentPage
        : tracker.adapter.fetchHistoricalPage
    ).bind(tracker.adapter);
    const dispatchedAt = await this.store.reserveRequest(
      tracker,
      scope,
      owner,
      tracker.settings
    );
    if (dispatchedAt === null || this.stopped) return false;
    state.pendingDispatch = false;
    now = dispatchedAt;
    let timeout: NodeJS.Timeout | undefined;
    let page: NormalizedTrackerPage;
    try {
      page = await Promise.race([
        fetch(request),
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
    if (this.stopped) return true;
    // Adapter observation time is local to its process. The reserved database
    // timestamp orders collector observations consistently across instances.
    const records = page.records.map((record) => ({
      ...record,
      observedAt: new Date(now),
    }));
    const rejections: ReleaseRejection[] = page.rejections
      ? [...page.rejections]
      : page.anomalies.map((anomaly) => ({
          ...anomaly,
          reason:
            anomaly.code === 'identity_conflict'
              ? 'identity_conflict'
              : 'invalid_value',
          release: {
            guid: null,
            infohash: null,
            title: null,
            fingerprint: null,
          },
        }));
    const criticalAnomaly = page.anomalies.some(
      (a) =>
        ['canonicalGuid', 'infohash', 'releaseName', 'categories'].includes(
          a.field
        ) || a.code === 'identity_conflict'
    );
    const unusable =
      records.length === 0 &&
      (page.receivedCount > 0 ||
        page.contractStatus !== 'compatible' ||
        criticalAnomaly);
    // A rejected nonempty response contradicts any pending terminal emptiness.
    if (page.receivedCount > 0 || unusable) {
      cp.empty = null;
      cp.terminalOffset = null;
    }
    const pageStartCheckpoint = structuredClone(cp);
    const pageStartScope = { ...scope };
    const failuresBeforePage = state.failures;
    const hashes = records.map((record) => fingerprint(record.canonicalGuid));
    const unique = new Set(hashes);
    const continuity = pageContinuity(cp.previous, hashes, tracker.pagination);
    const repeated = continuity === 'repeated';
    const critical =
      unusable || page.contractStatus !== 'compatible' || criticalAnomaly;
    const sourceGap = critical || cp.previousRejected;
    for (const anomaly of page.anomalies)
      diagnose(state, anomaly.code, anomaly.field, now);
    const unstable = continuity !== 'continuous';
    if (unstable)
      diagnose(
        state,
        repeated ? 'repeated_page' : 'abnormal_overlap',
        'page',
        now
      );
    let systematic =
      unusable ||
      page.contractStatus === 'incompatible' ||
      repeated ||
      (page.contractStatus === 'partial' &&
        records.length < page.receivedCount / 2);
    if (critical || unstable) {
      if (unstable && !systematic) cp.scanUncertain = true;
      // An unadvanced Historical page is still pending, not a skipped range.
      if (!systematic || scope.mode === 'recent') {
        cp.dirty = true;
        cp.repairThrough = Math.max(cp.repairThrough, cp.nextOffset);
      }
      state.coverage = 'partial';
    }
    const deferPage = () => {
      state.failures = failuresBeforePage + 1;
      scope.status =
        state.failures >= tracker.settings.failureLimit
          ? 'suspended'
          : 'backoff';
      state.recoverable = scope.status !== 'suspended';
      scope.errorCode = repeated ? 'repeated_page' : 'contract_incompatible';
      scope.retryAfterAt = new Date(
        now + backoff(state.failures, tracker.settings)
      );
      state.coverage = 'partial';
    };
    if (systematic) {
      deferPage();
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
          cp.nextOffset += step;
        } else {
          cp.terminalOffset = cp.empty.offset;
          if (scope.mode === 'historical') cp.done = true;
        }
      } else {
        cp.empty = null;
        cp.terminalOffset = null;
        cp.nextOffset += step;
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
          hashes.length === limit &&
          unique.size === limit &&
          !critical &&
          !unstable &&
          records.filter((record) => known.has(record.canonicalGuid)).length >=
            Math.max(2, step) &&
          records
            .slice(-overlap)
            .every((record) => known.has(record.canonicalGuid));
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
      cp.previous = hashes.slice(0, limit);
      cp.previousRejected = critical;
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
        state.coverage = 'partial';
        if (count === records.length) {
          // The repository can reject every record against stored identities.
          // Restore tentative progress inside the same page transaction.
          cp = pageStartCheckpoint;
          Object.assign(scope, pageStartScope);
          systematic = true;
          if (scope.mode === 'recent') {
            cp.dirty = true;
            cp.repairThrough = Math.max(cp.repairThrough, request.offset);
          }
          deferPage();
        } else {
          cp!.dirty = true;
          cp!.repairThrough = Math.max(cp!.repairThrough, request.offset);
        }
        checkpoint = checkpointFor(scope, cp!, state, now);
        return checkpoint;
      },
      afterPersist: async (manager) => {
        if (!systematic)
          await manager
            .getRepository(names.dispatch)
            .update({ trackerId: tracker.trackerId }, { failures: 0 });
      },
      beforeCheckpoint: async (manager, accepted, checkpoint) => {
        for (const record of records)
          if (!accepted.includes(record))
            rejections.push({
              itemIndex: records.indexOf(record),
              field: 'infohash',
              code: 'identity_conflict',
              reason: 'identity_conflict',
              release: diagnosticIdentity(
                record.canonicalGuid,
                record.infohash,
                record.releaseName
              ),
            });
        return persistReleaseDiagnostics(
          manager,
          checkpoint,
          accepted,
          rejections,
          now,
          {
            region: unstable
              ? repeated
                ? 'repeated_page'
                : systematic
                  ? undefined
                  : sourceGap
                    ? 'source_data_overlap'
                    : 'abnormal_overlap'
              : critical && !rejections.length
                ? 'contract_page'
                : undefined,
            systematic,
            terminal: cp!.done,
            offset: request.offset,
            continuous: !unstable,
          }
        );
      },
    });
    return true;
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
    if (cp && scope.mode === 'recent') {
      // Recent must revisit its moving front after an interruption. Historical
      // retries this unadvanced offset; request health alone does not dirty it.
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
