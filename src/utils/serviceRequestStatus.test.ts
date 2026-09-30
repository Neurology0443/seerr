import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { MediaRequestStatus, MediaStatus } from '@server/constants/media';
import type { MediaRequest } from '@server/entity/MediaRequest';
import type { NonFunctionProperties } from '@server/interfaces/api/common';
import { getServiceSlotStatus } from './serviceRequestStatus';

const request = (
  status: MediaRequestStatus,
  serviceStatus?: MediaStatus
): NonFunctionProperties<MediaRequest> =>
  ({
    status,
    isServiceRequest: true,
    serverId: 12,
    media: {
      status: MediaStatus.AVAILABLE,
      status4k: MediaStatus.AVAILABLE,
      serviceStatuses:
        serviceStatus === undefined
          ? []
          : [{ serviceId: 12, status: serviceStatus }],
    },
  }) as unknown as NonFunctionProperties<MediaRequest>;

describe('service request status', () => {
  it('uses the live target status when present', () => {
    assert.equal(
      getServiceSlotStatus(
        request(MediaRequestStatus.APPROVED, MediaStatus.AVAILABLE)
      ).status,
      MediaStatus.AVAILABLE
    );
    assert.equal(
      getServiceSlotStatus(
        request(MediaRequestStatus.APPROVED, MediaStatus.PROCESSING)
      ).status,
      MediaStatus.PROCESSING
    );
  });

  it('represents only active requests when the live status is absent', () => {
    assert.equal(
      getServiceSlotStatus(request(MediaRequestStatus.PENDING)).status,
      MediaStatus.PENDING
    );
    assert.equal(
      getServiceSlotStatus(request(MediaRequestStatus.APPROVED)).status,
      MediaStatus.PROCESSING
    );
    assert.equal(
      getServiceSlotStatus(request(MediaRequestStatus.COMPLETED)).status,
      undefined
    );
  });
});
