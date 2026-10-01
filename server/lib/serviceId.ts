import { MediaRequestStatus, MediaType } from '@server/constants/media';
import dataSource, { getRepository } from '@server/datasource';
import { MediaRequest } from '@server/entity/MediaRequest';
import MediaServiceStatus from '@server/entity/MediaServiceStatus';
import OverrideRule from '@server/entity/OverrideRule';
import { User } from '@server/entity/User';
import { getSettings } from '@server/lib/settings';

export type ServiceType = 'radarr' | 'sonarr';

const maxOrNegativeOne = (values: (number | null | undefined)[]): number =>
  values.reduce<number>(
    (maximum, value) =>
      Number.isInteger(value) ? Math.max(maximum, value as number) : maximum,
    -1
  );

const rawMaximum = (value: number | string | null | undefined): number =>
  value == null || !Number.isInteger(Number(value)) ? -1 : Number(value);

export const getObservedServiceIdMax = async (
  type: ServiceType
): Promise<number> => {
  const settings = getSettings();
  const mediaType = type === 'radarr' ? MediaType.MOVIE : MediaType.TV;
  const ruleColumn = type === 'radarr' ? 'radarrServiceId' : 'sonarrServiceId';
  const [requestResult, ruleResult, users, statusResult] = await Promise.all([
    getRepository(MediaRequest)
      .createQueryBuilder('request')
      .select('MAX(request.serverId)', 'maxId')
      .where('request.type = :type', { type: mediaType })
      .getRawOne<{ maxId: number | string | null }>(),
    getRepository(OverrideRule)
      .createQueryBuilder('rule')
      .select(`MAX(rule.${ruleColumn})`, 'maxId')
      .getRawOne<{ maxId: number | string | null }>(),
    getRepository(User).find({ select: { requestServices: true } }),
    getRepository(MediaServiceStatus)
      .createQueryBuilder('status')
      .select('MAX(status.serviceId)', 'maxId')
      .where('status.serviceType = :type', { type })
      .getRawOne<{ maxId: number | string | null }>(),
  ]);
  const prefix = `${type}:`;
  const grantIds = users
    .flatMap((user) => user.requestServices ?? [])
    .filter((grant) => grant.startsWith(prefix))
    .map((grant) => Number(grant.slice(prefix.length)))
    .filter(Number.isInteger);

  return maxOrNegativeOne([
    settings[type].reduce(
      (maximum, service) => Math.max(maximum, service.id),
      -1
    ),
    rawMaximum(requestResult?.maxId),
    rawMaximum(ruleResult?.maxId),
    grantIds.reduce((maximum, id) => Math.max(maximum, id), -1),
    rawMaximum(statusResult?.maxId),
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

export const hasActiveServiceRequests = async (
  type: ServiceType,
  id: number
): Promise<boolean> => {
  const common = {
    serverId: id,
    type: type === 'radarr' ? MediaType.MOVIE : MediaType.TV,
    isServiceRequest: true,
  };
  return (
    (await getRepository(MediaRequest).exists({
      where: { ...common, status: MediaRequestStatus.PENDING },
    })) ||
    (await getRepository(MediaRequest).exists({
      where: { ...common, status: MediaRequestStatus.APPROVED },
    }))
  );
};

export const removeServiceTargetReferences = async (
  type: ServiceType,
  id: number
): Promise<void> => {
  const identifier = `${type}:${id}`;
  await dataSource.transaction(async (manager) => {
    const users = await manager
      .getRepository(User)
      .createQueryBuilder('user')
      .where('user.requestServices LIKE :identifier', {
        identifier: `%"${identifier}"%`,
      })
      .getMany();
    for (const user of users) {
      user.requestServices = (user.requestServices ?? []).filter(
        (grant) => grant !== identifier
      );
      await manager.getRepository(User).save(user);
    }
    await manager.getRepository(MediaServiceStatus).delete({
      serviceId: id,
      serviceType: type,
    });
    await manager
      .getRepository(OverrideRule)
      .createQueryBuilder()
      .update()
      .set(
        type === 'radarr'
          ? { radarrServiceId: () => 'NULL' }
          : { sonarrServiceId: () => 'NULL' }
      )
      .where(
        `${type === 'radarr' ? 'radarrServiceId' : 'sonarrServiceId'} = :id`,
        { id }
      )
      .execute();
  });
};
