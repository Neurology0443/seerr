import { diagnosticIdentity } from '@server/api/trackers/diagnostics';
import type {
  ReleaseRejection,
  TrackerAnomaly,
} from '@server/api/trackers/types';
import { createHash, randomUUID } from 'node:crypto';
import type { EntityManager } from 'typeorm';
import { IsNull, LessThan } from 'typeorm';
import {
  readCollectionCheckpoint,
  readCollectionState,
} from './collectionState';
import { catalogueEntityNames as names } from './entities';
import type {
  CatalogueReleaseDiagnostic,
  CatalogueSyncState,
  ObservedTorrent,
  SyncCheckpoint,
} from './types';

export const REPAIR_ATTEMPT_LIMIT = 3;
export const REPAIR_PAGE_LIMIT = 10000;
export const DIAGNOSTIC_LIMIT = 5000;
export const DIAGNOSTIC_RETENTION_MS = 30 * 86400000;
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
});

async function issue(
  manager: EntityManager,
  scope: SyncCheckpoint,
  now: number,
  reason: string,
  quarantine = false
): Promise<void> {
  const repository = manager.getRepository<CatalogueReleaseDiagnostic>(
    names.diagnostic
  );
  const where = {
    ...scopeOf(scope),
    mode: scope.mode,
    diagnosticKey: `scope:${reason}`,
  };
  const old = await repository.findOneBy(where);
  if (old && old.status !== 'resolved') {
    await repository.update(old.id, {
      lastSeenAt: new Date(now),
      occurrences: Math.min(2147483647, old.occurrences + 1),
      ...(quarantine && old.status !== 'quarantined'
        ? { status: 'quarantined', nextAttemptAt: null, lastOutcome: reason }
        : {}),
    });
    return;
  }
  await repository.save({
    ...old,
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
    occurrences: (old?.occurrences ?? 0) + 1,
    status: quarantine ? 'quarantined' : 'unresolved',
    attempts: 0,
    nextAttemptAt: quarantine ? null : new Date(now + delay(0)),
    lastAttemptCycle: null,
    lastOutcome: quarantine ? reason : 'pending',
    resolvedAt: null,
    offset: null,
    itemPosition: null,
  });
}

// Called inside the page's fenced transaction; no HTTP or independent writes.
export async function prepareRepairs(
  manager: EntityManager,
  checkpoint: SyncCheckpoint,
  now: number,
  region?: string
): Promise<SyncCheckpoint> {
  const cp = readCollectionCheckpoint(checkpoint.checkpoint)!;
  const state = readCollectionState(checkpoint.collectionState);
  if (region) await issue(manager, checkpoint, now, region);
  if (!state.repairVersion) {
    if (
      checkpoint.mode === 'historical' &&
      (cp.dirty || (cp.done && state.coverage === 'partial'))
    )
      await issue(manager, checkpoint, now, 'legacy_uncertainty');
    state.repairVersion = 1;
  }
  if (cp.repairRun && cp.pages === 0) {
    const repository = manager.getRepository<CatalogueReleaseDiagnostic>(
      names.diagnostic
    );
    const pending = await repository.findBy({
      ...scopeOf(checkpoint),
      status: 'unresolved',
      critical: true,
    });
    const capacityBudgets = await repository.findBy({
      ...scopeOf(checkpoint),
      reason: 'retention_uncertainty',
      status: 'quarantined',
    });
    pending.push(
      ...capacityBudgets.filter((row) => row.attempts < REPAIR_ATTEMPT_LIMIT)
    );
    for (const row of pending)
      if (
        row.lastAttemptCycle !== checkpoint.cycleId &&
        (!row.nextAttemptAt || row.nextAttemptAt.getTime() <= now)
      )
        await repository.update(row.id, {
          attempts: row.attempts + 1,
          lastAttemptCycle: checkpoint.cycleId,
          nextAttemptAt: null,
          lastOutcome: 'scanning',
        });
  }
  return { ...checkpoint, collectionState: JSON.stringify(state) };
}

export async function retainDiagnostics(
  manager: EntityManager,
  scope: SyncCheckpoint,
  now: number
): Promise<void> {
  const repository = manager.getRepository<CatalogueReleaseDiagnostic>(
    names.diagnostic
  );
  const where = { ...scopeOf(scope), mode: scope.mode };
  await repository.delete({
    ...where,
    status: 'resolved',
    resolvedAt: LessThan(new Date(now - DIAGNOSTIC_RETENTION_MS)),
  });
  const count = await repository.countBy({ ...where, kind: 'release' });
  if (count <= DIAGNOSTIC_LIMIT) return;
  // Prefer evicting resolved history. If uncertainty must be compacted, retain
  // an explicit, non-resolvable coverage tombstone instead of claiming absence.
  const rows = await repository.find({
    where: { ...where, kind: 'release' },
    order: { lastSeenAt: 'ASC', id: 'ASC' },
  });
  rows.sort(
    (a, b) => Number(a.status !== 'resolved') - Number(b.status !== 'resolved')
  );
  const removed = rows.slice(0, count - DIAGNOSTIC_LIMIT);
  if (removed.some((row) => row.critical && row.status !== 'resolved'))
    await issue(manager, scope, now, 'retention_uncertainty', true);
  for (let i = 0; i < removed.length; i += 200)
    await repository.delete(removed.slice(i, i + 200).map((row) => row.id));
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
  } = {}
): Promise<SyncCheckpoint> {
  const repository = manager.getRepository<CatalogueReleaseDiagnostic>(
    names.diagnostic
  );
  const cp = readCollectionCheckpoint(checkpoint.checkpoint)!;
  const state = readCollectionState(checkpoint.collectionState);
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
    const diagnosticKey = identity
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
    const where = {
      ...scopeOf(checkpoint),
      mode: checkpoint.mode,
      diagnosticKey,
    };
    const old = await repository.findOneBy(where);
    const reopened = old?.status === 'resolved';
    const critical = criticalRejection(rejection);
    const exhausted = options.systematic && checkpoint.status === 'suspended';
    if (!identity && critical)
      await issue(
        manager,
        checkpoint,
        now,
        'unidentified_rejections',
        exhausted
      );
    await repository.save({
      ...old,
      ...where,
      kind: 'release',
      releaseKey: identity
        ? createHash('sha256').update(identity).digest('hex')
        : null,
      guid: safe.guid,
      infohash: safe.infohash,
      title: safe.title,
      fingerprint,
      field: rejection.field,
      code: rejection.code,
      reason: rejection.reason,
      critical,
      firstSeenAt: old?.firstSeenAt ?? new Date(now),
      lastSeenAt: new Date(now),
      occurrences: Math.min(2147483647, (old?.occurrences ?? 0) + 1),
      status:
        exhausted || old?.status === 'quarantined'
          ? 'quarantined'
          : 'unresolved',
      attempts: Math.max(
        reopened ? 0 : (old?.attempts ?? 0),
        options.systematic ? state.failures : 0
      ),
      nextAttemptAt:
        exhausted || old?.status === 'quarantined' || !critical
          ? null
          : (old?.nextAttemptAt ?? new Date(now + delay(0))),
      lastAttemptCycle: reopened ? null : (old?.lastAttemptCycle ?? null),
      lastOutcome: exhausted ? 'scope_suspended' : 'rejected',
      resolvedAt: null,
      offset: options.offset ?? null,
      itemPosition: rejection.itemIndex,
    });
  }
  if (options.region)
    await issue(
      manager,
      checkpoint,
      now,
      options.region,
      options.region === 'scan_budget_exhausted'
    );
  const rows = await repository.findBy(scopeOf(checkpoint));
  for (const row of rows) {
    if (row.status === 'resolved') continue;
    // Only an independently accepted observation of the same GUID, with this
    // field validated and no corresponding rejection, can repair a release.
    const observed =
      row.kind === 'release' &&
      row.guid &&
      accepted.find(
        (record) =>
          record.canonicalGuid === row.guid &&
          record.observedAt.getTime() >= row.lastSeenAt.getTime() &&
          !rejections.some(
            (rejected) =>
              rejected.release.guid === row.guid && rejected.field === row.field
          ) &&
          (row.field !== 'infohash' || !!record.infohash) &&
          (row.field !== 'categories' || !!record.categories?.length) &&
          (!['tmdbId', 'tvdbId', 'season', 'episode'].includes(row.field) ||
            record.trackerMetadata?.[row.field as 'tmdbId'] != null)
      );
    const verifiedRegion =
      options.terminal &&
      cp.terminalOffset !== null &&
      !cp.scanUncertain &&
      (cp.repairRun || cp.maintenance) &&
      row.kind === 'scope' &&
      ['abnormal_overlap', 'repeated_page', 'pagination_changed'].includes(
        row.reason
      ) &&
      cp.startedAt >= row.lastSeenAt.getTime();
    if (observed || verifiedRegion) {
      await repository.update(row.id, {
        status: 'resolved',
        resolvedAt: new Date(now),
        nextAttemptAt: null,
        lastOutcome: observed ? 'valid_reobservation' : 'verified_rescan',
      });
    } else if (
      options.terminal &&
      cp.repairRun &&
      row.lastAttemptCycle === checkpoint.cycleId &&
      row.status === 'unresolved'
    ) {
      const quarantine = row.attempts >= REPAIR_ATTEMPT_LIMIT;
      await repository.update(row.id, {
        status: quarantine ? 'quarantined' : 'unresolved',
        nextAttemptAt: quarantine ? null : new Date(now + delay(row.attempts)),
        lastOutcome:
          cp.pages >= REPAIR_PAGE_LIMIT && cp.terminalOffset === null
            ? 'scan_budget_exhausted'
            : 'unresolved_after_scan',
      });
    }
  }
  const capacityBudgets = await repository.findBy({
    ...scopeOf(checkpoint),
    reason: 'retention_uncertainty',
    status: 'quarantined',
  });
  for (const budget of capacityBudgets) {
    if (
      options.terminal &&
      cp.repairRun &&
      budget.lastAttemptCycle === checkpoint.cycleId
    ) {
      budget.lastOutcome =
        budget.attempts >= REPAIR_ATTEMPT_LIMIT
          ? 'retention_budget_exhausted'
          : 'uncertainty_retained';
      await repository.update(budget.id, {
        lastOutcome: budget.lastOutcome,
        nextAttemptAt: null,
      });
    }
    // Eviction must not grant discarded/reappearing releases fresh, unlimited
    // repair budgets. Preserve each diagnosis but stop this scope's repair loop.
    if (budget.lastOutcome === 'retention_budget_exhausted')
      await repository.update(
        {
          ...scopeOf(checkpoint),
          mode: budget.mode,
          critical: true,
          status: 'unresolved',
        },
        {
          status: 'quarantined',
          nextAttemptAt: null,
          lastOutcome: 'retention_budget_exhausted',
        }
      );
  }
  const unidentifiedBudgets = await repository.findBy({
    ...scopeOf(checkpoint),
    diagnosticKey: 'scope:unidentified_rejections',
    status: 'quarantined',
  });
  for (const budget of unidentifiedBudgets)
    await repository.update(
      {
        ...scopeOf(checkpoint),
        mode: budget.mode,
        kind: 'release',
        releaseKey: IsNull(),
        status: 'unresolved',
        critical: true,
      },
      {
        status: 'quarantined',
        nextAttemptAt: null,
        lastOutcome: 'unidentified_budget_exhausted',
      }
    );
  const pendingUnidentifiedBudgets = await repository.findBy({
    ...scopeOf(checkpoint),
    diagnosticKey: 'scope:unidentified_rejections',
    status: 'unresolved',
  });
  for (const budget of pendingUnidentifiedBudgets)
    await repository.update(
      {
        ...scopeOf(checkpoint),
        mode: budget.mode,
        kind: 'release',
        releaseKey: IsNull(),
        status: 'unresolved',
        critical: true,
      },
      { nextAttemptAt: budget.nextAttemptAt }
    );
  await retainDiagnostics(manager, checkpoint, now);
  const remaining = await repository.findBy(scopeOf(checkpoint));
  const uncertain = remaining.some(
    (row) => row.critical && row.status !== 'resolved'
  );
  const pending = remaining.filter(
    (row) => row.critical && row.status === 'unresolved'
  );
  if (checkpoint.mode === 'historical') {
    cp.dirty = pending.length > 0;
    if (uncertain || !cp.done) state.coverage = 'partial';
    else if (!cp.scanUncertain) state.coverage = 'observed';
    if (cp.done && pending.length) {
      const next = Math.min(
        ...pending.map(
          (row) => row.nextAttemptAt?.getTime() ?? now + delay(row.attempts)
        )
      );
      checkpoint.nextRunAt = new Date(next);
      checkpoint.phase = 'repair';
    }
  } else if (uncertain) {
    state.coverage = 'partial';
    // Wake the existing Historical scope even with periodic maintenance off.
    const historical = await manager
      .getRepository<CatalogueSyncState>(names.sync)
      .findOneBy({ ...scopeOf(checkpoint), mode: 'historical' });
    if (
      historical &&
      readCollectionCheckpoint(historical.checkpoint)?.done &&
      pending.length &&
      historical.status !== 'suspended'
    )
      await manager.getRepository(names.sync).update(historical.id, {
        nextRunAt: new Date(now + delay(0)),
        phase: 'repair',
      });
  }
  return {
    ...checkpoint,
    checkpoint: JSON.stringify(cp),
    collectionState: JSON.stringify(state),
  };
}
