import type { MediaStatus } from '@server/constants/media';
import type Media from '@server/entity/Media';
import type { User } from '@server/entity/User';
import type { DownloadingItem } from '@server/lib/downloadtracker';
import type { PaginatedResponse } from './common';

export interface MediaDownloadGroup {
  serverId: number;
  name: string;
  is4k: boolean;
  isIndependent: boolean;
  status: MediaStatus;
  downloads: DownloadingItem[];
}

export interface MediaDownloadsResponse {
  groups: MediaDownloadGroup[];
}

export interface MediaResultsResponse extends PaginatedResponse {
  results: Media[];
}

export interface MediaWatchDataResponse {
  data?: {
    users: User[];
    playCount: number;
    playCount7Days: number;
    playCount30Days: number;
  };
  data4k?: {
    users: User[];
    playCount: number;
    playCount7Days: number;
    playCount30Days: number;
  };
}
