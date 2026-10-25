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
