import ExternalAPI from '@server/api/externalapi';
import { IssueType } from '@server/constants/issue';
import { MediaStatus, MediaType } from '@server/constants/media';
import { getRepository } from '@server/datasource';
import { Blocklist } from '@server/entity/Blocklist';
import Issue from '@server/entity/Issue';
import Media from '@server/entity/Media';
import { User } from '@server/entity/User';
import { getSettings } from '@server/lib/settings';
import { setupTestDb } from '@server/test/db';
import {
  removalSnapshot,
  seedRemoval,
} from '@server/test/fixtures/destinationRemoval';
import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import blocklistedTagsProcessor from './blocklistedTagsProcessor';

setupTestDb();
beforeEach(() => {
  getSettings().main.blocklistedTags = '';
  getSettings().main.blocklistedTagsLimit = 1;
});

async function seedTagged() {
  const { media } = await seedRemoval(MediaType.TV);
  const user = await getRepository(User).findOneByOrFail({ id: 1 });
  await getRepository(Issue).save(
    new Issue({ media, createdBy: user, issueType: IssueType.VIDEO }),
    { listeners: false }
  );
  await Blocklist.addToBlocklist({
    blocklistRequest: {
      tmdbId: media.tmdbId,
      mediaType: MediaType.TV,
      blocklistedTags: ',7,',
    },
  });
  await Blocklist.addToBlocklist({
    blocklistRequest: { tmdbId: 78001, mediaType: MediaType.MOVIE },
  });
  return media;
}

describe('PR8 blocklisted tag cleanup', () => {
  it('preserves independent states, seasons, request history and Issues while leaving manual entries intact', async () => {
    const media = await seedTagged();
    const before = await removalSnapshot();
    await blocklistedTagsProcessor.run();
    const after = await removalSnapshot();
    assert.deepEqual(after.destinations, before.destinations);
    assert.deepEqual(after.seasons, before.seasons);
    assert.deepEqual(after.seasonRequests, before.seasonRequests);
    assert.deepEqual(
      after.requests.map((r) => [r.id, r.status, r.serverId]),
      before.requests.map((r) => [r.id, r.status, r.serverId])
    );
    assert.equal(await getRepository(Issue).count(), 1);
    const retained = await getRepository(Media).findOneByOrFail({
      id: media.id,
    });
    assert.equal(retained.status, MediaStatus.UNKNOWN);
    assert.equal(retained.status4k, MediaStatus.UNKNOWN);
    assert.equal(retained.externalServiceId, media.externalServiceId);
    const entries = await getRepository(Blocklist).find();
    assert.equal(entries.length, 1);
    assert.equal(entries[0].tmdbId, 78001);
  });

  it('cleans bare tag placeholders and can regenerate tag entries without losing useful data', async (t) => {
    const media = await seedTagged();
    await Blocklist.addToBlocklist({
      blocklistRequest: {
        tmdbId: 78002,
        mediaType: MediaType.MOVIE,
        blocklistedTags: ',7,',
      },
    });
    const before = await removalSnapshot();
    getSettings().main.blocklistedTags = '7';
    t.mock.method(
      ExternalAPI.prototype as unknown as {
        get: (endpoint: string) => Promise<unknown>;
      },
      'get',
      async (endpoint: string) => {
        if (endpoint.startsWith('/keyword/')) return { id: 7, name: 'test' };
        if (endpoint === '/discover/tv')
          return {
            results: [{ id: media.tmdbId, name: 'Show' }],
            total_pages: 1,
          };
        if (endpoint === '/discover/movie')
          return { results: [{ id: 78001, title: 'Manual' }], total_pages: 1 };
        throw new Error(`Unexpected endpoint ${endpoint}`);
      }
    );
    await blocklistedTagsProcessor.run();
    const after = await removalSnapshot();
    assert.deepEqual(after.destinations, before.destinations);
    assert.deepEqual(after.seasons, before.seasons);
    assert.deepEqual(after.seasonRequests, before.seasonRequests);
    assert.equal(after.requests.length, before.requests.length);
    assert.equal(await getRepository(Issue).count(), 1);
    assert.equal(
      (
        await getRepository(Blocklist).findOneByOrFail({
          tmdbId: media.tmdbId,
          mediaType: MediaType.TV,
        })
      ).blocklistedTags,
      ',7,'
    );
    assert.equal(
      (await getRepository(Blocklist).findOneByOrFail({ tmdbId: 78001 }))
        .blocklistedTags,
      null
    );
    assert.equal(
      await getRepository(Blocklist).exists({ where: { tmdbId: 78002 } }),
      false
    );
    assert.equal(
      (await getRepository(Media).findOneByOrFail({ tmdbId: 78002 })).status,
      MediaStatus.UNKNOWN
    );
  });

  it('rolls back cleanup when regeneration fails', async (t) => {
    await seedTagged();
    const before = await removalSnapshot();
    const entries = await getRepository(Blocklist).find({
      order: { id: 'ASC' },
    });
    getSettings().main.blocklistedTags = '7';
    t.mock.method(
      ExternalAPI.prototype as unknown as {
        get: (endpoint: string) => Promise<unknown>;
      },
      'get',
      async () => {
        throw new Error('metadata failure');
      }
    );
    await assert.rejects(
      () => blocklistedTagsProcessor.run(),
      /metadata failure/
    );
    assert.deepEqual(await removalSnapshot(), before);
    assert.deepEqual(
      await getRepository(Blocklist).find({ order: { id: 'ASC' } }),
      entries
    );
    assert.equal(blocklistedTagsProcessor.status().running, false);
  });

  it('rolls back cleanup when cancellation interrupts regeneration', async (t) => {
    await seedTagged();
    const before = await removalSnapshot();
    getSettings().main.blocklistedTags = '7';
    t.mock.method(
      ExternalAPI.prototype as unknown as {
        get: (endpoint: string) => Promise<unknown>;
      },
      'get',
      async () => {
        blocklistedTagsProcessor.cancel();
        return { id: 7, name: 'test' };
      }
    );
    await blocklistedTagsProcessor.run();
    assert.deepEqual(await removalSnapshot(), before);
    assert.equal(await getRepository(Blocklist).count(), 2);
  });
});
