import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import migrateIndependentDestinations from './migrations/0009_add_independent_request_destination';

describe('0009_add_independent_request_destination', () => {
  it('defaults missing Radarr and Sonarr values to false and preserves true', () => {
    const settings = {
      radarr: [{ id: 0 }, { id: 1, independentRequestDestination: true }],
      sonarr: [{ id: 0 }],
      migrations: [],
    };

    const migrated = migrateIndependentDestinations(settings);

    assert.strictEqual(migrated.radarr[0].independentRequestDestination, false);
    assert.strictEqual(migrated.radarr[1].independentRequestDestination, true);
    assert.strictEqual(migrated.sonarr[0].independentRequestDestination, false);
  });

  it('records its ID and is idempotent on a second execution', () => {
    const once = migrateIndependentDestinations({
      radarr: [{ id: 0 }],
      sonarr: [{ id: 0 }],
      migrations: [],
    });
    const twice = migrateIndependentDestinations(structuredClone(once));

    assert.deepStrictEqual(twice, once);
    assert.deepStrictEqual(
      twice.migrations.filter(
        (id) => id === '0009_add_independent_request_destination'
      ),
      ['0009_add_independent_request_destination']
    );
  });
});
