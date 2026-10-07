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
import { In, type EntityManager } from 'typeorm';

export type DestinationSeasonState = {
  seasonNumber: number;
  status: MediaStatus;
};

type DestinationSeasonObservation = {
  seasonNumber: number;
  totalEpisodes: number;
  availableEpisodes: number;
  monitored: boolean;
};

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
    return currentStatus === MediaStatus.PROCESSING
      ? MediaStatus.PROCESSING
      : MediaStatus.PENDING;
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
    where:
      mediaType === MediaType.TV && tvdbId
        ? [
            { tmdbId, mediaType },
            { tvdbId, mediaType },
          ]
        : { tmdbId, mediaType },
  });

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

  if (requests[0].type === MediaType.MOVIE) {
    if (destination.status !== MediaStatus.AVAILABLE) {
      return;
    }
    for (const request of requests) {
      request.status = MediaRequestStatus.COMPLETED;
      await requestRepository.save(request);
    }
    return;
  }

  const destinationSeasons = await entityManager.find(
    MediaDestinationSeasonStatus,
    { where: { destinationStatusId: destination.id } }
  );
  const statusBySeason = new Map(
    destinationSeasons.map((season) => [season.seasonNumber, season.status])
  );
  const seasonRequestRepository = entityManager.getRepository(SeasonRequest);

  for (const request of requests) {
    for (const season of request.seasons) {
      if (
        season.status !== MediaRequestStatus.COMPLETED &&
        statusBySeason.get(season.seasonNumber) === MediaStatus.AVAILABLE
      ) {
        season.status = MediaRequestStatus.COMPLETED;
        await seasonRequestRepository.save(season);
      }
    }
    if (
      request.seasons.length > 0 &&
      request.seasons.every(
        (season) => season.status === MediaRequestStatus.COMPLETED
      )
    ) {
      request.status = MediaRequestStatus.COMPLETED;
      await requestRepository.save(request);
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
    request.status = MediaRequestStatus.DECLINED;
    await requestRepository.save(request);
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
    if (observation.totalEpisodes <= 0) {
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

  for (const season of refreshedSeasons) {
    if (
      season.status !== MediaStatus.PENDING &&
      season.status !== MediaStatus.PROCESSING
    ) {
      continue;
    }
    const activeForSeason = await entityManager
      .getRepository(MediaRequest)
      .createQueryBuilder('request')
      .innerJoin('request.seasons', 'seasonRequest')
      .where('request.mediaId = :mediaId', { mediaId })
      .andWhere('request.serverId = :serverId', { serverId })
      .andWhere('request.status IN (:...statuses)', {
        statuses: [MediaRequestStatus.PENDING, MediaRequestStatus.APPROVED],
      })
      .andWhere('seasonRequest.seasonNumber = :seasonNumber', {
        seasonNumber: season.seasonNumber,
      })
      .getCount();
    if (activeForSeason === 0) {
      season.status = MediaStatus.UNKNOWN;
      await seasonRepository.save(season);
    }
  }

  const refreshedDestination = await destinationRepository.findOneOrFail({
    where: { id: destination.id },
  });
  if (hadScannerAvailability) {
    refreshedDestination.status = MediaStatus.DELETED;
    await destinationRepository.save(refreshedDestination);
    return;
  }

  const activeRequests = await entityManager.count(MediaRequest, {
    where: {
      media: { id: mediaId },
      serverId,
      status: In([MediaRequestStatus.PENDING, MediaRequestStatus.APPROVED]),
    },
  });
  if (activeRequests === 0) {
    refreshedDestination.status = MediaStatus.UNKNOWN;
    await destinationRepository.save(refreshedDestination);
  }
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
