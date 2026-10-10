import type { MediaStatus, MediaType } from '@server/constants/media';
import type { MediaRequest } from '@server/entity/MediaRequest';
import type { DownloadingItem } from '@server/lib/downloadtracker';
import type { NonFunctionProperties, PaginatedResponse } from './common';

export type MediaRequestResponse = NonFunctionProperties<MediaRequest> & {
  target?: MediaRequestTarget | null;
};

export type RequestDetailResponse = MediaRequestResponse & {
  editRevision: string;
  target: MediaRequestTarget | null;
};

export interface RequestResultsResponse extends PaginatedResponse {
  results: (NonFunctionProperties<MediaRequest> & {
    profileName?: string;
    canRemove?: boolean;
    target: MediaRequestTarget | null;
  })[];
  serviceErrors: {
    radarr: { id: number; name: string }[];
    sonarr: { id: number; name: string }[];
  };
}

export interface MediaRequestTarget {
  serverId: number;
  name: string;
  is4k: boolean;
  isIndependent: boolean;
  deleted: boolean;
  status: MediaStatus;
  serviceUrl?: string;
  downloadStatus?: DownloadingItem[];
}

export interface MovieRequestTarget {
  serverId: number;
  name: string;
  is4k: boolean;
  isDefault: boolean;
  isIndependent: boolean;
  status: MediaStatus;
  requestable: boolean;
}

export interface TvRequestTargetSeason {
  seasonNumber: number;
  status: MediaStatus;
  requestable: boolean;
}

export interface TvRequestTarget extends MovieRequestTarget {
  seasons: TvRequestTargetSeason[];
}

export type MediaRequestBody = {
  mediaType: MediaType;
  mediaId: number;
  tvdbId?: number;
  seasons?: number[] | 'all';
  is4k?: boolean;
  serverId?: number;
  profileId?: number;
  profileName?: string;
  rootFolder?: string;
  languageProfileId?: number;
  userId?: number;
  tags?: number[];
  ignoreQuota?: boolean;
};
