import type { DataSource, EntityManager } from 'typeorm';

const writeQueues = new WeakMap<DataSource, Promise<unknown>>();

// All catalogue repositories share the SQLite connection's transaction queue.
export function catalogueWrite<T>(
  connection: DataSource,
  operation: (manager: EntityManager) => Promise<T>
): Promise<T> {
  if (connection.options.type !== 'sqlite')
    return connection.transaction(operation);
  const result = (writeQueues.get(connection) ?? Promise.resolve()).then(() =>
    connection.transaction(operation)
  );
  writeQueues.set(
    connection,
    result.catch(() => undefined)
  );
  return result;
}

export type CatalogueClock = (manager: EntityManager) => Promise<number>;
export const databaseTime: CatalogueClock = async (manager) => {
  const sql =
    manager.connection.options.type === 'postgres'
      ? 'SELECT floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint AS now'
      : "SELECT CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER) AS now";
  return Number((await manager.query(sql))[0].now);
};

export class CatalogueLeaseLostError extends Error {
  constructor() {
    super('Catalogue collection lease is no longer valid');
  }
}
