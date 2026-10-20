---
title: Offline SQLite to PostgreSQL migration
description: Transfer a fully upgraded Seerr-multi installation to an empty PostgreSQL database.
---

# Offline SQLite to PostgreSQL migration

This standalone, one-way CLI transfers application data using the current
Seerr-multi build. It does not change application settings or start Seerr.
Use the same build for the source upgrade, migration command, and new deployment.

## Operator procedure

1. Fully upgrade the SQLite installation using this Seerr-multi build, then stop
   **every Seerr process**. Keep Seerr stopped throughout migration and validation.
2. Back up the **complete configuration directory**, including `settings.json`,
   secrets, credentials, client identifiers, certificates, and other files. Keep
   the original installation and backups available for recovery.
3. Create a consistent, standalone SQLite backup. For example, use SQLite's
   `.backup` command against the stopped installation:

   ```sh
   sqlite3 /original-config/db/db.sqlite3 ".backup '/backup/seerr.sqlite3'"
   ```

   Copy the matching `settings.json` to `/backup/settings.json`. Supply the backup
   paths to the CLI. The SQLite file must be a standalone backup, not a symbolic
   link, a hard link, or a live database. WAL/SHM/journal sidecars at the resolved
   database location cause rejection; never ignore or remove them to bypass
   validation. Arbitrary copies of an active database are unsupported. This tool
   never checkpoints or repairs a database. It opens the standalone backup
   read-only with SQLite's immutable flag. Hard-link detection checks the current
   filesystem link count; it cannot establish a file's provenance, detect a former
   alias whose other name was removed, or prove that no live writer exists. Create
   an independent consistent backup and keep its files unchanged during migration.
4. Provision an **existing, empty staging PostgreSQL database**, using PostgreSQL
   16 as tested in CI. Supply connection details explicitly; the CLI creates no
   database and does not drop or overwrite an existing database. The supplied role
   needs permission to run the application's migrations in `public`.
5. In the repository checkout, set the following environment variables securely:

   ```text
   DB_TYPE=postgres
   DB_HOST=<explicit PostgreSQL hostname>
   DB_PORT=<explicit PostgreSQL port>
   DB_USER=<migration role>
   DB_PASS=<password>
   DB_NAME=<empty staging database>
   ```

   An absolute `DB_SOCKET_PATH` can replace `DB_HOST`/`DB_PORT`. SSL uses the existing
   `DB_USE_SSL` and `DB_SSL_REJECT_UNAUTHORIZED` variables and `DB_SSL_CA`,
   `DB_SSL_KEY`, `DB_SSL_CERT` (or their `_FILE` alternatives). No application
   database name or test datasource is selected by default.
6. Run the CLI through the repository toolchain:

   ```sh
   devenv shell -- pnpm migration:sqlite-to-postgres --sqlite /backup/seerr.sqlite3 --settings /backup/settings.json
   ```

   Review the exit status and per-table counts. Exit `0` means all application
   rows, primary keys, converted values, foreign keys, uniqueness constraints,
   sequence positions, migration history, and source file hashes passed checks.
   Complete data verification repeats using a fresh PostgreSQL connection.
   Reports omit credentials, session data, and sensitive row values.
7. Only after success, configure the new deployment to use PostgreSQL explicitly
   and restore the **complete backed-up configuration directory**. Preserve
   `settings.json`, durable `dvrIdCounters`, settings migration history, credentials,
   and secrets exactly. The CLI does not switch `DB_TYPE` or rewrite any files.
8. Start the same Seerr-multi build against PostgreSQL, then check the installation
   and its integrations before normal use. Keep the original backups.

## Supported schema and representations

The SQLite migration journal must exactly match the SQLite migrations shipped
with the executing build (currently through
`AddMediaDestinationTables1791000000000`). Table columns, defaults, primary keys,
indexes, and foreign keys must match a reference schema created using those real
migrations. Unknown application tables, views, triggers, and unsupported schema
differences cause rejection. Older databases must be upgraded by Seerr before
backing them up. Settings must contain existing secrets, both DVR arrays, durable
nonnegative safe-integer DVR counters, and the persisted settings migration IDs
`0007_migrate_arr_tags`, `0008_migrate_blacklist_to_blocklist`, and
`0009_add_independent_request_destination`.

The transfer includes every column and row of these tables:

```text
user                       user_settings
user_push_subscription     media
season                     media_request
season_request             media_destination
media_destination_season   watchlist
blocklist                  issue
issue_comment              override_rule
discover_slider            session
```

- SQLite booleans must be integer `0` or `1`; nullable booleans retain `NULL`.
- Integers travel as decimal text, avoiding JavaScript numeric rounding. Values
  must fit the real PostgreSQL integer/bigint columns, including `session.expiredAt`.
- Datetimes accept `YYYY-MM-DD HH:mm:ss` or the `T` separator, optional fractional
  seconds up to six digits, and optional `Z`/`±HH:mm` offsets. Missing offsets mean
  **UTC**. Fractions retain microsecond precision. PostgreSQL timezone-aware
  columns receive UTC instants; `session.destroyedAt` receives UTC wall-clock text
  in its native timestamp-without-time-zone column. Nullable dates retain `NULL`.
- Serialized text is preserved as text without JSON parsing or normalization.
  Invalid UTF-8, embedded NUL, oversized bounded strings, unsupported timestamp
  precision, and out-of-range or incompatible values cause rejection.
- Generated sequences use the greater of remaining row IDs and SQLite's
  AUTOINCREMENT high-water mark. Empty tables retain consumed IDs. Exhausted
  PostgreSQL integer ID ranges cause rejection. DVR server identity allocation
  stays separate and uses the unchanged settings and historical database values.

## Failure and recovery

Source integrity, configuration, schema, and field validation happen before any
PostgreSQL schema changes. A non-empty target is rejected, including custom
schemas, tables, views, sequences, types, functions, and non-default extensions.
The CLI only loads real migrations; no application entities, subscribers, jobs,
notifications, or Arr clients are loaded. Constraints stay enabled.

Schema creation and data import are separate. Data inserts use one transaction,
with bounded batches in foreign-key order. Import or in-transaction verification
failures roll back application rows. Once import commits, a verification failure
returns failure and marks the staging database as invalid and unsuitable for
activation. Committed data, including any writes from another client, remains
untouched for diagnosis or manual disposal. There is no compensating deletion or
rollback simulation. Schema and migration history remain, so the target is rejected
on retry. The operator must discard the failed staging database manually; the
untouched original SQLite backup remains the recovery source.
**Never activate an unsuccessful or interrupted staging target.** Have the operator
discard it and provision a fresh empty database for the next attempt. No automatic
drop, truncate, constraint suppression, or schema repair is performed.

The SQLite source and `settings.json` are never written; their hashes must remain
unchanged before success. This tool cannot prove that two independently supplied
backups came from the same installation; preserving a consistent database and
configuration pair and keeping the application offline are operator responsibilities.

To recover, stop the PostgreSQL deployment and restore the original complete
configuration backup and consistent SQLite backup into the original SQLite
installation. Restore its original SQLite connection configuration and restart
the same build. This recovery does not transfer changes subsequently made in
PostgreSQL back to SQLite. There is no reverse migration or live synchronization.

## Focused integration tests

The dedicated test suite uses real SQLite and PostgreSQL migrations and the same
disposable PostgreSQL protections as the existing migration tests. Use a newly
provisioned disposable cluster with role `seerr_migration_test` and an empty
`seerr_migration_control` database; the only non-template databases may be
`postgres` and `seerr_migration_control`. The suite creates and drops only its own
randomly named databases. Never supply production or persistent shared databases.

```sh
SEERR_TRANSFER_PG_DISPOSABLE=true \
SEERR_TRANSFER_PG_PORT=<disposable-port> \
SEERR_TRANSFER_PG_PASSWORD=<disposable-password> \
  devenv shell -- pnpm test server/test/sqliteToPostgresMigration.test.ts
```

Any `SEERR_TRANSFER_PG_*` configuration makes PostgreSQL execution mandatory:
incomplete configuration fails rather than skipping. CI runs this separately
from the other PostgreSQL suites against its existing PostgreSQL 16 service.
