import ExternalAPI from '@server/api/externalapi';
import type { PlexWatchlistItem } from '@server/api/plextv';
import PlexTvAPI from '@server/api/plextv';
import {
  MediaRequestStatus,
  MediaStatus,
  MediaType,
} from '@server/constants/media';
import dataSource, { getRepository } from '@server/datasource';
import { Blocklist } from '@server/entity/Blocklist';
import Media from '@server/entity/Media';
import { MediaDestinationStatus } from '@server/entity/MediaDestinationStatus';
import {
  BlocklistedMediaError,
  DuplicateMediaRequestError,
  MediaRequest,
  NoSeasonsAvailableError,
  QuotaRestrictedError,
  RequestPermissionError,
} from '@server/entity/MediaRequest';
import { User } from '@server/entity/User';
import { UserSettings } from '@server/entity/UserSettings';
import { Permission } from '@server/lib/permissions';
import { getConfiguredRequestTargetState } from '@server/lib/requestTargetState';
import { getSettings } from '@server/lib/settings';
import watchlistSync from '@server/lib/watchlistsync';
import { setupTestDb } from '@server/test/db';
import { removalServer } from '@server/test/fixtures/destinationRemoval';
import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';

let watchlistItems: PlexWatchlistItem[] = [];

Object.defineProperty(PlexTvAPI.prototype, 'getWatchlist', {
  get() {
    return async () => ({
      offset: 0,
      size: 20,
      totalSize: watchlistItems.length,
      items: watchlistItems,
    });
  },
  set() {},
  configurable: true,
});

const realRequest = MediaRequest.request;
let useRealRequest = false;

let requestCalls: {
  mediaId: number;
  mediaType: MediaType;
  is4k?: boolean;
  serverId?: number;
}[] = [];

Object.defineProperty(MediaRequest, 'request', {
  value: async (...args: Parameters<typeof MediaRequest.request>) => {
    requestCalls.push(args[0]);
    return useRealRequest ? realRequest(...args) : ({} as MediaRequest);
  },
  writable: true,
  configurable: true,
});

setupTestDb();

async function configureSyncUser(): Promise<User> {
  const userRepository = getRepository(User);
  const admin = await userRepository.findOneOrFail({ where: { id: 1 } });

  admin.plexToken = 'test-plex-token';
  admin.permissions = Permission.AUTO_REQUEST;
  await userRepository.save(admin);

  const userSettingsRepository = getRepository(UserSettings);
  await userSettingsRepository.save(
    new UserSettings({
      user: admin,
      watchlistSyncMovies: true,
      watchlistSyncTv: true,
    })
  );

  return admin;
}

async function seedMedia(
  tmdbId: number,
  mediaType: MediaType,
  status: MediaStatus
): Promise<void> {
  const mediaRepository = getRepository(Media);
  await mediaRepository.save(
    new Media({
      tmdbId,
      mediaType,
      status,
      status4k: MediaStatus.UNKNOWN,
    })
  );
}

function movieItem(tmdbId: number, title: string): PlexWatchlistItem {
  return { ratingKey: `rk-${tmdbId}`, tmdbId, title, type: 'movie' };
}

function showItem(tmdbId: number, title: string): PlexWatchlistItem {
  return {
    ratingKey: `rk-${tmdbId}`,
    tmdbId,
    tvdbId: tmdbId * 1000,
    title,
    type: 'show',
  };
}

describe('WatchlistSync re-request gating', () => {
  beforeEach(() => {
    getSettings().radarr = [removalServer(1, false)];
    getSettings().sonarr = [removalServer(1, false)];
    useRealRequest = false;
    requestCalls = [];
    watchlistItems = [];
  });

  it('re-requests DELETED watchlist items and skips non-requestable ones', async () => {
    await configureSyncUser();

    await seedMedia(100, MediaType.MOVIE, MediaStatus.DELETED);
    await seedMedia(101, MediaType.MOVIE, MediaStatus.UNKNOWN);
    await seedMedia(102, MediaType.MOVIE, MediaStatus.AVAILABLE);
    await seedMedia(103, MediaType.MOVIE, MediaStatus.BLOCKLISTED);

    await seedMedia(200, MediaType.TV, MediaStatus.DELETED);
    await seedMedia(201, MediaType.TV, MediaStatus.AVAILABLE);

    watchlistItems = [
      movieItem(100, 'Deleted Movie'),
      movieItem(101, 'Unknown Movie'),
      movieItem(102, 'Available Movie'),
      movieItem(103, 'Blocklisted Movie'),
      showItem(200, 'Deleted Show'),
      showItem(201, 'Available Show'),
    ];

    await watchlistSync.syncWatchlist();

    const requestedArray = requestCalls.map(
      (c) => `${c.mediaType}:${c.mediaId}`
    );
    const requested = new Set(requestedArray);

    assert.strictEqual(
      requestedArray.length,
      requested.size,
      'Each item should be requested exactly once'
    );

    assert.ok(
      requested.has(`${MediaType.MOVIE}:100`),
      'DELETED movie on the watchlist should be re-requested'
    );

    assert.ok(
      requested.has(`${MediaType.MOVIE}:101`),
      'UNKNOWN movie should be requested'
    );
    assert.ok(
      !requested.has(`${MediaType.MOVIE}:102`),
      'AVAILABLE movie should NOT be requested'
    );
    assert.ok(
      !requested.has(`${MediaType.MOVIE}:103`),
      'BLOCKLISTED movie should NOT be requested'
    );

    assert.ok(
      requested.has(`${MediaType.TV}:200`),
      'DELETED show should be re-requested'
    );
    assert.ok(
      !requested.has(`${MediaType.TV}:201`),
      'AVAILABLE show should NOT be requested'
    );
  });

  it('re-requests DELETED watchlist items even when a stale auto-request exists', async () => {
    const user = await configureSyncUser();

    await seedMedia(100, MediaType.MOVIE, MediaStatus.DELETED);

    const media = await getRepository(Media).findOneOrFail({
      where: { tmdbId: 100, mediaType: MediaType.MOVIE },
    });

    await getRepository(MediaRequest).save(
      new MediaRequest({
        type: MediaType.MOVIE,
        status: MediaRequestStatus.COMPLETED,
        media,
        requestedBy: user,
        is4k: false,
        isAutoRequest: true,
      })
    );

    watchlistItems = [movieItem(100, 'Deleted Movie')];

    await watchlistSync.syncWatchlist();

    const calls = requestCalls.filter(
      (c) => c.mediaType === MediaType.MOVIE && c.mediaId === 100
    );

    assert.strictEqual(
      calls.length,
      1,
      'DELETED movie should be re-requested even when a stale auto-request exists'
    );
  });
});

describe('Watchlist destination isolation', () => {
  beforeEach(() => {
    useRealRequest = false;
    requestCalls = [];
    watchlistItems = [];
    getSettings().radarr = [
      removalServer(1),
      removalServer(2),
      removalServer(3),
    ];
    getSettings().sonarr = [removalServer(1), removalServer(2)];
  });

  it('submits exactly one Standard request without an explicit destination', async () => {
    await configureSyncUser();
    // Native availability must not hide a requestable independent destination.
    await seedMedia(300, MediaType.MOVIE, MediaStatus.AVAILABLE);
    watchlistItems = [movieItem(300, 'Dune')];
    await watchlistSync.syncWatchlist();
    assert.equal(requestCalls.length, 1);
    assert.equal(requestCalls[0].is4k, false);
    assert.equal(requestCalls[0].serverId, undefined);
  });

  for (const status of [
    MediaStatus.AVAILABLE,
    MediaStatus.PROCESSING,
    MediaStatus.UNKNOWN,
    MediaStatus.DELETED,
  ]) {
    it(`evaluates the original FR target after a default change (status=${status})`, async () => {
      const user = await configureSyncUser();
      await seedMedia(301, MediaType.MOVIE, MediaStatus.DELETED);
      const media = await getRepository(Media).findOneByOrFail({ tmdbId: 301 });
      await getRepository(MediaRequest).save(
        new MediaRequest({
          media,
          type: MediaType.MOVIE,
          requestedBy: user,
          serverId: 1,
          is4k: false,
          isAutoRequest: true,
          status: MediaRequestStatus.COMPLETED,
        })
      );
      if (status !== MediaStatus.UNKNOWN) {
        await getRepository(MediaDestinationStatus).save(
          new MediaDestinationStatus({
            mediaId: media.id,
            serverId: 1,
            status,
          })
        );
      }
      getSettings().radarr[0].isDefault = false;
      getSettings().radarr[1].isDefault = true;
      watchlistItems = [movieItem(301, 'Dune')];
      await watchlistSync.syncWatchlist();
      assert.equal(requestCalls.length, status === MediaStatus.DELETED ? 1 : 0);
      assert.equal(
        (
          await getRepository(MediaRequest).findOneByOrFail({
            media: { id: media.id },
          })
        ).serverId,
        1
      );
    });
  }

  it('preserves ambiguous deleted-server history rather than duplicating it', async () => {
    const user = await configureSyncUser();
    await seedMedia(302, MediaType.MOVIE, MediaStatus.DELETED);
    const media = await getRepository(Media).findOneByOrFail({ tmdbId: 302 });
    await getRepository(MediaRequest).save(
      new MediaRequest({
        media,
        type: MediaType.MOVIE,
        requestedBy: user,
        serverId: 999,
        is4k: false,
        isAutoRequest: true,
        status: MediaRequestStatus.COMPLETED,
      })
    );
    watchlistItems = [movieItem(302, 'Dune')];
    await watchlistSync.syncWatchlist();
    assert.equal(requestCalls.length, 0);
  });

  it('skips authoritative Blocklist membership even after native status changes', async () => {
    await configureSyncUser();
    await Blocklist.addToBlocklist({
      blocklistRequest: { tmdbId: 303, mediaType: MediaType.MOVIE },
    });
    await getRepository(Media).update(
      { tmdbId: 303 },
      { status: MediaStatus.UNKNOWN }
    );
    watchlistItems = [movieItem(303, 'Dune')];
    await watchlistSync.syncWatchlist();
    assert.equal(requestCalls.length, 0);
  });

  it('retains per-type Watchlist settings and permissions', async () => {
    const user = await configureSyncUser();
    await getRepository(User).update(user.id, {
      permissions: Permission.AUTO_REQUEST_MOVIE,
    });
    watchlistItems = [showItem(304, 'Show'), movieItem(305, 'Movie')];
    await watchlistSync.syncWatchlist();
    assert.deepEqual(
      requestCalls.map((c) => c.mediaId),
      [305]
    );
    await getRepository(UserSettings).update(
      { user: { id: user.id } },
      { watchlistSyncMovies: false }
    );
    useRealRequest = false;
    requestCalls = [];
    await watchlistSync.syncWatchlist();
    assert.equal(requestCalls.length, 0);
  });
});

describe('PR8 Watchlist integration', () => {
  for (const independent of [false, true]) {
    it(`creates only one real Standard request on the default (independent=${independent})`, async (t) => {
      requestCalls = [];
      useRealRequest = true;
      t.after(() => {
        useRealRequest = false;
      });
      const user = await configureSyncUser();
      await getRepository(User).update(user.id, {
        permissions: Permission.AUTO_REQUEST | Permission.REQUEST,
      });
      getSettings().radarr = [
        removalServer(1, independent),
        removalServer(2),
        removalServer(3),
      ];
      t.mock.method(
        ExternalAPI.prototype as unknown as {
          get: (endpoint: string) => Promise<unknown>;
        },
        'get',
        async () => ({
          id: 88001,
          external_ids: {},
          videos: { results: [{ type: 'Trailer', key: 'trailer' }] },
        })
      );
      watchlistItems = [movieItem(88001, 'Dune')];
      await watchlistSync.syncWatchlist();
      const requests = await getRepository(MediaRequest).find();
      assert.equal(requestCalls.length, 1);
      assert.equal(requests.length, 1);
      assert.equal(requests[0].serverId, 1);
      assert.equal(requests[0].is4k, false);
      assert.equal(requests[0].isAutoRequest, true);
      await watchlistSync.syncWatchlist();
      assert.equal(await getRepository(MediaRequest).count(), 1);
    });
  }

  it('preserves FR/EN/DE states and auto-request history through block, unblock and sync', async () => {
    const user = await configureSyncUser();
    requestCalls = [];
    useRealRequest = false;
    getSettings().radarr = [
      removalServer(1),
      removalServer(2),
      removalServer(3),
    ];
    const media = await getRepository(Media).save(
      new Media({
        tmdbId: 88002,
        mediaType: MediaType.MOVIE,
        status: MediaStatus.UNKNOWN,
      })
    );
    const states = await getRepository(MediaDestinationStatus).save(
      [MediaStatus.AVAILABLE, MediaStatus.PROCESSING, MediaStatus.UNKNOWN].map(
        (status, i) =>
          new MediaDestinationStatus({
            mediaId: media.id,
            serverId: i + 1,
            status,
          })
      )
    );
    const previous = await getRepository(MediaRequest).save(
      new MediaRequest({
        media,
        type: MediaType.MOVIE,
        serverId: 1,
        is4k: false,
        requestedBy: user,
        isAutoRequest: true,
        status: MediaRequestStatus.COMPLETED,
      })
    );
    await Blocklist.addToBlocklist({
      blocklistRequest: { tmdbId: media.tmdbId, mediaType: MediaType.MOVIE },
    });
    for (const server of getSettings().radarr) {
      const target = getConfiguredRequestTargetState({
        server,
        destinationStatus: states.find((d) => d.serverId === server.id)?.status,
        isBlocklisted: await getRepository(Blocklist).exists({
          where: { tmdbId: media.tmdbId, mediaType: MediaType.MOVIE },
        }),
      });
      assert.equal(target.requestable, false);
    }
    await dataSource.transaction(async (em) => {
      const entry = await em
        .getRepository(Blocklist)
        .findOneByOrFail({ tmdbId: media.tmdbId, mediaType: MediaType.MOVIE });
      await Blocklist.removeFromBlocklist(entry, em);
    });
    assert.equal(
      await getRepository(Media).exists({ where: { id: media.id } }),
      true
    );
    assert.deepEqual(
      await getRepository(MediaDestinationStatus).find({
        order: { serverId: 'ASC' },
      }),
      states
    );
    getSettings().radarr[0].isDefault = false;
    getSettings().radarr[1].isDefault = true;
    watchlistItems = [movieItem(media.tmdbId, 'Dune')];
    await watchlistSync.syncWatchlist();
    assert.equal(requestCalls.length, 0);
    const retained = await getRepository(MediaRequest).findOneByOrFail({
      id: previous.id,
    });
    assert.equal(retained.serverId, 1);
    assert.equal(retained.status, MediaRequestStatus.COMPLETED);
    assert.equal(await getRepository(MediaRequest).count(), 1);
  });
});

describe('PR8 Watchlist exception compatibility', () => {
  for (const ErrorType of [
    RequestPermissionError,
    QuotaRestrictedError,
    NoSeasonsAvailableError,
    DuplicateMediaRequestError,
    BlocklistedMediaError,
  ]) {
    it(`handles ${ErrorType.name} and continues syncing`, async (t) => {
      await configureSyncUser();
      getSettings().radarr = [removalServer(1)];
      watchlistItems = [
        movieItem(89001, 'Restricted'),
        movieItem(89002, 'Next'),
      ];
      let calls = 0;
      t.mock.method(MediaRequest, 'request', async () => {
        if (++calls === 1) throw new ErrorType('native restriction');
        return {} as MediaRequest;
      });
      await watchlistSync.syncWatchlist();
      assert.equal(calls, 2);
    });
  }
});
