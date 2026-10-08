import type { MediaRequest } from '@server/entity/MediaRequest';
import { createHash } from 'node:crypto';

export type RequestEditState = Pick<
  MediaRequest,
  | 'id'
  | 'type'
  | 'status'
  | 'is4k'
  | 'serverId'
  | 'profileId'
  | 'rootFolder'
  | 'languageProfileId'
  | 'tags'
  | 'requestedBy'
  | 'ignoreQuota'
  | 'seasons'
>;

// Fixed field order and canonical DB nulls make this independent of timestamps
// and entity/object identity. Empty tags intentionally differ from null tags.
// This fingerprints current editable state, not write history: A -> B -> A
// returns the original token when the final semantic state is identical.
export const getRequestEditRevision = (request: RequestEditState): string =>
  createHash('sha256')
    .update(
      JSON.stringify({
        id: request.id,
        type: request.type,
        status: request.status,
        is4k: request.is4k,
        serverId: request.serverId ?? null,
        profileId: request.profileId ?? null,
        rootFolder: request.rootFolder ?? null,
        languageProfileId: request.languageProfileId ?? null,
        tags: request.tags ?? null,
        requestedById: request.requestedBy.id,
        ignoreQuota: request.ignoreQuota,
        seasons: (request.seasons ?? [])
          .map(({ seasonNumber, status }) => ({ seasonNumber, status }))
          .sort(
            (a, b) => a.seasonNumber - b.seasonNumber || a.status - b.status
          ),
      })
    )
    .digest('hex');

// Legacy callers remain unconditional. Conditional callers send one strong,
// quoted token; malformed/weak tokens cannot authorize a stale mutation.
export const matchesExpectedEditRevision = (
  ifMatch: string | undefined,
  request: RequestEditState
): boolean =>
  ifMatch === undefined || ifMatch === `"${getRequestEditRevision(request)}"`;
