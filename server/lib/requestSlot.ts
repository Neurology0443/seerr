import { MediaRequestStatus, MediaStatus } from '@server/constants/media';

export const ACTIVE_REQUEST_STATUSES = [
  MediaRequestStatus.PENDING,
  MediaRequestStatus.APPROVED,
] as const;

export const isActiveRequestStatus = (status: MediaRequestStatus): boolean =>
  ACTIVE_REQUEST_STATUSES.includes(
    status as (typeof ACTIVE_REQUEST_STATUSES)[number]
  );

export const isRequestableDestinationStatus = (status?: MediaStatus): boolean =>
  status === undefined ||
  status === MediaStatus.UNKNOWN ||
  status === MediaStatus.DELETED;

export const isRequestDrivenDestinationStatus = (
  status: MediaStatus
): boolean =>
  status === MediaStatus.PENDING || status === MediaStatus.PROCESSING;
