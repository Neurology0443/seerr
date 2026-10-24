import logger from '@server/logger';
import assert from 'node:assert/strict';
import { it } from 'node:test';
import type { DataSource } from 'typeorm';
import { startCatalogueInitialization } from './index';
import { CatalogueDatabase, CatalogueUnavailableError } from './lifecycle';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function controlledConnection(
  connectionGate = Promise.resolve(),
  migrationGate = Promise.resolve(),
  schemaGate?: Promise<void>
) {
  let initialized = false;
  const calls = { initialize: 0, migrate: 0, destroy: 0 };
  const connection = {
    options: { type: schemaGate ? 'postgres' : 'sqlite' },
    get isInitialized() {
      return initialized;
    },
    async initialize() {
      calls.initialize++;
      await connectionGate;
      initialized = true;
    },
    async runMigrations() {
      calls.migrate++;
      await migrationGate;
    },
    async query() {
      await schemaGate;
    },
    async destroy() {
      calls.destroy++;
      initialized = false;
    },
  } as unknown as DataSource;
  return { connection, calls };
}

it('native startup proceeds while catalogue initialization is pending', async (t) => {
  const gate = deferred();
  const initialize = t.mock.method(
    CatalogueDatabase.prototype,
    'initialize',
    async () => {
      await gate.promise;
      return true;
    }
  );
  try {
    const startup = (async () => {
      startCatalogueInitialization();
      return 'native ready';
    })();
    assert.equal(await startup, 'native ready');
    assert.equal(initialize.mock.callCount(), 1);
  } finally {
    gate.resolve();
    await new Promise(setImmediate);
  }
});

it('startup handles rejected tasks and reporting failures without unhandled rejections', async (t) => {
  const messages: string[] = [];
  t.mock.method(CatalogueDatabase.prototype, 'initialize', async () => {
    throw new Error('postgres://user:SECRET@host/database');
  });
  const log = t.mock.method(logger, 'error', (message: string) => {
    messages.push(message);
    return logger;
  });
  startCatalogueInitialization();
  await new Promise(setImmediate);
  assert.deepEqual(messages, [
    'Catalogue initialization could not be reported',
  ]);
  assert.ok(!JSON.stringify(messages).includes('SECRET'));
  log.mock.restore();
  t.mock.method(logger, 'error', () => {
    throw new Error('log transport unavailable');
  });
  startCatalogueInitialization();
  await new Promise(setImmediate);
});

it('startup reports only the safe failure phase, code and diagnostic', async (t) => {
  t.mock.method(CatalogueDatabase.prototype, 'initialize', async () => false);
  t.mock.method(CatalogueDatabase.prototype, 'getState', () => ({
    status: 'unavailable' as const,
    error: 'migration' as const,
    code: '42501',
    diagnostic: 'Insufficient database privileges',
  }));
  const output: unknown[][] = [];
  t.mock.method(logger, 'error', (...args: unknown[]) => {
    output.push(args);
    return logger;
  });
  startCatalogueInitialization();
  await new Promise(setImmediate);
  assert.deepEqual(output, [
    [
      'Catalogue storage unavailable; native Seerr startup will continue',
      {
        label: 'Catalogue',
        phase: 'migration',
        code: '42501',
        diagnostic: 'Insufficient database privileges',
      },
    ],
  ]);
});

it('connection and migrations are single-flight; readiness waits for both', async () => {
  const connecting = deferred();
  const migrating = deferred();
  const { connection, calls } = controlledConnection(
    connecting.promise,
    migrating.promise
  );
  let factories = 0;
  const database = new CatalogueDatabase(() => {
    factories++;
    return connection;
  });
  const first = database.initialize();
  const second = database.initialize();
  assert.equal(first, second);
  assert.equal(database.getState().status, 'initializing');
  assert.throws(() => database.getConnection(), CatalogueUnavailableError);
  connecting.resolve();
  await new Promise(setImmediate);
  assert.equal(calls.migrate, 1);
  assert.equal(database.getState().status, 'initializing');
  assert.throws(() => database.getConnection(), CatalogueUnavailableError);
  migrating.resolve();
  assert.deepEqual(await Promise.all([first, second]), [true, true]);
  assert.equal(database.getState().status, 'ready');
  assert.equal(await database.initialize(), true);
  assert.equal(factories, 1);
  await database.shutdown();
  assert.equal(calls.destroy, 1);
});

for (const phase of ['connection', 'schema', 'migration'] as const) {
  it(`shutdown during pending ${phase} closes the connection and cannot reopen it`, async () => {
    const gate = deferred();
    const { connection, calls } = controlledConnection(
      phase === 'connection' ? gate.promise : undefined,
      phase === 'migration' ? gate.promise : undefined,
      phase === 'schema' ? gate.promise : undefined
    );
    const database = new CatalogueDatabase(() => connection);
    const opening = database.initialize();
    await new Promise(setImmediate);
    const closing = database.shutdown();
    assert.equal(database.shutdown(), closing);
    assert.equal(await database.initialize(), false);
    assert.throws(() => database.getConnection(), CatalogueUnavailableError);
    gate.resolve();
    assert.equal(await opening, false);
    await closing;
    await database.shutdown();
    assert.equal(await database.initialize(), false);
    assert.equal(database.getState().status, 'closed');
    assert.equal(connection.isInitialized, false);
    assert.equal(calls.initialize, 1);
    assert.equal(calls.destroy, 1);
    assert.equal(calls.migrate, phase === 'migration' ? 1 : 0);
  });
}

for (const [phase, code, diagnostic] of [
  ['connection', 'ECONNREFUSED', 'Database connection refused'],
  [
    'connection',
    'SQLITE_CANTOPEN',
    'Unable to open the catalogue database file',
  ],
  ['migration', '42501', 'Insufficient database privileges'],
] as const) {
  it(`retains safe ${phase} diagnostics (${code}) through cleanup`, async () => {
    const { connection } = controlledConnection();
    const error = Object.assign(
      new Error('password=SECRET SQL parameters: SECRET'),
      { code }
    );
    if (phase === 'connection')
      connection.initialize = async () => {
        throw error;
      };
    else
      connection.runMigrations = async () => {
        throw Object.assign(new Error('postgres://SECRET'), {
          driverError: error,
        });
      };
    const database = new CatalogueDatabase(() => connection);
    assert.equal(await database.initialize(), false);
    const failure = { status: 'unavailable', error: phase, code, diagnostic };
    assert.deepEqual(database.getState(), failure);
    assert.throws(() => database.getConnection(), CatalogueUnavailableError);
    await database.shutdown();
    assert.deepEqual(database.getState(), failure);
    assert.ok(!JSON.stringify(database.getState()).includes('SECRET'));
    assert.equal(connection.isInitialized, false);
  });
}

it('a genuine retry updates failure state and can become ready', async () => {
  const { connection } = controlledConnection();
  let fail = true;
  const database = new CatalogueDatabase(() => {
    if (fail) throw { code: 'SQLITE_CANTOPEN', message: 'SECRET' };
    return connection;
  });
  assert.equal(await database.initialize(), false);
  fail = false;
  assert.equal(await database.initialize(), true);
  assert.deepEqual(database.getState(), { status: 'ready' });
  await database.shutdown();
});

it('unrecognized error codes and cleanup errors do not replace the original safe failure', async () => {
  const { connection } = controlledConnection();
  connection.runMigrations = async () => {
    throw { code: 'password=SECRET', message: 'SECRET' };
  };
  connection.destroy = async () => {
    throw new Error('cleanup SECRET');
  };
  const database = new CatalogueDatabase(() => connection);
  assert.equal(await database.initialize(), false);
  const failure = {
    status: 'unavailable',
    error: 'migration',
    diagnostic: 'Catalogue database migration failed',
  };
  assert.deepEqual(database.getState(), failure);
  await database.shutdown();
  assert.deepEqual(database.getState(), failure);
});
