import type { DVRSettings } from '@server/lib/settings';
import { isSameDvrEndpoint } from '@server/lib/settings/dvrValidation';
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

// Existing-server mutations take identity before settings, so waiting for one
// server's network operation never holds the settings lock for other servers.
// Remote Arr operations take identity only; settings protects shared mutations.
export const withDvrSettingsMutationLock = <T>(
  kind: DvrIdentityKind,
  callback: () => Promise<T>
): Promise<T> => dvrSettingsMutationLock.dispatch(kind, callback);

export type DvrConnectionSettings = Pick<
  DVRSettings,
  'hostname' | 'port' | 'useSsl' | 'baseUrl' | 'apiKey'
>;

export const hasDvrConnectionChanged = (
  previous: DvrConnectionSettings,
  next: DvrConnectionSettings
): boolean =>
  previous.hostname !== next.hostname ||
  previous.port !== next.port ||
  Boolean(previous.useSsl) !== Boolean(next.useSsl) ||
  (previous.baseUrl ?? '') !== (next.baseUrl ?? '') ||
  previous.apiKey !== next.apiKey;

export const hasDvrEndpointChanged = (
  previous: DvrConnectionSettings,
  next: DvrConnectionSettings
): boolean =>
  !isSameDvrEndpoint(previous, next) ||
  Boolean(previous.useSsl) !== Boolean(next.useSsl);
