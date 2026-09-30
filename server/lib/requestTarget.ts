import { MediaType } from '@server/constants/media';
import type { RadarrSettings, SonarrSettings } from '@server/lib/settings';
import { getSettings } from '@server/lib/settings';
import {
  isMultiServiceTarget,
  validateServiceTargetConfig,
} from '@server/utils/serviceTarget';

export class InvalidServiceTargetError extends Error {}

type RequestTarget = RadarrSettings | SonarrSettings;
type RequestSlot = {
  isServiceRequest: boolean;
  is4k: boolean;
  serverId?: number | null;
};

export const isSameRequestSlot = (
  other: RequestSlot,
  isServiceRequest: boolean,
  is4k: boolean,
  serverId: number | null | undefined
): boolean =>
  isServiceRequest
    ? other.isServiceRequest && other.serverId === serverId
    : !other.isServiceRequest && other.is4k === is4k;

export const validateRequestTarget = ({
  mediaType,
  serverId,
  isServiceRequest,
  is4k,
}: {
  mediaType: MediaType;
  serverId?: number | null;
  isServiceRequest: boolean;
  is4k: boolean;
}): RequestTarget | undefined => {
  if (serverId == null) {
    if (isServiceRequest) {
      throw new InvalidServiceTargetError('Invalid request destination.');
    }
    return;
  }

  if (!Number.isInteger(serverId)) {
    throw new InvalidServiceTargetError('Invalid request destination.');
  }

  const type = mediaType === MediaType.MOVIE ? 'radarr' : 'sonarr';
  const service = getSettings()[type].find((item) => item.id === serverId);

  if (
    !service ||
    isMultiServiceTarget(service) !== isServiceRequest ||
    (!isServiceRequest && service.is4k !== is4k) ||
    (isServiceRequest && validateServiceTargetConfig(service) !== undefined)
  ) {
    throw new InvalidServiceTargetError('Invalid request destination.');
  }

  return service;
};
