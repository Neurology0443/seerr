import type { ServiceCommonServer } from '@server/interfaces/api/serviceInterfaces';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { applyDestinationRules, getDestinationDefaults } from './state';

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
});
