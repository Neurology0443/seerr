import type { AllSettings } from '@server/lib/settings';

const MIGRATION_ID = '0009_add_independent_request_destination';

const addIndependentRequestDestination = (settings: any): AllSettings => {
  if (
    Array.isArray(settings.migrations) &&
    settings.migrations.includes(MIGRATION_ID)
  ) {
    return settings;
  }

  for (const server of settings.radarr ?? []) {
    server.independentRequestDestination ??= false;
  }
  for (const server of settings.sonarr ?? []) {
    server.independentRequestDestination ??= false;
  }

  if (!Array.isArray(settings.migrations)) {
    settings.migrations = [];
  }
  settings.migrations.push(MIGRATION_ID);

  return settings;
};

export default addIndependentRequestDestination;
