import {
  defaultTr4kerCollectionSettings,
  validateCollectionSettings,
} from '@server/lib/catalogue/collectionConfig';
import assert from 'node:assert/strict';
import { it } from 'node:test';
import addCatalogueCollection from './migrations/0010_add_catalogue_collection';

it('catalogue settings migration is additive, disabled by default and idempotent', () => {
  const nativeJobs = { 'radarr-scan': { schedule: '0 0 4 * * *' } };
  const migrated = addCatalogueCollection({
    jobs: structuredClone(nativeJobs),
    migrations: [],
  });
  assert.deepEqual(migrated.catalogue.tr4ker, defaultTr4kerCollectionSettings);
  assert.equal(migrated.catalogue.tr4ker.enabled, false);
  assert.equal(migrated.catalogue.tr4ker.maintenanceIntervalMinutes, null);
  assert.deepEqual(migrated.jobs['radarr-scan'], nativeJobs['radarr-scan']);
  assert.equal(
    migrated.jobs['catalogue-recent-movies'].schedule,
    '0 */15 * * * *'
  );
  assert.equal(
    migrated.jobs['catalogue-recent-tv'].schedule,
    '10 */15 * * * *'
  );
  assert.deepEqual(addCatalogueCollection(structuredClone(migrated)), migrated);
});
it('catalogue migration preserves configured settings and custom schedules', () => {
  const migrated = addCatalogueCollection({
    catalogue: {
      tr4ker: {
        enabled: true,
        recentPageLimit: 7,
        maintenanceIntervalMinutes: 60,
      },
    },
    jobs: { 'catalogue-recent-movies': { schedule: '0 */30 * * * *' } },
  });
  assert.equal(migrated.catalogue.tr4ker.recentPageLimit, 7);
  assert.equal(migrated.catalogue.tr4ker.maintenanceIntervalMinutes, 60);
  assert.equal(
    migrated.jobs['catalogue-recent-movies'].schedule,
    '0 */30 * * * *'
  );
  assert.doesNotThrow(() =>
    validateCollectionSettings(migrated.catalogue.tr4ker)
  );
});
it('invalid intervals, burst settings and unbounded page limits are rejected safely', () => {
  for (const patch of [
    { globalSpacingSeconds: 2 },
    { maintenanceSpacingSeconds: 5 },
    { maintenanceIntervalMinutes: 0 },
    { maintenanceIntervalMinutes: NaN },
    { maintenanceIntervalMinutes: 'SECRET' },
    { recentPageLimit: 100000 },
    { failureLimit: 0 },
    { initialBackoffSeconds: -1 },
  ]) {
    assert.throws(
      () =>
        validateCollectionSettings({
          ...defaultTr4kerCollectionSettings,
          ...patch,
        } as typeof defaultTr4kerCollectionSettings),
      (error) =>
        (error as Error).message ===
        'Invalid catalogue collection configuration'
    );
  }
});
