import { MediaStatus } from '@server/constants/media';
import type { MediaRequestResponse } from '@server/interfaces/api/requestInterfaces';
import {
  getRequestDownloadStatus,
  refreshIntervalHelper,
} from './refreshIntervalHelper';

export const getRequestPresentation = (request?: MediaRequestResponse) => {
  if (request?.target?.isIndependent) {
    return {
      name: request.target.name,
      status: request.target.status,
      downloadStatus: request.target.downloadStatus ?? [],
      serviceUrl: request.target.serviceUrl,
    };
  }

  return {
    name: undefined,
    status:
      request?.media?.[request.is4k ? 'status4k' : 'status'] ??
      MediaStatus.UNKNOWN,
    downloadStatus: getRequestDownloadStatus(
      request?.media?.[request.is4k ? 'downloadStatus4k' : 'downloadStatus'],
      request?.type === 'tv'
        ? (request.seasons ?? []).map((season) => season.seasonNumber)
        : []
    ),
    serviceUrl: request?.media?.[request.is4k ? 'serviceUrl4k' : 'serviceUrl'],
  };
};

export const getRequestRefreshInterval = (
  request: MediaRequestResponse,
  timer: number,
  latestRequest: MediaRequestResponse = request
) =>
  refreshIntervalHelper(
    latestRequest.target?.isIndependent
      ? {
          downloadStatus: latestRequest.target.downloadStatus,
          downloadStatus4k: undefined,
        }
      : {
          downloadStatus: request.media.downloadStatus,
          downloadStatus4k: request.media.downloadStatus4k,
        },
    timer
  );
