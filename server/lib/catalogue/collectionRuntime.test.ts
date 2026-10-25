import { getSettings } from '@server/lib/settings';
import assert from 'node:assert/strict';
import { it } from 'node:test';
import type { DataSource } from 'typeorm';
import {
  catalogueCollectionRunning,
  startCatalogueCollection,
  stopCatalogueCollection,
} from './collectionRuntime';
import { CatalogueCollector } from './collector';

it('collection starts only with explicit configuration; startup is single-flight and shutdown stops dispatch', async (t) => {
  const settings = getSettings().catalogue.tr4ker;
  const originalEnabled = settings.enabled;
  const originalKey = process.env.TR4KER_KEY;
  let unavailable = false;
  const initialize = t.mock.method(
    CatalogueCollector.prototype,
    'initialize',
    async () => {
      if (unavailable) throw new Error('SECRET storage failure');
    }
  );
  const tick = t.mock.method(
    CatalogueCollector.prototype,
    'tick',
    async () => false
  );
  const stop = t.mock.method(
    CatalogueCollector.prototype,
    'stop',
    () => undefined
  );
  try {
    settings.enabled = false;
    process.env.TR4KER_KEY = 'synthetic-key';
    await startCatalogueCollection({} as DataSource);
    assert.equal(initialize.mock.callCount(), 0);
    settings.enabled = true;
    delete process.env.TR4KER_KEY;
    await startCatalogueCollection({} as DataSource);
    assert.equal(initialize.mock.callCount(), 0);
    process.env.TR4KER_KEY = 'synthetic-key';
    unavailable = true;
    await assert.doesNotReject(startCatalogueCollection({} as DataSource));
    assert.equal(catalogueCollectionRunning(), false);
    unavailable = false;
    await Promise.all([
      startCatalogueCollection({} as DataSource),
      startCatalogueCollection({} as DataSource),
    ]);
    assert.equal(initialize.mock.callCount(), 2);
    assert.equal(tick.mock.callCount(), 1);
    assert.equal(catalogueCollectionRunning(), true);
    await stopCatalogueCollection();
    assert.equal(stop.mock.callCount(), 1);
    assert.equal(catalogueCollectionRunning(), false);
    await startCatalogueCollection({} as DataSource);
    assert.equal(initialize.mock.callCount(), 2);
  } finally {
    settings.enabled = originalEnabled;
    if (originalKey === undefined) delete process.env.TR4KER_KEY;
    else process.env.TR4KER_KEY = originalKey;
    await stopCatalogueCollection();
  }
});
