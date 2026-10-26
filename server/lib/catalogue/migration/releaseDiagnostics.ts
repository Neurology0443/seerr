import { Table, TableIndex, type QueryRunner } from 'typeorm';

export async function migrateReleaseDiagnostics(
  runner: QueryRunner,
  postgres: boolean,
  down = false
): Promise<void> {
  const name = postgres
    ? 'catalogue.release_diagnostics'
    : 'release_diagnostics';
  if (down) {
    await runner.dropTable(name);
    return;
  }
  const nullable = (name: string, type = 'varchar') => ({
    name,
    type,
    isNullable: true,
  });
  const date = postgres ? 'timestamptz' : 'datetime';
  await runner.createTable(
    new Table({
      name,
      columns: [
        {
          name: 'id',
          type: 'integer',
          isPrimary: true,
          isGenerated: true,
          generationStrategy: 'increment',
        },
        ...[
          'tracker_id',
          'mode',
          'diagnostic_key',
          'kind',
          'field',
          'code',
          'reason',
          'status',
        ].map((name) => ({ name, type: 'varchar' })),
        { name: 'category_id', type: 'integer' },
        ...[
          'guid',
          'infohash',
          'title',
          'fingerprint',
          'release_key',
          'last_attempt_cycle',
          'last_outcome',
        ].map((name) => nullable(name)),
        ...['first_seen_at', 'last_seen_at'].map((name) => ({
          name,
          type: date,
        })),
        ...['next_attempt_at', 'resolved_at'].map((name) =>
          nullable(name, date)
        ),
        ...['occurrences', 'attempts'].map((name) => ({
          name,
          type: 'integer',
        })),
        { name: 'critical', type: 'boolean' },
        nullable('page_offset', 'integer'),
        nullable('item_position', 'integer'),
      ],
      uniques: [
        {
          name: 'UQ_catalogue_release_diagnostic',
          columnNames: ['tracker_id', 'category_id', 'mode', 'diagnostic_key'],
        },
      ],
      foreignKeys: [
        {
          name: 'FK_catalogue_diagnostic_tracker',
          columnNames: ['tracker_id'],
          referencedTableName: postgres ? 'catalogue.trackers' : 'trackers',
          referencedColumnNames: ['id'],
          onDelete: 'CASCADE',
        },
      ],
    })
  );
  for (const [index, columns] of [
    ['repair', ['tracker_id', 'category_id', 'status', 'next_attempt_at']],
    [
      'retention',
      ['tracker_id', 'category_id', 'mode', 'status', 'resolved_at'],
    ],
    ['guid', ['tracker_id', 'category_id', 'guid']],
  ] as const)
    await runner.createIndex(
      name,
      new TableIndex({
        name: `IDX_catalogue_diagnostic_${index}`,
        columnNames: [...columns],
      })
    );
}
