import assert from 'node:assert/strict';
import type { TestContext } from 'node:test';
import { beforeEach, describe, it, mock } from 'node:test';

import type { RadarrMovie } from '@server/api/servarr/radarr';
import RadarrAPI from '@server/api/servarr/radarr';
import type { SonarrSeries } from '@server/api/servarr/sonarr';
import SonarrAPI from '@server/api/servarr/sonarr';
import TheMovieDb from '@server/api/themoviedb';
import {
  MediaRequestStatus,
  MediaStatus,
  MediaType,
} from '@server/constants/media';
import { getRepository } from '@server/datasource';
import Media from '@server/entity/Media';
import { MediaDestinationSeasonStatus } from '@server/entity/MediaDestinationSeasonStatus';
import { MediaDestinationStatus } from '@server/entity/MediaDestinationStatus';
import { MediaRequest } from '@server/entity/MediaRequest';
import Season from '@server/entity/Season';
import SeasonRequest from '@server/entity/SeasonRequest';
import { User } from '@server/entity/User';
import notificationManager from '@server/lib/notifications';
import { Permission } from '@server/lib/permissions';
import type { RadarrSettings, SonarrSettings } from '@server/lib/settings';
import { getSettings } from '@server/lib/settings';
import mediaRoutes from '@server/routes/media';
import { MediaRequestSubscriber } from '@server/subscriber/MediaRequestSubscriber';
import { setupTestDb } from '@server/test/db';
import * as destinationOperations from '@server/utils/destinationOperationLock';
import { withDestinationOperationLock } from '@server/utils/destinationOperationLock';
import express from 'express';
import httpRequest from 'supertest';
import type { EntityManager } from 'typeorm';

const sendNotificationMock = mock.method(
  MediaRequest,
  'sendNotification',
  async () => undefined
);

let getMovieOverride:
  | ((args: { movieId: number }) => Promise<unknown>)
  | undefined;
let getTvShowOverride:
  | ((args: { tvId: number }) => Promise<unknown>)
  | undefined;

Object.defineProperty(TheMovieDb.prototype, 'getMovie', {
  get() {
    return (
      getMovieOverride ??
      (async ({ movieId }: { movieId: number }) => ({
        id: movieId,
        title: `Movie ${movieId}`,
        release_date: '2025-01-01',
        external_ids: {},
        keywords: { keywords: [] },
        genres: [],
      }))
    );
  },
  set() {},
  configurable: true,
});

Object.defineProperty(TheMovieDb.prototype, 'getTvShow', {
  get() {
    return (
      getTvShowOverride ??
      (async ({ tvId }: { tvId: number }) => ({
        id: tvId,
        name: `Series ${tvId}`,
        external_ids: { tvdb_id: tvId + 1000 },
        keywords: { results: [] },
        genres: [],
        seasons: [{ season_number: 1, episode_count: 8 }],
      }))
    );
  },
  set() {},
  configurable: true,
});

const radarrMovie = (id: number, titleSlug: string) =>
  ({ id, titleSlug, hasFile: true }) as RadarrMovie;

type DestinationLinkGuard = (
  requestId: number,
  mediaId: number,
  serverId: number,
  externalServiceId: number | null,
  externalServiceSlug: string,
  manager: EntityManager
) => Promise<MediaDestinationStatus | null>;

type FailureGuard = (
  requestId: number,
  manager: EntityManager,
  currentEntity?: MediaRequest
) => Promise<MediaRequest | null>;

type DestinationSeasonGuard = (
  requestId: number,
  destinationStatusId: number,
  seasonNumbers: number[],
  manager: EntityManager
) => Promise<boolean>;

type NativeLinkGuard = (
  entity: MediaRequest,
  serverId: number,
  externalServiceId: number | null,
  externalServiceSlug: string,
  manager: EntityManager
) => Promise<boolean>;

type ApprovedSuccessGuard = (
  requestId: number,
  manager: EntityManager,
  mutation: (manager: EntityManager) => Promise<boolean>
) => Promise<boolean>;

setupTestDb();

beforeEach(() => {
  sendNotificationMock.mock.resetCalls();
  getMovieOverride = undefined;
  getTvShowOverride = undefined;
  getSettings().radarr = [
    {
      id: 101,
      name: 'French Radarr',
      hostname: 'radarr-fr',
      port: 7878,
      apiKey: 'test',
      useSsl: false,
      activeProfileId: 1,
      activeDirectory: '/movies',
      tags: [],
      is4k: false,
      isDefault: true,
      syncEnabled: true,
      independentRequestDestination: true,
      preventSearch: false,
      tagRequests: false,
      overrideRule: [],
      minimumAvailability: 'released',
    },
    {
      id: 102,
      name: 'English Radarr',
      hostname: 'radarr-en',
      port: 7878,
      apiKey: 'test',
      useSsl: false,
      activeProfileId: 1,
      activeDirectory: '/movies',
      tags: [],
      is4k: false,
      isDefault: false,
      syncEnabled: true,
      independentRequestDestination: true,
      preventSearch: false,
      tagRequests: false,
      overrideRule: [],
      minimumAvailability: 'released',
    },
  ] as unknown as RadarrSettings[];
  getSettings().sonarr = [
    {
      id: 201,
      name: 'French Sonarr',
      hostname: 'sonarr-fr',
      port: 8989,
      apiKey: 'test',
      useSsl: false,
      activeProfileId: 1,
      activeDirectory: '/tv',
      activeLanguageProfileId: 1,
      tags: [],
      animeTags: [],
      is4k: false,
      isDefault: true,
      syncEnabled: true,
      independentRequestDestination: true,
      preventSearch: false,
      tagRequests: false,
      overrideRule: [],
      seriesType: 'standard',
      animeSeriesType: 'anime',
      enableSeasonFolders: true,
      monitorNewItems: 'all',
    },
    {
      id: 202,
      name: 'English Sonarr',
      hostname: 'sonarr-en',
      port: 8989,
      apiKey: 'test',
      useSsl: false,
      activeProfileId: 1,
      activeDirectory: '/tv',
      activeLanguageProfileId: 1,
      tags: [],
      animeTags: [],
      is4k: false,
      isDefault: false,
      syncEnabled: true,
      independentRequestDestination: true,
      preventSearch: false,
      tagRequests: false,
      overrideRule: [],
      seriesType: 'standard',
      animeSeriesType: 'anime',
      enableSeasonFolders: true,
      monitorNewItems: 'all',
    },
  ] as unknown as SonarrSettings[];
});

const configureMixedServers = () => {
  getSettings().radarr[0].independentRequestDestination = false;
  getSettings().sonarr[0].independentRequestDestination = false;
};

const flushCallbacks = async () => {
  await new Promise<void>((resolve) => setImmediate(resolve));
  await new Promise<void>((resolve) => setImmediate(resolve));
};

const waitFor = async (predicate: () => Promise<boolean>) => {
  for (let attempt = 0; attempt < 50; attempt++) {
    if (await predicate()) {
      return;
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('Timed out waiting for asynchronous subscriber work.');
};

async function requester() {
  return getRepository(User).findOneOrFail({
    where: { email: 'demo@seerr.dev' },
  });
}

async function seedMovieRequest(serverId = 102) {
  const media = await getRepository(Media).save(
    new Media({
      mediaType: MediaType.MOVIE,
      tmdbId: 92001,
      status: MediaStatus.AVAILABLE,
      status4k: MediaStatus.UNKNOWN,
    })
  );
  return getRepository(MediaRequest).save(
    new MediaRequest({
      type: MediaType.MOVIE,
      status: MediaRequestStatus.PENDING,
      media,
      requestedBy: await requester(),
      is4k: false,
      serverId,
    })
  );
}

async function seedTvRequest(serverId = 202) {
  const media = await getRepository(Media).save(
    new Media({
      mediaType: MediaType.TV,
      tmdbId: 93001,
      tvdbId: 94001,
      status: MediaStatus.AVAILABLE,
      status4k: MediaStatus.UNKNOWN,
    })
  );
  return getRepository(MediaRequest).save(
    new MediaRequest({
      type: MediaType.TV,
      status: MediaRequestStatus.PENDING,
      media,
      requestedBy: await requester(),
      is4k: false,
      serverId,
      seasons: [
        new SeasonRequest({
          seasonNumber: 1,
          status: MediaRequestStatus.PENDING,
        }),
      ],
    })
  );
}

async function markApprovedWithoutListeners(request: MediaRequest) {
  await getRepository(MediaRequest)
    .createQueryBuilder()
    .update(MediaRequest)
    .set({ status: MediaRequestStatus.APPROVED })
    .where('id = :id', { id: request.id })
    .callListeners(false)
    .execute();
  request.status = MediaRequestStatus.APPROVED;
}

const removalApp = (admin: User) => {
  const app = express();
  app.use((req, _res, next) => {
    req.user = admin;
    next();
  });
  app.use('/media', mediaRoutes);
  return app;
};

// Intercept constructor assignments to arrow methods while keeping each
// override local to its test, as with the existing TMDB stubs above.
const stubArrArrowMethod = (
  t: TestContext,
  target: object,
  name: string,
  implementation: () => Promise<unknown>
) => {
  const descriptor = Object.getOwnPropertyDescriptor(target, name);
  const fn = t.mock.fn(implementation);
  Object.defineProperty(target, name, {
    get: () => fn,
    set() {},
    configurable: true,
  });
  t.after(() => {
    if (descriptor) Object.defineProperty(target, name, descriptor);
    else Reflect.deleteProperty(target, name);
  });
  return fn;
};

describe('independent Arr addition and removal coordination', () => {
  it('starts detached Arr work after commit and cancels work from a rolled-back savepoint', async () => {
    const req = await seedMovieRequest();
    await markApprovedWithoutListeners(req);
    const manager = getRepository(MediaRequest).manager;
    const subscriber = manager.connection.subscribers.find(
      (entry) => entry instanceof MediaRequestSubscriber
    ) as MediaRequestSubscriber;
    const internals = subscriber as unknown as {
      runIndependentArrOperation: (
        entity: MediaRequest,
        serverId: number,
        manager: EntityManager,
        send: () => Promise<void>
      ) => Promise<void>;
    };
    const outerSend = mock.fn(async () => undefined);
    const innerSend = mock.fn(async () => undefined);
    let outer!: Promise<void>;
    let inner!: Promise<void>;
    await manager.transaction(async (tx) => {
      outer = internals.runIndependentArrOperation(
        req,
        req.serverId,
        tx,
        outerSend
      );
      await assert.rejects(
        tx.transaction(async (savepoint) => {
          inner = internals.runIndependentArrOperation(
            req,
            req.serverId,
            savepoint,
            innerSend
          );
          throw new Error('savepoint rollback');
        }),
        /savepoint rollback/
      );
      await inner;
      assert.equal(outerSend.mock.callCount(), 0);
      assert.equal(innerSend.mock.callCount(), 0);
    });
    await outer;
    assert.equal(outerSend.mock.callCount(), 1);
    assert.equal(innerSend.mock.callCount(), 0);
  });

  it('keeps work from a committed savepoint pending until the outer transaction commits', async () => {
    const req = await seedMovieRequest();
    await markApprovedWithoutListeners(req);
    const manager = getRepository(MediaRequest).manager;
    const subscriber = manager.connection.subscribers.find(
      (entry) => entry instanceof MediaRequestSubscriber
    ) as MediaRequestSubscriber;
    const internals = subscriber as unknown as {
      runIndependentArrOperation: (
        entity: MediaRequest,
        serverId: number,
        manager: EntityManager,
        send: () => Promise<void>
      ) => Promise<void>;
    };
    const send = mock.fn(async () => undefined);
    let operation!: Promise<void>;
    await assert.rejects(
      manager.transaction(async (tx) => {
        await tx.transaction(async (savepoint) => {
          operation = internals.runIndependentArrOperation(
            req,
            req.serverId,
            savepoint,
            send
          );
        });
        assert.equal(send.mock.callCount(), 0);
        throw new Error('outer rollback');
      }),
      /outer rollback/
    );
    await operation;
    assert.equal(send.mock.callCount(), 0);
  });

  for (const type of [MediaType.MOVIE, MediaType.TV]) {
    it(`waits for in-flight ${type} addition, including its callback, without blocking another destination`, async (t) => {
      const req =
        type === MediaType.MOVIE
          ? await seedMovieRequest()
          : await seedTvRequest();
      const repo = getRepository(MediaRequest);
      await markApprovedWithoutListeners(req);
      const subscriber = new MediaRequestSubscriber();
      let started!: () => void;
      const remoteStarted = new Promise<void>((resolve) => {
        started = resolve;
      });
      let release!: () => void;
      const remoteRelease = new Promise<void>((resolve) => {
        release = resolve;
      });
      let otherStarted!: () => void;
      const otherRemoteStarted = new Promise<void>((resolve) => {
        otherStarted = resolve;
      });
      let calls = 0;
      let present = false;
      let removalStarted = false;
      const add = async () => {
        if (++calls === 1) {
          started();
          await remoteRelease;
          present = true;
        } else otherStarted();
        return { id: 7007, titleSlug: 'added' };
      };
      if (type === MediaType.MOVIE)
        stubArrArrowMethod(
          t,
          RadarrAPI.prototype,
          'addMovie',
          async () => (await add()) as RadarrMovie
        );
      else
        t.mock.method(
          SonarrAPI.prototype,
          'addSeries',
          async () => (await add()) as SonarrSeries
        );
      const send = (entity: MediaRequest) =>
        type === MediaType.MOVIE
          ? subscriber.sendToRadarr(entity, repo.manager)
          : subscriber.sendToSonarr(entity, repo.manager);
      await send(req);
      await remoteStarted;
      let queued!: () => void;
      const removalQueued = new Promise<void>((resolve) => {
        queued = resolve;
      });
      const originalLock = destinationOperations.withDestinationOperationLock;
      t.mock.method(
        destinationOperations,
        'withDestinationOperationLock',
        (...args: Parameters<typeof originalLock>) => {
          if (
            args[0] === type &&
            args[1] === req.media.tmdbId &&
            args[2] === req.serverId
          )
            queued();
          return originalLock(...args);
        }
      );
      const remove = async () => {
        removalStarted = true;
        assert.equal(present, true);
        assert.equal(
          (
            await getRepository(MediaDestinationStatus).findOneByOrFail({
              mediaId: req.media.id,
              serverId: req.serverId,
            })
          ).externalServiceId,
          7007
        );
        present = false;
      };
      if (type === MediaType.MOVIE)
        stubArrArrowMethod(
          t,
          RadarrAPI.prototype,
          'removeMovieFromDestination',
          remove
        );
      else
        stubArrArrowMethod(
          t,
          SonarrAPI.prototype,
          'removeSeriesFromDestination',
          remove
        );
      const app = removalApp(
        await getRepository(User).findOneByOrFail({ id: 1 })
      );
      const removing = httpRequest(app)
        .delete(`/media/${req.media.id}/file?serverId=${req.serverId}`)
        .then((response) => response);
      await removalQueued;
      assert.equal(removalStarted, false);
      const other = await repo.save(
        new MediaRequest({
          media: req.media,
          type,
          serverId: req.serverId - 1,
          is4k: false,
          requestedBy: req.requestedBy,
          status: MediaRequestStatus.PENDING,
          seasons:
            type === MediaType.TV
              ? [
                  new SeasonRequest({
                    seasonNumber: 1,
                    status: MediaRequestStatus.PENDING,
                  }),
                ]
              : [],
        })
      );
      await markApprovedWithoutListeners(other);
      try {
        await send(other);
        await otherRemoteStarted;
        await withDestinationOperationLock(
          type,
          req.media.tmdbId,
          other.serverId,
          async () => undefined
        );
        assert.equal(removalStarted, false);
        await withDestinationOperationLock(
          type,
          req.media.tmdbId + 1,
          req.serverId,
          async () => undefined
        );
      } finally {
        release();
      }
      assert.equal((await removing).status, 204);
      assert.equal(present, false);
      const exact = await getRepository(MediaDestinationStatus).findOneByOrFail(
        { mediaId: req.media.id, serverId: req.serverId }
      );
      assert.equal(exact.status, MediaStatus.DELETED);
      assert.equal(exact.externalServiceId, null);
      assert.equal(exact.externalServiceSlug, null);
      assert.equal(
        (await repo.findOneByOrFail({ id: req.id })).status,
        MediaRequestStatus.DECLINED
      );
      assert.equal(
        (await repo.findOneByOrFail({ id: other.id })).status,
        MediaRequestStatus.APPROVED
      );
      assert.equal(
        (await getRepository(Media).findOneByOrFail({ id: req.media.id }))
          .status,
        MediaStatus.AVAILABLE
      );
      if (type === MediaType.TV)
        assert.ok(
          (
            await getRepository(MediaDestinationSeasonStatus).findBy({
              destinationStatusId: exact.id,
            })
          ).every((season) => season.status === MediaStatus.DELETED)
        );
    });

    it(`skips a queued ${type} addition after removal declines the request`, async (t) => {
      const req =
        type === MediaType.MOVIE
          ? await seedMovieRequest()
          : await seedTvRequest();
      const repo = getRepository(MediaRequest);
      await markApprovedWithoutListeners(req);
      const subscriber = new MediaRequestSubscriber();
      let locked!: () => void;
      const lockReady = new Promise<void>((resolve) => {
        locked = resolve;
      });
      let release!: () => void;
      const removalReady = new Promise<void>((resolve) => {
        release = resolve;
      });
      const remove = async () => {
        locked();
        await removalReady;
      };
      if (type === MediaType.MOVIE)
        stubArrArrowMethod(
          t,
          RadarrAPI.prototype,
          'removeMovieFromDestination',
          remove
        );
      else
        stubArrArrowMethod(
          t,
          SonarrAPI.prototype,
          'removeSeriesFromDestination',
          remove
        );
      const app = removalApp(
        await getRepository(User).findOneByOrFail({ id: 1 })
      );
      const removing = httpRequest(app)
        .delete(`/media/${req.media.id}/file?serverId=${req.serverId}`)
        .then((response) => response);
      await lockReady;
      let finished!: () => void;
      const additionFinished = new Promise<void>((resolve) => {
        finished = resolve;
      });
      const internals = subscriber as unknown as {
        runIndependentArrOperation: (
          ...args: [MediaRequest, number, EntityManager, () => Promise<void>]
        ) => Promise<void>;
      };
      const original = internals.runIndependentArrOperation.bind(subscriber);
      t.mock.method(
        internals,
        'runIndependentArrOperation',
        async (...args: Parameters<typeof original>) => {
          try {
            await original(...args);
          } finally {
            finished();
          }
        }
      );
      const addMovie = stubArrArrowMethod(
        t,
        RadarrAPI.prototype,
        'addMovie',
        async () => radarrMovie(7008, 'obsolete')
      );
      const addSeries = t.mock.method(
        SonarrAPI.prototype,
        'addSeries',
        async () => ({ id: 7008, titleSlug: 'obsolete' }) as SonarrSeries
      );
      try {
        if (type === MediaType.MOVIE)
          await subscriber.sendToRadarr(req, repo.manager);
        else await subscriber.sendToSonarr(req, repo.manager);
      } finally {
        release();
      }
      assert.equal((await removing).status, 204);
      await additionFinished;
      assert.equal(addMovie.mock.callCount(), 0);
      assert.equal(addSeries.mock.callCount(), 0);
      const exact = await getRepository(MediaDestinationStatus).findOneByOrFail(
        { mediaId: req.media.id, serverId: req.serverId }
      );
      assert.equal(exact.status, MediaStatus.DELETED);
      assert.equal(exact.externalServiceId, null);
      assert.equal(exact.externalServiceSlug, null);
      assert.equal(
        (await repo.findOneByOrFail({ id: req.id })).status,
        MediaRequestStatus.DECLINED
      );
      const freshRequest = await repo.save(
        new MediaRequest({
          media: req.media,
          type,
          serverId: req.serverId,
          is4k: false,
          requestedBy: req.requestedBy,
          status: MediaRequestStatus.APPROVED,
          seasons:
            type === MediaType.TV
              ? [
                  new SeasonRequest({
                    seasonNumber: 1,
                    status: MediaRequestStatus.APPROVED,
                  }),
                ]
              : [],
        })
      );
      await withDestinationOperationLock(
        type,
        req.media.tmdbId,
        req.serverId,
        async () => undefined
      );
      assert.equal(
        type === MediaType.MOVIE
          ? addMovie.mock.callCount()
          : addSeries.mock.callCount(),
        1
      );
      assert.equal(
        (await repo.findOneByOrFail({ id: freshRequest.id })).status,
        MediaRequestStatus.APPROVED
      );
      const rediscovered = await getRepository(
        MediaDestinationStatus
      ).findOneByOrFail({ mediaId: req.media.id, serverId: req.serverId });
      assert.equal(rediscovered.status, MediaStatus.PROCESSING);
      assert.equal(rediscovered.externalServiceId, 7008);
      assert.equal(
        (await repo.findOneByOrFail({ id: req.id })).status,
        MediaRequestStatus.DECLINED
      );
    });
  }
});

describe('MediaRequestSubscriber request destinations', () => {
  it('rolls back independent creation when destination preparation fails', async (t) => {
    const subscriberInternals = MediaRequestSubscriber.prototype as unknown as {
      prepareIndependentDestination: () => Promise<void>;
    };
    t.mock.method(
      subscriberInternals,
      'prepareIndependentDestination',
      async () => {
        throw new Error('Destination preparation failed');
      }
    );
    const sendToRadarr = t.mock.method(
      MediaRequestSubscriber.prototype,
      'sendToRadarr',
      async () => undefined
    );
    const sendToSonarr = t.mock.method(
      MediaRequestSubscriber.prototype,
      'sendToSonarr',
      async () => undefined
    );

    await assert.rejects(
      MediaRequest.request(
        {
          mediaType: MediaType.TV,
          mediaId: 93004,
          serverId: 202,
          seasons: [1],
        },
        await requester()
      ),
      /preparation failed/i
    );

    assert.strictEqual(sendToRadarr.mock.callCount(), 0);
    assert.strictEqual(sendToSonarr.mock.callCount(), 0);
    assert.strictEqual(sendNotificationMock.mock.callCount(), 0);
    const media = await getRepository(Media).findOne({
      where: { tmdbId: 93004, mediaType: MediaType.TV },
    });
    assert.strictEqual(
      await getRepository(MediaRequest).count({
        where: { media: { id: media?.id ?? 0 } },
      }),
      0
    );
    assert.strictEqual(
      await getRepository(MediaDestinationStatus).count({
        where: { mediaId: media?.id ?? 0, serverId: 202 },
      }),
      0
    );
    assert.strictEqual(await getRepository(SeasonRequest).count(), 0);
    assert.strictEqual(
      await getRepository(MediaDestinationSeasonStatus).count(),
      0
    );
  });

  it('rolls back independent approval when destination preparation fails', async (t) => {
    const requestRepository = getRepository(MediaRequest);
    const request = await seedTvRequest();
    const originalSeasonIds = request.seasons.map((season) => season.id);
    t.mock.method(
      MediaRequestSubscriber.prototype,
      'updateParentStatus',
      async () => {
        throw new Error('Destination preparation failed');
      }
    );
    const sendToSonarr = t.mock.method(
      MediaRequestSubscriber.prototype,
      'sendToSonarr',
      async () => undefined
    );
    sendNotificationMock.mock.resetCalls();

    request.status = MediaRequestStatus.APPROVED;
    await assert.rejects(
      requestRepository.save(request),
      /preparation failed/i
    );

    const persisted = await requestRepository.findOneOrFail({
      where: { id: request.id },
    });
    assert.strictEqual(persisted.status, MediaRequestStatus.PENDING);
    assert.deepStrictEqual(
      persisted.seasons.map((season) => season.id),
      originalSeasonIds
    );
    assert.ok(
      persisted.seasons.every(
        (season) => season.status === MediaRequestStatus.PENDING
      )
    );
    assert.strictEqual(sendToSonarr.mock.callCount(), 0);
    assert.strictEqual(sendNotificationMock.mock.callCount(), 0);
  });

  it('creates auto-approved independent TV seasons exactly once', async (t) => {
    const requestUser = await requester();
    requestUser.permissions = Permission.REQUEST | Permission.AUTO_APPROVE;
    await getRepository(User).save(requestUser);
    let destinationPreparedAtDispatch = false;
    const sendToSonarr = t.mock.method(
      MediaRequestSubscriber.prototype,
      'sendToSonarr',
      async (request: MediaRequest) => {
        const destination = await getRepository(MediaDestinationStatus).findOne(
          {
            where: { mediaId: request.media.id, serverId: 202 },
          }
        );
        destinationPreparedAtDispatch =
          destination !== null &&
          (await getRepository(MediaDestinationSeasonStatus).count({
            where: { destinationStatusId: destination.id },
          })) === 2;
      }
    );

    const created = await MediaRequest.request(
      {
        mediaType: MediaType.TV,
        mediaId: 93005,
        serverId: 202,
        seasons: [1, 2],
      },
      requestUser
    );
    const persisted = await getRepository(MediaRequest).findOneOrFail({
      where: { id: created.id },
    });
    const seasonRows = await getRepository(SeasonRequest).find({
      where: { request: { id: created.id } },
    });
    const destination = await getRepository(
      MediaDestinationStatus
    ).findOneOrFail({
      where: { mediaId: created.media.id, serverId: 202 },
    });
    const destinationSeasons = await getRepository(
      MediaDestinationSeasonStatus
    ).find({
      where: { destinationStatusId: destination.id },
    });

    assert.strictEqual(persisted.status, MediaRequestStatus.APPROVED);
    assert.strictEqual(seasonRows.length, 2);
    assert.deepStrictEqual(
      seasonRows
        .map((season) => season.seasonNumber)
        .sort((left, right) => left - right),
      [1, 2]
    );
    assert.ok(
      seasonRows.every(
        (season) => season.status === MediaRequestStatus.APPROVED
      )
    );
    assert.strictEqual(destination.status, MediaStatus.PENDING);
    assert.strictEqual(destinationSeasons.length, 2);
    assert.deepStrictEqual(
      destinationSeasons
        .map((season) => season.seasonNumber)
        .sort((left, right) => left - right),
      [1, 2]
    );
    assert.ok(
      destinationSeasons.every(
        (season) => season.status === MediaStatus.PENDING
      )
    );
    assert.strictEqual(sendToSonarr.mock.callCount(), 1);
    assert.strictEqual(destinationPreparedAtDispatch, true);
  });

  it('creates pending independent TV seasons exactly once', async () => {
    const requestUser = await requester();
    requestUser.permissions = Permission.REQUEST;
    await getRepository(User).save(requestUser);

    const created = await MediaRequest.request(
      {
        mediaType: MediaType.TV,
        mediaId: 93006,
        serverId: 202,
        seasons: [1, 2],
      },
      requestUser
    );
    const seasonRows = await getRepository(SeasonRequest).find({
      where: { request: { id: created.id } },
    });
    const destination = await getRepository(
      MediaDestinationStatus
    ).findOneOrFail({
      where: { mediaId: created.media.id, serverId: 202 },
    });
    const destinationSeasons = await getRepository(
      MediaDestinationSeasonStatus
    ).find({
      where: { destinationStatusId: destination.id },
    });

    assert.strictEqual(created.status, MediaRequestStatus.PENDING);
    assert.strictEqual(seasonRows.length, 2);
    assert.deepStrictEqual(
      seasonRows
        .map((season) => season.seasonNumber)
        .sort((left, right) => left - right),
      [1, 2]
    );
    assert.ok(
      seasonRows.every((season) => season.status === MediaRequestStatus.PENDING)
    );
    assert.strictEqual(destination.status, MediaStatus.PENDING);
    assert.strictEqual(destinationSeasons.length, 2);
  });

  it('approves existing independent TV seasons without reinserting them', async (t) => {
    const requestRepository = getRepository(MediaRequest);
    const request = await seedTvRequest();
    const originalSeasonIds = request.seasons.map((season) => season.id);
    const sendToSonarr = t.mock.method(
      MediaRequestSubscriber.prototype,
      'sendToSonarr',
      async () => undefined
    );

    request.status = MediaRequestStatus.APPROVED;
    await requestRepository.save(request);

    const persisted = await requestRepository.findOneOrFail({
      where: { id: request.id },
    });
    const destination = await getRepository(
      MediaDestinationStatus
    ).findOneOrFail({
      where: { mediaId: request.media.id, serverId: 202 },
    });
    const destinationSeasons = await getRepository(
      MediaDestinationSeasonStatus
    ).find({
      where: { destinationStatusId: destination.id },
    });

    assert.strictEqual(persisted.status, MediaRequestStatus.APPROVED);
    assert.deepStrictEqual(
      persisted.seasons.map((season) => season.id),
      originalSeasonIds
    );
    assert.ok(
      persisted.seasons.every(
        (season) => season.status === MediaRequestStatus.APPROVED
      )
    );
    assert.strictEqual(
      await getRepository(SeasonRequest).count({
        where: { request: { id: request.id } },
      }),
      originalSeasonIds.length
    );
    assert.strictEqual(destination.status, MediaStatus.PENDING);
    assert.strictEqual(destinationSeasons.length, 1);
    assert.strictEqual(sendToSonarr.mock.callCount(), 1);
  });

  it('does not leave native movie state processing after an early Radarr failure', async () => {
    configureMixedServers();
    const mediaRepository = getRepository(Media);
    const requestRepository = getRepository(MediaRequest);
    const media = await mediaRepository.save(
      new Media({
        mediaType: MediaType.MOVIE,
        tmdbId: 92003,
        status: MediaStatus.PENDING,
        status4k: MediaStatus.UNKNOWN,
      })
    );
    const request = await requestRepository.save(
      new MediaRequest({
        type: MediaType.MOVIE,
        status: MediaRequestStatus.PENDING,
        media,
        requestedBy: await requester(),
        is4k: false,
        serverId: 101,
      })
    );
    getMovieOverride = async () => {
      throw new Error('TMDB movie unavailable');
    };

    request.status = MediaRequestStatus.APPROVED;
    const savedRequest = await requestRepository.save(request);

    const persistedRequest = await requestRepository.findOneOrFail({
      where: { id: request.id },
    });
    const persistedMedia = await mediaRepository.findOneOrFail({
      where: { id: media.id },
    });
    assert.strictEqual(persistedRequest.status, MediaRequestStatus.FAILED);
    assert.strictEqual(savedRequest.status, MediaRequestStatus.FAILED);
    assert.strictEqual(persistedMedia.status, MediaStatus.PENDING);
  });

  it('does not promote native TV state after an early Sonarr failure', async () => {
    configureMixedServers();
    const mediaRepository = getRepository(Media);
    const requestRepository = getRepository(MediaRequest);
    const media = await mediaRepository.save(
      new Media({
        mediaType: MediaType.TV,
        tmdbId: 93003,
        tvdbId: 94003,
        status: MediaStatus.PENDING,
        status4k: MediaStatus.UNKNOWN,
        seasons: [
          new Season({
            seasonNumber: 1,
            status: MediaStatus.PENDING,
            status4k: MediaStatus.UNKNOWN,
          }),
        ],
      })
    );
    const request = await requestRepository.save(
      new MediaRequest({
        type: MediaType.TV,
        status: MediaRequestStatus.PENDING,
        media,
        requestedBy: await requester(),
        is4k: false,
        serverId: 201,
        seasons: [
          new SeasonRequest({
            seasonNumber: 1,
            status: MediaRequestStatus.PENDING,
          }),
        ],
      })
    );
    getTvShowOverride = async () => {
      throw new Error('TMDB series unavailable');
    };

    request.status = MediaRequestStatus.APPROVED;
    const savedRequest = await requestRepository.save(request);

    const persistedRequest = await requestRepository.findOneOrFail({
      where: { id: request.id },
    });
    const persistedMedia = await mediaRepository.findOneOrFail({
      where: { id: media.id },
    });
    assert.strictEqual(persistedRequest.status, MediaRequestStatus.FAILED);
    assert.strictEqual(savedRequest.status, MediaRequestStatus.FAILED);
    assert.strictEqual(
      persistedRequest.seasons[0].status,
      MediaRequestStatus.PENDING
    );
    assert.strictEqual(persistedMedia.status, MediaStatus.PENDING);
    assert.strictEqual(persistedMedia.seasons[0].status, MediaStatus.PENDING);
  });

  it('routes a movie to its exact Radarr and stores linkage only on the destination', async (t) => {
    const requestRepository = getRepository(MediaRequest);
    const request = await seedMovieRequest();
    const transaction = t.mock.method(
      requestRepository.manager,
      'transaction',
      async () => {
        throw new Error('Detached callbacks must not open a transaction');
      }
    );
    const builtFor: string[] = [];
    t.mock.method(
      RadarrAPI.prototype,
      'getMovieByTmdbId',
      async function (this: RadarrAPI) {
        builtFor.push(
          (
            this as unknown as {
              axios: { defaults: { baseURL: string } };
            }
          ).axios.defaults.baseURL
        );
        return radarrMovie(7001, 'movie-92001');
      }
    );

    await markApprovedWithoutListeners(request);
    await new MediaRequestSubscriber().sendToRadarr(
      request,
      requestRepository.manager
    );
    await waitFor(async () => {
      const destination = await getRepository(MediaDestinationStatus).findOne({
        where: { mediaId: request.media.id, serverId: 102 },
      });
      return destination?.status === MediaStatus.PROCESSING;
    });

    const media = await getRepository(Media).findOneOrFail({
      where: { id: request.media.id },
    });
    const destination = await getRepository(
      MediaDestinationStatus
    ).findOneOrFail({
      where: { mediaId: media.id, serverId: 102 },
    });
    assert.deepStrictEqual(builtFor, ['http://radarr-en:7878/api/v3']);
    assert.strictEqual(destination.status, MediaStatus.PROCESSING);
    assert.strictEqual(destination.externalServiceId, 7001);
    assert.strictEqual(destination.externalServiceSlug, 'movie-92001');
    assert.strictEqual(media.status, MediaStatus.AVAILABLE);
    assert.strictEqual(media.serviceId, null);
    assert.strictEqual(media.externalServiceId, null);
    assert.strictEqual(transaction.mock.callCount(), 0);
  });

  it('stores Sonarr linkage and requested season progress only on the destination', async (t) => {
    const requestRepository = getRepository(MediaRequest);
    const request = await seedTvRequest();
    const builtFor: string[] = [];
    t.mock.method(
      SonarrAPI.prototype,
      'addSeries',
      async function (this: SonarrAPI) {
        builtFor.push(
          (
            this as unknown as {
              axios: { defaults: { baseURL: string } };
            }
          ).axios.defaults.baseURL
        );
        return {
          id: 8001,
          titleSlug: 'series-93001',
        };
      }
    );

    await markApprovedWithoutListeners(request);
    await new MediaRequestSubscriber().sendToSonarr(
      request,
      requestRepository.manager
    );
    await waitFor(async () => {
      const destination = await getRepository(MediaDestinationStatus).findOne({
        where: { mediaId: request.media.id, serverId: 202 },
      });
      return destination?.status === MediaStatus.PROCESSING;
    });

    const media = await getRepository(Media).findOneOrFail({
      where: { id: request.media.id },
    });
    const destination = await getRepository(
      MediaDestinationStatus
    ).findOneOrFail({
      where: { mediaId: media.id, serverId: 202 },
    });
    const season = await getRepository(
      MediaDestinationSeasonStatus
    ).findOneOrFail({
      where: { destinationStatusId: destination.id, seasonNumber: 1 },
    });
    assert.deepStrictEqual(builtFor, ['http://sonarr-en:8989/api/v3']);
    assert.strictEqual(destination.status, MediaStatus.PROCESSING);
    assert.strictEqual(destination.externalServiceId, 8001);
    assert.strictEqual(season.status, MediaStatus.PROCESSING);
    assert.strictEqual(media.status, MediaStatus.AVAILABLE);
    assert.strictEqual(media.serviceId, null);
    assert.strictEqual(media.externalServiceId, null);
  });

  it('marks a failed request historical and releases only its exact destination', async (t) => {
    const requestRepository = getRepository(MediaRequest);
    const request = await seedMovieRequest();
    const transaction = t.mock.method(
      requestRepository.manager,
      'transaction',
      async () => {
        throw new Error('Detached callbacks must not open a transaction');
      }
    );
    await getRepository(MediaDestinationStatus).save(
      new MediaDestinationStatus({
        mediaId: request.media.id,
        serverId: 101,
        status: MediaStatus.PROCESSING,
      })
    );
    t.mock.method(RadarrAPI.prototype, 'getMovieByTmdbId', async () => {
      throw new Error('Radarr unavailable');
    });

    await markApprovedWithoutListeners(request);
    sendNotificationMock.mock.resetCalls();
    await new MediaRequestSubscriber().sendToRadarr(
      request,
      requestRepository.manager
    );
    await waitFor(async () => {
      const persisted = await requestRepository.findOne({
        where: { id: request.id },
      });
      const destination = await getRepository(MediaDestinationStatus).findOne({
        where: { mediaId: request.media.id, serverId: 102 },
      });
      return (
        persisted?.status === MediaRequestStatus.FAILED &&
        destination?.status === MediaStatus.UNKNOWN &&
        sendNotificationMock.mock.callCount() === 1
      );
    });

    const persisted = await requestRepository.findOneOrFail({
      where: { id: request.id },
    });
    const failedDestination = await getRepository(
      MediaDestinationStatus
    ).findOneOrFail({
      where: { mediaId: request.media.id, serverId: 102 },
    });
    const otherDestination = await getRepository(
      MediaDestinationStatus
    ).findOneOrFail({
      where: { mediaId: request.media.id, serverId: 101 },
    });
    assert.strictEqual(persisted.status, MediaRequestStatus.FAILED);
    assert.strictEqual(failedDestination.status, MediaStatus.UNKNOWN);
    assert.strictEqual(otherDestination.status, MediaStatus.PROCESSING);
    assert.strictEqual(sendNotificationMock.mock.callCount(), 1);
    assert.strictEqual(transaction.mock.callCount(), 0);
  });

  it('declines only the matching TV destination and season', async () => {
    const requestRepository = getRepository(MediaRequest);
    const request = await seedTvRequest();
    const otherDestination = await getRepository(MediaDestinationStatus).save(
      new MediaDestinationStatus({
        mediaId: request.media.id,
        serverId: 201,
        status: MediaStatus.PROCESSING,
      })
    );
    await getRepository(MediaDestinationSeasonStatus).save(
      new MediaDestinationSeasonStatus({
        destinationStatusId: otherDestination.id,
        seasonNumber: 1,
        status: MediaStatus.PROCESSING,
      })
    );

    request.status = MediaRequestStatus.DECLINED;
    await requestRepository.save(request);

    const english = await getRepository(MediaDestinationStatus).findOneOrFail({
      where: { mediaId: request.media.id, serverId: 202 },
    });
    const french = await getRepository(MediaDestinationStatus).findOneOrFail({
      where: { mediaId: request.media.id, serverId: 201 },
    });
    const englishSeason = await getRepository(
      MediaDestinationSeasonStatus
    ).findOneOrFail({
      where: { destinationStatusId: english.id, seasonNumber: 1 },
    });
    const frenchSeason = await getRepository(
      MediaDestinationSeasonStatus
    ).findOneOrFail({
      where: { destinationStatusId: french.id, seasonNumber: 1 },
    });
    assert.strictEqual(english.status, MediaStatus.UNKNOWN);
    assert.strictEqual(englishSeason.status, MediaStatus.UNKNOWN);
    assert.strictEqual(french.status, MediaStatus.PROCESSING);
    assert.strictEqual(frenchSeason.status, MediaStatus.PROCESSING);
  });

  it('preserves completed TV season history when an independent parent is declined', async () => {
    const media = await getRepository(Media).save(
      new Media({
        mediaType: MediaType.TV,
        tmdbId: 93002,
        tvdbId: 94002,
      })
    );
    const requestRepository = getRepository(MediaRequest);
    const request = await requestRepository.save(
      new MediaRequest({
        type: MediaType.TV,
        status: MediaRequestStatus.PENDING,
        media,
        requestedBy: await requester(),
        is4k: false,
        serverId: 202,
        seasons: [1, 2, 3].map(
          (seasonNumber) => new SeasonRequest({ seasonNumber })
        ),
      })
    );
    await markApprovedWithoutListeners(request);
    const persisted = await requestRepository.findOneOrFail({
      where: { id: request.id },
      relations: { seasons: true },
    });
    persisted.seasons.find((season) => season.seasonNumber === 1)!.status =
      MediaRequestStatus.COMPLETED;
    persisted.seasons.find((season) => season.seasonNumber === 2)!.status =
      MediaRequestStatus.APPROVED;
    await getRepository(SeasonRequest).save(persisted.seasons);

    persisted.status = MediaRequestStatus.DECLINED;
    await requestRepository.save(persisted);

    const updated = await requestRepository.findOneOrFail({
      where: { id: request.id },
      relations: { seasons: true },
    });
    assert.strictEqual(
      updated.seasons.find((season) => season.seasonNumber === 1)?.status,
      MediaRequestStatus.COMPLETED
    );
    assert.strictEqual(
      updated.seasons.find((season) => season.seasonNumber === 2)?.status,
      MediaRequestStatus.DECLINED
    );
    assert.strictEqual(
      updated.seasons.find((season) => season.seasonNumber === 3)?.status,
      MediaRequestStatus.DECLINED
    );
  });

  it('ignores an independent movie request when declining the native request', async () => {
    configureMixedServers();
    const requestRepository = getRepository(MediaRequest);
    const mediaRepository = getRepository(Media);
    const media = await mediaRepository.save(
      new Media({
        mediaType: MediaType.MOVIE,
        tmdbId: 92002,
        status: MediaStatus.PENDING,
        status4k: MediaStatus.UNKNOWN,
      })
    );
    const requestedBy = await requester();
    const nativeRequest = await requestRepository.save(
      new MediaRequest({
        type: MediaType.MOVIE,
        status: MediaRequestStatus.PENDING,
        media,
        requestedBy,
        is4k: false,
        serverId: 101,
      })
    );
    await requestRepository.save(
      new MediaRequest({
        type: MediaType.MOVIE,
        status: MediaRequestStatus.PENDING,
        media,
        requestedBy,
        is4k: false,
        serverId: 102,
      })
    );

    nativeRequest.status = MediaRequestStatus.DECLINED;
    await requestRepository.save(nativeRequest);

    const persistedMedia = await mediaRepository.findOneOrFail({
      where: { id: media.id },
    });
    const independentDestination = await getRepository(
      MediaDestinationStatus
    ).findOneOrFail({
      where: { mediaId: media.id, serverId: 102 },
    });
    assert.strictEqual(persistedMedia.status, MediaStatus.UNKNOWN);
    assert.strictEqual(independentDestination.status, MediaStatus.PENDING);
  });

  it('ignores an independent TV request when deleting the native request', async () => {
    configureMixedServers();
    const requestRepository = getRepository(MediaRequest);
    const mediaRepository = getRepository(Media);
    const media = await mediaRepository.save(
      new Media({
        mediaType: MediaType.TV,
        tmdbId: 93002,
        tvdbId: 94002,
        status: MediaStatus.PENDING,
        status4k: MediaStatus.UNKNOWN,
        seasons: [
          new Season({
            seasonNumber: 1,
            status: MediaStatus.PENDING,
            status4k: MediaStatus.UNKNOWN,
          }),
        ],
      })
    );
    const requestedBy = await requester();
    const nativeRequest = await requestRepository.save(
      new MediaRequest({
        type: MediaType.TV,
        status: MediaRequestStatus.PENDING,
        media,
        requestedBy,
        is4k: false,
        serverId: 201,
        seasons: [
          new SeasonRequest({
            seasonNumber: 1,
            status: MediaRequestStatus.PENDING,
          }),
        ],
      })
    );
    await requestRepository.save(
      new MediaRequest({
        type: MediaType.TV,
        status: MediaRequestStatus.PENDING,
        media,
        requestedBy,
        is4k: false,
        serverId: 202,
        seasons: [
          new SeasonRequest({
            seasonNumber: 1,
            status: MediaRequestStatus.PENDING,
          }),
        ],
      })
    );

    await requestRepository.remove(nativeRequest);

    const persistedMedia = await mediaRepository.findOneOrFail({
      where: { id: media.id },
    });
    const nativeSeason = persistedMedia.seasons.find(
      (season) => season.seasonNumber === 1
    );
    const independentDestination = await getRepository(
      MediaDestinationStatus
    ).findOneOrFail({
      where: { mediaId: media.id, serverId: 202 },
    });
    const independentSeason = await getRepository(
      MediaDestinationSeasonStatus
    ).findOneOrFail({
      where: {
        destinationStatusId: independentDestination.id,
        seasonNumber: 1,
      },
    });
    assert.strictEqual(persistedMedia.status, MediaStatus.UNKNOWN);
    assert.strictEqual(nativeSeason?.status, MediaStatus.UNKNOWN);
    assert.strictEqual(independentDestination.status, MediaStatus.PENDING);
    assert.strictEqual(independentSeason.status, MediaStatus.PENDING);
  });

  it('does not restore PROCESSING after the request is deleted during an Arr call', async (t) => {
    const requestRepository = getRepository(MediaRequest);
    const request = await seedMovieRequest();
    const subscriber = new MediaRequestSubscriber();
    const internals = subscriber as unknown as {
      updateDestinationLinkIfStillApproved: DestinationLinkGuard;
    };
    const originalGuard =
      internals.updateDestinationLinkIfStillApproved.bind(subscriber);
    let signalGuardFinished!: () => void;
    const guardFinished = new Promise<void>((resolve) => {
      signalGuardFinished = resolve;
    });
    t.mock.method(
      internals,
      'updateDestinationLinkIfStillApproved',
      async (...args: Parameters<DestinationLinkGuard>) => {
        try {
          return await originalGuard(...args);
        } finally {
          signalGuardFinished();
        }
      }
    );
    let resolveAdd!: (value: RadarrMovie) => void;
    let signalAddStarted!: () => void;
    const addStarted = new Promise<void>((resolve) => {
      signalAddStarted = resolve;
    });
    t.mock.method(
      RadarrAPI.prototype,
      'getMovieByTmdbId',
      () =>
        new Promise<RadarrMovie>((resolve) => {
          resolveAdd = resolve;
          signalAddStarted();
        })
    );

    await markApprovedWithoutListeners(request);
    await subscriber.sendToRadarr(request, requestRepository.manager);
    await addStarted;
    await requestRepository.remove(request);
    resolveAdd(radarrMovie(7002, 'late-movie'));
    await guardFinished;
    await flushCallbacks();

    const destination = await getRepository(
      MediaDestinationStatus
    ).findOneOrFail({
      where: { mediaId: request.media.id, serverId: 102 },
    });
    assert.strictEqual(destination.status, MediaStatus.UNKNOWN);
    assert.strictEqual(destination.externalServiceId, null);
  });

  it('locks and revalidates the exact request in the PostgreSQL success transaction', async () => {
    const subscriber = new MediaRequestSubscriber();
    const internals = subscriber as unknown as {
      withApprovedRequestSuccessGuard: ApprovedSuccessGuard;
    };
    const calls: string[] = [];
    let lockedStatus = MediaRequestStatus.APPROVED;
    const transactionManager = {
      createQueryBuilder(entity: typeof MediaRequest, alias: string) {
        assert.strictEqual(entity, MediaRequest);
        assert.strictEqual(alias, 'request');
        calls.push('query');
        return {
          setLock(lock: string) {
            assert.strictEqual(lock, 'pessimistic_write');
            calls.push('lock');
            return this;
          },
          where(sql: string, parameters: { requestId: number }) {
            assert.match(sql, /request\.id/);
            assert.strictEqual(parameters.requestId, 73);
            calls.push('where');
            return this;
          },
          async getOne() {
            calls.push('revalidate');
            return new MediaRequest({ id: 73, status: lockedStatus });
          },
        };
      },
    } as unknown as EntityManager;
    const postgresManager = {
      connection: { options: { type: 'postgres' } },
      async transaction<T>(
        run: (manager: EntityManager) => Promise<T>
      ): Promise<T> {
        calls.push('transaction');
        return run(transactionManager);
      },
    } as unknown as EntityManager;

    const applied = await internals.withApprovedRequestSuccessGuard(
      73,
      postgresManager,
      async (manager) => {
        assert.strictEqual(manager, transactionManager);
        calls.push('mutation');
        return true;
      }
    );

    assert.strictEqual(applied, true);
    assert.deepStrictEqual(calls, [
      'transaction',
      'query',
      'lock',
      'where',
      'revalidate',
      'mutation',
    ]);

    calls.length = 0;
    lockedStatus = MediaRequestStatus.DECLINED;
    const staleApplied = await internals.withApprovedRequestSuccessGuard(
      73,
      postgresManager,
      async () => {
        calls.push('stale mutation');
        return true;
      }
    );
    assert.strictEqual(staleApplied, false);
    assert.deepStrictEqual(calls, [
      'transaction',
      'query',
      'lock',
      'where',
      'revalidate',
    ]);
  });

  it('atomically ignores success when decline wins after the callback starts', async (t) => {
    const requestRepository = getRepository(MediaRequest);
    const request = await seedMovieRequest();
    const subscriber = new MediaRequestSubscriber();
    const internals = subscriber as unknown as {
      updateDestinationLinkIfStillApproved: DestinationLinkGuard;
    };
    const originalGuard =
      internals.updateDestinationLinkIfStillApproved.bind(subscriber);
    let signalGuardStarted!: () => void;
    const guardStarted = new Promise<void>((resolve) => {
      signalGuardStarted = resolve;
    });
    let releaseGuard!: () => void;
    const guardRelease = new Promise<void>((resolve) => {
      releaseGuard = resolve;
    });
    let signalGuardFinished!: () => void;
    const guardFinished = new Promise<void>((resolve) => {
      signalGuardFinished = resolve;
    });
    t.mock.method(
      internals,
      'updateDestinationLinkIfStillApproved',
      async (...args: Parameters<DestinationLinkGuard>) => {
        signalGuardStarted();
        await guardRelease;
        try {
          return await originalGuard(...args);
        } finally {
          signalGuardFinished();
        }
      }
    );
    t.mock.method(RadarrAPI.prototype, 'getMovieByTmdbId', async () =>
      radarrMovie(7003, 'racing-movie')
    );

    await markApprovedWithoutListeners(request);
    await subscriber.sendToRadarr(request, requestRepository.manager);
    await guardStarted;
    request.status = MediaRequestStatus.DECLINED;
    await requestRepository.save(request);
    releaseGuard();
    await guardFinished;
    await flushCallbacks();

    const persisted = await requestRepository.findOneOrFail({
      where: { id: request.id },
    });
    const destination = await getRepository(
      MediaDestinationStatus
    ).findOneOrFail({
      where: { mediaId: request.media.id, serverId: 102 },
    });
    assert.strictEqual(persisted.status, MediaRequestStatus.DECLINED);
    assert.strictEqual(destination.status, MediaStatus.UNKNOWN);
    assert.strictEqual(destination.externalServiceId, null);
  });

  it('keeps a later decline authoritative after Arr success wins first', async (t) => {
    const requestRepository = getRepository(MediaRequest);
    const request = await seedMovieRequest();
    t.mock.method(RadarrAPI.prototype, 'getMovieByTmdbId', async () =>
      radarrMovie(7006, 'successful-before-decline')
    );

    await markApprovedWithoutListeners(request);
    await new MediaRequestSubscriber().sendToRadarr(
      request,
      requestRepository.manager
    );
    await waitFor(async () => {
      const destination = await getRepository(MediaDestinationStatus).findOne({
        where: { mediaId: request.media.id, serverId: 102 },
      });
      return (
        destination?.status === MediaStatus.PROCESSING &&
        destination.externalServiceId === 7006
      );
    });

    request.status = MediaRequestStatus.DECLINED;
    await requestRepository.save(request);

    const persisted = await requestRepository.findOneOrFail({
      where: { id: request.id },
    });
    const destination = await getRepository(
      MediaDestinationStatus
    ).findOneOrFail({
      where: { mediaId: request.media.id, serverId: 102 },
    });
    assert.strictEqual(persisted.status, MediaRequestStatus.DECLINED);
    assert.strictEqual(destination.status, MediaStatus.UNKNOWN);
    assert.strictEqual(destination.externalServiceId, 7006);
  });

  it('condition-gates the later Sonarr season write after decline wins', async (t) => {
    const requestRepository = getRepository(MediaRequest);
    const request = await seedTvRequest();
    const subscriber = new MediaRequestSubscriber();
    const internals = subscriber as unknown as {
      updateDestinationSeasonsIfStillApproved: DestinationSeasonGuard;
    };
    const originalGuard =
      internals.updateDestinationSeasonsIfStillApproved.bind(subscriber);
    let signalGuardStarted!: () => void;
    const guardStarted = new Promise<void>((resolve) => {
      signalGuardStarted = resolve;
    });
    let releaseGuard!: () => void;
    const guardRelease = new Promise<void>((resolve) => {
      releaseGuard = resolve;
    });
    let signalGuardFinished!: () => void;
    const guardFinished = new Promise<void>((resolve) => {
      signalGuardFinished = resolve;
    });
    t.mock.method(
      internals,
      'updateDestinationSeasonsIfStillApproved',
      async (...args: Parameters<DestinationSeasonGuard>) => {
        signalGuardStarted();
        await guardRelease;
        try {
          return await originalGuard(...args);
        } finally {
          signalGuardFinished();
        }
      }
    );
    t.mock.method(SonarrAPI.prototype, 'addSeries', async () => ({
      id: 8002,
      titleSlug: 'racing-series',
    }));

    await markApprovedWithoutListeners(request);
    await subscriber.sendToSonarr(request, requestRepository.manager);
    await guardStarted;
    request.status = MediaRequestStatus.DECLINED;
    await requestRepository.save(request);
    releaseGuard();
    await guardFinished;
    await flushCallbacks();

    const persisted = await requestRepository.findOneOrFail({
      where: { id: request.id },
    });
    const destination = await getRepository(
      MediaDestinationStatus
    ).findOneOrFail({
      where: { mediaId: request.media.id, serverId: 202 },
    });
    const season = await getRepository(
      MediaDestinationSeasonStatus
    ).findOneOrFail({
      where: { destinationStatusId: destination.id, seasonNumber: 1 },
    });
    assert.strictEqual(persisted.status, MediaRequestStatus.DECLINED);
    assert.strictEqual(destination.status, MediaStatus.UNKNOWN);
    assert.strictEqual(season.status, MediaStatus.UNKNOWN);
  });

  it('condition-gates native linkage when decline wins before the callback write', async (t) => {
    configureMixedServers();
    const requestRepository = getRepository(MediaRequest);
    const request = await seedMovieRequest(101);
    const subscriber = new MediaRequestSubscriber();
    const internals = subscriber as unknown as {
      updateNativeMediaLinkIfStillApproved: NativeLinkGuard;
    };
    const originalGuard =
      internals.updateNativeMediaLinkIfStillApproved.bind(subscriber);
    let signalGuardStarted!: () => void;
    const guardStarted = new Promise<void>((resolve) => {
      signalGuardStarted = resolve;
    });
    let releaseGuard!: () => void;
    const guardRelease = new Promise<void>((resolve) => {
      releaseGuard = resolve;
    });
    let signalGuardFinished!: () => void;
    const guardFinished = new Promise<void>((resolve) => {
      signalGuardFinished = resolve;
    });
    t.mock.method(
      internals,
      'updateNativeMediaLinkIfStillApproved',
      async (...args: Parameters<NativeLinkGuard>) => {
        signalGuardStarted();
        await guardRelease;
        try {
          return await originalGuard(...args);
        } finally {
          signalGuardFinished();
        }
      }
    );
    t.mock.method(RadarrAPI.prototype, 'getMovieByTmdbId', async () =>
      radarrMovie(7004, 'late-native-movie')
    );

    const mediaRepository = getRepository(Media);
    const pendingMedia = await mediaRepository.findOneOrFail({
      where: { id: request.media.id },
    });
    pendingMedia.status = MediaStatus.PENDING;
    await mediaRepository.save(pendingMedia);
    await markApprovedWithoutListeners(request);
    await subscriber.sendToRadarr(request, requestRepository.manager);
    await guardStarted;
    request.status = MediaRequestStatus.DECLINED;
    await requestRepository.save(request);
    releaseGuard();
    await guardFinished;
    await flushCallbacks();

    const persisted = await requestRepository.findOneOrFail({
      where: { id: request.id },
    });
    const media = await getRepository(Media).findOneOrFail({
      where: { id: request.media.id },
    });
    assert.strictEqual(persisted.status, MediaRequestStatus.DECLINED);
    assert.strictEqual(media.externalServiceId, null);
    assert.strictEqual(media.externalServiceSlug, null);
    assert.strictEqual(media.serviceId, null);
  });

  it('does not fail or notify a request declined during an Arr call', async (t) => {
    const requestRepository = getRepository(MediaRequest);
    const request = await seedMovieRequest();
    const subscriber = new MediaRequestSubscriber();
    const internals = subscriber as unknown as {
      markFailedIfStillApproved: FailureGuard;
    };
    const originalGuard = internals.markFailedIfStillApproved.bind(subscriber);
    let signalGuardFinished!: () => void;
    const guardFinished = new Promise<void>((resolve) => {
      signalGuardFinished = resolve;
    });
    t.mock.method(
      internals,
      'markFailedIfStillApproved',
      async (...args: Parameters<FailureGuard>) => {
        try {
          return await originalGuard(...args);
        } finally {
          signalGuardFinished();
        }
      }
    );
    let rejectAdd!: (reason: Error) => void;
    t.mock.method(
      RadarrAPI.prototype,
      'getMovieByTmdbId',
      () =>
        new Promise<RadarrMovie>((_resolve, reject) => {
          rejectAdd = reject;
        })
    );

    await markApprovedWithoutListeners(request);
    await subscriber.sendToRadarr(request, requestRepository.manager);
    request.status = MediaRequestStatus.DECLINED;
    await requestRepository.save(request);
    sendNotificationMock.mock.resetCalls();

    rejectAdd(new Error('Late Radarr failure'));
    await guardFinished;
    await flushCallbacks();

    const persisted = await requestRepository.findOneOrFail({
      where: { id: request.id },
    });
    const destination = await getRepository(
      MediaDestinationStatus
    ).findOneOrFail({
      where: { mediaId: request.media.id, serverId: 102 },
    });
    assert.strictEqual(persisted.status, MediaRequestStatus.DECLINED);
    assert.strictEqual(destination.status, MediaStatus.UNKNOWN);
    assert.strictEqual(sendNotificationMock.mock.callCount(), 0);
  });

  it('atomically ignores failure when decline wins after the callback starts', async (t) => {
    const requestRepository = getRepository(MediaRequest);
    const request = await seedMovieRequest();
    const subscriber = new MediaRequestSubscriber();
    const internals = subscriber as unknown as {
      markFailedIfStillApproved: FailureGuard;
    };
    const originalGuard = internals.markFailedIfStillApproved.bind(subscriber);
    let signalGuardStarted!: () => void;
    const guardStarted = new Promise<void>((resolve) => {
      signalGuardStarted = resolve;
    });
    let releaseGuard!: () => void;
    const guardRelease = new Promise<void>((resolve) => {
      releaseGuard = resolve;
    });
    let signalGuardFinished!: () => void;
    const guardFinished = new Promise<void>((resolve) => {
      signalGuardFinished = resolve;
    });
    t.mock.method(
      internals,
      'markFailedIfStillApproved',
      async (...args: Parameters<FailureGuard>) => {
        signalGuardStarted();
        await guardRelease;
        try {
          return await originalGuard(...args);
        } finally {
          signalGuardFinished();
        }
      }
    );
    t.mock.method(RadarrAPI.prototype, 'getMovieByTmdbId', async () => {
      throw new Error('Radarr failed after callback start');
    });

    await markApprovedWithoutListeners(request);
    await subscriber.sendToRadarr(request, requestRepository.manager);
    await guardStarted;
    request.status = MediaRequestStatus.DECLINED;
    await requestRepository.save(request);
    sendNotificationMock.mock.resetCalls();
    releaseGuard();
    await guardFinished;
    await flushCallbacks();

    const persisted = await requestRepository.findOneOrFail({
      where: { id: request.id },
    });
    const destination = await getRepository(
      MediaDestinationStatus
    ).findOneOrFail({
      where: { mediaId: request.media.id, serverId: 102 },
    });
    assert.strictEqual(persisted.status, MediaRequestStatus.DECLINED);
    assert.strictEqual(destination.status, MediaStatus.UNKNOWN);
    assert.strictEqual(sendNotificationMock.mock.callCount(), 0);
  });

  it('runs overlapping SQLite callback guards without manager transactions', async (t) => {
    const requestRepository = getRepository(MediaRequest);
    const request = await seedMovieRequest();
    const subscriber = new MediaRequestSubscriber();
    const internals = subscriber as unknown as {
      updateDestinationLinkIfStillApproved: DestinationLinkGuard;
      markFailedIfStillApproved: FailureGuard;
    };
    const transaction = t.mock.method(
      requestRepository.manager,
      'transaction',
      async () => {
        throw new Error('Callback guards must not open SQLite transactions');
      }
    );

    await markApprovedWithoutListeners(request);
    await Promise.all([
      internals.updateDestinationLinkIfStillApproved(
        request.id,
        request.media.id,
        102,
        7005,
        'overlapping-movie',
        requestRepository.manager
      ),
      internals.markFailedIfStillApproved(
        request.id,
        requestRepository.manager
      ),
    ]);

    const persisted = await requestRepository.findOneOrFail({
      where: { id: request.id },
    });
    const destination = await getRepository(
      MediaDestinationStatus
    ).findOneOrFail({
      where: { mediaId: request.media.id, serverId: 102 },
    });
    assert.strictEqual(persisted.status, MediaRequestStatus.FAILED);
    assert.strictEqual(destination.status, MediaStatus.UNKNOWN);
    assert.strictEqual(transaction.mock.callCount(), 0);
  });

  it('ignores an outer Radarr failure after the request is declined', async () => {
    const requestRepository = getRepository(MediaRequest);
    const request = await seedMovieRequest();
    let rejectMovie!: (reason: Error) => void;
    getMovieOverride = () =>
      new Promise((_resolve, reject) => {
        rejectMovie = reject;
      });

    await markApprovedWithoutListeners(request);
    const sendPromise = new MediaRequestSubscriber().sendToRadarr(
      request,
      requestRepository.manager
    );
    await waitFor(async () => rejectMovie !== undefined);
    request.status = MediaRequestStatus.DECLINED;
    await requestRepository.save(request);
    sendNotificationMock.mock.resetCalls();

    rejectMovie(new Error('Late TMDB failure'));
    await sendPromise;

    const persisted = await requestRepository.findOneOrFail({
      where: { id: request.id },
    });
    const destination = await getRepository(
      MediaDestinationStatus
    ).findOneOrFail({
      where: { mediaId: request.media.id, serverId: 102 },
    });
    assert.strictEqual(persisted.status, MediaRequestStatus.DECLINED);
    assert.strictEqual(destination.status, MediaStatus.UNKNOWN);
    assert.strictEqual(sendNotificationMock.mock.callCount(), 0);
  });

  it('does not use native availability notifications for an independent completion', async (t) => {
    const request = await seedMovieRequest(102);
    await markApprovedWithoutListeners(request);
    const notify = t.mock.method(
      notificationManager,
      'sendNotification',
      async () => undefined
    );

    request.status = MediaRequestStatus.COMPLETED;
    await getRepository(MediaRequest).save(request);

    assert.strictEqual(notify.mock.callCount(), 0);
  });

  it('retains the existing native availability notification on completion', async (t) => {
    configureMixedServers();
    const request = await seedMovieRequest(101);
    await markApprovedWithoutListeners(request);
    const notify = t.mock.method(
      notificationManager,
      'sendNotification',
      async () => undefined
    );

    request.status = MediaRequestStatus.COMPLETED;
    await getRepository(MediaRequest).save(request);

    assert.strictEqual(notify.mock.callCount(), 1);
  });
});
