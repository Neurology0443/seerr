import type { QueryRunner, TableColumnOptions, TableOptions } from 'typeorm';
import { Table } from 'typeorm';

// Frozen initial DDL, independent of application entity metadata and later migrations.
export function initialCatalogueTables(postgres: boolean): Table[] {
  const table = (name: string) => (postgres ? 'catalogue.' + name : name);
  const id: TableColumnOptions = {
    name: 'id',
    type: 'integer',
    isPrimary: true,
    isGenerated: true,
    generationStrategy: 'increment',
  };
  const int = (name: string, nullable = false): TableColumnOptions => ({
    name,
    type: 'integer',
    isNullable: nullable,
  });
  const text = (name: string, nullable = false): TableColumnOptions => ({
    name,
    type: 'varchar',
    isNullable: nullable,
  });
  const date = (name: string, nullable = false): TableColumnOptions => ({
    name,
    type: postgres ? 'timestamptz' : 'datetime',
    isNullable: nullable,
  });
  const fk = (name: string, column: string, target: string) => ({
    name,
    columnNames: [column],
    referencedTableName: table(target),
    referencedColumnNames: ['id'],
    onDelete: 'CASCADE',
  });
  const check = (name: string, expression: string) => ({
    name: 'CK_catalogue_' + name,
    expression,
  });
  const definitions: TableOptions[] = [
    {
      name: table('trackers'),
      columns: [
        { name: 'id', type: 'varchar', isPrimary: true },
        text('name'),
        text('connector_type'),
        { name: 'enabled', type: 'boolean', default: postgres ? 'true' : '1' },
      ],
    },
    {
      name: table('torrents'),
      columns: [
        id,
        text('tracker_id'),
        text('canonical_guid'),
        text('infohash', true),
        text('release_name'),
        { name: 'size', type: 'bigint', isNullable: true },
        date('published_at', true),
        int('seeders', true),
        int('leechers', true),
        date('first_seen_at'),
        date('last_seen_at'),
        date('seeders_observed_at', true),
      ],
      uniques: [
        {
          name: 'UQ_catalogue_torrent_identity',
          columnNames: ['tracker_id', 'canonical_guid'],
        },
      ],
      indices: [
        {
          name: 'IDX_catalogue_torrent_observation',
          columnNames: ['tracker_id', 'last_seen_at', 'id'],
        },
      ],
      foreignKeys: [
        fk('FK_catalogue_torrent_tracker', 'tracker_id', 'trackers'),
      ],
      checks: [
        check('torrent_size', '"size" IS NULL OR "size" >= 0'),
        check('torrent_seeders', '"seeders" IS NULL OR "seeders" >= 0'),
        check('torrent_leechers', '"leechers" IS NULL OR "leechers" >= 0'),
        check('torrent_observation', '"last_seen_at" >= "first_seen_at"'),
        check('torrent_guid', 'length("canonical_guid") > 0'),
      ],
    },
    {
      name: table('torrent_categories'),
      columns: [id, int('torrent_id'), int('category_id')],
      uniques: [
        {
          name: 'UQ_catalogue_torrent_category',
          columnNames: ['torrent_id', 'category_id'],
        },
      ],
      foreignKeys: [
        fk('FK_catalogue_category_torrent', 'torrent_id', 'torrents'),
      ],
      checks: [check('category_positive', '"category_id" > 0')],
    },
    {
      name: table('torrent_media'),
      columns: [
        id,
        int('torrent_id'),
        text('media_type'),
        text('id_namespace'),
        int('external_id'),
        text('identification_status'),
        text('provenance'),
        text('parser_version', true),
      ],
      uniques: [
        {
          name: 'UQ_catalogue_torrent_media',
          columnNames: [
            'torrent_id',
            'media_type',
            'id_namespace',
            'external_id',
          ],
        },
      ],
      indices: [
        {
          name: 'IDX_catalogue_media_identity',
          columnNames: [
            'media_type',
            'id_namespace',
            'external_id',
            'torrent_id',
          ],
        },
      ],
      foreignKeys: [fk('FK_catalogue_media_torrent', 'torrent_id', 'torrents')],
      checks: [
        check('media_type', "\"media_type\" IN ('movie', 'tv')"),
        check('media_namespace', "\"id_namespace\" IN ('tmdb', 'tvdb')"),
        check('media_external_id', '"external_id" > 0'),
        check(
          'media_status',
          "\"identification_status\" IN ('resolved', 'ambiguous', 'rejected')"
        ),
      ],
    },
    {
      name: table('torrent_coverage'),
      columns: [
        id,
        int('media_association_id'),
        text('kind'),
        text('completeness'),
        int('season_number', true),
        int('episode_start', true),
        int('episode_end', true),
        text('provenance'),
      ],
      indices: [
        {
          name: 'IDX_catalogue_coverage_selection',
          columnNames: [
            'media_association_id',
            'season_number',
            'episode_start',
          ],
        },
      ],
      foreignKeys: [
        fk(
          'FK_catalogue_coverage_media',
          'media_association_id',
          'torrent_media'
        ),
      ],
      checks: [
        check(
          'coverage_kind',
          "\"kind\" IN ('movie', 'season', 'episode', 'range', 'partial', 'unknown')"
        ),
        check(
          'coverage_completeness',
          "\"completeness\" IN ('presumed', 'verified', 'incomplete', 'uncertain')"
        ),
        check(
          'coverage_season',
          '"season_number" IS NULL OR "season_number" >= 0'
        ),
        check(
          'coverage_episodes',
          '("episode_start" IS NULL AND "episode_end" IS NULL) OR ("episode_start" IS NOT NULL AND "episode_end" IS NOT NULL AND "episode_start" > 0 AND "episode_end" >= "episode_start")'
        ),
        check(
          'coverage_shape',
          '("kind" = \'movie\' AND "season_number" IS NULL AND "episode_start" IS NULL) OR ("kind" = \'season\' AND "season_number" IS NOT NULL AND "episode_start" IS NULL) OR ("kind" = \'episode\' AND "season_number" IS NOT NULL AND "episode_start" IS NOT NULL AND "episode_end" = "episode_start") OR ("kind" = \'range\' AND "season_number" IS NOT NULL AND "episode_start" IS NOT NULL) OR "kind" IN (\'partial\', \'unknown\')'
        ),
      ],
    },
    {
      name: table('sync_state'),
      columns: [
        id,
        text('tracker_id'),
        int('category_id'),
        text('mode'),
        { name: 'checkpoint', type: 'text', isNullable: true },
        text('phase'),
        text('status'),
        int('pages_processed'),
        text('cycle_id', true),
        date('last_successful_at', true),
        date('last_observed_at', true),
        date('updated_at'),
        date('retry_after_at', true),
        text('error_code', true),
        int('last_http_status', true),
      ],
      uniques: [
        {
          name: 'UQ_catalogue_sync_scope',
          columnNames: ['tracker_id', 'category_id', 'mode'],
        },
      ],
      foreignKeys: [fk('FK_catalogue_sync_tracker', 'tracker_id', 'trackers')],
      checks: [
        check('sync_category', '"category_id" > 0'),
        check('sync_mode', "\"mode\" IN ('recent', 'historical')"),
        check(
          'sync_status',
          "\"status\" IN ('idle', 'running', 'backoff', 'suspended', 'error')"
        ),
        check('sync_progress', '"pages_processed" >= 0'),
        check(
          'sync_http_status',
          '"last_http_status" IS NULL OR "last_http_status" BETWEEN 100 AND 599'
        ),
      ],
    },
    {
      name: table('destination_indexers'),
      columns: [
        id,
        text('arr_type'),
        int('server_id'),
        int('indexer_id'),
        text('name', true),
        date('observed_at'),
        text('state'),
      ],
      uniques: [
        {
          name: 'UQ_catalogue_destination_indexer',
          columnNames: ['arr_type', 'server_id', 'indexer_id'],
        },
      ],
      indices: [
        {
          name: 'IDX_catalogue_destination_observation',
          columnNames: ['arr_type', 'server_id', 'observed_at'],
        },
      ],
      checks: [
        check('destination_type', "\"arr_type\" IN ('radarr', 'sonarr')"),
        check('destination_identity', '"server_id" >= 0 AND "indexer_id" > 0'),
        check(
          'indexer_state',
          "\"state\" IN ('unverified', 'verified', 'stale', 'error')"
        ),
      ],
    },
    {
      name: table('destination_tracker_links'),
      columns: [
        id,
        int('destination_indexer_id'),
        text('tracker_id'),
        date('observed_at'),
        text('state'),
      ],
      uniques: [
        {
          name: 'UQ_catalogue_indexer_tracker',
          columnNames: ['destination_indexer_id', 'tracker_id'],
        },
      ],
      indices: [
        {
          name: 'IDX_catalogue_tracker_destination',
          columnNames: ['tracker_id', 'destination_indexer_id'],
        },
      ],
      foreignKeys: [
        fk(
          'FK_catalogue_link_indexer',
          'destination_indexer_id',
          'destination_indexers'
        ),
        fk('FK_catalogue_link_tracker', 'tracker_id', 'trackers'),
      ],
      checks: [
        check(
          'link_state',
          "\"state\" IN ('unverified', 'verified', 'ambiguous', 'disabled')"
        ),
      ],
    },
  ];
  return definitions.map((definition) => new Table(definition));
}

export async function createInitialCatalogue(
  queryRunner: QueryRunner,
  postgres: boolean
): Promise<void> {
  for (const table of initialCatalogueTables(postgres))
    await queryRunner.createTable(table);
}
export async function dropInitialCatalogue(
  queryRunner: QueryRunner,
  postgres: boolean
): Promise<void> {
  for (const table of initialCatalogueTables(postgres).reverse())
    await queryRunner.dropTable(table, false, true, true);
}
