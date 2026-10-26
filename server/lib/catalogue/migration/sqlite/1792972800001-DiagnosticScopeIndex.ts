import { migrateDiagnosticScopeIndex } from '@server/lib/catalogue/migration/diagnosticScopeIndex';
import type { MigrationInterface, QueryRunner } from 'typeorm';
export class DiagnosticScopeIndex1792972800001 implements MigrationInterface {
  async up(runner: QueryRunner): Promise<void> {
    await migrateDiagnosticScopeIndex(runner, false);
  }
  async down(runner: QueryRunner): Promise<void> {
    await migrateDiagnosticScopeIndex(runner, false, true);
  }
}
