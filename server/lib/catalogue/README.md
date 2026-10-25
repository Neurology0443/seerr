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

Backend startup starts catalogue initialization independently after native storage
and settings; it does not await its connection or migrations.
Initialization creates the PostgreSQL schema before running its journal and
versioned migrations. Concurrent calls share one initialization. On failure,
native startup continues, the internal state is `unavailable` with a safe error
phase, an allowlisted driver error code when available and a static safe diagnostic.
Connection access throws `CatalogueUnavailableError` until ready. This is not an
empty or healthy catalogue. An explicit initialization can retry; PR1 has no
automatic retry scheduler or catalogue API. SIGINT/SIGTERM attempt a bounded
connection shutdown; `shutdownCatalogue()` is also available internally. Shutdown
prevents new initialization and waits for any pending attempt before closing its
connection; a closed lifecycle cannot reopen itself. Failure diagnostics survive
cleanup. Explicit retries apply only before shutdown.

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

PostgreSQL needs `CONNECT` on the database. Initialization checks the PostgreSQL
catalogue for the schema without requiring elevated privileges. Automatic creation
of an absent `catalogue` schema requires database-level `CREATE`.

If an administrator pre-creates `catalogue`, database-level `CREATE` is not needed.
The runtime/migration role needs `USAGE, CREATE` within that schema to create the
migration journal, tables and sequences. DDL migrations on existing objects require
ownership of those objects (or membership in their owning role), alongside normal
table/sequence privileges for data access. Schema ownership itself is not required
when its owner grants the necessary schema privileges. Insufficient permissions
remain initialization failures; the application never grants privileges itself.
Native schema privileges remain independently required by Seerr.

## Persistence contract

`CatalogueRepository.persistPage()` commits observations and their scoped
checkpoint together. The lower-level `upsertObservedTorrents(manager, records)`
and `saveSyncCheckpoint(manager, checkpoint)` require an active shared transaction.
Use the repository's writes for SQLite; they serialize transactions on its single
connection. Callers using explicit manager transactions must serialize those
themselves. P3 collection ownership uses the SQL leases described below.

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
Seerr storage. No destructive rebuild command is provided. Absence
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

## P3 collection configuration and recovery

Collection is opt-in. Set the **process environment variable `TR4KER_KEY`** on each
Seerr instance; this is the sole API-key source. The key is never written to
catalogue SQL, settings or diagnostics. The endpoint remains the P2 TR4KER contract.
Configure non-secret options in `settings.json`:

```json
{
  "catalogue": {
    "tr4ker": {
      "enabled": true,
      "recentPageLimit": 10,
      "maintenanceIntervalMinutes": null,
      "globalSpacingSeconds": 3,
      "maintenanceSpacingSeconds": 6,
      "initialBackoffSeconds": 30,
      "maxBackoffSeconds": 900,
      "failureLimit": 5
    }
  },
  "jobs": {
    "catalogue-recent-movies": { "schedule": "0 */15 * * * *" },
    "catalogue-recent-tv": { "schedule": "10 */15 * * * *" }
  }
}
```

Merge these keys into existing settings. Existing installations receive disabled
collection defaults and both jobs through settings migration `0010`. Recent cadence
uses the existing native jobs settings (six-field cron), with movies and TV ten
seconds apart by default. Keep their starts staggered when changing schedules.
Collection options require restart; native job schedule edits retain their existing
behavior. All instances sharing a catalogue must use the same tracker settings.
Missing credentials or invalid configuration leave collection disabled while native
Seerr continues. Catalogue initialization and migrations remain independent of HTTP
startup. No capabilities probe or live validation crawl is performed.

Historical starts automatically once storage and configuration are ready. Pages
are 100 records with 20 overlap and an 80-position step. It resumes committed
progress after restart. A terminal boundary needs an empty read, a second empty
read at that offset, then an empty read at the subsequent offset. `total` is ignored.
This records an observed boundary, without promising exhaustive tracker coverage.

Maintenance has **no default recurrence**. Set `maintenanceIntervalMinutes` to a
positive integer (at most 525600) to activate it; `null` disables new maintenance
work. Each subsequent pass begins at zero after the preceding pass finishes and
its configured interval elapses. An interrupted pass keeps its own offset. The
tracker shares a SQL request-start budget across all categories and instances:
minimum three seconds globally (at most 20 starts per half-open minute), and six
seconds between maintenance starts (at most 10). Larger spacing values are allowed;
smaller values are rejected. Recent has dispatch priority. Idle time adds no capacity.

Recent cycles start at zero, stop only at a corroborated known boundary across two
successive overlapping pages, and have a configurable page bound (2–1000). Their
first run is partial. Partial Recent ranges must be revisited before a later cycle
can report an observed window. Historical anomalies keep the pass partial through
its terminal boundary; a subsequent clean full pass can repair that evidence.
Progress, coverage and bounded safe diagnostics are separate durable state. Neither
restart nor explicit error recovery clears incomplete evidence or deletes torrents.

Each scope has an opaque SQL lease, lasting 60 seconds, with renewal every 20 seconds
bounded to a two-minute operation. Page commits check ownership inside the same
transaction as observations, allowlisted native metadata and checkpoints. Late former
owners cannot commit after expiration/takeover. A lost or interrupted request replays
from the last commit. Shutdown stops new dispatch; abandoned ownership expires.

Transient failures back off exponentially from 30 seconds to 15 minutes by default;
valid future `Retry-After` seconds/dates take precedence even beyond that cap. Five
consecutive transient tracker failures suspend that tracker; authentication errors
suspend immediately. Systematic contract errors suspend only the affected scope.
Compatible page success resets failure counters. Backoff expiry permits automatic
retry; suspension requires correction and explicit recovery. PR3 adds no admin UI.

The internal operational recovery hook is `CollectionStore.recover('tr4ker')`, or
`recover('tr4ker', 2000, 'historical')` for a scoped contract suspension. Invoke it
against the configured catalogue after correcting credentials/configuration, with
writers stopped. It retains checkpoints, partial coverage and diagnostics, resets
failure counters, and never reserves future request slots or starts a network call.
Use `initializeCatalogue()` / `getCatalogueConnection()` for that connection and
close it with `shutdownCatalogue()`. Merely restarting or replacing the key does
not acknowledge a suspension. P4 can later expose this hook through administration.

Native TMDB/TVDB IDs remain separate nullable tracker claims on each torrent, with
season/episode, allowlisted per-field Torznab provenance and `nativeObservedAt`.
A newer observation can clear an absent claim to NULL; an older replay cannot
replace newer claims. No media associations or inferred season coverage are made.
The default P1 persistence path still rejects identity conflicts transactionally;
collector writes quarantine conflicting records, keep valid records and retain a
safe scoped diagnostic and partial coverage in that transaction.
