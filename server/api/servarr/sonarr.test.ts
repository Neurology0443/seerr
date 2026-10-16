import assert from 'node:assert/strict';
import { afterEach, describe, it, mock } from 'node:test';

import axios, { type AxiosInstance } from 'axios';

import SonarrAPI from '@server/api/servarr/sonarr';
import downloadTracker from '@server/lib/downloadtracker';
import { getSettings } from '@server/lib/settings';
import logger from '@server/logger';
import { removalServer } from '@server/test/fixtures/destinationRemoval';

function buildSonarr(): SonarrAPI {
  return new SonarrAPI({ url: 'http://localhost:8989/api/v3', apiKey: 'test' });
}

function getAxios(sonarr: SonarrAPI): AxiosInstance {
  return (sonarr as unknown as { axios: AxiosInstance }).axios;
}

describe('SonarrAPI complete queue pagination', () => {
  afterEach(() => mock.restoreAll());

  it('retains the last complete tracker snapshot when a later page fails', async (t) => {
    const settings = getSettings();
    const previousSonarr = settings.sonarr;
    const previousRadarr = settings.radarr;
    t.after(async () => {
      settings.sonarr = previousSonarr;
      settings.radarr = previousRadarr;
      await downloadTracker.resetDownloadTracker();
    });
    settings.sonarr = [removalServer(1)];
    settings.radarr = [];
    await downloadTracker.resetDownloadTracker();
    let failLaterPage = false;
    let finished: () => void = () => undefined;
    mock.method(logger, 'debug', () => finished());
    mock.method(logger, 'error', () => finished());
    mock.method(
      axios,
      'create',
      () =>
        ({
          interceptors: {
            request: { use: () => 0 },
            response: { use: () => 0 },
          },
          post: async () => ({}),
          get: async (_url: string, config: { params: { page: number } }) => {
            if (failLaterPage && config.params.page === 2)
              throw new Error('later page failed');
            return {
              data: {
                page: 1,
                pageSize: 100,
                totalRecords: failLaterPage ? 101 : 1,
                records: Array.from(
                  { length: failLaterPage ? 100 : 1 },
                  (_, i) => ({
                    ...queueRecord(i + 1),
                    estimatedCompletionTime: '2030-01-01T00:00:00Z',
                  })
                ),
              },
            };
          },
        }) as unknown as AxiosInstance
    );
    const refresh = () =>
      new Promise<void>((resolve) => {
        finished = resolve;
        downloadTracker.updateDownloads();
      });
    await refresh();
    const complete = downloadTracker.getSeriesProgress(1, 7);
    assert.equal(complete.length, 1);
    failLaterPage = true;
    await refresh();
    assert.deepEqual(downloadTracker.getSeriesProgress(1, 7), complete);
  });

  const queueRecord = (id: number) => ({
    id,
    seriesId: 7,
    title: 'Original release title',
    downloadId: 'season-pack',
    size: 100,
    sizeleft: 40,
    episode: { id, seasonNumber: 1, episodeNumber: id },
  });

  for (const [totalRecords, pageSize] of [
    [0, 100],
    [46, 100],
    [100, 100],
    [101, 100],
    [257, 100],
    [46, 10],
  ]) {
    it(`returns all ${totalRecords} records with effective page size ${pageSize}`, async () => {
      const api = buildSonarr();
      const records = Array.from({ length: totalRecords }, (_, index) =>
        queueRecord(index + 1)
      );
      const get = mock.method(
        getAxios(api),
        'get',
        async (
          url: string,
          config: {
            params: { page: number; pageSize: number; includeEpisode: boolean };
          }
        ) => {
          assert.equal(url, '/queue');
          assert.equal(config.params.includeEpisode, true);
          assert.equal(config.params.pageSize, 100);
          const page = config.params.page;
          return {
            data: {
              page,
              pageSize,
              totalRecords,
              records: records.slice((page - 1) * pageSize, page * pageSize),
            },
          };
        }
      );
      assert.deepEqual(await api.getQueue(), records);
      assert.equal(
        get.mock.callCount(),
        Math.max(1, Math.ceil(totalRecords / pageSize))
      );
      assert.deepEqual(
        get.mock.calls.map((call) => call.arguments[1]?.params.page),
        Array.from({ length: get.mock.callCount() }, (_, i) => i + 1)
      );
    });
  }

  it('rejects the entire retrieval if a later page fails, preserving error context', async () => {
    const api = buildSonarr();
    const failure = new Error('later page failed');
    mock.method(
      getAxios(api),
      'get',
      async (_url: string, config: { params: { page: number } }) => {
        if (config.params.page === 2) throw failure;
        return {
          data: {
            page: 1,
            pageSize: 100,
            totalRecords: 101,
            records: Array.from({ length: 100 }, (_, i) => queueRecord(i)),
          },
        };
      }
    );
    await assert.rejects(
      api.getQueue(),
      (error: Error & { cause?: unknown }) => {
        assert.match(
          error.message,
          /\[Sonarr\] Failed to retrieve queue: later page failed/
        );
        assert.equal(error.cause, failure);
        return true;
      }
    );
  });

  for (const invalid of [
    null,
    { pageSize: undefined },
    { pageSize: 0 },
    { pageSize: -1 },
    { pageSize: 1.5 },
    { totalRecords: -1 },
    { totalRecords: Infinity },
    { totalRecords: 1.5 },
    { page: 2 },
    { records: null },
    { records: [{}] },
    { records: [] },
  ]) {
    it(`rejects invalid first-page metadata ${JSON.stringify(invalid)} without looping`, async () => {
      const api = buildSonarr();
      const get = mock.method(getAxios(api), 'get', async () => ({
        data:
          invalid === null
            ? null
            : {
                page: 1,
                pageSize: 100,
                totalRecords: 1,
                records: [queueRecord(1)],
                ...invalid,
              },
      }));
      await assert.rejects(api.getQueue(), /Failed to retrieve queue/);
      assert.equal(get.mock.callCount(), 1);
    });
  }

  for (const invalid of [
    { page: 1 },
    { totalRecords: 201 },
    { pageSize: 50 },
    { records: [] },
    { records: [queueRecord(1)] },
  ]) {
    it(`rejects inconsistent or repeated later pages ${JSON.stringify(invalid)}`, async () => {
      const api = buildSonarr();
      const get = mock.method(
        getAxios(api),
        'get',
        async (_url: string, config: { params: { page: number } }) => ({
          data:
            config.params.page === 1
              ? {
                  page: 1,
                  pageSize: 100,
                  totalRecords: 101,
                  records: Array.from({ length: 100 }, (_, i) =>
                    queueRecord(i + 1)
                  ),
                }
              : {
                  page: 2,
                  pageSize: 100,
                  totalRecords: 101,
                  records: [queueRecord(101)],
                  ...invalid,
                },
        })
      );
      await assert.rejects(api.getQueue(), /Failed to retrieve queue/);
      assert.equal(get.mock.callCount(), 2);
    });
  }
});

describe('SonarrAPI removeSeries', () => {
  afterEach(() => mock.restoreAll());

  it('removes the series when it exists in the library', async () => {
    const sonarr = buildSonarr();
    mock.method(SonarrAPI.prototype, 'getSeriesByTvdbId', async () => ({
      id: 9,
      title: 'Test Series',
    }));
    const del = mock.method(getAxios(sonarr), 'delete', async () => ({}));

    await sonarr.removeSeries(1234);

    assert.strictEqual(del.mock.callCount(), 1);
    assert.strictEqual(del.mock.calls[0].arguments[0], '/series/9');
  });

  it('does nothing when the series is not in the library', async () => {
    const sonarr = buildSonarr();
    mock.method(getAxios(sonarr), 'get', async () => ({
      data: [{ id: 0, title: 'Breaking Bad' }],
    }));
    const del = mock.method(getAxios(sonarr), 'delete', async () => ({}));

    await assert.doesNotReject(() => sonarr.removeSeries(1234));
    assert.strictEqual(del.mock.callCount(), 0);
  });

  it('rejects when the tvdbId is unknown to the lookup', async () => {
    const sonarr = buildSonarr();
    mock.method(getAxios(sonarr), 'get', async () => ({ data: [] }));
    const del = mock.method(getAxios(sonarr), 'delete', async () => ({}));

    await assert.rejects(() => sonarr.removeSeries(1234), /Series not found/);
    assert.strictEqual(del.mock.callCount(), 0);
  });

  it('ignores a 404 when the series was already removed in Sonarr', async () => {
    const sonarr = buildSonarr();
    mock.method(SonarrAPI.prototype, 'getSeriesByTvdbId', async () => ({
      id: 9,
      title: 'Test Series',
    }));
    mock.method(getAxios(sonarr), 'delete', async () => {
      throw { response: { status: 404 } };
    });

    await assert.doesNotReject(() => sonarr.removeSeries(1234));
  });

  it('rethrows errors other than 404', async () => {
    const sonarr = buildSonarr();
    mock.method(SonarrAPI.prototype, 'getSeriesByTvdbId', async () => ({
      id: 9,
      title: 'Test Series',
    }));
    mock.method(getAxios(sonarr), 'delete', async () => {
      throw { response: { status: 500 } };
    });

    await assert.rejects(() => sonarr.removeSeries(1234));
  });

  it('rethrows a 404 from the lookup instead of treating it as removed', async () => {
    const sonarr = buildSonarr();
    mock.method(getAxios(sonarr), 'get', async () => {
      throw { response: { status: 404 } };
    });
    const del = mock.method(getAxios(sonarr), 'delete', async () => ({}));

    await assert.rejects(
      () => sonarr.removeSeries(1234),
      (e: unknown) =>
        (e as { response?: { status?: number } }).response?.status === 404
    );
    assert.strictEqual(del.mock.callCount(), 0);
  });
});

describe('SonarrAPI getSeriesByTvdbId', () => {
  afterEach(() => mock.restoreAll());

  it('rethrows a 401 from the lookup with the status intact', async () => {
    const sonarr = buildSonarr();
    mock.method(getAxios(sonarr), 'get', async () => {
      throw { response: { status: 401 } };
    });

    await assert.rejects(
      () => sonarr.getSeriesByTvdbId(1234),
      (e: unknown) =>
        (e as { response?: { status?: number } }).response?.status === 401
    );
  });

  it('throws "Series not found" when the lookup returns no results', async () => {
    const sonarr = buildSonarr();
    mock.method(getAxios(sonarr), 'get', async () => ({ data: [] }));

    await assert.rejects(() => sonarr.getSeriesByTvdbId(1234), {
      message: 'Series not found',
    });
  });
});

describe('SonarrAPI exact destination removal', () => {
  afterEach(() => mock.restoreAll());

  it('uses and verifies the preferred record before deleting files', async () => {
    const api = buildSonarr();
    const get = mock.method(getAxios(api), 'get', async () => ({
      data: { id: 7, tvdbId: 550 },
    }));
    const del = mock.method(getAxios(api), 'delete', async () => ({}));
    await api.removeSeriesFromDestination(550, 7);
    assert.equal(get.mock.calls[0].arguments[0], '/series/7');
    assert.deepEqual(del.mock.calls[0].arguments, [
      '/series/7',
      { params: { deleteFiles: true, addImportExclusion: false } },
    ]);
  });

  it('rejects a stale linkage to another identity without deleting', async () => {
    const api = buildSonarr();
    mock.method(getAxios(api), 'get', async () => ({
      data: { id: 7, tvdbId: 999 },
    }));
    const del = mock.method(getAxios(api), 'delete', async () => ({}));
    await assert.rejects(
      () => api.removeSeriesFromDestination(550, 7),
      /identity mismatch/
    );
    assert.equal(del.mock.callCount(), 0);
  });

  it('confirms absence using the library after a stale record returns 404', async () => {
    const api = buildSonarr();
    const get = mock.method(getAxios(api), 'get', async (url: string) => {
      if (url === '/series/7') throw { response: { status: 404 } };
      return { data: [] };
    });
    const del = mock.method(getAxios(api), 'delete', async () => ({}));
    await api.removeSeriesFromDestination(550, 7);
    assert.equal(get.mock.callCount(), 2);
    assert.deepEqual(get.mock.calls[1].arguments, [
      '/series',
      { params: { tvdbId: 550 } },
    ]);
    assert.equal(del.mock.callCount(), 0);
  });

  it('uses an authoritative library record when no linkage remains', async () => {
    const api = buildSonarr();
    mock.method(getAxios(api), 'get', async () => ({
      data: [{ id: 9, tvdbId: 550 }],
    }));
    const del = mock.method(getAxios(api), 'delete', async () => ({}));
    await api.removeSeriesFromDestination(550, null);
    assert.equal(del.mock.calls[0].arguments[0], '/series/9');
  });

  it('accepts a DELETE 404 only after record identity is verified', async () => {
    const api = buildSonarr();
    mock.method(getAxios(api), 'get', async () => ({
      data: { id: 7, tvdbId: 550 },
    }));
    mock.method(getAxios(api), 'delete', async () => {
      throw { response: { status: 404 } };
    });
    await assert.doesNotReject(() => api.removeSeriesFromDestination(550, 7));
  });

  for (const data of [
    undefined,
    null,
    {},
    [{ id: 0, tvdbId: 550 }],
    [{ id: 7 }],
    [
      { id: 7, tvdbId: 550 },
      { id: 8, tvdbId: 550 },
    ],
  ]) {
    it(`rejects inconclusive library results ${JSON.stringify(data)}`, async () => {
      const api = buildSonarr();
      mock.method(getAxios(api), 'get', async () => ({ data }));
      const del = mock.method(getAxios(api), 'delete', async () => ({}));
      await assert.rejects(() => api.removeSeriesFromDestination(550, null));
      assert.equal(del.mock.callCount(), 0);
    });
  }

  for (const failure of [
    { code: 'ETIMEDOUT' },
    { code: 'ECONNRESET' },
    ...[401, 403, 404, 500, 503].map((status) => ({ response: { status } })),
  ]) {
    it(`propagates failed library lookups ${JSON.stringify(failure)}`, async () => {
      const api = buildSonarr();
      mock.method(getAxios(api), 'get', async () => {
        throw failure;
      });
      const del = mock.method(getAxios(api), 'delete', async () => ({}));
      await assert.rejects(() => api.removeSeriesFromDestination(550, null));
      assert.equal(del.mock.callCount(), 0);
    });
  }

  for (const failure of [
    { code: 'ETIMEDOUT' },
    { code: 'ECONNRESET' },
    ...[401, 403, 500].map((status) => ({ response: { status } })),
  ]) {
    it(`propagates DELETE failures ${JSON.stringify(failure)}`, async () => {
      const api = buildSonarr();
      mock.method(getAxios(api), 'get', async () => ({
        data: { id: 7, tvdbId: 550 },
      }));
      mock.method(getAxios(api), 'delete', async () => {
        throw failure;
      });
      await assert.rejects(() => api.removeSeriesFromDestination(550, 7));
    });
  }
});
