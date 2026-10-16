import { Permission, useUser } from '@app/hooks/useUser';
import type { MediaDownloadsResponse } from '@server/interfaces/api/mediaInterfaces';
import useSWR from 'swr';

/** Details owns the snapshot refresh; Manage receives the same result as props. */
const useMediaDownloads = (mediaId?: number) => {
  const { hasPermission } = useUser();
  return useSWR<MediaDownloadsResponse>(
    mediaId && hasPermission(Permission.MANAGE_REQUESTS)
      ? `/api/v1/media/${mediaId}/downloads`
      : null,
    { refreshInterval: 15000, keepPreviousData: false }
  );
};

export default useMediaDownloads;
