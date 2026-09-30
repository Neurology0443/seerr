import type { AllSettings } from '@server/lib/settings';

const migrationName = '0009_multi_service_target_invariants';

const enforceMultiServiceTargetInvariants = (settings: any): AllSettings => {
  if (
    Array.isArray(settings.migrations) &&
    settings.migrations.includes(migrationName)
  ) {
    return settings;
  }

  for (const type of ['radarr', 'sonarr'] as const) {
    for (const service of settings[type] ?? []) {
      const label =
        typeof service.buttonLabel === 'string'
          ? service.buttonLabel.trim()
          : '';

      if (!label || service.isDefault || !service.syncEnabled) {
        delete service.buttonLabel;
      } else {
        service.buttonLabel = label;
      }
    }
  }

  if (!Array.isArray(settings.migrations)) settings.migrations = [];
  settings.migrations.push(migrationName);
  return settings;
};

export default enforceMultiServiceTargetInvariants;
