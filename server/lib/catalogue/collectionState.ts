import type { TrackerAnomaly } from '@server/api/trackers/types';

export interface CollectionCheckpoint {
  version: 1;
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
}
export interface CollectionDiagnostic {
  code:
    | TrackerAnomaly['code']
    | 'identity_conflict'
    | 'abnormal_overlap'
    | 'repeated_page'
    | 'invalid_checkpoint';
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
  if (!value || value.length > 16384) return null;
  try {
    const cp = JSON.parse(value) as CollectionCheckpoint;
    if (
      cp.version !== 1 ||
      ![
        cp.nextOffset,
        cp.pages,
        cp.startedAt,
        cp.knownStreak,
        cp.repairThrough,
      ].every((n) => Number.isSafeInteger(n) && n >= 0) ||
      cp.nextOffset > Number.MAX_SAFE_INTEGER - 160 ||
      !Array.isArray(cp.previous) ||
      cp.previous.length > 100 ||
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
  state.coverage = 'partial';
}
