import assert from 'node:assert/strict';
import { before, beforeEach, describe, it, mock } from 'node:test';

import type { RadarrSettings, SonarrSettings } from '@server/lib/settings';
import { getSettings } from '@server/lib/settings';
import type { AxiosInstance } from 'axios';
import axios from 'axios';
import type { Express } from 'express';
import express from 'express';
import request from 'supertest';
import serviceRoutes from './service';

mock.method(
  axios,
  'create',
  () =>
    ({
      interceptors: { request: { use: () => 0 } },
      get: async (endpoint: string) => ({
        data: endpoint === '/system/status' ? { version: '4.0.0' } : [],
      }),
    }) as unknown as AxiosInstance
);

const radarr = (
  id: number,
  independentRequestDestination: boolean
): RadarrSettings =>
  ({
    id,
    name: `Radarr ${id}`,
    hostname: 'localhost',
    port: 7878,
    apiKey: 'test',
    useSsl: false,
    activeProfileId: 1,
    activeProfileName: 'Any',
    activeDirectory: '/movies',
    is4k: false,
    minimumAvailability: 'released',
    isDefault: id === 1,
    syncEnabled: true,
    independentRequestDestination,
    preventSearch: false,
    tagRequests: false,
    tags: [],
    overrideRule: [],
  }) as RadarrSettings;

const sonarr = (
  id: number,
  independentRequestDestination: boolean
): SonarrSettings =>
  ({
    id,
    name: `Sonarr ${id}`,
    hostname: 'localhost',
    port: 8989,
    apiKey: 'test',
    useSsl: false,
    activeProfileId: 1,
    activeProfileName: 'Any',
    activeDirectory: '/tv',
    is4k: false,
    isDefault: id === 1,
    syncEnabled: true,
    independentRequestDestination,
    preventSearch: false,
    tagRequests: false,
    enableSeasonFolders: true,
    seriesType: 'standard',
    animeSeriesType: 'anime',
    monitorNewItems: 'all',
    tags: [],
    animeTags: [],
    overrideRule: [],
  }) as SonarrSettings;

let app: Express;

before(() => {
  app = express();
  app.use('/service', serviceRoutes);
});

beforeEach(() => {
  getSettings().radarr = [radarr(1, false), radarr(2, true)];
  getSettings().sonarr = [sonarr(1, false), sonarr(2, true)];
});

describe('service common server destination role', () => {
  for (const kind of ['radarr', 'sonarr'] as const) {
    it(`exposes the ${kind} independent flag in list and detail responses`, async () => {
      const list = await request(app).get(`/service/${kind}`);
      const native = list.body.find(
        (server: { id: number }) => server.id === 1
      );
      const independent = list.body.find(
        (server: { id: number }) => server.id === 2
      );

      assert.strictEqual(list.status, 200);
      assert.strictEqual(native.independentRequestDestination, false);
      assert.strictEqual(independent.independentRequestDestination, true);

      const detail = await request(app).get(`/service/${kind}/2`);
      assert.strictEqual(detail.status, 200);
      assert.strictEqual(
        detail.body.server.independentRequestDestination,
        true
      );
    });
  }
});
