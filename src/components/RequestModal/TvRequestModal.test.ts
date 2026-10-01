import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { MediaStatus } from '@server/constants/media';
import {
  getDestinationSeasonStatus,
  isRequestInSlot,
  isSeasonUnavailableForRequest,
} from './tvSeasonSelection';

describe('TV request destination selection', () => {
  it('isolates native and multi-service request slots', () => {
    const native = {
      isServiceRequest: false,
      serverId: 10,
      is4k: false,
    };
    const native4k = { ...native, is4k: true };
    const serviceFr = {
      isServiceRequest: true,
      serverId: 20,
      is4k: true,
    };
    const serviceDe = { ...serviceFr, serverId: 21 };

    assert.equal(isRequestInSlot(native, undefined, false), true);
    assert.equal(isRequestInSlot(native4k, undefined, false), false);
    assert.equal(isRequestInSlot(serviceFr, 20, true), true);
    assert.equal(isRequestInSlot(serviceDe, 20, true), false);
    assert.equal(isRequestInSlot(native4k, 20, true), false);
  });

  it('uses only the selected service season status', () => {
    const serviceStatuses = [
      {
        serviceType: 'sonarr',
        serviceId: 20,
        seasonStatuses: { 1: MediaStatus.AVAILABLE },
      },
    ];
    const seasons = [
      {
        seasonNumber: 1,
        status: MediaStatus.AVAILABLE,
        status4k: MediaStatus.PROCESSING,
      },
    ];

    assert.equal(
      getDestinationSeasonStatus({
        seasonNumber: 1,
        serverId: 20,
        is4k: false,
        seasons,
        serviceStatuses,
      }),
      MediaStatus.AVAILABLE
    );
    assert.equal(
      getDestinationSeasonStatus({
        seasonNumber: 1,
        serverId: 21,
        is4k: false,
        seasons,
        serviceStatuses,
      }),
      MediaStatus.UNKNOWN
    );
  });

  it('keeps native Standard and 4K availability independent', () => {
    const seasons = [
      {
        seasonNumber: 1,
        status: MediaStatus.AVAILABLE,
        status4k: MediaStatus.UNKNOWN,
      },
    ];

    assert.equal(
      getDestinationSeasonStatus({
        seasonNumber: 1,
        is4k: false,
        seasons,
      }),
      MediaStatus.AVAILABLE
    );
    assert.equal(
      getDestinationSeasonStatus({
        seasonNumber: 1,
        is4k: true,
        seasons,
      }),
      MediaStatus.UNKNOWN
    );
  });

  it('blocks only available seasons for a multi-service target', () => {
    assert.equal(
      isSeasonUnavailableForRequest(MediaStatus.AVAILABLE, true),
      true
    );
    for (const status of [
      MediaStatus.PROCESSING,
      MediaStatus.PARTIALLY_AVAILABLE,
      MediaStatus.UNKNOWN,
      MediaStatus.DELETED,
    ]) {
      assert.equal(isSeasonUnavailableForRequest(status, true), false);
    }
  });
});
