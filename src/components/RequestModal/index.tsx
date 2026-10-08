import CollectionRequestModal from '@app/components/RequestModal/CollectionRequestModal';
import MovieRequestModal from '@app/components/RequestModal/MovieRequestModal';
import TvRequestModal from '@app/components/RequestModal/TvRequestModal';
import { Transition } from '@headlessui/react';
import type { MediaStatus } from '@server/constants/media';
import type { MediaRequest } from '@server/entity/MediaRequest';
import type { NonFunctionProperties } from '@server/interfaces/api/common';
import { useRef, useState } from 'react';

interface RequestModalProps {
  show: boolean;
  type: 'movie' | 'tv' | 'collection';
  tmdbId: number;
  is4k?: boolean;
  editRequest?: NonFunctionProperties<MediaRequest>;
  onComplete?: (newStatus?: MediaStatus) => void;
  onCancel?: () => void;
  onUpdating?: (isUpdating: boolean) => void;
}

const RequestModal = ({
  type,
  show,
  tmdbId,
  is4k,
  editRequest,
  onComplete,
  onUpdating,
  onCancel,
}: RequestModalProps) => {
  // A rapid reopen can precede Transition's delayed unmount. Give every edit
  // opening a fresh session even in that case, without changing creation flows.
  const [session, setSession] = useState({ open: show, number: 0 });
  if (session.open !== show) {
    setSession({ open: show, number: session.number + (show ? 1 : 0) });
  }
  const editorKey = editRequest ? `${editRequest.id}:${session.number}` : 'new';
  const sessionKey = `${type}:${tmdbId}:${editorKey}`;
  const activeSession = useRef<string | undefined>(undefined);
  // Invalidate immediately on close, including Transition's leave interval.
  activeSession.current = show ? sessionKey : undefined;
  const isEditSessionActive = () => activeSession.current === sessionKey;
  const completeEdit: typeof onComplete = (status) => {
    if (isEditSessionActive()) onComplete?.(status);
  };
  const updateEdit: typeof onUpdating = (updating) => {
    if (isEditSessionActive()) onUpdating?.(updating);
  };
  return (
    <Transition
      as="div"
      enter="transition-opacity duration-300"
      enterFrom="opacity-0"
      enterTo="opacity-100"
      leave="transition-opacity duration-300"
      leaveFrom="opacity-100"
      leaveTo="opacity-0"
      show={show}
    >
      {type === 'movie' ? (
        <MovieRequestModal
          key={editRequest ? sessionKey : editorKey}
          onComplete={editRequest ? completeEdit : onComplete}
          onCancel={onCancel}
          tmdbId={tmdbId}
          onUpdating={editRequest ? updateEdit : onUpdating}
          isEditSessionActive={isEditSessionActive}
          is4k={is4k}
          editRequest={editRequest}
        />
      ) : type === 'tv' ? (
        <TvRequestModal
          key={editRequest ? sessionKey : editorKey}
          onComplete={editRequest ? completeEdit : onComplete}
          onCancel={onCancel}
          tmdbId={tmdbId}
          onUpdating={editRequest ? updateEdit : onUpdating}
          isEditSessionActive={isEditSessionActive}
          is4k={is4k}
          editRequest={editRequest}
        />
      ) : (
        <CollectionRequestModal
          onComplete={onComplete}
          onCancel={onCancel}
          tmdbId={tmdbId}
          onUpdating={onUpdating}
          is4k={is4k}
        />
      )}
    </Transition>
  );
};

export default RequestModal;
