import { migrateCollectionEngine } from '@server/lib/catalogue/migration/collectionEngine';
import type { MigrationInterface, QueryRunner } from 'typeorm';

export class CollectionEngine1792886400000 implements MigrationInterface {
  name = 'CollectionEngine1792886400000';
  async up(runner: QueryRunner): Promise<void> {
    await migrateCollectionEngine(runner, false);
  }
  async down(runner: QueryRunner): Promise<void> {
    await migrateCollectionEngine(runner, false, true);
  }
}
