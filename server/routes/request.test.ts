import assert from 'node:assert/strict';
import type { TestContext } from 'node:test';
import { before, beforeEach, describe, it, mock } from 'node:test';

import TheMovieDb from '@server/api/themoviedb';
import type {
  TmdbMovieDetails,
  TmdbTvDetails,
} from '@server/api/themoviedb/interfaces';
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
import OverrideRule from '@server/entity/OverrideRule';
import Season from '@server/entity/Season';
import SeasonRequest from '@server/entity/SeasonRequest';
import { User } from '@server/entity/User';
import { Permission } from '@server/lib/permissions';
import { getRequestEditRevision } from '@server/lib/requestEditRevision';
import type { RadarrSettings, SonarrSettings } from '@server/lib/settings';
import { getSettings } from '@server/lib/settings';
import { checkUser } from '@server/middleware/auth';
import { MediaRequestSubscriber } from '@server/subscriber/MediaRequestSubscriber';
import { setupTestDb } from '@server/test/db';
import {
  assertNoCredentials,
  seedUserSettings,
} from '@server/test/userSettings';
import requestLock, { requestKey } from '@server/utils/requestLock';
import type { AxiosInstance } from 'axios';
import axios from 'axios';
import type { Express } from 'express';
import express from 'express';
import session from 'express-session';
import request from 'supertest';
import { In } from 'typeorm';
import authRoutes from './auth';
import requestRoutes from './request';
import radarrRoutes from './settings/radarr';

const sendNotificationMock = mock.method(
  MediaRequest,
  'sendNotification',
  async () => undefined
).mock;

const getMovieImpl: (args: {
  movieId: number;
  language?: string;
}) => Promise<TmdbMovieDetails> = async ({ movieId }) => fakeTmdbMovie(movieId);

Object.defineProperty(TheMovieDb.prototype, 'getMovie', {
  get() {
    return async (args: { movieId: number; language?: string }) =>
      getMovieImpl(args);
  },
  set() {},
  configurable: true,
});

const getTvShowImpl: (args: {
  tvId: number;
  language?: string;
}) => Promise<TmdbTvDetails> = async ({ tvId }) => fakeTmdbShow(tvId);

Object.defineProperty(TheMovieDb.prototype, 'getTvShow', {
  get() {
    return async (args: { tvId: number; language?: string }) =>
      getTvShowImpl(args);
  },
  set() {},
  configurable: true,
});

function fakeTmdbMovie(tmdbId: number): TmdbMovieDetails {
  return {
    id: tmdbId,
    genres: [],
    original_language: 'en',
    keywords: { keywords: [] },
    external_ids: {},
    release_date: '2020-01-01',
  } as unknown as TmdbMovieDetails;
}

function fakeTmdbShow(tmdbId: number): TmdbTvDetails {
  return {
    id: tmdbId,
    genres: [],
    original_language: 'en',
    keywords: { results: [] },
    external_ids: {},
  } as unknown as TmdbTvDetails;
}

function configureRadarr(overrides: Partial<RadarrSettings>[]): void {
  const settings = getSettings();
  settings.radarr = overrides.map((o, i) => ({
    id: i,
    name: `Radarr ${i}`,
    hostname: 'localhost',
    port: 7878,
    apiKey: 'test-key',
    baseUrl: '',
    useSsl: false,
    activeProfileId: 1,
    activeDirectory: '/movies',
    is4k: false,
    minimumAvailability: 'released',
    tags: [],
    isDefault: i === 0,
    syncEnabled: true,
    independentRequestDestination: false,
    preventSearch: false,
    tagRequests: false,
    externalUrl: '',
    ...o,
  })) as RadarrSettings[];
}

function configureSonarr(overrides: Partial<SonarrSettings>[]): void {
  const settings = getSettings();
  settings.sonarr = overrides.map((o, i) => ({
    id: i,
    name: `Sonarr ${i}`,
    hostname: 'localhost',
    port: 8989,
    apiKey: 'test-key',
    baseUrl: '',
    useSsl: false,
    activeProfileId: 1,
    activeDirectory: '/tv',
    activeLanguageProfileId: 1,
    animeTags: [],
    is4k: false,
    enableSeasonFolders: true,
    tags: [],
    isDefault: i === 0,
    syncEnabled: true,
    independentRequestDestination: false,
    preventSearch: false,
    tagRequests: false,
    seriesType: 'standard',
    animeSeriesType: 'anime',
    monitorNewItems: 'all',
    externalUrl: '',
    ...o,
  })) as SonarrSettings[];
}

let app: Express;

function createApp() {
  const app = express();
  app.use(express.json());
  app.use(
    session({
      secret: 'test-secret',
      resave: false,
      saveUninitialized: false,
    })
  );
  app.use(checkUser);
  app.use('/auth', authRoutes);
  app.use('/request', requestRoutes);
  app.use('/settings/radarr', radarrRoutes);
  app.use(
    (
      err: { status?: number; message?: string },
      _req: express.Request,
      res: express.Response,
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      _next: express.NextFunction
    ) => {
      res
        .status(err.status ?? 500)
        .json({ status: err.status ?? 500, message: err.message });
    }
  );
  return app;
}

before(async () => {
  app = createApp();
});

beforeEach(() => {
  sendNotificationMock.resetCalls();
  getSettings().radarr = [];
  getSettings().sonarr = [];
});

setupTestDb();

async function loginAs(email: string, password: string) {
  const settings = getSettings();
  const priorLocalLogin = settings.main.localLogin;
  settings.main.localLogin = true;

  try {
    const agent = request.agent(app);
    const res = await agent.post('/auth/local').send({ email, password });
    assert.strictEqual(res.status, 200);
    return agent;
  } finally {
    settings.main.localLogin = priorLocalLogin;
  }
}

async function seedRequest(status = MediaRequestStatus.PENDING) {
  const userRepo = getRepository(User);
  const mediaRepo = getRepository(Media);
  const requestRepo = getRepository(MediaRequest);

  const requestedBy = await userRepo.findOneOrFail({
    where: { email: 'demo@seerr.dev' },
  });

  const media = await mediaRepo.save(
    new Media({
      mediaType: MediaType.MOVIE,
      tmdbId: 12345,
      status: MediaStatus.UNKNOWN,
      status4k: MediaStatus.UNKNOWN,
    })
  );

  const created = await requestRepo.save(
    new MediaRequest({
      type: MediaType.MOVIE,
      status,
      media,
      requestedBy,
      is4k: false,
      updatedAt: new Date('2025-03-01T00:00:00.000Z'),
    })
  );

  return requestRepo.findOneOrFail({
    where: { id: created.id },
    relations: { requestedBy: true, modifiedBy: true },
  });
}

const nextTurn = () => new Promise<void>((resolve) => setImmediate(resolve));

const pauseRequestBeforeUpdate = (t: TestContext) => {
  const originalBeforeUpdate = MediaRequestSubscriber.prototype.beforeUpdate;
  let signalReached!: () => void;
  const reached = new Promise<void>((resolve) => {
    signalReached = resolve;
  });
  let resume!: () => void;
  const resumed = new Promise<void>((resolve) => {
    resume = resolve;
  });

  t.mock.method(
    MediaRequestSubscriber.prototype,
    'beforeUpdate',
    async function (
      this: MediaRequestSubscriber,
      ...args: Parameters<typeof originalBeforeUpdate>
    ) {
      signalReached();
      await resumed;
      return originalBeforeUpdate.apply(this, args);
    }
  );

  return { reached, resume };
};

describe('Conditional request editing', () => {
  const moviePayload = (profileId: number, serverId = 1, userId?: number) => ({
    mediaType: MediaType.MOVIE,
    serverId,
    profileId,
    rootFolder: `/movies/${profileId}`,
    tags: [profileId],
    userId,
  });

  async function movieSession() {
    configureRadarr([{ id: 1 }, { id: 2 }]);
    const pending = await seedRequest();
    pending.serverId = 1;
    pending.profileId = 10;
    pending.rootFolder = '/movies/10';
    pending.tags = [10];
    await getRepository(MediaRequest).save(pending);
    const a = await loginAs('admin@seerr.dev', 'test1234');
    const b = await loginAs('admin@seerr.dev', 'test1234');
    const baseline = await a.get(`/request/${pending.id}`);
    assert.equal(baseline.status, 200);
    assert.equal(
      baseline.body.editRevision,
      getRequestEditRevision(
        await getRepository(MediaRequest).findOneByOrFail({ id: pending.id })
      )
    );
    return { a, b, pending, revision: baseline.body.editRevision as string };
  }

  for (const ownerOnly of [false, true]) {
    it(`rejects a stale movie edit after ${ownerOnly ? 'owner-only' : 'destination/configuration/owner'} changes`, async () => {
      const { a, b, pending, revision } = await movieSession();
      const owner = await seedUser('admin@seerr.dev');
      const newer = await b
        .put(`/request/${pending.id}`)
        .set('If-Match', `"${revision}"`)
        .send(moviePayload(ownerOnly ? 10 : 20, ownerOnly ? 1 : 2, owner.id));
      assert.equal(newer.status, 200);
      assert.notEqual(newer.body.editRevision, revision);
      const saved = await getRepository(MediaRequest).findOneByOrFail({
        id: pending.id,
      });
      assert.equal(newer.body.editRevision, getRequestEditRevision(saved));
      const stale = await a
        .put(`/request/${pending.id}`)
        .set('If-Match', `"${revision}"`)
        .send(moviePayload(30, 1, pending.requestedBy.id));
      assert.equal(stale.status, 409);
      const after = await getRepository(MediaRequest).findOneByOrFail({
        id: pending.id,
      });
      assert.equal(getRequestEditRevision(after), newer.body.editRevision);
      assert.equal(after.serverId, ownerOnly ? 1 : 2);
      assert.equal(after.profileId, ownerOnly ? 10 : 20);
      assert.equal(after.rootFolder, ownerOnly ? '/movies/10' : '/movies/20');
      assert.equal(after.requestedBy.id, owner.id);
    });
  }

  it('serializes two edits with the same revision and rejects the queued stale edit', async (t) => {
    const { a, b, pending, revision } = await movieSession();
    const pause = pauseRequestBeforeUpdate(t);
    let signalQueued!: () => void;
    const queued = new Promise<void>((resolve) => {
      signalQueued = resolve;
    });
    const dispatch = requestLock.dispatch.bind(requestLock);
    let count = 0;
    t.mock.method(
      requestLock,
      'dispatch',
      (...args: Parameters<typeof dispatch>) => {
        if (args[0] === requestKey(pending.id) && ++count === 2) signalQueued();
        return dispatch(...args);
      }
    );
    const first = a
      .put(`/request/${pending.id}`)
      .set('If-Match', `"${revision}"`)
      .send(moviePayload(20, 2))
      .then((res) => res);
    await pause.reached;
    const second = b
      .put(`/request/${pending.id}`)
      .set('If-Match', `"${revision}"`)
      .send(moviePayload(30, 1))
      .then((res) => res);
    try {
      await queued;
    } finally {
      pause.resume();
    }
    const [winner, loser] = await Promise.all([first, second]);
    assert.equal(winner.status, 200);
    assert.equal(loser.status, 409);
    const saved = await getRepository(MediaRequest).findOneByOrFail({
      id: pending.id,
    });
    assert.equal(saved.serverId, 2);
    assert.equal(saved.profileId, 20);
    assert.equal(saved.rootFolder, '/movies/20');
    assert.deepEqual(saved.tags, [20]);
    assert.equal(getRequestEditRevision(saved), winner.body.editRevision);
  });

  for (const independent of [false, true]) {
    it(`preserves ${independent ? 'independent' : 'native'} TV seasons on stale edit and cancellation`, async (t) => {
      configureSonarr([
        { id: 1, independentRequestDestination: independent },
        { id: 2, independentRequestDestination: true },
      ]);
      const owner = await seedUser('demo@seerr.dev');
      const media = await seedMediaSeasons(67890, [
        { seasonNumber: 1, status: MediaStatus.PENDING },
        { seasonNumber: 2, status: MediaStatus.UNKNOWN },
      ]);
      const repo = getRepository(MediaRequest);
      const make = (serverId: number, seasons: number[]) =>
        repo.save(
          new MediaRequest({
            type: MediaType.TV,
            status: MediaRequestStatus.PENDING,
            media,
            requestedBy: owner,
            serverId,
            profileId: 10,
            rootFolder: '/tv',
            tags: [],
            is4k: false,
            ignoreQuota: false,
            seasons: seasons.map(
              (seasonNumber) =>
                new SeasonRequest({
                  seasonNumber,
                  status: MediaRequestStatus.PENDING,
                })
            ),
          })
        );
      const pending = await make(1, [1]);
      const other = await make(2, [1, 2]);
      const a = await loginAs('admin@seerr.dev', 'test1234');
      const b = await loginAs('admin@seerr.dev', 'test1234');
      const baseline = await a.get(`/request/${pending.id}`);
      const body = {
        mediaType: MediaType.TV,
        serverId: 1,
        profileId: 10,
        rootFolder: '/tv',
        tags: [],
        seasons: [1, 2],
      };
      const newer = await b
        .put(`/request/${pending.id}`)
        .set('If-Match', `"${baseline.body.editRevision}"`)
        .send(body);
      assert.equal(newer.status, 200);
      const saved = await repo.findOneByOrFail({ id: pending.id });
      assert.deepEqual(saved.seasons.map((s) => s.seasonNumber).sort(), [1, 2]);
      const release = t.mock.method(
        MediaRequestSubscriber.prototype,
        'beforeUpdate'
      );
      const remove = t.mock.method(
        MediaRequestSubscriber.prototype,
        'afterRemove'
      );
      const destinationBefore = await getRepository(
        MediaDestinationSeasonStatus
      ).find({ order: { id: 'ASC' } });
      const nativeBefore = await getRepository(Media).findOneByOrFail({
        id: media.id,
      });
      const stale = await a
        .put(`/request/${pending.id}`)
        .set('If-Match', `"${baseline.body.editRevision}"`)
        .send({ ...body, seasons: [1], profileId: 99 });
      assert.equal(stale.status, 409);
      const deletion = await a
        .delete(`/request/${pending.id}`)
        .set('If-Match', `"${baseline.body.editRevision}"`);
      assert.equal(deletion.status, 409);
      assert.equal(release.mock.callCount(), 0);
      assert.equal(remove.mock.callCount(), 0);
      const after = await repo.findOneByOrFail({ id: pending.id });
      assert.equal(after.status, MediaRequestStatus.PENDING);
      assert.equal(getRequestEditRevision(after), newer.body.editRevision);
      assert.equal(after.requestedBy.id, owner.id);
      assert.equal(after.profileId, 10);
      assert.deepEqual(
        (await repo.findOneByOrFail({ id: other.id })).seasons
          .map((s) => s.seasonNumber)
          .sort(),
        [1, 2]
      );
      assert.deepEqual(
        await getRepository(MediaDestinationSeasonStatus).find({
          order: { id: 'ASC' },
        }),
        destinationBefore
      );
      assert.deepEqual(
        await getRepository(Media).findOneByOrFail({ id: media.id }),
        nativeBefore
      );
      const currentDelete = await a
        .delete(`/request/${pending.id}`)
        .set('If-Match', `"${newer.body.editRevision}"`);
      assert.equal(currentDelete.status, 204);
      assert.equal(await repo.findOneBy({ id: pending.id }), null);
    });
  }

  it('rejects approval superseded after PUT without invoking approval subscribers', async (t) => {
    const { a, b, pending, revision } = await movieSession();
    const first = await a
      .put(`/request/${pending.id}`)
      .set('If-Match', `"${revision}"`)
      .send(moviePayload(20));
    assert.equal(first.status, 200);
    const newer = await b
      .put(`/request/${pending.id}`)
      .set('If-Match', `"${first.body.editRevision}"`)
      .send(moviePayload(30, 2));
    assert.equal(newer.status, 200);
    const update = t.mock.method(
      MediaRequestSubscriber.prototype,
      'beforeUpdate'
    );
    const send = t.mock.method(
      MediaRequestSubscriber.prototype,
      'sendToRadarr',
      async () => undefined
    );
    const stale = await a
      .post(`/request/${pending.id}/approve`)
      .set('If-Match', `"${first.body.editRevision}"`);
    assert.equal(stale.status, 409);
    assert.equal(update.mock.callCount(), 0);
    assert.equal(send.mock.callCount(), 0);
    const after = await getRepository(MediaRequest).findOneByOrFail({
      id: pending.id,
    });
    assert.equal(after.status, MediaRequestStatus.PENDING);
    assert.equal(after.profileId, 30);
    assert.equal(getRequestEditRevision(after), newer.body.editRevision);
    const approved = await a
      .post(`/request/${pending.id}/approve`)
      .set('If-Match', `"${newer.body.editRevision}"`);
    assert.equal(approved.status, 200);
    assert.equal(approved.body.status, MediaRequestStatus.APPROVED);
    assert.equal(send.mock.callCount(), 1);
  });

  it('approves the revision returned by a single conditional edit', async (t) => {
    const { a, pending, revision } = await movieSession();
    const edited = await a
      .put(`/request/${pending.id}`)
      .set('If-Match', `"${revision}"`)
      .send(moviePayload(20));
    assert.equal(edited.status, 200);
    assert.notEqual(edited.body.editRevision, revision);
    const send = t.mock.method(
      MediaRequestSubscriber.prototype,
      'sendToRadarr',
      async () => undefined
    );
    const approved = await a
      .post(`/request/${pending.id}/approve`)
      .set('If-Match', `"${edited.body.editRevision}"`);
    assert.equal(approved.status, 200);
    assert.equal(approved.body.status, MediaRequestStatus.APPROVED);
    assert.equal(send.mock.callCount(), 1);
  });

  it('returns a revision of persisted values when PUT omits nullable fields', async () => {
    const { a, pending, revision } = await movieSession();
    const edited = await a
      .put(`/request/${pending.id}`)
      .set('If-Match', `"${revision}"`)
      .send({ mediaType: MediaType.MOVIE });
    assert.equal(edited.status, 200);
    assert.equal(edited.body.editRevision, revision);
    assert.equal(edited.body.profileId, 10);
  });
});

describe('DELETE /request/:requestId', () => {
  it('allows the owner to delete their own pending request', async () => {
    const mediaRequest = await seedRequest();

    const agent = await loginAs('demo@seerr.dev', 'test1234');
    const res = await agent.delete(`/request/${mediaRequest.id}`);

    assert.strictEqual(res.status, 204);
  });

  it('allows an admin to delete any pending request', async () => {
    const mediaRequest = await seedRequest();

    const agent = await loginAs('admin@seerr.dev', 'test1234');
    const res = await agent.delete(`/request/${mediaRequest.id}`);

    assert.strictEqual(res.status, 204);
  });

  it('prevents a non-owner non-admin from deleting a pending request', async () => {
    const userRepo = getRepository(User);
    const mediaRepo = getRepository(Media);
    const requestRepo = getRepository(MediaRequest);

    // Create a request owned by admin, then try to delete as friend
    const owner = await userRepo.findOneOrFail({
      where: { email: 'admin@seerr.dev' },
    });

    const media = await mediaRepo.save(
      new Media({
        mediaType: MediaType.MOVIE,
        tmdbId: 54321,
        status: MediaStatus.UNKNOWN,
        status4k: MediaStatus.UNKNOWN,
      })
    );

    const mediaRequest = await requestRepo.save(
      new MediaRequest({
        type: MediaType.MOVIE,
        status: MediaRequestStatus.PENDING,
        media,
        requestedBy: owner,
        is4k: false,
      })
    );

    const agent = await loginAs('demo@seerr.dev', 'test1234');
    const res = await agent.delete(`/request/${mediaRequest.id}`);

    assert.strictEqual(res.status, 401);
  });

  it('prevents the owner from deleting an approved request', async () => {
    const mediaRequest = await seedRequest(MediaRequestStatus.APPROVED);

    const agent = await loginAs('demo@seerr.dev', 'test1234');
    const res = await agent.delete(`/request/${mediaRequest.id}`);

    assert.strictEqual(res.status, 401);
  });

  it('returns 404 for a non-existent request', async () => {
    const agent = await loginAs('admin@seerr.dev', 'test1234');
    const res = await agent.delete('/request/99999999');

    assert.strictEqual(res.status, 404);
  });

  it('deletes a request once when two deletes race', async () => {
    const repo = getRepository(MediaRequest);
    const mediaRequest = await seedRequest();
    const admin = await loginAs('admin@seerr.dev', 'test1234');

    const results = await Promise.all([
      admin.delete(`/request/${mediaRequest.id}`),
      admin.delete(`/request/${mediaRequest.id}`),
    ]);

    assert.deepStrictEqual(results.map((r) => r.status).sort(), [204, 404]);
    assert.strictEqual(await repo.count({ where: { id: mediaRequest.id } }), 0);
  });
});

describe('PUT /request/:requestId (movie)', () => {
  it('persists server and root folder changes to the database', async () => {
    configureRadarr([
      { id: 3, isDefault: true, independentRequestDestination: false },
    ]);
    const requestRepo = getRepository(MediaRequest);
    const mediaRequest = await seedRequest();

    const agent = await loginAs('admin@seerr.dev', 'test1234');
    const res = await agent.put(`/request/${mediaRequest.id}`).send({
      mediaType: MediaType.MOVIE,
      serverId: 3,
      profileId: 7,
      rootFolder: '/updated/movies',
      tags: [1, 2],
    });

    assert.strictEqual(res.status, 200);

    const saved = await requestRepo.findOneOrFail({
      where: { id: mediaRequest.id },
    });
    assert.strictEqual(saved.serverId, 3);
    assert.strictEqual(saved.profileId, 7);
    assert.strictEqual(saved.rootFolder, '/updated/movies');
  });

  it('refuses to modify a request that is no longer pending', async () => {
    const requestRepo = getRepository(MediaRequest);
    const mediaRequest = await seedRequest(MediaRequestStatus.APPROVED);

    const agent = await loginAs('admin@seerr.dev', 'test1234');
    const res = await agent.put(`/request/${mediaRequest.id}`).send({
      mediaType: MediaType.MOVIE,
      serverId: 3,
      rootFolder: '/updated/movies',
    });

    assert.strictEqual(res.status, 409);
    assert.match(res.body.message, /pending/i);

    const saved = await requestRepo.findOneOrFail({
      where: { id: mediaRequest.id },
    });
    assert.strictEqual(saved.serverId, null);
    assert.strictEqual(saved.rootFolder, null);
  });

  it('keeps an independent destination when serverId is omitted', async () => {
    configureRadarr([
      { id: 31, independentRequestDestination: true, isDefault: true },
    ]);
    const requestRepo = getRepository(MediaRequest);
    const mediaRequest = await seedRequest();
    mediaRequest.serverId = 31;
    await requestRepo.save(mediaRequest);

    const agent = await loginAs('admin@seerr.dev', 'test1234');
    const res = await agent.put(`/request/${mediaRequest.id}`).send({
      mediaType: MediaType.MOVIE,
      rootFolder: '/updated/movies',
    });

    assert.strictEqual(res.status, 200);
    const saved = await requestRepo.findOneOrFail({
      where: { id: mediaRequest.id },
    });
    assert.strictEqual(saved.serverId, 31);
  });

  it('keeps a resolved native destination when serverId is omitted', async () => {
    configureRadarr([{ id: 33, independentRequestDestination: false }]);
    const requestRepo = getRepository(MediaRequest);
    const mediaRequest = await seedRequest();
    mediaRequest.serverId = 33;
    await requestRepo.save(mediaRequest);

    const agent = await loginAs('admin@seerr.dev', 'test1234');
    const res = await agent.put(`/request/${mediaRequest.id}`).send({
      mediaType: MediaType.MOVIE,
      rootFolder: '/updated/native-movies',
    });

    assert.strictEqual(res.status, 200);
    const saved = await requestRepo.findOneOrFail({
      where: { id: mediaRequest.id },
    });
    assert.strictEqual(saved.serverId, 33);
    assert.strictEqual(saved.rootFolder, '/updated/native-movies');
  });

  it('allows a native movie request to move to another native server', async () => {
    configureRadarr([
      { id: 34, isDefault: true, independentRequestDestination: false },
      { id: 35, isDefault: false, independentRequestDestination: false },
    ]);
    const requestRepo = getRepository(MediaRequest);
    const mediaRequest = await seedRequest();
    mediaRequest.serverId = 34;
    await requestRepo.save(mediaRequest);

    const agent = await loginAs('admin@seerr.dev', 'test1234');
    const res = await agent.put(`/request/${mediaRequest.id}`).send({
      mediaType: MediaType.MOVIE,
      serverId: 35,
      rootFolder: '/other-native',
    });

    assert.strictEqual(res.status, 200);
    const saved = await requestRepo.findOneOrFail({
      where: { id: mediaRequest.id },
    });
    assert.strictEqual(saved.serverId, 35);
    assert.strictEqual(saved.rootFolder, '/other-native');
  });

  it('rejects converting a native movie request to an independent destination', async () => {
    configureRadarr([
      { id: 36, isDefault: true, independentRequestDestination: false },
      { id: 37, isDefault: false, independentRequestDestination: true },
    ]);
    const requestRepo = getRepository(MediaRequest);
    const mediaRequest = await seedRequest();
    mediaRequest.serverId = 36;
    await requestRepo.save(mediaRequest);

    const agent = await loginAs('admin@seerr.dev', 'test1234');
    const res = await agent.put(`/request/${mediaRequest.id}`).send({
      mediaType: MediaType.MOVIE,
      serverId: 37,
      rootFolder: '/must-not-change',
    });

    assert.strictEqual(res.status, 409);
    const saved = await requestRepo.findOneOrFail({
      where: { id: mediaRequest.id },
    });
    assert.strictEqual(saved.serverId, 36);
    assert.strictEqual(saved.is4k, false);
    assert.strictEqual(saved.rootFolder, null);
    assert.strictEqual(
      await getRepository(MediaDestinationStatus).count({
        where: { mediaId: mediaRequest.media.id, serverId: 37 },
      }),
      0
    );
  });

  it('rejects null and unknown native movie targets without partial edits', async () => {
    configureRadarr([
      { id: 38, isDefault: true, independentRequestDestination: false },
    ]);
    const requestRepo = getRepository(MediaRequest);
    const mediaRequest = await seedRequest();
    mediaRequest.serverId = 38;
    await requestRepo.save(mediaRequest);
    const agent = await loginAs('admin@seerr.dev', 'test1234');

    for (const serverId of [null, 99999]) {
      const res = await agent.put(`/request/${mediaRequest.id}`).send({
        mediaType: MediaType.MOVIE,
        serverId,
        rootFolder: '/must-not-change',
      });
      assert.strictEqual(res.status, 409);
    }

    const saved = await requestRepo.findOneOrFail({
      where: { id: mediaRequest.id },
    });
    assert.strictEqual(saved.serverId, 38);
    assert.strictEqual(saved.rootFolder, null);
  });

  it('rejects retargeting an independent request', async () => {
    configureRadarr([
      { id: 31, independentRequestDestination: true, isDefault: true },
      { id: 32, independentRequestDestination: true, isDefault: false },
    ]);
    const requestRepo = getRepository(MediaRequest);
    const mediaRequest = await seedRequest();
    mediaRequest.serverId = 31;
    await requestRepo.save(mediaRequest);

    const agent = await loginAs('admin@seerr.dev', 'test1234');
    const res = await agent.put(`/request/${mediaRequest.id}`).send({
      mediaType: MediaType.MOVIE,
      serverId: 32,
      rootFolder: '/changed',
    });

    assert.strictEqual(res.status, 409);
    const saved = await requestRepo.findOneOrFail({
      where: { id: mediaRequest.id },
    });
    assert.strictEqual(saved.serverId, 31);
    assert.strictEqual(saved.rootFolder, null);
  });
});

async function seedUser(
  email: string,
  quotas: {
    movieQuotaLimit?: number;
    tvQuotaLimit?: number;
    tvQuotaDays?: number;
  } = {}
) {
  const userRepo = getRepository(User);
  const user = await userRepo.findOneOrFail({ where: { email } });
  Object.assign(user, quotas);

  return userRepo.save(user);
}

async function seedTvMedia(tmdbId: number) {
  const mediaRepo = getRepository(Media);

  return (
    (await mediaRepo.findOne({
      where: { tmdbId, mediaType: MediaType.TV },
    })) ??
    (await mediaRepo.save(
      new Media({
        mediaType: MediaType.TV,
        tmdbId,
        status: MediaStatus.PENDING,
        status4k: MediaStatus.UNKNOWN,
      })
    ))
  );
}

async function seedMediaSeasons(
  tmdbId: number,
  seasons: { seasonNumber: number; status: MediaStatus }[]
) {
  const media = await seedTvMedia(tmdbId);
  media.seasons = seasons.map(
    ({ seasonNumber, status }) =>
      new Season({ seasonNumber, status, status4k: MediaStatus.UNKNOWN })
  );

  return getRepository(Media).save(media);
}

async function seedTvRequest(
  requestedBy: User,
  seasons: number[],
  { tmdbId = 67890, ignoreQuota = false, createdAt = new Date() } = {}
) {
  return getRepository(MediaRequest).save(
    new MediaRequest({
      type: MediaType.TV,
      status: MediaRequestStatus.PENDING,
      media: await seedTvMedia(tmdbId),
      requestedBy,
      is4k: false,
      ignoreQuota,
      createdAt,
      seasons: seasons.map(
        (seasonNumber) =>
          new SeasonRequest({
            seasonNumber,
            status: MediaRequestStatus.PENDING,
          })
      ),
    })
  );
}

describe('PUT /request/:requestId (tv)', () => {
  it('does not add a season held by another request', async () => {
    const requestRepo = getRepository(MediaRequest);

    const owner = await seedUser('admin@seerr.dev');
    const otherUser = await seedUser('demo@seerr.dev');

    const mediaRequest = await seedTvRequest(owner, [1, 2]);
    const otherRequest = await seedTvRequest(otherUser, [3]);

    const agent = await loginAs('admin@seerr.dev', 'test1234');
    const res = await agent.put(`/request/${mediaRequest.id}`).send({
      mediaType: MediaType.TV,
      seasons: [1, 2, 3],
    });

    assert.strictEqual(res.status, 200);

    const saved = await requestRepo.findOneOrFail({
      where: { id: mediaRequest.id },
    });
    assert.deepStrictEqual(
      saved.seasons.map((s) => s.seasonNumber).sort((a, b) => a - b),
      [1, 2]
    );

    const otherSaved = await requestRepo.findOneOrFail({
      where: { id: otherRequest.id },
    });
    assert.deepStrictEqual(
      otherSaved.seasons.map((s) => s.seasonNumber),
      [3]
    );
  });

  it('gives a season to only one of two concurrent edits', async () => {
    const requestRepo = getRepository(MediaRequest);

    const owner = await seedUser('admin@seerr.dev');
    const otherUser = await seedUser('demo@seerr.dev');

    const mediaRequest = await seedTvRequest(owner, [1]);
    const otherRequest = await seedTvRequest(otherUser, [3]);

    const admin = await loginAs('admin@seerr.dev', 'test1234');
    const friend = await loginAs('demo@seerr.dev', 'test1234');

    const [adminRes, friendRes] = await Promise.all([
      admin
        .put(`/request/${mediaRequest.id}`)
        .send({ mediaType: MediaType.TV, seasons: [1, 2] }),
      friend
        .put(`/request/${otherRequest.id}`)
        .send({ mediaType: MediaType.TV, seasons: [3, 2] }),
    ]);

    assert.strictEqual(adminRes.status, 200);
    assert.strictEqual(friendRes.status, 200);

    const saved = await requestRepo.findOneOrFail({
      where: { id: mediaRequest.id },
    });
    const otherSaved = await requestRepo.findOneOrFail({
      where: { id: otherRequest.id },
    });

    const holders = [saved, otherSaved].filter((r) =>
      r.seasons.some((s) => s.seasonNumber === 2)
    );
    assert.strictEqual(holders.length, 1);

    assert.deepStrictEqual(
      [...saved.seasons, ...otherSaved.seasons]
        .map((s) => s.seasonNumber)
        .sort((a, b) => a - b),
      [1, 2, 3]
    );
  });

  it('edits independent TV seasons without reading or changing another destination', async () => {
    configureSonarr([
      { id: 201, isDefault: true, independentRequestDestination: true },
      { id: 202, isDefault: false, independentRequestDestination: true },
    ]);
    const user = await seedUser('demo@seerr.dev');
    const french = await MediaRequest.request(
      {
        mediaType: MediaType.TV,
        mediaId: 67901,
        serverId: 201,
        seasons: [2],
      },
      user
    );
    const english = await MediaRequest.request(
      {
        mediaType: MediaType.TV,
        mediaId: 67901,
        serverId: 202,
        seasons: [1],
      },
      user
    );
    const englishDestination = await getRepository(
      MediaDestinationStatus
    ).findOneOrFail({
      where: { mediaId: english.media.id, serverId: 202 },
    });
    const englishSeasonOne = await getRepository(
      MediaDestinationSeasonStatus
    ).findOneOrFail({
      where: {
        destinationStatusId: englishDestination.id,
        seasonNumber: 1,
      },
    });
    englishSeasonOne.status = MediaStatus.PROCESSING;
    await getRepository(MediaDestinationSeasonStatus).save(englishSeasonOne);

    const agent = await loginAs('demo@seerr.dev', 'test1234');
    const res = await agent.put(`/request/${english.id}`).send({
      mediaType: MediaType.TV,
      seasons: [2],
    });

    assert.strictEqual(res.status, 200);
    const savedEnglish = await getRepository(MediaRequest).findOneOrFail({
      where: { id: english.id },
    });
    assert.deepStrictEqual(
      savedEnglish.seasons.map((season) => season.seasonNumber),
      [2]
    );
    const destinations = await getRepository(MediaDestinationStatus).find({
      where: { mediaId: english.media.id },
    });
    const byServerId = new Map(
      destinations.map((destination) => [destination.serverId, destination])
    );
    const statuses = await getRepository(MediaDestinationSeasonStatus).find({
      where: {
        destinationStatusId: In([
          byServerId.get(201)?.id ?? 0,
          byServerId.get(202)?.id ?? 0,
        ]),
      },
    });
    const statusBySlot = new Map(
      statuses.map((status) => [
        `${status.destinationStatusId}:${status.seasonNumber}`,
        status.status,
      ])
    );
    assert.strictEqual(
      statusBySlot.get(`${byServerId.get(201)?.id}:2`),
      MediaStatus.PENDING
    );
    assert.strictEqual(
      statusBySlot.get(`${byServerId.get(202)?.id}:1`),
      MediaStatus.UNKNOWN
    );
    assert.strictEqual(
      statusBySlot.get(`${byServerId.get(202)?.id}:2`),
      MediaStatus.PENDING
    );
    assert.deepStrictEqual(
      french.seasons.map((season) => season.seasonNumber),
      [2]
    );
  });

  it('rolls back an independent TV edit when removed-season cleanup fails', async (t) => {
    configureSonarr([
      { id: 211, isDefault: true, independentRequestDestination: true },
    ]);
    const user = await seedUser('demo@seerr.dev');
    const mediaRequest = await MediaRequest.request(
      {
        mediaType: MediaType.TV,
        mediaId: 67911,
        serverId: 211,
        seasons: [1, 2],
      },
      user
    );
    const destination = await getRepository(
      MediaDestinationStatus
    ).findOneOrFail({
      where: { mediaId: mediaRequest.media.id, serverId: 211 },
    });
    const subscriberInternals = MediaRequestSubscriber.prototype as unknown as {
      releaseIndependentDestinationSeasons: () => Promise<void>;
    };
    t.mock.method(
      subscriberInternals,
      'releaseIndependentDestinationSeasons',
      async () => {
        throw new Error('Destination season cleanup failed');
      }
    );

    const agent = await loginAs('demo@seerr.dev', 'test1234');
    const res = await agent.put(`/request/${mediaRequest.id}`).send({
      mediaType: MediaType.TV,
      seasons: [2],
    });

    assert.strictEqual(res.status, 500);
    const persisted = await getRepository(MediaRequest).findOneOrFail({
      where: { id: mediaRequest.id },
    });
    assert.deepStrictEqual(
      persisted.seasons.map((season) => season.seasonNumber),
      [1, 2]
    );
    const seasonStatuses = await getRepository(
      MediaDestinationSeasonStatus
    ).find({
      where: { destinationStatusId: destination.id },
    });
    assert.deepStrictEqual(
      seasonStatuses
        .map((season) => [season.seasonNumber, season.status])
        .sort(([left], [right]) => left - right),
      [
        [1, MediaStatus.PENDING],
        [2, MediaStatus.PENDING],
      ]
    );
  });

  it('does not clear removed independent TV state held by another active exact-slot request', async () => {
    configureSonarr([
      { id: 212, isDefault: true, independentRequestDestination: true },
    ]);
    const user = await seedUser('demo@seerr.dev');
    const mediaRequest = await MediaRequest.request(
      {
        mediaType: MediaType.TV,
        mediaId: 67912,
        serverId: 212,
        seasons: [1, 2],
      },
      user
    );
    await getRepository(MediaRequest).save(
      new MediaRequest({
        type: MediaType.TV,
        status: MediaRequestStatus.PENDING,
        media: mediaRequest.media,
        requestedBy: user,
        is4k: false,
        serverId: 212,
        seasons: [
          new SeasonRequest({
            seasonNumber: 1,
            status: MediaRequestStatus.PENDING,
          }),
        ],
      })
    );

    const agent = await loginAs('demo@seerr.dev', 'test1234');
    const res = await agent.put(`/request/${mediaRequest.id}`).send({
      mediaType: MediaType.TV,
      seasons: [2],
    });

    assert.strictEqual(res.status, 200);
    const destination = await getRepository(
      MediaDestinationStatus
    ).findOneOrFail({
      where: { mediaId: mediaRequest.media.id, serverId: 212 },
    });
    const season = await getRepository(
      MediaDestinationSeasonStatus
    ).findOneOrFail({
      where: { destinationStatusId: destination.id, seasonNumber: 1 },
    });
    assert.strictEqual(season.status, MediaStatus.PENDING);
  });

  it('does not degrade scanner-derived state when an independent TV season is removed', async () => {
    configureSonarr([
      { id: 213, isDefault: true, independentRequestDestination: true },
    ]);
    const user = await seedUser('demo@seerr.dev');
    const mediaRequest = await MediaRequest.request(
      {
        mediaType: MediaType.TV,
        mediaId: 67913,
        serverId: 213,
        seasons: [1, 2],
      },
      user
    );
    const destination = await getRepository(
      MediaDestinationStatus
    ).findOneOrFail({
      where: { mediaId: mediaRequest.media.id, serverId: 213 },
    });
    const seasonRepository = getRepository(MediaDestinationSeasonStatus);
    const scannerDerived = await seasonRepository.findOneOrFail({
      where: { destinationStatusId: destination.id, seasonNumber: 1 },
    });
    scannerDerived.status = MediaStatus.AVAILABLE;
    await seasonRepository.save(scannerDerived);

    const agent = await loginAs('demo@seerr.dev', 'test1234');
    const res = await agent.put(`/request/${mediaRequest.id}`).send({
      mediaType: MediaType.TV,
      seasons: [2],
    });

    assert.strictEqual(res.status, 200);
    assert.strictEqual(
      (
        await seasonRepository.findOneOrFail({
          where: { id: scannerDerived.id },
        })
      ).status,
      MediaStatus.AVAILABLE
    );
  });

  it('keeps a resolved native TV destination when serverId is omitted', async () => {
    configureSonarr([{ id: 203, independentRequestDestination: false }]);
    const owner = await seedUser('demo@seerr.dev');
    const mediaRequest = await seedTvRequest(owner, [1]);
    mediaRequest.serverId = 203;
    await getRepository(MediaRequest).save(mediaRequest);

    const agent = await loginAs('demo@seerr.dev', 'test1234');
    const res = await agent.put(`/request/${mediaRequest.id}`).send({
      mediaType: MediaType.TV,
      seasons: [1],
      rootFolder: '/updated/native-tv',
    });

    assert.strictEqual(res.status, 200);
    const saved = await getRepository(MediaRequest).findOneOrFail({
      where: { id: mediaRequest.id },
    });
    assert.strictEqual(saved.serverId, 203);
    assert.strictEqual(saved.rootFolder, '/updated/native-tv');
  });

  it('rejects converting a native TV request to an independent destination', async () => {
    configureSonarr([
      { id: 208, isDefault: true, independentRequestDestination: false },
      { id: 209, isDefault: false, independentRequestDestination: true },
    ]);
    const owner = await seedUser('demo@seerr.dev');
    const mediaRequest = await seedTvRequest(owner, [1]);
    mediaRequest.serverId = 208;
    await getRepository(MediaRequest).save(mediaRequest);

    const agent = await loginAs('demo@seerr.dev', 'test1234');
    const res = await agent.put(`/request/${mediaRequest.id}`).send({
      mediaType: MediaType.TV,
      serverId: 209,
      seasons: [1, 2],
      rootFolder: '/must-not-change',
    });

    assert.strictEqual(res.status, 409);
    const saved = await getRepository(MediaRequest).findOneOrFail({
      where: { id: mediaRequest.id },
    });
    assert.strictEqual(saved.serverId, 208);
    assert.strictEqual(saved.rootFolder, null);
    assert.deepStrictEqual(
      saved.seasons.map((season) => season.seasonNumber),
      [1]
    );
    assert.strictEqual(
      await getRepository(MediaDestinationStatus).count({
        where: { mediaId: mediaRequest.media.id, serverId: 209 },
      }),
      0
    );
    assert.strictEqual(
      await getRepository(MediaDestinationSeasonStatus).count(),
      0
    );
  });

  it('rejects a deleted native TV target even when an old destination row exists', async () => {
    configureSonarr([
      { id: 210, isDefault: true, independentRequestDestination: false },
    ]);
    const owner = await seedUser('demo@seerr.dev');
    const mediaRequest = await seedTvRequest(owner, [1]);
    mediaRequest.serverId = 210;
    await getRepository(MediaRequest).save(mediaRequest);
    const staleDestination = await getRepository(MediaDestinationStatus).save(
      new MediaDestinationStatus({
        mediaId: mediaRequest.media.id,
        serverId: 211,
        status: MediaStatus.UNKNOWN,
      })
    );

    const agent = await loginAs('demo@seerr.dev', 'test1234');
    const res = await agent.put(`/request/${mediaRequest.id}`).send({
      mediaType: MediaType.TV,
      serverId: 211,
      seasons: [1, 2],
      rootFolder: '/must-not-change',
    });

    assert.strictEqual(res.status, 409);
    const saved = await getRepository(MediaRequest).findOneOrFail({
      where: { id: mediaRequest.id },
    });
    assert.strictEqual(saved.serverId, 210);
    assert.strictEqual(saved.rootFolder, null);
    assert.deepStrictEqual(
      saved.seasons.map((season) => season.seasonNumber),
      [1]
    );
    assert.strictEqual(
      await getRepository(MediaDestinationSeasonStatus).count({
        where: { destinationStatusId: staleDestination.id },
      }),
      0
    );
  });

  it('does not filter a native TV edit because an independent request holds the season', async () => {
    configureSonarr([
      { id: 204, isDefault: true, independentRequestDestination: false },
      { id: 205, isDefault: false, independentRequestDestination: true },
    ]);
    const user = await seedUser('demo@seerr.dev');
    await MediaRequest.request(
      {
        mediaType: MediaType.TV,
        mediaId: 67902,
        serverId: 205,
        seasons: [2],
      },
      user
    );
    const native = await MediaRequest.request(
      {
        mediaType: MediaType.TV,
        mediaId: 67902,
        serverId: 204,
        seasons: [1],
      },
      user
    );

    const agent = await loginAs('demo@seerr.dev', 'test1234');
    const res = await agent.put(`/request/${native.id}`).send({
      mediaType: MediaType.TV,
      seasons: [1, 2],
    });

    assert.strictEqual(res.status, 200);
    const saved = await getRepository(MediaRequest).findOneOrFail({
      where: { id: native.id },
    });
    assert.deepStrictEqual(
      saved.seasons.map((season) => season.seasonNumber).sort((a, b) => a - b),
      [1, 2]
    );
  });

  it('does not filter an independent TV edit because a native request holds the season', async () => {
    configureSonarr([
      { id: 206, isDefault: true, independentRequestDestination: false },
      { id: 207, isDefault: false, independentRequestDestination: true },
    ]);
    const user = await seedUser('demo@seerr.dev');
    await MediaRequest.request(
      {
        mediaType: MediaType.TV,
        mediaId: 67903,
        serverId: 206,
        seasons: [2],
      },
      user
    );
    const independent = await MediaRequest.request(
      {
        mediaType: MediaType.TV,
        mediaId: 67903,
        serverId: 207,
        seasons: [1],
      },
      user
    );

    const agent = await loginAs('demo@seerr.dev', 'test1234');
    const res = await agent.put(`/request/${independent.id}`).send({
      mediaType: MediaType.TV,
      seasons: [1, 2],
    });

    assert.strictEqual(res.status, 200);
    const saved = await getRepository(MediaRequest).findOneOrFail({
      where: { id: independent.id },
    });
    assert.deepStrictEqual(
      saved.seasons.map((season) => season.seasonNumber).sort((a, b) => a - b),
      [1, 2]
    );
  });
});

describe('PUT /request/:requestId (season availability)', () => {
  it('does not add a season the media already has', async () => {
    const requestRepo = getRepository(MediaRequest);
    const owner = await seedUser('demo@seerr.dev');
    const mediaRequest = await seedTvRequest(owner, [1]);
    await seedMediaSeasons(67890, [
      { seasonNumber: 2, status: MediaStatus.AVAILABLE },
    ]);

    const agent = await loginAs('demo@seerr.dev', 'test1234');
    const res = await agent.put(`/request/${mediaRequest.id}`).send({
      mediaType: MediaType.TV,
      seasons: [1, 2, 3],
    });

    assert.strictEqual(res.status, 200);

    const saved = await requestRepo.findOneOrFail({
      where: { id: mediaRequest.id },
    });
    assert.deepStrictEqual(
      saved.seasons.map((s) => s.seasonNumber).sort((a, b) => a - b),
      [1, 3]
    );
  });

  it('returns 202 when every requested season is already covered', async () => {
    const owner = await seedUser('demo@seerr.dev');
    const mediaRequest = await seedTvRequest(owner, [1]);
    await seedMediaSeasons(67890, [
      { seasonNumber: 2, status: MediaStatus.AVAILABLE },
    ]);

    const agent = await loginAs('demo@seerr.dev', 'test1234');
    const res = await agent.put(`/request/${mediaRequest.id}`).send({
      mediaType: MediaType.TV,
      seasons: [2],
    });

    assert.strictEqual(res.status, 202);
  });

  it('keeps the seasons it already holds once they are available', async () => {
    configureSonarr([
      { id: 3, isDefault: true, independentRequestDestination: false },
    ]);
    const requestRepo = getRepository(MediaRequest);
    const owner = await seedUser('demo@seerr.dev');
    const mediaRequest = await seedTvRequest(owner, [1, 2]);
    await seedMediaSeasons(67890, [
      { seasonNumber: 1, status: MediaStatus.AVAILABLE },
      { seasonNumber: 2, status: MediaStatus.PROCESSING },
    ]);

    const agent = await loginAs('demo@seerr.dev', 'test1234');
    const res = await agent.put(`/request/${mediaRequest.id}`).send({
      mediaType: MediaType.TV,
      seasons: [1, 2],
      serverId: 3,
    });

    assert.strictEqual(res.status, 200);

    const saved = await requestRepo.findOneOrFail({
      where: { id: mediaRequest.id },
    });
    assert.deepStrictEqual(
      saved.seasons.map((s) => s.seasonNumber).sort((a, b) => a - b),
      [1, 2]
    );
    assert.strictEqual(saved.serverId, 3);
  });

  it('does not charge quota for a season the media already has', async () => {
    const requestRepo = getRepository(MediaRequest);
    const owner = await seedUser('demo@seerr.dev', { tvQuotaLimit: 1 });
    const mediaRequest = await seedTvRequest(owner, [1]);
    await seedMediaSeasons(67890, [
      { seasonNumber: 2, status: MediaStatus.AVAILABLE },
    ]);

    const agent = await loginAs('demo@seerr.dev', 'test1234');
    const res = await agent.put(`/request/${mediaRequest.id}`).send({
      mediaType: MediaType.TV,
      seasons: [1, 2],
    });

    assert.strictEqual(res.status, 200);

    const saved = await requestRepo.findOneOrFail({
      where: { id: mediaRequest.id },
    });
    assert.deepStrictEqual(
      saved.seasons.map((s) => s.seasonNumber),
      [1]
    );
  });
});

describe('PUT /request/:requestId (quota)', () => {
  it('rejects adding seasons beyond the season limit', async () => {
    const requestRepo = getRepository(MediaRequest);
    const owner = await seedUser('demo@seerr.dev', { tvQuotaLimit: 2 });
    const mediaRequest = await seedTvRequest(owner, [1, 2]);

    const agent = await loginAs('demo@seerr.dev', 'test1234');
    const res = await agent.put(`/request/${mediaRequest.id}`).send({
      mediaType: MediaType.TV,
      seasons: [1, 2, 3],
    });

    assert.strictEqual(res.status, 403);

    const saved = await requestRepo.findOneOrFail({
      where: { id: mediaRequest.id },
    });
    assert.deepStrictEqual(
      saved.seasons.map((s) => s.seasonNumber).sort((a, b) => a - b),
      [1, 2]
    );
  });

  it('rejects adding seasons to a request older than the quota window', async () => {
    const requestRepo = getRepository(MediaRequest);
    const owner = await seedUser('demo@seerr.dev', {
      tvQuotaLimit: 2,
      tvQuotaDays: 7,
    });
    const mediaRequest = await seedTvRequest(owner, [1, 2], {
      createdAt: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000),
    });

    const agent = await loginAs('demo@seerr.dev', 'test1234');
    const res = await agent.put(`/request/${mediaRequest.id}`).send({
      mediaType: MediaType.TV,
      seasons: [1, 2, 3],
    });

    assert.strictEqual(res.status, 403);

    const saved = await requestRepo.findOneOrFail({
      where: { id: mediaRequest.id },
    });
    assert.deepStrictEqual(
      saved.seasons.map((s) => s.seasonNumber).sort((a, b) => a - b),
      [1, 2]
    );
  });

  it('allows swapping seasons at the season limit', async () => {
    const requestRepo = getRepository(MediaRequest);
    const owner = await seedUser('demo@seerr.dev', { tvQuotaLimit: 2 });
    const mediaRequest = await seedTvRequest(owner, [1, 2]);

    const agent = await loginAs('demo@seerr.dev', 'test1234');
    const res = await agent.put(`/request/${mediaRequest.id}`).send({
      mediaType: MediaType.TV,
      seasons: [3, 4],
    });

    assert.strictEqual(res.status, 200);

    const saved = await requestRepo.findOneOrFail({
      where: { id: mediaRequest.id },
    });
    assert.deepStrictEqual(
      saved.seasons.map((s) => s.seasonNumber).sort((a, b) => a - b),
      [3, 4]
    );
  });

  it('rejects reassignment to a user without room for the existing seasons', async () => {
    const requestRepo = getRepository(MediaRequest);
    const owner = await seedUser('admin@seerr.dev');
    const target = await seedUser('demo@seerr.dev', { tvQuotaLimit: 1 });
    const mediaRequest = await seedTvRequest(owner, [1, 2]);

    const agent = await loginAs('admin@seerr.dev', 'test1234');
    const res = await agent.put(`/request/${mediaRequest.id}`).send({
      mediaType: MediaType.TV,
      seasons: [1, 2],
      userId: target.id,
    });

    assert.strictEqual(res.status, 403);

    const saved = await requestRepo.findOneOrFail({
      where: { id: mediaRequest.id },
    });
    assert.strictEqual(saved.requestedBy.id, owner.id);
  });

  it('rejects reassignment of a movie request to a user at their limit', async () => {
    const requestRepo = getRepository(MediaRequest);
    const mediaRepo = getRepository(Media);

    const owner = await seedUser('admin@seerr.dev');
    const target = await seedUser('demo@seerr.dev', { movieQuotaLimit: 1 });

    // Uses up the target's single movie request
    await seedRequest();

    const media = await mediaRepo.save(
      new Media({
        mediaType: MediaType.MOVIE,
        tmdbId: 55555,
        status: MediaStatus.PENDING,
        status4k: MediaStatus.UNKNOWN,
      })
    );
    const mediaRequest = await requestRepo.save(
      new MediaRequest({
        type: MediaType.MOVIE,
        status: MediaRequestStatus.PENDING,
        media,
        requestedBy: owner,
        is4k: false,
      })
    );

    const agent = await loginAs('admin@seerr.dev', 'test1234');
    const res = await agent.put(`/request/${mediaRequest.id}`).send({
      mediaType: MediaType.MOVIE,
      userId: target.id,
    });

    assert.strictEqual(res.status, 403);

    const saved = await requestRepo.findOneOrFail({
      where: { id: mediaRequest.id },
    });
    assert.strictEqual(saved.requestedBy.id, owner.id);
  });

  it('allows reassignment to a user who bypasses quotas', async () => {
    const requestRepo = getRepository(MediaRequest);
    const owner = await seedUser('demo@seerr.dev', { tvQuotaLimit: 1 });
    const target = await seedUser('admin@seerr.dev');
    const mediaRequest = await seedTvRequest(owner, [1, 2]);

    const agent = await loginAs('admin@seerr.dev', 'test1234');
    const res = await agent.put(`/request/${mediaRequest.id}`).send({
      mediaType: MediaType.TV,
      seasons: [1, 2],
      userId: target.id,
    });

    assert.strictEqual(res.status, 200);

    const saved = await requestRepo.findOneOrFail({
      where: { id: mediaRequest.id },
    });
    assert.strictEqual(saved.requestedBy.id, target.id);
  });

  it('allows an edit that exceeds the limit when the request ignores quota', async () => {
    const requestRepo = getRepository(MediaRequest);
    const owner = await seedUser('demo@seerr.dev', { tvQuotaLimit: 2 });

    await seedTvRequest(owner, [1, 2], { tmdbId: 77777 });
    const mediaRequest = await seedTvRequest(owner, [1, 2], {
      ignoreQuota: true,
    });

    const agent = await loginAs('demo@seerr.dev', 'test1234');
    const res = await agent.put(`/request/${mediaRequest.id}`).send({
      mediaType: MediaType.TV,
      seasons: [1, 2, 3],
    });

    assert.strictEqual(res.status, 200);

    const saved = await requestRepo.findOneOrFail({
      where: { id: mediaRequest.id },
    });
    assert.deepStrictEqual(
      saved.seasons.map((s) => s.seasonNumber).sort((a, b) => a - b),
      [1, 2, 3]
    );
  });

  it('charges only the net increase when an edit both adds and removes', async () => {
    const requestRepo = getRepository(MediaRequest);
    const owner = await seedUser('demo@seerr.dev', { tvQuotaLimit: 4 });
    const mediaRequest = await seedTvRequest(owner, [1, 2, 3]);

    const agent = await loginAs('demo@seerr.dev', 'test1234');
    const res = await agent.put(`/request/${mediaRequest.id}`).send({
      mediaType: MediaType.TV,
      seasons: [1, 2, 4, 5],
    });

    assert.strictEqual(res.status, 200);

    const saved = await requestRepo.findOneOrFail({
      where: { id: mediaRequest.id },
    });
    assert.deepStrictEqual(
      saved.seasons.map((s) => s.seasonNumber).sort((a, b) => a - b),
      [1, 2, 4, 5]
    );
  });
});

describe('GET /request/:requestId', () => {
  it('omits notification settings from requestedBy and modifiedBy', async () => {
    const pending = await seedRequest();
    await seedUserSettings('demo@seerr.dev');
    await seedUserSettings('admin@seerr.dev');

    const admin = await loginAs('admin@seerr.dev', 'test1234');
    const approved = await admin.post(`/request/${pending.id}/approve`);
    assert.strictEqual(approved.status, 200);

    const res = await admin.get(`/request/${pending.id}`);

    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.requestedBy.email, 'demo@seerr.dev');
    assert.strictEqual(res.body.modifiedBy.email, 'admin@seerr.dev');
    assert.ok(!('settings' in res.body.requestedBy));
    assert.ok(!('settings' in res.body.modifiedBy));
    assertNoCredentials(res.body);
  });

  it('returns the exact independent target instead of contradictory native state', async () => {
    configureRadarr([
      {
        id: 301,
        name: 'French',
        independentRequestDestination: true,
      },
    ]);
    const pending = await seedRequest();
    pending.serverId = 301;
    pending.media.status = MediaStatus.AVAILABLE;
    await getRepository(Media).save(pending.media);
    await getRepository(MediaRequest).save(pending);
    await getRepository(MediaDestinationStatus).upsert(
      {
        mediaId: pending.media.id,
        serverId: 301,
        status: MediaStatus.PROCESSING,
      },
      ['mediaId', 'serverId']
    );

    const response = await (
      await loginAs('admin@seerr.dev', 'test1234')
    ).get(`/request/${pending.id}`);

    assert.strictEqual(response.status, 200);
    assert.deepStrictEqual(response.body.target, {
      serverId: 301,
      name: 'French',
      is4k: false,
      isIndependent: true,
      deleted: false,
      status: MediaStatus.PROCESSING,
      downloadStatus: [],
    });
  });

  it('returns null for an unresolved legacy target and a stable deleted placeholder', async () => {
    const legacy = await seedRequest();
    const admin = await loginAs('admin@seerr.dev', 'test1234');
    const legacyResponse = await admin.get(`/request/${legacy.id}`);
    assert.strictEqual(legacyResponse.body.target, null);

    legacy.serverId = 777;
    await getRepository(MediaRequest).save(legacy);
    const deletedResponse = await admin.get(`/request/${legacy.id}`);
    assert.strictEqual(
      deletedResponse.body.target.name,
      'Deleted Radarr server (#777)'
    );
    assert.strictEqual(deletedResponse.body.target.deleted, true);
  });
});

describe('GET /request target-aware list and count', () => {
  const mockProfiles = (t: TestContext) => {
    t.mock.method(
      axios,
      'create',
      () =>
        ({
          interceptors: { request: { use: () => 0 } },
          get: async () => ({ data: [] }),
        }) as unknown as AxiosInstance
    );
  };

  it('filters independent requests by destination state before pagination', async (t) => {
    mockProfiles(t);
    configureRadarr([
      { id: 311, independentRequestDestination: true, name: 'Independent' },
    ]);
    const requestRepo = getRepository(MediaRequest);
    const independent = await seedRequest(MediaRequestStatus.COMPLETED);
    independent.serverId = 311;
    independent.media.status = MediaStatus.UNKNOWN;
    await getRepository(Media).save(independent.media);
    await requestRepo.save(independent);
    await getRepository(MediaDestinationStatus).upsert(
      {
        mediaId: independent.media.id,
        serverId: 311,
        status: MediaStatus.AVAILABLE,
      },
      ['mediaId', 'serverId']
    );
    const otherMedia = await getRepository(Media).save(
      new Media({
        mediaType: MediaType.MOVIE,
        tmdbId: 12346,
        status: MediaStatus.UNKNOWN,
      })
    );
    const requestedBy = await getRepository(User).findOneByOrFail({ id: 1 });
    await requestRepo.save(
      new MediaRequest({
        type: MediaType.MOVIE,
        status: MediaRequestStatus.COMPLETED,
        media: otherMedia,
        requestedBy,
        serverId: 311,
        is4k: false,
      })
    );
    const response = await (
      await loginAs('admin@seerr.dev', 'test1234')
    ).get('/request?filter=available&take=1&skip=0');

    assert.strictEqual(response.status, 200);
    assert.strictEqual(response.body.pageInfo.results, 1);
    assert.strictEqual(response.body.results.length, 1);
    assert.strictEqual(response.body.results[0].id, independent.id);
    assert.strictEqual(
      response.body.results[0].target.status,
      MediaStatus.AVAILABLE
    );
  });

  it('uses destination state for processing and available counts without changing lifecycle counts', async () => {
    configureRadarr([
      { id: 321, independentRequestDestination: true },
      { id: 322, independentRequestDestination: false },
    ]);
    const requestRepo = getRepository(MediaRequest);
    const independent = await seedRequest(MediaRequestStatus.APPROVED);
    independent.serverId = 321;
    independent.media.status = MediaStatus.UNKNOWN;
    await getRepository(Media).save(independent.media);
    await requestRepo.save(independent);
    await getRepository(MediaDestinationStatus).upsert(
      {
        mediaId: independent.media.id,
        serverId: 321,
        status: MediaStatus.AVAILABLE,
      },
      ['mediaId', 'serverId']
    );
    const nativeMedia = await getRepository(Media).save(
      new Media({
        mediaType: MediaType.MOVIE,
        tmdbId: 12347,
        status: MediaStatus.PROCESSING,
      })
    );
    const requestedBy = await getRepository(User).findOneByOrFail({ id: 1 });
    const native = await requestRepo.save(
      new MediaRequest({
        type: MediaType.MOVIE,
        status: MediaRequestStatus.APPROVED,
        media: nativeMedia,
        requestedBy,
        serverId: 322,
        is4k: false,
      })
    );
    await requestRepo
      .createQueryBuilder()
      .update(MediaRequest)
      .set({ status: MediaRequestStatus.APPROVED })
      .where('id IN (:...ids)', { ids: [independent.id, native.id] })
      .callListeners(false)
      .execute();

    const response = await (
      await loginAs('admin@seerr.dev', 'test1234')
    ).get('/request/count');

    assert.strictEqual(response.status, 200);
    assert.strictEqual(response.body.total, 2);
    assert.strictEqual(response.body.movie, 2);
    assert.strictEqual(response.body.approved, 2);
    assert.strictEqual(response.body.available, 1);
    assert.strictEqual(response.body.processing, 1);
  });

  it('classifies processing and deleted filters from exact destination state', async (t) => {
    mockProfiles(t);
    configureRadarr([{ id: 325, independentRequestDestination: true }]);
    const requestRepo = getRepository(MediaRequest);
    const processing = await seedRequest(MediaRequestStatus.APPROVED);
    processing.serverId = 325;
    processing.media.status = MediaStatus.AVAILABLE;
    await getRepository(Media).save(processing.media);
    await requestRepo.save(processing);
    await getRepository(MediaDestinationStatus).upsert(
      {
        mediaId: processing.media.id,
        serverId: 325,
        status: MediaStatus.PROCESSING,
      },
      ['mediaId', 'serverId']
    );
    const deletedMedia = await getRepository(Media).save(
      new Media({
        mediaType: MediaType.MOVIE,
        tmdbId: 12349,
        status: MediaStatus.AVAILABLE,
      })
    );
    const requestedBy = await getRepository(User).findOneByOrFail({ id: 1 });
    const deleted = await requestRepo.save(
      new MediaRequest({
        type: MediaType.MOVIE,
        status: MediaRequestStatus.COMPLETED,
        media: deletedMedia,
        requestedBy,
        serverId: 325,
        is4k: false,
      })
    );
    await getRepository(MediaDestinationStatus).upsert(
      {
        mediaId: deletedMedia.id,
        serverId: 325,
        status: MediaStatus.DELETED,
      },
      ['mediaId', 'serverId']
    );
    await requestRepo
      .createQueryBuilder()
      .update(MediaRequest)
      .set({ status: MediaRequestStatus.APPROVED })
      .where('id = :id', { id: processing.id })
      .callListeners(false)
      .execute();
    await requestRepo
      .createQueryBuilder()
      .update(MediaRequest)
      .set({ status: MediaRequestStatus.COMPLETED })
      .where('id = :id', { id: deleted.id })
      .callListeners(false)
      .execute();
    const admin = await loginAs('admin@seerr.dev', 'test1234');

    const processingResponse = await admin.get('/request?filter=processing');
    const deletedResponse = await admin.get('/request?filter=deleted');

    assert.deepStrictEqual(
      processingResponse.body.results.map(
        (candidate: { id: number }) => candidate.id
      ),
      [processing.id]
    );
    assert.deepStrictEqual(
      deletedResponse.body.results.map(
        (candidate: { id: number }) => candidate.id
      ),
      [deleted.id]
    );
  });

  it('guards independent removal while preserving native canRemove', async (t) => {
    mockProfiles(t);
    configureRadarr([
      { id: 331, independentRequestDestination: true },
      { id: 332, independentRequestDestination: false },
    ]);
    const independent = await seedRequest(MediaRequestStatus.COMPLETED);
    independent.serverId = 331;
    independent.media.serviceId = 331;
    await getRepository(Media).save(independent.media);
    await getRepository(MediaRequest).save(independent);
    await getRepository(MediaDestinationStatus).upsert(
      {
        mediaId: independent.media.id,
        serverId: 331,
        status: MediaStatus.AVAILABLE,
      },
      ['mediaId', 'serverId']
    );
    const nativeMedia = await getRepository(Media).save(
      new Media({
        mediaType: MediaType.MOVIE,
        tmdbId: 12348,
        status: MediaStatus.AVAILABLE,
        serviceId: 332,
      })
    );
    const requestedBy = await getRepository(User).findOneByOrFail({ id: 1 });
    const native = await getRepository(MediaRequest).save(
      new MediaRequest({
        type: MediaType.MOVIE,
        status: MediaRequestStatus.COMPLETED,
        media: nativeMedia,
        requestedBy,
        serverId: 332,
        is4k: false,
      })
    );

    const response = await (
      await loginAs('admin@seerr.dev', 'test1234')
    ).get('/request?filter=available');

    assert.strictEqual(response.status, 200);
    assert.strictEqual(
      response.body.results.find(
        (candidate: { id: number }) => candidate.id === independent.id
      ).canRemove,
      false
    );
    assert.strictEqual(
      response.body.results.find(
        (candidate: { id: number }) => candidate.id === native.id
      ).canRemove,
      true
    );
  });
});

describe('POST /request/:requestId/:status', () => {
  const cases = [
    { action: 'approve', expected: MediaRequestStatus.APPROVED },
    { action: 'decline', expected: MediaRequestStatus.DECLINED },
  ] as const;

  for (const { action, expected } of cases) {
    it(`transitions to ${action}d and records the acting user`, async () => {
      const repo = getRepository(MediaRequest);
      const pending = await seedRequest();
      const admin = await loginAs('admin@seerr.dev', 'test1234');

      const res = await admin.post(`/request/${pending.id}/${action}`);

      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.body.status, expected);
      assert.strictEqual(res.body.modifiedBy.email, 'admin@seerr.dev');

      const persisted = await repo.findOneOrFail({
        where: { id: pending.id },
        relations: { modifiedBy: true },
      });

      assert.strictEqual(persisted.status, expected);
      assert.strictEqual(persisted.modifiedBy?.email, 'admin@seerr.dev');
      assert.ok(persisted.updatedAt > pending.updatedAt);
    });
  }

  it('returns freshly persisted native target state after approval', async (t) => {
    configureRadarr([
      { id: 341, isDefault: true, independentRequestDestination: false },
    ]);
    const requestRepository = getRepository(MediaRequest);
    const pending = await seedRequest();
    pending.serverId = 341;
    pending.media.status = MediaStatus.PENDING;
    await getRepository(Media).save(pending.media);
    await requestRepository.save(pending);
    t.mock.method(
      MediaRequestSubscriber.prototype,
      'sendToRadarr',
      async () => undefined
    );

    const response = await (
      await loginAs('admin@seerr.dev', 'test1234')
    ).post(`/request/${pending.id}/approve`);
    const persistedMedia = await getRepository(Media).findOneByOrFail({
      id: pending.media.id,
    });

    assert.strictEqual(response.status, 200);
    assert.strictEqual(persistedMedia.status, MediaStatus.PROCESSING);
    assert.strictEqual(response.body.target.status, persistedMedia.status);
    assert.strictEqual(response.body.target.serverId, 341);
    assert.strictEqual(response.body.target.isIndependent, false);
  });

  it('keeps independent approval state isolated from contradictory native state', async (t) => {
    configureRadarr([
      { id: 342, isDefault: true, independentRequestDestination: true },
    ]);
    const pending = await seedRequest();
    pending.media.status = MediaStatus.AVAILABLE;
    await getRepository(Media).save(pending.media);
    await getRepository(MediaRequest)
      .createQueryBuilder()
      .update(MediaRequest)
      .set({ serverId: 342 })
      .where('id = :id', { id: pending.id })
      .callListeners(false)
      .execute();
    await getRepository(MediaDestinationStatus).save(
      new MediaDestinationStatus({
        mediaId: pending.media.id,
        serverId: 342,
        status: MediaStatus.UNKNOWN,
      })
    );
    t.mock.method(
      MediaRequestSubscriber.prototype,
      'sendToRadarr',
      async () => undefined
    );

    const response = await (
      await loginAs('admin@seerr.dev', 'test1234')
    ).post(`/request/${pending.id}/approve`);
    const destination = await getRepository(
      MediaDestinationStatus
    ).findOneByOrFail({
      mediaId: pending.media.id,
      serverId: 342,
    });

    assert.strictEqual(response.status, 200);
    assert.strictEqual(response.body.target.status, destination.status);
    assert.notStrictEqual(response.body.target.status, MediaStatus.AVAILABLE);
    assert.strictEqual(response.body.target.serverId, 342);
    assert.strictEqual(response.body.target.isIndependent, true);
  });

  it('rejects a status the route does not define', async () => {
    const repo = getRepository(MediaRequest);
    const pending = await seedRequest();
    const admin = await loginAs('admin@seerr.dev', 'test1234');

    const res = await admin.post(`/request/${pending.id}/frobnicate`);

    assert.strictEqual(res.status, 400);
    assert.match(res.body.message, /approve/i);

    const persisted = await repo.findOneOrFail({
      where: { id: pending.id },
      relations: { modifiedBy: true },
    });
    assert.strictEqual(persisted.status, MediaRequestStatus.PENDING);
    assert.ok(!persisted.modifiedBy);
  });

  it('refuses to act on a request that is no longer pending', async () => {
    const repo = getRepository(MediaRequest);
    const approved = await seedRequest(MediaRequestStatus.APPROVED);
    const admin = await loginAs('admin@seerr.dev', 'test1234');

    const res = await admin.post(`/request/${approved.id}/decline`);

    assert.strictEqual(res.status, 409);
    assert.match(res.body.message, /pending/i);

    const persisted = await repo.findOneOrFail({ where: { id: approved.id } });
    assert.strictEqual(persisted.status, MediaRequestStatus.APPROVED);
  });

  it('applies only one of a concurrent approve and decline', async () => {
    const repo = getRepository(MediaRequest);
    const pending = await seedRequest();
    const admin = await loginAs('admin@seerr.dev', 'test1234');

    const [approve, decline] = await Promise.all([
      admin.post(`/request/${pending.id}/approve`),
      admin.post(`/request/${pending.id}/decline`),
    ]);

    assert.deepStrictEqual([approve.status, decline.status].sort(), [200, 409]);

    const persisted = await repo.findOneOrFail({ where: { id: pending.id } });
    assert.strictEqual(
      persisted.status,
      approve.status === 200
        ? MediaRequestStatus.APPROVED
        : MediaRequestStatus.DECLINED
    );
  });

  it('rejects the removed pending verb even on a non-pending request', async () => {
    const repo = getRepository(MediaRequest);
    const declined = await seedRequest(MediaRequestStatus.DECLINED);
    const admin = await loginAs('admin@seerr.dev', 'test1234');

    const res = await admin.post(`/request/${declined.id}/pending`);

    assert.strictEqual(res.status, 400);
    assert.match(res.body.message, /approve/i);

    const persisted = await repo.findOneOrFail({ where: { id: declined.id } });
    assert.strictEqual(persisted.status, MediaRequestStatus.DECLINED);
  });
});

describe('POST /request/:requestId/retry', () => {
  it('returns freshly persisted native target state after retry', async (t) => {
    configureRadarr([
      { id: 343, isDefault: true, independentRequestDestination: false },
    ]);
    const requestRepository = getRepository(MediaRequest);
    const failed = await seedRequest(MediaRequestStatus.FAILED);
    failed.serverId = 343;
    failed.media.status = MediaStatus.PENDING;
    await getRepository(Media).save(failed.media);
    await requestRepository.save(failed);
    t.mock.method(
      MediaRequestSubscriber.prototype,
      'sendToRadarr',
      async () => undefined
    );

    const response = await (
      await loginAs('admin@seerr.dev', 'test1234')
    ).post(`/request/${failed.id}/retry`);
    const persistedMedia = await getRepository(Media).findOneByOrFail({
      id: failed.media.id,
    });

    assert.strictEqual(response.status, 200);
    assert.strictEqual(persistedMedia.status, MediaStatus.PROCESSING);
    assert.strictEqual(response.body.target.status, persistedMedia.status);
    assert.strictEqual(response.body.target.serverId, 343);
    assert.strictEqual(response.body.target.isIndependent, false);
  });

  it('preserves default fallback for a legacy request without serverId', async () => {
    const repo = getRepository(MediaRequest);
    const failed = await seedRequest(MediaRequestStatus.FAILED);
    const admin = await loginAs('admin@seerr.dev', 'test1234');

    const res = await admin.post(`/request/${failed.id}/retry`);

    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.status, MediaRequestStatus.APPROVED);
    assert.strictEqual(res.body.modifiedBy.email, 'admin@seerr.dev');

    const persisted = await repo.findOneOrFail({
      where: { id: failed.id },
      relations: { modifiedBy: true },
    });

    assert.strictEqual(persisted.status, MediaRequestStatus.APPROVED);
    assert.strictEqual(persisted.serverId, null);
    assert.strictEqual(persisted.modifiedBy?.email, 'admin@seerr.dev');
    assert.ok(persisted.updatedAt > failed.updatedAt);
  });

  it('refuses to retry a request that has not failed', async () => {
    const repo = getRepository(MediaRequest);
    const pending = await seedRequest();
    const admin = await loginAs('admin@seerr.dev', 'test1234');

    const res = await admin.post(`/request/${pending.id}/retry`);

    assert.strictEqual(res.status, 409);
    assert.match(res.body.message, /failed/i);

    const persisted = await repo.findOneOrFail({ where: { id: pending.id } });
    assert.strictEqual(persisted.status, MediaRequestStatus.PENDING);
  });

  it('sends a concurrently retried request to *arr once', async (t) => {
    const repo = getRepository(MediaRequest);
    const failed = await seedRequest(MediaRequestStatus.FAILED);
    const admin = await loginAs('admin@seerr.dev', 'test1234');

    const sendToRadarr = t.mock.method(
      MediaRequestSubscriber.prototype,
      'sendToRadarr',
      async () => undefined
    );

    const results = await Promise.all([
      admin.post(`/request/${failed.id}/retry`),
      admin.post(`/request/${failed.id}/retry`),
    ]);

    assert.deepStrictEqual(results.map((r) => r.status).sort(), [200, 409]);
    assert.strictEqual(sendToRadarr.mock.callCount(), 1);

    const persisted = await repo.findOneOrFail({ where: { id: failed.id } });
    assert.strictEqual(persisted.status, MediaRequestStatus.APPROVED);
  });

  it('retries an independent request on its stored server after the default changes', async (t) => {
    configureRadarr([
      { id: 41, independentRequestDestination: true, isDefault: false },
      { id: 42, independentRequestDestination: true, isDefault: true },
    ]);
    const repo = getRepository(MediaRequest);
    const failed = await seedRequest(MediaRequestStatus.FAILED);
    failed.serverId = 41;
    await repo.save(failed);
    await getRepository(MediaDestinationStatus).save(
      new MediaDestinationStatus({
        mediaId: failed.media.id,
        serverId: 41,
        status: MediaStatus.UNKNOWN,
      })
    );
    t.mock.method(
      MediaRequestSubscriber.prototype,
      'sendToRadarr',
      async () => undefined
    );

    const admin = await loginAs('admin@seerr.dev', 'test1234');
    const res = await admin.post(`/request/${failed.id}/retry`);

    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.serverId, 41);
  });

  it('retries a native request on its stored server after the default changes', async (t) => {
    configureRadarr([
      { id: 43, independentRequestDestination: false, isDefault: false },
      { id: 44, independentRequestDestination: false, isDefault: true },
    ]);
    const repo = getRepository(MediaRequest);
    const failed = await seedRequest(MediaRequestStatus.FAILED);
    failed.serverId = 43;
    await repo.save(failed);
    const dispatchedTargets: (number | null)[] = [];
    t.mock.method(
      MediaRequestSubscriber.prototype,
      'sendToRadarr',
      async (request: MediaRequest) => {
        dispatchedTargets.push(request.serverId);
      }
    );

    const admin = await loginAs('admin@seerr.dev', 'test1234');
    const res = await admin.post(`/request/${failed.id}/retry`);

    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.serverId, 43);
    assert.deepStrictEqual(dispatchedTargets, [43]);
  });

  for (const scenario of [
    { name: 'independent', independent: true, serverId: 71 },
    { name: 'native', independent: false, serverId: 72 },
  ]) {
    it(`${scenario.name} retry wins against concurrent server deletion`, async (t) => {
      configureRadarr([
        {
          id: scenario.serverId,
          independentRequestDestination: scenario.independent,
          isDefault: true,
        },
      ]);
      t.mock.method(getSettings(), 'save', async () => undefined);
      const repo = getRepository(MediaRequest);
      const failed = await seedRequest(MediaRequestStatus.FAILED);
      failed.serverId = scenario.serverId;
      await repo.save(failed);
      if (scenario.independent) {
        await getRepository(MediaDestinationStatus).save(
          new MediaDestinationStatus({
            mediaId: failed.media.id,
            serverId: scenario.serverId,
            status: MediaStatus.UNKNOWN,
          })
        );
      }
      const pause = pauseRequestBeforeUpdate(t);
      const sendToRadarr = t.mock.method(
        MediaRequestSubscriber.prototype,
        'sendToRadarr',
        async () => undefined
      );
      const admin = await loginAs('admin@seerr.dev', 'test1234');

      const retry = admin.post(`/request/${failed.id}/retry`);
      const retryPromise = retry.then((response) => response);
      await pause.reached;

      let deletionSettled = false;
      const deletion = request(app)
        .delete(`/settings/radarr/${scenario.serverId}`)
        .then((response) => {
          deletionSettled = true;
          return response;
        });
      await nextTurn();
      await nextTurn();
      assert.strictEqual(deletionSettled, false);

      pause.resume();
      const retryResponse = await retryPromise;
      const deletionResponse = await deletion;

      assert.strictEqual(retryResponse.status, 200);
      assert.strictEqual(retryResponse.body.serverId, scenario.serverId);
      assert.strictEqual(deletionResponse.status, 409);
      const persisted = await repo.findOneOrFail({
        where: { id: failed.id },
      });
      assert.strictEqual(persisted.status, MediaRequestStatus.APPROVED);
      assert.strictEqual(persisted.serverId, scenario.serverId);
      assert.strictEqual(sendToRadarr.mock.callCount(), 1);
      assert.ok(
        getSettings().radarr.some((server) => server.id === scenario.serverId)
      );
    });

    it(`${scenario.name} server deletion wins against concurrent retry`, async (t) => {
      configureRadarr([
        {
          id: scenario.serverId,
          independentRequestDestination: scenario.independent,
          isDefault: true,
        },
      ]);
      t.mock.method(getSettings(), 'save', async () => undefined);
      const repo = getRepository(MediaRequest);
      const failed = await seedRequest(MediaRequestStatus.FAILED);
      failed.serverId = scenario.serverId;
      await repo.save(failed);
      if (scenario.independent) {
        await getRepository(MediaDestinationStatus).save(
          new MediaDestinationStatus({
            mediaId: failed.media.id,
            serverId: scenario.serverId,
            status: MediaStatus.UNKNOWN,
          })
        );
      }
      const sendToRadarr = t.mock.method(
        MediaRequestSubscriber.prototype,
        'sendToRadarr',
        async () => undefined
      );
      const admin = await loginAs('admin@seerr.dev', 'test1234');
      let signalDeleteValidation!: () => void;
      const deleteValidationReached = new Promise<void>((resolve) => {
        signalDeleteValidation = resolve;
      });
      let resumeDeleteValidation!: () => void;
      const deleteValidationResumed = new Promise<void>((resolve) => {
        resumeDeleteValidation = resolve;
      });
      t.mock.method(repo, 'existsBy', async () => {
        signalDeleteValidation();
        await deleteValidationResumed;
        return false;
      });

      const deletion = request(app).delete(
        `/settings/radarr/${scenario.serverId}`
      );
      const deletionPromise = deletion.then((response) => response);
      await deleteValidationReached;
      const retry = admin.post(`/request/${failed.id}/retry`);
      const retryPromise = retry.then((response) => response);

      resumeDeleteValidation();
      const deletionResponse = await deletionPromise;
      const retryResponse = await retryPromise;

      assert.strictEqual(deletionResponse.status, 200);
      assert.strictEqual(retryResponse.status, 409);
      const persisted = await repo.findOneOrFail({
        where: { id: failed.id },
      });
      assert.strictEqual(persisted.status, MediaRequestStatus.FAILED);
      assert.strictEqual(persisted.serverId, scenario.serverId);
      assert.strictEqual(sendToRadarr.mock.callCount(), 0);
      assert.ok(
        !getSettings().radarr.some((server) => server.id === scenario.serverId)
      );

      if (scenario.independent) {
        const destination = await getRepository(
          MediaDestinationStatus
        ).findOneOrFail({
          where: {
            mediaId: failed.media.id,
            serverId: scenario.serverId,
          },
        });
        assert.strictEqual(destination.status, MediaStatus.UNKNOWN);
      } else {
        const media = await getRepository(Media).findOneOrFail({
          where: { id: failed.media.id },
        });
        assert.strictEqual(media.status, MediaStatus.UNKNOWN);
        assert.strictEqual(media.status4k, MediaStatus.UNKNOWN);
      }
    });
  }

  it('rejects native movie retry when another native request occupies the slot', async (t) => {
    configureRadarr([
      { id: 45, independentRequestDestination: false, isDefault: true },
    ]);
    const repo = getRepository(MediaRequest);
    const failed = await seedRequest(MediaRequestStatus.FAILED);
    failed.serverId = 45;
    await repo.save(failed);
    const active = await repo.save(
      new MediaRequest({
        type: MediaType.MOVIE,
        status: MediaRequestStatus.PENDING,
        media: failed.media,
        requestedBy: failed.requestedBy,
        is4k: false,
        serverId: 45,
      })
    );
    const sendToRadarr = t.mock.method(
      MediaRequestSubscriber.prototype,
      'sendToRadarr',
      async () => undefined
    );

    const admin = await loginAs('admin@seerr.dev', 'test1234');
    const res = await admin.post(`/request/${failed.id}/retry`);

    assert.strictEqual(res.status, 409);
    assert.strictEqual(
      (await repo.findOneOrFail({ where: { id: failed.id } })).status,
      MediaRequestStatus.FAILED
    );
    assert.strictEqual(
      (await repo.findOneOrFail({ where: { id: active.id } })).status,
      MediaRequestStatus.PENDING
    );
    assert.strictEqual(sendToRadarr.mock.callCount(), 0);
  });

  it('rejects native TV retry when another native request overlaps a season', async () => {
    configureSonarr([
      { id: 46, independentRequestDestination: false, isDefault: true },
    ]);
    const owner = await seedUser('demo@seerr.dev');
    const repo = getRepository(MediaRequest);
    const failed = await seedTvRequest(owner, [1, 2], { tmdbId: 67904 });
    failed.status = MediaRequestStatus.FAILED;
    failed.serverId = 46;
    await repo.save(failed);
    const active = await repo.save(
      new MediaRequest({
        type: MediaType.TV,
        status: MediaRequestStatus.PENDING,
        media: failed.media,
        requestedBy: owner,
        is4k: false,
        serverId: 46,
        seasons: [
          new SeasonRequest({
            seasonNumber: 2,
            status: MediaRequestStatus.PENDING,
          }),
        ],
      })
    );

    const admin = await loginAs('admin@seerr.dev', 'test1234');
    const res = await admin.post(`/request/${failed.id}/retry`);

    assert.strictEqual(res.status, 409);
    assert.strictEqual(
      (await repo.findOneOrFail({ where: { id: failed.id } })).status,
      MediaRequestStatus.FAILED
    );
    assert.strictEqual(
      (await repo.findOneOrFail({ where: { id: active.id } })).status,
      MediaRequestStatus.PENDING
    );
  });

  it('allows native retry when only an independent request is active', async (t) => {
    configureRadarr([
      { id: 47, independentRequestDestination: false, isDefault: true },
      { id: 48, independentRequestDestination: true, isDefault: false },
    ]);
    const repo = getRepository(MediaRequest);
    const failed = await seedRequest(MediaRequestStatus.FAILED);
    failed.serverId = 47;
    await repo.save(failed);
    await repo.save(
      new MediaRequest({
        type: MediaType.MOVIE,
        status: MediaRequestStatus.PENDING,
        media: failed.media,
        requestedBy: failed.requestedBy,
        is4k: false,
        serverId: 48,
      })
    );
    const sendToRadarr = t.mock.method(
      MediaRequestSubscriber.prototype,
      'sendToRadarr',
      async () => undefined
    );

    const admin = await loginAs('admin@seerr.dev', 'test1234');
    const res = await admin.post(`/request/${failed.id}/retry`);

    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.status, MediaRequestStatus.APPROVED);
    assert.strictEqual(sendToRadarr.mock.callCount(), 1);
  });

  it('rejects retry when a persisted native server was deleted', async (t) => {
    configureRadarr([
      { id: 54, independentRequestDestination: false, isDefault: true },
    ]);
    const repo = getRepository(MediaRequest);
    const failed = await seedRequest(MediaRequestStatus.FAILED);
    failed.serverId = 53;
    await repo.save(failed);
    const sendToRadarr = t.mock.method(
      MediaRequestSubscriber.prototype,
      'sendToRadarr',
      async () => undefined
    );

    const admin = await loginAs('admin@seerr.dev', 'test1234');
    const res = await admin.post(`/request/${failed.id}/retry`);

    assert.strictEqual(res.status, 409);
    const persisted = await repo.findOneOrFail({ where: { id: failed.id } });
    assert.strictEqual(persisted.status, MediaRequestStatus.FAILED);
    assert.strictEqual(persisted.serverId, 53);
    assert.strictEqual(sendToRadarr.mock.callCount(), 0);
  });

  it('rejects retry when the independent server was deleted', async () => {
    getSettings().radarr = [];
    const repo = getRepository(MediaRequest);
    const failed = await seedRequest(MediaRequestStatus.FAILED);
    failed.serverId = 51;
    await repo.save(failed);
    await getRepository(MediaDestinationStatus).save(
      new MediaDestinationStatus({
        mediaId: failed.media.id,
        serverId: 51,
        status: MediaStatus.UNKNOWN,
      })
    );

    const admin = await loginAs('admin@seerr.dev', 'test1234');
    const res = await admin.post(`/request/${failed.id}/retry`);

    assert.strictEqual(res.status, 409);
  });

  it('rejects retry when another request occupies the independent slot', async () => {
    configureRadarr([
      { id: 61, independentRequestDestination: true, isDefault: true },
    ]);
    const repo = getRepository(MediaRequest);
    const failed = await seedRequest(MediaRequestStatus.FAILED);
    failed.serverId = 61;
    await repo.save(failed);
    await getRepository(MediaDestinationStatus).save(
      new MediaDestinationStatus({
        mediaId: failed.media.id,
        serverId: 61,
        status: MediaStatus.UNKNOWN,
      })
    );
    await repo.save(
      new MediaRequest({
        type: MediaType.MOVIE,
        status: MediaRequestStatus.PENDING,
        media: failed.media,
        requestedBy: failed.requestedBy,
        is4k: false,
        serverId: 61,
      })
    );

    const admin = await loginAs('admin@seerr.dev', 'test1234');
    const res = await admin.post(`/request/${failed.id}/retry`);

    assert.strictEqual(res.status, 409);
  });
});

describe('DELETE /request/:requestId, deleted media status restoration', () => {
  async function seedDeletedMediaScenario() {
    const userRepo = getRepository(User);
    const mediaRepo = getRepository(Media);
    const requestRepo = getRepository(MediaRequest);

    const admin = await userRepo.findOneOrFail({
      where: { email: 'admin@seerr.dev' },
    });

    const media = await mediaRepo.save(
      new Media({
        mediaType: MediaType.MOVIE,
        tmdbId: 99001,
        status: MediaStatus.DELETED,
        status4k: MediaStatus.UNKNOWN,
      })
    );

    const staleRequest = await requestRepo.save(
      new MediaRequest({
        type: MediaType.MOVIE,
        status: MediaRequestStatus.COMPLETED,
        media,
        requestedBy: admin,
        is4k: false,
        isAutoRequest: true,
      })
    );

    media.status = MediaStatus.PENDING;
    await mediaRepo.save(media);

    const newRequest = await requestRepo.save(
      new MediaRequest({
        type: MediaType.MOVIE,
        status: MediaRequestStatus.APPROVED,
        media,
        requestedBy: admin,
        is4k: false,
      })
    );

    return { media, staleRequest, newRequest, admin };
  }

  it('restores media status to DELETED when the re-request is deleted and a stale completed request remains', async () => {
    const mediaRepo = getRepository(Media);
    const { media, newRequest } = await seedDeletedMediaScenario();

    const agent = await loginAs('admin@seerr.dev', 'test1234');
    const res = await agent.delete(`/request/${newRequest.id}`);

    assert.strictEqual(res.status, 204);

    const updated = await mediaRepo.findOneOrFail({ where: { id: media.id } });
    assert.strictEqual(updated.status, MediaStatus.DELETED);
  });

  it('restores media status4k to DELETED when the re-request is deleted and a stale completed request remains', async () => {
    const userRepo = getRepository(User);
    const mediaRepo = getRepository(Media);
    const requestRepo = getRepository(MediaRequest);

    const admin = await userRepo.findOneOrFail({
      where: { email: 'admin@seerr.dev' },
    });

    const media = await mediaRepo.save(
      new Media({
        mediaType: MediaType.MOVIE,
        tmdbId: 99003,
        status: MediaStatus.UNKNOWN,
        status4k: MediaStatus.DELETED,
      })
    );

    await requestRepo.save(
      new MediaRequest({
        type: MediaType.MOVIE,
        status: MediaRequestStatus.COMPLETED,
        media,
        requestedBy: admin,
        is4k: true,
        isAutoRequest: true,
      })
    );

    media.status4k = MediaStatus.PENDING;
    await mediaRepo.save(media);

    const newRequest = await requestRepo.save(
      new MediaRequest({
        type: MediaType.MOVIE,
        status: MediaRequestStatus.APPROVED,
        media,
        requestedBy: admin,
        is4k: true,
      })
    );

    const agent = await loginAs('admin@seerr.dev', 'test1234');
    const res = await agent.delete(`/request/${newRequest.id}`);

    assert.strictEqual(res.status, 204);

    const updated = await mediaRepo.findOneOrFail({ where: { id: media.id } });
    assert.strictEqual(updated.status4k, MediaStatus.DELETED);
  });

  it('resets media status to UNKNOWN when the stale completed request is also deleted', async () => {
    const mediaRepo = getRepository(Media);
    const requestRepo = getRepository(MediaRequest);
    const { media, newRequest, staleRequest } =
      await seedDeletedMediaScenario();

    const agent = await loginAs('admin@seerr.dev', 'test1234');

    await agent.delete(`/request/${newRequest.id}`);

    const res = await agent.delete(`/request/${staleRequest.id}`);
    assert.strictEqual(res.status, 204);

    const updated = await mediaRepo.findOneOrFail({ where: { id: media.id } });
    assert.strictEqual(updated.status, MediaStatus.UNKNOWN);

    const remaining = await requestRepo.find({
      where: { media: { id: media.id } },
    });
    assert.strictEqual(remaining.length, 0);
  });

  it('resets media status4k to UNKNOWN when the stale completed 4K request is also deleted', async () => {
    const userRepo = getRepository(User);
    const mediaRepo = getRepository(Media);
    const requestRepo = getRepository(MediaRequest);

    const admin = await userRepo.findOneOrFail({
      where: { email: 'admin@seerr.dev' },
    });

    const media = await mediaRepo.save(
      new Media({
        mediaType: MediaType.MOVIE,
        tmdbId: 99004,
        status: MediaStatus.UNKNOWN,
        status4k: MediaStatus.DELETED,
      })
    );

    const staleRequest = await requestRepo.save(
      new MediaRequest({
        type: MediaType.MOVIE,
        status: MediaRequestStatus.COMPLETED,
        media,
        requestedBy: admin,
        is4k: true,
        isAutoRequest: true,
      })
    );

    media.status4k = MediaStatus.PENDING;
    await mediaRepo.save(media);

    const newRequest = await requestRepo.save(
      new MediaRequest({
        type: MediaType.MOVIE,
        status: MediaRequestStatus.APPROVED,
        media,
        requestedBy: admin,
        is4k: true,
      })
    );

    const agent = await loginAs('admin@seerr.dev', 'test1234');

    await agent.delete(`/request/${newRequest.id}`);

    const res = await agent.delete(`/request/${staleRequest.id}`);
    assert.strictEqual(res.status, 204);

    const updated = await mediaRepo.findOneOrFail({ where: { id: media.id } });
    assert.strictEqual(updated.status4k, MediaStatus.UNKNOWN);
  });

  it('does not reset media status when other active requests still exist', async () => {
    const userRepo = getRepository(User);
    const mediaRepo = getRepository(Media);
    const requestRepo = getRepository(MediaRequest);

    const admin = await userRepo.findOneOrFail({
      where: { email: 'admin@seerr.dev' },
    });

    const media = await mediaRepo.save(
      new Media({
        mediaType: MediaType.MOVIE,
        tmdbId: 99002,
        status: MediaStatus.PENDING,
        status4k: MediaStatus.UNKNOWN,
      })
    );

    const req1 = await requestRepo.save(
      new MediaRequest({
        type: MediaType.MOVIE,
        status: MediaRequestStatus.PENDING,
        media,
        requestedBy: admin,
        is4k: false,
      })
    );

    await requestRepo.save(
      new MediaRequest({
        type: MediaType.MOVIE,
        status: MediaRequestStatus.PENDING,
        media,
        requestedBy: admin,
        is4k: false,
      })
    );

    const agent = await loginAs('admin@seerr.dev', 'test1234');
    const res = await agent.delete(`/request/${req1.id}`);

    assert.strictEqual(res.status, 204);

    const updated = await mediaRepo.findOneOrFail({ where: { id: media.id } });
    assert.strictEqual(updated.status, MediaStatus.PENDING);
  });

  it('does not reset media status when status is PARTIALLY_AVAILABLE and only completed requests remain', async () => {
    const userRepo = getRepository(User);
    const mediaRepo = getRepository(Media);
    const requestRepo = getRepository(MediaRequest);

    const admin = await userRepo.findOneOrFail({
      where: { email: 'admin@seerr.dev' },
    });

    const media = await mediaRepo.save(
      new Media({
        mediaType: MediaType.MOVIE,
        tmdbId: 99005,
        status: MediaStatus.PARTIALLY_AVAILABLE,
        status4k: MediaStatus.UNKNOWN,
      })
    );

    const completedRequest = await requestRepo.save(
      new MediaRequest({
        type: MediaType.MOVIE,
        status: MediaRequestStatus.COMPLETED,
        media,
        requestedBy: admin,
        is4k: false,
      })
    );

    const agent = await loginAs('admin@seerr.dev', 'test1234');
    const res = await agent.delete(`/request/${completedRequest.id}`);

    assert.strictEqual(res.status, 204);

    const updated = await mediaRepo.findOneOrFail({ where: { id: media.id } });
    assert.strictEqual(updated.status, MediaStatus.PARTIALLY_AVAILABLE);
  });
});

describe('POST /request (movie), override rules', () => {
  it('uses the explicit independent server for override rules instead of the default', async () => {
    configureRadarr([
      { id: 71, isDefault: true, independentRequestDestination: true },
      { id: 72, isDefault: false, independentRequestDestination: true },
    ]);
    getSettings().sonarr = [];
    await getRepository(OverrideRule).save([
      new OverrideRule({
        radarrServiceId: 71,
        rootFolder: '/default',
      }),
      new OverrideRule({
        radarrServiceId: 72,
        rootFolder: '/explicit',
      }),
    ]);

    const agent = await loginAs('demo@seerr.dev', 'test1234');
    const res = await agent.post('/request').send({
      mediaType: MediaType.MOVIE,
      mediaId: 87999,
      serverId: 72,
    });

    assert.strictEqual(res.status, 201);
    assert.strictEqual(res.body.serverId, 72);
    assert.strictEqual(res.body.rootFolder, '/explicit');
    assert.strictEqual(res.body.target.serverId, 72);
    assert.strictEqual(res.body.target.isIndependent, true);
  });

  it('rejects an unknown explicit server and a desynchronized independent server', async () => {
    configureRadarr([
      {
        id: 73,
        isDefault: true,
        independentRequestDestination: true,
        syncEnabled: false,
      },
    ]);
    getSettings().sonarr = [];
    const agent = await loginAs('demo@seerr.dev', 'test1234');

    const unknown = await agent.post('/request').send({
      mediaType: MediaType.MOVIE,
      mediaId: 87997,
      serverId: 999,
    });
    const incoherent = await agent.post('/request').send({
      mediaType: MediaType.MOVIE,
      mediaId: 87998,
      serverId: 73,
    });

    assert.strictEqual(unknown.status, 400);
    assert.strictEqual(incoherent.status, 400);
  });

  it('applies an override rule when the default Radarr server id differs from its array index', async () => {
    configureRadarr([{ id: 5, isDefault: true, is4k: false }]);
    getSettings().sonarr = [];

    const userRepo = getRepository(User);
    const friend = await userRepo.findOneOrFail({
      where: { email: 'demo@seerr.dev' },
    });

    const overrideRuleRepo = getRepository(OverrideRule);
    await overrideRuleRepo.save(
      new OverrideRule({
        radarrServiceId: 5,
        users: String(friend.id),
        rootFolder: '/overridden/movies',
      })
    );

    const agent = await loginAs('demo@seerr.dev', 'test1234');
    const res = await agent.post('/request').send({
      mediaType: MediaType.MOVIE,
      mediaId: 88001,
    });

    assert.strictEqual(res.status, 201);
    assert.strictEqual(res.body.rootFolder, '/overridden/movies');
  });

  it('applies an override rule when the default Radarr server id matches its array index (sanity check)', async () => {
    configureRadarr([{ id: 0, isDefault: true, is4k: false }]);
    getSettings().sonarr = [];

    const userRepo = getRepository(User);
    const friend = await userRepo.findOneOrFail({
      where: { email: 'demo@seerr.dev' },
    });

    const overrideRuleRepo = getRepository(OverrideRule);
    await overrideRuleRepo.save(
      new OverrideRule({
        radarrServiceId: 0,
        users: String(friend.id),
        rootFolder: '/overridden/movies',
      })
    );

    const agent = await loginAs('demo@seerr.dev', 'test1234');
    const res = await agent.post('/request').send({
      mediaType: MediaType.MOVIE,
      mediaId: 88002,
    });

    assert.strictEqual(res.status, 201);
    assert.strictEqual(res.body.rootFolder, '/overridden/movies');
  });

  it('rejects a movie request when there is no resolvable Radarr target', async () => {
    getSettings().radarr = [];
    getSettings().sonarr = [];

    const userRepo = getRepository(User);
    const friend = await userRepo.findOneOrFail({
      where: { email: 'demo@seerr.dev' },
    });

    const overrideRuleRepo = getRepository(OverrideRule);
    await overrideRuleRepo.save(
      new OverrideRule({
        radarrServiceId: 999,
        users: String(friend.id),
        rootFolder: '/overridden/movies',
      })
    );

    const agent = await loginAs('demo@seerr.dev', 'test1234');
    const res = await agent.post('/request').send({
      mediaType: MediaType.MOVIE,
      mediaId: 88005,
    });

    assert.strictEqual(res.status, 400);
  });
});

describe('POST /request (tv), override rules', () => {
  it('applies an override rule when the default Sonarr server id differs from its array index', async () => {
    configureSonarr([{ id: 5, isDefault: true, is4k: false }]);
    getSettings().radarr = [];

    const userRepo = getRepository(User);
    const friend = await userRepo.findOneOrFail({
      where: { email: 'demo@seerr.dev' },
    });

    const overrideRuleRepo = getRepository(OverrideRule);
    await overrideRuleRepo.save(
      new OverrideRule({
        sonarrServiceId: 5,
        users: String(friend.id),
        rootFolder: '/overridden/tv',
      })
    );

    const agent = await loginAs('demo@seerr.dev', 'test1234');
    const res = await agent.post('/request').send({
      mediaType: MediaType.TV,
      mediaId: 88003,
      seasons: [1],
    });

    assert.strictEqual(res.status, 201);
    assert.strictEqual(res.body.rootFolder, '/overridden/tv');
  });

  it('applies an override rule when the default Sonarr server id matches its array index (sanity check)', async () => {
    configureSonarr([{ id: 0, isDefault: true, is4k: false }]);
    getSettings().radarr = [];

    const userRepo = getRepository(User);
    const friend = await userRepo.findOneOrFail({
      where: { email: 'demo@seerr.dev' },
    });

    const overrideRuleRepo = getRepository(OverrideRule);
    await overrideRuleRepo.save(
      new OverrideRule({
        sonarrServiceId: 0,
        users: String(friend.id),
        rootFolder: '/overridden/tv',
      })
    );

    const agent = await loginAs('demo@seerr.dev', 'test1234');
    const res = await agent.post('/request').send({
      mediaType: MediaType.TV,
      mediaId: 88004,
      seasons: [1],
    });

    assert.strictEqual(res.status, 201);
    assert.strictEqual(res.body.rootFolder, '/overridden/tv');
  });

  it('rejects a TV request when there is no resolvable Sonarr target', async () => {
    getSettings().radarr = [];
    getSettings().sonarr = [];

    const userRepo = getRepository(User);
    const friend = await userRepo.findOneOrFail({
      where: { email: 'demo@seerr.dev' },
    });

    const overrideRuleRepo = getRepository(OverrideRule);
    await overrideRuleRepo.save(
      new OverrideRule({
        sonarrServiceId: 999,
        users: String(friend.id),
        rootFolder: '/overridden/tv',
      })
    );

    const agent = await loginAs('demo@seerr.dev', 'test1234');
    const res = await agent.post('/request').send({
      mediaType: MediaType.TV,
      mediaId: 88006,
      seasons: [1],
    });

    assert.strictEqual(res.status, 400);
  });
});

describe('POST /request, override rules and requester choices', () => {
  it('evaluates omitted collection configuration independently for each movie', async (t) => {
    configureRadarr([{ id: 42, tags: [1] }]);
    const requester = await getRepository(User).findOneOrFail({
      where: { email: 'demo@seerr.dev' },
    });
    requester.permissions = Permission.REQUEST | Permission.REQUEST_ADVANCED;
    await getRepository(User).save(requester);
    t.mock.getter(
      TheMovieDb.prototype,
      'getMovie',
      () =>
        async ({ movieId }: { movieId: number }) => ({
          ...fakeTmdbMovie(movieId),
          genres: [{ id: movieId, name: 'Collection part genre' }],
        })
    );
    await getRepository(OverrideRule).save([
      new OverrideRule({
        radarrServiceId: 42,
        genre: '88400',
        profileId: 7,
        rootFolder: '/first',
        tags: '2',
      }),
      new OverrideRule({
        radarrServiceId: 42,
        genre: '88401',
        profileId: 8,
        rootFolder: '/second',
        tags: '3',
      }),
    ]);
    const agent = await loginAs('demo@seerr.dev', 'test1234');
    for (const [mediaId, profileId, rootFolder, tags] of [
      [88400, 7, '/first', [2]],
      [88401, 8, '/second', [3]],
    ] as [number, number, string, number[]][]) {
      const res = await agent.post('/request').send({
        mediaType: MediaType.MOVIE,
        mediaId,
        serverId: 42,
      });
      assert.equal(res.status, 201);
      const persisted = await getRepository(MediaRequest).findOneByOrFail({
        id: res.body.id,
      });
      assert.equal(persisted.serverId, 42);
      assert.equal(persisted.requestedBy.id, requester.id);
      assert.equal(persisted.profileId, profileId);
      assert.equal(persisted.rootFolder, rootFolder);
      assert.deepEqual(persisted.tags, tags);
    }
  });

  for (const mediaType of [MediaType.MOVIE, MediaType.TV]) {
    for (const independent of [false, true]) {
      const configure =
        mediaType === MediaType.MOVIE ? configureRadarr : configureSonarr;
      const serviceField =
        mediaType === MediaType.MOVIE ? 'radarrServiceId' : 'sonarrServiceId';
      const configurations = [
        {
          name: 'no manual configuration',
          manual: {},
          expected: { profileId: 7, rootFolder: '/rule', tags: [2] },
        },
        {
          name: 'manual profile',
          manual: { profileId: 9 },
          expected: { profileId: 9, rootFolder: '/rule', tags: [2] },
        },
        {
          name: 'manual folder',
          manual: { rootFolder: '/chosen' },
          expected: { profileId: 7, rootFolder: '/chosen', tags: [2] },
        },
        {
          name: 'explicit empty tags',
          manual: { tags: [] },
          expected: { profileId: 7, rootFolder: '/rule', tags: [] },
        },
        {
          name: 'manual tags',
          manual: { tags: [3] },
          expected: { profileId: 7, rootFolder: '/rule', tags: [3] },
        },
        {
          name: 'explicit default profile',
          manual: { profileId: 1 },
          expected: { profileId: 1, rootFolder: '/rule', tags: [2] },
        },
        ...(mediaType === MediaType.TV
          ? [
              {
                name: 'manual language',
                manual: { languageProfileId: 9 },
                expected: { profileId: 7, rootFolder: '/rule', tags: [2] },
              },
            ]
          : []),
      ];

      for (const { name, manual, expected } of configurations) {
        it(`preserves ${name} for an advanced ${mediaType} requester on a ${independent ? 'independent' : 'native'} destination`, async () => {
          configure([
            { id: 41, independentRequestDestination: independent, tags: [1] },
          ]);
          const requester = await getRepository(User).findOneOrFail({
            where: { email: 'demo@seerr.dev' },
          });
          requester.permissions =
            Permission.REQUEST | Permission.REQUEST_ADVANCED;
          await getRepository(User).save(requester);
          await getRepository(OverrideRule).save(
            new OverrideRule({
              [serviceField]: 41,
              profileId: 7,
              rootFolder: '/rule',
              tags: '2',
            })
          );
          const agent = await loginAs('demo@seerr.dev', 'test1234');
          const res = await agent.post('/request').send({
            mediaType,
            mediaId: 88100,
            serverId: 41,
            ...(mediaType === MediaType.TV ? { seasons: [1] } : {}),
            ...manual,
          });
          assert.equal(res.status, 201);
          const persisted = await getRepository(MediaRequest).findOneOrFail({
            where: { id: res.body.id },
          });
          assert.equal(persisted.serverId, 41);
          assert.equal(persisted.profileId, expected.profileId);
          assert.equal(persisted.rootFolder, expected.rootFolder);
          assert.deepEqual(persisted.tags, expected.tags);
          if (mediaType === MediaType.TV)
            assert.equal(
              persisted.languageProfileId,
              'languageProfileId' in manual ? manual.languageProfileId : null
            );
        });
      }

      it(`uses only the second ${mediaType} destination's rules (${independent ? 'independent' : 'native'})`, async () => {
        configure([
          {
            id: 41,
            isDefault: true,
            independentRequestDestination: independent,
          },
          {
            id: 42,
            isDefault: false,
            independentRequestDestination: independent,
          },
        ]);
        const requester = await getRepository(User).findOneOrFail({
          where: { email: 'demo@seerr.dev' },
        });
        requester.permissions =
          Permission.REQUEST | Permission.REQUEST_ADVANCED;
        await getRepository(User).save(requester);
        await getRepository(OverrideRule).save([
          new OverrideRule({
            [serviceField]: 41,
            profileId: 7,
            rootFolder: '/first',
            tags: '1',
          }),
          new OverrideRule({
            [serviceField]: 42,
            profileId: 8,
            rootFolder: '/second',
            tags: '2',
          }),
        ]);
        const agent = await loginAs('demo@seerr.dev', 'test1234');
        const res = await agent.post('/request').send({
          mediaType,
          mediaId: 88101,
          serverId: 42,
          ...(mediaType === MediaType.TV ? { seasons: [1] } : {}),
        });
        assert.equal(res.status, 201);
        const persisted = await getRepository(MediaRequest).findOneOrFail({
          where: { id: res.body.id },
        });
        assert.equal(persisted.serverId, 42);
        assert.equal(persisted.profileId, 8);
        assert.equal(persisted.rootFolder, '/second');
        assert.deepEqual(persisted.tags, [2]);
      });

      it(`leaves untouched ${mediaType} overrides null and sends the selected destination defaults (${independent ? 'independent' : 'native'})`, async (t) => {
        configure([
          {
            id: 41,
            isDefault: true,
            independentRequestDestination: independent,
          },
          {
            id: 42,
            isDefault: false,
            independentRequestDestination: independent,
            activeProfileId: 8,
            activeDirectory: '/second',
            activeLanguageProfileId: 9,
            tags: [2],
          },
        ]);
        const requester = await getRepository(User).findOneOrFail({
          where: { email: 'demo@seerr.dev' },
        });
        requester.permissions =
          Permission.REQUEST | Permission.REQUEST_ADVANCED;
        await getRepository(User).save(requester);
        const agent = await loginAs('demo@seerr.dev', 'test1234');
        const res = await agent.post('/request').send({
          mediaType,
          mediaId: 88102,
          serverId: 42,
          ...(mediaType === MediaType.TV ? { seasons: [1], tvdbId: 123 } : {}),
        });
        assert.equal(res.status, 201);
        const persisted = await getRepository(MediaRequest).findOneOrFail({
          where: { id: res.body.id },
        });
        for (const field of [
          'profileId',
          'rootFolder',
          'languageProfileId',
          'tags',
        ] as const)
          assert.equal(persisted[field], null);
        const arrPayloads: {
          qualityProfileId: number;
          rootFolderPath: string;
          languageProfileId?: number;
          tags: number[];
        }[] = [];
        t.mock.method(
          axios,
          'create',
          () =>
            ({
              interceptors: {
                request: { use: () => 0 },
                response: { use: () => 0 },
              },
              get: async () => ({ data: [{ id: 0, seasons: [] }] }),
              post: async (
                _url: string,
                body: (typeof arrPayloads)[number]
              ) => {
                arrPayloads.push(body);
                return { data: { id: 123 } };
              },
            }) as unknown as AxiosInstance
        );
        // Inspect dispatch without applying asynchronous Arr success state.
        const subscriberInternals =
          MediaRequestSubscriber.prototype as unknown as {
            applyArrSuccessIfStillApproved: () => Promise<boolean>;
          };
        t.mock.method(
          subscriberInternals,
          'applyArrSuccessIfStillApproved',
          async () => false
        );
        persisted.status = MediaRequestStatus.APPROVED;
        const subscriber = new MediaRequestSubscriber();
        const manager = getRepository(MediaRequest).manager;
        if (mediaType === MediaType.MOVIE)
          await subscriber.sendToRadarr(persisted, manager, independent);
        else await subscriber.sendToSonarr(persisted, manager, independent);
        await nextTurn();
        assert.equal(arrPayloads.length, 1);
        assert.equal(arrPayloads[0].qualityProfileId, 8);
        assert.equal(arrPayloads[0].rootFolderPath, '/second');
        assert.deepEqual(arrPayloads[0].tags, [2]);
        if (mediaType === MediaType.TV)
          assert.equal(arrPayloads[0].languageProfileId, 9);
      });
    }
  }

  async function requestWithRule(permissions: number) {
    configureRadarr([{ id: 1, isDefault: true, is4k: false }]);
    getSettings().sonarr = [];

    const userRepo = getRepository(User);
    const requester = await userRepo.findOneOrFail({
      where: { email: 'demo@seerr.dev' },
    });
    requester.permissions = permissions;
    await userRepo.save(requester);

    await getRepository(OverrideRule).save(
      new OverrideRule({
        radarrServiceId: 1,
        rootFolder: '/rule',
        profileId: 7,
        tags: '2',
      })
    );

    const agent = await loginAs('demo@seerr.dev', 'test1234');
    return agent.post('/request').send({
      mediaType: MediaType.MOVIE,
      mediaId: 88010,
      serverId: 1,
      rootFolder: '/chosen',
      tags: [],
    });
  }

  it('keeps what an advanced requester sets and fills the rest from the rule', async () => {
    const res = await requestWithRule(
      Permission.REQUEST | Permission.REQUEST_ADVANCED
    );

    assert.strictEqual(res.status, 201);
    assert.strictEqual(res.body.rootFolder, '/chosen');
    assert.strictEqual(res.body.profileId, 7);
    assert.deepStrictEqual(res.body.tags, []);
  });

  it('keeps what a request manager sets and fills the rest from the rule', async (t) => {
    // Manage Requests auto-approves; keep it from calling Radarr
    t.mock.method(
      MediaRequestSubscriber.prototype,
      'sendToRadarr',
      async () => undefined
    );
    const res = await requestWithRule(
      Permission.REQUEST | Permission.MANAGE_REQUESTS
    );

    assert.strictEqual(res.status, 201);
    assert.strictEqual(res.body.rootFolder, '/chosen');
    assert.strictEqual(res.body.profileId, 7);
    assert.deepStrictEqual(res.body.tags, []);
  });

  it('applies the rule over what a regular requester sets', async () => {
    const res = await requestWithRule(Permission.REQUEST);

    assert.strictEqual(res.status, 201);
    assert.strictEqual(res.body.rootFolder, '/rule');
  });
});

describe('DELETE /request/:requestId, orphaned season status reset', () => {
  async function seedTvShow(
    tmdbId: number,
    seasons: Partial<Season>[]
  ): Promise<Media> {
    const mediaRepo = getRepository(Media);

    return mediaRepo.save(
      new Media({
        mediaType: MediaType.TV,
        tmdbId,
        status: MediaStatus.PROCESSING,
        status4k: MediaStatus.UNKNOWN,
        seasons: seasons.map((season) => new Season(season)),
      })
    );
  }

  async function seedTvRequest(
    media: Media,
    seasonNumbers: number[]
  ): Promise<MediaRequest> {
    const userRepo = getRepository(User);
    const requestRepo = getRepository(MediaRequest);

    const admin = await userRepo.findOneOrFail({
      where: { email: 'admin@seerr.dev' },
    });

    return requestRepo.save(
      new MediaRequest({
        type: MediaType.TV,
        status: MediaRequestStatus.APPROVED,
        media,
        requestedBy: admin,
        is4k: false,
        seasons: seasonNumbers.map(
          (seasonNumber) =>
            new SeasonRequest({
              seasonNumber,
              status: MediaRequestStatus.APPROVED,
            })
        ),
      })
    );
  }

  it('resets a request-covered PROCESSING season to UNKNOWN so it can be re-requested', async () => {
    const mediaRepo = getRepository(Media);
    const media = await seedTvShow(99101, [
      { seasonNumber: 1, status: MediaStatus.PROCESSING },
    ]);
    const tvRequest = await seedTvRequest(media, [1]);

    const admin = await loginAs('admin@seerr.dev', 'test1234');
    const res = await admin.delete(`/request/${tvRequest.id}`);
    assert.strictEqual(res.status, 204);

    const updated = await mediaRepo.findOneOrFail({
      where: { id: media.id },
    });
    assert.strictEqual(updated.seasons[0].status, MediaStatus.UNKNOWN);

    configureSonarr([{ id: 0, isDefault: true }]);
    const friend = await loginAs('demo@seerr.dev', 'test1234');
    const reRequest = await friend.post('/request').send({
      mediaType: MediaType.TV,
      mediaId: 99101,
      seasons: [1],
    });
    assert.strictEqual(reRequest.status, 201);
  });

  it('does not touch PROCESSING seasons the deleted request did not cover', async () => {
    const mediaRepo = getRepository(Media);
    const media = await seedTvShow(99102, [
      { seasonNumber: 1, status: MediaStatus.PROCESSING },
      { seasonNumber: 2, status: MediaStatus.PROCESSING },
    ]);
    const tvRequest = await seedTvRequest(media, [1]);

    const admin = await loginAs('admin@seerr.dev', 'test1234');
    const res = await admin.delete(`/request/${tvRequest.id}`);
    assert.strictEqual(res.status, 204);

    const updated = await mediaRepo.findOneOrFail({ where: { id: media.id } });
    const seasonOne = updated.seasons.find((s) => s.seasonNumber === 1);
    const seasonTwo = updated.seasons.find((s) => s.seasonNumber === 2);
    assert.strictEqual(seasonOne?.status, MediaStatus.UNKNOWN);
    assert.strictEqual(seasonTwo?.status, MediaStatus.PROCESSING);
  });

  it('keeps a season PROCESSING while another active request still covers it', async () => {
    const mediaRepo = getRepository(Media);
    const media = await seedTvShow(99103, [
      { seasonNumber: 1, status: MediaStatus.PROCESSING },
    ]);
    const firstRequest = await seedTvRequest(media, [1]);
    await seedTvRequest(media, [1]);

    const admin = await loginAs('admin@seerr.dev', 'test1234');
    const res = await admin.delete(`/request/${firstRequest.id}`);
    assert.strictEqual(res.status, 204);

    const updated = await mediaRepo.findOneOrFail({ where: { id: media.id } });
    assert.strictEqual(updated.seasons[0].status, MediaStatus.PROCESSING);
  });

  it('leaves season status4k untouched when deleting a non-4K request', async () => {
    const mediaRepo = getRepository(Media);
    const media = await seedTvShow(99104, [
      {
        seasonNumber: 1,
        status: MediaStatus.PROCESSING,
        status4k: MediaStatus.PROCESSING,
      },
    ]);
    const tvRequest = await seedTvRequest(media, [1]);

    const admin = await loginAs('admin@seerr.dev', 'test1234');
    const res = await admin.delete(`/request/${tvRequest.id}`);
    assert.strictEqual(res.status, 204);

    const updated = await mediaRepo.findOneOrFail({ where: { id: media.id } });
    assert.strictEqual(updated.seasons[0].status, MediaStatus.UNKNOWN);
    assert.strictEqual(updated.seasons[0].status4k, MediaStatus.PROCESSING);
  });
});
