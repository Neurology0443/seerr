import { MediaRequestStatus, MediaStatus } from '@server/constants/media';
import type { MediaRequest } from '@server/entity/MediaRequest';
import type { NonFunctionProperties } from '@server/interfaces/api/common';
import type { DownloadingItem } from '@server/lib/downloadtracker';

export const getServiceSlotStatus = (
  request?: NonFunctionProperties<MediaRequest>
): { status?: MediaStatus; downloadItem?: DownloadingItem[] } => {
  if (!request?.isServiceRequest) {
    return {};
  }

  const serviceStatus = request.media.serviceStatuses?.find(
    (ss) => ss.serviceId === request.serverId
  );

  const liveStatus =
    serviceStatus &&
    serviceStatus.status !== MediaStatus.UNKNOWN &&
    serviceStatus.status !== MediaStatus.DELETED
      ? serviceStatus.status
      : undefined;
  const requestStatus =
    request.status === MediaRequestStatus.PENDING
      ? MediaStatus.PENDING
      : request.status === MediaRequestStatus.APPROVED
        ? MediaStatus.PROCESSING
        : undefined;

  return {
    status: liveStatus ?? requestStatus,
    downloadItem:
      liveStatus !== undefined ? (serviceStatus?.downloadStatus ?? []) : [],
  };
};
