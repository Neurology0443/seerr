import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { MediaRequestStatus, MediaStatus } from '@server/constants/media';
import type { MediaRequest } from '@server/entity/MediaRequest';
import type { NonFunctionProperties } from '@server/interfaces/api/common';
import { getServiceSlotStatus } from './serviceRequestStatus';

const request = (
  status: MediaRequestStatus,
  serviceStatus?: MediaStatus,
  downloadStatus: unknown[] = []
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
          : [{ serviceId: 12, status: serviceStatus, downloadStatus }],
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

  for (const liveStatus of [MediaStatus.UNKNOWN, MediaStatus.DELETED]) {
    it(`falls back from ${liveStatus} to an active request without live downloads`, () => {
      const pending = getServiceSlotStatus(
        request(MediaRequestStatus.PENDING, liveStatus, [{}])
      );
      assert.equal(pending.status, MediaStatus.PENDING);
      assert.deepEqual(pending.downloadItem, []);

      const approved = getServiceSlotStatus(
        request(MediaRequestStatus.APPROVED, liveStatus, [{}])
      );
      assert.equal(approved.status, MediaStatus.PROCESSING);
      assert.deepEqual(approved.downloadItem, []);

      assert.equal(
        getServiceSlotStatus(
          request(MediaRequestStatus.COMPLETED, liveStatus, [{}])
        ).status,
        undefined
      );
    });
  }

  it('keeps downloads only for a meaningful live status', () => {
    const downloadStatus = [{}];
    const result = getServiceSlotStatus(
      request(
        MediaRequestStatus.APPROVED,
        MediaStatus.PROCESSING,
        downloadStatus
      )
    );
    assert.equal(result.status, MediaStatus.PROCESSING);
    assert.deepEqual(result.downloadItem, downloadStatus);
  });
});
