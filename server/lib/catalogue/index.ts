import logger from '@server/logger';
import {
  startCatalogueCollection,
  stopCatalogueCollection,
} from './collectionRuntime';
import { createCatalogueDataSource } from './datasource';
import { CatalogueDatabase } from './lifecycle';

const catalogue = new CatalogueDatabase(() => createCatalogueDataSource());
let shutdownRegistered = false;

export const getCatalogueState = () => catalogue.getState();
export const getCatalogueConnection = () => catalogue.getConnection();
export const shutdownCatalogue = async () => {
  await stopCatalogueCollection();
  await catalogue.shutdown();
};

export async function initializeCatalogue(): Promise<boolean> {
  const ready = await catalogue.initialize();
  if (!ready) {
    logger.error(
      'Catalogue storage unavailable; native Seerr startup will continue',
      {
        label: 'Catalogue',
        phase: catalogue.getState().error,
        code: catalogue.getState().code,
        diagnostic: catalogue.getState().diagnostic,
      }
    );
  }
  return ready;
}

export function startCatalogueInitialization(): void {
  void initializeCatalogue()
    .then((ready) => {
      if (ready) return startCatalogueCollection(getCatalogueConnection());
    })
    .catch(() => {
      // Initialization records database failures itself. A reporting failure must
      // not turn this independent task into an unhandled rejection at startup.
      try {
        logger.error('Catalogue initialization could not be reported', {
          label: 'Catalogue',
        });
      } catch {
        /* The lifecycle state remains available even if logging fails. */
      }
    });
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
