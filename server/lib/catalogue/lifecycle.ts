import type { DataSource } from 'typeorm';

export type CatalogueState = {
  status: 'uninitialized' | 'initializing' | 'ready' | 'unavailable' | 'closed';
  error?: 'connection' | 'migration' | 'shutdown';
};

export class CatalogueUnavailableError extends Error {
  constructor() {
    super('Catalogue storage is unavailable');
  }
}

export class CatalogueDatabase {
  private connection?: DataSource;
  private initializing?: Promise<boolean>;
  private closing?: Promise<void>;
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
    if (this.closing) return this.closing.then(() => this.initialize());
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
      phase = 'migration';
      if (this.connection.options.type === 'postgres') {
        // TypeORM creates its migration journal in this schema too.
        await this.connection.query('CREATE SCHEMA IF NOT EXISTS "catalogue"');
      }
      await this.connection.runMigrations({ transaction: 'all' });
      this.state = { status: 'ready' };
      return true;
    } catch {
      if (this.connection?.isInitialized) {
        try {
          await this.connection.destroy();
        } catch {
          /* Preserve the initialization failure. */
        }
      }
      this.state = { status: 'unavailable', error: phase };
      return false;
    }
  }

  shutdown(): Promise<void> {
    if (this.closing) return this.closing;
    this.closing = (async () => {
      await this.initializing;
      try {
        if (this.connection?.isInitialized) await this.connection.destroy();
        this.state = { status: 'closed' };
      } catch {
        this.state = { status: 'unavailable', error: 'shutdown' };
      }
    })().finally(() => {
      this.closing = undefined;
    });
    return this.closing;
  }
}
