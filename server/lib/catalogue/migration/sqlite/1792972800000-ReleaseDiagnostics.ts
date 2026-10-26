import { migrateReleaseDiagnostics } from '@server/lib/catalogue/migration/releaseDiagnostics';
import type { MigrationInterface, QueryRunner } from 'typeorm';
export class ReleaseDiagnostics1792972800000 implements MigrationInterface {
  async up(runner: QueryRunner): Promise<void> {
    await migrateReleaseDiagnostics(runner, false);
  }
  async down(runner: QueryRunner): Promise<void> {
    await migrateReleaseDiagnostics(runner, false, true);
  }
}
