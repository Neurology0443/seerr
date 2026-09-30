import assert from 'node:assert/strict';
import { before, beforeEach, describe, it } from 'node:test';

import { getRepository } from '@server/datasource';
import OverrideRule from '@server/entity/OverrideRule';
import { getSettings } from '@server/lib/settings';
import { setupTestDb } from '@server/test/db';
import type { Express } from 'express';
import express from 'express';
import request from 'supertest';
import radarrRoutes from './radarr';
import sonarrRoutes from './sonarr';

let app: Express;
setupTestDb();

const payload = (overrides: Record<string, unknown> = {}) => ({
  name: 'Test',
  hostname: 'localhost',
  port: 1234,
  apiKey: 'key',
  useSsl: false,
  activeProfileId: 1,
  activeProfileName: 'Profile',
  activeDirectory: '/media',
  tags: [],
  is4k: false,
  isDefault: false,
  syncEnabled: true,
  preventSearch: false,
  tagRequests: false,
  overrideRule: [],
  minimumAvailability: 'released',
  seriesType: 'standard',
  animeSeriesType: 'anime',
  enableSeasonFolders: true,
  monitorNewItems: 'all',
  ...overrides,
});

before(() => {
  app = express();
  app.use(express.json());
  app.use('/settings/radarr', radarrRoutes);
  app.use('/settings/sonarr', sonarrRoutes);
  app.use(
    (
      err: { status?: number; message?: string },
      _req: express.Request,
      res: express.Response,
      _next: express.NextFunction
    ) => {
      void _next;
      return res.status(err.status ?? 500).json({ message: err.message });
    }
  );
});

beforeEach(() => {
  const settings = getSettings();
  settings.radarr = [];
  settings.sonarr = [];
  settings.nextServiceIds = { radarr: 0, sonarr: 0 };
});

for (const type of ['radarr', 'sonarr'] as const) {
  describe(`${type} settings target invariants`, () => {
    it('rejects invalid labelled POST payloads without mutation', async () => {
      for (const invalid of [
        { buttonLabel: 'Deutsch', isDefault: true },
        { buttonLabel: 'Deutsch', syncEnabled: false },
        { buttonLabel: 123 },
      ]) {
        const beforeState = structuredClone(getSettings()[type]);
        await request(app)
          .post(`/settings/${type}`)
          .send(payload(invalid))
          .expect(400);
        assert.deepEqual(getSettings()[type], beforeState);
      }
    });

    it('creates valid labelled and whitespace-native targets', async () => {
      const labelled = await request(app)
        .post(`/settings/${type}`)
        .send(payload({ buttonLabel: ' Deutsch ' }))
        .expect(201);
      assert.equal(labelled.body.buttonLabel, 'Deutsch');

      const native = await request(app)
        .post(`/settings/${type}`)
        .send(payload({ buttonLabel: '   ' }))
        .expect(201);
      assert.equal(native.body.buttonLabel, undefined);
    });

    it('blocks referenced role and quality changes without mutation', async () => {
      const settings = getSettings();
      settings[type] = [payload({ id: 7, syncEnabled: true }) as never];
      await getRepository(OverrideRule).save(
        new OverrideRule(
          type === 'radarr' ? { radarrServiceId: 7 } : { sonarrServiceId: 7 }
        )
      );

      for (const change of [{ buttonLabel: 'Deutsch' }, { is4k: true }]) {
        const beforeState = structuredClone(settings[type]);
        await request(app)
          .put(`/settings/${type}/7`)
          .send(payload({ id: 7, ...change }))
          .expect(409);
        assert.deepEqual(settings[type], beforeState);
      }
    });

    it('rejects a non-string PUT label without mutation', async () => {
      const settings = getSettings();
      settings[type] = [payload({ id: 11, isDefault: true }) as never];
      const beforeState = structuredClone(settings[type]);
      await request(app)
        .put(`/settings/${type}/11`)
        .send(payload({ id: 11, buttonLabel: 123, isDefault: true }))
        .expect(400);
      assert.deepEqual(settings[type], beforeState);
    });

    it('blocks reverse referenced role and quality changes', async () => {
      const settings = getSettings();
      settings[type] = [
        payload({ id: 8, buttonLabel: 'Deutsch', is4k: true }) as never,
      ];
      await getRepository(OverrideRule).save(
        new OverrideRule(
          type === 'radarr' ? { radarrServiceId: 8 } : { sonarrServiceId: 8 }
        )
      );
      await request(app)
        .put(`/settings/${type}/8`)
        .send(payload({ id: 8, is4k: true }))
        .expect(409);
      await request(app)
        .put(`/settings/${type}/8`)
        .send(payload({ id: 8, buttonLabel: 'Deutsch', is4k: false }))
        .expect(409);
    });

    it('allows non-structural edits to referenced targets', async () => {
      const settings = getSettings();
      settings[type] = [payload({ id: 9, buttonLabel: 'Deutsch' }) as never];
      await getRepository(OverrideRule).save(
        new OverrideRule(
          type === 'radarr' ? { radarrServiceId: 9 } : { sonarrServiceId: 9 }
        )
      );
      const response = await request(app)
        .put(`/settings/${type}/9`)
        .send(
          payload({
            id: 9,
            buttonLabel: 'German',
            hostname: 'new-host',
            apiKey: 'new-key',
          })
        )
        .expect(200);
      assert.equal(response.body.buttonLabel, 'German');
      assert.equal(response.body.hostname, 'new-host');
      assert.equal(response.body.apiKey, 'new-key');
    });

    it('allows role changes without references', async () => {
      const settings = getSettings();
      settings[type] = [payload({ id: 10 }) as never];
      await request(app)
        .put(`/settings/${type}/10`)
        .send(payload({ id: 10, buttonLabel: 'Deutsch' }))
        .expect(200);
      await request(app)
        .put(`/settings/${type}/10`)
        .send(payload({ id: 10 }))
        .expect(200);
    });

    it('deletes an unreferenced target', async () => {
      const settings = getSettings();
      settings[type] = [payload({ id: 12 }) as never];

      await request(app).delete(`/settings/${type}/12`).expect(200);
      assert.deepEqual(settings[type], []);
    });

    it('refuses to delete a referenced target without mutation', async () => {
      const settings = getSettings();
      settings[type] = [payload({ id: 13 }) as never];
      await getRepository(OverrideRule).save(
        new OverrideRule(
          type === 'radarr' ? { radarrServiceId: 13 } : { sonarrServiceId: 13 }
        )
      );
      const beforeState = structuredClone(settings[type]);

      await request(app).delete(`/settings/${type}/13`).expect(409);
      assert.deepEqual(settings[type], beforeState);
    });
  });
}
