import { MediaType } from '@server/constants/media';
import { getRepository } from '@server/datasource';
import { MediaRequest } from '@server/entity/MediaRequest';
import MediaServiceStatus from '@server/entity/MediaServiceStatus';
import OverrideRule from '@server/entity/OverrideRule';
import { User } from '@server/entity/User';
import { getSettings } from '@server/lib/settings';

export type ServiceType = 'radarr' | 'sonarr';

const maxOrNegativeOne = (values: (number | null | undefined)[]): number =>
  Math.max(
    -1,
    ...values.filter((value): value is number => Number.isInteger(value))
  );

export const getObservedServiceIdMax = async (
  type: ServiceType
): Promise<number> => {
  const settings = getSettings();
  const mediaType = type === 'radarr' ? MediaType.MOVIE : MediaType.TV;
  const [requests, rules, users, statuses] = await Promise.all([
    getRepository(MediaRequest).find({
      select: { serverId: true },
      where: { type: mediaType },
    }),
    getRepository(OverrideRule).find({
      select:
        type === 'radarr'
          ? { radarrServiceId: true }
          : { sonarrServiceId: true },
    }),
    getRepository(User).find({ select: { requestServices: true } }),
    getRepository(MediaServiceStatus).find({
      select: { serviceId: true },
      where: { serviceType: type },
    }),
  ]);
  const prefix = `${type}:`;
  const grantIds = users
    .flatMap((user) => user.requestServices ?? [])
    .filter((grant) => grant.startsWith(prefix))
    .map((grant) => Number(grant.slice(prefix.length)))
    .filter(Number.isInteger);

  return maxOrNegativeOne([
    ...settings[type].map((service) => service.id),
    ...requests.map((request) => request.serverId),
    ...rules.map((rule) =>
      type === 'radarr' ? rule.radarrServiceId : rule.sonarrServiceId
    ),
    ...grantIds,
    ...statuses.map((status) => status.serviceId),
  ]);
};

export const allocateServiceId = async (type: ServiceType): Promise<number> =>
  getSettings().allocateServiceId(type, await getObservedServiceIdMax(type));

export const hasServiceReferences = async (
  type: ServiceType,
  id: number
): Promise<boolean> => {
  const mediaType = type === 'radarr' ? MediaType.MOVIE : MediaType.TV;
  const grant = `${type}:${id}`;
  const [request, status, rule, users] = await Promise.all([
    getRepository(MediaRequest).exists({
      where: { serverId: id, type: mediaType },
    }),
    getRepository(MediaServiceStatus).exists({
      where: { serviceId: id, serviceType: type },
    }),
    getRepository(OverrideRule).exists({
      where:
        type === 'radarr' ? { radarrServiceId: id } : { sonarrServiceId: id },
    }),
    getRepository(User).find({ select: { requestServices: true } }),
  ]);
  return (
    request ||
    status ||
    rule ||
    users.some((user) => user.requestServices?.includes(grant))
  );
};
