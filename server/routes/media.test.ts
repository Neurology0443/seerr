import assert from 'node:assert/strict';
import { before, beforeEach, describe, it, mock } from 'node:test';

import RadarrAPI from '@server/api/servarr/radarr';
import SonarrAPI from '@server/api/servarr/sonarr';
import {
  MediaRequestStatus,
  MediaStatus,
  MediaType,
} from '@server/constants/media';
import { getRepository } from '@server/datasource';
import Media from '@server/entity/Media';
import MediaRequest from '@server/entity/MediaRequest';
import MediaServiceStatus from '@server/entity/MediaServiceStatus';
import Season from '@server/entity/Season';
import { User } from '@server/entity/User';
import { getSettings } from '@server/lib/settings';
import { setupTestDb } from '@server/test/db';
import axios from 'axios';
import type { Express } from 'express';
import express from 'express';
import request from 'supertest';
import mediaRoutes from './media';

let app: Express;
const getMovie = mock.method(
  RadarrAPI.prototype,
  'getMovieByTmdbId',
  async () => ({ id: 501, title: 'Movie' }) as never
);
const getSeries = mock.method(
  SonarrAPI.prototype,
  'getSeriesByTvdbId',
  async () => ({ id: 701, title: 'Series' }) as never
);
const realAxiosCreate = axios.create.bind(axios);
const deleteRequest = mock.fn(async (path: string) => ({ path }));
const getRequest = mock.fn(async (path: string) => {
  if (path.startsWith('/tv/')) {
    return {
      data: {
        external_ids: { tvdb_id: 700 },
      },
    };
  }

  throw new Error(`Unexpected HTTP GET in media route test: ${path}`);
});
const sendNotification = mock.method(
  MediaRequest,
  'sendNotification',
  async () => undefined
);

mock.method(axios, 'create', (config?: Parameters<typeof axios.create>[0]) => {
  const instance = realAxiosCreate(config);

  instance.get = getRequest as unknown as typeof instance.get;
  instance.delete = deleteRequest as unknown as typeof instance.delete;

  return instance;
});

setupTestDb();

before(() => {
  app = express();
  app.use(express.json());
  app.use(async (req, _res, next) => {
    req.user = await getRepository(User).findOneByOrFail({ id: 1 });
    next();
  });
  app.use('/media', mediaRoutes);
  app.use(
    (
      err: { status?: number; message?: string },
      _req: express.Request,
      res: express.Response,
      _next: express.NextFunction
    ) => {
      void _next;
      return res.status(err.status ?? 500).json({ message: err.message });
    }
  );
});

beforeEach(() => {
  getMovie.mock.resetCalls();
  getSeries.mock.resetCalls();
  deleteRequest.mock.resetCalls();
  getRequest.mock.resetCalls();
  sendNotification.mock.resetCalls();
  deleteRequest.mock.mockImplementation(async (path: string) => ({ path }));
  const settings = getSettings();
  settings.radarr = [];
  settings.sonarr = [];
});

const target = (id: number, type: 'radarr' | 'sonarr') => ({
  id,
  name: `${type} ${id}`,
  hostname: 'localhost',
  port: type === 'radarr' ? 7878 : 8989,
  apiKey: 'key',
  baseUrl: '',
  useSsl: false,
  activeProfileId: 1,
  activeDirectory: '/media',
  is4k: false,
  tags: [],
  isDefault: false,
  syncEnabled: true,
  preventSearch: false,
  externalUrl: '',
  buttonLabel: 'Deutsch',
});

describe('DELETE /media/:id/file service target', () => {
  it('deletes only the selected movie target and preserves history', async () => {
    getSettings().radarr = [
      target(51, 'radarr'),
      target(52, 'radarr'),
    ] as never;
    const media = await getRepository(Media).save(
      new Media({
        tmdbId: 5001,
        mediaType: MediaType.MOVIE,
        status: MediaStatus.AVAILABLE,
      })
    );
    const user = await getRepository(User).findOneByOrFail({ id: 1 });
    const historical = await getRepository(MediaRequest).save(
      new MediaRequest({
        type: MediaType.MOVIE,
        status: MediaRequestStatus.FAILED,
        media,
        requestedBy: user,
        serverId: 51,
        isServiceRequest: true,
        is4k: false,
      }),
      { listeners: false }
    );
    const active = await getRepository(MediaRequest).save(
      new MediaRequest({
        type: MediaType.MOVIE,
        status: MediaRequestStatus.APPROVED,
        media,
        requestedBy: user,
        serverId: 51,
        isServiceRequest: true,
        is4k: false,
      }),
      { listeners: false }
    );
    await getRepository(MediaServiceStatus).save([
      new MediaServiceStatus({
        mediaId: media.id,
        serviceId: 51,
        serviceType: 'radarr',
        status: MediaStatus.AVAILABLE,
      }),
      new MediaServiceStatus({
        mediaId: media.id,
        serviceId: 52,
        serviceType: 'radarr',
        status: MediaStatus.PROCESSING,
      }),
    ]);

    await request(app)
      .delete(`/media/${media.id}/file?serviceId=51`)
      .expect(204);

    assert.equal(getMovie.mock.callCount(), 1);
    assert.equal(deleteRequest.mock.calls[0].arguments[0], '/movie/501');
    assert.equal(
      (await getRepository(Media).findOneByOrFail({ id: media.id })).status,
      MediaStatus.AVAILABLE
    );
    assert.equal(
      (
        await getRepository(MediaServiceStatus).findOneByOrFail({
          mediaId: media.id,
          serviceId: 51,
        })
      ).status,
      MediaStatus.DELETED
    );
    assert.equal(
      (
        await getRepository(MediaServiceStatus).findOneByOrFail({
          mediaId: media.id,
          serviceId: 52,
        })
      ).status,
      MediaStatus.PROCESSING
    );
    assert.equal(
      await getRepository(MediaRequest).existsBy({ id: historical.id }),
      true
    );
    assert.equal(
      (await getRepository(MediaRequest).findOneByOrFail({ id: active.id }))
        .status,
      MediaRequestStatus.DECLINED
    );
  });

  it('rejects missing, native, and wrong-type targets without mutation', async () => {
    getSettings().radarr = [
      { ...target(61, 'radarr'), buttonLabel: undefined, isDefault: true },
    ] as never;
    getSettings().sonarr = [target(62, 'sonarr')] as never;
    const media = await getRepository(Media).save(
      new Media({
        tmdbId: 5002,
        mediaType: MediaType.MOVIE,
        status: MediaStatus.PROCESSING,
      })
    );

    for (const id of [999, 61, 62]) {
      await request(app)
        .delete(`/media/${media.id}/file?serviceId=${id}`)
        .expect(400);
    }
    assert.equal(getMovie.mock.callCount(), 0);
    assert.equal(
      (await getRepository(Media).findOneByOrFail({ id: media.id })).status,
      MediaStatus.PROCESSING
    );
  });

  it('does not persist success state when Radarr deletion fails', async () => {
    getSettings().radarr = [target(63, 'radarr')] as never;
    const media = await getRepository(Media).save(
      new Media({
        tmdbId: 5004,
        mediaType: MediaType.MOVIE,
        status: MediaStatus.UNKNOWN,
      })
    );
    await getRepository(MediaServiceStatus).save(
      new MediaServiceStatus({
        mediaId: media.id,
        serviceId: 63,
        serviceType: 'radarr',
        status: MediaStatus.AVAILABLE,
      })
    );
    deleteRequest.mock.mockImplementation(async (path: string) => {
      throw new Error(`Radarr unavailable for ${path}`);
    });

    await request(app)
      .delete(`/media/${media.id}/file?serviceId=63`)
      .expect(500);

    assert.equal(
      (
        await getRepository(MediaServiceStatus).findOneByOrFail({
          mediaId: media.id,
          serviceId: 63,
        })
      ).status,
      MediaStatus.AVAILABLE
    );
  });

  it('marks only service seasons deleted for a selected series target', async () => {
    getSettings().sonarr = [target(71, 'sonarr')] as never;
    const media = await getRepository(Media).save(
      new Media({
        tmdbId: 5003,
        tvdbId: 700,
        mediaType: MediaType.TV,
        status: MediaStatus.AVAILABLE,
        seasons: [
          new Season({
            seasonNumber: 1,
            status: MediaStatus.AVAILABLE,
            status4k: MediaStatus.UNKNOWN,
          }),
        ],
      })
    );
    await getRepository(MediaServiceStatus).save(
      new MediaServiceStatus({
        mediaId: media.id,
        serviceId: 71,
        serviceType: 'sonarr',
        status: MediaStatus.AVAILABLE,
        seasonStatuses: { 1: MediaStatus.AVAILABLE },
      })
    );

    await request(app)
      .delete(`/media/${media.id}/file?serviceId=71`)
      .expect(204);

    assert.equal(getSeries.mock.callCount(), 1);
    assert.equal(deleteRequest.mock.calls[0].arguments[0], '/series/701');
    const updatedMedia = await getRepository(Media).findOneByOrFail({
      id: media.id,
    });
    assert.equal(updatedMedia.status, MediaStatus.AVAILABLE);
    assert.equal(updatedMedia.seasons[0].status, MediaStatus.AVAILABLE);
    const serviceStatus = await getRepository(
      MediaServiceStatus
    ).findOneByOrFail({ mediaId: media.id, serviceId: 71 });
    assert.equal(serviceStatus.status, MediaStatus.DELETED);
    assert.equal(serviceStatus.seasonStatuses?.[1], MediaStatus.DELETED);
  });
});
