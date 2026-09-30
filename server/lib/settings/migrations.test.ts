import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { assertValidServiceTargets } from '@server/lib/settings';
import migrate from './settings/migrations/0009_multi_service_target_invariants';

describe('0009 multi-service target invariants', () => {
  it('normalizes valid labels and restores ambiguous targets to native', () => {
    const settings = {
      migrations: [],
      radarr: [
        {
          id: 1,
          buttonLabel: ' Deutsch ',
          isDefault: false,
          syncEnabled: true,
        },
        { id: 2, buttonLabel: '   ', isDefault: false, syncEnabled: true },
        { id: 3, buttonLabel: 'Default', isDefault: true, syncEnabled: true },
      ],
      sonarr: [
        { id: 4, buttonLabel: 'No scan', isDefault: false, syncEnabled: false },
        { id: 5, buttonLabel: 'English', isDefault: false, syncEnabled: true },
      ],
    };

    const once = migrate(structuredClone(settings) as never);
    const twice = migrate(structuredClone(once));

    assert.equal(once.radarr[0].buttonLabel, 'Deutsch');
    assert.equal(once.radarr[1].buttonLabel, undefined);
    assert.equal(once.radarr[2].buttonLabel, undefined);
    assert.equal(once.radarr[2].isDefault, true);
    assert.equal(once.sonarr[0].buttonLabel, undefined);
    assert.equal(once.sonarr[0].syncEnabled, false);
    assert.equal(once.sonarr[1].buttonLabel, 'English');
    assert.deepEqual(twice, once);
    assert.equal(
      twice.migrations.filter(
        (name) => name === '0009_multi_service_target_invariants'
      ).length,
      1
    );
  });

  it('rejects invalid future settings and accepts valid targets', () => {
    assert.throws(() =>
      assertValidServiceTargets('radarr', [
        { id: 1, buttonLabel: 'Label', isDefault: true, syncEnabled: true },
      ])
    );
    assert.throws(() =>
      assertValidServiceTargets('sonarr', [
        { id: 2, buttonLabel: 'Label', isDefault: false, syncEnabled: false },
      ])
    );
    assert.doesNotThrow(() =>
      assertValidServiceTargets('radarr', [
        { id: 3, isDefault: true, syncEnabled: false },
        { id: 4, buttonLabel: 'Label', isDefault: false, syncEnabled: true },
      ])
    );
  });
});
