import StatusBadge, { getStatusLabel } from '@app/components/StatusBadge';
import defineMessages from '@app/utils/defineMessages';
import { MediaRequestStatus, MediaStatus } from '@server/constants/media';
import type { MediaRequest } from '@server/entity/MediaRequest';
import type MediaServiceStatus from '@server/entity/MediaServiceStatus';
import type { ServiceCommonServer } from '@server/interfaces/api/serviceInterfaces';
import { useIntl } from 'react-intl';
import useSWR from 'swr';

const messages = defineMessages('components.StatusBadge.ServiceStatusBadges', {
  statusinservice: '{status} in {label}',
});

interface ServiceStatusBadgesProps {
  serviceStatuses?: MediaServiceStatus[];
  requests?: MediaRequest[];
  mediaType: 'movie' | 'tv';
  plexUrl?: string;
  tmdbId?: number;
  title?: string | string[];
  seasonNumber?: number;
}

const ServiceStatusBadges = ({
  serviceStatuses,
  requests,
  mediaType,
  plexUrl,
  tmdbId,
  title,
  seasonNumber,
}: ServiceStatusBadgesProps) => {
  const intl = useIntl();
  const pendingServiceRequests = (requests ?? []).filter(
    (request) =>
      request.isServiceRequest &&
      request.status === MediaRequestStatus.PENDING &&
      seasonNumber === undefined
  );
  const { data: services } = useSWR<ServiceCommonServer[]>(
    serviceStatuses?.length || pendingServiceRequests.length
      ? `/api/v1/service/${mediaType === 'movie' ? 'radarr' : 'sonarr'}`
      : null
  );

  if (!services || (!serviceStatuses?.length && !pendingServiceRequests.length))
    return null;

  const items = (serviceStatuses ?? [])
    .map((ss) => {
      const server = services.find((s) => s.id === ss.serviceId);
      if (!server) return null;
      const status =
        seasonNumber !== undefined
          ? ss.seasonStatuses?.[seasonNumber]
          : ss.status;
      if (
        status === undefined ||
        status === MediaStatus.UNKNOWN ||
        status === MediaStatus.DELETED
      ) {
        return null;
      }
      const downloadItem =
        seasonNumber === undefined ? (ss.downloadStatus ?? []) : [];
      return { server, status, downloadItem };
    })
    .filter((x): x is NonNullable<typeof x> => x !== null);

  for (const request of pendingServiceRequests) {
    if (items.some(({ server }) => server.id === request.serverId)) {
      continue;
    }
    const server = services.find((s) => s.id === request.serverId);
    if (!server) {
      continue;
    }
    items.push({ server, status: MediaStatus.PENDING, downloadItem: [] });
  }

  if (!items.length) return null;

  return (
    <>
      {items.map(({ server, status, downloadItem }) => (
        <StatusBadge
          key={`service-badge-${server.id}`}
          status={status}
          downloadItem={downloadItem}
          inProgress={downloadItem.length > 0}
          title={title}
          statusLabelOverride={intl.formatMessage(messages.statusinservice, {
            status: getStatusLabel(intl, status, downloadItem.length > 0),
            label: server.buttonLabel ?? server.name,
          })}
          mediaType={mediaType}
          plexUrl={plexUrl}
          tmdbId={tmdbId}
        />
      ))}
    </>
  );
};

export default ServiceStatusBadges;
