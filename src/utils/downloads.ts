import type { DownloadingItem } from '@server/lib/downloadtracker';

/** Call separately for each destination. Source indexes preserve title-array alignment. */
export const deduplicateDownloads = (items: DownloadingItem[] = []) => {
  const seen = new Set<string>();
  return items.flatMap((item, sourceIndex) => {
    const id =
      typeof item.downloadId === 'string' && item.downloadId.trim()
        ? item.downloadId
        : undefined;
    if (id && seen.has(id)) return [];
    if (id) seen.add(id);
    return [
      {
        item,
        sourceIndex,
        key: id ? `download-${id}` : `record-${sourceIndex}`,
      },
    ];
  });
};

export const getDownloadSummary = (
  items: DownloadingItem[] = [],
  mediaType?: 'movie' | 'tv'
) => {
  const unique = deduplicateDownloads(items);
  const summary: {
    count: number;
    seasonNumber?: number;
    episodeNumber?: number;
    progress?: number;
  } = { count: unique.length };
  if (unique.length !== 1) return summary;

  const first = unique[0].item;
  if (
    Number.isFinite(first.size) &&
    first.size > 0 &&
    Number.isFinite(first.sizeLeft) &&
    first.sizeLeft >= 0 &&
    first.sizeLeft <= first.size
  ) {
    summary.progress = Math.round(
      ((first.size - first.sizeLeft) / first.size) * 100
    );
  }
  if (
    mediaType !== 'tv' ||
    items.some(
      ({ episode }) =>
        !episode ||
        !Number.isSafeInteger(episode.seasonNumber) ||
        episode.seasonNumber < 0 ||
        !Number.isSafeInteger(episode.episodeNumber) ||
        episode.episodeNumber <= 0
    )
  )
    return summary;
  const seasons = new Set(items.map(({ episode }) => episode!.seasonNumber));
  if (seasons.size !== 1) return summary;
  summary.seasonNumber = first.episode!.seasonNumber;
  const episodes = new Set(items.map(({ episode }) => episode!.episodeNumber));
  if (episodes.size === 1) summary.episodeNumber = first.episode!.episodeNumber;
  return summary;
};
