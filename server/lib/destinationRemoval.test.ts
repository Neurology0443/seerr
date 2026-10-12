import {
  MediaRequestStatus,
  MediaStatus,
  MediaType,
} from '@server/constants/media';
import { getRepository } from '@server/datasource';
import { MediaDestinationStatus } from '@server/entity/MediaDestinationStatus';
import { MediaRequest } from '@server/entity/MediaRequest';
import { completeRequestsForDestination } from '@server/lib/destinationAvailability';
import { persistConfirmedDestinationRemoval } from '@server/lib/destinationRemoval';
import { setupTestDb } from '@server/test/db';
import {
  removalSnapshot,
  seedRemoval,
} from '@server/test/fixtures/destinationRemoval';
import assert from 'node:assert/strict';
import { afterEach, describe, it, mock } from 'node:test';

setupTestDb();
afterEach(() => mock.restoreAll());

describe('confirmed destination removal persistence', () => {
  it('dispatches only actual declines after the exact removal transaction commits', async () => {
    const { media, requests } = await seedRemoval(MediaType.TV);
    const manager = getRepository(MediaDestinationStatus).manager;
    const notify = mock.method(
      MediaRequest,
      'sendNotification',
      async (request: MediaRequest) => {
        assert.equal(request.id, requests[0].id);
        const snapshot = await removalSnapshot();
        assert.equal(snapshot.destinations[1].status, MediaStatus.DELETED);
        assert.ok(
          snapshot.seasons
            .filter(
              (s) => s.destinationStatusId === snapshot.destinations[1].id
            )
            .every((s) => s.status === MediaStatus.DELETED)
        );
        assert.equal(snapshot.requests[0].status, MediaRequestStatus.DECLINED);
        assert.equal(manager.queryRunner?.isTransactionActive ?? false, false);
      }
    );
    await persistConfirmedDestinationRemoval(media.id, 2, manager);
    assert.equal(notify.mock.callCount(), 1);
    await persistConfirmedDestinationRemoval(media.id, 2, manager);
    assert.equal(notify.mock.callCount(), 1);
  });

  it('rolls back declines, linkage and seasons together and sends no notification on failure', async () => {
    const { media } = await seedRemoval(MediaType.TV);
    const manager = getRepository(MediaDestinationStatus).manager;
    const before = await removalSnapshot();
    const notify = mock.method(
      MediaRequest,
      'sendNotification',
      async () => undefined
    );
    await manager.query(
      "CREATE TRIGGER fail_destination_removal BEFORE UPDATE ON media_destination_season WHEN NEW.status = 7 BEGIN SELECT RAISE(ABORT, 'test persistence failure'); END"
    );
    try {
      await assert.rejects(
        () => persistConfirmedDestinationRemoval(media.id, 2, manager),
        /test persistence failure/
      );
      assert.deepEqual(await removalSnapshot(), before);
      assert.equal(notify.mock.callCount(), 0);
    } finally {
      await manager.query('DROP TRIGGER fail_destination_removal');
    }
  });

  it('does not recreate a missing destination or decline its requests', async () => {
    const { media } = await seedRemoval();
    const repo = getRepository(MediaDestinationStatus);
    await repo.delete({ mediaId: media.id, serverId: 2 });
    const before = await removalSnapshot();
    await assert.rejects(() =>
      persistConfirmedDestinationRemoval(media.id, 2, repo.manager)
    );
    assert.deepEqual(await removalSnapshot(), before);
  });

  it('a late availability completion cannot overwrite committed terminal declines', async () => {
    const { media, requests } = await seedRemoval();
    const repo = getRepository(MediaDestinationStatus);
    mock.method(MediaRequest, 'sendNotification', async () => undefined);
    await persistConfirmedDestinationRemoval(media.id, 2, repo.manager);
    await repo.update(
      { mediaId: media.id, serverId: 2 },
      { status: MediaStatus.AVAILABLE }
    );
    assert.deepEqual(
      await completeRequestsForDestination(media.id, 2, repo.manager),
      []
    );
    assert.equal(
      (
        await getRepository(MediaRequest).findOneByOrFail({
          id: requests[0].id,
        })
      ).status,
      MediaRequestStatus.DECLINED
    );
    assert.equal(
      (
        await getRepository(MediaRequest).findOneByOrFail({
          id: requests[3].id,
        })
      ).status,
      MediaRequestStatus.FAILED
    );
  });
});
