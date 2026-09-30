import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { ServiceCommonServer } from '@server/interfaces/api/serviceInterfaces';
import { getSelectableServers } from './serviceTarget';

const servers = [
  { id: 0 },
  { id: 1, buttonLabel: 'Deutsch' },
  { id: 2 },
] as ServiceCommonServer[];

describe('AdvancedRequester target filtering', () => {
  it('only exposes native targets in the native flow', () => {
    assert.deepEqual(
      getSelectableServers(servers, false).map(({ id }) => id),
      [0, 2]
    );
  });

  it('retains the labelled fixed service target', () => {
    assert.deepEqual(
      getSelectableServers(servers, true, 1).map(({ id }) => id),
      [1]
    );
  });
});
