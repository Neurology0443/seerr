import AsyncLock from '@server/utils/asyncLock';

export type DvrIdentityKind = 'radarr' | 'sonarr';

const dvrIdentityLock = new AsyncLock();
const dvrSettingsMutationLock = new AsyncLock();

export const dvrIdentityKey = (
  kind: DvrIdentityKind,
  serverId: number
): string => `${kind}:${serverId}`;

export const withDvrIdentityLock = <T>(
  kind: DvrIdentityKind,
  serverId: number,
  callback: () => Promise<T>
): Promise<T> =>
  dvrIdentityLock.dispatch(dvrIdentityKey(kind, serverId), callback);

export const withDvrSettingsMutationLock = <T>(
  kind: DvrIdentityKind,
  callback: () => Promise<T>
): Promise<T> => dvrSettingsMutationLock.dispatch(kind, callback);
