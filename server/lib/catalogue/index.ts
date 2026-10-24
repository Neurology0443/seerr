import logger from '@server/logger';
import { createCatalogueDataSource } from './datasource';
import { CatalogueDatabase } from './lifecycle';

const catalogue = new CatalogueDatabase(() => createCatalogueDataSource());
let shutdownRegistered = false;

export const getCatalogueState = () => catalogue.getState();
export const getCatalogueConnection = () => catalogue.getConnection();
export const shutdownCatalogue = () => catalogue.shutdown();

export async function initializeCatalogue(): Promise<boolean> {
  const ready = await catalogue.initialize();
  if (!ready) {
    logger.error(
      'Catalogue storage unavailable; native Seerr startup will continue',
      {
        label: 'Catalogue',
        phase: catalogue.getState().error,
      }
    );
  }
  return ready;
}

// The native server has no shutdown coordinator. Preserve signal exit semantics
// while allowing this independent connection a bounded opportunity to close.
export function registerCatalogueShutdown(): void {
  if (shutdownRegistered) return;
  shutdownRegistered = true;
  for (const [signal, code] of [
    ['SIGINT', 130],
    ['SIGTERM', 143],
  ] as const) {
    process.once(signal, () => {
      const timeout = setTimeout(() => process.exit(code), 5000);
      timeout.unref();
      void shutdownCatalogue().finally(() => process.exit(code));
    });
  }
}
