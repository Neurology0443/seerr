import type {
  ServiceCommonServer,
  ServiceCommonServerWithDetails,
} from '@server/interfaces/api/serviceInterfaces';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  applyDestinationRules,
  getDestinationDefaults,
  getEditedDestinationValues,
  validateDestinationSelection,
} from './state';

const server: ServiceCommonServer = {
  id: 1,
  name: 'FR',
  is4k: false,
  isDefault: true,
  independentRequestDestination: false,
  activeProfileId: 10,
  activeDirectory: '/fr',
  activeTags: [1],
  activeLanguageProfileId: 11,
  activeAnimeProfileId: 12,
  activeAnimeDirectory: '/anime',
  activeAnimeLanguageProfileId: 13,
  activeAnimeTags: [2],
};

describe('AdvancedRequester value precedence', () => {
  it('preserves historical custom overrides including explicitly empty tags', () => {
    const persisted = {
      profile: 30,
      folder: '/custom',
      language: 31,
      tags: [],
    };
    assert.deepEqual(
      applyDestinationRules(
        getDestinationDefaults(server, false),
        { profileId: 40, rootFolder: '/rule', tags: [4] },
        persisted
      ),
      persisted
    );
  });

  it('keeps manual fields authoritative during rule and server revalidation', () => {
    const manual = { profile: 30, folder: '/manual' };
    assert.deepEqual(
      applyDestinationRules(
        getDestinationDefaults(server, false),
        { profileId: 40, rootFolder: '/rule', tags: [4] },
        manual
      ),
      { ...manual, language: 11, tags: [4] }
    );
    assert.deepEqual(
      applyDestinationRules(
        getDestinationDefaults(
          {
            ...server,
            activeProfileId: 50,
            activeDirectory: '/updated',
          },
          false
        ),
        { profileId: 60, rootFolder: '/user-rule', tags: [6] },
        manual
      ),
      { ...manual, language: 11, tags: [6] }
    );
  });

  it('loads the new destination and preserves native anime defaults', () => {
    assert.deepEqual(
      applyDestinationRules(
        getDestinationDefaults(
          {
            ...server,
            id: 2,
            activeProfileId: 20,
            activeDirectory: '/en',
            activeTags: [3],
          },
          false
        ),
        {},
        {}
      ),
      { profile: 20, folder: '/en', language: 11, tags: [3] }
    );
    assert.deepEqual(getDestinationDefaults(server, true), {
      profile: 12,
      folder: '/anime',
      language: 13,
      tags: [2],
    });
  });

  it('applies recovered rules only to fields without manual overrides', () => {
    assert.deepEqual(
      applyDestinationRules(
        getDestinationDefaults(server, false),
        { profileId: 40, rootFolder: '/recovered-rule', tags: [4] },
        { profile: 30, tags: [] }
      ),
      { profile: 30, folder: '/recovered-rule', language: 11, tags: [] }
    );
  });

  it('preserves newer manual fields when a pending rule result is applied', async () => {
    let manual = {
      profile: 30,
      folder: '/manual',
      language: 31,
      tags: [] as number[],
    };
    const result = Promise.resolve({
      profileId: 40,
      rootFolder: '/rule',
      tags: [4],
    }).then((override) =>
      applyDestinationRules(
        getDestinationDefaults(server, false),
        override,
        manual
      )
    );
    manual = { ...manual, profile: 50, folder: '/new-manual', language: 51 };
    assert.deepEqual(await result, manual);
  });
});

describe('current destination selection validation', () => {
  const metadata: ServiceCommonServerWithDetails = {
    server,
    profiles: [{ id: 10, name: 'Default' }],
    rootFolders: [{ id: 1, path: '/fr' }],
    languageProfiles: [{ id: 11, name: 'Default' }],
    tags: [{ id: 1, label: 'Default' }],
  };
  const valid = {
    server: false,
    profile: false,
    folder: false,
    language: false,
    tags: [],
  };
  const selection = {
    selectedServer: 1,
    is4k: false,
    servers: [server],
    eligibleServers: [server],
    serverData: metadata,
    values: getDestinationDefaults(server, false),
  };

  it('validates defaults and rule results as well as manual and historical values', () => {
    assert.deepEqual(validateDestinationSelection(selection), valid);
    for (const values of [
      { profile: 30, folder: '/missing', language: 31, tags: [1, 9] },
      applyDestinationRules(
        getDestinationDefaults(server, false),
        { profileId: 30, rootFolder: '/missing', tags: [1, 9] },
        { language: 31 }
      ),
      getDestinationDefaults(
        {
          ...server,
          activeProfileId: 30,
          activeDirectory: '/missing',
          activeLanguageProfileId: 31,
          activeTags: [1, 9],
        },
        false
      ),
    ]) {
      const preserved = structuredClone(values);
      assert.deepEqual(validateDestinationSelection({ ...selection, values }), {
        server: false,
        profile: true,
        folder: true,
        language: true,
        tags: [9],
      });
      assert.deepEqual(values, preserved);
    }
  });

  it('preserves absence, sentinel values and explicitly empty tags', () => {
    for (const values of [
      {},
      { profile: null, folder: null, language: null, tags: null },
      { profile: -1, folder: '', language: -1, tags: [] },
    ]) {
      assert.deepEqual(
        validateDestinationSelection({ ...selection, values }),
        valid
      );
    }
  });

  it('matches the root folder by exact path rather than ID or prefix', () => {
    assert.equal(
      validateDestinationSelection({
        ...selection,
        values: { folder: '/fr/extra' },
      }).folder,
      true
    );
  });

  it('does not infer deleted fields or a deleted server from missing metadata', () => {
    assert.deepEqual(
      validateDestinationSelection({
        selectedServer: 1,
        is4k: false,
        values: { profile: 30, folder: '/missing', language: 31, tags: [9] },
      }),
      valid
    );
  });

  it('uses only the exact selected destination inventory', () => {
    assert.deepEqual(
      validateDestinationSelection({
        ...selection,
        selectedServer: 2,
        servers: [{ ...server, id: 2 }],
        eligibleServers: [{ ...server, id: 2 }],
        values: { profile: 30, folder: '/missing', language: 31, tags: [9] },
      }),
      { ...valid, server: true }
    );
  });

  it('rejects deleted and ineligible destinations without replacing their ID', () => {
    assert.equal(
      validateDestinationSelection({ ...selection, servers: [] }).server,
      true
    );
    assert.equal(
      validateDestinationSelection({ ...selection, eligibleServers: [] })
        .server,
      true
    );
    assert.equal(selection.selectedServer, 1);
  });

  for (const is4k of [false, true]) {
    it(`rejects list/detail tier disagreement for ${is4k ? '4K' : 'Standard'}`, () => {
      const matching = { ...server, is4k };
      const tierSelection = {
        ...selection,
        is4k,
        servers: [matching],
        eligibleServers: [matching],
        serverData: { ...metadata, server: matching },
      };
      assert.deepEqual(validateDestinationSelection(tierSelection), valid);
      assert.equal(
        validateDestinationSelection({
          ...tierSelection,
          servers: [{ ...matching, is4k: !is4k }],
        }).server,
        true
      );
      assert.equal(
        validateDestinationSelection({
          ...tierSelection,
          serverData: { ...metadata, server: { ...matching, is4k: !is4k } },
        }).server,
        true
      );
    });
  }

  it('only validates language profiles when their inventory is applicable', () => {
    for (const languageProfiles of [undefined, null]) {
      assert.equal(
        validateDestinationSelection({
          ...selection,
          serverData: {
            ...metadata,
            languageProfiles,
          } as ServiceCommonServerWithDetails,
          values: { language: 31 },
        }).language,
        false
      );
    }
    assert.equal(
      validateDestinationSelection({
        ...selection,
        serverData: { ...metadata, languageProfiles: [] },
      }).language,
      true
    );
  });

  it('retains invalid tags and recovers after explicit removal or metadata repair', () => {
    const values = { ...selection.values, tags: [1, 9] };
    assert.deepEqual(
      validateDestinationSelection({ ...selection, values }).tags,
      [9]
    );
    assert.deepEqual(values.tags, [1, 9]);
    assert.deepEqual(
      validateDestinationSelection({
        ...selection,
        values: { ...values, tags: [] },
      }),
      valid
    );
    assert.deepEqual(
      validateDestinationSelection({
        ...selection,
        values,
        serverData: {
          ...metadata,
          tags: [...metadata.tags, { id: 9, label: 'Restored' }],
        },
      }),
      valid
    );
  });
});

describe('partial request edit configuration', () => {
  it('uses the new destination configuration instead of old persisted values', () => {
    const resolved = { profile: 20, folder: '/en', language: 21, tags: [2] };
    assert.deepEqual(
      getEditedDestinationValues(
        { profile: 30, folder: '/fr', language: 31, tags: [] },
        {},
        { ...resolved, destinationChanged: true }
      ),
      resolved
    );
  });

  it('preserves manual selections made on the new destination', () => {
    assert.deepEqual(
      getEditedDestinationValues(
        { profile: 30, folder: '/fr', language: 31, tags: [1] },
        { profile: 22, tags: [] },
        {
          profile: 20,
          folder: '/en',
          language: 21,
          tags: [2],
          destinationChanged: true,
        }
      ),
      { profile: 22, folder: '/en', language: 21, tags: [] }
    );
  });

  it('preserves persisted nulls on an unchanged or restored destination', () => {
    const persisted = {
      profile: null,
      folder: null,
      language: null,
      tags: null,
    };
    assert.deepEqual(
      getEditedDestinationValues(
        persisted,
        { folder: '/custom' },
        {
          ...getDestinationDefaults(server, false),
          destinationChanged: false,
        }
      ),
      { ...persisted, folder: '/custom' }
    );
  });

  it('clears an old language override when the new destination has none', () => {
    assert.deepEqual(
      getEditedDestinationValues(
        { profile: 30, folder: '/fr', language: 31, tags: [1] },
        {},
        { profile: 20, folder: '/en', tags: [], destinationChanged: true }
      ),
      { profile: 20, folder: '/en', language: null, tags: [] }
    );
  });

  it('preserves nullable historical fields when only the folder changes', () => {
    assert.deepEqual(
      getEditedDestinationValues(
        { profile: null, folder: null, language: null, tags: null },
        { folder: '/custom' }
      ),
      { profile: null, folder: '/custom', language: null, tags: null }
    );
  });

  it('preserves explicit values and empty tags when only the profile changes', () => {
    assert.deepEqual(
      getEditedDestinationValues(
        { profile: 30, folder: '/custom', language: 31, tags: [] },
        { profile: 10 }
      ),
      { profile: 10, folder: '/custom', language: 31, tags: [] }
    );
  });

  it('persists explicit selections even when they match displayed defaults', () => {
    const defaults = getDestinationDefaults(server, false);
    assert.deepEqual(
      getEditedDestinationValues(
        { profile: null, folder: null, language: null, tags: null },
        defaults
      ),
      defaults
    );
  });

  it('keeps untouched persisted values instead of displayed rule results', () => {
    const persisted = {
      profile: null,
      folder: '/custom',
      language: null,
      tags: [9],
    };
    assert.deepEqual(getEditedDestinationValues(persisted), persisted);
    assert.deepEqual(
      applyDestinationRules(
        getDestinationDefaults(server, false),
        { profileId: 40, rootFolder: '/rule', tags: [4] },
        { folder: '/custom', tags: [9] }
      ),
      { profile: 40, folder: '/custom', language: 11, tags: [9] }
    );
    assert.deepEqual(getEditedDestinationValues(persisted, { tags: [] }), {
      ...persisted,
      tags: [],
    });
  });
});
