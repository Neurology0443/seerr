import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';

import {
  MediaRequestStatus,
  MediaStatus,
  MediaType,
} from '@server/constants/media';
import { getRepository } from '@server/datasource';
import Media from '@server/entity/Media';
import { MediaDestinationStatus } from '@server/entity/MediaDestinationStatus';
import { MediaRequest } from '@server/entity/MediaRequest';
import { User } from '@server/entity/User';
import { getRequestTargetState } from '@server/lib/requestTargetState';
import type { RadarrSettings, SonarrSettings } from '@server/lib/settings';
import { getSettings } from '@server/lib/settings';
import { setupTestDb } from '@server/test/db';

setupTestDb();

beforeEach(() => {
  getSettings().radarr = [];
  getSettings().sonarr = [];
});

const radarr = (
  id: number,
  overrides: Partial<RadarrSettings> = {}
): RadarrSettings =>
  ({
    id,
    name: `Radarr ${id}`,
    hostname: 'localhost',
    port: 7878,
    apiKey: 'test',
    useSsl: false,
    activeProfileId: 1,
    activeDirectory: '/movies',
    is4k: false,
    minimumAvailability: 'released',
    isDefault: false,
    syncEnabled: true,
    independentRequestDestination: false,
    preventSearch: false,
    tagRequests: false,
    tags: [],
    ...overrides,
  }) as RadarrSettings;

const sonarr = (
  id: number,
  overrides: Partial<SonarrSettings> = {}
): SonarrSettings =>
  ({
    id,
    name: `Sonarr ${id}`,
    hostname: 'localhost',
    port: 8989,
    apiKey: 'test',
    useSsl: false,
    activeProfileId: 1,
    activeDirectory: '/tv',
    is4k: false,
    isDefault: false,
    syncEnabled: true,
    independentRequestDestination: false,
    preventSearch: false,
    tagRequests: false,
    enableSeasonFolders: true,
    seriesType: 'standard',
    animeSeriesType: 'anime',
    monitorNewItems: 'all',
    tags: [],
    animeTags: [],
    ...overrides,
  }) as SonarrSettings;

async function seedRequest({
  type = MediaType.MOVIE,
  serverId = 1,
  is4k = false,
  status = MediaStatus.PROCESSING,
  status4k = MediaStatus.AVAILABLE,
}: {
  type?: MediaType;
  serverId?: number | null;
  is4k?: boolean;
  status?: MediaStatus;
  status4k?: MediaStatus;
} = {}) {
  const media = await getRepository(Media).save(
    new Media({
      mediaType: type,
      tmdbId: type === MediaType.MOVIE ? 41001 : 42001,
      status,
      status4k,
    })
  );
  const requestedBy = await getRepository(User).findOneByOrFail({ id: 1 });
  const request = await getRepository(MediaRequest).save(
    new MediaRequest({
      type,
      status: MediaRequestStatus.COMPLETED,
      media,
      requestedBy,
      serverId: serverId as number,
      is4k,
    })
  );

  return { media, request };
}

describe('getRequestTargetState', () => {
  it('reads native Standard and 4K status from their native fields', async () => {
    getSettings().radarr = [radarr(1), radarr(2, { is4k: true })];
    const standard = await seedRequest({ serverId: 1 });
    const fourK = await seedRequest({ serverId: 2, is4k: true });

    assert.strictEqual(
      (
        await getRequestTargetState(
          standard.request,
          getRepository(MediaRequest).manager
        )
      )?.status,
      MediaStatus.PROCESSING
    );
    assert.strictEqual(
      (
        await getRequestTargetState(
          fourK.request,
          getRepository(MediaRequest).manager
        )
      )?.status,
      MediaStatus.AVAILABLE
    );
  });

  it('uses only exact independent destination state and treats a missing row as UNKNOWN', async () => {
    getSettings().radarr = [
      radarr(11, { independentRequestDestination: true }),
      radarr(12, { independentRequestDestination: true }),
    ];
    const exact = await seedRequest({
      serverId: 11,
      status: MediaStatus.AVAILABLE,
    });
    const missing = await seedRequest({
      serverId: 12,
      status: MediaStatus.AVAILABLE,
    });
    await getRepository(MediaDestinationStatus).save(
      new MediaDestinationStatus({
        mediaId: exact.media.id,
        serverId: 11,
        status: MediaStatus.DELETED,
      })
    );

    const exactTarget = await getRequestTargetState(
      exact.request,
      getRepository(MediaRequest).manager
    );
    const missingTarget = await getRequestTargetState(
      missing.request,
      getRepository(MediaRequest).manager
    );

    assert.strictEqual(exactTarget?.isIndependent, true);
    assert.strictEqual(exactTarget?.status, MediaStatus.DELETED);
    assert.strictEqual(missingTarget?.isIndependent, true);
    assert.strictEqual(missingTarget?.status, MediaStatus.UNKNOWN);
  });

  it('classifies deleted servers only through the historical destination row', async () => {
    const independent = await seedRequest({ serverId: 21 });
    const native = await seedRequest({ serverId: 22 });
    await getRepository(MediaDestinationStatus).save(
      new MediaDestinationStatus({
        mediaId: independent.media.id,
        serverId: 21,
        status: MediaStatus.AVAILABLE,
      })
    );

    const independentTarget = await getRequestTargetState(
      independent.request,
      getRepository(MediaRequest).manager
    );
    const nativeTarget = await getRequestTargetState(
      native.request,
      getRepository(MediaRequest).manager
    );

    assert.deepStrictEqual(independentTarget, {
      serverId: 21,
      name: 'Deleted Radarr server (#21)',
      is4k: false,
      isIndependent: true,
      deleted: true,
      status: MediaStatus.AVAILABLE,
    });
    assert.strictEqual(nativeTarget?.isIndependent, false);
    assert.strictEqual(nativeTarget?.status, MediaStatus.PROCESSING);
  });

  it('returns null for legacy requests and exact placeholders for deleted TV targets', async () => {
    getSettings().sonarr = [sonarr(99, { isDefault: true })];
    const legacy = await seedRequest({ serverId: null });
    const deleted = await seedRequest({
      type: MediaType.TV,
      serverId: 44,
    });

    assert.strictEqual(
      await getRequestTargetState(
        legacy.request,
        getRepository(MediaRequest).manager
      ),
      null
    );
    assert.strictEqual(
      (
        await getRequestTargetState(
          deleted.request,
          getRepository(MediaRequest).manager
        )
      )?.name,
      'Deleted Sonarr server (#44)'
    );
  });

  it('reflects a configured server rename without retargeting to the default', async () => {
    getSettings().radarr = [
      radarr(51, { name: 'Renamed', isDefault: false }),
      radarr(52, { name: 'Current default', isDefault: true }),
    ];
    const seeded = await seedRequest({ serverId: 51 });

    const target = await getRequestTargetState(
      seeded.request,
      getRepository(MediaRequest).manager
    );

    assert.strictEqual(target?.serverId, 51);
    assert.strictEqual(target?.name, 'Renamed');
  });
});
