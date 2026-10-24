import {
  createInitialCatalogue,
  dropInitialCatalogue,
} from '@server/lib/catalogue/migration/initialSchema';
import type { MigrationInterface, QueryRunner } from 'typeorm';

export class InitialCatalogue1792800000000 implements MigrationInterface {
  name = 'InitialCatalogue1792800000000';
  async up(queryRunner: QueryRunner): Promise<void> {
    await createInitialCatalogue(queryRunner, true);
  }
  async down(queryRunner: QueryRunner): Promise<void> {
    await dropInitialCatalogue(queryRunner, true);
  }
}
