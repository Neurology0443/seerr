import { MediaStatus, MediaType } from '@server/constants/media';
import type Media from '@server/entity/Media';
import { MediaDestinationStatus } from '@server/entity/MediaDestinationStatus';
import type { MediaRequest } from '@server/entity/MediaRequest';
import type { MediaRequestTarget } from '@server/interfaces/api/requestInterfaces';
import {
  getConfiguredRequestServer,
  isIndependentRequest,
} from '@server/lib/requestTarget';
import { getSettings, type DVRSettings } from '@server/lib/settings';
import type { EntityManager, ObjectLiteral, SelectQueryBuilder } from 'typeorm';

export const getEffectiveTargetStatus = ({
  media,
  is4k,
  isIndependent,
  destinationStatus,
}: {
  media?: Media;
  is4k: boolean;
  isIndependent: boolean;
  destinationStatus?: MediaStatus;
}): MediaStatus =>
  isIndependent
    ? (destinationStatus ?? MediaStatus.UNKNOWN)
    : (media?.[is4k ? 'status4k' : 'status'] ?? MediaStatus.UNKNOWN);

export const getConfiguredTargetStatus = ({
  media,
  server,
  destinationStatus,
}: {
  media?: Media;
  server: DVRSettings;
  destinationStatus?: MediaStatus;
}): MediaStatus =>
  getEffectiveTargetStatus({
    media,
    is4k: Boolean(server.is4k),
    isIndependent: server.independentRequestDestination === true,
    destinationStatus,
  });

export const getRequestTargetState = async (
  request: Pick<MediaRequest, 'type' | 'serverId' | 'is4k' | 'media'>,
  manager: EntityManager
): Promise<MediaRequestTarget | null> => {
  if (request.serverId == null) {
    return null;
  }

  const server = getConfiguredRequestServer(request);
  const independent = await isIndependentRequest(request, manager);
  const destination = independent
    ? await manager.getRepository(MediaDestinationStatus).findOne({
        where: {
          mediaId: request.media.id,
          serverId: request.serverId,
        },
      })
    : null;

  return {
    serverId: request.serverId,
    name:
      server?.name ??
      `Deleted ${request.type === MediaType.MOVIE ? 'Radarr' : 'Sonarr'} server (#${request.serverId})`,
    is4k: request.is4k,
    isIndependent: independent,
    deleted: !server,
    status: getEffectiveTargetStatus({
      media: request.media,
      is4k: request.is4k,
      isIndependent: independent,
      destinationStatus: destination?.status,
    }),
  };
};

export const serializeMediaRequest = async <
  T extends Pick<MediaRequest, 'type' | 'serverId' | 'is4k' | 'media'>,
>(
  request: T,
  manager: EntityManager
): Promise<T & { target: MediaRequestTarget | null }> => ({
  ...request,
  target: await getRequestTargetState(request, manager),
});

type EffectiveStatusAliases = {
  request?: string;
  media?: string;
  destination?: string;
};

export const addEffectiveTargetStatusJoin = <Entity extends ObjectLiteral>(
  query: SelectQueryBuilder<Entity>,
  aliases: EffectiveStatusAliases = {}
): string => {
  const requestAlias = aliases.request ?? 'request';
  const mediaAlias = aliases.media ?? 'media';
  const destinationAlias = aliases.destination ?? 'targetDestination';
  const settings = getSettings();
  const configuredRadarrIds = settings.radarr.map((server) => server.id);
  const configuredSonarrIds = settings.sonarr.map((server) => server.id);
  const independentRadarrIds = settings.radarr
    .filter((server) => server.independentRequestDestination === true)
    .map((server) => server.id);
  const independentSonarrIds = settings.sonarr
    .filter((server) => server.independentRequestDestination === true)
    .map((server) => server.id);

  query
    .leftJoin(
      MediaDestinationStatus,
      destinationAlias,
      `${destinationAlias}.mediaId = ${mediaAlias}.id AND ${destinationAlias}.serverId = ${requestAlias}.serverId`
    )
    .setParameters({
      targetMovieType: MediaType.MOVIE,
      targetTvType: MediaType.TV,
      targetConfiguredRadarrIds:
        configuredRadarrIds.length > 0 ? configuredRadarrIds : [-1],
      targetConfiguredSonarrIds:
        configuredSonarrIds.length > 0 ? configuredSonarrIds : [-1],
      targetIndependentRadarrIds:
        independentRadarrIds.length > 0 ? independentRadarrIds : [-1],
      targetIndependentSonarrIds:
        independentSonarrIds.length > 0 ? independentSonarrIds : [-1],
      targetUnknownStatus: MediaStatus.UNKNOWN,
      target4k: true,
    });

  const configuredIndependent = `(
    (${requestAlias}.type = :targetMovieType AND ${requestAlias}.serverId IN (:...targetIndependentRadarrIds))
    OR (${requestAlias}.type = :targetTvType AND ${requestAlias}.serverId IN (:...targetIndependentSonarrIds))
  )`;
  const configured = `(
    (${requestAlias}.type = :targetMovieType AND ${requestAlias}.serverId IN (:...targetConfiguredRadarrIds))
    OR (${requestAlias}.type = :targetTvType AND ${requestAlias}.serverId IN (:...targetConfiguredSonarrIds))
  )`;
  const nativeStatus = `(CASE WHEN ${requestAlias}.is4k = :target4k THEN ${mediaAlias}.status4k ELSE ${mediaAlias}.status END)`;

  return `(CASE
    WHEN ${configuredIndependent} THEN COALESCE(${destinationAlias}.status, :targetUnknownStatus)
    WHEN ${configured} THEN ${nativeStatus}
    WHEN ${destinationAlias}.id IS NOT NULL THEN ${destinationAlias}.status
    ELSE ${nativeStatus}
  END)`;
};
