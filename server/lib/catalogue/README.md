# Catalogue storage (PR1)

The catalogue has its own TypeORM connection, entities, foreign keys and
`catalogue_migrations` journal. Schema synchronization is always disabled.
It has no foreign keys to native Seerr tables and registers no native subscribers.

SQLite uses `$CONFIG_DIRECTORY/db/catalogue.sqlite` (default `config/db/catalogue.sqlite`),
with WAL and foreign keys enabled. Native `db.sqlite3` remains separate.
PostgreSQL uses the native `DB_*` connection settings, including socket, SSL
certificates, pool and timeout settings, with explicitly qualified `catalogue`
tables and migration journal. It does not change `search_path`.

## Initialization and migrations

Backend startup initializes the catalogue after native storage and settings.
Initialization creates the PostgreSQL schema before running its journal and
versioned migrations. Concurrent calls share one initialization. On failure,
native startup continues, the internal state is `unavailable` with a safe error
phase, and connection access throws `CatalogueUnavailableError`. This is not an
empty or healthy catalogue. An explicit initialization can retry; PR1 has no
automatic retry scheduler or catalogue API. SIGINT/SIGTERM attempt a bounded
connection shutdown; `shutdownCatalogue()` is also available internally.

Run migrations independently from the repository root, using the same environment
and configuration as the backend:

```sh
devenv --no-tui shell -- env TS_NODE_PROJECT=server/tsconfig.json node -r ts-node/register -r tsconfig-paths/register server/lib/catalogue/migrate.ts
# After pnpm build:server; the runtime discovers only compiled JS migrations:
devenv --no-tui shell -- node dist/lib/catalogue/migrate.js
```

The command returns a nonzero status on initialization/migration failure and closes
its connection. Migration DDL runs in a transaction. Correct the cause before
retrying; never enable synchronization or delete the journal to repair a failure.
SQL/error payload logging is disabled for this connection to avoid disclosing
identifiers or credentials.

PostgreSQL needs `CONNECT` on the database, and `CREATE` on the database for initial
schema creation. If an administrator pre-creates the schema, the runtime/migration
role needs `USAGE, CREATE` on `catalogue` and ownership of its objects (or equivalent
DDL privileges), plus normal table/sequence privileges. Native schema privileges
remain independently required by Seerr. No extension or extra service is needed.

## Persistence contract

`CatalogueRepository.persistPage()` commits observations and their scoped
checkpoint together. The lower-level `upsertObservedTorrents(manager, records)`
and `saveSyncCheckpoint(manager, checkpoint)` require an active shared transaction.
Use the repository's writes for SQLite; they serialize transactions on its single
connection. Callers using explicit manager transactions must serialize those
themselves. Cross-process collection ownership belongs to PR3.

Identity is tracker plus canonical GUID. A contradictory known infohash rejects
the transaction. Incoming missing hashes do not erase a known identity hash.
Unknown observed metadata is NULL; stale observations do not replace newer values.
First observation is preserved on update, and only observed torrents are touched.
Categories are replaced only when supplied for a current observation. Associations
and coverage are explicit caller input; no parsing or completeness is inferred.
Arr snapshots use `(arrType, serverId, indexerId)` and have no compatibility rules.

The GUID boundary rejects credential parameters, URL userinfo, fragments and
unrecognized query parameters. It does not extract tracker IDs or sanitize raw
download URLs. PR2 must supply a non-sensitive stable GUID and must keep credentials,
raw responses and URLs out of all stored text (including checkpoints/provenance).

## Backup, restore, rebuild and conversion

Stop catalogue writers before restore/rebuild. For a consistent SQLite backup,
stop the backend and copy the closed `catalogue.sqlite`, or use SQLite's online
backup API. Do not copy only the main file while WAL writes are active; its WAL
may hold committed data. Back up native storage and settings separately.

For PostgreSQL, a schema-specific logical dump (`pg_dump --schema=catalogue`)
includes catalogue objects/data; retain its journal and sequence values. A whole
database dump includes native and catalogue storage together. Restore catalogue
into a compatible schema with matching ownership/privileges while writers are
stopped, then run its migrations. Test the restored backup before production use.

An explicit rebuild may discard only the catalogue file/schema **and its own
journal**, then initialize and recollect it. Retain settings/credentials and native
Seerr storage. PR1 provides no destructive rebuild command or collector. Absence
of recollected data must not be treated as authoritative negative availability.

The native SQLite-to-PostgreSQL converter rejects targets with custom schemas and
does not transfer this second SQLite file. Leave that protection intact: migrate
native Seerr first into an eligible empty PostgreSQL target, then initialize the
catalogue separately. Restore an engine-compatible catalogue backup, or rebuild
and recollect later. A SQLite catalogue file is not a PostgreSQL restore input.

## Focused validation

```sh
devenv --no-tui shell -- pnpm test server/lib/catalogue/catalogue.test.ts
```

SQLite uses temporary files and real native migrations. PostgreSQL uses the native
migration-test disposable-instance contract: `SEERR_MIGRATION_PG_DISPOSABLE=true`,
`SEERR_MIGRATION_PG_PORT`, and `SEERR_MIGRATION_PG_PASSWORD`; fixed local host, role
`seerr_migration_test`, empty control database `seerr_migration_control`, and no
other non-template databases except `postgres`. The role must create/drop test
databases. Only a randomly named database created by the test is dropped; supplied
databases are never reset. Run this file and the native migration file separately
against that dedicated instance. Never use application `DB_*` credentials for tests.

Without this explicitly provisioned instance the PostgreSQL test is skipped with
a blocker message (required in CI). **PR1 cannot be closed until the real
PostgreSQL test passes.** Configuration checks are not PostgreSQL execution proof.
