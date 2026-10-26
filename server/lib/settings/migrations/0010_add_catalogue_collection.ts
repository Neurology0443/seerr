import {
  defaultTr4kerCollectionSettings,
  type Tr4kerCollectionSettings,
} from '@server/lib/catalogue/collectionConfig';
import type { AllSettings } from '@server/lib/settings';

const MIGRATION_ID = '0010_add_catalogue_collection';
export default function addCatalogueCollection(settings: {
  catalogue?: { tr4ker?: Partial<Tr4kerCollectionSettings> };
  jobs?: Partial<AllSettings['jobs']>;
  migrations?: string[];
}): AllSettings {
  if (settings.migrations?.includes(MIGRATION_ID))
    return settings as AllSettings;
  settings.catalogue ??= {};
  settings.catalogue.tr4ker = {
    ...defaultTr4kerCollectionSettings,
    ...settings.catalogue.tr4ker,
  };
  settings.jobs ??= {};
  settings.jobs['catalogue-recent-movies'] ??= { schedule: '0 */15 * * * *' };
  settings.jobs['catalogue-recent-tv'] ??= { schedule: '10 */15 * * * *' };
  settings.migrations ??= [];
  settings.migrations.push(MIGRATION_ID);
  return settings as AllSettings;
}
