import { MediaType } from '@server/constants/media';
import { MediaDestinationStatus } from '@server/entity/MediaDestinationStatus';
import type { MediaRequest } from '@server/entity/MediaRequest';
import {
  getSettings,
  type DVRSettings,
  type RadarrSettings,
  type SonarrSettings,
} from '@server/lib/settings';
import type { EntityManager } from 'typeorm';

export class RequestTargetError extends Error {}

export type RequestTarget = {
  serverId: number;
  server: RadarrSettings | SonarrSettings;
  isIndependent: boolean;
  effectiveIs4k: boolean;
  serverIs4k: boolean;
};

export type RequestCreationTarget = Pick<
  RequestTarget,
  'serverId' | 'isIndependent' | 'effectiveIs4k' | 'serverIs4k'
>;

export const resolveRequestTarget = ({
  mediaType,
  is4k,
  serverId,
}: {
  mediaType: MediaType;
  is4k?: boolean;
  serverId?: number;
}): RequestTarget => {
  const settings = getSettings();
  const servers =
    mediaType === MediaType.MOVIE ? settings.radarr : settings.sonarr;
  const server =
    serverId !== undefined
      ? servers.find((candidate) => candidate.id === serverId)
      : servers.find(
          (candidate) => candidate.isDefault && candidate.is4k === Boolean(is4k)
        );

  if (!server) {
    throw new RequestTargetError(
      serverId !== undefined
        ? `The requested ${mediaType} server does not exist.`
        : `No default ${is4k ? '4K ' : ''}${mediaType} server is configured.`
    );
  }

  const isIndependent = server.independentRequestDestination === true;
  if (isIndependent && server.syncEnabled !== true) {
    throw new RequestTargetError(
      'Independent request destinations must have synchronization enabled.'
    );
  }

  return {
    serverId: server.id,
    server,
    isIndependent,
    effectiveIs4k: isIndependent ? server.is4k : Boolean(is4k),
    serverIs4k: Boolean(server.is4k),
  };
};

export const validateRequestCreationTarget = ({
  mediaType,
  target,
}: {
  mediaType: MediaType;
  target: RequestCreationTarget;
}): void => {
  const settings = getSettings();
  const servers =
    mediaType === MediaType.MOVIE ? settings.radarr : settings.sonarr;
  const server = servers.find((candidate) => candidate.id === target.serverId);

  if (!server) {
    throw new RequestTargetError(
      'The resolved request destination is no longer configured.'
    );
  }

  if (
    (server.independentRequestDestination === true) !==
    target.isIndependent
  ) {
    throw new RequestTargetError(
      'The resolved request destination role changed during creation.'
    );
  }

  if (
    Boolean(server.is4k) !== target.serverIs4k ||
    (target.isIndependent && server.syncEnabled !== true)
  ) {
    throw new RequestTargetError(
      'The resolved request destination changed during creation.'
    );
  }
};

const findConfiguredServer = (
  request: Pick<MediaRequest, 'type' | 'serverId'>
): DVRSettings | undefined => {
  if (request.serverId == null) {
    return undefined;
  }

  const settings = getSettings();
  const servers =
    request.type === MediaType.MOVIE ? settings.radarr : settings.sonarr;

  return servers.find((server) => server.id === request.serverId);
};

export const isIndependentRequest = async (
  request: Pick<MediaRequest, 'type' | 'serverId' | 'media'>,
  manager: EntityManager
): Promise<boolean> => {
  if (request.serverId == null) {
    return false;
  }

  const server = findConfiguredServer(request);
  if (server) {
    return server.independentRequestDestination === true;
  }

  return manager.getRepository(MediaDestinationStatus).exists({
    where: {
      mediaId: request.media.id,
      serverId: request.serverId,
    },
  });
};

export const isNativeRequest = async (
  request: Pick<MediaRequest, 'type' | 'serverId' | 'media'>,
  manager: EntityManager
): Promise<boolean> => !(await isIndependentRequest(request, manager));

export const getConfiguredRequestServer = findConfiguredServer;

export const getRequestTargetName = (
  request: Pick<MediaRequest, 'type' | 'serverId'>
): string =>
  findConfiguredServer(request)?.name ??
  `Deleted ${request.type === MediaType.MOVIE ? 'Radarr' : 'Sonarr'} server (#${request.serverId})`;
