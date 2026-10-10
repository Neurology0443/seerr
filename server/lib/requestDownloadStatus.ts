import { MediaType } from '@server/constants/media';
import type { DownloadingItem } from '@server/lib/downloadtracker';

export const getRequestDownloadStatus = (
  downloadStatus: DownloadingItem[] | undefined,
  seasonNumbers: number[],
  mediaType?: MediaType
): DownloadingItem[] => {
  const items = downloadStatus ?? [];

  if (mediaType === MediaType.MOVIE) {
    return items;
  }

  if (!seasonNumbers.length) {
    // Native callers retain their existing empty-season behavior. Independent
    // TV callers specify the media type and must establish requested seasons.
    return mediaType === MediaType.TV ? [] : items;
  }

  return items.filter(
    (item) => item.episode && seasonNumbers.includes(item.episode.seasonNumber)
  );
};
