import type {
  MovieRequestTarget,
  TvRequestTarget,
} from '@server/interfaces/api/requestInterfaces';

export const getDefaultRequestTarget = <T extends MovieRequestTarget>(
  targets: T[] | undefined,
  is4k: boolean
): T | undefined =>
  targets?.find((target) => target.isDefault && target.is4k === is4k);

export const isEditDestinationReadOnly = (
  serverId: number | null | undefined,
  target: MovieRequestTarget | undefined
): boolean => serverId != null && (!target || target.isIndependent);

export const getEditServerId = (
  originalServerId: number | null | undefined,
  target: MovieRequestTarget | undefined,
  selectedServerId: number | undefined
): number | undefined => {
  if (target?.isIndependent) return originalServerId ?? undefined;
  if (originalServerId != null && !target) return undefined;
  return selectedServerId;
};

export const canRequestTargetTier = (
  targets: MovieRequestTarget[] | undefined,
  is4k: boolean,
  canSelectDestination: boolean
): boolean =>
  targets?.some(
    (target) =>
      target.is4k === is4k &&
      target.requestable &&
      (canSelectDestination || target.isDefault)
  ) === true;

export const getRequestableSeasonNumbers = (
  target: TvRequestTarget | undefined
): number[] =>
  target?.seasons
    .filter((season) => season.requestable)
    .map((season) => season.seasonNumber) ?? [];

export const getTvRequestSeasonPayload = (
  target: TvRequestTarget | undefined,
  selectedSeasons: number[],
  partialRequestsEnabled: boolean
): number[] => {
  const requestableSeasons = getRequestableSeasonNumbers(target);

  return (
    partialRequestsEnabled
      ? selectedSeasons.filter((season) => requestableSeasons.includes(season))
      : requestableSeasons
  ).toSorted((first, second) => first - second);
};

type PendingRequest = {
  id: number;
  serverId?: number | null;
  is4k: boolean;
};

export type PendingRequestGroup<T extends PendingRequest> = {
  key: string;
  is4k: boolean;
  isIndependent: boolean;
  destinationName?: string;
  requests: T[];
};

export const groupPendingRequests = <T extends PendingRequest>(
  requests: T[],
  targets: MovieRequestTarget[] | undefined
): PendingRequestGroup<T>[] => {
  const groups = new Map<string, PendingRequestGroup<T>>();

  requests.forEach((request) => {
    const target = targets?.find(
      (candidate) => candidate.serverId === request.serverId
    );
    const key =
      request.serverId == null
        ? `historical:${request.id}`
        : target
          ? target.isIndependent
            ? `independent:${target.serverId}:${request.is4k}`
            : `native:${target.serverId}:${request.is4k}`
          : `unresolved:${request.id}`;
    const existing = groups.get(key);

    if (existing) {
      existing.requests.push(request);
      return;
    }

    groups.set(key, {
      key,
      is4k: request.is4k,
      isIndependent: target?.isIndependent === true,
      destinationName: target?.name,
      requests: [request],
    });
  });

  return [...groups.values()];
};
