import type { EntitySchemaColumnOptions } from 'typeorm';
import { EntitySchema } from 'typeorm';
import type {
  CatalogueCategory,
  CatalogueCoverage,
  CatalogueDestinationIndexer,
  CatalogueDestinationTrackerLink,
  CatalogueDispatchState,
  CatalogueEngine,
  CatalogueMediaAssociation,
  CatalogueReleaseDiagnostic,
  CatalogueSyncState,
  CatalogueTorrent,
  CatalogueTracker,
} from './types';

export const catalogueEntityNames = {
  tracker: 'CatalogueTracker',
  torrent: 'CatalogueTorrent',
  category: 'CatalogueCategory',
  media: 'CatalogueMediaAssociation',
  coverage: 'CatalogueCoverage',
  sync: 'CatalogueSyncState',
  indexer: 'CatalogueDestinationIndexer',
  link: 'CatalogueDestinationTrackerLink',
  dispatch: 'CatalogueDispatchState',
  diagnostic: 'CatalogueReleaseDiagnostic',
} as const;

// Build metadata per connection, without native decorators or global DB_TYPE.
export function createCatalogueEntities(
  engine: CatalogueEngine
): EntitySchema[] {
  const schema = engine === 'postgres' ? 'catalogue' : undefined;
  const id: EntitySchemaColumnOptions = {
    type: 'integer',
    primary: true,
    generated: 'increment',
  };
  const int = (name: string, nullable = false): EntitySchemaColumnOptions => ({
    name,
    type: 'integer',
    nullable,
  });
  const text = (name: string, nullable = false): EntitySchemaColumnOptions => ({
    name,
    type: 'varchar',
    nullable,
  });
  const date = (name: string, nullable = false): EntitySchemaColumnOptions => ({
    name,
    type: engine === 'postgres' ? 'timestamptz' : 'datetime',
    nullable,
  });
  const fk = (name: string, target: string, column: string) => ({
    name,
    target,
    columnNames: [column],
    referencedColumnNames: ['id'],
    onDelete: 'CASCADE' as const,
  });
  return [
    new EntitySchema<CatalogueReleaseDiagnostic>({
      name: catalogueEntityNames.diagnostic,
      tableName: 'release_diagnostics',
      schema,
      columns: {
        id,
        trackerId: text('tracker_id'),
        categoryId: int('category_id'),
        mode: text('mode'),
        diagnosticKey: text('diagnostic_key'),
        releaseKey: text('release_key', true),
        kind: text('kind'),
        guid: text('guid', true),
        infohash: text('infohash', true),
        title: text('title', true),
        fingerprint: text('fingerprint', true),
        field: text('field'),
        code: text('code'),
        reason: text('reason'),
        critical: { type: 'boolean' },
        firstSeenAt: date('first_seen_at'),
        lastSeenAt: date('last_seen_at'),
        occurrences: int('occurrences'),
        status: text('status'),
        attempts: int('attempts'),
        nextAttemptAt: date('next_attempt_at', true),
        lastAttemptCycle: text('last_attempt_cycle', true),
        lastOutcome: text('last_outcome', true),
        resolvedAt: date('resolved_at', true),
        offset: int('page_offset', true),
        itemPosition: int('item_position', true),
      },
      uniques: [
        {
          name: 'UQ_catalogue_release_diagnostic',
          columns: ['trackerId', 'categoryId', 'mode', 'diagnosticKey'],
        },
      ],
      indices: [
        {
          name: 'IDX_catalogue_diagnostic_repair',
          columns: ['trackerId', 'categoryId', 'status', 'nextAttemptAt'],
        },
        {
          name: 'IDX_catalogue_diagnostic_retention',
          columns: ['trackerId', 'categoryId', 'mode', 'status', 'resolvedAt'],
        },
        {
          name: 'IDX_catalogue_diagnostic_guid',
          columns: ['trackerId', 'categoryId', 'guid'],
        },
      ],
      foreignKeys: [
        fk(
          'FK_catalogue_diagnostic_tracker',
          catalogueEntityNames.tracker,
          'trackerId'
        ),
      ],
    }),
    new EntitySchema<CatalogueTracker>({
      name: catalogueEntityNames.tracker,
      tableName: 'trackers',
      schema,
      columns: {
        id: { type: 'varchar', primary: true },
        name: text('name'),
        connectorType: text('connector_type'),
        enabled: { type: 'boolean', default: true },
      },
    }),
    new EntitySchema<CatalogueTorrent>({
      name: catalogueEntityNames.torrent,
      tableName: 'torrents',
      schema,
      columns: {
        id,
        trackerId: text('tracker_id'),
        canonicalGuid: text('canonical_guid'),
        infohash: text('infohash', true),
        releaseName: text('release_name'),
        size: {
          name: 'size',
          type: 'bigint',
          nullable: true,
          transformer: {
            to: (value: number | null) => value,
            from: (value: string | number | null) =>
              value === null ? null : Number(value),
          },
        },
        publishedAt: date('published_at', true),
        seeders: int('seeders', true),
        leechers: int('leechers', true),
        firstSeenAt: date('first_seen_at'),
        lastSeenAt: date('last_seen_at'),
        seedersObservedAt: date('seeders_observed_at', true),
        nativeTmdbId: int('native_tmdb_id', true),
        nativeTvdbId: int('native_tvdb_id', true),
        nativeSeason: int('native_season', true),
        nativeEpisode: int('native_episode', true),
        nativeProvenance: {
          name: 'native_provenance',
          type: 'text',
          nullable: true,
        },
        nativeObservedAt: date('native_observed_at', true),
      },
      uniques: [
        {
          name: 'UQ_catalogue_torrent_identity',
          columns: ['trackerId', 'canonicalGuid'],
        },
      ],
      indices: [
        {
          name: 'IDX_catalogue_torrent_observation',
          columns: ['trackerId', 'lastSeenAt', 'id'],
        },
      ],
      foreignKeys: [
        fk(
          'FK_catalogue_torrent_tracker',
          catalogueEntityNames.tracker,
          'trackerId'
        ),
      ],
    }),
    new EntitySchema<CatalogueCategory>({
      name: catalogueEntityNames.category,
      tableName: 'torrent_categories',
      schema,
      columns: {
        id,
        torrentId: int('torrent_id'),
        categoryId: int('category_id'),
      },
      uniques: [
        {
          name: 'UQ_catalogue_torrent_category',
          columns: ['torrentId', 'categoryId'],
        },
      ],
      foreignKeys: [
        fk(
          'FK_catalogue_category_torrent',
          catalogueEntityNames.torrent,
          'torrentId'
        ),
      ],
    }),
    new EntitySchema<CatalogueMediaAssociation>({
      name: catalogueEntityNames.media,
      tableName: 'torrent_media',
      schema,
      columns: {
        id,
        torrentId: int('torrent_id'),
        mediaType: text('media_type'),
        idNamespace: text('id_namespace'),
        externalId: int('external_id'),
        identificationStatus: text('identification_status'),
        provenance: text('provenance'),
        parserVersion: text('parser_version', true),
      },
      uniques: [
        {
          name: 'UQ_catalogue_torrent_media',
          columns: ['torrentId', 'mediaType', 'idNamespace', 'externalId'],
        },
      ],
      indices: [
        {
          name: 'IDX_catalogue_media_identity',
          columns: ['mediaType', 'idNamespace', 'externalId', 'torrentId'],
        },
      ],
      foreignKeys: [
        fk(
          'FK_catalogue_media_torrent',
          catalogueEntityNames.torrent,
          'torrentId'
        ),
      ],
    }),
    new EntitySchema<CatalogueCoverage>({
      name: catalogueEntityNames.coverage,
      tableName: 'torrent_coverage',
      schema,
      columns: {
        id,
        mediaAssociationId: int('media_association_id'),
        kind: text('kind'),
        completeness: text('completeness'),
        seasonNumber: int('season_number', true),
        episodeStart: int('episode_start', true),
        episodeEnd: int('episode_end', true),
        provenance: text('provenance'),
      },
      indices: [
        {
          name: 'IDX_catalogue_coverage_selection',
          columns: ['mediaAssociationId', 'seasonNumber', 'episodeStart'],
        },
      ],
      foreignKeys: [
        fk(
          'FK_catalogue_coverage_media',
          catalogueEntityNames.media,
          'mediaAssociationId'
        ),
      ],
    }),
    new EntitySchema<CatalogueSyncState>({
      name: catalogueEntityNames.sync,
      tableName: 'sync_state',
      schema,
      columns: {
        id,
        trackerId: text('tracker_id'),
        categoryId: int('category_id'),
        mode: text('mode'),
        checkpoint: { name: 'checkpoint', type: 'text', nullable: true },
        phase: text('phase'),
        status: text('status'),
        pagesProcessed: int('pages_processed'),
        cycleId: text('cycle_id', true),
        lastSuccessfulAt: date('last_successful_at', true),
        lastObservedAt: date('last_observed_at', true),
        updatedAt: date('updated_at'),
        retryAfterAt: date('retry_after_at', true),
        errorCode: text('error_code', true),
        lastHttpStatus: int('last_http_status', true),
        collectionState: {
          name: 'collection_state',
          type: 'text',
          nullable: true,
        },
        nextRunAt: date('next_run_at', true),
        leaseOwner: text('lease_owner', true),
        leaseExpiresAt: date('lease_expires_at', true),
      },
      uniques: [
        {
          name: 'UQ_catalogue_sync_scope',
          columns: ['trackerId', 'categoryId', 'mode'],
        },
      ],
      foreignKeys: [
        fk(
          'FK_catalogue_sync_tracker',
          catalogueEntityNames.tracker,
          'trackerId'
        ),
      ],
    }),
    new EntitySchema<CatalogueDispatchState>({
      name: catalogueEntityNames.dispatch,
      tableName: 'tracker_dispatch',
      schema,
      columns: {
        trackerId: { name: 'tracker_id', type: 'varchar', primary: true },
        ...Object.fromEntries(
          ['lastStart', 'maintenanceStart', 'cooldownUntil'].map((property) => [
            property,
            {
              name: {
                lastStart: 'last_start',
                maintenanceStart: 'maintenance_start',
                cooldownUntil: 'cooldown_until',
              }[property],
              type: 'bigint',
              nullable: true,
              transformer: {
                to: (value: number | null) => value,
                from: (value: string | number | null) =>
                  value == null ? null : Number(value),
              },
            },
          ])
        ),
        suspended: { type: 'boolean', default: false },
        failures: { type: 'integer', default: 0 },
        errorCode: text('error_code', true),
        lastHttpStatus: int('last_http_status', true),
      },
      foreignKeys: [
        fk(
          'FK_catalogue_dispatch_tracker',
          catalogueEntityNames.tracker,
          'trackerId'
        ),
      ],
    }),
    new EntitySchema<CatalogueDestinationIndexer>({
      name: catalogueEntityNames.indexer,
      tableName: 'destination_indexers',
      schema,
      columns: {
        id,
        arrType: text('arr_type'),
        serverId: int('server_id'),
        indexerId: int('indexer_id'),
        name: text('name', true),
        observedAt: date('observed_at'),
        state: text('state'),
      },
      uniques: [
        {
          name: 'UQ_catalogue_destination_indexer',
          columns: ['arrType', 'serverId', 'indexerId'],
        },
      ],
      indices: [
        {
          name: 'IDX_catalogue_destination_observation',
          columns: ['arrType', 'serverId', 'observedAt'],
        },
      ],
    }),
    new EntitySchema<CatalogueDestinationTrackerLink>({
      name: catalogueEntityNames.link,
      tableName: 'destination_tracker_links',
      schema,
      columns: {
        id,
        destinationIndexerId: int('destination_indexer_id'),
        trackerId: text('tracker_id'),
        observedAt: date('observed_at'),
        state: text('state'),
      },
      uniques: [
        {
          name: 'UQ_catalogue_indexer_tracker',
          columns: ['destinationIndexerId', 'trackerId'],
        },
      ],
      indices: [
        {
          name: 'IDX_catalogue_tracker_destination',
          columns: ['trackerId', 'destinationIndexerId'],
        },
      ],
      foreignKeys: [
        fk(
          'FK_catalogue_link_indexer',
          catalogueEntityNames.indexer,
          'destinationIndexerId'
        ),
        fk(
          'FK_catalogue_link_tracker',
          catalogueEntityNames.tracker,
          'trackerId'
        ),
      ],
    }),
  ];
}
