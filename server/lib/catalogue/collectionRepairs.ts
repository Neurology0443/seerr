import { diagnosticIdentity } from '@server/api/trackers/diagnostics';
import type {
  ReleaseRejection,
  TrackerAnomaly,
} from '@server/api/trackers/types';
import { createHash, randomUUID } from 'node:crypto';
import type { EntityManager } from 'typeorm';
import { In, LessThan, Not } from 'typeorm';
import {
  readCollectionCheckpoint,
  readCollectionState,
} from './collectionState';
import { catalogueEntityNames as names } from './entities';
import type {
  CatalogueReleaseDiagnostic,
  ObservedTorrent,
  SyncCheckpoint,
} from './types';

export const REPAIR_ATTEMPT_LIMIT = 3;
export const REPAIR_PAGE_LIMIT = 10000;
export const DIAGNOSTIC_LIMIT = 5000;
export const DIAGNOSTIC_RETENTION_MS = 30 * 86400000;
const BATCH_SIZE = 100;
const WRITE_BATCH_SIZE = 20;
const actionableReasons = [
  'abnormal_overlap',
  'repeated_page',
  'pagination_changed',
  'invalid_checkpoint',
];
const delay = (attempts: number) =>
  Math.min(900000, 30000 * 2 ** Math.max(0, attempts - 1));
export const criticalRejection = (
  a: Pick<TrackerAnomaly, 'field' | 'code'>
): boolean =>
  ['canonicalGuid', 'infohash', 'releaseName', 'categories'].includes(
    a.field
  ) || a.code === 'identity_conflict';
const scopeOf = (scope: SyncCheckpoint) => ({
  trackerId: scope.trackerId,
  categoryId: scope.categoryId,
  mode: scope.mode,
});

async function issue(
  manager: EntityManager,
  scope: SyncCheckpoint,
  now: number,
  reason: string,
  offset?: number
): Promise<void> {
  const repository = manager.getRepository<CatalogueReleaseDiagnostic>(
    names.diagnostic
  );
  const where = { ...scopeOf(scope), diagnosticKey: `scope:${reason}` };
  const old = await repository.findOneBy(where);
  const actionable = actionableReasons.includes(reason);
  const recurring = old && old.status !== 'resolved';
  await repository.upsert(
    {
      ...where,
      kind: 'scope',
      releaseKey: null,
      guid: null,
      infohash: null,
      title: null,
      fingerprint: null,
      field: 'page',
      code: 'collection_uncertainty',
      reason,
      critical: true,
      firstSeenAt: old?.firstSeenAt ?? new Date(now),
      lastSeenAt: new Date(now),
      occurrences: Math.min(2147483647, (old?.occurrences ?? 0) + 1),
      status: recurring
        ? old.status
        : actionable
          ? 'unresolved'
          : 'quarantined',
      attempts: recurring ? old.attempts : 0,
      nextAttemptAt: recurring
        ? old.nextAttemptAt
        : actionable
          ? new Date(now + delay(0))
          : null,
      lastAttemptCycle: recurring ? old.lastAttemptCycle : null,
      lastOutcome: recurring
        ? old.lastOutcome
        : actionable
          ? 'pending'
          : 'non_repairable_uncertainty',
      resolvedAt: null,
      offset:
        reason === 'repeated_page' && offset != null && offset <= 2147483647
          ? offset
          : (old?.offset ?? null),
      itemPosition: null,
    },
    ['trackerId', 'categoryId', 'mode', 'diagnosticKey']
  );
}

// SQL aggregates, scoped by mode, never materialize the category's release history.
async function summary(manager: EntityManager, scope: SyncCheckpoint) {
  const repository = manager.getRepository<CatalogueReleaseDiagnostic>(
    names.diagnostic
  );
  const pending =
    "diagnostic.kind = 'scope' AND diagnostic.status = 'unresolved' AND diagnostic.reason IN (:...reasons)";
  const raw = await repository
    .createQueryBuilder('diagnostic')
    .select('COUNT(*)', 'uncertain')
    .addSelect(
      `COALESCE(SUM(CASE WHEN ${pending} THEN 1 ELSE 0 END),0)`,
      'pending'
    )
    .addSelect(
      `MIN(CASE WHEN ${pending} THEN diagnostic.next_attempt_at END)`,
      'next'
    )
    .where(
      'diagnostic.tracker_id = :tracker AND diagnostic.category_id = :category AND diagnostic.mode = :mode',
      {
        tracker: scope.trackerId,
        category: scope.categoryId,
        mode: scope.mode,
      }
    )
    .andWhere(
      'diagnostic.critical = :critical AND diagnostic.status <> :resolved',
      { critical: true, resolved: 'resolved' }
    )
    .setParameter('reasons', actionableReasons)
    .getRawOne();
  const next: Date | null =
    raw.next == null
      ? null
      : manager.connection.driver.prepareHydratedValue(
          raw.next,
          repository.metadata.findColumnWithPropertyName('nextAttemptAt')!
        );
  return {
    uncertain: Number(raw.uncertain),
    pending: Number(raw.pending),
    next,
  };
}

function maintenanceAt(
  checkpoint: SyncCheckpoint,
  now: number,
  interval: number | null
) {
  return interval === null
    ? null
    : new Date(
        (checkpoint.lastSuccessfulAt?.getTime() ?? now) + interval * 60000
      );
}

// Runs before the existing final SQL request permit, under its page fence or
// initialization tracker lock. Version 2 retires old release-driven repair jobs.
export async function prepareRepairs(
  manager: EntityManager,
  checkpoint: SyncCheckpoint,
  now: number,
  region?: string,
  maintenanceIntervalMinutes: number | null = null
): Promise<SyncCheckpoint> {
  const repository = manager.getRepository<CatalogueReleaseDiagnostic>(
    names.diagnostic
  );
  const cp = readCollectionCheckpoint(checkpoint.checkpoint);
  const state = readCollectionState(checkpoint.collectionState);
  const upgrading = state.repairVersion !== 2;
  if (
    !state.repairVersion &&
    checkpoint.mode === 'historical' &&
    cp &&
    (cp.dirty || (cp.done && state.coverage === 'partial'))
  )
    await issue(manager, checkpoint, now, 'legacy_uncertainty');
  if (upgrading) {
    await repository.update(
      { ...scopeOf(checkpoint), kind: 'release', status: 'unresolved' },
      {
        status: 'quarantined',
        nextAttemptAt: null,
        lastOutcome: 'source_data_unrepairable',
      }
    );
    await repository.update(
      {
        ...scopeOf(checkpoint),
        kind: 'scope',
        status: 'unresolved',
        reason: Not(In(actionableReasons)),
      },
      {
        status: 'quarantined',
        nextAttemptAt: null,
        lastOutcome: 'non_repairable_uncertainty',
      }
    );
    state.repairVersion = 2;
  }
  if (!cp) return { ...checkpoint, collectionState: JSON.stringify(state) };
  if (region) await issue(manager, checkpoint, now, region);
  // Scope causes are a fixed, small set. Release rows are never loaded here.
  const regions = await repository.findBy({
    ...scopeOf(checkpoint),
    kind: 'scope',
    status: 'unresolved',
    reason: In(actionableReasons),
  });
  const exhausted = regions.filter(
    (row) =>
      row.attempts >= REPAIR_ATTEMPT_LIMIT &&
      !(
        cp.repairRun &&
        row.lastAttemptCycle === checkpoint.cycleId &&
        row.lastOutcome === 'scanning'
      )
  );
  if (exhausted.length)
    await repository.update(
      { id: In(exhausted.map((row) => row.id)) },
      {
        status: 'quarantined',
        nextAttemptAt: null,
        lastOutcome: 'repair_budget_exhausted',
      }
    );
  if (cp.repairRun && cp.pages === 0) {
    const eligible = regions.filter(
      (row) =>
        !exhausted.includes(row) &&
        row.lastAttemptCycle !== checkpoint.cycleId &&
        (!row.nextAttemptAt || row.nextAttemptAt.getTime() <= now)
    );
    if (eligible.length)
      await repository.update(
        { id: In(eligible.map((row) => row.id)) },
        {
          attempts: () => 'attempts + 1',
          lastAttemptCycle: checkpoint.cycleId,
          nextAttemptAt: null,
          lastOutcome: 'scanning',
        }
      );
  }
  let totals = await summary(manager, checkpoint);
  if (checkpoint.mode === 'historical') {
    // Cancel previously persisted rescans whose only obligations were source
    // anomalies. This technical stop is not terminal-empty or coverage evidence.
    if (cp.repairRun && !cp.done && !totals.pending) {
      if (!totals.uncertain) {
        await issue(manager, checkpoint, now, 'cancelled_legacy_repair');
        totals = await summary(manager, checkpoint);
      }
      cp.done = true;
      checkpoint.status = 'idle';
    }
    cp.dirty = totals.pending > 0;
    if (totals.uncertain || !cp.done || cp.scanUncertain)
      state.coverage = 'partial';
    if (cp.done) {
      if (totals.pending) {
        checkpoint.phase = 'repair';
        checkpoint.nextRunAt = totals.next ?? new Date(now + delay(0));
      } else if (upgrading || checkpoint.phase === 'repair') {
        checkpoint.phase = 'complete';
        checkpoint.nextRunAt = maintenanceAt(
          checkpoint,
          now,
          maintenanceIntervalMinutes
        );
      }
    }
  }
  return {
    ...checkpoint,
    checkpoint: JSON.stringify(cp),
    collectionState: JSON.stringify(state),
  };
}

export async function retainDiagnostics(
  manager: EntityManager,
  scope: SyncCheckpoint,
  now: number
): Promise<void> {
  const repository = manager.getRepository<CatalogueReleaseDiagnostic>(
    names.diagnostic
  );
  const where = scopeOf(scope);
  await repository.delete({
    ...where,
    status: 'resolved',
    resolvedAt: LessThan(new Date(now - DIAGNOSTIC_RETENTION_MS)),
  });
  const excess =
    (await repository.countBy({ ...where, kind: 'release' })) -
    DIAGNOSTIC_LIMIT;
  if (excess <= 0) return;
  const removed = await repository
    .createQueryBuilder('diagnostic')
    .select(['diagnostic.id', 'diagnostic.critical', 'diagnostic.status'])
    .where(
      'diagnostic.tracker_id = :tracker AND diagnostic.category_id = :category AND diagnostic.mode = :mode AND diagnostic.kind = :kind',
      {
        tracker: scope.trackerId,
        category: scope.categoryId,
        mode: scope.mode,
        kind: 'release',
      }
    )
    .orderBy(
      "CASE WHEN diagnostic.status = 'resolved' THEN 0 ELSE 1 END",
      'ASC'
    )
    .addOrderBy('diagnostic.last_seen_at', 'ASC')
    .addOrderBy('diagnostic.id', 'ASC')
    .take(excess)
    .getMany();
  if (removed.some((row) => row.critical && row.status !== 'resolved'))
    await issue(manager, scope, now, 'retention_uncertainty');
  for (let i = 0; i < removed.length; i += BATCH_SIZE)
    await repository.delete(
      removed.slice(i, i + BATCH_SIZE).map((row) => row.id)
    );
}

function validated(record: ObservedTorrent, field: string): boolean {
  if (['tmdbId', 'tvdbId', 'season', 'episode'].includes(field))
    return record.trackerMetadata?.[field as 'tmdbId'] != null;
  if (field === 'categories') return !!record.categories?.length;
  return (
    [
      'canonicalGuid',
      'infohash',
      'releaseName',
      'trackerId',
      'size',
      'publishedAt',
      'seeders',
      'leechers',
      'observedAt',
    ].includes(field) && record[field as keyof ObservedTorrent] != null
  );
}

export async function persistReleaseDiagnostics(
  manager: EntityManager,
  checkpoint: SyncCheckpoint,
  accepted: ObservedTorrent[],
  rejections: ReleaseRejection[],
  now: number,
  options: {
    region?: string;
    systematic?: boolean;
    terminal?: boolean;
    offset?: number;
    maintenanceIntervalMinutes?: number | null;
    continuous?: boolean;
  } = {}
): Promise<SyncCheckpoint> {
  const repository = manager.getRepository<CatalogueReleaseDiagnostic>(
    names.diagnostic
  );
  const cp = readCollectionCheckpoint(checkpoint.checkpoint)!;
  const state = readCollectionState(checkpoint.collectionState);
  const incoming = new Map<
    string,
    {
      rejection: ReleaseRejection;
      safe: ReturnType<typeof diagnosticIdentity>;
      fingerprint: string | null;
      releaseKey: string | null;
      count: number;
    }
  >();
  for (const rejection of rejections) {
    const safe = diagnosticIdentity(
      rejection.release.guid,
      rejection.release.infohash,
      rejection.release.title
    );
    const fingerprint =
      rejection.release.fingerprint &&
      /^[a-f0-9]{64}$/.test(rejection.release.fingerprint)
        ? rejection.release.fingerprint
        : null;
    const identity = safe.guid
      ? `guid:${safe.guid}`
      : fingerprint
        ? `opaque:${fingerprint}`
        : safe.infohash
          ? `hash:${safe.infohash}`
          : null;
    const key = identity
      ? createHash('sha256')
          .update(
            JSON.stringify([
              identity,
              rejection.field,
              rejection.code,
              rejection.reason,
            ])
          )
          .digest('hex')
      : `unknown:${randomUUID()}`;
    incoming.set(key, {
      rejection,
      safe,
      fingerprint,
      releaseKey: identity
        ? createHash('sha256').update(identity).digest('hex')
        : null,
      count: (incoming.get(key)?.count ?? 0) + 1,
    });
  }
  const keys = [...incoming.keys()];
  for (let i = 0; i < keys.length; i += BATCH_SIZE) {
    const batch = keys.slice(i, i + BATCH_SIZE);
    const previous = await repository.findBy({
      ...scopeOf(checkpoint),
      diagnosticKey: In(batch),
    });
    const old = new Map(previous.map((row) => [row.diagnosticKey, row]));
    const values = batch.map((diagnosticKey) => {
      const { rejection, safe, fingerprint, releaseKey, count } =
        incoming.get(diagnosticKey)!;
      const before = old.get(diagnosticKey);
      return {
        ...scopeOf(checkpoint),
        diagnosticKey,
        kind: 'release' as const,
        releaseKey,
        guid: safe.guid,
        infohash: safe.infohash,
        title: safe.title,
        fingerprint,
        field: rejection.field,
        code: rejection.code,
        reason: rejection.reason,
        critical: criticalRejection(rejection),
        firstSeenAt: before?.firstSeenAt ?? new Date(now),
        lastSeenAt: new Date(now),
        occurrences: Math.min(2147483647, (before?.occurrences ?? 0) + count),
        status: 'quarantined' as const,
        attempts: before?.attempts ?? 0,
        nextAttemptAt: null,
        lastAttemptCycle: before?.lastAttemptCycle ?? null,
        lastOutcome: 'source_data_unrepairable',
        resolvedAt: null,
        offset:
          options.offset != null && options.offset <= 2147483647
            ? options.offset
            : null,
        itemPosition: rejection.itemIndex,
      };
    });
    for (let j = 0; j < values.length; j += WRITE_BATCH_SIZE)
      await repository.upsert(values.slice(j, j + WRITE_BATCH_SIZE), [
        'trackerId',
        'categoryId',
        'mode',
        'diagnosticKey',
      ]);
  }
  // Cross-mode resolution is explicit and identity/field specific. It does not
  // read or update the other mode's checkpoints, counters or scheduling state.
  const observations = new Map(
    accepted.map((record) => [record.canonicalGuid, record])
  );
  const guids = [...observations.keys()];
  const blocked = new Set(
    rejections
      .filter((row) => row.release.guid)
      .map((row) => JSON.stringify([row.release.guid, row.field]))
  );
  for (let i = 0; i < guids.length; i += BATCH_SIZE) {
    const relevant = await repository.findBy({
      trackerId: checkpoint.trackerId,
      categoryId: checkpoint.categoryId,
      mode: In(['recent', 'historical']),
      kind: 'release',
      guid: In(guids.slice(i, i + BATCH_SIZE)),
      status: In(['unresolved', 'quarantined']),
    });
    const resolved = relevant.filter((row) => {
      const record = observations.get(row.guid!)!;
      return (
        record.observedAt.getTime() >= row.lastSeenAt.getTime() &&
        validated(record, row.field) &&
        !blocked.has(JSON.stringify([row.guid, row.field]))
      );
    });
    if (resolved.length)
      await repository.update(
        { id: In(resolved.map((row) => row.id)) },
        {
          status: 'resolved',
          resolvedAt: new Date(now),
          nextAttemptAt: null,
          lastOutcome: 'valid_reobservation',
        }
      );
  }
  if (options.region)
    await issue(manager, checkpoint, now, options.region, options.offset);
  const regions = await repository.findBy({
    ...scopeOf(checkpoint),
    kind: 'scope',
    status: Not('resolved'),
  });
  const resolvedRegions: number[] = [];
  const failedRegions: number[] = [];
  for (const row of regions) {
    const retriedPage =
      row.reason === 'repeated_page' &&
      row.offset !== null &&
      ((row.offset === options.offset &&
        accepted.length > 0 &&
        options.continuous &&
        !options.systematic) ||
        (options.terminal && cp.terminalOffset === row.offset));
    const cleanRescan =
      options.terminal &&
      cp.terminalOffset !== null &&
      !cp.scanUncertain &&
      cp.startedAt >= row.lastSeenAt.getTime();
    if (actionableReasons.includes(row.reason) && (retriedPage || cleanRescan))
      resolvedRegions.push(row.id);
    else if (
      options.terminal &&
      cp.repairRun &&
      row.lastAttemptCycle === checkpoint.cycleId &&
      row.status === 'unresolved'
    )
      failedRegions.push(row.id);
  }
  if (resolvedRegions.length)
    await repository.update(
      { id: In(resolvedRegions) },
      {
        status: 'resolved',
        resolvedAt: new Date(now),
        nextAttemptAt: null,
        lastOutcome: 'verified_collection',
      }
    );
  for (const row of regions.filter((row) => failedRegions.includes(row.id))) {
    const quarantine = row.attempts >= REPAIR_ATTEMPT_LIMIT;
    await repository.update(row.id, {
      status: quarantine ? 'quarantined' : 'unresolved',
      nextAttemptAt: quarantine ? null : new Date(now + delay(row.attempts)),
      lastOutcome:
        cp.terminalOffset === null
          ? 'scan_budget_exhausted'
          : 'unresolved_after_scan',
    });
  }
  await retainDiagnostics(manager, checkpoint, now);
  const totals = await summary(manager, checkpoint);
  if (checkpoint.mode === 'historical') {
    cp.dirty = totals.pending > 0;
    state.coverage =
      totals.uncertain || !cp.done || cp.scanUncertain ? 'partial' : 'observed';
    if (cp.done && totals.pending) {
      checkpoint.phase = 'repair';
      checkpoint.nextRunAt = totals.next ?? new Date(now + delay(0));
    } else if (cp.done && checkpoint.phase === 'repair') {
      checkpoint.phase = 'complete';
      checkpoint.nextRunAt = maintenanceAt(
        checkpoint,
        now,
        options.maintenanceIntervalMinutes ?? null
      );
    }
  } else if (totals.uncertain) state.coverage = 'partial';
  return {
    ...checkpoint,
    checkpoint: JSON.stringify(cp),
    collectionState: JSON.stringify(state),
  };
}
