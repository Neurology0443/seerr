import fs from 'fs';
import path from 'path';
import type { TlsOptions } from 'tls';
import { AbstractLogger, DataSource } from 'typeorm';
import { createCatalogueEntities } from './entities';
import type { CatalogueEngine } from './types';

export interface CatalogueConnectionOptions {
  type?: CatalogueEngine;
  database?: string;
  env?: Readonly<Record<string, string | undefined>>;
}

class CatalogueSqlLogger extends AbstractLogger {
  protected writeLog(): void {
    // TypeORM logs migration errors even with logging:false. Only the lifecycle
    // reports failures, using a safe phase instead of raw SQL/driver messages.
  }
}

// Match native connection conventions without importing native entities/subscribers.
export function createCatalogueDataSource(
  options: CatalogueConnectionOptions = {}
): DataSource {
  const env = options.env ?? process.env;
  const type =
    options.type ?? (env.DB_TYPE === 'postgres' ? 'postgres' : 'sqlite');
  const integer = (name: string, fallback?: number) => {
    const value = parseInt(env[name] ?? '', 10);
    return Number.isNaN(value) ? fallback : value;
  };
  const certificate = (name: string) =>
    env[name] ||
    (env[name + '_FILE']
      ? fs.readFileSync(env[name + '_FILE'] as string)
      : undefined);
  const ssl: TlsOptions | undefined =
    type === 'postgres' && env.DB_USE_SSL?.toLowerCase() === 'true'
      ? {
          rejectUnauthorized: env.DB_SSL_REJECT_UNAUTHORIZED
            ? env.DB_SSL_REJECT_UNAUTHORIZED.toLowerCase() === 'true'
            : true,
          ca: certificate('DB_SSL_CA'),
          key: certificate('DB_SSL_KEY'),
          cert: certificate('DB_SSL_CERT'),
        }
      : undefined;
  const common = {
    synchronize: false,
    dropSchema: false,
    migrationsRun: false,
    // SQL and driver errors may contain identifiers or connection secrets.
    logging: false as const,
    logger: new CatalogueSqlLogger(false),
    entities: createCatalogueEntities(type),
    subscribers: [],
    migrationsTableName: 'catalogue_migrations',
    migrations: [
      path.join(__dirname, 'migration', type, '*' + path.extname(__filename)),
    ],
  };
  return type === 'postgres'
    ? new DataSource({
        ...common,
        type,
        schema: 'catalogue',
        host: env.DB_SOCKET_PATH || env.DB_HOST,
        port: env.DB_SOCKET_PATH ? undefined : integer('DB_PORT', 5432),
        username: env.DB_USER,
        password: env.DB_PASS,
        database: options.database ?? env.DB_NAME ?? 'seerr',
        ssl,
        poolSize: integer('DB_POOL_SIZE'),
        connectTimeoutMS: integer('DB_CONNECT_TIMEOUT_MS', 30000),
      })
    : new DataSource({
        ...common,
        type,
        database:
          options.database ??
          path.join(
            env.CONFIG_DIRECTORY ?? path.resolve(__dirname, '../../../config'),
            'db',
            'catalogue.sqlite'
          ),
        enableWAL: true,
      });
}
