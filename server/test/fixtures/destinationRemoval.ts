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
import {
  getSettings,
  type RadarrSettings,
  type SonarrSettings,
} from '@server/lib/settings';

export const removalServer = (
  id: number,
  independentRequestDestination = true,
  is4k = false
) =>
  ({
    id,
    name: id === 2 ? 'EN' : 'FR',
    hostname: `server-${id}`,
    port: 7878,
    apiKey: 'test',
    useSsl: false,
    is4k,
    isDefault: id === 1,
    independentRequestDestination,
    syncEnabled: true,
    externalUrl: `https://server-${id}.example`,
  }) as RadarrSettings & SonarrSettings;

export const seedRemoval = async (type = MediaType.MOVIE, is4k = false) => {
  const servers = [removalServer(1), removalServer(2, true, is4k)];
  getSettings().radarr = type === MediaType.MOVIE ? servers : [];
  getSettings().sonarr = type === MediaType.TV ? servers : [];
  const media = await getRepository(Media).save(
    new Media({
      tmdbId: 550,
      tvdbId: 1234,
      mediaType: type,
      status: MediaStatus.AVAILABLE,
      status4k: MediaStatus.PARTIALLY_AVAILABLE,
      serviceId: 99,
      serviceId4k: 98,
      externalServiceId: 100,
      externalServiceId4k: 101,
      externalServiceSlug: 'native',
      externalServiceSlug4k: 'native-4k',
      seasons:
        type === MediaType.TV
          ? [
              new Season({
                seasonNumber: 1,
                status: MediaStatus.AVAILABLE,
                status4k: MediaStatus.PROCESSING,
              }),
            ]
          : [],
    }),
    { listeners: false }
  );
  const destinations = await getRepository(MediaDestinationStatus).save(
    servers.map(
      (server) =>
        new MediaDestinationStatus({
          mediaId: media.id,
          serverId: server.id,
          status: MediaStatus.AVAILABLE,
          externalServiceId: 10 + server.id,
          externalServiceSlug: `exact-${server.id}`,
        })
    )
  );
  if (type === MediaType.TV) {
    await getRepository(MediaDestinationSeasonStatus).save(
      destinations.flatMap((destination) =>
        [1, 2].map(
          (seasonNumber) =>
            new MediaDestinationSeasonStatus({
              destinationStatusId: destination.id,
              seasonNumber,
              status:
                seasonNumber === 1
                  ? MediaStatus.AVAILABLE
                  : MediaStatus.PROCESSING,
            })
        )
      )
    );
  }
  const requestedBy = await getRepository(User).findOneByOrFail({ id: 1 });
  const requests = await getRepository(MediaRequest).save(
    [
      ...[
        MediaRequestStatus.APPROVED,
        MediaRequestStatus.PENDING,
        MediaRequestStatus.COMPLETED,
        MediaRequestStatus.FAILED,
        MediaRequestStatus.DECLINED,
      ].map(
        (status) =>
          new MediaRequest({
            media,
            type,
            serverId: 2,
            is4k,
            requestedBy,
            status,
            seasons:
              type === MediaType.TV
                ? [new SeasonRequest({ seasonNumber: 1, status })]
                : [],
          })
      ),
      new MediaRequest({
        media,
        type,
        serverId: 1,
        requestedBy,
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
      }),
    ],
    { listeners: false }
  );
  return { media, destinations, requests };
};

export const removalSnapshot = async () => ({
  media: await getRepository(Media).find({ order: { id: 'ASC' } }),
  destinations: await getRepository(MediaDestinationStatus).find({
    order: { id: 'ASC' },
  }),
  seasons: await getRepository(MediaDestinationSeasonStatus).find({
    order: { id: 'ASC' },
  }),
  requests: await getRepository(MediaRequest).find({ order: { id: 'ASC' } }),
  seasonRequests: await getRepository(SeasonRequest).find({
    order: { id: 'ASC' },
  }),
});
