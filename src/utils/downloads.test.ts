import { MediaType } from '@server/constants/media';
import type { DownloadingItem } from '@server/lib/downloadtracker';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { deduplicateDownloads, getDownloadSummary } from './downloads';

const item = (
  downloadId = 'pack',
  seasonNumber = 2,
  episodeNumber = 1
): DownloadingItem => ({
  downloadId,
  mediaType: MediaType.TV,
  externalId: 10,
  title: 'Unchanged release title',
  size: 1000,
  sizeLeft: 400,
  status: 'paused',
  timeLeft: '00:10:00',
  estimatedCompletionTime: new Date('2030-01-01'),
  episode: {
    id: episodeNumber,
    seasonNumber,
    episodeNumber,
    absoluteEpisodeNumber: episodeNumber,
  },
});

describe('destination download deduplication', () => {
  it('keeps first representatives, order and original title indexes without mutating records', () => {
    const records = [item('A'), item('A', 2, 2), item('B'), item('B', 2, 2)];
    records.forEach(Object.freeze);
    Object.freeze(records);
    const unique = deduplicateDownloads(records);
    assert.deepEqual(
      unique.map(({ sourceIndex }) => sourceIndex),
      [0, 2]
    );
    assert.equal(unique[0].item, records[0]);
    assert.equal(unique[1].item, records[2]);
    assert.equal(records.length, 4);
  });
  it('keeps records without usable identities distinct', () => {
    const records = [
      item(''),
      item(''),
      item('  '),
      item('  '),
      { ...item(), downloadId: undefined } as unknown as DownloadingItem,
    ];
    assert.equal(deduplicateDownloads(records).length, 5);
  });
  it('does not merge identities between separately processed destinations', () => {
    assert.equal(deduplicateDownloads([item('same'), item('same')]).length, 1);
    assert.equal(deduplicateDownloads([item('same'), item('same')]).length, 1);
  });
  it('handles absent and empty queues', () => {
    assert.deepEqual(deduplicateDownloads(), []);
    assert.deepEqual(getDownloadSummary([]), { count: 0 });
  });
});

describe('compact download summaries', () => {
  it('counts three season packs, with no global progress or arbitrary episode label', () => {
    const records = [1, 2, 3].flatMap((season) =>
      Array.from({ length: 23 }, (_, i) =>
        item(`pack-${season}`, season, i + 1)
      )
    );
    assert.deepEqual(getDownloadSummary(records, 'tv'), { count: 3 });
    assert.equal(deduplicateDownloads(records).length, 3);
  });
  it('uses a season only when multiple episode records establish it', () => {
    assert.deepEqual(
      getDownloadSummary(
        Array.from({ length: 23 }, (_, i) => item('pack', 2, i + 1)),
        'tv'
      ),
      { count: 1, seasonNumber: 2, progress: 60 }
    );
  });
  it('keeps an accurate episode label for one episode, including duplicate records', () => {
    assert.deepEqual(
      getDownloadSummary([item('episode', 2, 4), item('episode', 2, 4)], 'tv'),
      { count: 1, seasonNumber: 2, episodeNumber: 4, progress: 60 }
    );
  });
  it('does not assign one season to a multi-season torrent', () => {
    assert.deepEqual(
      getDownloadSummary([item('pack', 1), item('pack', 2)], 'tv'),
      { count: 1, progress: 60 }
    );
  });
  it('requires complete, valid episode metadata for a season/episode label', () => {
    for (const missing of [
      { ...item(), episode: undefined },
      item('pack', -1),
      item('pack', 2, 0),
      item('pack', NaN),
    ]) {
      assert.deepEqual(getDownloadSummary([item(), missing], 'tv'), {
        count: 1,
        progress: 60,
      });
    }
  });
  it('uses counts for movies even if episode metadata is present', () => {
    assert.deepEqual(getDownloadSummary([item()], 'movie'), {
      count: 1,
      progress: 60,
    });
  });
  it('keeps unknown download identities separate and disables aggregate progress', () => {
    assert.deepEqual(getDownloadSummary([item(''), item('')], 'tv'), {
      count: 2,
    });
  });
  it('only returns finite, valid single-download progress', () => {
    for (const values of [
      { size: 0 },
      { size: -1 },
      { size: Infinity },
      { sizeLeft: NaN },
      { sizeLeft: -1 },
      { sizeLeft: 1001 },
    ]) {
      assert.equal(
        getDownloadSummary([{ ...item(), ...values }], 'movie').progress,
        undefined
      );
    }
    assert.equal(
      getDownloadSummary([{ ...item(), sizeLeft: 0 }], 'movie').progress,
      100
    );
    assert.equal(
      getDownloadSummary([item(), item('another')], 'movie').progress,
      undefined
    );
  });
});
