import type { TrackerAnomaly } from '@server/api/trackers/types';
import type { CollectionPagination } from './collectionConfig';

export interface CollectionCheckpoint {
  version: 2;
  pagination: CollectionPagination;
  nextOffset: number;
  pages: number;
  startedAt: number;
  previous: string[];
  knownStreak: number;
  empty: { offset: number; confirmations: number } | null;
  terminalOffset: number | null;
  done: boolean;
  dirty: boolean;
  repairThrough: number;
  maintenance: boolean;
  repairRun?: boolean;
  scanUncertain?: boolean;
}
export interface CollectionDiagnostic {
  code:
    | TrackerAnomaly['code']
    | 'identity_conflict'
    | 'abnormal_overlap'
    | 'repeated_page'
    | 'invalid_checkpoint'
    | 'pagination_changed';
  field: TrackerAnomaly['field'] | 'page';
  at: number;
  count: number;
}
export interface CollectionState {
  version: 1;
  coverage: 'partial' | 'observed';
  failures: number;
  diagnostics: CollectionDiagnostic[];
  recoverable: boolean;
  pendingDispatch?: boolean;
  repairVersion?: 1;
}
export const emptyCollectionState = (): CollectionState => ({
  version: 1,
  coverage: 'partial',
  failures: 0,
  diagnostics: [],
  recoverable: true,
});
export function readCollectionState(value?: string | null): CollectionState {
  if (!value) return emptyCollectionState();
  try {
    const state = JSON.parse(value) as CollectionState;
    if (
      state.version !== 1 ||
      !['partial', 'observed'].includes(state.coverage) ||
      !Number.isInteger(state.failures) ||
      state.failures < 0 ||
      !Array.isArray(state.diagnostics) ||
      state.diagnostics.length > 32
    )
      throw new Error();
    return state;
  } catch {
    return emptyCollectionState();
  }
}
export function readCollectionCheckpoint(
  value: string | null
): CollectionCheckpoint | null {
  if (!value || value.length > 131072) return null;
  try {
    const parsed = JSON.parse(value);
    // Frozen v1 checkpoints always used 100/20. Upgrade that representation
    // without discarding a valid deep scan's progress.
    const cp = (
      parsed.version === 1
        ? { ...parsed, version: 2, pagination: { limit: 100, overlap: 20 } }
        : parsed
    ) as CollectionCheckpoint;
    if (
      cp.version !== 2 ||
      !cp.pagination ||
      !Number.isSafeInteger(cp.pagination.limit) ||
      cp.pagination.limit < 2 ||
      cp.pagination.limit > 1000 ||
      !Number.isSafeInteger(cp.pagination.overlap) ||
      cp.pagination.overlap < 1 ||
      cp.pagination.overlap >= cp.pagination.limit ||
      ![
        cp.nextOffset,
        cp.pages,
        cp.startedAt,
        cp.knownStreak,
        cp.repairThrough,
      ].every((n) => Number.isSafeInteger(n) && n >= 0) ||
      cp.nextOffset > Number.MAX_SAFE_INTEGER - 2000 ||
      !Array.isArray(cp.previous) ||
      cp.previous.length > cp.pagination.limit ||
      cp.previous.some((s) => !/^[a-f0-9]{64}$/.test(s)) ||
      !['done', 'dirty', 'maintenance'].every(
        (key) => typeof cp[key as keyof CollectionCheckpoint] === 'boolean'
      ) ||
      (cp.terminalOffset !== null &&
        (!Number.isSafeInteger(cp.terminalOffset) || cp.terminalOffset < 0)) ||
      (cp.empty !== null &&
        (!Number.isSafeInteger(cp.empty.offset) ||
          cp.empty.offset < 0 ||
          ![1, 2].includes(cp.empty.confirmations)))
    )
      return null;
    return cp;
  } catch {
    return null;
  }
}
export function diagnose(
  state: CollectionState,
  code: CollectionDiagnostic['code'],
  field: CollectionDiagnostic['field'],
  now: number,
  count = 1
): void {
  const existing = state.diagnostics.find(
    (d) => d.code === code && d.field === field
  );
  if (existing) {
    existing.at = now;
    existing.count = Math.min(2147483647, existing.count + count);
  } else {
    if (state.diagnostics.length === 32) state.diagnostics.shift();
    state.diagnostics.push({
      code,
      field,
      at: now,
      count: Math.min(count, 2147483647),
    });
  }
}

// Shared identities must retain their relative order and lie near the old
// tail/new head. Small offset shifts change the count, without breaking this
// continuity. No intersection, excessive drift or reordering stays uncertain.
export function pageContinuity(
  previous: string[],
  current: string[],
  pagination: CollectionPagination
): 'continuous' | 'broken' | 'repeated' {
  if (new Set(current).size !== current.length) return 'broken';
  if (!previous.length || !current.length) return 'continuous';
  const positions = new Map(previous.map((hash, index) => [hash, index]));
  const shared = current.flatMap((hash, index) =>
    positions.has(hash)
      ? [{ previous: positions.get(hash)!, current: index }]
      : []
  );
  if (shared.length === current.length && current.length === previous.length)
    return 'repeated';
  const minimum = Math.min(
    previous.length,
    current.length,
    Math.max(1, Math.ceil(pagination.overlap / 2))
  );
  const maximum = Math.min(pagination.limit - 1, pagination.overlap * 2);
  if (
    shared.length < minimum ||
    shared.length > maximum ||
    shared.some(
      (match, index) =>
        (index > 0 && match.previous <= shared[index - 1].previous) ||
        match.previous < previous.length - maximum ||
        match.current >= maximum
    )
  )
    return 'broken';
  return 'continuous';
}
