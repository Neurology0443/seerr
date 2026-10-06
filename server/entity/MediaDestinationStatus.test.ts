import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { MediaStatus, MediaType } from '@server/constants/media';
import dataSource, { getRepository } from '@server/datasource';
import Media from '@server/entity/Media';
import { MediaDestinationSeasonStatus } from '@server/entity/MediaDestinationSeasonStatus';
import { MediaDestinationStatus } from '@server/entity/MediaDestinationStatus';
import { setupTestDb } from '@server/test/db';

setupTestDb();

let nextTmdbId = 50000;

const createMedia = () =>
  getRepository(Media).save(
    new Media({ mediaType: MediaType.MOVIE, tmdbId: nextTmdbId++ })
  );

const createDestination = async (mediaId: number, serverId = 1) =>
  getRepository(MediaDestinationStatus).save(
    new MediaDestinationStatus({ mediaId, serverId })
  );

describe('destination status persistence', () => {
  it('creates a destination with UNKNOWN as its default status', async () => {
    const media = await createMedia();
    const destination = await createDestination(media.id);

    assert.ok(destination.id);
    assert.strictEqual(destination.status, MediaStatus.UNKNOWN);
  });

  it('enforces unique media/server and destination/season pairs', async () => {
    const media = await createMedia();
    const destination = await createDestination(media.id);

    await assert.rejects(() => createDestination(media.id));

    const seasonRepository = getRepository(MediaDestinationSeasonStatus);
    await seasonRepository.save(
      new MediaDestinationSeasonStatus({
        destinationStatusId: destination.id,
        seasonNumber: 1,
      })
    );
    await assert.rejects(() =>
      seasonRepository.save(
        new MediaDestinationSeasonStatus({
          destinationStatusId: destination.id,
          seasonNumber: 1,
        })
      )
    );
  });

  it('deleting a destination cascades to its seasons but not its media', async () => {
    const media = await createMedia();
    const destination = await createDestination(media.id);
    await getRepository(MediaDestinationSeasonStatus).save(
      new MediaDestinationSeasonStatus({
        destinationStatusId: destination.id,
        seasonNumber: 2,
      })
    );

    await getRepository(MediaDestinationStatus).delete(destination.id);

    assert.strictEqual(
      await getRepository(MediaDestinationSeasonStatus).count(),
      0
    );
    assert.strictEqual(await getRepository(Media).countBy({ id: media.id }), 1);
  });

  it('deleting media cascades through destinations to seasons', async () => {
    const media = await createMedia();
    const destination = await createDestination(media.id);
    await getRepository(MediaDestinationSeasonStatus).save(
      new MediaDestinationSeasonStatus({
        destinationStatusId: destination.id,
        seasonNumber: 3,
      })
    );

    await getRepository(Media).delete(media.id);

    assert.strictEqual(await getRepository(MediaDestinationStatus).count(), 0);
    assert.strictEqual(
      await getRepository(MediaDestinationSeasonStatus).count(),
      0
    );
  });

  it('does not precreate destination rows with media', async () => {
    await createMedia();

    assert.strictEqual(await getRepository(MediaDestinationStatus).count(), 0);
    assert.strictEqual(
      await getRepository(MediaDestinationSeasonStatus).count(),
      0
    );
  });

  it('does not add destination columns to native tables', async () => {
    const queryRunner = dataSource.createQueryRunner();
    try {
      for (const tableName of [
        'media',
        'media_request',
        'season',
        'season_request',
      ]) {
        const table = await queryRunner.getTable(tableName);
        assert.ok(table, `${tableName} should exist`);
        assert.ok(
          table.columns.every(
            (column) =>
              !column.name.toLowerCase().includes('destination') &&
              column.name !== 'independentRequestDestination'
          ),
          `${tableName} should not contain Seerr-multi destination columns`
        );
      }
    } finally {
      await queryRunner.release();
    }
  });
});
