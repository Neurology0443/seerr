import Alert from '@app/components/Common/Alert';
import Modal from '@app/components/Common/Modal';
import type { RequestOverrides } from '@app/components/RequestModal/AdvancedRequester';
import AdvancedRequester from '@app/components/RequestModal/AdvancedRequester';
import { getEditedDestinationValues } from '@app/components/RequestModal/AdvancedRequester/state';
import QuotaDisplay from '@app/components/RequestModal/QuotaDisplay';
import { useRequestEditSession } from '@app/components/RequestModal/useRequestEditSession';
import {
  revalidateRequestData,
  useRequestTargets,
} from '@app/hooks/useRequestTargets';
import useToasts from '@app/hooks/useToasts';
import { useUser } from '@app/hooks/useUser';
import globalMessages from '@app/i18n/globalMessages';
import defineMessages from '@app/utils/defineMessages';
import {
  getDefaultRequestTarget,
  getEditServerId,
  isEditDestinationReadOnly,
} from '@app/utils/requestTargets';
import { MediaStatus } from '@server/constants/media';
import type { MediaRequest } from '@server/entity/MediaRequest';
import type { NonFunctionProperties } from '@server/interfaces/api/common';
import type { RequestDetailResponse } from '@server/interfaces/api/requestInterfaces';
import type { QuotaResponse } from '@server/interfaces/api/userInterfaces';
import { Permission } from '@server/lib/permissions';
import type { MovieDetails } from '@server/models/Movie';
import axios from 'axios';
import { useCallback, useEffect, useState } from 'react';
import { useIntl } from 'react-intl';
import useSWR from 'swr';

const messages = defineMessages('components.RequestModal', {
  requestadmin: 'This request will be approved automatically.',
  requestSuccess: '<strong>{title}</strong> requested successfully!',
  requestCancel: 'Request for <strong>{title}</strong> canceled.',
  requestmovietitle: 'Request Movie',
  requestmovie4ktitle: 'Request Movie in 4K',
  edit: 'Edit Request',
  approve: 'Approve Request',
  cancel: 'Cancel Request',
  pendingrequest: 'Pending Movie Request',
  pending4krequest: 'Pending 4K Movie Request',
  requestfrom: "{username}'s request is pending approval.",
  errorediting: 'Something went wrong while editing the request.',
  requestedited: 'Request for <strong>{title}</strong> edited successfully!',
  requestApproved: 'Request for <strong>{title}</strong> approved!',
  requesterror: 'Something went wrong while submitting the request.',
  requestconflict:
    'This destination is no longer requestable. Refresh your selection and try again.',
  editconflict:
    'This request changed while you were editing. Close and reopen the editor to load the latest request.',
  editunavailable:
    'This request cannot be edited. Close and reopen the editor.',
  approvalfailed: 'The request was edited successfully, but approval failed.',
  pendingapproval: 'Your request is pending approval.',
});

interface RequestModalProps extends React.HTMLAttributes<HTMLDivElement> {
  tmdbId: number;
  is4k?: boolean;
  editRequest?: NonFunctionProperties<MediaRequest>;
  onCancel?: () => void;
  onComplete?: (newStatus?: MediaStatus) => void;
  onUpdating?: (isUpdating: boolean) => void;
}

const MovieRequestModal = ({
  onCancel,
  onComplete,
  tmdbId,
  onUpdating,
  editRequest: requestToEdit,
  is4k = false,
}: RequestModalProps) => {
  const [isUpdating, setIsUpdating] = useState(false);
  const [requestOverrides, setRequestOverrides] =
    useState<RequestOverrides | null>(null);
  const editSession = useRequestEditSession(
    requestToEdit?.id,
    requestOverrides?.hasLocalChanges === true,
    () => setRequestOverrides(null)
  );
  const editRequest = editSession.request;
  const { addToast } = useToasts();
  const { data, error } = useSWR<MovieDetails>(`/api/v1/movie/${tmdbId}`, {
    revalidateOnMount: true,
  });
  const intl = useIntl();
  const { user, hasPermission } = useUser();
  const { targets } = useRequestTargets('movie', tmdbId);
  const canUseAdvancedRequester = hasPermission(
    [Permission.REQUEST_ADVANCED, Permission.MANAGE_REQUESTS],
    { type: 'or' }
  );
  const canSelectDestination = hasPermission(Permission.REQUEST_ADVANCED);
  const defaultTarget = getDefaultRequestTarget(targets, is4k);
  const selectedServerId = editRequest
    ? editRequest.serverId
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
  const isAdvancedConfigurationReady =
    !canUseAdvancedRequester || requestOverrides?.isReady === true;
  const editConfigurationBlocked =
    requestOverrides?.hasConfigurationChanges === true &&
    requestOverrides.isReady !== true;
  const { data: quota } = useSWR<QuotaResponse>(
    user &&
      (!requestOverrides?.user?.id || hasPermission(Permission.MANAGE_USERS))
      ? `/api/v1/user/${requestOverrides?.user?.id ?? user.id}/quota`
      : null
  );

  useEffect(() => {
    if (onUpdating) {
      onUpdating(isUpdating);
    }
  }, [isUpdating, onUpdating]);

  const sendRequest = useCallback(async () => {
    if (!selectedTarget?.requestable || !isAdvancedConfigurationReady) {
      return;
    }

    setIsUpdating(true);

    try {
      let overrideParams = {};
      if (requestOverrides) {
        overrideParams = {
          serverId: canSelectDestination ? requestOverrides.server : undefined,
          profileId: requestOverrides.profile,
          rootFolder: requestOverrides.folder,
          userId: requestOverrides.user?.id,
          tags: requestOverrides.tags,
        };
      }
      const response = await axios.post<MediaRequest>('/api/v1/request', {
        mediaId: data?.id,
        mediaType: 'movie',
        is4k,
        ignoreQuota: requestOverrides?.ignoreQuota,
        ...overrideParams,
      });
      revalidateRequestData({ mediaType: 'movie', tmdbId });

      if (response.data) {
        if (onComplete) {
          onComplete(
            selectedTarget?.isIndependent
              ? undefined
              : hasPermission(
                    is4k ? Permission.AUTO_APPROVE_4K : Permission.AUTO_APPROVE
                  ) ||
                  hasPermission(
                    is4k
                      ? Permission.AUTO_APPROVE_4K_MOVIE
                      : Permission.AUTO_APPROVE_MOVIE
                  )
                ? MediaStatus.PROCESSING
                : MediaStatus.PENDING
          );
        }
        addToast(
          <span>
            {intl.formatMessage(messages.requestSuccess, {
              title: data?.title,
              strong: (msg: React.ReactNode) => <strong>{msg}</strong>,
            })}
          </span>,
          { appearance: 'success', autoDismiss: true }
        );
      }
    } catch (error) {
      const isConflict =
        axios.isAxiosError(error) && error.response?.status === 409;
      if (isConflict) {
        revalidateRequestData({ mediaType: 'movie', tmdbId });
      }
      addToast(
        intl.formatMessage(
          isConflict ? messages.requestconflict : messages.requesterror
        ),
        {
          appearance: 'error',
          autoDismiss: true,
        }
      );
    } finally {
      setIsUpdating(false);
    }
  }, [
    requestOverrides,
    data?.id,
    data?.title,
    is4k,
    onComplete,
    addToast,
    intl,
    hasPermission,
    canSelectDestination,
    isAdvancedConfigurationReady,
    selectedTarget,
    tmdbId,
  ]);

  const cancelRequest = async () => {
    if (!editRequest || editSession.blocked || isUpdating) return;
    setIsUpdating(true);

    try {
      const response = await axios.delete<MediaRequest>(
        `/api/v1/request/${editRequest.id}`,
        { headers: { 'If-Match': `"${editRequest.editRevision}"` } }
      );
      revalidateRequestData({
        mediaType: 'movie',
        tmdbId,
        requestId: editRequest?.id,
      });

      if (response.status === 204) {
        if (onComplete) {
          onComplete(isNativeEdit ? MediaStatus.UNKNOWN : undefined);
        }
        addToast(
          <span>
            {intl.formatMessage(messages.requestCancel, {
              title: data?.title,
              strong: (msg: React.ReactNode) => <strong>{msg}</strong>,
            })}
          </span>,
          { appearance: 'success', autoDismiss: true }
        );
      }
    } catch (error) {
      if (axios.isAxiosError(error) && error.response?.status === 409) {
        editSession.blockConflict();
        revalidateRequestData({
          mediaType: 'movie',
          tmdbId,
          requestId: editRequest.id,
        });
        addToast(intl.formatMessage(messages.editconflict), {
          appearance: 'error',
          autoDismiss: true,
        });
      }
    } finally {
      setIsUpdating(false);
    }
  };

  const updateRequest = async (alsoApproveRequest = false) => {
    if (
      !editRequest ||
      editSession.blocked ||
      editConfigurationBlocked ||
      isUpdating
    )
      return;
    setIsUpdating(true);
    let editSaved = false;

    try {
      const editedValues = getEditedDestinationValues(
        {
          profile: editRequest?.profileId,
          folder: editRequest?.rootFolder,
          tags: editRequest?.tags,
        },
        requestOverrides?.manualValues,
        requestOverrides ?? undefined
      );
      const { data: updatedRequest } = await axios.put<RequestDetailResponse>(
        `/api/v1/request/${editRequest.id}`,
        {
          mediaType: 'movie',
          serverId: getEditServerId(
            editRequest?.serverId,
            editTarget,
            requestOverrides?.server
          ),
          profileId: editedValues.profile,
          rootFolder: editedValues.folder,
          userId: requestOverrides?.user?.id,
          tags: editedValues.tags,
        },
        {
          headers: { 'If-Match': `"${editRequest.editRevision}"` },
          validateStatus: (status) => status === 200,
        }
      );
      editSaved = true;

      if (alsoApproveRequest) {
        if (!updatedRequest.editRevision)
          throw new Error('Missing edit revision.');
        await axios.post(
          `/api/v1/request/${editRequest.id}/approve`,
          undefined,
          {
            headers: { 'If-Match': `"${updatedRequest.editRevision}"` },
          }
        );
      }
      revalidateRequestData({
        mediaType: 'movie',
        tmdbId,
        requestId: editRequest?.id,
      });

      addToast(
        <span>
          {intl.formatMessage(
            alsoApproveRequest
              ? messages.requestApproved
              : messages.requestedited,
            {
              title: data?.title,
              strong: (msg: React.ReactNode) => <strong>{msg}</strong>,
            }
          )}
        </span>,
        {
          appearance: 'success',
          autoDismiss: true,
        }
      );

      if (onComplete) {
        onComplete(isNativeEdit ? MediaStatus.PENDING : undefined);
      }
    } catch (error) {
      const isConflict =
        axios.isAxiosError(error) && error.response?.status === 409;
      if (isConflict) editSession.blockConflict();
      if (isConflict || editSaved) {
        revalidateRequestData({
          mediaType: 'movie',
          tmdbId,
          requestId: editRequest?.id,
        });
      }
      addToast(
        <span>
          {intl.formatMessage(
            editSaved
              ? messages.approvalfailed
              : isConflict
                ? messages.editconflict
                : messages.errorediting
          )}
        </span>,
        {
          appearance: 'error',
          autoDismiss: true,
        }
      );
    } finally {
      setIsUpdating(false);
    }
  };

  if (requestToEdit && !editRequest) {
    return (
      <Modal
        loading={!editSession.error}
        onCancel={onCancel}
        title={intl.formatMessage(messages.edit)}
        cancelText={intl.formatMessage(globalMessages.close)}
      >
        {!!editSession.error && (
          <Alert
            type="error"
            title={intl.formatMessage(messages.editunavailable)}
          />
        )}
      </Modal>
    );
  }

  if (editRequest) {
    const isOwner = editRequest.requestedBy.id === user?.id;

    return (
      <Modal
        loading={!data && !error}
        backgroundClickable
        onCancel={onCancel}
        title={intl.formatMessage(
          is4k ? messages.pending4krequest : messages.pendingrequest
        )}
        subTitle={data?.title}
        onOk={() =>
          hasPermission(Permission.MANAGE_REQUESTS)
            ? updateRequest(true)
            : hasPermission(Permission.REQUEST_ADVANCED)
              ? updateRequest()
              : cancelRequest()
        }
        okDisabled={
          isUpdating ||
          editSession.blocked ||
          (canUseAdvancedRequester && editConfigurationBlocked)
        }
        okText={
          hasPermission(Permission.MANAGE_REQUESTS)
            ? intl.formatMessage(messages.approve)
            : hasPermission(Permission.REQUEST_ADVANCED)
              ? intl.formatMessage(messages.edit)
              : intl.formatMessage(messages.cancel)
        }
        okButtonType={
          hasPermission(Permission.MANAGE_REQUESTS)
            ? 'success'
            : hasPermission(Permission.REQUEST_ADVANCED)
              ? 'primary'
              : 'danger'
        }
        onSecondary={
          isOwner &&
          hasPermission(
            [Permission.REQUEST_ADVANCED, Permission.MANAGE_REQUESTS],
            { type: 'or' }
          )
            ? () => cancelRequest()
            : undefined
        }
        secondaryDisabled={isUpdating || editSession.blocked}
        secondaryText={
          isOwner &&
          hasPermission(
            [Permission.REQUEST_ADVANCED, Permission.MANAGE_REQUESTS],
            { type: 'or' }
          )
            ? intl.formatMessage(messages.cancel)
            : undefined
        }
        secondaryButtonType="danger"
        cancelText={intl.formatMessage(globalMessages.close)}
        backdrop={`https://image.tmdb.org/t/p/w1920_and_h800_multi_faces/${data?.backdropPath}`}
      >
        {editSession.conflicted ? (
          <Alert
            type="error"
            title={intl.formatMessage(messages.editconflict)}
          />
        ) : (
          editSession.blocked && (
            <Alert
              type="error"
              title={intl.formatMessage(messages.editunavailable)}
            />
          )
        )}
        <fieldset disabled={editSession.blocked || isUpdating}>
          {isOwner
            ? intl.formatMessage(messages.pendingapproval)
            : intl.formatMessage(messages.requestfrom, {
                username: editRequest.requestedBy.displayName,
              })}
          {hasPermission(
            [Permission.REQUEST_ADVANCED, Permission.MANAGE_REQUESTS],
            { type: 'or' }
          ) && (
            <AdvancedRequester
              key={`${editRequest.id}:${editRequest.editRevision}`}
              type="movie"
              tmdbId={tmdbId}
              is4k={is4k}
              requestUser={editRequest.requestedBy}
              requestId={editRequest.id}
              initialServerId={editRequest.serverId}
              destinationReadOnly={isEditDestinationReadOnly(
                editRequest.serverId,
                editTarget
              )}
              defaultOverrides={{
                folder: editRequest.rootFolder,
                profile: editRequest.profileId,
                server: editRequest.serverId,
                tags: editRequest.tags,
              }}
              onChange={(overrides) => {
                setRequestOverrides(overrides);
              }}
            />
          )}
        </fieldset>
      </Modal>
    );
  }

  const hasAutoApprove = hasPermission(
    [
      Permission.MANAGE_REQUESTS,
      is4k ? Permission.AUTO_APPROVE_4K : Permission.AUTO_APPROVE,
      is4k ? Permission.AUTO_APPROVE_4K_MOVIE : Permission.AUTO_APPROVE_MOVIE,
    ],
    { type: 'or' }
  );

  return (
    <Modal
      loading={(!data && !error) || !quota}
      backgroundClickable
      onCancel={onCancel}
      onOk={sendRequest}
      okDisabled={
        isUpdating ||
        !selectedTarget?.requestable ||
        !isAdvancedConfigurationReady ||
        (quota?.movie.restricted && !requestOverrides?.ignoreQuota)
      }
      title={intl.formatMessage(
        is4k ? messages.requestmovie4ktitle : messages.requestmovietitle
      )}
      subTitle={data?.title}
      okText={
        isUpdating
          ? intl.formatMessage(globalMessages.requesting)
          : intl.formatMessage(
              is4k ? globalMessages.request4k : globalMessages.request
            )
      }
      okButtonType={'primary'}
      backdrop={`https://image.tmdb.org/t/p/w1920_and_h800_multi_faces/${data?.backdropPath}`}
    >
      {hasAutoApprove && !quota?.movie.restricted && (
        <div className="mt-6">
          <Alert
            title={intl.formatMessage(messages.requestadmin)}
            type="info"
          />
        </div>
      )}
      {(quota?.movie.limit ?? 0) > 0 && (
        <QuotaDisplay
          mediaType="movie"
          quota={quota?.movie}
          userOverride={
            requestOverrides?.user && requestOverrides.user.id !== user?.id
              ? requestOverrides?.user?.id
              : undefined
          }
        />
      )}
      {hasPermission(
        [Permission.REQUEST_ADVANCED, Permission.MANAGE_REQUESTS],
        { type: 'or' }
      ) && (
        <AdvancedRequester
          tmdbId={tmdbId}
          type="movie"
          is4k={is4k}
          initialServerId={defaultTarget?.serverId}
          hideDestinationSelector={!canSelectDestination}
          quota={quota}
          onServerChange={(serverId) => {
            setRequestOverrides((overrides) => ({
              server: serverId,
              user: overrides?.user,
              ignoreQuota: overrides?.ignoreQuota,
              isReady: false,
              hasConfigurationChanges: true,
            }));
          }}
          onChange={(overrides) => {
            setRequestOverrides(overrides);
          }}
        />
      )}
    </Modal>
  );
};

export default MovieRequestModal;
