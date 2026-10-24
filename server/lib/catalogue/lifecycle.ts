import type { DataSource } from 'typeorm';

export type CatalogueState = {
  status: 'uninitialized' | 'initializing' | 'ready' | 'unavailable' | 'closed';
  error?: 'connection' | 'migration' | 'shutdown';
  code?: string;
  diagnostic?: string;
};

function failureState(
  phase: NonNullable<CatalogueState['error']>,
  error: unknown
): CatalogueState {
  const details = error as {
    code?: unknown;
    driverError?: { code?: unknown };
  } | null;
  const candidate = details?.driverError?.code ?? details?.code;
  const systemCodes = [
    'ECONNREFUSED',
    'ECONNRESET',
    'ETIMEDOUT',
    'ENOTFOUND',
    'EACCES',
    'ENOENT',
    'EISDIR',
  ];
  const code =
    typeof candidate === 'string' &&
    (/^[0-9A-Z]{5}$/.test(candidate) ||
      /^SQLITE_(ERROR|BUSY|LOCKED|READONLY|IOERR|CORRUPT|FULL|CANTOPEN|SCHEMA|TOOBIG|CONSTRAINT|MISMATCH|MISUSE|AUTH|RANGE|NOTADB|PERM|NOMEM|ABORT|INTERRUPT|PROTOCOL)$/.test(
        candidate
      ) ||
      systemCodes.includes(candidate))
      ? candidate
      : undefined;
  const diagnostics: Record<string, string> = {
    '42501': 'Insufficient database privileges',
    '28P01': 'Database authentication failed',
    '3D000': 'Configured database does not exist',
    SQLITE_CANTOPEN: 'Unable to open the catalogue database file',
    SQLITE_BUSY: 'Catalogue database is busy',
    SQLITE_READONLY: 'Catalogue database is read-only',
    ECONNREFUSED: 'Database connection refused',
    ETIMEDOUT: 'Database connection timed out',
    ENOTFOUND: 'Database host could not be resolved',
    EACCES: 'Database resource access denied',
    ENOENT: 'Required database resource not found',
  };
  return {
    status: 'unavailable',
    error: phase,
    ...(code ? { code } : {}),
    diagnostic:
      (code && diagnostics[code]) || `Catalogue database ${phase} failed`,
  };
}

export class CatalogueUnavailableError extends Error {
  constructor() {
    super('Catalogue storage is unavailable');
  }
}

export class CatalogueDatabase {
  private connection?: DataSource;
  private initializing?: Promise<boolean>;
  private closing?: Promise<void>;
  private stopping = false;
  private state: CatalogueState = { status: 'uninitialized' };

  constructor(private readonly factory: () => DataSource) {}

  getState(): CatalogueState {
    return { ...this.state };
  }

  getConnection(): DataSource {
    if (this.state.status !== 'ready' || !this.connection?.isInitialized)
      throw new CatalogueUnavailableError();
    return this.connection;
  }

  initialize(): Promise<boolean> {
    if (this.stopping) return Promise.resolve(false);
    if (this.initializing) return this.initializing;
    if (this.state.status === 'ready') return Promise.resolve(true);
    this.initializing = this.open().finally(() => {
      this.initializing = undefined;
    });
    return this.initializing;
  }

  private async open(): Promise<boolean> {
    this.state = { status: 'initializing' };
    let phase: 'connection' | 'migration' = 'connection';
    try {
      // A previous cleanup failure must not leave a second live connection.
      if (this.connection?.isInitialized) await this.connection.destroy();
      this.connection = this.factory();
      await this.connection.initialize();
      if (this.stopping) return false;
      phase = 'migration';
      if (this.connection.options.type === 'postgres') {
        // TypeORM creates its migration journal in this schema too.
        await this.connection.query('CREATE SCHEMA IF NOT EXISTS "catalogue"');
      }
      if (this.stopping) return false;
      await this.connection.runMigrations({ transaction: 'all' });
      if (this.stopping) return false;
      this.state = { status: 'ready' };
      return true;
    } catch (error) {
      this.state = failureState(phase, error);
      if (this.connection?.isInitialized) {
        try {
          await this.connection.destroy();
        } catch {
          /* Preserve the initialization failure. */
        }
      }
      return false;
    }
  }

  shutdown(): Promise<void> {
    if (this.closing) return this.closing;
    this.stopping = true;
    if (this.state.status !== 'unavailable') this.state = { status: 'closed' };
    this.closing = (async () => {
      await this.initializing;
      try {
        if (this.connection?.isInitialized) await this.connection.destroy();
      } catch (error) {
        if (this.state.status !== 'unavailable')
          this.state = failureState('shutdown', error);
      }
    })().finally(() => {
      this.closing = undefined;
    });
    return this.closing;
  }
}
