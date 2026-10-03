import { MediaStatus } from '@server/constants/media';
import type { MediaRequest } from '@server/entity/MediaRequest';

export const isRequestInSlot = (
  request: Pick<MediaRequest, 'isServiceRequest' | 'serverId' | 'is4k'>,
  serverId: number | undefined,
  is4k: boolean
): boolean =>
  serverId != null
    ? request.isServiceRequest && request.serverId === serverId
    : !request.isServiceRequest && request.is4k === is4k;

export const getDestinationSeasonStatus = ({
  seasonNumber,
  serverId,
  is4k,
  seasons,
  serviceStatuses,
}: {
  seasonNumber: number;
  serverId?: number;
  is4k: boolean;
  seasons?: {
    seasonNumber: number;
    status: MediaStatus;
    status4k: MediaStatus;
  }[];
  serviceStatuses?: {
    serviceType: string;
    serviceId: number;
    seasonStatuses?: Record<number, MediaStatus> | null;
  }[];
}): MediaStatus => {
  if (serverId != null) {
    return (
      serviceStatuses?.find(
        (status) =>
          status.serviceType === 'sonarr' && status.serviceId === serverId
      )?.seasonStatuses?.[seasonNumber] ?? MediaStatus.UNKNOWN
    );
  }

  const season = seasons?.find((item) => item.seasonNumber === seasonNumber);
  return season?.[is4k ? 'status4k' : 'status'] ?? MediaStatus.UNKNOWN;
};

export const isSeasonUnavailableForRequest = (
  status: MediaStatus,
  isServiceTarget: boolean
): boolean =>
  isServiceTarget
    ? status === MediaStatus.AVAILABLE
    : status !== MediaStatus.UNKNOWN && status !== MediaStatus.DELETED;
