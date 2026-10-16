import Spinner from '@app/assets/spinner.svg';
import Badge from '@app/components/Common/Badge';
import Tooltip from '@app/components/Common/Tooltip';
import DownloadBlock from '@app/components/DownloadBlock';
import useSettings from '@app/hooks/useSettings';
import { Permission, useUser } from '@app/hooks/useUser';
import globalMessages from '@app/i18n/globalMessages';
import defineMessages from '@app/utils/defineMessages';
import { deduplicateDownloads, getDownloadSummary } from '@app/utils/downloads';
import { MediaStatus } from '@server/constants/media';
import { MediaServerType } from '@server/constants/server';
import type { DownloadingItem } from '@server/lib/downloadtracker';
import { useIntl } from 'react-intl';

const messages = defineMessages('components.StatusBadge', {
  status: '{status}',
  status4k: '4K {status}',
  playonplex: 'Play on {mediaServerName}',
  openinarr: 'Open in {arr}',
  managemedia: 'Manage {mediaType}',
  seasonnumber: 'S{seasonNumber}',
  seasonepisodenumber: 'S{seasonNumber}E{episodeNumber}',
  standard: 'Standard',
  downloads: 'Downloads',
  noactivedownloads: 'No active downloads.',
});

interface StatusBadgeProps {
  status?: MediaStatus;
  downloadItem?: DownloadingItem[];
  is4k?: boolean;
  inProgress?: boolean;
  plexUrl?: string;
  serviceUrl?: string;
  isIndependent?: boolean;
  tmdbId?: number;
  mediaType?: 'movie' | 'tv';
  title?: string | string[];
  statusLabelOverride?: string;
  destinationName?: string;
  showReleaseTitle?: boolean;
}

const StatusBadge = ({
  status,
  downloadItem = [],
  is4k = false,
  inProgress = false,
  plexUrl,
  serviceUrl,
  isIndependent = false,
  tmdbId,
  mediaType,
  title,
  statusLabelOverride,
  destinationName,
  showReleaseTitle = false,
}: StatusBadgeProps) => {
  const intl = useIntl();
  const { hasPermission } = useUser();
  const settings = useSettings();

  let mediaLink: string | undefined;
  let mediaLinkDescription: string | undefined;

  const uniqueDownloads = deduplicateDownloads(downloadItem);
  const summary = getDownloadSummary(downloadItem, mediaType);

  if (isIndependent && hasPermission(Permission.ADMIN) && serviceUrl) {
    mediaLink = serviceUrl;
    mediaLinkDescription = intl.formatMessage(messages.openinarr, {
      arr: mediaType === 'movie' ? 'Radarr' : 'Sonarr',
    });
  } else if (
    !isIndependent &&
    mediaType &&
    plexUrl &&
    hasPermission(
      is4k
        ? [
            Permission.REQUEST_4K,
            mediaType === 'movie'
              ? Permission.REQUEST_4K_MOVIE
              : Permission.REQUEST_4K_TV,
          ]
        : [
            Permission.REQUEST,
            mediaType === 'movie'
              ? Permission.REQUEST_MOVIE
              : Permission.REQUEST_TV,
          ],
      {
        type: 'or',
      }
    ) &&
    (!is4k ||
      (mediaType === 'movie'
        ? settings.currentSettings.movie4kEnabled
        : settings.currentSettings.series4kEnabled))
  ) {
    mediaLink = plexUrl;
    mediaLinkDescription = intl.formatMessage(messages.playonplex, {
      mediaServerName:
        settings.currentSettings.mediaServerType === MediaServerType.EMBY
          ? 'Emby'
          : settings.currentSettings.mediaServerType === MediaServerType.PLEX
            ? 'Plex'
            : 'Jellyfin',
    });
  } else if (hasPermission(Permission.MANAGE_REQUESTS)) {
    if (mediaType && tmdbId) {
      mediaLink = `/${mediaType}/${tmdbId}?manage=1`;
      mediaLinkDescription = intl.formatMessage(messages.managemedia, {
        mediaType: intl.formatMessage(
          mediaType === 'movie' ? globalMessages.movie : globalMessages.tvshow
        ),
      });
    } else if (hasPermission(Permission.ADMIN) && serviceUrl) {
      mediaLink = serviceUrl;
      mediaLinkDescription = intl.formatMessage(messages.openinarr, {
        arr: mediaType === 'movie' ? 'Radarr' : 'Sonarr',
      });
    }
  }

  const tooltipContent = (
    <>
      {destinationName !== undefined && (
        <div className="break-words px-4 pt-3 font-semibold">
          {destinationName} (
          {is4k ? '4K' : intl.formatMessage(messages.standard)})
        </div>
      )}
      <ul>
        {uniqueDownloads.map(({ item: status, sourceIndex, key }) => (
          <li key={key} className="border-b border-gray-700 last:border-b-0">
            <DownloadBlock
              downloadItem={status}
              title={Array.isArray(title) ? title[sourceIndex] : title}
              is4k={is4k}
              showReleaseTitle={showReleaseTitle}
            />
          </li>
        ))}
      </ul>
    </>
  );

  const downloadIndicator =
    summary.seasonNumber !== undefined
      ? intl.formatMessage(
          summary.episodeNumber !== undefined
            ? messages.seasonepisodenumber
            : messages.seasonnumber,
          {
            seasonNumber: summary.seasonNumber,
            episodeNumber: summary.episodeNumber,
          }
        )
      : summary.count;
  const legacyDownloadIndicator =
    (mediaType === 'tv' && downloadItem[0]?.episode) || summary.count > 1 ? (
      <span className="ml-1">{downloadIndicator}</span>
    ) : null;

  const badgeDownloadProgress = summary.progress !== undefined && (
    <div
      className={`absolute left-0 top-0 z-10 flex h-full ${
        status === MediaStatus.DELETED
          ? 'bg-red-600/80'
          : status === MediaStatus.PROCESSING
            ? 'bg-indigo-500/80'
            : 'bg-green-500/80'
      } transition-all duration-200 ease-in-out`}
      style={{
        width: `${summary.progress}%`,
      }}
    />
  );

  if (destinationName !== undefined) {
    const active = summary.count > 0;
    if (
      !isIndependent &&
      (status === MediaStatus.UNKNOWN || status === undefined)
    )
      return null;
    if (
      isIndependent &&
      (status === MediaStatus.UNKNOWN ||
        status === MediaStatus.DELETED ||
        status === undefined) &&
      !active
    )
      return null;
    if (isIndependent && status === MediaStatus.PENDING) return null;
    let statusMessage =
      status === MediaStatus.AVAILABLE
        ? globalMessages.available
        : status === MediaStatus.PARTIALLY_AVAILABLE
          ? globalMessages.partiallyavailable
          : status === MediaStatus.PROCESSING
            ? globalMessages.processing
            : status === MediaStatus.DELETED
              ? globalMessages.deleted
              : status === MediaStatus.PENDING
                ? globalMessages.pending
                : status === MediaStatus.BLOCKLISTED
                  ? globalMessages.blocklisted
                  : messages.downloads;
    if (
      !isIndependent &&
      (status === MediaStatus.AVAILABLE ||
        status === MediaStatus.PARTIALLY_AVAILABLE ||
        status === MediaStatus.PROCESSING ||
        status === MediaStatus.DELETED)
    ) {
      statusMessage = inProgress
        ? globalMessages.processing
        : status === MediaStatus.PROCESSING
          ? globalMessages.requested
          : statusMessage;
    }
    const label = intl.formatMessage(statusMessage);
    return (
      <Tooltip
        content={
          active ? (
            tooltipContent
          ) : (
            <div className="space-y-1 p-2">
              <div className="break-words font-semibold">
                {destinationName} (
                {is4k ? '4K' : intl.formatMessage(messages.standard)})
              </div>
              <div>{label}</div>
              {!isIndependent && mediaLinkDescription && (
                <div>{mediaLinkDescription}</div>
              )}
              <div>{intl.formatMessage(messages.noactivedownloads)}</div>
            </div>
          )
        }
        className="max-h-96 w-96 max-w-[calc(100vw-1rem)] overflow-y-auto"
        tooltipConfig={{ interactive: true, delayHide: 100 }}
      >
        <Badge
          badgeType={
            status === MediaStatus.DELETED || status === MediaStatus.BLOCKLISTED
              ? 'danger'
              : status === MediaStatus.AVAILABLE ||
                  status === MediaStatus.PARTIALLY_AVAILABLE
                ? 'success'
                : status === MediaStatus.PENDING
                  ? 'warning'
                  : status === MediaStatus.UNKNOWN
                    ? 'light'
                    : 'primary'
          }
          href={mediaLink}
          className={`relative max-w-full overflow-hidden ${active ? '!bg-gray-700/80 !px-0 hover:!bg-gray-700' : ''}`}
        >
          {active && badgeDownloadProgress}
          <span
            className={`relative z-20 inline-flex min-w-0 items-center ${active ? 'px-2' : ''}`}
          >
            <span className="shrink-0">
              {intl.formatMessage(is4k ? messages.status4k : messages.status, {
                status: label,
              })}
            </span>
            <span className="mx-1 shrink-0">·</span>
            <span className="min-w-0 truncate">{destinationName}</span>
            {active && (
              <span className="ml-1 shrink-0">· {downloadIndicator}</span>
            )}
          </span>
        </Badge>
      </Tooltip>
    );
  }

  switch (status) {
    case MediaStatus.AVAILABLE:
      return (
        <Tooltip
          content={inProgress ? tooltipContent : mediaLinkDescription}
          className={`${
            inProgress && 'hidden max-h-96 w-96 overflow-y-auto sm:block'
          }`}
          tooltipConfig={{
            ...(inProgress && { interactive: true, delayHide: 100 }),
          }}
        >
          <Badge
            badgeType="success"
            href={mediaLink}
            className={`${
              inProgress && 'relative !bg-gray-700/80 !px-0 hover:!bg-gray-700'
            } overflow-hidden`}
          >
            {inProgress && badgeDownloadProgress}
            <div
              className={`relative z-20 flex items-center ${
                inProgress && 'px-2'
              }`}
            >
              <span>
                {intl.formatMessage(
                  is4k ? messages.status4k : messages.status,
                  {
                    status: inProgress
                      ? intl.formatMessage(globalMessages.processing)
                      : intl.formatMessage(globalMessages.available),
                  }
                )}
              </span>
              {inProgress && (
                <>
                  {legacyDownloadIndicator}
                  <Spinner className="ml-1 h-3 w-3" />
                </>
              )}
            </div>
          </Badge>
        </Tooltip>
      );

    case MediaStatus.PARTIALLY_AVAILABLE:
      return (
        <Tooltip
          content={inProgress ? tooltipContent : mediaLinkDescription}
          className={`${
            inProgress && 'hidden max-h-96 w-96 overflow-y-auto sm:block'
          }`}
          tooltipConfig={{
            ...(inProgress && { interactive: true, delayHide: 100 }),
          }}
        >
          <Badge
            badgeType="success"
            href={mediaLink}
            className={`${
              inProgress && 'relative !bg-gray-700/80 !px-0 hover:!bg-gray-700'
            } overflow-hidden`}
          >
            {inProgress && badgeDownloadProgress}
            <div
              className={`relative z-20 flex items-center ${
                inProgress && 'px-2'
              }`}
            >
              <span>
                {intl.formatMessage(
                  is4k ? messages.status4k : messages.status,
                  {
                    status: inProgress
                      ? intl.formatMessage(globalMessages.processing)
                      : intl.formatMessage(globalMessages.partiallyavailable),
                  }
                )}
              </span>
              {inProgress && (
                <>
                  {legacyDownloadIndicator}
                  <Spinner className="ml-1 h-3 w-3" />
                </>
              )}
            </div>
          </Badge>
        </Tooltip>
      );

    case MediaStatus.PROCESSING:
      return (
        <Tooltip
          content={inProgress ? tooltipContent : mediaLinkDescription}
          className={`${
            inProgress && 'hidden max-h-96 w-96 overflow-y-auto sm:block'
          }`}
          tooltipConfig={{
            ...(inProgress && { interactive: true, delayHide: 100 }),
          }}
        >
          <Badge
            badgeType="primary"
            href={mediaLink}
            className={`${
              inProgress && 'relative !bg-gray-700/80 !px-0 hover:!bg-gray-700'
            } overflow-hidden`}
          >
            {inProgress && badgeDownloadProgress}
            <div
              className={`relative z-20 flex items-center ${
                inProgress && 'px-2'
              }`}
            >
              <span>
                {intl.formatMessage(
                  is4k ? messages.status4k : messages.status,
                  {
                    status: inProgress
                      ? intl.formatMessage(globalMessages.processing)
                      : intl.formatMessage(globalMessages.requested),
                  }
                )}
              </span>
              {inProgress && (
                <>
                  {legacyDownloadIndicator}
                  <Spinner className="ml-1 h-3 w-3" />
                </>
              )}
            </div>
          </Badge>
        </Tooltip>
      );

    case MediaStatus.PENDING:
      return (
        <Tooltip content={mediaLinkDescription}>
          <Badge badgeType="warning" href={mediaLink}>
            {intl.formatMessage(is4k ? messages.status4k : messages.status, {
              status: intl.formatMessage(globalMessages.pending),
            })}
          </Badge>
        </Tooltip>
      );

    case MediaStatus.BLOCKLISTED:
      return (
        <Tooltip content={mediaLinkDescription}>
          <Badge badgeType="danger" href={mediaLink}>
            {intl.formatMessage(is4k ? messages.status4k : messages.status, {
              status:
                statusLabelOverride ??
                intl.formatMessage(globalMessages.blocklisted),
            })}
          </Badge>
        </Tooltip>
      );

    case MediaStatus.DELETED:
      return (
        <Tooltip
          content={inProgress ? tooltipContent : mediaLinkDescription}
          className={`${
            inProgress && 'hidden max-h-96 w-96 overflow-y-auto sm:block'
          }`}
          tooltipConfig={{
            ...(inProgress && { interactive: true, delayHide: 100 }),
          }}
        >
          <Badge
            badgeType="danger"
            href={mediaLink}
            className={`${
              inProgress && 'relative !bg-gray-700/80 !px-0 hover:!bg-gray-700'
            } overflow-hidden`}
          >
            {inProgress && badgeDownloadProgress}
            <div
              className={`relative z-20 flex items-center ${
                inProgress && 'px-2'
              }`}
            >
              <span>
                {intl.formatMessage(
                  is4k ? messages.status4k : messages.status,
                  {
                    status: inProgress
                      ? intl.formatMessage(globalMessages.processing)
                      : intl.formatMessage(globalMessages.deleted),
                  }
                )}
              </span>
              {inProgress && (
                <>
                  {legacyDownloadIndicator}
                  <Spinner className="ml-1 h-3 w-3" />
                </>
              )}
            </div>
          </Badge>
        </Tooltip>
      );

    default:
      return null;
  }
};

export default StatusBadge;
