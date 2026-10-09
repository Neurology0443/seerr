import CollectionRequestModal from '@app/components/RequestModal/CollectionRequestModal';
import MovieRequestModal from '@app/components/RequestModal/MovieRequestModal';
import TvRequestModal from '@app/components/RequestModal/TvRequestModal';
import { Transition } from '@headlessui/react';
import type { MediaStatus } from '@server/constants/media';
import type { MediaRequest } from '@server/entity/MediaRequest';
import type { NonFunctionProperties } from '@server/interfaces/api/common';
import { useLayoutEffect, useRef, useState } from 'react';

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
  const requestKey = editRequest ? `edit:${editRequest.id}` : 'new';
  const contextKey = `${type}:${tmdbId}:${is4k ? '4k' : 'standard'}:${requestKey}`;
  // A rapid reopen can precede Transition's delayed unmount. Give every
  // opening or request context change a fresh session even in that case.
  const [session, setSession] = useState({
    open: show,
    context: contextKey,
    number: 0,
  });
  if (session.open !== show || session.context !== contextKey) {
    setSession({
      open: show,
      context: contextKey,
      number: session.number + (show ? 1 : 0),
    });
  }
  const sessionKey = `${contextKey}:${session.number}`;
  const activeSession = useRef<string | undefined>(undefined);
  // Only a committed opening can activate a session. Conditional cleanup also
  // protects a newer session from invalidation by an older one.
  useLayoutEffect(() => {
    if (!show) return;
    activeSession.current = sessionKey;
    return () => {
      if (activeSession.current === sessionKey) {
        activeSession.current = undefined;
      }
    };
  }, [show, sessionKey]);
  const isSessionActive = () => activeSession.current === sessionKey;
  const cancelSession: typeof onCancel = () => {
    if (!isSessionActive()) return;
    // Close handlers invalidate before the parent's show change is committed.
    activeSession.current = undefined;
    onUpdating?.(false);
    onCancel?.();
  };
  const completeSession: typeof onComplete = (status) => {
    if (!isSessionActive()) return;
    activeSession.current = undefined;
    onUpdating?.(false);
    onComplete?.(status);
  };
  const updateSession: typeof onUpdating = (updating) => {
    if (isSessionActive()) onUpdating?.(updating);
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
          key={sessionKey}
          onComplete={onComplete ? completeSession : undefined}
          onCancel={onCancel ? cancelSession : undefined}
          tmdbId={tmdbId}
          onUpdating={onUpdating ? updateSession : undefined}
          isEditSessionActive={isSessionActive}
          is4k={is4k}
          editRequest={editRequest}
        />
      ) : type === 'tv' ? (
        <TvRequestModal
          key={sessionKey}
          onComplete={onComplete ? completeSession : undefined}
          onCancel={onCancel ? cancelSession : undefined}
          tmdbId={tmdbId}
          onUpdating={onUpdating ? updateSession : undefined}
          isEditSessionActive={isSessionActive}
          is4k={is4k}
          editRequest={editRequest}
        />
      ) : (
        <CollectionRequestModal
          key={sessionKey}
          onComplete={onComplete ? completeSession : undefined}
          onCancel={onCancel ? cancelSession : undefined}
          tmdbId={tmdbId}
          onUpdating={onUpdating ? updateSession : undefined}
          is4k={is4k}
        />
      )}
    </Transition>
  );
};

export default RequestModal;
