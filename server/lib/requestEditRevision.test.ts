import { MediaRequestStatus, MediaType } from '@server/constants/media';
import type { MediaRequest } from '@server/entity/MediaRequest';
import type SeasonRequest from '@server/entity/SeasonRequest';
import type { User } from '@server/entity/User';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  getRequestEditRevision,
  matchesExpectedEditRevision,
} from './requestEditRevision';

const state = (): MediaRequest =>
  ({
    id: 1,
    type: MediaType.TV,
    status: MediaRequestStatus.PENDING,
    is4k: false,
    serverId: 1,
    profileId: 10,
    rootFolder: '/tv',
    languageProfileId: 20,
    tags: [],
    requestedBy: { id: 1 } as User,
    ignoreQuota: false,
    seasons: [1, 2].map(
      (seasonNumber) =>
        ({ seasonNumber, status: MediaRequestStatus.PENDING }) as SeasonRequest
    ),
    updatedAt: new Date('2026-10-08T00:00:00Z'),
  }) as unknown as MediaRequest;

describe('request edit revision', () => {
  it('is stable across entity identity, property order and timestamps', () => {
    const request = state();
    const reordered = Object.fromEntries(
      Object.entries(request).reverse()
    ) as MediaRequest;
    reordered.updatedAt = new Date('2026-10-08T00:01:00Z');
    assert.equal(
      getRequestEditRevision(request),
      getRequestEditRevision(reordered)
    );
  });

  for (const change of [
    { id: 2 },
    { type: MediaType.MOVIE },
    { status: MediaRequestStatus.APPROVED },
    { is4k: true },
    { serverId: 2 },
    { profileId: 11 },
    { rootFolder: '/other' },
    { languageProfileId: 21 },
    { tags: [1] },
    { requestedBy: { id: 2 } as User },
    { ignoreQuota: true },
    {
      seasons: [
        { seasonNumber: 1, status: MediaRequestStatus.PENDING },
      ] as SeasonRequest[],
    },
    {
      seasons: [
        { seasonNumber: 1, status: MediaRequestStatus.APPROVED },
        { seasonNumber: 2, status: MediaRequestStatus.PENDING },
      ] as SeasonRequest[],
    },
  ]) {
    it(`changes with ${Object.keys(change)[0]}, even at the same timestamp`, () => {
      const request = state();
      assert.notEqual(
        getRequestEditRevision(request),
        getRequestEditRevision({ ...request, ...change })
      );
    });
  }

  it('restores the original token after A -> B -> A, allowing the identical current state', () => {
    const request = state();
    const accepted = getRequestEditRevision(request);
    const originalFolder = request.rootFolder;
    request.rootFolder = '/other';
    assert.notEqual(getRequestEditRevision(request), accepted);
    assert.equal(matchesExpectedEditRevision(`"${accepted}"`, request), false);
    request.rootFolder = originalFolder;
    request.updatedAt = new Date('2026-10-08T00:02:00Z');
    request.seasons.reverse();
    assert.equal(getRequestEditRevision(request), accepted);
    assert.ok(matchesExpectedEditRevision(`"${accepted}"`, request));
  });

  it('normalizes nullable values without collapsing empty tags', () => {
    const request = state();
    const nullable = { ...request, tags: null } as unknown as MediaRequest;
    assert.notEqual(
      getRequestEditRevision(request),
      getRequestEditRevision(nullable)
    );
    assert.equal(
      getRequestEditRevision({ ...request, tags: undefined }),
      getRequestEditRevision(nullable)
    );
  });

  it('normalizes season order without mutating the input', () => {
    const request = state();
    const reversed = { ...request, seasons: request.seasons.toReversed() };
    assert.equal(
      getRequestEditRevision(request),
      getRequestEditRevision(reversed)
    );
    assert.deepEqual(
      reversed.seasons.map((season) => season.seasonNumber),
      [2, 1]
    );
  });

  it('preserves unconditional callers and requires the quoted current revision', () => {
    const request = state();
    const revision = getRequestEditRevision(request);
    assert.ok(matchesExpectedEditRevision(undefined, request));
    assert.ok(matchesExpectedEditRevision(`"${revision}"`, request));
    for (const header of ['', revision, `W/"${revision}"`, '"stale"', '*']) {
      assert.equal(matchesExpectedEditRevision(header, request), false);
    }
  });
});
