import { migrateRejectedDiagnosticValue } from '@server/lib/catalogue/migration/rejectedDiagnosticValue';
import type { MigrationInterface, QueryRunner } from 'typeorm';
export class RejectedDiagnosticValue1792972800002 implements MigrationInterface {
  async up(runner: QueryRunner): Promise<void> {
    await migrateRejectedDiagnosticValue(runner, false);
  }
  async down(runner: QueryRunner): Promise<void> {
    await migrateRejectedDiagnosticValue(runner, false, true);
  }
}
