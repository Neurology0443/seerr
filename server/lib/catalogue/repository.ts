import type { DataSource, EntityManager } from 'typeorm';
import { In } from 'typeorm';
import { catalogueEntityNames as names } from './entities';
import {
  CatalogueLeaseLostError,
  catalogueWrite,
  databaseTime,
  type CatalogueClock,
} from './transactions';
import type {
  CatalogueCategory,
  CatalogueCoverage,
  CatalogueDestinationIndexer,
  CatalogueDestinationTrackerLink,
  CatalogueMediaAssociation,
  CatalogueSyncState,
  CatalogueTorrent,
  CatalogueTracker,
  MediaIdentity,
  ObservedTorrent,
  SyncCheckpoint,
} from './types';

export class CatalogueIdentityConflictError extends Error {
  constructor() {
    super('Catalogue tracker/GUID identity has a contradictory infohash');
  }
}

// This is a rejection boundary, not tracker-specific extraction or normalization.
export function assertSafeCanonicalGuid(guid: string): void {
  let decoded = guid;
  try {
    for (let i = 0; i < 3; i++) {
      const next = decodeURIComponent(decoded);
      if (next === decoded) break;
      decoded = next;
    }
  } catch {
    throw new Error('Unsafe catalogue GUID');
  }
  if (
    !guid ||
    guid.length > 2048 ||
    guid !== guid.trim() ||
    decoded.includes('\\') ||
    decoded.includes('%') ||
    [...decoded].some(
      (character) =>
        character.charCodeAt(0) <= 32 || character.charCodeAt(0) === 127
    )
  ) {
    throw new Error('Unsafe catalogue GUID');
  }
  if (/^https?:\/\//i.test(decoded)) {
    let url: URL;
    try {
      url = new URL(decoded);
    } catch {
      throw new Error('Unsafe catalogue GUID');
    }
    if (
      url.username ||
      url.password ||
      decoded.includes('#') ||
      [...url.searchParams].some(
        ([key, value]) =>
          !['id', 'torrentid', 'torrent_id'].includes(key.toLowerCase()) ||
          !/^\d+$/.test(value)
      )
    ) {
      throw new Error('Unsafe catalogue GUID');
    }
  } else if (
    !/^[a-z0-9._:-]+$/i.test(decoded) ||
    /(?:^|[^a-z0-9])(?:passkey|api[_-]?key|auth(?:orization)?|token|password|secret)[:=]/i.test(
      decoded
    )
  ) {
    throw new Error('Unsafe catalogue GUID');
  }
}

function integer(value: number, min = 0, max = 2147483647): void {
  if (!Number.isSafeInteger(value) || value < min || value > max)
    throw new Error('Invalid catalogue integer');
}

function date(value: Date): void {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime()))
    throw new Error('Invalid catalogue observation date');
}

function requireTransaction(manager: EntityManager): void {
  if (!manager.queryRunner?.isTransactionActive)
    throw new Error('Catalogue page writes require an active transaction');
}

function assertNativeProvenance(origin: unknown): void {
  const value = origin as { source?: unknown; field?: unknown } | null;
  // Native metadata remains a tracker claim. The adapter interprets the exact
  // protocol field; persistence accepts only a bounded symbolic field path.
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).some((key) => key !== 'source' && key !== 'field') ||
    value.source !== 'tracker' ||
    typeof value.field !== 'string' ||
    !/^[a-z_$/][a-z0-9_$.:/-]{0,127}$/i.test(value.field) ||
    value.field.includes('//') ||
    value.field
      .split(/[.:/]/)
      .some((part) =>
        [
          'apikey',
          'passkey',
          'authorization',
          'auth',
          'accesstoken',
          'token',
          'password',
          'secret',
        ].includes(part.toLowerCase().replace(/[_-]/g, ''))
      )
  )
    throw new Error('Invalid catalogue native metadata provenance');
}

type NormalizedObservation = ObservedTorrent & { firstSeenAt: Date };

function normalizeObservations(
  records: ObservedTorrent[]
): NormalizedObservation[] {
  const unique = new Map<string, NormalizedObservation>();
  for (const input of records) {
    assertSafeCanonicalGuid(input.canonicalGuid);
    date(input.observedAt);
    if (input.publishedAt) date(input.publishedAt);
    if (!input.trackerId || !input.releaseName)
      throw new Error('Missing catalogue torrent identity or release name');
    for (const value of [input.seeders, input.leechers])
      if (value != null) integer(value);
    if (input.size != null) integer(input.size, 0, Number.MAX_SAFE_INTEGER);
    if (
      input.infohash != null &&
      !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(input.infohash)
    )
      throw new Error('Invalid catalogue infohash');
    for (const category of input.categories ?? []) integer(category, 1);
    if (input.trackerMetadata) {
      for (const field of ['tmdbId', 'tvdbId', 'season', 'episode'] as const) {
        const value =
          input.trackerMetadata[field as keyof typeof input.trackerMetadata];
        if (value != null) {
          integer(value, field.endsWith('Id') ? 1 : 0);
          assertNativeProvenance(input.provenance?.[field]);
        } else if (input.provenance?.[field] != null)
          assertNativeProvenance(input.provenance[field]);
      }
    }
    const record: NormalizedObservation = {
      ...input,
      infohash: input.infohash?.toLowerCase() ?? null,
      firstSeenAt: input.observedAt,
    };
    const key = JSON.stringify([record.trackerId, record.canonicalGuid]);
    const previous = unique.get(key);
    if (previous) {
      if (
        previous.infohash &&
        record.infohash &&
        previous.infohash !== record.infohash
      )
        throw new CatalogueIdentityConflictError();
      const latest =
        previous.observedAt > record.observedAt ? previous : record;
      unique.set(key, {
        ...latest,
        infohash: previous.infohash ?? record.infohash,
        firstSeenAt:
          previous.firstSeenAt < record.firstSeenAt
            ? previous.firstSeenAt
            : record.firstSeenAt,
      });
    } else unique.set(key, record);
  }
  return [...unique.values()];
}

export async function upsertObservedTorrents(
  manager: EntityManager,
  records: ObservedTorrent[]
): Promise<CatalogueTorrent[]> {
  requireTransaction(manager);
  const observations = normalizeObservations(records);
  const postgres = manager.connection.options.type === 'postgres';
  const table = postgres ? '"catalogue"."torrents"' : '"torrents"';
  const columns = [
    'tracker_id',
    'canonical_guid',
    'infohash',
    'release_name',
    'size',
    'published_at',
    'seeders',
    'leechers',
    'first_seen_at',
    'last_seen_at',
    'seeders_observed_at',
    'native_tmdb_id',
    'native_tvdb_id',
    'native_season',
    'native_episode',
    'native_provenance',
    'native_observed_at',
  ];
  const repository = manager.getRepository<CatalogueTorrent>(names.torrent);
  const result: CatalogueTorrent[] = [];
  for (let offset = 0; offset < observations.length; offset += 50) {
    const batch = observations.slice(offset, offset + 50);
    const parameters: unknown[] = [];
    const encodeDate = (value: Date | null | undefined) =>
      value == null
        ? null
        : manager.connection.driver.preparePersistentValue(
            value,
            repository.metadata.findColumnWithPropertyName('lastSeenAt')!
          );
    const values = batch.map((record) => {
      const row = [
        record.trackerId,
        record.canonicalGuid,
        record.infohash ?? null,
        record.releaseName,
        record.size ?? null,
        encodeDate(record.publishedAt),
        record.seeders ?? null,
        record.leechers ?? null,
        encodeDate(record.firstSeenAt),
        encodeDate(record.observedAt),
        record.seeders == null ? null : encodeDate(record.observedAt),
        record.trackerMetadata?.tmdbId ?? null,
        record.trackerMetadata?.tvdbId ?? null,
        record.trackerMetadata?.season ?? null,
        record.trackerMetadata?.episode ?? null,
        record.trackerMetadata
          ? JSON.stringify(
              Object.fromEntries(
                (['tmdbId', 'tvdbId', 'season', 'episode'] as const)
                  .filter((field) => record.trackerMetadata![field] != null)
                  .map((field) => [
                    field,
                    {
                      source: 'tracker',
                      field: record.provenance![field]!.field,
                    },
                  ])
              )
            )
          : null,
        record.trackerMetadata ? encodeDate(record.observedAt) : null,
      ];
      return (
        '(' +
        row
          .map((value) => {
            parameters.push(value);
            return postgres ? '$' + parameters.length : '?';
          })
          .join(',') +
        ')'
      );
    });
    const observedColumns = [
      'release_name',
      'size',
      'published_at',
      'seeders',
      'leechers',
      'last_seen_at',
      'seeders_observed_at',
    ];
    await manager.query(
      `INSERT INTO ${table} AS existing (${columns.map((column) => '"' + column + '"').join(',')}) VALUES ${values.join(',')}
      ON CONFLICT ("tracker_id", "canonical_guid") DO UPDATE SET
      "infohash" = COALESCE(existing."infohash", excluded."infohash"),
      ${['native_tmdb_id', 'native_tvdb_id', 'native_season', 'native_episode', 'native_provenance', 'native_observed_at'].map((column) => `"${column}" = CASE WHEN excluded."native_observed_at" IS NOT NULL AND (existing."native_observed_at" IS NULL OR excluded."native_observed_at" >= existing."native_observed_at") THEN excluded."${column}" ELSE existing."${column}" END`).join(',')},
      ${observedColumns.map((column) => `"${column}" = CASE WHEN excluded."last_seen_at" >= existing."last_seen_at" THEN excluded."${column}" ELSE existing."${column}" END`).join(',')}
      WHERE existing."infohash" IS NULL OR excluded."infohash" IS NULL OR existing."infohash" = excluded."infohash"`,
      parameters
    );
    const stored = await repository.find({
      where: batch.map(({ trackerId, canonicalGuid }) => ({
        trackerId,
        canonicalGuid,
      })),
    });
    const byIdentity = new Map(
      stored.map((row) => [
        JSON.stringify([row.trackerId, row.canonicalGuid]),
        row,
      ])
    );
    const replacements: { torrentId: number; categories: number[] }[] = [];
    for (const record of batch) {
      const row = byIdentity.get(
        JSON.stringify([record.trackerId, record.canonicalGuid])
      )!;
      if (record.infohash && row.infohash !== record.infohash)
        throw new CatalogueIdentityConflictError();
      if (
        record.categories &&
        row.lastSeenAt.getTime() <= record.observedAt.getTime()
      ) {
        replacements.push({
          torrentId: row.id,
          categories: [...new Set(record.categories)],
        });
      }
      result.push(row);
    }
    if (replacements.length) {
      const categories = manager.getRepository<CatalogueCategory>(
        names.category
      );
      // Torrent batches bound the delete to 50 IDs. Bound insert parameters too:
      // even a single torrent can have more categories than a SQLite window.
      await categories.delete({
        torrentId: In(replacements.map((row) => row.torrentId)),
      });
      let associations: { torrentId: number; categoryId: number }[] = [];
      for (const { torrentId, categories: ids } of replacements) {
        for (const categoryId of ids) {
          associations.push({ torrentId, categoryId });
          if (associations.length === 250) {
            await categories.insert(associations);
            associations = [];
          }
        }
      }
      if (associations.length) await categories.insert(associations);
    }
  }
  return result;
}

export async function saveSyncCheckpoint(
  manager: EntityManager,
  checkpoint: SyncCheckpoint
): Promise<void> {
  requireTransaction(manager);
  await manager
    .getRepository<CatalogueSyncState>(names.sync)
    .upsert(checkpoint, ['trackerId', 'categoryId', 'mode']);
}

export interface CollectedPageOptions {
  owner: string;
  clock?: CatalogueClock;
  onIdentityConflicts: (count: number) => SyncCheckpoint;
  afterPersist?: (manager: EntityManager) => Promise<void>;
  beforeCheckpoint?: (
    manager: EntityManager,
    accepted: ObservedTorrent[],
    checkpoint: SyncCheckpoint
  ) => Promise<SyncCheckpoint>;
}

export class CatalogueRepository {
  constructor(private readonly connection: DataSource) {}

  private write<T>(
    operation: (manager: EntityManager) => Promise<T>
  ): Promise<T> {
    return catalogueWrite(this.connection, operation);
  }

  saveTracker(tracker: CatalogueTracker): Promise<void> {
    return this.write(async (manager) => {
      await manager
        .getRepository<CatalogueTracker>(names.tracker)
        .upsert(tracker, ['id']);
    });
  }

  persistPage(
    records: ObservedTorrent[],
    checkpoint: SyncCheckpoint,
    collection?: CollectedPageOptions
  ): Promise<CatalogueTorrent[]> {
    return this.write(async (manager) => {
      if (records.some((record) => record.trackerId !== checkpoint.trackerId))
        throw new Error('Catalogue page must belong to its checkpoint tracker');
      const fence = async () => {
        if (!collection) return;
        const now = new Date(await (collection.clock ?? databaseTime)(manager));
        const result = await manager
          .getRepository<CatalogueSyncState>(names.sync)
          .createQueryBuilder()
          .update()
          .set({ leaseOwner: collection.owner })
          .where(
            'tracker_id = :tracker AND category_id = :category AND mode = :mode AND lease_owner = :owner AND lease_expires_at > :now',
            {
              tracker: checkpoint.trackerId,
              category: checkpoint.categoryId,
              mode: checkpoint.mode,
              owner: collection.owner,
              now,
            }
          )
          .execute();
        if (result.affected !== 1) throw new CatalogueLeaseLostError();
      };
      if (collection)
        await manager
          .getRepository(names.dispatch)
          .update(
            { trackerId: checkpoint.trackerId },
            { trackerId: checkpoint.trackerId }
          );
      await fence();
      if (collection && records.length) {
        // The scope fence is a write before reads on SQLite. Serialize the
        // tracker's page writes on PostgreSQL as well, across categories.
        const existing = await manager
          .getRepository<CatalogueTorrent>(names.torrent)
          .find({
            where: records.map((record) => ({
              trackerId: record.trackerId,
              canonicalGuid: record.canonicalGuid,
            })),
          });
        const hashes = new Map(
          existing.map((row) => [row.canonicalGuid, row.infohash])
        );
        let conflicts = 0;
        records = records.filter((record) => {
          const hash = hashes.get(record.canonicalGuid);
          if (
            hash &&
            record.infohash &&
            hash !== record.infohash.toLowerCase()
          ) {
            conflicts++;
            return false;
          }
          if (record.infohash)
            hashes.set(record.canonicalGuid, record.infohash.toLowerCase());
          return true;
        });
        if (conflicts) checkpoint = collection.onIdentityConflicts(conflicts);
      }
      const torrents = await upsertObservedTorrents(manager, records);
      await collection?.afterPersist?.(manager);
      if (collection?.beforeCheckpoint)
        checkpoint = await collection.beforeCheckpoint(
          manager,
          records,
          checkpoint
        );
      await fence();
      if (collection) {
        // Lease renewal belongs to the coordinator; a page must not overwrite it.
        checkpoint = { ...checkpoint };
        delete checkpoint.leaseOwner;
        delete checkpoint.leaseExpiresAt;
      }
      await saveSyncCheckpoint(manager, checkpoint);
      await fence();
      return torrents;
    });
  }

  saveMediaAssociation(
    association: Omit<CatalogueMediaAssociation, 'id'>
  ): Promise<CatalogueMediaAssociation> {
    return this.write(async (manager) => {
      const repository = manager.getRepository<CatalogueMediaAssociation>(
        names.media
      );
      await repository.upsert(association, [
        'torrentId',
        'mediaType',
        'idNamespace',
        'externalId',
      ]);
      return repository.findOneByOrFail({
        torrentId: association.torrentId,
        mediaType: association.mediaType,
        idNamespace: association.idNamespace,
        externalId: association.externalId,
      });
    });
  }

  replaceCoverage(
    mediaAssociationId: number,
    coverage: Omit<CatalogueCoverage, 'id' | 'mediaAssociationId'>[]
  ): Promise<void> {
    return this.write(async (manager) => {
      const repository = manager.getRepository<CatalogueCoverage>(
        names.coverage
      );
      await repository.delete({ mediaAssociationId });
      if (coverage.length)
        await repository.insert(
          coverage.map((row) => ({ ...row, mediaAssociationId }))
        );
    });
  }

  saveDestinationIndexer(
    indexer: Omit<CatalogueDestinationIndexer, 'id'>
  ): Promise<CatalogueDestinationIndexer> {
    return this.write(async (manager) => {
      const repository = manager.getRepository<CatalogueDestinationIndexer>(
        names.indexer
      );
      await repository.upsert(indexer, ['arrType', 'serverId', 'indexerId']);
      return repository.findOneByOrFail({
        arrType: indexer.arrType,
        serverId: indexer.serverId,
        indexerId: indexer.indexerId,
      });
    });
  }

  saveDestinationTrackerLink(
    link: Omit<CatalogueDestinationTrackerLink, 'id'>
  ): Promise<void> {
    return this.write(async (manager) => {
      await manager
        .getRepository<CatalogueDestinationTrackerLink>(names.link)
        .upsert(link, ['destinationIndexerId', 'trackerId']);
    });
  }

  findTorrent(id: number): Promise<CatalogueTorrent | null> {
    return this.connection
      .getRepository<CatalogueTorrent>(names.torrent)
      .findOneBy({ id });
  }

  findTorrentByGuid(
    trackerId: string,
    canonicalGuid: string
  ): Promise<CatalogueTorrent | null> {
    return this.connection
      .getRepository<CatalogueTorrent>(names.torrent)
      .findOneBy({ trackerId, canonicalGuid });
  }

  findMediaAssociations(
    identity: MediaIdentity
  ): Promise<CatalogueMediaAssociation[]> {
    return this.connection
      .getRepository<CatalogueMediaAssociation>(names.media)
      .find({ where: identity, order: { id: 'ASC' } });
  }

  findCoverage(
    mediaAssociationId: number,
    seasonNumber?: number
  ): Promise<CatalogueCoverage[]> {
    return this.connection
      .getRepository<CatalogueCoverage>(names.coverage)
      .findBy({
        mediaAssociationId,
        ...(seasonNumber === undefined ? {} : { seasonNumber }),
      });
  }

  findSyncState(
    trackerId: string,
    categoryId: number,
    mode: SyncCheckpoint['mode']
  ): Promise<CatalogueSyncState | null> {
    return this.connection
      .getRepository<CatalogueSyncState>(names.sync)
      .findOneBy({ trackerId, categoryId, mode });
  }

  findTrackerTorrents(
    trackerId: string,
    afterId = 0,
    limit = 100
  ): Promise<CatalogueTorrent[]> {
    integer(limit, 1, 1000);
    return this.connection
      .getRepository<CatalogueTorrent>(names.torrent)
      .createQueryBuilder('torrent')
      .where('torrent.trackerId = :trackerId AND torrent.id > :afterId', {
        trackerId,
        afterId,
      })
      .orderBy('torrent.id', 'ASC')
      .take(limit)
      .getMany();
  }
}
