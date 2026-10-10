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
import { MediaDestinationStatus } from '@server/entity/MediaDestinationStatus';
import { MediaRequest } from '@server/entity/MediaRequest';
import SeasonRequest from '@server/entity/SeasonRequest';
import { User } from '@server/entity/User';
import { initI18n } from '@server/i18n';
import downloadTracker from '@server/lib/downloadtracker';
import notificationManager, { Notification } from '@server/lib/notifications';
import type { NotificationPayload } from '@server/lib/notifications/agents/agent';
import WebPushAgent from '@server/lib/notifications/agents/webpush';
import type { RadarrSettings, SonarrSettings } from '@server/lib/settings';
import { getSettings } from '@server/lib/settings';
import { setupTestDb } from '@server/test/db';
import assert from 'node:assert/strict';
import { before, beforeEach, describe, it } from 'node:test';

// TMDB uses instance arrow functions, as in the existing route tests.
Object.defineProperty(TheMovieDb.prototype, 'getMovie', {
  get: () => async () =>
    ({
      title: 'Movie',
      overview: 'Overview',
      release_date: '2026-01-01',
      poster_path: '/movie.jpg',
    }) as TmdbMovieDetails,
  set() {},
  configurable: true,
});
Object.defineProperty(TheMovieDb.prototype, 'getTvShow', {
  get: () => async () =>
    ({
      name: 'Series',
      overview: 'Overview',
      first_air_date: '2026-01-01',
      poster_path: '/tv.jpg',
    }) as TmdbTvDetails,
  set() {},
  configurable: true,
});

setupTestDb();
before(initI18n);
beforeEach(() => {
  getSettings().radarr = [];
  getSettings().sonarr = [];
});

const categories = [
  Notification.MEDIA_PENDING,
  Notification.MEDIA_APPROVED,
  Notification.MEDIA_AUTO_APPROVED,
  Notification.MEDIA_AUTO_REQUESTED,
  Notification.MEDIA_FAILED,
  Notification.MEDIA_DECLINED,
  Notification.MEDIA_AVAILABLE,
];

describe('request notification destination identity', () => {
  for (const type of [MediaType.MOVIE, MediaType.TV]) {
    it(`preserves native ${type} payloads and adds exact, renamed and deleted destinations for every existing category`, async (t) => {
      const media = await getRepository(Media).save(
        new Media({ tmdbId: 91, mediaType: type })
      );
      const requestedBy = await getRepository(User).findOneByOrFail({ id: 1 });
      const request = await getRepository(MediaRequest).save(
        new MediaRequest({
          media,
          type,
          serverId: 91,
          is4k: false,
          requestedBy,
          status: MediaRequestStatus.COMPLETED,
          seasons:
            type === MediaType.TV
              ? [1, 3].map(
                  (seasonNumber) =>
                    new SeasonRequest({
                      seasonNumber,
                      status: MediaRequestStatus.COMPLETED,
                    })
                )
              : [],
        })
      );
      const capture = t.mock.method(
        notificationManager,
        'sendNotification',
        () => undefined
      );
      const key = type === MediaType.MOVIE ? 'radarr' : 'sonarr';
      const server = {
        id: 91,
        name: 'English',
        is4k: false,
        independentRequestDestination: false,
      } as RadarrSettings & SonarrSettings;
      const defaultServer = { ...server, id: 92, name: 'FR', isDefault: true };
      getSettings()[key] = [server, defaultServer];
      const seasonsExtra =
        type === MediaType.TV
          ? [{ name: 'Requested Seasons', value: '1, 3' }]
          : undefined;
      for (const category of categories) {
        await MediaRequest.sendNotification(request, media, category);
        assert.deepEqual(
          capture.mock.calls.at(-1)?.arguments[1]!.extra,
          seasonsExtra
        );
      }
      server.independentRequestDestination = true;
      const progress = t.mock.method(
        downloadTracker,
        type === MediaType.MOVIE ? 'getMovieProgress' : 'getSeriesProgress',
        () => {
          throw new Error('Presentation queue unavailable');
        }
      );
      await getRepository(MediaDestinationStatus).save(
        new MediaDestinationStatus({
          mediaId: media.id,
          serverId: 91,
          status: MediaStatus.AVAILABLE,
          externalServiceId: 191,
        })
      );
      for (const name of [
        'English',
        'Renamed English',
        `Deleted ${type === MediaType.MOVIE ? 'Radarr' : 'Sonarr'} server (#91)`,
      ]) {
        if (name.startsWith('Deleted')) getSettings()[key] = [defaultServer];
        else server.name = name;
        for (const category of categories) {
          await MediaRequest.sendNotification(request, media, category);
          const call = capture.mock.calls.at(-1)!;
          assert.equal(call.arguments[0], category);
          assert.deepEqual(call.arguments[1]!.extra, [
            ...(seasonsExtra ?? []),
            { name: 'Destination Server', value: name },
          ]);
          assert.equal(call.arguments[1]!.request?.serverId, 91);
        }
      }
      assert.equal(capture.mock.callCount(), categories.length * 4);
      assert.equal(progress.mock.callCount(), 0);
    });
  }
});

describe('short web push notification formatting', () => {
  // Exercise the actual formatter without sending a push or requiring subscriptions.
  const agent = new WebPushAgent() as unknown as {
    getNotificationPayload(
      type: Notification,
      payload: NotificationPayload
    ): { message?: string };
  };
  for (const category of categories) {
    it(`includes destination in ${Notification[category]} while preserving native message text`, () => {
      const payload: NotificationPayload = {
        subject: 'Movie',
        notifyAdmin: false,
        notifySystem: true,
        media: new Media({ mediaType: MediaType.MOVIE }),
        request: new MediaRequest({
          requestedBy: new User({ username: 'Requester' }),
        }),
      };
      const native = agent.getNotificationPayload(category, payload);
      const independent = agent.getNotificationPayload(category, {
        ...payload,
        extra: [{ name: 'Destination Server', value: 'English' }],
      });
      assert.equal(
        independent.message,
        `${native.message}\nDestination Server: English`
      );
    });
  }
});
