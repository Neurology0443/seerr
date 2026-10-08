import Alert from '@app/components/Common/Alert';
import Badge from '@app/components/Common/Badge';
import Modal from '@app/components/Common/Modal';
import type { RequestOverrides } from '@app/components/RequestModal/AdvancedRequester';
import AdvancedRequester from '@app/components/RequestModal/AdvancedRequester';
import { getEditedDestinationValues } from '@app/components/RequestModal/AdvancedRequester/state';
import QuotaDisplay from '@app/components/RequestModal/QuotaDisplay';
import SearchByNameModal from '@app/components/RequestModal/SearchByNameModal';
import {
  revalidateRequestData,
  useRequestTargets,
} from '@app/hooks/useRequestTargets';
import useSettings from '@app/hooks/useSettings';
import useToasts from '@app/hooks/useToasts';
import { useUser } from '@app/hooks/useUser';
import globalMessages from '@app/i18n/globalMessages';
import defineMessages from '@app/utils/defineMessages';
import {
  getDefaultRequestTarget,
  getEditServerId,
  getRequestableSeasonNumbers,
  getTvRequestSeasonPayload,
  isEditDestinationReadOnly,
} from '@app/utils/requestTargets';
import { ANIME_KEYWORD_ID } from '@server/api/themoviedb/constants';
import { MediaRequestStatus, MediaStatus } from '@server/constants/media';
import type { MediaRequest } from '@server/entity/MediaRequest';
import type SeasonRequest from '@server/entity/SeasonRequest';
import type { NonFunctionProperties } from '@server/interfaces/api/common';
import type { QuotaResponse } from '@server/interfaces/api/userInterfaces';
import { Permission } from '@server/lib/permissions';
import type { TvDetails } from '@server/models/Tv';
import axios from 'axios';
import { useState } from 'react';
import { useIntl } from 'react-intl';
import useSWR from 'swr';

const messages = defineMessages('components.RequestModal', {
  requestadmin: 'This request will be approved automatically.',
  requestSuccess: '<strong>{title}</strong> requested successfully!',
  requestseriestitle: 'Request Series',
  requestseries4ktitle: 'Request Series in 4K',
  edit: 'Edit Request',
  approve: 'Approve Request',
  cancel: 'Cancel Request',
  pendingrequest: 'Pending Request',
  pending4krequest: 'Pending 4K Request',
  requestfrom: "{username}'s request is pending approval.",
  requestseasons:
    'Request {seasonCount} {seasonCount, plural, one {Season} other {Seasons}}',
  requestseasons4k:
    'Request {seasonCount} {seasonCount, plural, one {Season} other {Seasons}} in 4K',
  alreadyrequested: 'Already Requested',
  selectseason: 'Select Season(s)',
  season: 'Season',
  numberofepisodes: '# of Episodes',
  seasonnumber: 'Season {number}',
  errorediting: 'Something went wrong while editing the request.',
  requestedited: 'Request for <strong>{title}</strong> edited successfully!',
  requestApproved: 'Request for <strong>{title}</strong> approved!',
  requestcancelled: 'Request for <strong>{title}</strong> canceled.',
  autoapproval: 'Automatic Approval',
  requesterror: 'Something went wrong while submitting the request.',
  requestconflict:
    'This destination is no longer requestable. Refresh your selection and try again.',
  pendingapproval: 'Your request is pending approval.',
});

interface RequestModalProps extends React.HTMLAttributes<HTMLDivElement> {
  tmdbId: number;
  onCancel?: () => void;
  onComplete?: (newStatus?: MediaStatus) => void;
  onUpdating?: (isUpdating: boolean) => void;
  is4k?: boolean;
  editRequest?: NonFunctionProperties<MediaRequest>;
}

const TvRequestModal = ({
  onCancel,
  onComplete,
  tmdbId,
  onUpdating,
  editRequest,
  is4k = false,
}: RequestModalProps) => {
  const settings = useSettings();
  const { addToast } = useToasts();
  const editingSeasons: number[] = (editRequest?.seasons ?? []).map(
    (season) => season.seasonNumber
  );
  const { data, error } = useSWR<TvDetails>(`/api/v1/tv/${tmdbId}`);
  const [requestOverrides, setRequestOverrides] =
    useState<RequestOverrides | null>(null);
  const [selectedSeasons, setSelectedSeasons] = useState<number[]>(
    editRequest ? editingSeasons : []
  );
  const intl = useIntl();
  const { user, hasPermission } = useUser();
  const { targets } = useRequestTargets('tv', tmdbId);
  const canUseAdvancedRequester = hasPermission(
    [Permission.REQUEST_ADVANCED, Permission.MANAGE_REQUESTS],
    { type: 'or' }
  );
  const canSelectDestination = hasPermission(Permission.REQUEST_ADVANCED);
  const defaultTarget = getDefaultRequestTarget(targets, is4k);
  const selectedServerId = editRequest
    ? (requestOverrides?.server ??
      editRequest.serverId ??
      targets?.find(
        (target) =>
          target.isDefault && !target.isIndependent && target.is4k === is4k
      )?.serverId)
    : canSelectDestination
      ? (requestOverrides?.server ?? defaultTarget?.serverId)
      : defaultTarget?.serverId;
  const selectedTarget = targets?.find(
    (target) => target.serverId === selectedServerId
  );
  const editTarget = editRequest
    ? targets?.find((target) => target.serverId === editRequest.serverId)
    : undefined;
  const isNativeEdit =
    editRequest &&
    (editRequest.serverId == null || editTarget?.isIndependent === false);
  const requestableSeasons = getRequestableSeasonNumbers(selectedTarget);
  const isAdvancedConfigurationReady =
    !canUseAdvancedRequester || requestOverrides?.isReady === true;
  const editConfigurationBlocked =
    requestOverrides?.hasConfigurationChanges === true &&
    requestOverrides.isReady !== true;
  const [searchModal, setSearchModal] = useState<{
    show: boolean;
  }>({
    show: true,
  });
  const [tvdbId, setTvdbId] = useState<number | undefined>(undefined);
  const { data: quota } = useSWR<QuotaResponse>(
    user &&
      (!requestOverrides?.user?.id || hasPermission(Permission.MANAGE_USERS))
      ? `/api/v1/user/${requestOverrides?.user?.id ?? user.id}/quota`
      : null
  );

  const currentlyRemaining =
    (quota?.tv.remaining ?? 0) -
    selectedSeasons.length +
    (editRequest?.seasons ?? []).length;

  const updateRequest = async (alsoApproveRequest = false) => {
    if (!editRequest) {
      return;
    }
    if (selectedSeasons.length > 0 && editConfigurationBlocked) return;

    if (onUpdating) {
      onUpdating(true);
    }

    try {
      if (selectedSeasons.length > 0) {
        const editedValues = getEditedDestinationValues(
          {
            profile: editRequest.profileId,
            folder: editRequest.rootFolder,
            language: editRequest.languageProfileId,
            tags: editRequest.tags,
          },
          requestOverrides?.manualValues
        );
        await axios.put(`/api/v1/request/${editRequest.id}`, {
          mediaType: 'tv',
          serverId: getEditServerId(
            editRequest.serverId,
            editTarget,
            requestOverrides?.server
          ),
          profileId: editedValues.profile,
          rootFolder: editedValues.folder,
          languageProfileId: editedValues.language,
          userId: requestOverrides?.user?.id,
          tags: editedValues.tags,
          seasons: selectedSeasons.toSorted((a, b) => a - b),
        });

        if (alsoApproveRequest) {
          await axios.post(`/api/v1/request/${editRequest.id}/approve`);
        }
      } else {
        await axios.delete(`/api/v1/request/${editRequest.id}`);
      }
      revalidateRequestData({
        mediaType: 'tv',
        tmdbId,
        requestId: editRequest.id,
      });

      addToast(
        <span>
          {selectedSeasons.length > 0
            ? intl.formatMessage(
                alsoApproveRequest
                  ? messages.requestApproved
                  : messages.requestedited,
                {
                  title: data?.name,
                  strong: (msg: React.ReactNode) => <strong>{msg}</strong>,
                }
              )
            : intl.formatMessage(messages.requestcancelled, {
                title: data?.name,
                strong: (msg: React.ReactNode) => <strong>{msg}</strong>,
              })}
        </span>,
        {
          appearance: 'success',
          autoDismiss: true,
        }
      );
      if (onComplete) {
        onComplete(
          isNativeEdit
            ? selectedSeasons.length > 0
              ? MediaStatus.PENDING
              : MediaStatus.UNKNOWN
            : undefined
        );
      }
    } catch (error) {
      const isConflict =
        axios.isAxiosError(error) && error.response?.status === 409;
      if (isConflict) {
        revalidateRequestData({
          mediaType: 'tv',
          tmdbId,
          requestId: editRequest.id,
        });
      }
      addToast(
        <span>
          {intl.formatMessage(
            isConflict ? messages.requestconflict : messages.errorediting
          )}
        </span>,
        {
          appearance: 'error',
          autoDismiss: true,
        }
      );
    } finally {
      if (onUpdating) {
        onUpdating(false);
      }
    }
  };

  const sendRequest = async () => {
    const seasons = getTvRequestSeasonPayload(
      selectedTarget,
      selectedSeasons,
      settings.currentSettings.partialRequestsEnabled
    );

    if (
      !selectedTarget ||
      !isAdvancedConfigurationReady ||
      seasons.length === 0
    ) {
      return;
    }

    if (onUpdating) {
      onUpdating(true);
    }

    try {
      let overrideParams = {};
      if (requestOverrides) {
        overrideParams = {
          serverId: canSelectDestination ? requestOverrides.server : undefined,
          profileId: requestOverrides.profile,
          rootFolder: requestOverrides.folder,
          languageProfileId: requestOverrides.language,
          userId: requestOverrides?.user?.id,
          tags: requestOverrides.tags,
        };
      }
      const response = await axios.post<MediaRequest>(
        '/api/v1/request',
        {
          mediaId: data?.id,
          tvdbId: tvdbId ?? data?.externalIds.tvdbId,
          mediaType: 'tv',
          is4k,
          ignoreQuota: requestOverrides?.ignoreQuota,
          seasons,
          ...overrideParams,
        },
        {
          // The API returns 202 when no seasons remain; only 201 creates a request.
          validateStatus: (status) => status === 201,
        }
      );
      revalidateRequestData({ mediaType: 'tv', tmdbId });

      if (onComplete) {
        onComplete(
          selectedTarget.isIndependent
            ? undefined
            : response.data.media[is4k ? 'status4k' : 'status']
        );
      }
      addToast(
        <span>
          {intl.formatMessage(messages.requestSuccess, {
            title: data?.name,
            strong: (msg: React.ReactNode) => <strong>{msg}</strong>,
          })}
        </span>,
        { appearance: 'success', autoDismiss: true }
      );
    } catch (error) {
      const isConflict =
        axios.isAxiosError(error) && error.response?.status === 409;
      const noSeasonsAvailable =
        axios.isAxiosError(error) && error.response?.status === 202;
      if (noSeasonsAvailable) {
        setSelectedSeasons([]);
      }
      if (isConflict || noSeasonsAvailable) {
        revalidateRequestData({ mediaType: 'tv', tmdbId });
      }
      addToast(
        noSeasonsAvailable
          ? (error.response?.data?.message ??
              intl.formatMessage(messages.requestconflict))
          : intl.formatMessage(
              isConflict ? messages.requestconflict : messages.requesterror
            ),
        {
          appearance: 'error',
          autoDismiss: true,
        }
      );
    } finally {
      if (onUpdating) {
        onUpdating(false);
      }
    }
  };

  const getAllSeasons = (): number[] => {
    let allSeasons = (data?.seasons ?? []).filter(
      (season) => season.episodeCount !== 0
    );
    if (!settings.currentSettings.enableSpecialEpisodes) {
      allSeasons = allSeasons.filter((season) => season.seasonNumber > 0);
    }
    return allSeasons.map((season) => season.seasonNumber);
  };

  const isSelectedSeason = (seasonNumber: number): boolean =>
    selectedSeasons.includes(seasonNumber);

  const toggleSeason = (seasonNumber: number): void => {
    const canSelectSeason = editRequest
      ? editingSeasons.includes(seasonNumber) ||
        requestableSeasons.includes(seasonNumber)
      : requestableSeasons.includes(seasonNumber);

    if (!canSelectSeason) {
      return;
    }

    // If there are no more remaining requests available, block toggle
    if (
      quota?.tv.limit &&
      currentlyRemaining <= 0 &&
      !isSelectedSeason(seasonNumber)
    ) {
      return;
    }

    if (selectedSeasons.includes(seasonNumber)) {
      setSelectedSeasons((seasons) =>
        seasons.filter((sn) => sn !== seasonNumber)
      );
    } else {
      setSelectedSeasons((seasons) => [...seasons, seasonNumber]);
    }
  };

  const unrequestedSeasons = requestableSeasons;
  const selectableSeasons = editRequest
    ? getAllSeasons().filter(
        (season) =>
          editingSeasons.includes(season) || requestableSeasons.includes(season)
      )
    : requestableSeasons;

  const toggleAllSeasons = (): void => {
    // If the user has a quota and not enough requests for all seasons, block toggleAllSeasons
    if (
      quota?.tv.limit &&
      (quota?.tv.remaining ?? 0) <
        selectableSeasons.filter((season) => !editingSeasons.includes(season))
          .length
    ) {
      return;
    }

    if (
      data &&
      selectedSeasons.length >= 0 &&
      selectedSeasons.length < selectableSeasons.length
    ) {
      setSelectedSeasons(selectableSeasons);
    } else {
      setSelectedSeasons([]);
    }
  };

  const isAllSeasons = (): boolean => {
    if (!data || selectableSeasons.length === 0) {
      return false;
    }
    return (
      selectedSeasons.filter((season) => season !== 0).length ===
      selectableSeasons.filter((season) => season !== 0).length
    );
  };

  const getSeasonRequest = (
    seasonNumber: number
  ): SeasonRequest | undefined => {
    let seasonRequest: SeasonRequest | undefined;

    if (
      data?.mediaInfo &&
      (data.mediaInfo.requests || []).filter(
        (request) =>
          request.id === editRequest?.id &&
          request.status !== MediaRequestStatus.DECLINED &&
          request.status !== MediaRequestStatus.COMPLETED
      ).length > 0
    ) {
      data.mediaInfo.requests
        .filter(
          (request) =>
            request.id === editRequest?.id &&
            request.status !== MediaRequestStatus.DECLINED &&
            request.status !== MediaRequestStatus.COMPLETED
        )
        .forEach((request) => {
          if (!seasonRequest) {
            seasonRequest = request.seasons.find(
              (season) =>
                season.seasonNumber === seasonNumber &&
                season.status !== MediaRequestStatus.COMPLETED
            );
          }
        });
    }

    return seasonRequest;
  };

  const isOwner = editRequest && editRequest.requestedBy.id === user?.id;
  const selectedRequestableSeasonCount = selectedSeasons.filter((season) =>
    requestableSeasons.includes(season)
  ).length;

  return data && !error && !data.externalIds.tvdbId && searchModal.show ? (
    <SearchByNameModal
      tvdbId={tvdbId}
      setTvdbId={setTvdbId}
      closeModal={() => setSearchModal({ show: false })}
      onCancel={onCancel}
      modalTitle={intl.formatMessage(
        is4k ? messages.requestseries4ktitle : messages.requestseriestitle
      )}
      modalSubTitle={data.name}
      tmdbId={tmdbId}
      backdrop={`https://image.tmdb.org/t/p/w1920_and_h800_multi_faces/${data?.backdropPath}`}
    />
  ) : (
    <Modal
      loading={!data && !error}
      backgroundClickable
      onCancel={tvdbId ? () => setSearchModal({ show: true }) : onCancel}
      onOk={() =>
        editRequest
          ? hasPermission(Permission.MANAGE_REQUESTS)
            ? updateRequest(true)
            : updateRequest()
          : sendRequest()
      }
      title={intl.formatMessage(
        editRequest
          ? is4k
            ? messages.pending4krequest
            : messages.pendingrequest
          : is4k
            ? messages.requestseries4ktitle
            : messages.requestseriestitle
      )}
      subTitle={data?.name}
      okText={
        editRequest
          ? selectedSeasons.length === 0
            ? intl.formatMessage(messages.cancel)
            : hasPermission(Permission.MANAGE_REQUESTS)
              ? intl.formatMessage(messages.approve)
              : intl.formatMessage(messages.edit)
          : unrequestedSeasons.length === 0
            ? intl.formatMessage(messages.alreadyrequested)
            : !settings.currentSettings.partialRequestsEnabled
              ? intl.formatMessage(
                  is4k ? globalMessages.request4k : globalMessages.request
                )
              : selectedSeasons.length === 0
                ? intl.formatMessage(messages.selectseason)
                : intl.formatMessage(
                    is4k ? messages.requestseasons4k : messages.requestseasons,
                    {
                      seasonCount: selectedSeasons.length,
                    }
                  )
      }
      okDisabled={
        editRequest
          ? selectedSeasons.length > 0 && editConfigurationBlocked
          : !settings.currentSettings.partialRequestsEnabled &&
              quota?.tv.limit &&
              unrequestedSeasons.length > (quota.tv.remaining ?? 0) &&
              !requestOverrides?.ignoreQuota
            ? true
            : !selectedTarget ||
              !isAdvancedConfigurationReady ||
              unrequestedSeasons.length === 0 ||
              (settings.currentSettings.partialRequestsEnabled &&
                selectedRequestableSeasonCount === 0)
      }
      okButtonType={
        editRequest
          ? settings.currentSettings.partialRequestsEnabled &&
            selectedSeasons.length === 0
            ? 'danger'
            : hasPermission(Permission.MANAGE_REQUESTS)
              ? 'success'
              : 'primary'
          : 'primary'
      }
      cancelText={
        editRequest
          ? intl.formatMessage(globalMessages.close)
          : tvdbId
            ? intl.formatMessage(globalMessages.back)
            : intl.formatMessage(globalMessages.cancel)
      }
      backdrop={`https://image.tmdb.org/t/p/w1920_and_h800_multi_faces/${data?.backdropPath}`}
    >
      {editRequest
        ? isOwner
          ? intl.formatMessage(messages.pendingapproval)
          : intl.formatMessage(messages.requestfrom, {
              username: editRequest?.requestedBy.displayName,
            })
        : null}
      {hasPermission(
        [
          Permission.MANAGE_REQUESTS,
          is4k ? Permission.AUTO_APPROVE_4K : Permission.AUTO_APPROVE,
          is4k ? Permission.AUTO_APPROVE_4K_TV : Permission.AUTO_APPROVE_TV,
        ],
        { type: 'or' }
      ) &&
        !(
          quota?.tv.limit &&
          !settings.currentSettings.partialRequestsEnabled &&
          unrequestedSeasons.length > (quota?.tv.remaining ?? 0)
        ) &&
        requestableSeasons.length > 0 &&
        !editRequest && (
          <div className="mt-6">
            <Alert
              title={intl.formatMessage(messages.requestadmin)}
              type="info"
            />
          </div>
        )}
      {(quota?.tv.limit ?? 0) > 0 && (
        <QuotaDisplay
          mediaType="tv"
          quota={quota?.tv}
          remaining={
            !settings.currentSettings.partialRequestsEnabled &&
            unrequestedSeasons.length > (quota?.tv.remaining ?? 0)
              ? 0
              : currentlyRemaining
          }
          userOverride={
            requestOverrides?.user && requestOverrides.user.id !== user?.id
              ? requestOverrides?.user?.id
              : undefined
          }
          overLimit={
            !settings.currentSettings.partialRequestsEnabled &&
            unrequestedSeasons.length > (quota?.tv.remaining ?? 0)
              ? unrequestedSeasons.length
              : undefined
          }
        />
      )}
      <div className="flex flex-col">
        <div className="-mx-4 sm:mx-0">
          <div className="inline-block min-w-full py-2 align-middle">
            <div className="overflow-hidden border border-gray-700 shadow backdrop-blur sm:rounded-lg">
              <table className="min-w-full">
                <thead>
                  <tr>
                    <th
                      className={`w-16 bg-gray-700/80 px-4 py-3 ${
                        !settings.currentSettings.partialRequestsEnabled &&
                        'hidden'
                      }`}
                    >
                      <span
                        role="checkbox"
                        tabIndex={0}
                        aria-checked={isAllSeasons()}
                        onClick={() => toggleAllSeasons()}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter' || e.key === 'Space') {
                            toggleAllSeasons();
                          }
                        }}
                        className={`relative inline-flex h-5 w-10 flex-shrink-0 cursor-pointer items-center justify-center pt-2 focus:outline-none ${
                          quota?.tv.remaining &&
                          quota.tv.limit &&
                          quota.tv.remaining < unrequestedSeasons.length
                            ? 'opacity-50'
                            : ''
                        }`}
                      >
                        <span
                          aria-hidden="true"
                          className={`${
                            isAllSeasons() ? 'bg-indigo-500' : 'bg-gray-800'
                          } absolute mx-auto h-4 w-9 rounded-full transition-colors duration-200 ease-in-out`}
                        />
                        <span
                          aria-hidden="true"
                          className={`${
                            isAllSeasons() ? 'translate-x-5' : 'translate-x-0'
                          } absolute left-0 inline-block h-5 w-5 rounded-full border border-gray-200 bg-white shadow transition-transform duration-200 ease-in-out group-focus:border-blue-300 group-focus:ring`}
                        />
                      </span>
                    </th>
                    <th className="bg-gray-700/80 px-1 py-3 text-left text-xs font-medium uppercase leading-4 tracking-wider text-gray-200 md:px-6">
                      {intl.formatMessage(messages.season)}
                    </th>
                    <th className="bg-gray-700/80 px-5 py-3 text-left text-xs font-medium uppercase leading-4 tracking-wider text-gray-200 md:px-6">
                      {intl.formatMessage(messages.numberofepisodes)}
                    </th>
                    <th className="bg-gray-700/80 px-2 py-3 text-left text-xs font-medium uppercase leading-4 tracking-wider text-gray-200 md:px-6">
                      {intl.formatMessage(globalMessages.status)}
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-700">
                  {data?.seasons
                    .filter(
                      (season) =>
                        season.episodeCount !== 0 &&
                        (settings.currentSettings.enableSpecialEpisodes ||
                          season.seasonNumber !== 0)
                    )
                    .map((season) => {
                      const seasonRequest = editRequest
                        ? getSeasonRequest(season.seasonNumber)
                        : undefined;
                      const seasonTarget = selectedTarget?.seasons.find(
                        (targetSeason) =>
                          targetSeason.seasonNumber === season.seasonNumber
                      );
                      const canSelectSeason = editRequest
                        ? editingSeasons.includes(season.seasonNumber) ||
                          seasonTarget?.requestable === true
                        : seasonTarget?.requestable === true;
                      const seasonOccupied = !canSelectSeason;
                      return (
                        <tr key={`season-${season.id}`}>
                          <td
                            className={`whitespace-nowrap px-4 py-4 text-sm font-medium leading-5 text-gray-100 ${
                              !settings.currentSettings
                                .partialRequestsEnabled && 'hidden'
                            }`}
                          >
                            <span
                              role="checkbox"
                              tabIndex={0}
                              aria-checked={
                                seasonOccupied ||
                                isSelectedSeason(season.seasonNumber)
                              }
                              onClick={() => toggleSeason(season.seasonNumber)}
                              onKeyDown={(e) => {
                                if (e.key === 'Enter' || e.key === 'Space') {
                                  toggleSeason(season.seasonNumber);
                                }
                              }}
                              className={`relative inline-flex h-5 w-10 flex-shrink-0 cursor-pointer items-center justify-center pt-2 focus:outline-none ${
                                seasonOccupied ||
                                (quota?.tv.limit &&
                                  currentlyRemaining <= 0 &&
                                  !isSelectedSeason(season.seasonNumber))
                                  ? 'opacity-50'
                                  : ''
                              }`}
                            >
                              <span
                                aria-hidden="true"
                                className={`${
                                  seasonOccupied ||
                                  isSelectedSeason(season.seasonNumber)
                                    ? 'bg-indigo-500'
                                    : 'bg-gray-700'
                                } absolute mx-auto h-4 w-9 rounded-full transition-colors duration-200 ease-in-out`}
                              />
                              <span
                                aria-hidden="true"
                                className={`${
                                  seasonOccupied ||
                                  isSelectedSeason(season.seasonNumber)
                                    ? 'translate-x-5'
                                    : 'translate-x-0'
                                } absolute left-0 inline-block h-5 w-5 rounded-full border border-gray-200 bg-white shadow transition-transform duration-200 ease-in-out group-focus:border-blue-300 group-focus:ring`}
                              />
                            </span>
                          </td>
                          <td className="whitespace-nowrap px-1 py-4 text-sm font-medium leading-5 text-gray-100 md:px-6">
                            {season.seasonNumber === 0
                              ? intl.formatMessage(globalMessages.specials)
                              : intl.formatMessage(messages.seasonnumber, {
                                  number: season.seasonNumber,
                                })}
                          </td>
                          <td className="whitespace-nowrap px-5 py-4 text-sm leading-5 text-gray-200 md:px-6">
                            {season.episodeCount}
                          </td>
                          <td className="whitespace-nowrap py-4 pr-2 text-sm leading-5 text-gray-200 md:px-6">
                            {seasonTarget?.status === MediaStatus.AVAILABLE && (
                              <Badge badgeType="success">
                                {intl.formatMessage(globalMessages.available)}
                              </Badge>
                            )}
                            {seasonTarget?.status ===
                              MediaStatus.PARTIALLY_AVAILABLE && (
                              <Badge badgeType="success">
                                {intl.formatMessage(
                                  globalMessages.partiallyavailable
                                )}
                              </Badge>
                            )}
                            {seasonTarget?.status ===
                              MediaStatus.PROCESSING && (
                              <Badge badgeType="primary">
                                {intl.formatMessage(globalMessages.requested)}
                              </Badge>
                            )}
                            {seasonTarget?.status !== MediaStatus.AVAILABLE &&
                              seasonTarget?.status !==
                                MediaStatus.PARTIALLY_AVAILABLE &&
                              seasonTarget?.status !== MediaStatus.PROCESSING &&
                              seasonRequest?.status ===
                                MediaRequestStatus.PENDING && (
                                <Badge badgeType="warning">
                                  {intl.formatMessage(globalMessages.pending)}
                                </Badge>
                              )}
                            {seasonTarget?.status !== MediaStatus.AVAILABLE &&
                              seasonTarget?.status !==
                                MediaStatus.PARTIALLY_AVAILABLE &&
                              seasonTarget?.status !== MediaStatus.PROCESSING &&
                              seasonRequest?.status ===
                                MediaRequestStatus.APPROVED && (
                                <Badge badgeType="primary">
                                  {intl.formatMessage(globalMessages.requested)}
                                </Badge>
                              )}
                            {!seasonRequest && seasonTarget?.requestable && (
                              <Badge>
                                {intl.formatMessage(
                                  globalMessages.notrequested
                                )}
                              </Badge>
                            )}
                            {!seasonRequest &&
                              seasonTarget &&
                              !seasonTarget.requestable &&
                              (seasonTarget.status === MediaStatus.UNKNOWN ||
                                seasonTarget.status ===
                                  MediaStatus.DELETED) && (
                                <Badge>
                                  {intl.formatMessage(
                                    messages.alreadyrequested
                                  )}
                                </Badge>
                              )}
                            {seasonTarget?.status === MediaStatus.PENDING &&
                              !seasonRequest && (
                                <Badge badgeType="warning">
                                  {intl.formatMessage(globalMessages.pending)}
                                </Badge>
                              )}
                          </td>
                        </tr>
                      );
                    })}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      </div>
      {hasPermission(
        [Permission.REQUEST_ADVANCED, Permission.MANAGE_REQUESTS],
        { type: 'or' }
      ) && (
        <AdvancedRequester
          type="tv"
          tmdbId={tmdbId}
          is4k={is4k}
          isAnime={data?.keywords.some(
            (keyword) => keyword.id === ANIME_KEYWORD_ID
          )}
          quota={quota}
          onChange={(overrides) => setRequestOverrides(overrides)}
          onServerChange={(serverId) => {
            if (!editRequest) {
              setSelectedSeasons([]);
            }
            setRequestOverrides((overrides) => ({
              server: serverId,
              user: overrides?.user,
              ignoreQuota: overrides?.ignoreQuota,
              isReady: false,
              hasConfigurationChanges: true,
            }));
          }}
          requestUser={editRequest?.requestedBy}
          requestId={editRequest?.id}
          initialServerId={
            editRequest ? editRequest.serverId : defaultTarget?.serverId
          }
          hideDestinationSelector={!editRequest && !canSelectDestination}
          destinationReadOnly={
            editRequest
              ? isEditDestinationReadOnly(editRequest.serverId, editTarget)
              : false
          }
          defaultOverrides={
            editRequest
              ? {
                  folder: editRequest.rootFolder,
                  profile: editRequest.profileId,
                  server: editRequest.serverId,
                  language: editRequest.languageProfileId,
                  tags: editRequest.tags,
                }
              : undefined
          }
        />
      )}
    </Modal>
  );
};

export default TvRequestModal;
