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
import SeasonRequest from '@server/entity/SeasonRequest';
import { In, Not, type EntityManager } from 'typeorm';

export type DestinationSeasonState = {
  seasonNumber: number;
  status: MediaStatus;
};

type DestinationSeasonObservation = {
  seasonNumber: number;
  totalEpisodes: number;
  availableEpisodes: number;
  monitored: boolean;
  observedInService?: boolean;
};

export class MediaIdentityConflictError extends Error {}

const managerOrDefault = (manager?: EntityManager): EntityManager =>
  manager ?? getRepository(Media).manager;

export const transitionMovieDestinationStatus = (
  currentStatus: MediaStatus,
  hasFile: boolean,
  monitored: boolean
): MediaStatus => {
  if (hasFile) {
    return MediaStatus.AVAILABLE;
  }
  if (monitored) {
    return MediaStatus.PROCESSING;
  }
  if (currentStatus === MediaStatus.PROCESSING) {
    return MediaStatus.UNKNOWN;
  }
  if (currentStatus === MediaStatus.AVAILABLE) {
    return MediaStatus.DELETED;
  }
  return currentStatus;
};

export const transitionDestinationSeasonStatus = (
  currentStatus: MediaStatus,
  observation: DestinationSeasonObservation
): MediaStatus => {
  if (observation.totalEpisodes <= 0) {
    return currentStatus;
  }
  if (observation.availableEpisodes === observation.totalEpisodes) {
    return MediaStatus.AVAILABLE;
  }
  if (observation.availableEpisodes > 0) {
    return MediaStatus.PARTIALLY_AVAILABLE;
  }
  if (observation.monitored) {
    return MediaStatus.PROCESSING;
  }
  if (currentStatus === MediaStatus.PROCESSING) {
    return MediaStatus.UNKNOWN;
  }
  if (
    currentStatus === MediaStatus.AVAILABLE ||
    currentStatus === MediaStatus.PARTIALLY_AVAILABLE
  ) {
    return MediaStatus.DELETED;
  }
  return currentStatus;
};

export const rollupDestinationTvStatus = (
  currentStatus: MediaStatus,
  seasonStates: DestinationSeasonState[]
): MediaStatus => {
  const relevantStates = seasonStates.filter(
    (season) => season.seasonNumber !== 0
  );

  if (relevantStates.length === 0) {
    return currentStatus;
  }
  if (
    relevantStates.every((season) => season.status === MediaStatus.AVAILABLE)
  ) {
    return MediaStatus.AVAILABLE;
  }
  if (
    relevantStates.some(
      (season) =>
        season.status === MediaStatus.AVAILABLE ||
        season.status === MediaStatus.PARTIALLY_AVAILABLE
    )
  ) {
    return MediaStatus.PARTIALLY_AVAILABLE;
  }
  if (
    relevantStates.some((season) => season.status === MediaStatus.PROCESSING)
  ) {
    return MediaStatus.PROCESSING;
  }
  if (relevantStates.some((season) => season.status === MediaStatus.PENDING)) {
    return MediaStatus.PENDING;
  }
  if (
    relevantStates.some((season) => season.status === MediaStatus.DELETED) &&
    relevantStates.every(
      (season) =>
        season.status === MediaStatus.DELETED ||
        season.status === MediaStatus.UNKNOWN
    )
  ) {
    return MediaStatus.DELETED;
  }
  if (currentStatus === MediaStatus.PENDING) {
    return MediaStatus.PENDING;
  }
  if (currentStatus === MediaStatus.DELETED) {
    return MediaStatus.DELETED;
  }
  return MediaStatus.UNKNOWN;
};

const ensureMediaIdentity = async (
  {
    tmdbId,
    tvdbId,
    mediaType,
  }: { tmdbId: number; tvdbId?: number; mediaType: MediaType },
  manager: EntityManager
): Promise<Media> => {
  const mediaRepository = manager.getRepository(Media);
  let media = await mediaRepository.findOne({
    where: { tmdbId, mediaType },
  });

  if (mediaType === MediaType.TV && media) {
    if (media.tvdbId && tvdbId && media.tvdbId !== tvdbId) {
      throw new MediaIdentityConflictError(
        `TV media ${media.id} already uses TVDB ID ${media.tvdbId}; refusing incoming TVDB ID ${tvdbId}.`
      );
    }
    if (!media.tvdbId && tvdbId) {
      const conflictingMedia = await mediaRepository.findOne({
        where: { tvdbId },
      });
      if (conflictingMedia && conflictingMedia.id !== media.id) {
        throw new MediaIdentityConflictError(
          `TVDB ID ${tvdbId} is already owned by media ${conflictingMedia.id}; refusing to merge it with media ${media.id}.`
        );
      }
      media.tvdbId = tvdbId;
      media = await mediaRepository.save(media);
    }
    return media;
  }

  if (!media && mediaType === MediaType.TV && tvdbId) {
    media = await mediaRepository.findOne({ where: { tvdbId } });
  }

  if (!media) {
    media = await mediaRepository.save(
      new Media({
        tmdbId,
        tvdbId,
        mediaType,
        status: MediaStatus.UNKNOWN,
        status4k: MediaStatus.UNKNOWN,
      })
    );
  }

  return media;
};

const transitionApprovedRequest = async (
  requestId: number,
  status: MediaRequestStatus.COMPLETED | MediaRequestStatus.DECLINED,
  manager: EntityManager
): Promise<boolean> => {
  const result = await manager
    .createQueryBuilder()
    .update(MediaRequest)
    .set({ status })
    .where('id = :requestId', { requestId })
    .andWhere('status = :approved', {
      approved: MediaRequestStatus.APPROVED,
    })
    .callListeners(false)
    .execute();

  return result.affected === 1;
};

export const completeRequestsForDestination = async (
  mediaId: number,
  serverId: number,
  manager?: EntityManager
): Promise<void> => {
  const entityManager = managerOrDefault(manager);
  const requestRepository = entityManager.getRepository(MediaRequest);
  const destination = await entityManager.findOne(MediaDestinationStatus, {
    where: { mediaId, serverId },
  });
  if (!destination) {
    return;
  }

  const requests = await requestRepository.find({
    where: {
      media: { id: mediaId },
      serverId,
      status: MediaRequestStatus.APPROVED,
    },
    relations: { media: true, seasons: true },
  });
  if (requests.length === 0) {
    return;
  }

  const destinationSeasons = await entityManager.find(
    MediaDestinationSeasonStatus,
    { where: { destinationStatusId: destination.id } }
  );
  const statusBySeason = new Map(
    destinationSeasons.map((season) => [season.seasonNumber, season.status])
  );

  for (const request of requests) {
    if (request.type === MediaType.MOVIE) {
      if (destination.status === MediaStatus.AVAILABLE) {
        await transitionApprovedRequest(
          request.id,
          MediaRequestStatus.COMPLETED,
          entityManager
        );
      }
      continue;
    }

    for (const season of request.seasons) {
      if (statusBySeason.get(season.seasonNumber) === MediaStatus.AVAILABLE) {
        await entityManager
          .createQueryBuilder()
          .update(SeasonRequest)
          .set({ status: MediaRequestStatus.COMPLETED })
          .where('id = :seasonRequestId', { seasonRequestId: season.id })
          .andWhere('status IN (:...eligibleSeasonStatuses)', {
            eligibleSeasonStatuses: [
              MediaRequestStatus.PENDING,
              MediaRequestStatus.APPROVED,
            ],
          })
          .andWhere(
            `EXISTS (SELECT 1 FROM "media_request" "parentRequest" WHERE "parentRequest"."id" = :parentRequestId AND "parentRequest"."status" = :approved)`
          )
          .setParameters({
            parentRequestId: request.id,
            approved: MediaRequestStatus.APPROVED,
          })
          .callListeners(false)
          .execute();
      }
    }

    const requestedSeasonCount = await entityManager.count(SeasonRequest, {
      where: { request: { id: request.id } },
    });
    const incompleteSeasonCount = await entityManager.count(SeasonRequest, {
      where: {
        request: { id: request.id },
        status: Not(MediaRequestStatus.COMPLETED),
      },
    });
    if (requestedSeasonCount > 0 && incompleteSeasonCount === 0) {
      await transitionApprovedRequest(
        request.id,
        MediaRequestStatus.COMPLETED,
        entityManager
      );
    }
  }
};

export const declineRequestsForDestination = async (
  mediaId: number,
  serverId: number,
  manager?: EntityManager
): Promise<void> => {
  const entityManager = managerOrDefault(manager);
  const requestRepository = entityManager.getRepository(MediaRequest);
  const requests = await requestRepository.find({
    where: {
      media: { id: mediaId },
      serverId,
      status: MediaRequestStatus.APPROVED,
    },
    relations: { media: true, seasons: true },
  });

  for (const request of requests) {
    if (
      !(await transitionApprovedRequest(
        request.id,
        MediaRequestStatus.DECLINED,
        entityManager
      ))
    ) {
      continue;
    }
    const declinedRequest = await requestRepository.findOneOrFail({
      where: { id: request.id },
      relations: { media: true, seasons: true },
    });
    await reconcileIndependentRequestDecline(declinedRequest, entityManager);
  }
};

export const updateIndependentMovieDestination = async (
  {
    tmdbId,
    serverId,
    externalServiceId,
    externalServiceSlug,
    hasFile,
    monitored,
  }: {
    tmdbId: number;
    serverId: number;
    externalServiceId: number | null;
    externalServiceSlug: string;
    hasFile: boolean;
    monitored: boolean;
  },
  manager?: EntityManager
): Promise<MediaDestinationStatus> => {
  const entityManager = managerOrDefault(manager);
  const media = await ensureMediaIdentity(
    { tmdbId, mediaType: MediaType.MOVIE },
    entityManager
  );
  const destinationRepository = entityManager.getRepository(
    MediaDestinationStatus
  );
  let destination = await destinationRepository.findOne({
    where: { mediaId: media.id, serverId },
  });
  if (!destination) {
    destination = new MediaDestinationStatus({
      mediaId: media.id,
      serverId,
      status: MediaStatus.UNKNOWN,
    });
  }
  destination.status = transitionMovieDestinationStatus(
    destination.status,
    hasFile,
    monitored
  );
  destination.externalServiceId = externalServiceId;
  destination.externalServiceSlug = externalServiceSlug;
  destination = await destinationRepository.save(destination);
  await completeRequestsForDestination(media.id, serverId, entityManager);
  return destination;
};

export const updateIndependentTvDestination = async (
  {
    tmdbId,
    tvdbId,
    serverId,
    externalServiceId,
    externalServiceSlug,
    seasons,
  }: {
    tmdbId: number;
    tvdbId: number;
    serverId: number;
    externalServiceId: number | null;
    externalServiceSlug: string;
    seasons: DestinationSeasonObservation[];
  },
  manager?: EntityManager
): Promise<MediaDestinationStatus> => {
  const entityManager = managerOrDefault(manager);
  const media = await ensureMediaIdentity(
    { tmdbId, tvdbId, mediaType: MediaType.TV },
    entityManager
  );
  const destinationRepository = entityManager.getRepository(
    MediaDestinationStatus
  );
  const seasonRepository = entityManager.getRepository(
    MediaDestinationSeasonStatus
  );
  let destination = await destinationRepository.findOne({
    where: { mediaId: media.id, serverId },
  });
  if (!destination) {
    destination = await destinationRepository.save(
      new MediaDestinationStatus({
        mediaId: media.id,
        serverId,
        status: MediaStatus.UNKNOWN,
        externalServiceId,
        externalServiceSlug,
      })
    );
  }

  destination.externalServiceId = externalServiceId;
  destination.externalServiceSlug = externalServiceSlug;

  const existingSeasons = await seasonRepository.find({
    where: { destinationStatusId: destination.id },
  });
  const bySeason = new Map(
    existingSeasons.map((season) => [season.seasonNumber, season])
  );

  for (const observation of seasons) {
    if (
      observation.totalEpisodes <= 0 ||
      observation.observedInService === false
    ) {
      continue;
    }
    const existing = bySeason.get(observation.seasonNumber);
    const nextStatus = transitionDestinationSeasonStatus(
      existing?.status ?? MediaStatus.UNKNOWN,
      observation
    );
    if (!existing && nextStatus === MediaStatus.UNKNOWN) {
      continue;
    }
    const season =
      existing ??
      new MediaDestinationSeasonStatus({
        destinationStatusId: destination.id,
        seasonNumber: observation.seasonNumber,
      });
    season.status = nextStatus;
    const saved = await seasonRepository.save(season);
    bySeason.set(saved.seasonNumber, saved);
  }

  const observationsBySeason = new Map(
    seasons.map((season) => [season.seasonNumber, season])
  );
  const rollupSeasons = [...bySeason.values()]
    .filter((season) => {
      const observation = observationsBySeason.get(season.seasonNumber);
      return observation
        ? observation.totalEpisodes > 0
        : season.status !== MediaStatus.UNKNOWN;
    })
    .map((season) => ({
      seasonNumber: season.seasonNumber,
      status: season.status,
    }));
  destination.status = rollupDestinationTvStatus(
    destination.status,
    rollupSeasons
  );
  destination = await destinationRepository.save(destination);
  await completeRequestsForDestination(media.id, serverId, entityManager);
  return destination;
};

const releaseRequestDrivenDestinationSeasons = async (
  {
    mediaId,
    serverId,
    destinationStatusId,
    seasonNumbers,
    excludeRequestId,
  }: {
    mediaId: number;
    serverId: number;
    destinationStatusId: number;
    seasonNumbers?: number[];
    excludeRequestId?: number;
  },
  manager: EntityManager
): Promise<void> => {
  const seasonRepository = manager.getRepository(MediaDestinationSeasonStatus);
  const uniqueSeasonNumbers = seasonNumbers
    ? [...new Set(seasonNumbers)]
    : undefined;
  if (uniqueSeasonNumbers?.length === 0) {
    return;
  }
  const seasonStatuses = await seasonRepository.find({
    where: {
      destinationStatusId,
      ...(uniqueSeasonNumbers
        ? { seasonNumber: In(uniqueSeasonNumbers) }
        : undefined),
    },
  });

  for (const seasonStatus of seasonStatuses) {
    if (
      seasonStatus.status !== MediaStatus.PENDING &&
      seasonStatus.status !== MediaStatus.PROCESSING
    ) {
      continue;
    }
    const activeQuery = manager
      .getRepository(MediaRequest)
      .createQueryBuilder('request')
      .innerJoin('request.seasons', 'seasonRequest')
      .where('request.mediaId = :mediaId', { mediaId })
      .andWhere('request.serverId = :serverId', { serverId })
      .andWhere('request.status IN (:...statuses)', {
        statuses: [MediaRequestStatus.PENDING, MediaRequestStatus.APPROVED],
      })
      .andWhere('seasonRequest.seasonNumber = :seasonNumber', {
        seasonNumber: seasonStatus.seasonNumber,
      });
    if (excludeRequestId !== undefined) {
      activeQuery.andWhere('request.id != :excludeRequestId', {
        excludeRequestId,
      });
    }
    if ((await activeQuery.getCount()) === 0) {
      seasonStatus.status = MediaStatus.UNKNOWN;
      await seasonRepository.save(seasonStatus);
    }
  }
};

export const reconcileIndependentTvDestination = async (
  mediaId: number,
  serverId: number,
  manager?: EntityManager,
  excludeRequestId?: number
): Promise<void> => {
  const entityManager = managerOrDefault(manager);
  const destinationRepository = entityManager.getRepository(
    MediaDestinationStatus
  );
  const destination = await destinationRepository.findOne({
    where: { mediaId, serverId },
  });
  if (!destination) {
    return;
  }
  const seasons = await entityManager.find(MediaDestinationSeasonStatus, {
    where: { destinationStatusId: destination.id },
  });
  const relevantSeasons = seasons.filter((season) => season.seasonNumber !== 0);

  if (relevantSeasons.length === 0) {
    const activeRequests = await entityManager.find(MediaRequest, {
      where: {
        media: { id: mediaId },
        serverId,
        ...(excludeRequestId !== undefined
          ? { id: Not(excludeRequestId) }
          : undefined),
        status: In([MediaRequestStatus.PENDING, MediaRequestStatus.APPROVED]),
      },
      select: { id: true, status: true },
    });
    if (
      destination.status === MediaStatus.PENDING ||
      destination.status === MediaStatus.PROCESSING
    ) {
      destination.status = activeRequests.some(
        (request) => request.status === MediaRequestStatus.APPROVED
      )
        ? MediaStatus.PROCESSING
        : activeRequests.length > 0
          ? MediaStatus.PENDING
          : MediaStatus.UNKNOWN;
      await destinationRepository.save(destination);
    }
    return;
  }

  let nextStatus = rollupDestinationTvStatus(
    destination.status,
    relevantSeasons.map((season) => ({
      seasonNumber: season.seasonNumber,
      status: season.status,
    }))
  );
  if (
    nextStatus === MediaStatus.PENDING ||
    nextStatus === MediaStatus.PROCESSING
  ) {
    const activeRequests = await entityManager.count(MediaRequest, {
      where: {
        media: { id: mediaId },
        serverId,
        ...(excludeRequestId !== undefined
          ? { id: Not(excludeRequestId) }
          : undefined),
        status: In([MediaRequestStatus.PENDING, MediaRequestStatus.APPROVED]),
      },
    });
    if (activeRequests === 0) {
      nextStatus = MediaStatus.UNKNOWN;
    }
  }
  if (nextStatus !== destination.status) {
    destination.status = nextStatus;
    await destinationRepository.save(destination);
  }
};

export const reconcileIndependentRequestDecline = async (
  request: MediaRequest,
  manager?: EntityManager
): Promise<void> => {
  const entityManager = managerOrDefault(manager);
  const destinationRepository = entityManager.getRepository(
    MediaDestinationStatus
  );
  const destination = await destinationRepository.findOne({
    where: { mediaId: request.media.id, serverId: request.serverId },
  });
  if (!destination) {
    return;
  }

  if (request.type === MediaType.TV) {
    await entityManager
      .createQueryBuilder()
      .update(SeasonRequest)
      .set({ status: MediaRequestStatus.DECLINED })
      .where('requestId = :requestId', { requestId: request.id })
      .andWhere('status IN (:...activeStatuses)', {
        activeStatuses: [
          MediaRequestStatus.PENDING,
          MediaRequestStatus.APPROVED,
        ],
      })
      .callListeners(false)
      .execute();
    await releaseRequestDrivenDestinationSeasons(
      {
        mediaId: request.media.id,
        serverId: request.serverId,
        destinationStatusId: destination.id,
        seasonNumbers: request.seasons.map((season) => season.seasonNumber),
        excludeRequestId: request.id,
      },
      entityManager
    );
    await reconcileIndependentTvDestination(
      request.media.id,
      request.serverId,
      entityManager,
      request.id
    );
    return;
  }

  const otherActive = await entityManager.count(MediaRequest, {
    where: {
      media: { id: request.media.id },
      serverId: request.serverId,
      id: Not(request.id),
      status: In([MediaRequestStatus.PENDING, MediaRequestStatus.APPROVED]),
    },
  });
  if (
    otherActive === 0 &&
    (destination.status === MediaStatus.PENDING ||
      destination.status === MediaStatus.PROCESSING)
  ) {
    destination.status = MediaStatus.UNKNOWN;
    await destinationRepository.save(destination);
  }
};

export const markMissingMovieDestination = async (
  mediaId: number,
  serverId: number,
  manager?: EntityManager
): Promise<void> => {
  const entityManager = managerOrDefault(manager);
  const destinationRepository = entityManager.getRepository(
    MediaDestinationStatus
  );
  const destination = await destinationRepository.findOne({
    where: { mediaId, serverId },
  });
  if (!destination) {
    return;
  }
  if (destination.status === MediaStatus.PROCESSING) {
    await declineRequestsForDestination(mediaId, serverId, entityManager);
    const activeRequests = await entityManager.count(MediaRequest, {
      where: {
        media: { id: mediaId },
        serverId,
        status: In([MediaRequestStatus.PENDING, MediaRequestStatus.APPROVED]),
      },
    });
    if (activeRequests === 0) {
      const refreshedDestination = await destinationRepository.findOneOrFail({
        where: { id: destination.id },
      });
      if (
        refreshedDestination.status === MediaStatus.PENDING ||
        refreshedDestination.status === MediaStatus.PROCESSING
      ) {
        refreshedDestination.status = MediaStatus.UNKNOWN;
        await destinationRepository.save(refreshedDestination);
      }
    }
  } else if (destination.status === MediaStatus.AVAILABLE) {
    destination.status = MediaStatus.DELETED;
    await destinationRepository.save(destination);
  }
};

export const markMissingTvDestination = async (
  mediaId: number,
  serverId: number,
  manager?: EntityManager
): Promise<void> => {
  const entityManager = managerOrDefault(manager);
  const destinationRepository = entityManager.getRepository(
    MediaDestinationStatus
  );
  const seasonRepository = entityManager.getRepository(
    MediaDestinationSeasonStatus
  );
  const destination = await destinationRepository.findOne({
    where: { mediaId, serverId },
  });
  if (!destination) {
    return;
  }
  const existingSeasons = await seasonRepository.find({
    where: { destinationStatusId: destination.id },
  });
  const hadScannerAvailability =
    destination.status === MediaStatus.AVAILABLE ||
    destination.status === MediaStatus.PARTIALLY_AVAILABLE ||
    existingSeasons.some((season) =>
      [MediaStatus.AVAILABLE, MediaStatus.PARTIALLY_AVAILABLE].includes(
        season.status
      )
    );

  await declineRequestsForDestination(mediaId, serverId, entityManager);

  const refreshedDestination = await destinationRepository.findOneOrFail({
    where: { id: destination.id },
  });
  if (hadScannerAvailability) {
    refreshedDestination.status = MediaStatus.DELETED;
    await destinationRepository.save(refreshedDestination);
  }

  const refreshedSeasons = await seasonRepository.find({
    where: { destinationStatusId: destination.id },
  });
  const changedSeasons = refreshedSeasons.filter((season) =>
    [MediaStatus.AVAILABLE, MediaStatus.PARTIALLY_AVAILABLE].includes(
      season.status
    )
  );
  for (const season of changedSeasons) {
    season.status = MediaStatus.DELETED;
  }
  if (changedSeasons.length > 0) {
    await seasonRepository.save(changedSeasons);
  }

  await releaseRequestDrivenDestinationSeasons(
    { mediaId, serverId, destinationStatusId: destination.id },
    entityManager
  );
  await reconcileIndependentTvDestination(mediaId, serverId, entityManager);
};

export const findIndependentDestinationCandidates = async (
  serverId: number,
  mediaType: MediaType,
  statuses: MediaStatus[],
  manager?: EntityManager
): Promise<MediaDestinationStatus[]> => {
  const entityManager = managerOrDefault(manager);
  return entityManager.getRepository(MediaDestinationStatus).find({
    where: {
      serverId,
      status: In(statuses),
      media: { mediaType },
    },
    relations: { media: true },
  });
};
