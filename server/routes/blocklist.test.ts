import assert from 'node:assert/strict';
import { before, describe, it } from 'node:test';

import TheMovieDb from '@server/api/themoviedb';
import { IssueType } from '@server/constants/issue';
import { MediaStatus, MediaType } from '@server/constants/media';
import dataSource, { getRepository } from '@server/datasource';
import { Blocklist } from '@server/entity/Blocklist';
import Issue from '@server/entity/Issue';
import Media from '@server/entity/Media';
import { MediaRequest } from '@server/entity/MediaRequest';
import { User } from '@server/entity/User';
import { Watchlist } from '@server/entity/Watchlist';
import { getSettings } from '@server/lib/settings';
import { checkUser } from '@server/middleware/auth';
import { setupTestDb } from '@server/test/db';
import {
  removalSnapshot,
  seedRemoval,
} from '@server/test/fixtures/destinationRemoval';
import {
  assertNoCredentials,
  seedUserSettings,
} from '@server/test/userSettings';
import type { Express } from 'express';
import express from 'express';
import session from 'express-session';
import request from 'supertest';
import { EntityManager } from 'typeorm';
import authRoutes from './auth';
import blocklistRoutes from './blocklist';

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
  app.use('/blocklist', blocklistRoutes);
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

describe('GET /blocklist/:id', () => {
  // this route replies with res.send() rather than res.json()
  it('omits notification settings from the blocklisting user', async () => {
    const blocklistUser = await seedUserSettings('demo@seerr.dev');

    const media = await getRepository(Media).save(
      new Media({
        mediaType: MediaType.MOVIE,
        tmdbId: 12345,
        status: MediaStatus.BLOCKLISTED,
        status4k: MediaStatus.UNKNOWN,
      })
    );

    await getRepository(Blocklist).save(
      new Blocklist({
        mediaType: MediaType.MOVIE,
        tmdbId: 12345,
        title: 'Blocked Movie',
        user: blocklistUser,
        media,
      })
    );

    const admin = await loginAs('admin@seerr.dev', 'test1234');
    const res = await admin.get('/blocklist/12345?mediaType=movie');

    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.user.email, 'demo@seerr.dev');
    assert.ok(!('settings' in res.body.user));
    assertNoCredentials(res.body);
  });
});

describe('PR8 safe unblock', () => {
  it('preserves request and season history, independent states, Issues, Watchlists and native linkage', async () => {
    const { media } = await seedRemoval(MediaType.TV);
    const user = await getRepository(User).findOneByOrFail({ id: 1 });
    await getRepository(Issue).save(
      new Issue({ media, createdBy: user, issueType: IssueType.VIDEO }),
      { listeners: false }
    );
    await getRepository(Watchlist).save(
      new Watchlist({
        media,
        tmdbId: media.tmdbId,
        mediaType: MediaType.TV,
        requestedBy: user,
      })
    );
    await Blocklist.addToBlocklist({
      blocklistRequest: { tmdbId: media.tmdbId, mediaType: MediaType.TV },
    });
    // Non-blocklisted native availability must survive unblock.
    await getRepository(Media).update(media.id, {
      status4k: MediaStatus.AVAILABLE,
    });
    const before = await removalSnapshot();
    const agent = await loginAs('admin@seerr.dev', 'test1234');
    const response = await agent.delete(
      `/blocklist/${media.tmdbId}?mediaType=tv`
    );
    assert.equal(response.status, 204);
    const after = await removalSnapshot();
    assert.deepEqual(after.destinations, before.destinations);
    assert.deepEqual(after.seasons, before.seasons);
    assert.deepEqual(after.seasonRequests, before.seasonRequests);
    assert.deepEqual(
      after.requests.map((r) => [r.id, r.status, r.serverId]),
      before.requests.map((r) => [r.id, r.status, r.serverId])
    );
    assert.equal(after.media[0].status, MediaStatus.UNKNOWN);
    assert.equal(after.media[0].status4k, MediaStatus.AVAILABLE);
    assert.equal(after.media[0].externalServiceId, media.externalServiceId);
    assert.deepEqual(after.media[0].seasons, before.media[0].seasons);
    assert.equal(await getRepository(Issue).count(), 1);
    assert.equal(await getRepository(Watchlist).count(), 1);
    assert.equal(await getRepository(Blocklist).count(), 0);
  });

  it('cleans a bare Blocklist entry conservatively without deleting unrelated media', async () => {
    await Blocklist.addToBlocklist({
      blocklistRequest: { tmdbId: 77002, mediaType: MediaType.MOVIE },
    });
    const { media } = await seedRemoval();
    const agent = await loginAs('admin@seerr.dev', 'test1234');
    assert.equal(
      (await agent.delete('/blocklist/77002?mediaType=movie')).status,
      204
    );
    const retained = await getRepository(Media).findOneByOrFail({
      tmdbId: 77002,
    });
    assert.equal(retained.status, MediaStatus.UNKNOWN);
    assert.equal(retained.status4k, MediaStatus.UNKNOWN);
    assert.equal(
      await getRepository(Media).exists({ where: { id: media.id } }),
      true
    );
    assert.equal(await getRepository(Blocklist).count(), 0);
  });

  it('collection unblock preserves useful data on every affected item', async (t) => {
    const { media } = await seedRemoval();
    const other = await getRepository(Media).save(
      new Media({
        tmdbId: 77003,
        mediaType: MediaType.MOVIE,
        ratingKey: 'useful',
      })
    );
    for (const item of [media, other])
      await Blocklist.addToBlocklist({
        blocklistRequest: { tmdbId: item.tmdbId, mediaType: MediaType.MOVIE },
      });
    t.mock.method(
      TheMovieDb.prototype,
      'getCollection',
      async () =>
        ({
          parts: [
            { id: media.tmdbId },
            { id: other.tmdbId },
            { id: media.tmdbId },
          ],
        }) as Awaited<ReturnType<TheMovieDb['getCollection']>>
    );
    const before = await removalSnapshot();
    const agent = await loginAs('admin@seerr.dev', 'test1234');
    assert.equal((await agent.delete('/blocklist/collection/1')).status, 204);
    const after = await removalSnapshot();
    assert.equal(after.media.length, 2);
    assert.deepEqual(after.destinations, before.destinations);
    assert.equal(
      await getRepository(MediaRequest).count(),
      before.requests.length
    );
    assert.equal(
      (await getRepository(Media).findOneByOrFail({ id: other.id })).ratingKey,
      'useful'
    );
    assert.equal(await getRepository(Blocklist).count(), 0);
  });

  it('rolls back both the Blocklist removal and native reset on cleanup failure', async (t) => {
    const { media } = await seedRemoval();
    await Blocklist.addToBlocklist({
      blocklistRequest: { tmdbId: media.tmdbId, mediaType: MediaType.MOVIE },
    });
    const before = await removalSnapshot();
    const update = EntityManager.prototype.update;
    let writes = 0;
    const failure = t.mock.method(
      EntityManager.prototype,
      'update',
      async function (
        this: EntityManager,
        ...args: Parameters<EntityManager['update']>
      ) {
        if (args[0] === Media && ++writes === 2)
          throw new Error('cleanup failure');
        return update.apply(this, args);
      }
    );
    const agent = await loginAs('admin@seerr.dev', 'test1234');
    assert.equal(
      (await agent.delete(`/blocklist/${media.tmdbId}?mediaType=movie`)).status,
      500
    );
    failure.mock.restore();
    assert.equal(await getRepository(Blocklist).count(), 1);
    assert.deepEqual(await removalSnapshot(), before);
    assert.equal(dataSource.isInitialized, true);
  });
});
