import { MediaStatus, MediaType } from '@server/constants/media';
import Media from '@server/entity/Media';
import { MediaRequest } from '@server/entity/MediaRequest';
import type {
  MediaRequestResponse,
  MediaRequestTarget,
} from '@server/interfaces/api/requestInterfaces';
import type { DownloadingItem } from '@server/lib/downloadtracker';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  getRequestPresentation,
  getRequestRefreshInterval,
} from './requestPresentation';

const download = (title: string) => ({ title }) as DownloadingItem;
const native: MediaRequestResponse = new MediaRequest({
  type: MediaType.MOVIE,
  is4k: false,
  seasons: [],
  media: new Media({
    status: MediaStatus.AVAILABLE,
    status4k: MediaStatus.DELETED,
    serviceUrl: 'native',
    serviceUrl4k: 'native4k',
    downloadStatus: [download('native')],
    downloadStatus4k: [download('native4k')],
  }),
});
const target = (name: string, status: MediaStatus): MediaRequestTarget => ({
  serverId: name === 'FR' ? 1 : 2,
  name,
  status,
  isIndependent: true,
  is4k: false,
  deleted: false,
  serviceUrl: name,
  downloadStatus: [download(name)],
});

describe('request presentation', () => {
  it('selects distinct destination identity, status, queue and link for the same media', () => {
    for (const [name, status] of [
      ['FR', MediaStatus.AVAILABLE],
      ['EN', MediaStatus.PROCESSING],
    ] as const) {
      const request = { ...native, target: target(name, status) };
      assert.deepEqual(getRequestPresentation(request), {
        name,
        status,
        downloadStatus: [download(name)],
        serviceUrl: name,
      });
      assert.equal(getRequestRefreshInterval(request, 15000), 15000);
    }
  });

  it('never substitutes native progress or links for empty or absent independent data', () => {
    for (const downloadStatus of [[], undefined]) {
      const request = {
        ...native,
        target: {
          ...target('Deleted Radarr server (#2)', MediaStatus.UNKNOWN),
          deleted: true,
          serviceUrl: undefined,
          downloadStatus,
        },
      };
      assert.deepEqual(getRequestPresentation(request), {
        name: request.target.name,
        status: MediaStatus.UNKNOWN,
        downloadStatus: [],
        serviceUrl: undefined,
      });
      assert.equal(getRequestRefreshInterval(request, 15000), 0);
    }
  });

  it('preserves native Standard/4K and legacy presentation and refresh cadence', () => {
    const idleNative = {
      ...native,
      media: new Media({
        ...native.media,
        downloadStatus: [],
        downloadStatus4k: [],
      }),
    };
    assert.equal(getRequestRefreshInterval(native, 15000, idleNative), 15000);
    assert.equal(getRequestRefreshInterval(idleNative, 15000, native), 0);
    const activeIndependent = {
      ...native,
      target: target('EN', MediaStatus.PROCESSING),
    };
    const idleIndependent = {
      ...activeIndependent,
      target: { ...activeIndependent.target, downloadStatus: [] },
    };
    assert.equal(
      getRequestRefreshInterval(activeIndependent, 15000, idleIndependent),
      0
    );
    assert.equal(
      getRequestRefreshInterval(idleIndependent, 15000, activeIndependent),
      15000
    );
    for (const is4k of [false, true]) {
      for (const requestTarget of [
        null,
        undefined,
        { ...target('native', MediaStatus.UNKNOWN), isIndependent: false },
      ]) {
        const request = { ...native, is4k, target: requestTarget };
        assert.deepEqual(getRequestPresentation(request), {
          name: undefined,
          status: is4k ? MediaStatus.DELETED : MediaStatus.AVAILABLE,
          downloadStatus:
            native.media[is4k ? 'downloadStatus4k' : 'downloadStatus'],
          serviceUrl: is4k ? 'native4k' : 'native',
        });
        assert.equal(getRequestRefreshInterval(request, 15000), 15000);
      }
    }
    assert.deepEqual(getRequestPresentation(), {
      name: undefined,
      status: MediaStatus.UNKNOWN,
      downloadStatus: [],
      serviceUrl: undefined,
    });
  });
});
