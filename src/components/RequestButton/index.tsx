import ButtonWithDropdown from '@app/components/Common/ButtonWithDropdown';
import RequestModal from '@app/components/RequestModal';
import {
  revalidateRequestData,
  useRequestTargets,
} from '@app/hooks/useRequestTargets';
import useSettings from '@app/hooks/useSettings';
import { Permission, useUser } from '@app/hooks/useUser';
import globalMessages from '@app/i18n/globalMessages';
import defineMessages from '@app/utils/defineMessages';
import {
  canRequestTargetTier,
  groupPendingRequests,
} from '@app/utils/requestTargets';
import { ArrowDownTrayIcon } from '@heroicons/react/24/outline';
import {
  CheckIcon,
  InformationCircleIcon,
  XMarkIcon,
} from '@heroicons/react/24/solid';
import { MediaRequestStatus, MediaStatus } from '@server/constants/media';
import type Media from '@server/entity/Media';
import type { MediaRequest } from '@server/entity/MediaRequest';
import axios from 'axios';
import { useMemo, useState } from 'react';
import { useIntl } from 'react-intl';
import { mutate } from 'swr';

const messages = defineMessages('components.RequestButton', {
  viewrequest: 'View Request',
  viewrequest4k: 'View 4K Request',
  requestmore: 'Request More',
  requestmore4k: 'Request More in 4K',
  approverequest: 'Approve Request',
  approverequest4k: 'Approve 4K Request',
  declinerequest: 'Decline Request',
  declinerequest4k: 'Decline 4K Request',
  approverequests:
    'Approve {requestCount, plural, one {Request} other {{requestCount} Requests}}',
  declinerequests:
    'Decline {requestCount, plural, one {Request} other {{requestCount} Requests}}',
  approve4krequests:
    'Approve {requestCount, plural, one {4K Request} other {{requestCount} 4K Requests}}',
  decline4krequests:
    'Decline {requestCount, plural, one {4K Request} other {{requestCount} 4K Requests}}',
  destinationAction: '{action} — {destination}',
  requestIdentity: 'Request #{id}',
});

interface ButtonOption {
  id: string;
  text: string;
  action: () => void;
  svg?: React.ReactNode;
}

interface RequestButtonProps {
  mediaType: 'movie' | 'tv';
  onUpdate: () => void;
  tmdbId: number;
  media?: Media;
  isShowComplete?: boolean;
  is4kShowComplete?: boolean;
}

const RequestButton = ({
  tmdbId,
  onUpdate,
  media,
  mediaType,
  isShowComplete = false,
  is4kShowComplete = false,
}: RequestButtonProps) => {
  const intl = useIntl();
  const settings = useSettings();
  const { user, hasPermission } = useUser();
  const [showRequestModal, setShowRequestModal] = useState(false);
  const [showRequest4kModal, setShowRequest4kModal] = useState(false);
  const [editRequest, setEditRequest] = useState<MediaRequest | undefined>();
  const { targets } = useRequestTargets(mediaType, tmdbId);

  const pendingRequestGroups = useMemo(
    () =>
      groupPendingRequests(
        (media?.requests ?? []).filter(
          (request) => request.status === MediaRequestStatus.PENDING
        ),
        targets
      ),
    [media?.requests, targets]
  );
  const canSelectDestination = hasPermission(Permission.REQUEST_ADVANCED);
  const isBlocklisted = media?.status === MediaStatus.BLOCKLISTED;
  const canRequest =
    !isBlocklisted &&
    canRequestTargetTier(targets, false, canSelectDestination);
  const canRequest4k =
    !isBlocklisted && canRequestTargetTier(targets, true, canSelectDestination);
  const hasNativeRequestMoreTarget = (tier4k: boolean) =>
    targets?.some(
      (target) =>
        target.is4k === tier4k &&
        !target.isIndependent &&
        target.requestable &&
        (canSelectDestination || target.isDefault)
    ) === true;

  const modifyRequest = async (
    request: MediaRequest,
    type: 'approve' | 'decline'
  ) => {
    const response = await axios.post(`/api/v1/request/${request.id}/${type}`);

    if (response) {
      onUpdate();
      revalidateRequestData({
        mediaType,
        tmdbId,
        requestId: request.id,
      });
    }
  };

  const modifyRequests = async (
    requests: MediaRequest[],
    type: 'approve' | 'decline'
  ): Promise<void> => {
    if (!requests) {
      return;
    }

    await Promise.all(
      requests.map(async (request) => {
        return axios.post(`/api/v1/request/${request.id}/${type}`);
      })
    );

    onUpdate();
    requests.forEach((request) => mutate(`/api/v1/request/${request.id}`));
    revalidateRequestData({ mediaType, tmdbId });
  };

  const buttons: ButtonOption[] = [];
  const withDestination = (action: string, destination?: string) =>
    destination
      ? intl.formatMessage(messages.destinationAction, {
          action,
          destination,
        })
      : action;

  pendingRequestGroups.forEach((group) => {
    const destinationName =
      group.destinationName ??
      intl.formatMessage(messages.requestIdentity, {
        id: group.requests[0].id,
      });
    const representative =
      group.requests.find((request) => request.requestedBy.id === user?.id) ??
      group.requests[0];
    const tierSuffix = group.is4k ? '4k' : 'standard';
    const viewText = intl.formatMessage(
      group.is4k ? messages.viewrequest4k : messages.viewrequest
    );

    if (
      representative.requestedBy.id === user?.id ||
      (group.requests.length === 1 && hasPermission(Permission.MANAGE_REQUESTS))
    ) {
      buttons.push({
        id: `active-${tierSuffix}-${group.key}-${representative.id}`,
        text: withDestination(viewText, destinationName),
        action: () => {
          setEditRequest(representative);
          if (group.is4k) {
            setShowRequest4kModal(true);
          } else {
            setShowRequestModal(true);
          }
        },
        svg: <InformationCircleIcon />,
      });
    }

    if (!hasPermission(Permission.MANAGE_REQUESTS)) {
      return;
    }

    if (mediaType === 'movie') {
      const approveText = intl.formatMessage(
        group.is4k ? messages.approverequest4k : messages.approverequest
      );
      const declineText = intl.formatMessage(
        group.is4k ? messages.declinerequest4k : messages.declinerequest
      );
      buttons.push(
        {
          id: `approve-${tierSuffix}-${group.key}-${representative.id}`,
          text: withDestination(approveText, destinationName),
          action: () => modifyRequest(representative, 'approve'),
          svg: <CheckIcon />,
        },
        {
          id: `decline-${tierSuffix}-${group.key}-${representative.id}`,
          text: withDestination(declineText, destinationName),
          action: () => modifyRequest(representative, 'decline'),
          svg: <XMarkIcon />,
        }
      );
    } else {
      const approveText = intl.formatMessage(
        group.is4k ? messages.approve4krequests : messages.approverequests,
        { requestCount: group.requests.length }
      );
      const declineText = intl.formatMessage(
        group.is4k ? messages.decline4krequests : messages.declinerequests,
        { requestCount: group.requests.length }
      );
      buttons.push(
        {
          id: `approve-${tierSuffix}-batch-${group.key}`,
          text: withDestination(approveText, destinationName),
          action: () => modifyRequests(group.requests, 'approve'),
          svg: <CheckIcon />,
        },
        {
          id: `decline-${tierSuffix}-batch-${group.key}`,
          text: withDestination(declineText, destinationName),
          action: () => modifyRequests(group.requests, 'decline'),
          svg: <XMarkIcon />,
        }
      );
    }
  });

  if (
    canRequest &&
    hasPermission(
      [
        Permission.REQUEST,
        mediaType === 'movie'
          ? Permission.REQUEST_MOVIE
          : Permission.REQUEST_TV,
      ],
      { type: 'or' }
    )
  ) {
    // Native status only preserves the legacy TV label; eligibility above is
    // exclusively determined by request-targets.
    const isRequestMore =
      mediaType === 'tv' &&
      !!media &&
      !isShowComplete &&
      media.status !== MediaStatus.UNKNOWN &&
      media.status !== MediaStatus.DELETED &&
      media.status !== MediaStatus.BLOCKLISTED &&
      hasNativeRequestMoreTarget(false);
    buttons.push({
      id: isRequestMore ? 'request-more' : 'request',
      text: intl.formatMessage(
        isRequestMore ? messages.requestmore : globalMessages.request
      ),
      action: () => {
        setEditRequest(undefined);
        setShowRequestModal(true);
      },
      svg: <ArrowDownTrayIcon />,
    });
  }

  if (
    canRequest4k &&
    hasPermission(
      [
        Permission.REQUEST_4K,
        mediaType === 'movie'
          ? Permission.REQUEST_4K_MOVIE
          : Permission.REQUEST_4K_TV,
      ],
      { type: 'or' }
    ) &&
    ((settings.currentSettings.movie4kEnabled && mediaType === 'movie') ||
      (settings.currentSettings.series4kEnabled && mediaType === 'tv'))
  ) {
    // Native status only preserves the legacy TV label; eligibility above is
    // exclusively determined by request-targets.
    const isRequestMore =
      mediaType === 'tv' &&
      !!media &&
      !is4kShowComplete &&
      media.status4k !== MediaStatus.UNKNOWN &&
      media.status4k !== MediaStatus.DELETED &&
      media.status4k !== MediaStatus.BLOCKLISTED &&
      hasNativeRequestMoreTarget(true);
    buttons.push({
      id: isRequestMore ? 'request-more-4k' : 'request4k',
      text: intl.formatMessage(
        isRequestMore ? messages.requestmore4k : globalMessages.request4k
      ),
      action: () => {
        setEditRequest(undefined);
        setShowRequest4kModal(true);
      },
      svg: <ArrowDownTrayIcon />,
    });
  }

  const [buttonOne, ...others] = buttons;

  if (!buttonOne) {
    return null;
  }

  return (
    <>
      <RequestModal
        tmdbId={tmdbId}
        show={showRequestModal}
        type={mediaType}
        editRequest={!editRequest?.is4k ? editRequest : undefined}
        onComplete={() => {
          onUpdate();
          setShowRequestModal(false);
        }}
        onCancel={() => setShowRequestModal(false)}
      />
      <RequestModal
        tmdbId={tmdbId}
        show={showRequest4kModal}
        type={mediaType}
        editRequest={editRequest?.is4k ? editRequest : undefined}
        is4k
        onComplete={() => {
          onUpdate();
          setShowRequest4kModal(false);
        }}
        onCancel={() => setShowRequest4kModal(false)}
      />
      <ButtonWithDropdown
        data-testid="request-button"
        text={
          <>
            {buttonOne.svg}
            <span>{buttonOne.text}</span>
          </>
        }
        onClick={buttonOne.action}
        className="ml-2"
      >
        {others && others.length > 0
          ? others.map((button) => (
              <ButtonWithDropdown.Item
                onClick={button.action}
                key={`request-option-${button.id}`}
              >
                {button.svg}
                <span>{button.text}</span>
              </ButtonWithDropdown.Item>
            ))
          : null}
      </ButtonWithDropdown>
    </>
  );
};

export default RequestButton;
