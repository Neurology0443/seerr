import { TableCheck, TableColumn, type QueryRunner } from 'typeorm';

export async function migrateRejectedDiagnosticValue(
  runner: QueryRunner,
  postgres: boolean,
  down = false
): Promise<void> {
  const table = postgres
    ? 'catalogue.release_diagnostics'
    : 'release_diagnostics';
  const check = 'CHK_catalogue_diagnostic_rejected_value_length';
  if (down) {
    await runner.dropCheckConstraint(table, check);
    await runner.dropColumn(table, 'rejected_value');
  } else {
    await runner.addColumn(
      table,
      new TableColumn({
        name: 'rejected_value',
        type: 'varchar',
        length: '32',
        isNullable: true,
      })
    );
    await runner.createCheckConstraint(
      table,
      new TableCheck({
        name: check,
        expression: 'length("rejected_value") <= 32',
      })
    );
  }
}
