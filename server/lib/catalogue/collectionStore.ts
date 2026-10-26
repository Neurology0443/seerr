import type { DataSource, EntityManager } from 'typeorm';
import type {
  Tr4kerCollectionSettings,
  TrackerCollectionDescription,
} from './collectionConfig';
import { prepareRepairs } from './collectionRepairs';
import {
  emptyCollectionState,
  readCollectionCheckpoint,
  readCollectionState,
} from './collectionState';
import { catalogueEntityNames as names } from './entities';
import { saveSyncCheckpoint } from './repository';
import {
  CatalogueLeaseLostError,
  catalogueWrite,
  databaseTime,
  type CatalogueClock,
} from './transactions';
import type {
  CatalogueDispatchState,
  CatalogueSyncState,
  SyncCheckpoint,
} from './types';

export const COLLECTION_LEASE_MS = 60000;
export type CollectionScope = Pick<
  CatalogueSyncState,
  'trackerId' | 'categoryId' | 'mode'
>;

export class CollectionStore {
  constructor(
    readonly connection: DataSource,
    readonly clock: CatalogueClock = databaseTime
  ) {}
  write<T>(operation: (manager: EntityManager) => Promise<T>): Promise<T> {
    return catalogueWrite(this.connection, operation);
  }
  private async lockTracker(
    manager: EntityManager,
    trackerId: string
  ): Promise<void> {
    await manager
      .getRepository(names.dispatch)
      .update({ trackerId }, { trackerId });
  }
  async initialize(
    tracker: TrackerCollectionDescription,
    settings: Tr4kerCollectionSettings
  ): Promise<void> {
    const { trackerId } = tracker;
    await this.write(async (manager) => {
      await manager
        .getRepository(names.tracker)
        .createQueryBuilder()
        .insert()
        .values({
          id: trackerId,
          name: tracker.name,
          connectorType: tracker.connectorType,
          enabled: true,
        })
        .orIgnore()
        .execute();
      await manager
        .getRepository(names.dispatch)
        .createQueryBuilder()
        .insert()
        .values({ trackerId, failures: 0, suspended: false })
        .orIgnore()
        .execute();
      await this.lockTracker(manager, trackerId);
      const now = await this.clock(manager);
      for (const category of tracker.categories)
        for (const mode of ['recent', 'historical'] as const) {
          await manager
            .getRepository(names.sync)
            .createQueryBuilder()
            .insert()
            .values({
              trackerId,
              categoryId: category.id,
              mode,
              checkpoint: null,
              phase: mode === 'recent' ? 'recent' : 'initial',
              status: 'idle',
              pagesProcessed: 0,
              cycleId: null,
              lastSuccessfulAt: null,
              lastObservedAt: null,
              updatedAt: new Date(now),
              retryAfterAt: null,
              errorCode: null,
              lastHttpStatus: null,
              nextRunAt: new Date(
                now + (mode === 'recent' ? category.recentStaggerMs : 0)
              ),
              collectionState: JSON.stringify(emptyCollectionState()),
            })
            .orIgnore()
            .execute();
        }
      // Upgrade old uncertain checkpoints under the existing tracker lock.
      // Never rewrite a scope currently owned by another process.
      const historical = await manager
        .getRepository<CatalogueSyncState>(names.sync)
        .findBy({ trackerId, mode: 'historical' });
      for (const scope of historical) {
        const cp = readCollectionCheckpoint(scope.checkpoint);
        if (
          !cp ||
          readCollectionState(scope.collectionState).repairVersion ||
          (scope.leaseExpiresAt && scope.leaseExpiresAt.getTime() > now)
        )
          continue;
        const upgraded = await prepareRepairs(manager, scope, now);
        if (
          cp.done &&
          (cp.dirty ||
            readCollectionState(scope.collectionState).coverage === 'partial')
        ) {
          upgraded.phase = 'repair';
          upgraded.nextRunAt = new Date(now + 30000);
        }
        await saveSyncCheckpoint(manager, upgraded);
      }
      // Enabling maintenance later uses the last pass's observed finish time.
      if (settings.maintenanceIntervalMinutes !== null) {
        const finished = await manager
          .getRepository<CatalogueSyncState>(names.sync)
          .findBy({ trackerId, mode: 'historical', phase: 'complete' });
        for (const scope of finished)
          if (!scope.nextRunAt)
            await manager.getRepository(names.sync).update(scope.id, {
              nextRunAt: new Date(
                (scope.lastSuccessfulAt?.getTime() ?? now) +
                  settings.maintenanceIntervalMinutes * 60000
              ),
            });
      }
    });
  }
  async enqueueRecent(trackerId: string, categoryId: number): Promise<void> {
    await this.write(async (manager) => {
      await this.lockTracker(manager, trackerId);
      const now = await this.clock(manager);
      const repository = manager.getRepository<CatalogueSyncState>(names.sync);
      const scope = await repository.findOneBy({
        trackerId,
        categoryId,
        mode: 'recent',
      });
      // Multiple instances receive the same native cron event. Coalesce it.
      if (
        scope &&
        scope.nextRunAt == null &&
        scope.status !== 'suspended' &&
        (!scope.lastSuccessfulAt ||
          scope.lastSuccessfulAt.getTime() < now - 60000)
      )
        await repository.update(scope.id, { nextRunAt: new Date(now) });
    });
  }
  async claimNext(
    tracker: TrackerCollectionDescription,
    owner: string,
    settings: Tr4kerCollectionSettings
  ): Promise<{ scope: CatalogueSyncState; now: number } | null> {
    const { trackerId } = tracker;
    return this.write(async (manager) => {
      await this.lockTracker(manager, trackerId);
      const now = await this.clock(manager);
      const dispatch = await manager
        .getRepository<CatalogueDispatchState>(names.dispatch)
        .findOneByOrFail({ trackerId });
      if (
        dispatch.suspended ||
        (dispatch.cooldownUntil != null && dispatch.cooldownUntil > now) ||
        (dispatch.lastStart != null &&
          now < dispatch.lastStart + settings.globalSpacingSeconds * 1000)
      )
        return null;
      const scopes = await manager
        .getRepository<CatalogueSyncState>(names.sync)
        .findBy({ trackerId });
      const eligible = scopes.filter(
        (scope) =>
          tracker.categories.some(
            (category) => category.id === scope.categoryId
          ) &&
          scope.status !== 'suspended' &&
          scope.nextRunAt != null &&
          scope.nextRunAt.getTime() <= now &&
          (!scope.leaseExpiresAt || scope.leaseExpiresAt.getTime() <= now) &&
          (!scope.retryAfterAt || scope.retryAfterAt.getTime() <= now)
      );
      const pendingRecent = eligible.some((scope) => scope.mode === 'recent');
      const candidates = eligible
        .filter((scope) => !pendingRecent || scope.mode === 'recent')
        .sort(
          (a, b) =>
            a.nextRunAt!.getTime() - b.nextRunAt!.getTime() ||
            a.categoryId - b.categoryId
        );
      for (const scope of candidates) {
        const maintenance =
          scope.mode === 'historical' &&
          ['maintenance', 'complete', 'repair'].includes(scope.phase);
        if (
          maintenance &&
          ((scope.phase !== 'repair' &&
            settings.maintenanceIntervalMinutes === null) ||
            (dispatch.maintenanceStart != null &&
              now <
                dispatch.maintenanceStart +
                  settings.maintenanceSpacingSeconds * 1000))
        )
          continue;
        if (!(await this.acquire(manager, scope, owner, now))) continue;

        return {
          scope: {
            ...scope,
            collectionState: JSON.stringify({
              ...readCollectionState(scope.collectionState),
              pendingDispatch: true,
            }),
            leaseOwner: owner,
            leaseExpiresAt: new Date(now + COLLECTION_LEASE_MS),
          },
          now,
        };
      }
      return null;
    });
  }
  // Final permit: call only after durable cycle/checkpoint preparation. The
  // caller invokes its adapter immediately after this transaction commits.
  async reserveRequest(
    tracker: TrackerCollectionDescription,
    scope: CollectionScope,
    owner: string,
    settings: Tr4kerCollectionSettings
  ): Promise<number | null> {
    return this.write(async (manager) => {
      await this.lockTracker(manager, tracker.trackerId);
      const dispatch = await manager
        .getRepository<CatalogueDispatchState>(names.dispatch)
        .findOneByOrFail({ trackerId: tracker.trackerId });
      const scopes = await manager
        .getRepository<CatalogueSyncState>(names.sync)
        .findBy({ trackerId: tracker.trackerId });
      const current = scopes.find(
        (row) => row.categoryId === scope.categoryId && row.mode === scope.mode
      );
      const now = await this.clock(manager);
      if (
        !current ||
        current.leaseOwner !== owner ||
        !current.leaseExpiresAt ||
        current.leaseExpiresAt.getTime() <= now
      )
        throw new CatalogueLeaseLostError();
      if (!readCollectionState(current.collectionState).pendingDispatch)
        return null;
      const eligible = (row: CatalogueSyncState) =>
        tracker.categories.some((category) => category.id === row.categoryId) &&
        row.status !== 'suspended' &&
        row.nextRunAt != null &&
        row.nextRunAt.getTime() <= now &&
        (!row.retryAfterAt || row.retryAfterAt.getTime() <= now);
      const maintenance =
        current.mode === 'historical' &&
        ['maintenance', 'complete', 'repair'].includes(current.phase);
      if (
        !eligible(current) ||
        dispatch.suspended ||
        (dispatch.cooldownUntil != null && dispatch.cooldownUntil > now) ||
        (dispatch.lastStart != null &&
          now < dispatch.lastStart + settings.globalSpacingSeconds * 1000) ||
        (maintenance &&
          ((current.phase !== 'repair' &&
            settings.maintenanceIntervalMinutes === null) ||
            (dispatch.maintenanceStart != null &&
              now <
                dispatch.maintenanceStart +
                  settings.maintenanceSpacingSeconds * 1000))) ||
        (current.mode === 'historical' &&
          scopes.some(
            (row) =>
              row.mode === 'recent' &&
              eligible(row) &&
              (!row.leaseExpiresAt ||
                row.leaseExpiresAt.getTime() <= now ||
                readCollectionState(row.collectionState).pendingDispatch)
          ))
      )
        return null;
      const state = readCollectionState(current.collectionState);
      state.pendingDispatch = false;
      await manager
        .getRepository(names.sync)
        .update(current.id, { collectionState: JSON.stringify(state) });
      await manager
        .getRepository(names.dispatch)
        .update(
          { trackerId: tracker.trackerId },
          { lastStart: now, ...(maintenance ? { maintenanceStart: now } : {}) }
        );
      return now;
    });
  }
  private async acquire(
    manager: EntityManager,
    scope: CatalogueSyncState,
    owner: string,
    now: number
  ): Promise<boolean> {
    const result = await manager
      .getRepository(names.sync)
      .createQueryBuilder()
      .update()
      .set({
        leaseOwner: owner,
        leaseExpiresAt: new Date(now + COLLECTION_LEASE_MS),
        collectionState: JSON.stringify({
          ...readCollectionState(scope.collectionState),
          pendingDispatch: true,
        }),
      })
      .where(
        'tracker_id = :trackerId AND category_id = :categoryId AND mode = :mode AND (lease_expires_at IS NULL OR lease_expires_at <= :now)',
        { ...scope, now: new Date(now) }
      )
      .execute();
    return result.affected === 1;
  }
  async renew(
    scope: CollectionScope,
    owner: string,
    deadline: number
  ): Promise<boolean> {
    return this.write(async (manager) => {
      await this.lockTracker(manager, scope.trackerId);
      const now = await this.clock(manager);
      if (now >= deadline) return false;
      const result = await manager
        .getRepository(names.sync)
        .createQueryBuilder()
        .update()
        .set({
          leaseExpiresAt: new Date(
            Math.min(now + COLLECTION_LEASE_MS, deadline)
          ),
        })
        .where(
          'tracker_id = :trackerId AND category_id = :categoryId AND mode = :mode AND lease_owner = :owner AND lease_expires_at > :now',
          { ...scope, owner, now: new Date(now) }
        )
        .execute();
      return result.affected === 1;
    });
  }
  async release(scope: CollectionScope, owner: string): Promise<void> {
    await this.write(async (manager) => {
      await manager
        .getRepository(names.sync)
        .createQueryBuilder()
        .update()
        .set({ leaseOwner: null, leaseExpiresAt: null })
        .where(
          'tracker_id = :trackerId AND category_id = :categoryId AND mode = :mode AND lease_owner = :owner',
          { ...scope, owner }
        )
        .execute();
    });
  }
  async fail(
    scope: CatalogueSyncState,
    checkpoint: SyncCheckpoint,
    owner: string,
    trackerFailure?: (
      dispatch: CatalogueDispatchState,
      now: number
    ) => Partial<CatalogueDispatchState>
  ): Promise<void> {
    await this.write(async (manager) => {
      await this.lockTracker(manager, scope.trackerId);
      const now = await this.clock(manager);
      const current = await manager
        .getRepository<CatalogueSyncState>(names.sync)
        .findOneByOrFail({ id: scope.id });
      if (
        current.leaseOwner !== owner ||
        !current.leaseExpiresAt ||
        current.leaseExpiresAt.getTime() <= now
      )
        throw new CatalogueLeaseLostError();
      if (trackerFailure) {
        const dispatch = await manager
          .getRepository<CatalogueDispatchState>(names.dispatch)
          .findOneByOrFail({ trackerId: scope.trackerId });
        await manager
          .getRepository(names.dispatch)
          .update(
            { trackerId: scope.trackerId },
            trackerFailure(dispatch, now)
          );
      }
      const state = { ...checkpoint };
      delete state.leaseOwner;
      delete state.leaseExpiresAt;
      await saveSyncCheckpoint(manager, state);
      if (current.leaseExpiresAt.getTime() <= (await this.clock(manager)))
        throw new CatalogueLeaseLostError();
    });
  }
  // Explicit operator recovery hook for P4/operations; never clears coverage or progress.
  async recover(
    trackerId: string,
    categoryId?: number,
    mode?: CatalogueSyncState['mode']
  ): Promise<void> {
    await this.write(async (manager) => {
      await this.lockTracker(manager, trackerId);
      const now = await this.clock(manager);
      if (categoryId === undefined)
        await manager.getRepository(names.dispatch).update(
          { trackerId },
          {
            suspended: false,
            failures: 0,
            cooldownUntil: null,
            errorCode: null,
            lastHttpStatus: null,
          }
        );
      const scopes = await manager
        .getRepository<CatalogueSyncState>(names.sync)
        .findBy({
          trackerId,
          ...(categoryId === undefined ? {} : { categoryId }),
          ...(mode ? { mode } : {}),
        });
      for (const scope of scopes) {
        // Recovery cannot evict an active writer.
        if (scope.leaseExpiresAt && scope.leaseExpiresAt.getTime() > now)
          continue;
        const state = readCollectionState(scope.collectionState);
        state.failures = 0;
        state.recoverable = true;
        const cp = readCollectionCheckpoint(scope.checkpoint);
        await manager.getRepository(names.sync).update(scope.id, {
          status: 'idle',
          retryAfterAt: null,
          nextRunAt: cp?.done ? scope.nextRunAt : new Date(now),
          collectionState: JSON.stringify(state),
        });
      }
    });
  }
}
