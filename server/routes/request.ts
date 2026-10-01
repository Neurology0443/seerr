import RadarrAPI from '@server/api/servarr/radarr';
import SonarrAPI from '@server/api/servarr/sonarr';
import TheMovieDb from '@server/api/themoviedb';
import { ANIME_KEYWORD_ID } from '@server/api/themoviedb/constants';
import {
  MediaRequestStatus,
  MediaStatus,
  MediaType,
} from '@server/constants/media';
import { getRepository } from '@server/datasource';
import Media from '@server/entity/Media';
import {
  BlocklistedMediaError,
  DuplicateMediaRequestError,
  MediaRequest,
  NoSeasonsAvailableError,
  QuotaRestrictedError,
  RequestPermissionError,
} from '@server/entity/MediaRequest';
import MediaServiceStatus from '@server/entity/MediaServiceStatus';
import SeasonRequest from '@server/entity/SeasonRequest';
import { User } from '@server/entity/User';
import type {
  MediaRequestBody,
  RequestResultsResponse,
} from '@server/interfaces/api/requestInterfaces';
import { Permission } from '@server/lib/permissions';
import {
  InvalidServiceTargetError,
  isSameRequestSlot,
  validateRequestTarget,
} from '@server/lib/requestTarget';
import { getSettings } from '@server/lib/settings';
import logger from '@server/logger';
import { isAuthenticated } from '@server/middleware/auth';
import { isPgsql } from '@server/utils/dbType';
import requestLock, {
  mediaKey,
  mediaLock,
  requestKey,
  serviceTargetKey,
  serviceTargetLock,
  userKey,
} from '@server/utils/requestLock';
import { Router } from 'express';

const requestRoutes = Router();

const requestedTvSeasonsAvailable = (serviceRequest: boolean): string => {
  if (!serviceRequest) {
    return `NOT EXISTS (
      SELECT 1 FROM season_request requested_season
      LEFT JOIN season media_season
        ON media_season."mediaId" = media.id
        AND media_season."seasonNumber" = requested_season."seasonNumber"
      WHERE requested_season."requestId" = request.id
        AND (
          media_season.id IS NULL OR
          CASE WHEN request."is4k" = true
            THEN media_season."status4k"
            ELSE media_season.status
          END != :availableStatus
        )
    )`;
  }

  const seasonStatus = isPgsql
    ? `CAST(matched_service_status."seasonStatuses" AS jsonb) ->> CAST(requested_season."seasonNumber" AS text)`
    : `json_extract(matched_service_status."seasonStatuses", '$."' || requested_season."seasonNumber" || '"')`;

  return `EXISTS (
    SELECT 1 FROM media_service_status matched_service_status
    WHERE matched_service_status."mediaId" = media.id
      AND matched_service_status."serviceId" = request."serverId"
      AND matched_service_status."serviceType" = :sonarrType
      AND NOT EXISTS (
        SELECT 1 FROM season_request requested_season
        WHERE requested_season."requestId" = request.id
          AND COALESCE(CAST((${seasonStatus}) AS integer), -1) != :availableStatus
      )
  )`;
};

const requestAvailableCondition = `(
  (request.type = :movieType AND (
    (request."isServiceRequest" = false AND (
      (request."is4k" = false AND media.status = :availableStatus) OR
      (request."is4k" = true AND media."status4k" = :availableStatus)
    )) OR
    (request."isServiceRequest" = true AND EXISTS (
      SELECT 1 FROM media_service_status matched_service_status
      WHERE matched_service_status."mediaId" = media.id
        AND matched_service_status."serviceId" = request."serverId"
        AND matched_service_status."serviceType" = :radarrType
        AND matched_service_status.status = :availableStatus
    ))
  )) OR
  (request.type = :tvType AND (
    (request."isServiceRequest" = false AND ${requestedTvSeasonsAvailable(false)}) OR
    (request."isServiceRequest" = true AND ${requestedTvSeasonsAvailable(true)})
  ))
)`;

requestRoutes.get<Record<string, unknown>, RequestResultsResponse>(
  '/',
  async (req, res, next) => {
    try {
      const pageSize = req.query.take ? Number(req.query.take) : 10;
      const skip = req.query.skip ? Number(req.query.skip) : 0;
      const requestedBy = req.query.requestedBy
        ? Number(req.query.requestedBy)
        : null;
      const mediaType = (req.query.mediaType as MediaType | 'all') || 'all';

      let statusFilter: MediaRequestStatus[];

      switch (req.query.filter) {
        case 'approved':
        case 'processing':
          statusFilter = [MediaRequestStatus.APPROVED];
          break;
        case 'pending':
          statusFilter = [MediaRequestStatus.PENDING];
          break;
        case 'unavailable':
          statusFilter = [
            MediaRequestStatus.PENDING,
            MediaRequestStatus.APPROVED,
          ];
          break;
        case 'failed':
          statusFilter = [MediaRequestStatus.FAILED];
          break;
        case 'completed':
        case 'available':
        case 'deleted':
          statusFilter = [MediaRequestStatus.COMPLETED];
          break;
        default:
          statusFilter = [
            MediaRequestStatus.PENDING,
            MediaRequestStatus.APPROVED,
            MediaRequestStatus.DECLINED,
            MediaRequestStatus.FAILED,
            MediaRequestStatus.COMPLETED,
          ];
      }

      let mediaStatusFilter: MediaStatus[];

      switch (req.query.filter) {
        case 'available':
          mediaStatusFilter = [MediaStatus.AVAILABLE];
          break;
        case 'processing':
        case 'unavailable':
          mediaStatusFilter = [
            MediaStatus.UNKNOWN,
            MediaStatus.PENDING,
            MediaStatus.PROCESSING,
            MediaStatus.PARTIALLY_AVAILABLE,
          ];
          break;
        case 'deleted':
          mediaStatusFilter = [MediaStatus.DELETED];
          break;
        default:
          mediaStatusFilter = [
            MediaStatus.UNKNOWN,
            MediaStatus.PENDING,
            MediaStatus.PROCESSING,
            MediaStatus.PARTIALLY_AVAILABLE,
            MediaStatus.AVAILABLE,
            MediaStatus.DELETED,
          ];
      }

      let sortFilter: string;
      let sortDirection: 'ASC' | 'DESC';

      switch (req.query.sort) {
        case 'modified':
          sortFilter = 'request.updatedAt';
          break;
        default:
          sortFilter = 'request.id';
      }

      switch (req.query.sortDirection) {
        case 'asc':
          sortDirection = 'ASC';
          break;
        default:
          sortDirection = 'DESC';
      }

      let query = getRepository(MediaRequest)
        .createQueryBuilder('request')
        .leftJoinAndSelect('request.media', 'media')
        .leftJoinAndSelect('media.serviceStatuses', 'serviceStatuses')
        .leftJoinAndSelect('request.seasons', 'seasons')
        .leftJoinAndSelect('request.modifiedBy', 'modifiedBy')
        .leftJoinAndSelect('request.requestedBy', 'requestedBy')
        .where('request.status IN (:...requestStatus)', {
          requestStatus: statusFilter,
        });

      if (req.query.filter === 'available') {
        query = query.andWhere(requestAvailableCondition, {
          availableStatus: MediaStatus.AVAILABLE,
          movieType: MediaType.MOVIE,
          tvType: MediaType.TV,
          radarrType: 'radarr',
          sonarrType: 'sonarr',
        });
      } else if (
        req.query.filter === 'processing' ||
        req.query.filter === 'unavailable'
      ) {
        query = query.andWhere(`NOT ${requestAvailableCondition}`, {
          availableStatus: MediaStatus.AVAILABLE,
          movieType: MediaType.MOVIE,
          tvType: MediaType.TV,
          radarrType: 'radarr',
          sonarrType: 'sonarr',
        });
      } else if (req.query.filter === 'deleted') {
        query = query.andWhere(
          `(
            (request."isServiceRequest" = false AND (
              (request."is4k" = false AND media.status IN (:...mediaStatus)) OR
              (request."is4k" = true AND media."status4k" IN (:...mediaStatus))
            )) OR
            (request."isServiceRequest" = true AND EXISTS (
              SELECT 1 FROM media_service_status matchedServiceStatus
              WHERE matchedServiceStatus."mediaId" = media.id
                AND matchedServiceStatus."serviceId" = request."serverId"
                AND matchedServiceStatus."serviceType" = CASE
                  WHEN request.type = :movieType THEN :radarrType
                  ELSE :sonarrType
                END
                AND matchedServiceStatus.status IN (:...mediaStatus)
            ))
          )`,
          {
            mediaStatus: mediaStatusFilter,
            movieType: MediaType.MOVIE,
            radarrType: 'radarr',
            sonarrType: 'sonarr',
          }
        );
      }

      if (
        !req.user?.hasPermission(
          [Permission.MANAGE_REQUESTS, Permission.REQUEST_VIEW],
          { type: 'or' }
        )
      ) {
        if (requestedBy && requestedBy !== req.user?.id) {
          return next({
            status: 403,
            message: "You do not have permission to view this user's requests.",
          });
        }

        query = query.andWhere('requestedBy.id = :id', {
          id: req.user?.id,
        });
      } else if (requestedBy) {
        query = query.andWhere('requestedBy.id = :id', {
          id: requestedBy,
        });
      }

      switch (mediaType) {
        case 'all':
          break;
        case 'movie':
          query = query.andWhere('request.type = :type', {
            type: MediaType.MOVIE,
          });
          break;
        case 'tv':
          query = query.andWhere('request.type = :type', {
            type: MediaType.TV,
          });
          break;
      }

      const [requests, requestCount] = await query
        .orderBy(sortFilter, sortDirection)
        .take(pageSize)
        .skip(skip)
        .getManyAndCount();

      const settings = getSettings();

      // get all quality profiles for every configured sonarr server
      const sonarrServers = await Promise.all(
        settings.sonarr.map(async (sonarrSetting) => {
          const sonarr = new SonarrAPI({
            apiKey: sonarrSetting.apiKey,
            url: SonarrAPI.buildUrl(sonarrSetting, '/api/v3'),
          });

          return {
            id: sonarrSetting.id,
            profiles: await sonarr.getProfiles().catch(() => undefined),
          };
        })
      );

      // get all quality profiles for every configured radarr server
      const radarrServers = await Promise.all(
        settings.radarr.map(async (radarrSetting) => {
          const radarr = new RadarrAPI({
            apiKey: radarrSetting.apiKey,
            url: RadarrAPI.buildUrl(radarrSetting, '/api/v3'),
          });

          return {
            id: radarrSetting.id,
            profiles: await radarr.getProfiles().catch(() => undefined),
          };
        })
      );

      // add profile names to the media requests, with undefined if not found
      let mappedRequests = requests.map((r) => {
        switch (r.type) {
          case MediaType.MOVIE: {
            const radarrServer = radarrServers.find(
              (serverr) => serverr.id === r.serverId
            );
            const profileName = radarrServer?.profiles?.find(
              (profile) => profile.id === r.profileId
            )?.name;
            const serverName =
              r.serverId != null
                ? (settings.radarr.find((s) => s.id === r.serverId)?.name ??
                  (r.isServiceRequest
                    ? `Deleted service (#${r.serverId})`
                    : undefined))
                : undefined;

            return { ...r, profileName, serverName };
          }
          case MediaType.TV: {
            const sonarrServer = sonarrServers.find(
              (serverr) => serverr.id === r.serverId
            );
            const serverName =
              r.serverId != null
                ? (settings.sonarr.find((s) => s.id === r.serverId)?.name ??
                  (r.isServiceRequest
                    ? `Deleted service (#${r.serverId})`
                    : undefined))
                : undefined;

            return {
              ...r,
              profileName: sonarrServer?.profiles?.find(
                (profile) => profile.id === r.profileId
              )?.name,
              serverName,
            };
          }
        }
      });

      // add canRemove prop if user has permission
      if (req.user?.hasPermission(Permission.MANAGE_REQUESTS)) {
        mappedRequests = mappedRequests.map((r) => {
          switch (r.type) {
            case MediaType.MOVIE: {
              return {
                ...r,
                // check if the radarr server for this request is configured
                canRemove: r.isServiceRequest
                  ? settings.radarr.some(
                      (server) =>
                        server.id === r.serverId &&
                        Boolean(server.buttonLabel?.trim()) &&
                        !server.isDefault &&
                        server.syncEnabled
                    )
                  : radarrServers.some(
                      (server) =>
                        server.id ===
                        (r.is4k ? r.media.serviceId4k : r.media.serviceId)
                    ),
              };
            }
            case MediaType.TV: {
              return {
                ...r,
                // check if the sonarr server for this request is configured
                canRemove: r.isServiceRequest
                  ? settings.sonarr.some(
                      (server) =>
                        server.id === r.serverId &&
                        Boolean(server.buttonLabel?.trim()) &&
                        !server.isDefault &&
                        server.syncEnabled
                    )
                  : sonarrServers.some(
                      (server) =>
                        server.id ===
                        (r.is4k ? r.media.serviceId4k : r.media.serviceId)
                    ),
              };
            }
          }
        });
      }

      return res.status(200).json({
        pageInfo: {
          pages: Math.ceil(requestCount / pageSize),
          pageSize,
          results: requestCount,
          page: Math.ceil(skip / pageSize) + 1,
        },
        results: mappedRequests,
        serviceErrors: {
          radarr: radarrServers
            .filter((s) => !s.profiles)
            .map((s) => ({
              id: s.id,
              name:
                settings.radarr.find((r) => r.id === s.id)?.name ||
                `Radarr ${s.id}`,
            })),
          sonarr: sonarrServers
            .filter((s) => !s.profiles)
            .map((s) => ({
              id: s.id,
              name:
                settings.sonarr.find((r) => r.id === s.id)?.name ||
                `Sonarr ${s.id}`,
            })),
        },
      });
    } catch (e) {
      next({ status: 500, message: e.message });
    }
  }
);

requestRoutes.post<never, MediaRequest, MediaRequestBody>(
  '/',
  async (req, res, next) => {
    try {
      if (!req.user) {
        return next({
          status: 401,
          message: 'You must be logged in to request media.',
        });
      }
      const request = await MediaRequest.request(req.body, req.user);

      return res.status(201).json(request);
    } catch (error) {
      if (!(error instanceof Error)) {
        return;
      }

      switch (error.constructor) {
        case RequestPermissionError:
        case QuotaRestrictedError:
          return next({ status: 403, message: error.message });
        case DuplicateMediaRequestError:
          return next({ status: 409, message: error.message });
        case NoSeasonsAvailableError:
          return next({ status: 202, message: error.message });
        case BlocklistedMediaError:
          return next({ status: 403, message: error.message });
        case InvalidServiceTargetError:
          return next({ status: 400, message: error.message });
        default:
          return next({ status: 500, message: error.message });
      }
    }
  }
);

requestRoutes.get('/count', async (_req, res, next) => {
  const requestRepository = getRepository(MediaRequest);

  try {
    const query = requestRepository
      .createQueryBuilder('request')
      .innerJoinAndSelect('request.media', 'media');

    const totalCount = await query.getCount();

    const movieCount = await query
      .where('request.type = :requestType', {
        requestType: MediaType.MOVIE,
      })
      .getCount();

    const tvCount = await query
      .where('request.type = :requestType', {
        requestType: MediaType.TV,
      })
      .getCount();

    const pendingCount = await query
      .where('request.status = :requestStatus', {
        requestStatus: MediaRequestStatus.PENDING,
      })
      .getCount();

    const approvedCount = await query
      .where('request.status = :requestStatus', {
        requestStatus: MediaRequestStatus.APPROVED,
      })
      .getCount();

    const declinedCount = await query
      .where('request.status = :requestStatus', {
        requestStatus: MediaRequestStatus.DECLINED,
      })
      .getCount();

    const processingCount = await query
      .where('request.status = :requestStatus', {
        requestStatus: MediaRequestStatus.APPROVED,
      })
      .andWhere(`NOT ${requestAvailableCondition}`, {
        availableStatus: MediaStatus.AVAILABLE,
        movieType: MediaType.MOVIE,
        tvType: MediaType.TV,
        radarrType: 'radarr',
        sonarrType: 'sonarr',
      })
      .getCount();

    const availableCount = await query
      .where('request.status = :requestStatus', {
        requestStatus: MediaRequestStatus.APPROVED,
      })
      .andWhere(requestAvailableCondition, {
        availableStatus: MediaStatus.AVAILABLE,
        movieType: MediaType.MOVIE,
        tvType: MediaType.TV,
        radarrType: 'radarr',
        sonarrType: 'sonarr',
      })
      .getCount();

    const completedCount = await query
      .where('request.status = :requestStatus', {
        requestStatus: MediaRequestStatus.COMPLETED,
      })
      .getCount();

    return res.status(200).json({
      total: totalCount,
      movie: movieCount,
      tv: tvCount,
      pending: pendingCount,
      approved: approvedCount,
      declined: declinedCount,
      processing: processingCount,
      available: availableCount,
      completed: completedCount,
    });
  } catch (e) {
    logger.error('Something went wrong retrieving request counts', {
      label: 'API',
      errorMessage: e.message,
    });
    next({ status: 500, message: 'Unable to retrieve request counts.' });
  }
});

requestRoutes.get('/:requestId', async (req, res, next) => {
  const requestRepository = getRepository(MediaRequest);

  try {
    const request = await requestRepository.findOneOrFail({
      where: { id: Number(req.params.requestId) },
      relations: {
        requestedBy: true,
        modifiedBy: true,
        media: { serviceStatuses: true },
      },
    });

    if (
      request.requestedBy.id !== req.user?.id &&
      !req.user?.hasPermission(
        [Permission.MANAGE_REQUESTS, Permission.REQUEST_VIEW],
        { type: 'or' }
      )
    ) {
      return next({
        status: 403,
        message: 'You do not have permission to view this request.',
      });
    }

    return res.status(200).json(request);
  } catch (e) {
    logger.debug('Failed to retrieve request.', {
      label: 'API',
      errorMessage: e.message,
    });
    next({ status: 404, message: 'Request not found.' });
  }
});

requestRoutes.put<{ requestId: string }>(
  '/:requestId',
  async (req, res, next) => {
    const requestRepository = getRepository(MediaRequest);
    const userRepository = getRepository(User);
    const requestId = Number(req.params.requestId);
    try {
      // Ordering is request then owner here, user then media on create, so no cycle
      return await requestLock.dispatch(requestKey(requestId), async () => {
        const request = await requestRepository.findOne({
          where: {
            id: requestId,
          },
        });

        if (!request) {
          return next({ status: 404, message: 'Request not found.' });
        }

        const requestedServerId =
          req.body.serverId === undefined
            ? request.serverId
            : req.body.serverId;

        const updateRequest = async () => {
          if (req.body.mediaType !== request.type) {
            return next({
              status: 400,
              message: 'Request media type cannot be changed.',
            });
          }

          if (
            (request.requestedBy.id !== req.user?.id ||
              (req.body.mediaType !== 'tv' &&
                !req.user?.hasPermission(Permission.REQUEST_ADVANCED))) &&
            !req.user?.hasPermission(Permission.MANAGE_REQUESTS)
          ) {
            return next({
              status: 403,
              message: 'You do not have permission to modify this request.',
            });
          }

          if (request.status !== MediaRequestStatus.PENDING) {
            return next({
              status: 409,
              message: 'Only pending requests can be modified.',
            });
          }

          const previousOwnerId = request.requestedBy.id;
          let requestUser = request.requestedBy;

          if (
            req.body.userId &&
            req.body.userId !== request.requestedBy.id &&
            !req.user?.hasPermission([
              Permission.MANAGE_USERS,
              Permission.MANAGE_REQUESTS,
            ])
          ) {
            return next({
              status: 403,
              message: 'You do not have permission to modify the request user.',
            });
          } else if (req.body.userId) {
            requestUser = await userRepository.findOneOrFail({
              where: { id: req.body.userId },
            });
          }

          // Reassignment moves every season on the request onto the new owner's
          // quota, so it is charged in full rather than as a delta
          const ownerChanging = requestUser.id !== previousOwnerId;

          const destinationChanging = requestedServerId !== request.serverId;
          const slotChanging = request.isServiceRequest && destinationChanging;
          if (!request.isServiceRequest && req.body.serverId !== undefined) {
            validateRequestTarget({
              mediaType: request.type,
              serverId: requestedServerId,
              isServiceRequest: false,
              is4k: request.is4k,
            });
          }
          if (request.isServiceRequest) {
            const target = validateRequestTarget({
              mediaType: request.type,
              serverId: requestedServerId,
              isServiceRequest: true,
              is4k: request.is4k,
            });
            if (target?.is4k !== request.is4k) {
              throw new InvalidServiceTargetError(
                'Invalid request destination.'
              );
            }

            const qualityPermissions =
              request.type === MediaType.MOVIE
                ? request.is4k
                  ? [Permission.REQUEST_4K, Permission.REQUEST_4K_MOVIE]
                  : [Permission.REQUEST, Permission.REQUEST_MOVIE]
                : request.is4k
                  ? [Permission.REQUEST_4K, Permission.REQUEST_4K_TV]
                  : [Permission.REQUEST, Permission.REQUEST_TV];
            if (
              !req.user?.hasPermission(Permission.MANAGE_REQUESTS) &&
              !requestUser.hasPermission(qualityPermissions, { type: 'or' })
            ) {
              throw new RequestPermissionError(
                'You do not have permission to request in this service.'
              );
            }

            if (
              !req.user?.hasPermission(Permission.MANAGE_REQUESTS) &&
              !req.user?.requestServices?.includes(
                `${request.type === MediaType.MOVIE ? 'radarr' : 'sonarr'}:${
                  requestedServerId
                }`
              )
            ) {
              throw new RequestPermissionError(
                'You do not have permission to request in this service.'
              );
            }

            if (target?.animeOnly) {
              const tmdb = new TheMovieDb();
              const tmdbMedia =
                request.type === MediaType.MOVIE
                  ? await tmdb.getMovie({ movieId: request.media.tmdbId })
                  : await tmdb.getTvShow({ tvId: request.media.tmdbId });
              const keywords =
                'results' in tmdbMedia.keywords
                  ? tmdbMedia.keywords.results
                  : tmdbMedia.keywords.keywords;
              if (
                !keywords.some((keyword) => keyword.id === ANIME_KEYWORD_ID)
              ) {
                throw new InvalidServiceTargetError(
                  'This request destination is restricted to anime.'
                );
              }
            }
          }

          return requestLock.dispatch(userKey(requestUser.id), () =>
            mediaLock.dispatch(
              mediaKey(request.type, request.media.tmdbId),
              async () => {
                const mediaRepository = getRepository(Media);
                const media = await mediaRepository.findOneOrFail({
                  where: {
                    tmdbId: request.media.tmdbId,
                    mediaType: request.type,
                  },
                  relations: { requests: true },
                });
                const otherActiveRequests = media.requests.filter(
                  (other) =>
                    other.id !== request.id &&
                    (request.isServiceRequest
                      ? other.status === MediaRequestStatus.PENDING ||
                        other.status === MediaRequestStatus.APPROVED
                      : other.status !== MediaRequestStatus.DECLINED &&
                        other.status !== MediaRequestStatus.COMPLETED) &&
                    isSameRequestSlot(
                      other,
                      request.isServiceRequest,
                      request.is4k,
                      requestedServerId
                    )
                );

                if (request.type === MediaType.MOVIE) {
                  if (
                    (request.isServiceRequest || destinationChanging) &&
                    otherActiveRequests.length > 0
                  ) {
                    return next({
                      status: 409,
                      message: 'Request for this media already exists.',
                    });
                  }

                  if (ownerChanging && !request.ignoreQuota) {
                    const quotas = await requestUser.getQuota();

                    if (quotas.movie.restricted) {
                      return next({
                        status: 403,
                        message: 'Movie Quota exceeded.',
                      });
                    }
                  }

                  request.serverId = requestedServerId;
                  request.profileId = req.body.profileId;
                  request.rootFolder = req.body.rootFolder;
                  request.tags = req.body.tags;
                  request.requestedBy = requestUser as User;

                  await requestRepository.save(request);
                  return res.status(200).json(request);
                }

                const rawRequestedSeasons: unknown = req.body.seasons;

                if (
                  !Array.isArray(rawRequestedSeasons) ||
                  rawRequestedSeasons.length === 0 ||
                  rawRequestedSeasons.some(
                    (season) => !Number.isInteger(season) || season < 0
                  )
                ) {
                  throw new InvalidServiceTargetError(
                    'Invalid season selection.'
                  );
                }
                const requestedSeasons = [
                  ...new Set<number>(rawRequestedSeasons),
                ];

                const existingSeasons = otherActiveRequests.flatMap((other) =>
                  other.seasons.map((season) => season.seasonNumber)
                );

                if (
                  request.isServiceRequest &&
                  requestedSeasons.some((season) =>
                    existingSeasons.includes(season)
                  )
                ) {
                  return next({
                    status: 409,
                    message: 'Request for this media already exists.',
                  });
                }

                const currentSeasons = slotChanging
                  ? []
                  : request.seasons.map((season) => season.seasonNumber);

                let coveredSeasons: number[];
                if (request.isServiceRequest) {
                  const serviceStatus = await getRepository(
                    MediaServiceStatus
                  ).findOne({
                    where: {
                      mediaId: media.id,
                      serviceId: requestedServerId,
                      serviceType: 'sonarr',
                    },
                  });
                  coveredSeasons = Object.entries(
                    serviceStatus?.seasonStatuses ?? {}
                  )
                    .filter(([, status]) => status === MediaStatus.AVAILABLE)
                    .map(([seasonNumber]) => Number(seasonNumber));
                } else {
                  coveredSeasons = (media.seasons ?? [])
                    .filter(
                      (season) =>
                        season[request.is4k ? 'status4k' : 'status'] !==
                          MediaStatus.UNKNOWN &&
                        season[request.is4k ? 'status4k' : 'status'] !==
                          MediaStatus.DELETED
                    )
                    .map((season) => season.seasonNumber);
                }
                coveredSeasons = coveredSeasons.filter(
                  (season) => !currentSeasons.includes(season)
                );

                const filteredSeasons = requestedSeasons.filter(
                  (season) => !existingSeasons.includes(season)
                );
                const keptSeasons = filteredSeasons.filter((season) =>
                  currentSeasons.includes(season)
                );
                const newSeasons = filteredSeasons.filter(
                  (season) =>
                    !currentSeasons.includes(season) &&
                    !coveredSeasons.includes(season)
                );
                const resultingSeasonCount =
                  keptSeasons.length + newSeasons.length;

                if (resultingSeasonCount === 0) {
                  return next({
                    status: 202,
                    message: 'No seasons available to request',
                  });
                }

                if (!request.ignoreQuota) {
                  const quotas = await requestUser.getQuota();
                  const quotaWindowStart = new Date();
                  if (quotas.tv.days) {
                    quotaWindowStart.setDate(
                      quotaWindowStart.getDate() - quotas.tv.days
                    );
                  }

                  const countedAlready =
                    !ownerChanging &&
                    (!quotas.tv.days || request.createdAt > quotaWindowStart);
                  const priorSeasonCount = countedAlready
                    ? request.seasons.length
                    : 0;
                  const requiredSeasons =
                    resultingSeasonCount - priorSeasonCount;

                  if (
                    quotas.tv.limit &&
                    requiredSeasons > (quotas.tv.remaining ?? 0)
                  ) {
                    return next({
                      status: 403,
                      message: 'Series Quota exceeded.',
                    });
                  }
                }

                request.serverId = requestedServerId;
                request.profileId = req.body.profileId;
                request.rootFolder = req.body.rootFolder;
                request.languageProfileId = req.body.languageProfileId;
                request.tags = req.body.tags;
                request.requestedBy = requestUser as User;
                request.seasons = request.seasons.filter((season) =>
                  keptSeasons.includes(season.seasonNumber)
                );

                if (newSeasons.length > 0) {
                  logger.debug('Adding new seasons to request', {
                    label: 'Media Request',
                    newSeasons,
                  });
                  request.seasons.push(
                    ...newSeasons.map(
                      (season) =>
                        new SeasonRequest({
                          seasonNumber: season,
                          status: MediaRequestStatus.PENDING,
                        })
                    )
                  );
                }

                await requestRepository.save(request);
                return res.status(200).json(request);
              }
            )
          );
        };

        if (requestedServerId == null) {
          return updateRequest();
        }
        return serviceTargetLock.dispatch(
          serviceTargetKey(
            request.type === MediaType.MOVIE ? 'radarr' : 'sonarr',
            requestedServerId
          ),
          updateRequest
        );
      });
    } catch (e) {
      if (e instanceof InvalidServiceTargetError) {
        return next({ status: 400, message: e.message });
      }
      if (e instanceof RequestPermissionError) {
        return next({ status: 403, message: e.message });
      }
      next({ status: 500, message: e.message });
    }
  }
);

requestRoutes.delete('/:requestId', async (req, res, next) => {
  const requestRepository = getRepository(MediaRequest);
  const requestId = Number(req.params.requestId);

  try {
    return await requestLock.dispatch(requestKey(requestId), async () => {
      const request = await requestRepository.findOneOrFail({
        where: { id: requestId },
        relations: { requestedBy: true, modifiedBy: true },
      });

      if (
        !req.user?.hasPermission(Permission.MANAGE_REQUESTS) &&
        (request.requestedBy.id !== req.user?.id ||
          request.status !== MediaRequestStatus.PENDING)
      ) {
        return next({
          status: 401,
          message: 'You do not have permission to delete this request.',
        });
      }

      await requestRepository.remove(request);

      return res.status(204).send();
    });
  } catch (e) {
    logger.error('Something went wrong deleting a request.', {
      label: 'API',
      errorMessage: e.message,
    });
    next({ status: 404, message: 'Request not found.' });
  }
});

requestRoutes.post<{
  requestId: string;
}>(
  '/:requestId/retry',
  isAuthenticated(Permission.MANAGE_REQUESTS),
  async (req, res, next) => {
    const requestRepository = getRepository(MediaRequest);
    const requestId = Number(req.params.requestId);

    try {
      return await requestLock.dispatch(requestKey(requestId), async () => {
        const request = await requestRepository.findOneOrFail({
          where: { id: requestId },
          relations: { requestedBy: true, modifiedBy: true },
        });

        if (request.status !== MediaRequestStatus.FAILED) {
          return next({
            status: 409,
            message: 'Only failed requests can be retried.',
          });
        }

        const retry = async () => {
          // this also triggers updating the parent media's status & sending to *arr
          request.status = MediaRequestStatus.APPROVED;
          request.modifiedBy = req.user;
          await requestRepository.save(request);

          return res.status(200).json(request);
        };

        if (!request.isServiceRequest) {
          return retry();
        }
        if (request.serverId == null) {
          throw new InvalidServiceTargetError('Invalid request destination.');
        }
        return serviceTargetLock.dispatch(
          serviceTargetKey(
            request.type === MediaType.MOVIE ? 'radarr' : 'sonarr',
            request.serverId
          ),
          async () => {
            validateRequestTarget({
              mediaType: request.type,
              serverId: request.serverId,
              isServiceRequest: true,
              is4k: request.is4k,
            });
            return retry();
          }
        );
      });
    } catch (e) {
      if (e instanceof InvalidServiceTargetError) {
        return next({ status: 400, message: e.message });
      }
      logger.error('Error processing request retry', {
        label: 'Media Request',
        message: e.message,
      });
      next({ status: 404, message: 'Request not found.' });
    }
  }
);

requestRoutes.post<{
  requestId: string;
  status: 'approve' | 'decline';
}>(
  '/:requestId/:status',
  isAuthenticated(Permission.MANAGE_REQUESTS),
  async (req, res, next) => {
    const requestRepository = getRepository(MediaRequest);
    const requestId = Number(req.params.requestId);

    try {
      return await requestLock.dispatch(requestKey(requestId), async () => {
        const request = await requestRepository.findOneOrFail({
          where: { id: requestId },
          relations: { requestedBy: true, modifiedBy: true },
        });

        let newStatus: MediaRequestStatus;

        switch (req.params.status) {
          case 'approve':
            newStatus = MediaRequestStatus.APPROVED;
            break;
          case 'decline':
            newStatus = MediaRequestStatus.DECLINED;
            break;
          default:
            return next({
              status: 400,
              message: 'Status must be approve or decline.',
            });
        }

        if (request.status !== MediaRequestStatus.PENDING) {
          return next({
            status: 409,
            message: 'Only pending requests can be approved or declined.',
          });
        }

        request.status = newStatus;
        request.modifiedBy = req.user;
        await requestRepository.save(request);

        return res.status(200).json(request);
      });
    } catch (e) {
      logger.error('Error processing request update', {
        label: 'Media Request',
        message: e.message,
      });
      next({ status: 404, message: 'Request not found.' });
    }
  }
);

export default requestRoutes;
