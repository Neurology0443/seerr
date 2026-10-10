import type { DownloadingItem } from '@server/lib/downloadtracker';

export const getRequestDownloadStatus = (
  downloadStatus: DownloadingItem[] | undefined,
  seasonNumbers: number[]
): DownloadingItem[] => {
  const items = downloadStatus ?? [];

  if (!seasonNumbers.length) {
    return items;
  }

  return items.filter(
    (item) => item.episode && seasonNumbers.includes(item.episode.seasonNumber)
  );
};
