import { MediaRequestStatus, MediaStatus } from '@server/constants/media';
import type { MediaRequest } from '@server/entity/MediaRequest';
import type { NonFunctionProperties } from '@server/interfaces/api/common';
import type { DownloadingItem } from '@server/lib/downloadtracker';

export const getServiceSlotStatus = (
  request?: NonFunctionProperties<MediaRequest>,
  seasonNumber?: number
): { status?: MediaStatus; downloadItem?: DownloadingItem[] } => {
  if (!request?.isServiceRequest) {
    return {};
  }

  const serviceStatus = request.media.serviceStatuses?.find(
    (ss) => ss.serviceId === request.serverId
  );

  const rawLiveStatus =
    seasonNumber === undefined
      ? serviceStatus?.status
      : serviceStatus?.seasonStatuses?.[seasonNumber];
  const liveStatus =
    rawLiveStatus !== undefined &&
    rawLiveStatus !== MediaStatus.UNKNOWN &&
    rawLiveStatus !== MediaStatus.DELETED
      ? rawLiveStatus
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
      seasonNumber === undefined && liveStatus !== undefined
        ? (serviceStatus?.downloadStatus ?? [])
        : [],
  };
};
