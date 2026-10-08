import { MediaRequestStatus } from '@server/constants/media';
import type { RequestDetailResponse } from '@server/interfaces/api/requestInterfaces';
import { useCallback, useEffect, useRef, useState } from 'react';
import useSWR from 'swr';

// Shared only by the movie/TV request editors. A list or cached detail object
// cannot establish the initial baseline for a new editing session.
export const useRequestEditSession = (
  requestId: number | undefined,
  dirty: boolean,
  onAccept: (request: RequestDetailResponse) => void,
  isSessionActive?: () => boolean
) => {
  const [accepted, setAccepted] = useState<RequestDetailResponse>();
  const [confirmed, setConfirmed] = useState(false);
  const [conflicted, setConflicted] = useState(false);
  const [initialError, setInitialError] = useState<unknown>();
  const mounted = useRef(true);
  const callbacks = useRef({ dirty, onAccept, isSessionActive });
  callbacks.current = { dirty, onAccept, isSessionActive };
  const isActive = useCallback(
    () => mounted.current && (callbacks.current.isSessionActive?.() ?? true),
    []
  );
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const { data, error, mutate } = useSWR<RequestDetailResponse>(
    requestId === undefined ? null : `/api/v1/request/${requestId}`,
    { revalidateOnMount: true }
  );

  useEffect(() => {
    let active = true;
    setAccepted(undefined);
    setConfirmed(false);
    setConflicted(false);
    setInitialError(undefined);
    if (requestId !== undefined) {
      // A bound SWR revalidation confirms this session even when another SWR
      // subscriber already populated/deduplicated the detail cache.
      void mutate().then(
        (request) => {
          if (!active || !isActive()) return;
          if (!request || request.id !== requestId || !request.editRevision) {
            setInitialError(new Error('Unable to retrieve request.'));
            return;
          }
          callbacks.current.onAccept(request);
          setAccepted(request);
          setConfirmed(true);
        },
        (error: unknown) => {
          if (active && isActive()) setInitialError(error);
        }
      );
    }
    return () => {
      active = false;
    };
  }, [requestId, mutate, isActive]);

  useEffect(() => {
    if (
      !isActive() ||
      !confirmed ||
      conflicted ||
      !accepted ||
      !data ||
      data.id !== requestId ||
      !data.editRevision ||
      data.editRevision === accepted.editRevision
    )
      return;
    if (callbacks.current.dirty) {
      setConflicted(true);
    } else {
      callbacks.current.onAccept(data);
      setAccepted(data);
    }
  }, [data, accepted, confirmed, conflicted, requestId, isActive]);

  return {
    request: accepted?.id === requestId ? accepted : undefined,
    error: (initialError ?? error) as unknown,
    conflicted,
    isActive,
    blockConflict: () => setConflicted(true),
    blocked:
      !confirmed ||
      accepted?.id !== requestId ||
      accepted?.status !== MediaRequestStatus.PENDING ||
      conflicted ||
      !!(initialError ?? error),
  };
};
