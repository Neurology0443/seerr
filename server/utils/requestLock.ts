import type { MediaType } from '@server/constants/media';
import AsyncLock from '@server/utils/asyncLock';

// Keyed on user id or request id. Never dispatch from a subscriber or
// transaction as a waiter would block while holding the save's connection.
const requestLock = new AsyncLock();

// keyed on media. always taken inside requestLock, never around it.
export const mediaLock = new AsyncLock();
// Coordinates request persistence with deletion of one destination. Never use
// this lock from an entity subscriber.
export const serviceTargetLock = new AsyncLock();

export const userKey = (userId: number) => `user:${userId}`;
export const requestKey = (requestId: number) => `request:${requestId}`;
export const mediaKey = (mediaType: MediaType, mediaId: number) =>
  `${mediaType}:${mediaId}`;
export const serviceTargetKey = (type: 'radarr' | 'sonarr', id: number) =>
  `${type}:${id}`;

export const withServiceTargetLocks = async <T>(
  targets: { type: 'radarr' | 'sonarr'; id: number }[],
  callback: () => Promise<T>
): Promise<T> => {
  const keys = [
    ...new Map(
      targets.map((target) => [serviceTargetKey(target.type, target.id), target])
    ).values(),
  ]
    .sort((a, b) => a.type.localeCompare(b.type) || a.id - b.id)
    .map(({ type, id }) => serviceTargetKey(type, id));
  const dispatch = (index: number): Promise<T> =>
    index === keys.length
      ? callback()
      : serviceTargetLock.dispatch(keys[index], () => dispatch(index + 1));
  return dispatch(0);
};

export default requestLock;
