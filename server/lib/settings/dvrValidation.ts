const INDEPENDENT_DESTINATION_FIELD = 'independentRequestDestination';

type DvrEndpoint = {
  id?: number;
  hostname: string;
  port: number;
  baseUrl?: string;
  independentRequestDestination?: boolean;
};

export const hasIndependentRequestDestination = (body: {
  independentRequestDestination?: unknown;
}): boolean =>
  Object.prototype.hasOwnProperty.call(body, INDEPENDENT_DESTINATION_FIELD);

export const hasValidIndependentRequestDestination = (body: {
  independentRequestDestination?: unknown;
}): boolean =>
  !hasIndependentRequestDestination(body) ||
  typeof body.independentRequestDestination === 'boolean';

export const isSameDvrEndpoint = (
  first: DvrEndpoint,
  second: DvrEndpoint
): boolean =>
  first.hostname === second.hostname &&
  first.port === second.port &&
  first.baseUrl === second.baseUrl;

export const conflictsWithIndependentDvrEndpoint = (
  candidate: DvrEndpoint,
  configured: DvrEndpoint[],
  excludeId?: number
): boolean =>
  configured.some(
    (server) =>
      server.id !== excludeId &&
      isSameDvrEndpoint(candidate, server) &&
      (candidate.independentRequestDestination === true ||
        server.independentRequestDestination === true)
  );

export const findAmbiguousIndependentDvrServerIds = (
  configured: DvrEndpoint[]
): Set<number> => {
  const ambiguousIds = new Set<number>();

  for (let index = 0; index < configured.length; index++) {
    for (
      let comparison = index + 1;
      comparison < configured.length;
      comparison++
    ) {
      const first = configured[index];
      const second = configured[comparison];
      if (
        isSameDvrEndpoint(first, second) &&
        (first.independentRequestDestination === true ||
          second.independentRequestDestination === true)
      ) {
        if (first.id !== undefined) {
          ambiguousIds.add(first.id);
        }
        if (second.id !== undefined) {
          ambiguousIds.add(second.id);
        }
      }
    }
  }

  return ambiguousIds;
};
