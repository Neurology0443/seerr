/** Offline data transfer. Deliberately never imports the application datasource. */
import type { AllSettings } from '@server/lib/settings';
import { createHash } from 'node:crypto';
import { constants, createReadStream, readFileSync } from 'node:fs';
import { access, lstat, readFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import type { TlsOptions } from 'node:tls';
import { pathToFileURL } from 'node:url';
import sqlite3 from 'sqlite3';
import type { QueryRunner, Table } from 'typeorm';
import { DataSource } from 'typeorm';

export const applicationTables = [
  'user',
  'user_settings',
  'user_push_subscription',
  'media',
  'season',
  'media_request',
  'season_request',
  'media_destination',
  'media_destination_season',
  'watchlist',
  'blocklist',
  'issue',
  'issue_comment',
  'override_rule',
  'discover_slider',
  'session',
] as const;

const quote = (name: string) => `"${name.replaceAll('"', '""')}"`;
const qualified = (name: string) => `public.${quote(name)}`;
const batchSize = 200;
type Row = Record<string, string | null>;
type ReadSqlite = (sql: string, params?: unknown[]) => Promise<Row[]>;
type PgOptions = Extract<
  ConstructorParameters<typeof DataSource>[0],
  { type: 'postgres' }
>;
type SourceColumn = {
  name: string;
  type: string;
  notnull: number;
  pk: number;
  dflt_value: string | null;
};
type Column = SourceColumn & {
  kind: 'integer' | 'bigint' | 'boolean' | 'text' | 'timestamp';
  length?: number;
};
type Plan = {
  name: string;
  columns: Column[];
  highWater: string;
  generated: boolean;
};

export class MigrationError extends Error {}
function requireCondition(
  condition: unknown,
  message: string
): asserts condition {
  if (!condition) throw new MigrationError(message);
}

/** DB_* follows datasource.ts, but every connection identity is mandatory. */
export function postgresOptionsFromEnv(
  env: Partial<NodeJS.ProcessEnv> = process.env
): PgOptions {
  for (const key of ['DB_USER', 'DB_PASS', 'DB_NAME']) {
    requireCondition(env[key], `${key} must be explicitly supplied.`);
  }
  requireCondition(
    env.DB_HOST || env.DB_SOCKET_PATH,
    'DB_HOST or DB_SOCKET_PATH must be explicitly supplied.'
  );
  requireCondition(env.DB_TYPE === 'postgres', 'DB_TYPE must be postgres.');
  const port = Number(env.DB_PORT);
  requireCondition(
    env.DB_SOCKET_PATH ||
      (/^\d+$/.test(env.DB_PORT ?? '') &&
        Number.isInteger(port) &&
        port > 0 &&
        port <= 65535),
    'DB_PORT must be explicitly supplied and valid.'
  );
  const material = (key: string) =>
    env[key] ??
    (env[`${key}_FILE`] ? readFileSync(env[`${key}_FILE`]!) : undefined);
  const ssl: TlsOptions | undefined =
    env.DB_USE_SSL?.toLowerCase() === 'true'
      ? {
          rejectUnauthorized:
            env.DB_SSL_REJECT_UNAUTHORIZED?.toLowerCase() !== 'false',
          ca: material('DB_SSL_CA'),
          key: material('DB_SSL_KEY'),
          cert: material('DB_SSL_CERT'),
        }
      : undefined;
  return {
    type: 'postgres',
    host: env.DB_SOCKET_PATH || env.DB_HOST,
    port: env.DB_SOCKET_PATH ? undefined : port,
    username: env.DB_USER,
    password: env.DB_PASS,
    database: env.DB_NAME,
    ssl,
    connectTimeoutMS: 30000,
  };
}

function pgSource(options: PgOptions) {
  // Whitelist connection properties; caller options can never enable lifecycle code.
  return new DataSource({
    type: 'postgres',
    host: options.host,
    port: options.port,
    username: options.username,
    password: options.password,
    database: options.database,
    ssl: options.ssl,
    connectTimeoutMS: options.connectTimeoutMS ?? 30000,
    poolSize: 2,
    entities: [],
    subscribers: [],
    logging: false,
    synchronize: false,
    dropSchema: false,
    migrationsRun: false,
    migrations: [
      path.join(
        __dirname,
        '../migration/postgres/*' + path.extname(__filename)
      ),
    ],
  });
}

async function fileHash(file: string) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}
async function regularFile(file: string, label: string) {
  requireCondition(
    (await stat(file)).isFile(),
    `${label} must be a regular readable file.`
  );
  await access(file, constants.R_OK);
}
async function standaloneBackupPath(file: string) {
  const supplied = await lstat(file);
  requireCondition(
    !supplied.isSymbolicLink(),
    'SQLite backup must not be a symbolic link.'
  );
  requireCondition(
    supplied.isFile(),
    'SQLite backup must be a regular readable file.'
  );
  requireCondition(
    supplied.nlink === 1,
    'SQLite backup must not have multiple hard links; supply an independent standalone backup.'
  );
  const resolved = await realpath(file);
  const actual = await lstat(resolved);
  requireCondition(
    actual.isFile() &&
      !actual.isSymbolicLink() &&
      actual.nlink === 1 &&
      actual.dev === supplied.dev &&
      actual.ino === supplied.ino,
    'SQLite source changed during path validation or is not an independent standalone backup.'
  );
  await access(resolved, constants.R_OK);
  for (const suffix of ['-wal', '-shm', '-journal']) {
    const exists = await lstat(resolved + suffix).then(
      () => true,
      (error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return false;
        throw error;
      }
    );
    requireCondition(
      !exists,
      'SQLite backup has a journal/WAL sidecar; supply a standalone consistent offline backup.'
    );
  }
  return resolved;
}
async function openBackup(file: string) {
  // Recheck immediately before opening; never use an unresolved source alias.
  const resolved = await standaloneBackupPath(file);
  const uri = pathToFileURL(resolved);
  uri.searchParams.set('immutable', '1');
  const db = await new Promise<sqlite3.Database>((resolve, reject) => {
    const connection: sqlite3.Database = new sqlite3.Database(
      uri.href,
      sqlite3.OPEN_READONLY | sqlite3.OPEN_URI,
      (error) => (error ? reject(error) : resolve(connection))
    );
  });
  const read: ReadSqlite = (sql, params = []) =>
    new Promise((resolve, reject) =>
      db.all(sql, params, (error, rows) =>
        error ? reject(error) : resolve(rows as Row[])
      )
    );
  return {
    read,
    close: () =>
      new Promise<void>((resolve, reject) =>
        db.close((error) => (error ? reject(error) : resolve()))
      ),
  };
}

async function settingsFromBackup(file: string): Promise<AllSettings> {
  await regularFile(file, 'settings.json');
  const settings: AllSettings = JSON.parse(await readFile(file, 'utf8'));
  requireCondition(
    settings && typeof settings === 'object',
    'Invalid settings.json object.'
  );
  for (const key of [
    'clientId',
    'sessionSecret',
    'vapidPublic',
    'vapidPrivate',
  ] as const) {
    requireCondition(
      typeof settings[key] === 'string' && settings[key]!.length > 0,
      `settings.json requires persisted ${key}.`
    );
  }
  requireCondition(
    typeof settings.main?.apiKey === 'string' &&
      settings.main.apiKey.length > 0,
    'settings.json requires a persisted main.apiKey.'
  );
  requireCondition(
    Array.isArray(settings.migrations) &&
      settings.migrations.every((value) => typeof value === 'string'),
    'Invalid settings migration history.'
  );
  // Never execute settings migrator/load(): even raw loading may generate secrets.
  const settingsMigrations = [
    '0007_migrate_arr_tags',
    '0008_migrate_blacklist_to_blocklist',
    '0009_add_independent_request_destination',
  ];
  requireCondition(
    settingsMigrations.every((name) => settings.migrations.includes(name)),
    'Settings migrations are incomplete; upgrade with this Seerr-multi build before taking backups.'
  );
  for (const kind of ['radarr', 'sonarr'] as const) {
    requireCondition(
      Array.isArray(settings[kind]),
      `settings.json requires ${kind} configuration.`
    );
    const counter = settings.dvrIdCounters?.[kind];
    requireCondition(
      Number.isSafeInteger(counter) && counter >= 0,
      `settings.json requires a valid durable dvrIdCounters.${kind}.`
    );
    const ids = new Set<number>();
    for (const server of settings[kind]) {
      requireCondition(
        server &&
          Number.isSafeInteger(server.id) &&
          server.id >= 0 &&
          !ids.has(server.id),
        `Invalid ${kind} identity or durable counter.`
      );
      ids.add(server.id);
      requireCondition(
        ['name', 'hostname', 'apiKey', 'activeDirectory'].every(
          (key) => typeof server[key as keyof typeof server] === 'string'
        ) &&
          server.apiKey.length > 0 &&
          server.hostname.length > 0,
        `Invalid persisted ${kind} connection settings.`
      );
      requireCondition(
        Number.isInteger(server.port) &&
          server.port > 0 &&
          server.port <= 65535,
        `Invalid persisted ${kind} port.`
      );
      requireCondition(
        [
          'useSsl',
          'is4k',
          'isDefault',
          'syncEnabled',
          'independentRequestDestination',
        ].every(
          (key) => typeof server[key as keyof typeof server] === 'boolean'
        ) &&
          (!server.independentRequestDestination || server.syncEnabled),
        `Invalid persisted ${kind} destination flags.`
      );
    }
  }
  return settings;
}

async function sqliteSchema(read: ReadSqlite) {
  const objects = await read(
    `SELECT type, name, tbl_name, sql FROM sqlite_master WHERE substr(name, 1, 7) <> 'sqlite_' ORDER BY type, name`
  );
  const tables = objects
    .filter((item) => item.type === 'table')
    .map((item) => item.name!);
  requireCondition(
    objects.every((item) => item.type === 'table' || item.type === 'index'),
    'Unsupported SQLite views or triggers.'
  );
  return Promise.all(
    tables.map(async (name) => ({
      name,
      columns: await read(`PRAGMA table_xinfo(${quote(name)})`),
      foreignKeys: await read(`PRAGMA foreign_key_list(${quote(name)})`),
      indices: await Promise.all(
        (await read(`PRAGMA index_list(${quote(name)})`))
          .sort((a, b) => a.name!.localeCompare(b.name!))
          .map(async (index) => ({
            name: index.name,
            unique: index.unique,
            origin: index.origin,
            partial: index.partial,
            columns: await read(`PRAGMA index_xinfo(${quote(index.name!)})`),
          }))
      ),
      autoincrement: /\bAUTOINCREMENT\b/i.test(
        objects.find((item) => item.name === name)?.sql ?? ''
      ),
    }))
  );
}

function columnPlan(column: SourceColumn, table: string): Column {
  const type = column.type.toLowerCase();
  let kind: Column['kind'];
  if (type === 'integer') kind = 'integer';
  else if (type === 'bigint') kind = 'bigint';
  else if (type === 'boolean') kind = 'boolean';
  else if (type === 'datetime') kind = 'timestamp';
  else if (/^(varchar|text)(\(\d+\))?$/.test(type)) kind = 'text';
  else throw new MigrationError(`Unsupported type at ${table}.${column.name}.`);
  const length = type.match(/\((\d+)\)/)?.[1];
  return { ...column, kind, length: length ? Number(length) : undefined };
}

/** Keep microseconds as text; Date is used only for UTC calendar/offset arithmetic. */
export function utcTimestamp(value: string): string {
  const match =
    /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})(?:\.(\d{1,6}))?(Z|[+-]\d{2}:\d{2})?$/.exec(
      value
    );
  requireCondition(match, 'Unsupported timestamp format or precision.');
  const [, day, time, fraction = '', zone = 'Z'] = match;
  const wall = `${day}T${time}`;
  const calendar = new Date(`${wall}Z`);
  requireCondition(
    Number.isFinite(calendar.getTime()) &&
      calendar.toISOString().slice(0, 19) === wall &&
      Number(day.slice(0, 4)) >= 1,
    'Invalid UTC timestamp.'
  );
  if (zone !== 'Z')
    requireCondition(
      Number(zone.slice(1, 3)) <= 23 && Number(zone.slice(4)) <= 59,
      'Invalid timestamp offset.'
    );
  const date = new Date(`${wall}${zone}`);
  requireCondition(
    Number.isFinite(date.getTime()) &&
      date.getUTCFullYear() >= 1 &&
      date.getUTCFullYear() <= 9999,
    'Timestamp outside supported range.'
  );
  return `${date.toISOString().slice(0, 19).replace('T', ' ')}.${fraction.padEnd(6, '0')}`;
}

function convert(row: Row, plan: Plan): Row {
  return Object.fromEntries(
    plan.columns.map((column, index) => {
      const value = row[column.name];
      const storage = row[`__storage${index}`];
      try {
        if (value === null) {
          requireCondition(!column.notnull, 'NULL in a required column.');
          return [column.name, null];
        }
        requireCondition(typeof value === 'string', 'Missing column.');
        if (column.kind === 'integer' || column.kind === 'bigint') {
          requireCondition(
            storage === 'integer' && /^-?\d+$/.test(value),
            'Expected an exact SQLite integer.'
          );
          const integer = BigInt(value);
          const min =
            column.kind === 'integer' ? -2147483648n : -9223372036854775808n;
          const max =
            column.kind === 'integer' ? 2147483647n : 9223372036854775807n;
          requireCondition(
            integer >= min && integer <= max,
            'Integer outside PostgreSQL range.'
          );
          return [column.name, integer.toString()];
        }
        if (column.kind === 'boolean') {
          requireCondition(
            storage === 'integer' && (value === '0' || value === '1'),
            'Expected SQLite boolean 0 or 1.'
          );
          return [column.name, value === '1' ? 'true' : 'false'];
        }
        requireCondition(storage === 'text', 'Expected SQLite text.');
        requireCondition(
          Buffer.from(value, 'utf8').toString('hex').toUpperCase() ===
            row[`__bytes${index}`],
          'Text is not valid UTF-8.'
        );
        if (column.kind === 'timestamp')
          return [column.name, utcTimestamp(value)];
        requireCondition(
          !value.includes('\0') &&
            Buffer.from(value, 'utf8').toString('utf8') === value &&
            (!column.length || [...value].length <= column.length),
          'Text cannot be represented in PostgreSQL.'
        );
        return [column.name, value];
      } catch (error) {
        throw new MigrationError(
          `Invalid value at ${plan.name}.${column.name}: ${error instanceof MigrationError ? error.message : 'unsupported representation.'}`
        );
      }
    })
  );
}

async function sourceBatch(
  read: ReadSqlite,
  plan: Plan,
  after?: string
): Promise<Row[]> {
  const columns = plan.columns.flatMap((column, index) => [
    `CAST(${quote(column.name)} AS TEXT) AS ${quote(column.name)}`,
    `typeof(${quote(column.name)}) AS ${quote(`__storage${index}`)}`,
    `hex(${quote(column.name)}) AS ${quote(`__bytes${index}`)}`,
  ]);
  const ordering = plan.name === 'session' ? 's."id" COLLATE BINARY' : 's."id"';
  return (
    await read(
      `SELECT ${columns.join(', ')} FROM ${quote(plan.name)} s ${after === undefined ? '' : `WHERE ${ordering} > ?`} ORDER BY ${ordering} LIMIT ${batchSize}`,
      after === undefined ? [] : [after]
    )
  ).map((row) => convert(row, plan));
}

async function sourcePlans(read: ReadSqlite) {
  requireCondition(
    JSON.stringify(await read('PRAGMA integrity_check')) ===
      JSON.stringify([{ integrity_check: 'ok' }]),
    'SQLite integrity_check failed.'
  );
  requireCondition(
    (await read('SELECT 1 FROM pragma_foreign_key_check LIMIT 1')).length === 0,
    'SQLite foreign_key_check failed.'
  );
  const expected = new DataSource({
    type: 'sqlite',
    database: ':memory:',
    entities: [],
    subscribers: [],
    synchronize: false,
    dropSchema: false,
    migrationsRun: false,
    migrations: [
      path.join(__dirname, '../migration/sqlite/*' + path.extname(__filename)),
    ],
  });
  try {
    await expected.initialize();
    await expected.query('PRAGMA foreign_keys=OFF');
    await expected.runMigrations();
    const expectedRead: ReadSqlite = (sql, params) =>
      expected.query(sql, params);
    const journal = `SELECT CAST(timestamp AS TEXT) AS timestamp, name FROM migrations ORDER BY timestamp, name`;
    requireCondition(
      JSON.stringify(await read(journal)) ===
        JSON.stringify(await expected.query(journal)),
      'SQLite migration history does not match this build; fully upgrade before taking backups.'
    );
    const schema = await sqliteSchema(read);
    const canonical = await sqliteSchema(expectedRead);
    requireCondition(
      JSON.stringify(schema.map((table) => table.name)) ===
        JSON.stringify(canonical.map((table) => table.name)),
      'Unsupported SQLite table structure; unknown or missing application tables.'
    );
    for (const table of canonical) {
      const actual = schema.find((entry) => entry.name === table.name)!;
      const changedColumn = table.columns.find(
        (column, index) =>
          JSON.stringify(column) !== JSON.stringify(actual.columns[index])
      );
      requireCondition(
        !changedColumn && table.columns.length === actual.columns.length,
        `Unsupported SQLite column structure at ${table.name}.${changedColumn?.name ?? 'columns'}.`
      );
      requireCondition(
        JSON.stringify(actual) === JSON.stringify(table),
        `Unsupported SQLite index or constraint structure at ${table.name}.`
      );
    }
    requireCondition(
      JSON.stringify(
        schema
          .map((table) => table.name)
          .filter((name) => name !== 'migrations')
          .sort()
      ) === JSON.stringify([...applicationTables].sort()),
      'Unexpected application tables in this build.'
    );
    const sequences = await read(
      'SELECT name, CAST(seq AS TEXT) AS seq, typeof(seq) AS storage FROM sqlite_sequence'
    );
    requireCondition(
      sequences.every(
        (entry) =>
          entry.name === 'migrations' ||
          applicationTables.includes(
            entry.name as (typeof applicationTables)[number]
          )
      ),
      'Unknown SQLite AUTOINCREMENT entry.'
    );
    requireCondition(
      new Set(sequences.map((entry) => entry.name)).size === sequences.length &&
        sequences.every((entry) => entry.storage === 'integer'),
      'Invalid SQLite AUTOINCREMENT metadata.'
    );
    const plans: Plan[] = schema
      .filter((table) => table.name !== 'migrations')
      .map((table) => ({
        name: table.name,
        columns: (table.columns as unknown as SourceColumn[]).map((column) =>
          columnPlan(column, table.name)
        ),
        highWater:
          sequences.find((entry) => entry.name === table.name)?.seq ?? '0',
        generated: table.autoincrement,
      }));
    for (const plan of plans) {
      requireCondition(
        plan.columns
          .filter((column) => column.pk)
          .map((column) => column.name)
          .join() === 'id',
        `Unsupported primary key at ${plan.name}.`
      );
      requireCondition(
        /^\d+$/.test(plan.highWater) && BigInt(plan.highWater) < 2147483647n,
        `SQLite AUTOINCREMENT exhausted or unsupported at ${plan.name}.id.`
      );
      let after: string | undefined;
      for (;;) {
        const rows = await sourceBatch(read, plan, after);
        if (!rows.length) break;
        after = rows[rows.length - 1].id!;
        if (plan.generated && BigInt(after) > BigInt(plan.highWater))
          plan.highWater = after;
      }
      requireCondition(
        BigInt(plan.highWater) < 2147483647n,
        `Generated identifier exhausted at ${plan.name}.id.`
      );
    }
    return plans;
  } finally {
    if (expected.isInitialized) await expected.destroy();
  }
}

async function emptyPostgres(db: QueryRunner) {
  requireCondition(
    (
      await db.query(
        `SELECT n.nspname FROM pg_namespace n WHERE n.nspname <> 'public' AND n.nspname <> 'information_schema' AND n.nspname !~ '^pg_'`
      )
    ).length === 0,
    'PostgreSQL must have no custom schemas.'
  );
  requireCondition(
    (
      await db.query(
        `SELECT c.oid FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname <> 'information_schema' AND n.nspname !~ '^pg_' UNION ALL SELECT p.oid FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname <> 'information_schema' AND n.nspname !~ '^pg_' UNION ALL SELECT t.oid FROM pg_type t JOIN pg_namespace n ON n.oid=t.typnamespace WHERE n.nspname <> 'information_schema' AND n.nspname !~ '^pg_'`
      )
    ).length === 0 &&
      (
        await db.query(
          `SELECT 1 FROM pg_largeobject_metadata UNION ALL SELECT 1 FROM pg_event_trigger UNION ALL SELECT 1 FROM pg_extension WHERE extname <> 'plpgsql'`
        )
      ).length === 0,
    'PostgreSQL destination is not empty; use a fresh empty staging database.'
  );
}

function timestampWithoutZone(plan: Plan, column: Column) {
  return plan.name === 'session' && column.name === 'destroyedAt';
}
async function pgTables(db: QueryRunner, plans: Plan[]) {
  const names: { name: string }[] = await db.query(
    `SELECT tablename AS name FROM pg_tables WHERE schemaname='public' ORDER BY tablename`
  );
  requireCondition(
    JSON.stringify(names.map(({ name }) => name)) ===
      JSON.stringify([...plans.map((plan) => plan.name), 'migrations'].sort()),
    'Unexpected PostgreSQL table set.'
  );
  const tables = await db.getTables(plans.map((plan) => `public.${plan.name}`));
  for (const plan of plans) {
    const table = tables.find((table) => table.name === plan.name)!;
    requireCondition(
      table && table.columns.length === plan.columns.length,
      `PostgreSQL column mismatch at ${plan.name}.`
    );
    for (const column of plan.columns) {
      const actual = table.columns.find(
        (actual) => actual.name === column.name
      );
      const wanted =
        column.kind === 'timestamp'
          ? timestampWithoutZone(plan, column)
            ? 'timestamp without time zone'
            : 'timestamp with time zone'
          : column.kind;
      requireCondition(
        actual &&
          (column.kind === 'text'
            ? ['text', 'character varying'].includes(actual.type)
            : actual.type === wanted) &&
          actual.isPrimary === Boolean(column.pk) &&
          actual.isNullable === !column.notnull &&
          (!actual.length || Number(actual.length) === column.length),
        `Unsupported schema difference at ${plan.name}.${column.name}.`
      );
    }
  }
  // Topological insert order comes from actual PostgreSQL foreign keys.
  const ordered: Plan[] = [];
  while (ordered.length < plans.length) {
    const next = plans.find(
      (plan) =>
        !ordered.includes(plan) &&
        tables
          .find((table) => table.name === plan.name)!
          .foreignKeys.every((fk) =>
            ordered.some((parent) => parent.name === fk.referencedTableName)
          )
    );
    requireCondition(
      next,
      'Unsupported cyclic or external PostgreSQL foreign keys.'
    );
    ordered.push(next);
  }
  return { tables, ordered };
}

async function verifyJournal(db: QueryRunner, dataSource: DataSource) {
  const actual = await db.query(
    'SELECT timestamp::text AS timestamp, name FROM public.migrations ORDER BY timestamp, name'
  );
  const expected = dataSource.migrations
    .map((migration) => {
      const name = migration.name ?? migration.constructor.name;
      return { timestamp: name.slice(-13), name };
    })
    .sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  requireCondition(
    JSON.stringify(actual) === JSON.stringify(expected),
    'PostgreSQL migration journal mismatch.'
  );
}

async function verifyData(
  db: QueryRunner,
  read: ReadSqlite,
  plans: Plan[],
  tables: Table[]
) {
  const counts: Record<string, number> = {};
  for (const plan of plans) {
    const [{ count }] = await db.query(
      `SELECT count(*)::text AS count FROM ${qualified(plan.name)}`
    );
    requireCondition(
      count ===
        (
          await read(
            `SELECT CAST(count(*) AS TEXT) AS count FROM ${quote(plan.name)}`
          )
        )[0].count,
      `Row count mismatch at ${plan.name}.`
    );
    counts[plan.name] = Number(count);
    let after: string | undefined;
    for (;;) {
      const rows = await sourceBatch(read, plan, after);
      if (!rows.length) break;
      const expressions = plan.columns.map((column) => {
        const name = quote(column.name);
        const expression =
          column.kind === 'timestamp'
            ? `to_char(${name}${timestampWithoutZone(plan, column) ? '' : " AT TIME ZONE 'UTC'"}, 'YYYY-MM-DD HH24:MI:SS.US')`
            : `${name}::text`;
        return `${expression} AS ${name}`;
      });
      const ordering =
        plan.name === 'session' ? 's."id" COLLATE "C"' : 's."id"';
      const actual: Row[] = await db.query(
        `SELECT ${expressions.join(', ')} FROM ${qualified(plan.name)} s ${after === undefined ? '' : `WHERE ${ordering} > $1`} ORDER BY ${ordering} LIMIT ${batchSize}`,
        after === undefined ? [] : [after]
      );
      requireCondition(
        rows.length === actual.length,
        `Primary key set mismatch at ${plan.name}.`
      );
      for (let index = 0; index < rows.length; index++) {
        for (const column of plan.columns)
          requireCondition(
            rows[index][column.name] === actual[index][column.name],
            `Verification mismatch at ${plan.name}.${column.name}.`
          );
      }
      after = rows[rows.length - 1].id!;
    }
    const table = tables.find((table) => table.name === plan.name)!;
    for (const fk of table.foreignKeys) {
      const join = fk.columnNames
        .map(
          (column, index) =>
            `a.${quote(column)}=b.${quote(fk.referencedColumnNames[index])}`
        )
        .join(' AND ');
      const present = fk.columnNames
        .map((column) => `a.${quote(column)} IS NOT NULL`)
        .join(' AND ');
      const dangling = await db.query(
        `SELECT 1 FROM ${qualified(plan.name)} a WHERE ${present} AND NOT EXISTS (SELECT 1 FROM ${qualified(fk.referencedTableName)} b WHERE ${join}) LIMIT 1`
      );
      requireCondition(
        dangling.length === 0,
        `Foreign key verification failed at ${plan.name}.`
      );
    }
    for (const unique of [
      ...table.uniques,
      ...table.indices.filter((index) => index.isUnique),
    ]) {
      const columns = unique.columnNames.map(quote);
      requireCondition(
        (
          await db.query(
            `SELECT 1 FROM ${qualified(plan.name)} WHERE ${columns.map((column) => `${column} IS NOT NULL`).join(' AND ')} GROUP BY ${columns.join(', ')} HAVING count(*) > 1 LIMIT 1`
          )
        ).length === 0,
        `Uniqueness verification failed at ${plan.name}.`
      );
    }
    if (plan.generated) {
      const [{ sequence }] = await db.query(
        `SELECT pg_get_serial_sequence($1, 'id') AS sequence`,
        [qualified(plan.name)]
      );
      requireCondition(
        sequence,
        `Missing generated sequence at ${plan.name}.id.`
      );
      const [{ value, called }] = await db.query(
        `SELECT last_value::text AS value, is_called AS called FROM ${sequence}`
      );
      requireCondition(
        value === (plan.highWater === '0' ? '1' : plan.highWater) &&
          called === (plan.highWater !== '0'),
        `Sequence verification failed at ${plan.name}.id.`
      );
    }
  }
  requireCondition(
    (
      await db.query(
        `SELECT 1 FROM pg_constraint WHERE connamespace='public'::regnamespace AND NOT convalidated UNION ALL SELECT 1 FROM pg_index i JOIN pg_class c ON c.oid=i.indrelid WHERE c.relnamespace='public'::regnamespace AND (NOT indisvalid OR NOT indisready)`
      )
    ).length === 0,
    'PostgreSQL constraints or indexes are not valid.'
  );
  return counts;
}

export type MigrationOptions = {
  sqlitePath: string;
  settingsPath: string;
  postgres: PgOptions;
};
export async function migrateSqliteToPostgres(options: MigrationOptions) {
  let phase = 'source preflight';
  let source: Awaited<ReturnType<typeof openBackup>> | undefined;
  let target: DataSource | undefined;
  let runner: QueryRunner | undefined;
  let committed = false;
  let result: { counts: Record<string, number>; validated: true } | undefined;
  let failure: MigrationError | undefined;
  try {
    // Validate independently of NODE_ENV, DB_TYPE, or the normal datasource.
    requireCondition(
      options.postgres.type === 'postgres' &&
        options.postgres.host &&
        options.postgres.username &&
        options.postgres.password &&
        options.postgres.database &&
        (options.postgres.host.startsWith('/') ||
          (Number.isInteger(options.postgres.port) &&
            options.postgres.port! > 0 &&
            options.postgres.port! <= 65535)),
      'Explicit PostgreSQL host, port, user, password and database are required.'
    );
    const sqlitePath = await standaloneBackupPath(options.sqlitePath);
    await regularFile(options.settingsPath, 'settings.json');
    const sqliteHash = await fileHash(sqlitePath);
    const settingsHash = await fileHash(options.settingsPath);
    await settingsFromBackup(options.settingsPath);
    source = await openBackup(sqlitePath);
    await source.read('PRAGMA query_only=ON');
    await source.read('BEGIN');
    const plans = await sourcePlans(source.read);
    phase = 'destination preflight';
    target = pgSource(options.postgres);
    await target.initialize();
    runner = target.createQueryRunner();
    await runner.connect();
    // Serialize this tool's runs without disabling any database constraints.
    const [{ locked }] = await runner.query(
      `SELECT pg_try_advisory_lock(1791000000, 20261020) AS locked`
    );
    requireCondition(
      locked,
      'Another migration is using this staging destination.'
    );
    await runner.query(`SET search_path TO public`);
    await runner.query(`SET TIME ZONE 'UTC'`);
    await emptyPostgres(runner);
    phase = 'PostgreSQL schema creation';
    await target.runMigrations({ transaction: 'all' });
    phase = 'schema verification';
    const schema = await pgTables(runner, plans);
    const ordered = schema.ordered;
    await verifyJournal(runner, target);
    await runner.startTransaction();
    await runner.query(
      `LOCK TABLE ${plans.map((plan) => qualified(plan.name)).join(', ')} IN ACCESS EXCLUSIVE MODE`
    );
    for (const plan of ordered) {
      phase = `data import: ${plan.name}`;
      let after: string | undefined;
      for (;;) {
        const rows = await sourceBatch(source.read, plan, after);
        if (!rows.length) break;
        const params: (string | null)[] = [];
        const values = rows.map(
          (row) =>
            `(${plan.columns
              .map((column) => {
                let value = row[column.name];
                if (
                  value !== null &&
                  column.kind === 'timestamp' &&
                  !timestampWithoutZone(plan, column)
                )
                  value += '+00:00';
                params.push(value);
                return `$${params.length}`;
              })
              .join(', ')})`
        );
        await runner.query(
          `INSERT INTO ${qualified(plan.name)} (${plan.columns.map((column) => quote(column.name)).join(', ')}) VALUES ${values.join(', ')}`,
          params
        );
        after = rows[rows.length - 1].id!;
      }
      if (plan.generated)
        await runner.query(
          `SELECT setval(pg_get_serial_sequence($1, 'id'), $2::bigint, $3)`,
          [
            qualified(plan.name),
            plan.highWater === '0' ? '1' : plan.highWater,
            plan.highWater !== '0',
          ]
        );
    }
    phase = 'transaction verification';
    await verifyData(runner, source.read, plans, schema.tables);
    await verifyJournal(runner, target);
    requireCondition(
      (await fileHash(sqlitePath)) === sqliteHash &&
        (await fileHash(options.settingsPath)) === settingsHash,
      'Input files changed during migration; staging target must not be activated.'
    );
    await runner.commitTransaction();
    committed = true;
    phase = 'fresh connection verification';
    const fresh = pgSource(options.postgres);
    try {
      await fresh.initialize();
      const reader = fresh.createQueryRunner();
      try {
        await reader.query(`SET TIME ZONE 'UTC'`);
        const reopened = await pgTables(reader, plans);
        await verifyJournal(reader, fresh);
        const counts = await verifyData(
          reader,
          source.read,
          plans,
          reopened.tables
        );
        requireCondition(
          (await fileHash(sqlitePath)) === sqliteHash &&
            (await fileHash(options.settingsPath)) === settingsHash,
          'Input files changed during final verification.'
        );
        result = { counts, validated: true };
      } finally {
        await reader.release();
      }
    } finally {
      if (fresh.isInitialized) await fresh.destroy();
    }
  } catch (error) {
    if (!committed && runner?.isTransactionActive) {
      try {
        await runner.rollbackTransaction();
      } catch {
        failure = new MigrationError(
          `${phase}: rollback failed; discard this staging database. Never activate it.`
        );
      }
    }
    // Once committed, preserve staging data, including other clients' writes.
    const disposition = committed
      ? 'PostgreSQL staging database is invalid and not suitable for activation. Import has committed; data is preserved for diagnosis. Discard it manually and retry only with a fresh empty database.'
      : 'Discard an unsuccessful staging target; retry only with a fresh empty database.';
    const code = (error as { driverError?: { code?: string } }).driverError
      ?.code;
    failure ??= new MigrationError(
      `${phase}: ${error instanceof MigrationError ? error.message : `operation failed${code && /^[A-Z0-9_]+$/.test(code) ? ` (SQLSTATE ${code})` : ''}. No sensitive database error details are printed.`} ${disposition}`
    );
  } finally {
    let cleanupFailed = false;
    if (runner && !runner.isReleased) {
      try {
        await runner.query('SELECT pg_advisory_unlock(1791000000, 20261020)');
      } catch {
        cleanupFailed = true;
      }
      try {
        await runner.release();
      } catch {
        cleanupFailed = true;
      }
    }
    try {
      if (target?.isInitialized) await target.destroy();
    } catch {
      cleanupFailed = true;
    }
    try {
      if (source) await source.close();
    } catch {
      cleanupFailed = true;
    }
    if (cleanupFailed)
      failure ??= new MigrationError(
        'Connection cleanup failed. Do not activate this staging database; discard it and retry using fresh empty staging.'
      );
  }
  if (failure) throw failure;
  requireCondition(
    result,
    'Migration did not produce a verified result. Never activate this staging database.'
  );
  return result;
}

export async function runCli(args = process.argv.slice(2)) {
  try {
    requireCondition(
      args.length === 4 &&
        args[0] === '--sqlite' &&
        args[2] === '--settings' &&
        args[1] &&
        args[3],
      'Usage: migration:sqlite-to-postgres --sqlite /backup/db.sqlite3 --settings /backup/settings.json'
    );
    process.stdout.write(
      'Offline migration: keep Seerr stopped. Preserve the COMPLETE application configuration directory for the new deployment. Never activate a failed staging target.\n'
    );
    const report = await migrateSqliteToPostgres({
      sqlitePath: path.resolve(args[1]),
      settingsPath: path.resolve(args[3]),
      postgres: postgresOptionsFromEnv(),
    });
    for (const [table, count] of Object.entries(report.counts))
      process.stdout.write(`${table}: ${count}\n`);
    process.stdout.write(
      'Verified all rows, keys, values, relationships, sequences and PostgreSQL migrations using a fresh connection. Input files unchanged. Preserve the complete configuration directory; switch the deployment only after reviewing this report.\n'
    );
    return 0;
  } catch (error) {
    process.stderr.write(
      (error instanceof MigrationError
        ? error.message
        : 'Migration failed during configuration or connection setup; check paths and explicit DB_* settings.') +
        '\n'
    );
    return 1;
  }
}
if (require.main === module)
  void runCli().then((code) => {
    process.exitCode = code;
  });
