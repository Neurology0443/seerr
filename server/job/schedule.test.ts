import * as runtime from '@server/lib/catalogue/collectionRuntime';
import { getSettings } from '@server/lib/settings';
import schedule from 'node-schedule';
import assert from 'node:assert/strict';
import { it } from 'node:test';
import { scheduledJobs, startJobs } from './schedule';

it('Recent movie/TV native jobs are separate, staggered, configurable and registered once', (t) => {
  const job = { cancel: () => true } as unknown as schedule.Job;
  const callbacks = new Map<string, () => void>();
  t.mock.method(schedule, 'scheduleJob', ((
    cron: string,
    callback: () => void
  ) => {
    callbacks.set(cron, callback);
    return job;
  }) as typeof schedule.scheduleJob);
  const enqueued: ('movie' | 'tv')[] = [];
  t.mock.method(
    runtime,
    'enqueueCatalogueRecent',
    (category: 'movie' | 'tv') => {
      enqueued.push(category);
    }
  );
  const settings = getSettings();
  const previous = settings.jobs['catalogue-recent-movies'].schedule;
  settings.jobs['catalogue-recent-movies'].schedule = '0 */30 * * * *';
  try {
    startJobs();
    const count = scheduledJobs.length;
    startJobs();
    assert.equal(scheduledJobs.length, count);
    const catalogue = scheduledJobs.filter((j) =>
      j.id.startsWith('catalogue-')
    );
    assert.equal(catalogue.length, 2);
    assert.equal(catalogue[0].cronSchedule, '0 */30 * * * *');
    assert.equal(catalogue[1].cronSchedule, '10 */15 * * * *');
    callbacks.get(catalogue[0].cronSchedule)!();
    callbacks.get(catalogue[1].cronSchedule)!();
    assert.deepEqual(enqueued, ['movie', 'tv']);
    assert.ok(scheduledJobs.some((j) => j.id === 'radarr-scan'));
    assert.ok(scheduledJobs.some((j) => j.id === 'download-sync'));
  } finally {
    scheduledJobs.splice(0);
    settings.jobs['catalogue-recent-movies'].schedule = previous;
  }
});
