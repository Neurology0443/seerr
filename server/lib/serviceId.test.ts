import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';

import {
  MediaRequestStatus,
  MediaStatus,
  MediaType,
} from '@server/constants/media';
import { getRepository } from '@server/datasource';
import Media from '@server/entity/Media';
import { MediaRequest } from '@server/entity/MediaRequest';
import MediaServiceStatus from '@server/entity/MediaServiceStatus';
import OverrideRule from '@server/entity/OverrideRule';
import { User } from '@server/entity/User';
import { setupTestDb } from '@server/test/db';
import { allocateServiceId, getObservedServiceIdMax } from './serviceId';
import { getSettings } from './settings';

setupTestDb();

beforeEach(() => {
  const settings = getSettings();
  settings.radarr = [];
  settings.sonarr = [];
  settings.nextServiceIds = { radarr: 0, sonarr: 0 };
});

const requestWithServer = (type: MediaType, serverId: number) =>
  getRepository(MediaRequest).save(
    new MediaRequest({
      type,
      serverId,
      status: MediaRequestStatus.COMPLETED,
      is4k: false,
      isServiceRequest: false,
      isAutoRequest: false,
      ignoreQuota: false,
    })
  );

describe('service ID allocation', () => {
  it('seeds from configured services and advances persistently', async () => {
    getSettings().radarr = [{ id: 4 } as never];
    const first = await allocateServiceId('radarr');
    const second = await allocateServiceId('radarr');
    assert.ok(first > 4);
    assert.ok(second > first);
  });

  it('seeds each namespace from historical requests', async () => {
    await requestWithServer(MediaType.MOVIE, 12);
    await requestWithServer(MediaType.TV, 15);
    assert.ok((await allocateServiceId('radarr')) >= 13);
    assert.ok((await allocateServiceId('sonarr')) >= 16);
  });

  it('seeds from override rules and user grants', async () => {
    await getRepository(OverrideRule).save(
      new OverrideRule({ radarrServiceId: 20 })
    );
    await getRepository(User).save(
      new User({
        email: 'service-id-test@seerr.dev',
        avatar: '',
        requestServices: ['sonarr:25'],
      })
    );
    assert.ok((await getObservedServiceIdMax('radarr')) >= 20);
    assert.ok((await allocateServiceId('radarr')) >= 21);
    assert.ok((await allocateServiceId('sonarr')) >= 26);
  });

  it('seeds from service status', async () => {
    const media = await getRepository(Media).save(
      new Media({
        mediaType: MediaType.MOVIE,
        tmdbId: 30030,
        status: MediaStatus.UNKNOWN,
        status4k: MediaStatus.UNKNOWN,
      })
    );
    await getRepository(MediaServiceStatus).save(
      new MediaServiceStatus({
        media,
        mediaId: media.id,
        serviceType: 'radarr',
        serviceId: 30,
        status: MediaStatus.UNKNOWN,
      })
    );
    assert.ok((await allocateServiceId('radarr')) >= 31);
  });

  it('never reuses a deleted ID retained by the counter', async () => {
    getSettings().nextServiceIds = { radarr: 6, sonarr: 0 };
    assert.equal(await allocateServiceId('radarr'), 6);
  });

  it('raises a stale counter above historical references', async () => {
    getSettings().nextServiceIds = { radarr: 3, sonarr: 0 };
    await requestWithServer(MediaType.MOVIE, 12);
    assert.ok((await allocateServiceId('radarr')) >= 13);
  });

  it('allocates distinct IDs to concurrent creations in each namespace', async () => {
    const [radarrIds, sonarrIds] = await Promise.all([
      Promise.all(Array.from({ length: 5 }, () => allocateServiceId('radarr'))),
      Promise.all(Array.from({ length: 5 }, () => allocateServiceId('sonarr'))),
    ]);

    assert.equal(new Set(radarrIds).size, radarrIds.length);
    assert.equal(new Set(sonarrIds).size, sonarrIds.length);
  });
});
