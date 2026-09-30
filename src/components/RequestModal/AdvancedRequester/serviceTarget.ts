import type { ServiceCommonServer } from '@server/interfaces/api/serviceInterfaces';
import { isMultiServiceTarget } from '@server/utils/serviceTarget';

export const getSelectableServers = (
  servers: ServiceCommonServer[] | undefined,
  serverFixed: boolean,
  fixedServerId?: number | null
): ServiceCommonServer[] => {
  if (!servers) return [];
  if (serverFixed && fixedServerId != null) {
    return servers.filter((server) => server.id === fixedServerId);
  }
  return servers.filter((server) => !isMultiServiceTarget(server));
};
