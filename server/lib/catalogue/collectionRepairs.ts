import {
  diagnosticIdentity,
  diagnosticRejectedValue,
} from '@server/api/trackers/diagnostics';
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
  type CollectionCheckpoint,
} from './collectionState';
import { catalogueEntityNames as names } from './entities';
import type {
  CatalogueReleaseDiagnostic,
  ObservedTorrent,
  SyncCheckpoint,
} from './types';

export const DIAGNOSTIC_LIMIT = 5000;
export const DIAGNOSTIC_RETENTION_MS = 30 * 86400000;
const BATCH_SIZE = 100;
const WRITE_BATCH_SIZE = 20;
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

// A key identifies one observation episode, not a reason, page or moving offset.
// Consecutive observations retain it until a usable page separates the episodes.
async function issue(
  manager: EntityManager,
  scope: SyncCheckpoint,
  cp: CollectionCheckpoint | null,
  now: number,
  reason: string,
  offset?: number,
  retrying = false
): Promise<void> {
  const repository = manager.getRepository<CatalogueReleaseDiagnostic>(
    names.diagnostic
  );
  const keys = cp ? (cp.incidentKeys ??= {}) : {};
  const key = keys[reason];
  const previous = key
    ? await repository.findOneBy({ ...scopeOf(scope), diagnosticKey: key })
    : null;
  const old =
    previous?.status !== 'resolved' && previous?.reason === reason
      ? previous
      : null;
  const diagnosticKey = old?.diagnosticKey ?? `scope:${reason}:${randomUUID()}`;
  keys[reason] = diagnosticKey;
  const actionable = reason === 'repeated_page' && retrying;
  const quarantined =
    old?.status === 'quarantined' ||
    !actionable ||
    scope.status === 'suspended';
  await repository.upsert(
    {
      ...scopeOf(scope),
      diagnosticKey,
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
      status: quarantined ? 'quarantined' : 'unresolved',
      attempts: Math.min(
        2147483647,
        (old?.attempts ?? 0) +
          (actionable && old?.status !== 'quarantined' ? 1 : 0)
      ),
      nextAttemptAt: quarantined ? null : scope.retryAfterAt,
      lastAttemptCycle: actionable
        ? scope.cycleId
        : (old?.lastAttemptCycle ?? null),
      lastOutcome:
        old?.status === 'quarantined'
          ? old.lastOutcome
          : actionable
            ? quarantined
              ? 'retry_budget_exhausted'
              : 'retrying_page'
            : 'non_repairable_uncertainty',
      resolvedAt: null,
      offset:
        offset != null && offset <= 2147483647 ? offset : (old?.offset ?? null),
      itemPosition: null,
      rejectedValue: null,
    },
    ['trackerId', 'categoryId', 'mode', 'diagnosticKey']
  );
}

// SQL aggregates, scoped by mode, never materialize the category's history.
async function summary(manager: EntityManager, scope: SyncCheckpoint) {
  const raw = await manager
    .getRepository<CatalogueReleaseDiagnostic>(names.diagnostic)
    .createQueryBuilder('diagnostic')
    .select('COUNT(*)', 'uncertain')
    .addSelect(
      "COALESCE(SUM(CASE WHEN diagnostic.kind = 'scope' AND diagnostic.status = 'unresolved' AND diagnostic.reason = 'repeated_page' THEN 1 ELSE 0 END),0)",
      'pending'
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
    .getRawOne();
  return { uncertain: Number(raw.uncertain), pending: Number(raw.pending) };
}

async function deferPendingPage(
  manager: EntityManager,
  checkpoint: SyncCheckpoint,
  cp: CollectionCheckpoint
) {
  const key = cp.incidentKeys?.repeated_page;
  if (!key || !['backoff', 'suspended'].includes(checkpoint.status)) return;
  const suspended = checkpoint.status === 'suspended';
  await manager.getRepository(names.diagnostic).update(
    { ...scopeOf(checkpoint), diagnosticKey: key, status: 'unresolved' },
    suspended
      ? {
          status: 'quarantined',
          nextAttemptAt: null,
          lastOutcome: 'retry_budget_exhausted',
        }
      : { nextAttemptAt: checkpoint.retryAfterAt }
  );
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

// Runs under the existing page fence or initialization tracker lock. Version 3
// retires full rescans: none of the recorded warnings proves a bounded gap.
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
  const upgrading = state.repairVersion !== 3;
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
      { ...scopeOf(checkpoint), kind: 'scope', status: 'unresolved' },
      {
        status: 'quarantined',
        nextAttemptAt: null,
        lastOutcome: 'unbounded_repair_retired',
      }
    );
    state.repairVersion = 3;
  }
  if (!cp) return { ...checkpoint, collectionState: JSON.stringify(state) };
  if (region) await issue(manager, checkpoint, cp, now, region);
  await deferPendingPage(manager, checkpoint, cp);
  let totals = await summary(manager, checkpoint);
  const obsolete = cp.repairRun || checkpoint.phase === 'repair';
  if (
    upgrading &&
    (cp.dirty || obsolete || (cp.done && state.coverage === 'partial')) &&
    !totals.uncertain
  ) {
    await issue(manager, checkpoint, cp, now, 'legacy_uncertainty');
    totals = await summary(manager, checkpoint);
  }
  if (checkpoint.mode === 'historical') {
    if (obsolete) {
      // A technical stop preserves the offset and uncertainty, never inventing
      // terminal-empty evidence or spending another request permit.
      if (!totals.uncertain) {
        await issue(manager, checkpoint, cp, now, 'cancelled_legacy_repair');
        totals = await summary(manager, checkpoint);
      }
      cp.done = true;
      if (checkpoint.status !== 'suspended') checkpoint.status = 'idle';
    }
    cp.dirty = totals.pending > 0;
    if (totals.uncertain || !cp.done || cp.scanUncertain)
      state.coverage = 'partial';
    if (cp.done && (upgrading || obsolete)) {
      checkpoint.phase = 'complete';
      checkpoint.nextRunAt = maintenanceAt(
        checkpoint,
        now,
        maintenanceIntervalMinutes
      );
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
  const active = Object.values(
    readCollectionCheckpoint(scope.checkpoint)?.incidentKeys ?? {}
  );
  for (const kind of ['release', 'scope'] as const) {
    const excess =
      (await repository.countBy({
        ...where,
        kind,
        ...(kind === 'scope' ? { reason: Not('retention_uncertainty') } : {}),
      })) - DIAGNOSTIC_LIMIT;
    if (excess <= 0) continue;
    const victims = repository
      .createQueryBuilder('diagnostic')
      .select(['diagnostic.id', 'diagnostic.critical', 'diagnostic.status'])
      .where(
        'diagnostic.tracker_id = :tracker AND diagnostic.category_id = :category AND diagnostic.mode = :mode AND diagnostic.kind = :kind AND diagnostic.reason <> :marker',
        {
          tracker: scope.trackerId,
          category: scope.categoryId,
          mode: scope.mode,
          kind,
          marker: 'retention_uncertainty',
        }
      )
      .orderBy(
        "CASE WHEN diagnostic.status = 'resolved' THEN 0 ELSE 1 END",
        'ASC'
      )
      .addOrderBy('diagnostic.last_seen_at', 'ASC')
      .addOrderBy('diagnostic.id', 'ASC');
    if (active.length)
      victims.andWhere('diagnostic.diagnostic_key NOT IN (:...active)', {
        active,
      });
    const removed = await victims.take(excess).getMany();
    if (removed.some((row) => row.critical && row.status !== 'resolved')) {
      // This is an aggregate lost-evidence marker, not a retryable incident.
      const marker = await repository.findOneBy({
        ...where,
        kind: 'scope',
        reason: 'retention_uncertainty',
      });
      const cp = readCollectionCheckpoint(scope.checkpoint);
      if (marker && cp)
        (cp.incidentKeys ??= {}).retention_uncertainty = marker.diagnosticKey;
      if (!marker)
        await issue(manager, scope, cp, now, 'retention_uncertainty');
      if (cp) scope.checkpoint = JSON.stringify(cp);
    }
    for (let i = 0; i < removed.length; i += BATCH_SIZE)
      await repository.delete(
        removed.slice(i, i + BATCH_SIZE).map((row) => row.id)
      );
  }
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
        rejectedValue:
          ['tmdbId', 'tvdbId'].includes(rejection.field) &&
          rejection.code === 'invalid_field'
            ? diagnosticRejectedValue(rejection.rejectedValue)
            : null,
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
    await issue(
      manager,
      checkpoint,
      cp,
      now,
      options.region,
      options.offset,
      options.systematic
    );
  if (options.systematic) await deferPendingPage(manager, checkpoint, cp);
  // Read only the bounded active episode keys. Historical scope history can grow
  // to its retention cap without adding per-page reads or unrelated resolutions.
  const active = Object.values(cp.incidentKeys ?? {});
  const regions = active.length
    ? await repository.findBy({
        ...scopeOf(checkpoint),
        kind: 'scope',
        diagnosticKey: In(active),
        status: Not('resolved'),
      })
    : [];
  let pendingEmpty = false;
  for (const row of regions) {
    if (row.reason !== 'repeated_page' || options.systematic) continue;
    const retriedPage =
      row.offset === options.offset &&
      options.continuous &&
      accepted.length > 0;
    const terminalPage = options.terminal && cp.terminalOffset === row.offset;
    if (!terminalPage && !accepted.length && cp.empty?.offset === row.offset) {
      pendingEmpty = true;
      continue;
    }
    if (row.status === 'quarantined' && !retriedPage && !terminalPage) continue;
    await repository.update(row.id, {
      status: retriedPage || terminalPage ? 'resolved' : 'quarantined',
      resolvedAt: retriedPage || terminalPage ? new Date(now) : null,
      nextAttemptAt: null,
      lastOutcome:
        retriedPage || terminalPage
          ? 'verified_collection'
          : 'uncertain_page_recovery',
    });
  }
  if (!options.systematic) {
    for (const reason of Object.keys(cp.incidentKeys ?? {})) {
      if (
        reason !== options.region &&
        reason !== 'retention_uncertainty' &&
        !(
          ['abnormal_overlap', 'source_data_overlap'].includes(reason) &&
          !options.continuous
        ) &&
        !(reason === 'repeated_page' && pendingEmpty)
      )
        delete cp.incidentKeys![reason];
    }
  }
  // Retention may add its uncertainty marker to this checkpoint's active keys.
  checkpoint.checkpoint = JSON.stringify(cp);
  await retainDiagnostics(manager, checkpoint, now);
  Object.assign(cp, readCollectionCheckpoint(checkpoint.checkpoint));
  const totals = await summary(manager, checkpoint);
  if (checkpoint.mode === 'historical') {
    cp.dirty = totals.pending > 0;
    state.coverage =
      totals.uncertain || !cp.done || cp.scanUncertain ? 'partial' : 'observed';
  } else if (totals.uncertain) state.coverage = 'partial';
  return {
    ...checkpoint,
    checkpoint: JSON.stringify(cp),
    collectionState: JSON.stringify(state),
  };
}
