// Offline child process used to exercise real cross-process SQL coordination.
import {
  defaultTr4kerCollectionSettings,
  tr4kerCollectionDescription,
} from '@server/lib/catalogue/collectionConfig';
import { CollectionStore } from '@server/lib/catalogue/collectionStore';
import { createCatalogueDataSource } from '@server/lib/catalogue/datasource';
import { CatalogueRepository } from '@server/lib/catalogue/repository';

async function main(): Promise<void> {
  const input = JSON.parse(process.argv[2]);
  const db = createCatalogueDataSource(input.connection);
  await db.initialize();
  try {
    const store = new CollectionStore(db, async () => input.now);
    if (input.action === 'commit') {
      await new CatalogueRepository(db).persistPage(
        input.records ?? [],
        input.checkpoint,
        {
          owner: input.owner,
          clock: store.clock,
          onIdentityConflicts: () => input.checkpoint,
        }
      );
      process.send?.({ committed: true });
    } else {
      const tracker = {
        ...tr4kerCollectionDescription,
        trackerId: input.trackerId,
      };
      const settings = {
        ...defaultTr4kerCollectionSettings,
        ...input.settings,
      };
      const claimed = await store.claimNext(tracker, input.owner, settings);
      const now = claimed
        ? await store.reserveRequest(
            tracker,
            claimed.scope,
            input.owner,
            settings
          )
        : null;
      const reserved = claimed && now !== null ? { ...claimed, now } : null;
      if (claimed && now === null)
        await store.release(claimed.scope, input.owner);
      process.send?.({ reserved });
    }
  } catch (error) {
    process.send?.({
      error: error instanceof Error ? error.constructor.name : 'Error',
    });
  } finally {
    await db.destroy();
  }
}
void main().catch(() => {
  process.exitCode = 1;
});
