import assert from 'node:assert/strict';
import type { TestContext } from 'node:test';
import { beforeEach, describe, it } from 'node:test';

import { MediaRequestStatus, MediaType } from '@server/constants/media';
import { getRepository } from '@server/datasource';
import Media from '@server/entity/Media';
import { MediaRequest } from '@server/entity/MediaRequest';
import { User } from '@server/entity/User';
import type { RadarrSettings } from '@server/lib/settings';
import { getSettings } from '@server/lib/settings';
import { allocateDvrServerId } from '@server/lib/settings/dvrId';
import { setupTestDb } from '@server/test/db';

setupTestDb();

beforeEach(() => {
  const settings = getSettings();
  settings.radarr = [];
  settings.sonarr = [];
  settings.dvrIdCounters = { radarr: 0, sonarr: 0 };
});

const configuredServer = (id: number) => ({ id }) as RadarrSettings;

async function mockSettingsSave(t: TestContext) {
  const settings = getSettings();
  const save = t.mock.method(settings, 'save', async () => undefined);
  return { settings, save };
}

async function seedMedia(
  mediaType: MediaType,
  tmdbId: number,
  serviceId?: number,
  serviceId4k?: number
): Promise<Media> {
  return getRepository(Media).save(
    new Media({ mediaType, tmdbId, serviceId, serviceId4k })
  );
}

async function seedRequest(
  mediaType: MediaType,
  serverId: number,
  tmdbId: number
): Promise<void> {
  const requestedBy = await getRepository(User).findOneByOrFail({ id: 1 });
  const media = await seedMedia(mediaType, tmdbId);
  await getRepository(MediaRequest)
    .createQueryBuilder()
    .insert()
    .into(MediaRequest)
    .values({
      status: MediaRequestStatus.COMPLETED,
      type: mediaType,
      serverId,
      media,
      requestedBy,
      is4k: false,
    })
    .callListeners(false)
    .execute();
}

describe('allocateDvrServerId', () => {
  it('starts both service families at zero independently and persists counters', async (t) => {
    const { settings, save } = await mockSettingsSave(t);

    assert.strictEqual(await allocateDvrServerId('radarr'), 0);
    assert.strictEqual(await allocateDvrServerId('sonarr'), 0);
    assert.deepStrictEqual(settings.dvrIdCounters, { radarr: 1, sonarr: 1 });
    assert.strictEqual(save.mock.callCount(), 2);
  });

  it('serializes concurrent allocations of the same kind', async (t) => {
    await mockSettingsSave(t);

    assert.deepStrictEqual(
      await Promise.all([
        allocateDvrServerId('radarr'),
        allocateDvrServerId('radarr'),
      ]),
      [0, 1]
    );
  });

  it('does not recycle an ID after the last configured server is removed', async (t) => {
    const { settings } = await mockSettingsSave(t);
    const first = await allocateDvrServerId('radarr');
    settings.radarr.push(configuredServer(first));
    settings.radarr.pop();

    assert.strictEqual(await allocateDvrServerId('radarr'), 1);
  });

  it('allocates above the highest configured ID', async (t) => {
    const { settings } = await mockSettingsSave(t);
    settings.radarr = [configuredServer(18)];

    assert.strictEqual(await allocateDvrServerId('radarr'), 19);
  });

  it('bootstraps from historical requests without crossing service families', async (t) => {
    await mockSettingsSave(t);
    await seedRequest(MediaType.MOVIE, 30, 10001);
    await seedRequest(MediaType.TV, 40, 10002);

    assert.strictEqual(await allocateDvrServerId('radarr'), 31);
    assert.strictEqual(await allocateDvrServerId('sonarr'), 41);
  });

  it('bootstraps from native standard and 4K media references', async (t) => {
    await mockSettingsSave(t);
    await seedMedia(MediaType.MOVIE, 20001, 50, 52);
    await seedMedia(MediaType.TV, 20002, 60, 63);

    assert.strictEqual(await allocateDvrServerId('radarr'), 53);
    assert.strictEqual(await allocateDvrServerId('sonarr'), 64);
  });

  it('keeps high history from the other media type isolated', async (t) => {
    await mockSettingsSave(t);
    await seedMedia(MediaType.MOVIE, 30001, 90, 91);

    assert.strictEqual(await allocateDvrServerId('sonarr'), 0);
  });
});
