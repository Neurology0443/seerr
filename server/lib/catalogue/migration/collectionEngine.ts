import type { QueryRunner } from 'typeorm';
import { Table, TableColumn } from 'typeorm';

// Additive P3 DDL. Keep the frozen P1 migration unchanged.
export async function migrateCollectionEngine(
  runner: QueryRunner,
  postgres: boolean,
  down = false
): Promise<void> {
  const table = (name: string) => (postgres ? `catalogue.${name}` : name);
  const dateType = postgres ? 'timestamptz' : 'datetime';
  const columns = {
    torrents: [
      ...[
        'native_tmdb_id',
        'native_tvdb_id',
        'native_season',
        'native_episode',
      ].map((name) => ({ name, type: 'integer', isNullable: true })),
      { name: 'native_provenance', type: 'text', isNullable: true },
      { name: 'native_observed_at', type: dateType, isNullable: true },
    ],
    sync_state: [
      { name: 'collection_state', type: 'text', isNullable: true },
      { name: 'next_run_at', type: dateType, isNullable: true },
      { name: 'lease_owner', type: 'varchar', isNullable: true },
      { name: 'lease_expires_at', type: dateType, isNullable: true },
    ],
  };
  if (down) await runner.dropTable(table('tracker_dispatch'));
  for (const [name, definitions] of Object.entries(columns)) {
    if (!postgres) {
      // SQLite's ORM table rebuild can cascade-delete referencing rows. These
      // nullable additions/removals need only native ALTER TABLE operations.
      for (const column of definitions)
        await runner.query(
          `ALTER TABLE "${name}" ${down ? `DROP COLUMN "${column.name}"` : `ADD COLUMN "${column.name}" ${column.type}`}`
        );
    } else if (down)
      await runner.dropColumns(
        table(name),
        definitions.map((c) => c.name)
      );
    else
      await runner.addColumns(
        table(name),
        definitions.map((c) => new TableColumn(c))
      );
  }
  if (!down)
    await runner.createTable(
      new Table({
        name: table('tracker_dispatch'),
        columns: [
          { name: 'tracker_id', type: 'varchar', isPrimary: true },
          ...['last_start', 'maintenance_start', 'cooldown_until'].map(
            (name) => ({ name, type: 'bigint', isNullable: true })
          ),
          {
            name: 'suspended',
            type: 'boolean',
            default: postgres ? 'false' : '0',
          },
          { name: 'failures', type: 'integer', default: 0 },
          { name: 'error_code', type: 'varchar', isNullable: true },
          { name: 'last_http_status', type: 'integer', isNullable: true },
        ],
        foreignKeys: [
          {
            name: 'FK_catalogue_dispatch_tracker',
            columnNames: ['tracker_id'],
            referencedTableName: table('trackers'),
            referencedColumnNames: ['id'],
            onDelete: 'CASCADE',
          },
        ],
      })
    );
}
