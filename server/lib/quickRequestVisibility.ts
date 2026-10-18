import { MediaStatus, MediaType } from '@server/constants/media';
import { getRepository } from '@server/datasource';
import { Blocklist } from '@server/entity/Blocklist';
import Media from '@server/entity/Media';
import { MediaDestinationSeasonStatus } from '@server/entity/MediaDestinationSeasonStatus';
import { MediaDestinationStatus } from '@server/entity/MediaDestinationStatus';
import { MediaRequest } from '@server/entity/MediaRequest';
import type { User } from '@server/entity/User';
import { Permission } from '@server/lib/permissions';
import {
  ACTIVE_REQUEST_STATUSES,
  isActiveRequestStatus,
} from '@server/lib/requestSlot';
import { getConfiguredRequestServer } from '@server/lib/requestTarget';
import { getConfiguredRequestTargetState } from '@server/lib/requestTargetState';
import { getSettings } from '@server/lib/settings';
import logger from '@server/logger';
import type { Results } from '@server/models/Search';
import { In } from 'typeorm';

// An optional, user-specific list projection. The Request Modal and POST remain
// authoritative; complete the batch before changing any result so failures fall back.
export const enrichQuickRequestVisibility = async <T extends Results>(
  results: T[],
  user: User | undefined
): Promise<T[]> => {
  try {
    const settings = getSettings();
    const advanced = user?.hasPermission(Permission.REQUEST_ADVANCED);
    const targets = {
      movie: settings.radarr.filter(
        (server) => !server.is4k && (advanced || server.isDefault)
      ),
      tv: settings.sonarr.filter(
        (server) => !server.is4k && (advanced || server.isDefault)
      ),
    };
    const eligible = results.filter(
      (result) =>
        (result.mediaType === 'movie' || result.mediaType === 'tv') &&
        user?.hasPermission(
          [
            Permission.REQUEST,
            result.mediaType === 'movie'
              ? Permission.REQUEST_MOVIE
              : Permission.REQUEST_TV,
          ],
          { type: 'or' }
        ) &&
        result.mediaInfo?.status !== MediaStatus.BLOCKLISTED &&
        targets[result.mediaType].length > 0
    );
    const mediaIds = [
      ...new Set(
        eligible
          .map((result) =>
            'mediaInfo' in result ? result.mediaInfo?.id : undefined
          )
          .filter((id): id is number => id !== undefined)
      ),
    ];
    const tvIds = [
      ...new Set(
        eligible
          .filter((result) => result.mediaType === 'tv')
          .map((result) =>
            'mediaInfo' in result ? result.mediaInfo?.id : undefined
          )
          .filter((id): id is number => id !== undefined)
      ),
    ];
    const blocklistedMedia = eligible.length
      ? await getRepository(Blocklist)
          .createQueryBuilder('blocklist')
          .select(['blocklist.tmdbId', 'blocklist.mediaType'])
          .where('blocklist.tmdbId IN (:...tmdbIds)', {
            tmdbIds: [...new Set(eligible.map((result) => result.id))],
          })
          .getMany()
      : [];
    const blocklistedIdentities = new Set(
      blocklistedMedia.map((item) => `${item.mediaType}:${item.tmdbId}`)
    );
    // QueryBuilder does not load eager seasons. Load only native seasons here,
    // without users, downloads, or management relations from the original lookup.
    const [requests, destinations, nativeMedia, destinationSeasons] =
      mediaIds.length
        ? await Promise.all([
            getRepository(MediaRequest)
              .createQueryBuilder('request')
              .select([
                'request.id',
                'request.status',
                'request.type',
                'request.serverId',
                'request.is4k',
              ])
              .leftJoinAndSelect('request.seasons', 'season')
              .innerJoin('request.media', 'media')
              .addSelect('media.id')
              .where('media.id IN (:...mediaIds)', { mediaIds })
              .andWhere(
                '(request.type = :tvType OR request.status IN (:...activeStatuses))',
                {
                  tvType: MediaType.TV,
                  activeStatuses: ACTIVE_REQUEST_STATUSES,
                }
              )
              .getMany(),
            getRepository(MediaDestinationStatus).findBy({
              mediaId: In(mediaIds),
            }),
            tvIds.length
              ? getRepository(Media)
                  .createQueryBuilder('media')
                  .select('media.id')
                  .leftJoinAndSelect('media.seasons', 'season')
                  .where('media.id IN (:...tvIds)', { tvIds })
                  .getMany()
              : Promise.resolve([]),
            tvIds.length
              ? getRepository(MediaDestinationSeasonStatus)
                  .createQueryBuilder('season')
                  .innerJoinAndSelect('season.destinationStatus', 'destination')
                  .where('destination.mediaId IN (:...tvIds)', { tvIds })
                  .getMany()
              : Promise.resolve([]),
          ])
        : [[], [], [], []];
    const destinationIdentities = new Set(
      destinations.map(
        (destination) => `${destination.mediaId}:${destination.serverId}`
      )
    );
    const requestsByMedia = new Map<number, MediaRequest[]>();
    for (const request of requests) {
      const group = requestsByMedia.get(request.media.id) ?? [];
      group.push(request);
      requestsByMedia.set(request.media.id, group);
    }
    const seasonsByMedia = new Map<number, MediaDestinationSeasonStatus[]>();
    for (const season of destinationSeasons) {
      const group = seasonsByMedia.get(season.destinationStatus.mediaId) ?? [];
      group.push(season);
      seasonsByMedia.set(season.destinationStatus.mediaId, group);
    }
    const nativeByMedia = new Map(
      nativeMedia.map((item) => [item.id, item.seasons])
    );
    const destinationBySlot = new Map(
      destinations.map((item) => [`${item.mediaId}:${item.serverId}`, item])
    );
    const eligibleSet = new Set(eligible);
    const projected = results.map((result) => {
      if (result.mediaType !== 'movie' && result.mediaType !== 'tv')
        return result;
      if (!eligibleSet.has(result))
        return { ...result, quickRequestable: false };
      const media = result.mediaInfo;
      const isBlocklisted = blocklistedIdentities.has(
        `${result.mediaType}:${result.id}`
      );
      const mediaRequests = media ? (requestsByMedia.get(media.id) ?? []) : [];
      // Batch-safe isIndependentRequest semantics: configured role first,
      // otherwise a retained destination row identifies a deleted server.
      const activeRequests = mediaRequests
        .filter((request) => isActiveRequestStatus(request.status))
        .map((request) => {
          const configured = getConfiguredRequestServer(request);
          return {
            request,
            isIndependent:
              request.serverId != null &&
              (configured
                ? configured.independentRequestDestination === true
                : destinationIdentities.has(
                    `${request.media.id}:${request.serverId}`
                  )),
          };
        });
      const seasons = media ? (nativeByMedia.get(media.id) ?? []) : [];
      const independentSeasons = media
        ? (seasonsByMedia.get(media.id) ?? [])
        : [];
      // Synchronized local inventory intentionally omits live TMDB episode-count
      // filtering and unsynchronized new seasons. Detailed targets may differ.
      const inventory = [
        ...new Set([
          ...seasons.map((season) => season.seasonNumber),
          ...independentSeasons.map((season) => season.seasonNumber),
          ...mediaRequests.flatMap((request) =>
            request.seasons.map((season) => season.seasonNumber)
          ),
        ]),
      ].filter((number) => number !== 0 || settings.main.enableSpecialEpisodes);
      const quickRequestable = targets[result.mediaType].some((server) => {
        if (result.mediaType === 'tv' && inventory.length) {
          return inventory.some(
            (seasonNumber) =>
              getConfiguredRequestTargetState({
                isBlocklisted,
                media,
                server,
                activeRequests,
                seasonNumber,
                nativeStatus:
                  seasons.find((season) => season.seasonNumber === seasonNumber)
                    ?.status ?? MediaStatus.UNKNOWN,
                destinationStatus: independentSeasons.find(
                  (season) =>
                    season.destinationStatus.serverId === server.id &&
                    season.seasonNumber === seasonNumber
                )?.status,
              }).requestable
          );
        }
        // Empty TV inventory retains the controlled parent-state fallback.
        return getConfiguredRequestTargetState({
          isBlocklisted,
          media,
          server,
          activeRequests,
          destinationStatus: destinationBySlot.get(`${media?.id}:${server.id}`)
            ?.status,
        }).requestable;
      });
      return { ...result, quickRequestable };
    });
    return projected;
  } catch (error) {
    logger.warn(
      'Unable to project Quick Request visibility; using native fallback',
      {
        label: 'API',
        errorMessage: error.message,
      }
    );
    return results;
  }
};
