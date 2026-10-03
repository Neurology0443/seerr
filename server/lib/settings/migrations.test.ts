import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { assertValidServiceTargets } from '@server/lib/settings';
import migrate from './migrations/0009_multi_service_target_invariants';

describe('0009 multi-service target invariants', () => {
  it('normalizes valid labels without changing their target role', () => {
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
      ],
      sonarr: [
        { id: 5, buttonLabel: 'English', isDefault: false, syncEnabled: true },
      ],
    };

    const once = migrate(structuredClone(settings) as never);
    const twice = migrate(structuredClone(once));

    assert.equal(once.radarr[0].buttonLabel, 'Deutsch');
    assert.equal(once.radarr[1].buttonLabel, undefined);
    assert.equal(once.sonarr[0].buttonLabel, 'English');
    assert.deepEqual(twice, once);
    assert.equal(
      twice.migrations.filter(
        (name) => name === '0009_multi_service_target_invariants'
      ).length,
      1
    );
  });

  it('rejects labelled legacy targets with an incompatible role', () => {
    assert.throws(() =>
      migrate({
        migrations: [],
        radarr: [
          {
            id: 3,
            buttonLabel: 'Default',
            isDefault: true,
            syncEnabled: true,
          },
        ],
        sonarr: [],
      } as never)
    );
    assert.throws(() =>
      migrate({
        migrations: [],
        radarr: [],
        sonarr: [
          {
            id: 4,
            buttonLabel: 'No scan',
            isDefault: false,
            syncEnabled: false,
          },
        ],
      } as never)
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
