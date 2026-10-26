import type { PageRequest } from '@server/api/trackers/types';

export interface Tr4kerCollectionSettings {
  enabled: boolean;
  recentPageLimit: number;
  maintenanceIntervalMinutes: number | null;
  globalSpacingSeconds: number;
  maintenanceSpacingSeconds: number;
  initialBackoffSeconds: number;
  maxBackoffSeconds: number;
  failureLimit: number;
}
export const defaultTr4kerCollectionSettings: Tr4kerCollectionSettings = {
  enabled: false,
  recentPageLimit: 10,
  maintenanceIntervalMinutes: null,
  globalSpacingSeconds: 3,
  maintenanceSpacingSeconds: 6,
  initialBackoffSeconds: 30,
  maxBackoffSeconds: 900,
  failureLimit: 5,
};
export function validateCollectionSettings(
  value: Tr4kerCollectionSettings
): void {
  const int = (n: number, min: number, max: number) =>
    Number.isSafeInteger(n) && n >= min && n <= max;
  if (
    typeof value.enabled !== 'boolean' ||
    !int(value.recentPageLimit, 2, 1000) ||
    (value.maintenanceIntervalMinutes !== null &&
      !int(value.maintenanceIntervalMinutes, 1, 525600)) ||
    !int(value.globalSpacingSeconds, 3, 3600) ||
    !int(value.maintenanceSpacingSeconds, 6, 3600) ||
    !int(value.initialBackoffSeconds, 1, 900) ||
    !int(value.maxBackoffSeconds, value.initialBackoffSeconds, 86400) ||
    !int(value.failureLimit, 1, 100)
  )
    throw new Error('Invalid catalogue collection configuration');
}

export interface CollectionPagination {
  limit: number;
  overlap: number;
}
export interface TrackerCollectionDescription {
  trackerId: string;
  name: string;
  connectorType: string;
  categories: {
    id: number;
    requestCategory: PageRequest['category'];
    recentStaggerMs: number;
  }[];
  pagination: CollectionPagination;
}

// Production tracker defaults belong at the integration boundary, not in the
// offset collector. These do not change the persisted settings.json format.
export const tr4kerCollectionDescription: TrackerCollectionDescription = {
  trackerId: 'tr4ker',
  name: 'TR4KER',
  connectorType: 'torznab',
  categories: [
    { id: 2000, requestCategory: 'movie', recentStaggerMs: 0 },
    { id: 5000, requestCategory: 'tv', recentStaggerMs: 10000 },
  ],
  pagination: { limit: 100, overlap: 20 },
};

export function validateCollectionDescription(
  value: TrackerCollectionDescription
): void {
  const integer = (n: number, min: number, max: number) =>
    Number.isSafeInteger(n) && n >= min && n <= max;
  if (
    !/^[a-z0-9][a-z0-9._-]{0,127}$/i.test(value.trackerId) ||
    typeof value.name !== 'string' ||
    !value.name ||
    value.name.length > 128 ||
    typeof value.connectorType !== 'string' ||
    !value.connectorType ||
    value.connectorType.length > 128 ||
    !Array.isArray(value.categories) ||
    value.categories.length === 0 ||
    value.categories.length > 32 ||
    value.categories.some(
      (category) =>
        !integer(category.id, 1, 2147483647) ||
        !['movie', 'tv'].includes(category.requestCategory) ||
        !integer(category.recentStaggerMs, 0, 86400000)
    ) ||
    new Set(value.categories.map((category) => category.id)).size !==
      value.categories.length ||
    !value.pagination ||
    !integer(value.pagination.limit, 2, 1000) ||
    !integer(value.pagination.overlap, 1, value.pagination.limit - 1)
  )
    throw new Error('Invalid catalogue collection description');
}
