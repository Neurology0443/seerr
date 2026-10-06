import { MediaRequestStatus, MediaType } from '@server/constants/media';
import { getRepository } from '@server/datasource';
import Media from '@server/entity/Media';
import { MediaDestinationStatus } from '@server/entity/MediaDestinationStatus';
import { MediaRequest } from '@server/entity/MediaRequest';
import { getSettings } from '@server/lib/settings';
import AsyncLock from '@server/utils/asyncLock';
import { In } from 'typeorm';

export type DvrKind = 'radarr' | 'sonarr';

const dvrIdLock = new AsyncLock();

const mediaTypeForKind = (kind: DvrKind): MediaType =>
  kind === 'radarr' ? MediaType.MOVIE : MediaType.TV;

const toMaximum = (value: unknown): number => {
  if (value === null || value === undefined) {
    return -1;
  }

  const number = Number(value);
  return Number.isFinite(number) ? number : -1;
};

export const allocateDvrServerId = async (kind: DvrKind): Promise<number> =>
  dvrIdLock.dispatch(kind, async () => {
    const settings = getSettings();
    const mediaType = mediaTypeForKind(kind);

    const [requestResult, serviceResult, destinationResult] = await Promise.all(
      [
        getRepository(MediaRequest)
          .createQueryBuilder('request')
          .select('MAX(request.serverId)', 'maximum')
          .where('request.type = :mediaType', { mediaType })
          .getRawOne<{ maximum: number | string | null }>(),
        getRepository(Media)
          .createQueryBuilder('media')
          .select('MAX(media.serviceId)', 'serviceMaximum')
          .addSelect('MAX(media.serviceId4k)', 'service4kMaximum')
          .where('media.mediaType = :mediaType', { mediaType })
          .getRawOne<{
            serviceMaximum: number | string | null;
            service4kMaximum: number | string | null;
          }>(),
        getRepository(MediaDestinationStatus)
          .createQueryBuilder('destination')
          .select('MAX(destination.serverId)', 'maximum')
          .innerJoin('destination.media', 'media')
          .where('media.mediaType = :mediaType', { mediaType })
          .getRawOne<{ maximum: number | string | null }>(),
      ]
    );

    const configuredMaximum = settings[kind].reduce(
      (maximum, server) => Math.max(maximum, server.id),
      -1
    );
    const id = Math.max(
      settings.dvrIdCounters[kind] ?? 0,
      configuredMaximum + 1,
      toMaximum(requestResult?.maximum) + 1,
      toMaximum(serviceResult?.serviceMaximum) + 1,
      toMaximum(serviceResult?.service4kMaximum) + 1,
      toMaximum(destinationResult?.maximum) + 1
    );

    settings.dvrIdCounters[kind] = id + 1;
    await settings.save();

    return id;
  });

export const isDvrServerHistoricallyUsed = async (
  kind: DvrKind,
  serverId: number
): Promise<boolean> => {
  const mediaType = mediaTypeForKind(kind);
  const [requestUsed, nativeMediaUsed, destinationUsed] = await Promise.all([
    getRepository(MediaRequest).existsBy({ type: mediaType, serverId }),
    getRepository(Media).exists({
      where: [
        { mediaType, serviceId: serverId },
        { mediaType, serviceId4k: serverId },
      ],
    }),
    getRepository(MediaDestinationStatus)
      .createQueryBuilder('destination')
      .innerJoin('destination.media', 'media')
      .where('destination.serverId = :serverId', { serverId })
      .andWhere('media.mediaType = :mediaType', { mediaType })
      .getExists(),
  ]);

  return requestUsed || nativeMediaUsed || destinationUsed;
};

export const hasActiveDvrRequests = async (
  kind: DvrKind,
  serverId: number
): Promise<boolean> =>
  getRepository(MediaRequest).existsBy({
    type: mediaTypeForKind(kind),
    serverId,
    status: In([MediaRequestStatus.PENDING, MediaRequestStatus.APPROVED]),
  });
