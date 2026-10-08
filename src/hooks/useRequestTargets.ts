import type {
  MovieRequestTarget,
  TvRequestTarget,
} from '@server/interfaces/api/requestInterfaces';
import useSWR, { mutate } from 'swr';

export type RequestTargetMediaType = 'movie' | 'tv';

export const getRequestTargetsKey = (
  mediaType: RequestTargetMediaType,
  tmdbId: number
): string => `/api/v1/${mediaType}/${tmdbId}/request-targets`;

export const isRequestTargetsKey = (key: unknown): key is string =>
  typeof key === 'string' &&
  /^\/api\/v1\/(movie|tv)\/\d+\/request-targets$/.test(key);

export const revalidateRequestTargets = (
  mediaType?: RequestTargetMediaType,
  tmdbId?: number
): Promise<unknown> =>
  mediaType && tmdbId !== undefined
    ? mutate(getRequestTargetsKey(mediaType, tmdbId), undefined, {
        revalidate: true,
      })
    : mutate(isRequestTargetsKey, undefined, { revalidate: true });

export const revalidateRequestData = ({
  mediaType,
  tmdbId,
  requestId,
}: {
  mediaType: RequestTargetMediaType;
  tmdbId: number;
  requestId?: number;
}): Promise<unknown[]> =>
  Promise.all([
    revalidateRequestTargets(mediaType, tmdbId),
    mutate(`/api/v1/${mediaType}/${tmdbId}`),
    mutate(
      (key) =>
        typeof key === 'string' &&
        (key === '/api/v1/request/count' ||
          key.startsWith('/api/v1/request?') ||
          (requestId !== undefined && key === `/api/v1/request/${requestId}`))
    ),
  ]);

type RequestTargetsResult<T> = {
  targets: T[] | undefined;
  error: unknown;
  isLoading: boolean;
  isValidating: boolean;
  revalidate: () => Promise<T[] | undefined>;
};

export function useRequestTargets(
  mediaType: 'movie',
  tmdbId: number
): RequestTargetsResult<MovieRequestTarget>;
export function useRequestTargets(
  mediaType: 'tv',
  tmdbId: number
): RequestTargetsResult<TvRequestTarget>;
export function useRequestTargets(
  mediaType: RequestTargetMediaType,
  tmdbId: number
): RequestTargetsResult<MovieRequestTarget | TvRequestTarget>;
export function useRequestTargets(
  mediaType: RequestTargetMediaType,
  tmdbId: number
): RequestTargetsResult<MovieRequestTarget | TvRequestTarget> {
  const {
    data,
    error,
    isLoading,
    isValidating,
    mutate: revalidate,
  } = useSWR<(MovieRequestTarget | TvRequestTarget)[]>(
    getRequestTargetsKey(mediaType, tmdbId)
  );

  return {
    targets: error ? undefined : data,
    error,
    isLoading,
    isValidating,
    revalidate,
  };
}

export default useRequestTargets;
