import { MediaStatus } from '@server/constants/media';
import type {
  MovieRequestTarget,
  TvRequestTarget,
} from '@server/interfaces/api/requestInterfaces';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  canRequestTargetTier,
  getDefaultRequestTarget,
  getRequestableSeasonNumbers,
  getTvRequestSeasonPayload,
  groupPendingRequests,
} from './requestTargets';

const target = (
  serverId: number,
  overrides: Partial<MovieRequestTarget> = {}
): MovieRequestTarget => ({
  serverId,
  name: `Server ${serverId}`,
  is4k: false,
  isDefault: false,
  isIndependent: true,
  status: MediaStatus.UNKNOWN,
  requestable: true,
  ...overrides,
});

describe('request target selection', () => {
  it('allows Advanced users to use a requestable non-default destination', () => {
    const targets = [
      target(1, { isDefault: true, requestable: false }),
      target(2),
    ];

    assert.equal(canRequestTargetTier(targets, false, true), true);
    assert.equal(canRequestTargetTier(targets, false, false), false);
    assert.equal(canRequestTargetTier(undefined, false, true), false);
    assert.equal(getDefaultRequestTarget(targets, false)?.serverId, 1);
  });

  it('keeps Standard and 4K eligibility separate', () => {
    const targets = [
      target(1, { isDefault: true, requestable: false }),
      target(2, { is4k: true, isDefault: true }),
    ];

    assert.equal(canRequestTargetTier(targets, false, true), false);
    assert.equal(canRequestTargetTier(targets, true, true), true);
  });

  it('uses season requestability rather than season status', () => {
    const tvTarget: TvRequestTarget = {
      ...target(1, { isDefault: true }),
      seasons: [
        {
          seasonNumber: 1,
          status: MediaStatus.UNKNOWN,
          requestable: false,
        },
        {
          seasonNumber: 2,
          status: MediaStatus.PROCESSING,
          requestable: true,
        },
      ],
    };

    assert.deepEqual(getRequestableSeasonNumbers(tvTarget), [2]);
    assert.deepEqual(getTvRequestSeasonPayload(tvTarget, [1, 2], true), [2]);
    assert.deepEqual(getTvRequestSeasonPayload(tvTarget, [], false), [2]);
  });
});

describe('pending request grouping', () => {
  it('separates independent destinations while preserving native tier groups', () => {
    const targets = [
      target(1, { name: 'FR' }),
      target(2, { name: 'EN' }),
      target(3, { isIndependent: false }),
      target(4, { isIndependent: false }),
    ];
    const groups = groupPendingRequests(
      [
        { id: 10, serverId: 1, is4k: false },
        { id: 11, serverId: 2, is4k: false },
        { id: 12, serverId: 3, is4k: false },
        { id: 13, serverId: 4, is4k: false },
        { id: 14, serverId: null, is4k: false },
      ],
      targets
    );

    assert.deepEqual(
      groups.map((group) => [
        group.key,
        group.destinationName,
        group.requests.map((request) => request.id),
      ]),
      [
        ['independent:1', 'FR', [10]],
        ['independent:2', 'EN', [11]],
        ['native:false', undefined, [12, 13, 14]],
      ]
    );
  });

  it('never batches unresolved destinations together', () => {
    const groups = groupPendingRequests(
      [
        { id: 20, serverId: 8, is4k: false },
        { id: 21, serverId: 9, is4k: false },
      ],
      undefined
    );

    assert.deepEqual(
      groups.map((group) => group.requests.map((request) => request.id)),
      [[20], [21]]
    );
  });
});
