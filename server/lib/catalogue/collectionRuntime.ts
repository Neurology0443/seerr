import Tr4kerAdapter from '@server/api/trackers/tr4ker';
import { getSettings } from '@server/lib/settings';
import logger from '@server/logger';
import type { DataSource } from 'typeorm';
import {
  tr4kerCollectionDescription,
  validateCollectionSettings,
} from './collectionConfig';
import { CatalogueCollector } from './collector';

let collector: CatalogueCollector | undefined;
let starting: Promise<void> | undefined;
let timer: NodeJS.Timeout | undefined;
let stopping = false;

function reportUnavailable(): void {
  logger.warn('Catalogue collection unavailable; native Seerr will continue', {
    label: 'Catalogue',
  });
}
export function startCatalogueCollection(
  connection: DataSource
): Promise<void> {
  if (stopping || collector) return Promise.resolve();
  if (starting) return starting;
  starting = (async () => {
    const settings = getSettings().catalogue.tr4ker;
    if (!settings.enabled || !process.env.TR4KER_KEY?.trim()) return;
    try {
      validateCollectionSettings(settings);
      const candidate = new CatalogueCollector(connection, [
        {
          ...tr4kerCollectionDescription,
          settings,
          adapter: new Tr4kerAdapter({
            trackerId: 'tr4ker',
            apiKey: process.env.TR4KER_KEY,
          }),
        },
      ]);
      await candidate.initialize();
      if (stopping) {
        candidate.stop();
        return;
      }
      collector = candidate;
      const tick = () => {
        void candidate.tick().catch(reportUnavailable);
      };
      // A wake-up polls durable eligible work. SQL, not this timer, decides
      // request starts. Repeated startup cannot create a second dispatcher.
      timer = setInterval(tick, 1000);
      timer.unref();
      tick();
    } catch {
      reportUnavailable();
    }
  })().finally(() => {
    starting = undefined;
  });
  return starting;
}
export function enqueueCatalogueRecent(categoryId: number): void {
  if (stopping || !collector) return;
  void collector
    .enqueueRecent(categoryId)
    .then(() => collector?.tick())
    .catch(reportUnavailable);
}
export function catalogueCollectionRunning(categoryId?: number): boolean {
  return (
    !!collector &&
    !stopping &&
    (categoryId === undefined || collector.scopeRunning(categoryId))
  );
}
export async function stopCatalogueCollection(): Promise<void> {
  stopping = true;
  if (timer) {
    clearInterval(timer);
    timer = undefined;
  }
  collector?.stop();
  await starting;
  if (collector) {
    // A stuck network operation must not indefinitely hold shutdown open.
    let timeout: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        collector.drain(),
        new Promise<void>((resolve) => {
          timeout = setTimeout(resolve, 2000);
          timeout.unref();
        }),
      ]);
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  }
}
