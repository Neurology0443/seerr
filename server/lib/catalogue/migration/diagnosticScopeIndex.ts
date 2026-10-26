import { TableIndex, type QueryRunner } from 'typeorm';

export async function migrateDiagnosticScopeIndex(
  runner: QueryRunner,
  postgres: boolean,
  down = false
): Promise<void> {
  const table = postgres
    ? 'catalogue.release_diagnostics'
    : 'release_diagnostics';
  const name = 'IDX_catalogue_diagnostic_scope_state';
  if (down) await runner.dropIndex(table, name);
  else
    await runner.createIndex(
      table,
      new TableIndex({
        name,
        columnNames: [
          'tracker_id',
          'category_id',
          'mode',
          'kind',
          'critical',
          'status',
          'next_attempt_at',
        ],
      })
    );
}
