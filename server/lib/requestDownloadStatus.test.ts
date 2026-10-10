import { MediaType } from '@server/constants/media';
import type { DownloadingItem } from '@server/lib/downloadtracker';
import { getRequestDownloadStatus } from '@server/lib/requestDownloadStatus';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

const queue = [
  { title: 'Season 1', episode: { seasonNumber: 1 } },
  { title: 'Season 2', episode: { seasonNumber: 2 } },
  { title: 'No episode' },
] as DownloadingItem[];

describe('request download filtering', () => {
  it('does not filter movies by seasons', () => {
    assert.deepEqual(
      getRequestDownloadStatus(queue, [], MediaType.MOVIE),
      queue
    );
    assert.deepEqual(
      getRequestDownloadStatus(queue, [1], MediaType.MOVIE),
      queue
    );
  });

  it('exposes only the requested TV seasons and fails closed without seasons', () => {
    assert.deepEqual(getRequestDownloadStatus(queue, [1], MediaType.TV), [
      queue[0],
    ]);
    assert.deepEqual(getRequestDownloadStatus(queue, [], MediaType.TV), []);
    assert.deepEqual(
      getRequestDownloadStatus(undefined, [1], MediaType.TV),
      []
    );
  });

  it('preserves the native empty-season queue behavior', () => {
    assert.deepEqual(getRequestDownloadStatus(queue, []), queue);
  });
});
