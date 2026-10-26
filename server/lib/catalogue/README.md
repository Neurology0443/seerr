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
The two jobs trigger logical `movie`/`tv` work; each tracker resolves these through
its configured category IDs (TR4KER uses `2000`/`5000`). Unsupported mappings are
not enqueued. An enqueue failure for one tracker does not discard another's work.
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

Lease acquisition and cycle preparation do not consume quota. The final SQL
reservation follows durable preparation and is immediately followed by the adapter
invocation, with no intervening asynchronous SQL. A pending Recent preparation
retains priority; a request already dispatched cannot reuse its permit. Distinct
trackers each have one bounded local operation and progress independently. Shutdown
stops new dispatch and drains all tracked operations within the existing bound.

Recent cycles start at zero, stop only at a corroborated known boundary across two
successive overlapping pages, and have a configurable page bound (2–1000). Their
first run is partial. Partial Recent ranges must be revisited before a later cycle
can report an observed window. Historical defects on advanced pages keep the pass
partial through its terminal boundary; the diagnostic repair contract below
determines which subsequent evidence can repair them. A failed request or wholly unusable page leaves its offset pending.
Successful reprocessing at that offset can finish the current pass as observed,
provided no other coverage defect remains, including after restart during backoff.
Progress, coverage and bounded safe diagnostics are separate durable state. Neither
restart nor explicit error recovery clears incomplete evidence or deletes torrents.

Continuity uses the intersection and relative order of GUIDs near the old page's
tail and the new page's head. Small overlap variations (including 19 or 21 for the
20-record overlap) are accepted; missing continuity, reordering and repeated pages
remain uncertain. Diagnostics alone do not set coverage: malformed optional native
metadata is observable without invalidating reliable observation coverage. Critical
rejections remain partial through terminal confirmation until clean reprocessing.

The runtime supplies explicit tracker identity, category mappings and pagination;
TR4KER retains 100/20 and step 80. Checkpoint version 2 records pagination parameters.
Version 1's frozen 100/20 continuity is upgraded without losing its offset. Changing
pagination on an incomplete pass restarts that pass at zero, retaining torrent rows
and partial coverage while the affected range is reprocessed. No SQL schema or
settings-format migration is required.

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
Nonempty pages with no usable records, including records all quarantined against
stored identities, use bounded scope retries without advancing page progress or
success timestamps. They cancel pending terminal-empty evidence and cannot confirm
the end of history. Partially accepted pages retain valid records and partial
coverage. Recent interruption safeguards remain conservative across cycles.

The internal operational recovery hook is `CollectionStore.recover('tr4ker')`, or
`recover('tr4ker', 2000, 'historical')` for a scoped contract suspension. Invoke it
against the configured catalogue after correcting credentials/configuration, with
writers stopped. It retains checkpoints, partial coverage and diagnostics, resets
failure counters, and never reserves future request slots or starts a network call.
Use `initializeCatalogue()` / `getCatalogueConnection()` for that connection and
close it with `shutdownCatalogue()`. Merely restarting or replacing the key does
not acknowledge a suspension. P4 can later expose this hook through administration.

Native TMDB/TVDB IDs remain separate nullable tracker claims on each torrent, with
season/episode, bounded per-field tracker provenance and `nativeObservedAt`.
Provenance accepts symbolic protocol-independent field paths; adapters interpret
the exact names. Persistence requires source `tracker` for native claims and rejects
malformed structures, credential fields, URLs and raw payloads. Existing TR4KER
Torznab paths persist unchanged; absent optional claims need no provenance.
A newer observation can clear an absent claim to NULL; an older replay cannot
replace newer claims. No media associations or inferred season coverage are made.
The default P1 persistence path still rejects identity conflicts transactionally;
collector writes quarantine conflicting records, keep valid records and retain a
safe scoped diagnostic and partial coverage in that transaction.

## Release diagnostics and Historical repair (CAT-012/CAT-013)

The additive `ReleaseDiagnostics1792972800000` migration creates the isolated
`release_diagnostics` table on SQLite and PostgreSQL. Page observations, diagnostics,
repair transitions and checkpoints commit in the existing fenced page transaction.
The bounded aggregate diagnostics remain available in collection state.

Release entries retain tracker/category/mode, field/code/precise reason, first/last
rejection, occurrences, safe identity, optional page context and repair status.
`releaseKey` identifies a safely identifiable release independently of its rejection
reason; distinct-release counts must count distinct non-null release keys, not
diagnostic rows or occurrences. Unidentifiable sightings retain separate rows with
null release keys. Neither offsets nor item positions establish identity.

The adapter independently checks diagnostic GUIDs, hashes and titles. A complete
safe rejected GUID can be retained without becoming an accepted torrent identity.
Unsafe identifiers are represented by HMAC-SHA256; production TR4KER uses its
configured authentication key as the HMAC key without persisting it. Fingerprints
survive normal restarts; credential rotation conservatively leaves earlier opaque
diagnostics unresolved. Titles are checked before truncation to 256 characters;
known secrets, request/download URLs, encoded unsafe values and XML are withheld.

Storage is bounded to 5,000 release diagnostics and 5,000 collection incidents per
tracker/category/mode, plus one aggregate lost-evidence marker. Resolved history
expires 30 days after resolution. Active episode rows are protected from capacity eviction.
Capacity eviction prefers resolved history. Evicting unresolved critical evidence
creates a quarantined scope marker that permanently retains its coverage uncertainty;
it cannot silently turn missing diagnostic history into proof of complete coverage.
Neither evicted evidence nor a reappearing release diagnostic creates a repair job.

For Historical, `dirty` means an actionable pending-page incident remains
`unresolved`. Source-data rejections are immediately `quarantined`, with outcome
`source_data_unrepairable`, no retry date and no new repair attempts. They still
affect coverage; quarantine does not mean the release was repaired or absent.
`coverage` independently stays `partial` while the pass is unfinished, a critical
release/scope is unresolved or quarantined, or the current scan is unreliable.
Reaching terminal pages is a technical scan completion, not a resolution event.
A release resolves only on a later accepted observation of the same safe GUID,
with the affected field validated and no corresponding rejection. Matching a
different GUID by hash, or failing to find the old release, never resolves it.
Such evidence comes from normal collection or explicitly configured maintenance;
an individual rejected release never schedules another API request or full scan.
Pagination warnings (`abnormal_overlap`, filtered overlap, changed pagination and
invalid checkpoint context) do not prove an actionable, bounded collection gap.
They remain quarantined coverage uncertainty, without dedicated requests or scans.
A later clean traversal does not silently resolve unrelated continuity incidents.

Recoverable failures retry the pending page, with the existing configured failure
limit, exponential backoff, Retry-After, leases, quota and suspension. Repeated-page
incidents record that page's retry state and resolve only when its pending response
has valid continuity, or its emptiness is confirmed by the normal terminal policy.
A usable but uncertain recovery retains quarantine; exhaustion is never coverage
evidence. No currently recorded warning justifies a separate full Historical pass.
Only an explicitly configured maintenance interval starts another normal traversal.
`dirty=false, coverage=partial` is a valid durable terminal state.

Collection incidents use opaque episode keys persisted in the checkpoint, within
tracker/category/mode. Consecutive same-reason observations share that episode even
as offsets move. Healthy continuity ends overlap episodes; advancing a pending
page ends its retry episode. A new ordinary cycle also separates episodes; a later incident gets a fresh key and independent retry history.
These are observation boundaries, not inferred release identities or missing ranges.
Quarantined episodes remain visible without rearming their budget. Resolution is
limited to the active repeated-page incident; other history is left untouched.
Active keys are bounded, and persistence looks up only those keys, not all incidents.

Repair-state version 3 retires persisted full-scan obligations, preserving old
identities, counters, quarantines and coverage uncertainty. In-progress obsolete
rescans stop before another request, retaining their offset without inventing
terminal-empty evidence. Ordinary unfinished traversals keep their checkpoints;
request and unusable-page retries retain their existing bounded recovery behavior.

Diagnostic reads, aggregates, retention, repair eligibility and counters are scoped
by tracker/category/mode. Recent never schedules Historical repairs, or conversely.
An explicit resolution query may match a validated GUID and field across modes;
it changes only that diagnosis, leaving the other mode's checkpoint and scheduling
state untouched. Unknown optional fields are insufficient resolution evidence.

`DiagnosticScopeIndex1792972800001` adds a scope/state index on both engines.
Page diagnostics are deduplicated in memory, looked up in batches of 100 and
upserted in batches of 20. Resolution queries select only observed GUIDs, coverage
uses SQL aggregates and capacity cleanup loads only rows being evicted. No page
loads the full category diagnostic history or issues one query per release.
No diagnostic API, administration UI or new collection engine is introduced.
