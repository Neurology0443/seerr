import assert from 'node:assert/strict';
import { afterEach, describe, it, mock } from 'node:test';

import type { AxiosInstance } from 'axios';

import RadarrAPI from '@server/api/servarr/radarr';

function buildRadarr(): RadarrAPI {
  return new RadarrAPI({ url: 'http://localhost:7878/api/v3', apiKey: 'test' });
}

function getAxios(radarr: RadarrAPI): AxiosInstance {
  return (radarr as unknown as { axios: AxiosInstance }).axios;
}

describe('RadarrAPI complete queue pagination', () => {
  afterEach(() => mock.restoreAll());

  const queueRecord = (id: number) => ({
    id,
    movieId: 7,
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
      const api = buildRadarr();
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
    const api = buildRadarr();
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
          /\[Radarr\] Failed to retrieve queue: later page failed/
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
      const api = buildRadarr();
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
      const api = buildRadarr();
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

describe('RadarrAPI removeMovie', () => {
  afterEach(() => mock.restoreAll());

  it('removes the movie when it exists in the library', async () => {
    const radarr = buildRadarr();
    mock.method(RadarrAPI.prototype, 'getMovieByTmdbId', async () => ({
      id: 7,
      title: 'Test Movie',
    }));
    const del = mock.method(getAxios(radarr), 'delete', async () => ({}));

    await radarr.removeMovie(550);

    assert.strictEqual(del.mock.callCount(), 1);
    assert.strictEqual(del.mock.calls[0].arguments[0], '/movie/7');
  });

  it('does nothing when the movie is not in the library', async () => {
    const radarr = buildRadarr();
    mock.method(getAxios(radarr), 'get', async () => ({
      data: [{ id: 0, title: 'Fight Club' }],
    }));
    const del = mock.method(getAxios(radarr), 'delete', async () => ({}));

    await assert.doesNotReject(() => radarr.removeMovie(550));
    assert.strictEqual(del.mock.callCount(), 0);
  });

  it('rejects when the tmdbId is unknown to the lookup', async () => {
    const radarr = buildRadarr();
    mock.method(getAxios(radarr), 'get', async () => ({ data: [] }));
    const del = mock.method(getAxios(radarr), 'delete', async () => ({}));

    await assert.rejects(() => radarr.removeMovie(550), /Movie not found/);
    assert.strictEqual(del.mock.callCount(), 0);
  });

  it('ignores a 404 when the movie was already removed in Radarr', async () => {
    const radarr = buildRadarr();
    mock.method(RadarrAPI.prototype, 'getMovieByTmdbId', async () => ({
      id: 7,
      title: 'Test Movie',
    }));
    mock.method(getAxios(radarr), 'delete', async () => {
      throw { response: { status: 404 } };
    });

    await assert.doesNotReject(() => radarr.removeMovie(550));
  });

  it('rethrows errors other than 404', async () => {
    const radarr = buildRadarr();
    mock.method(RadarrAPI.prototype, 'getMovieByTmdbId', async () => ({
      id: 7,
      title: 'Test Movie',
    }));
    mock.method(getAxios(radarr), 'delete', async () => {
      throw { response: { status: 500 } };
    });

    await assert.rejects(() => radarr.removeMovie(550));
  });

  it('rethrows a 404 from the lookup instead of treating it as removed', async () => {
    const radarr = buildRadarr();
    mock.method(getAxios(radarr), 'get', async () => {
      throw { response: { status: 404 } };
    });
    const del = mock.method(getAxios(radarr), 'delete', async () => ({}));

    await assert.rejects(
      () => radarr.removeMovie(550),
      (e: unknown) =>
        (e as { response?: { status?: number } }).response?.status === 404
    );
    assert.strictEqual(del.mock.callCount(), 0);
  });
});

describe('RadarrAPI getMovieByTmdbId', () => {
  afterEach(() => mock.restoreAll());

  it('rethrows a 401 from the lookup with the status intact', async () => {
    const radarr = buildRadarr();
    mock.method(getAxios(radarr), 'get', async () => {
      throw { response: { status: 401 } };
    });

    await assert.rejects(
      () => radarr.getMovieByTmdbId(550),
      (e: unknown) =>
        (e as { response?: { status?: number } }).response?.status === 401
    );
  });

  it('throws "Movie not found" when the lookup returns no results', async () => {
    const radarr = buildRadarr();
    mock.method(getAxios(radarr), 'get', async () => ({ data: [] }));

    await assert.rejects(() => radarr.getMovieByTmdbId(550), {
      message: 'Movie not found',
    });
  });
});

describe('RadarrAPI exact destination removal', () => {
  afterEach(() => mock.restoreAll());

  it('uses and verifies the preferred record before deleting files', async () => {
    const api = buildRadarr();
    const get = mock.method(getAxios(api), 'get', async () => ({
      data: { id: 7, tmdbId: 550 },
    }));
    const del = mock.method(getAxios(api), 'delete', async () => ({}));
    await api.removeMovieFromDestination(550, 7);
    assert.equal(get.mock.calls[0].arguments[0], '/movie/7');
    assert.deepEqual(del.mock.calls[0].arguments, [
      '/movie/7',
      { params: { deleteFiles: true, addImportExclusion: false } },
    ]);
  });

  it('rejects a stale linkage to another identity without deleting', async () => {
    const api = buildRadarr();
    mock.method(getAxios(api), 'get', async () => ({
      data: { id: 7, tmdbId: 999 },
    }));
    const del = mock.method(getAxios(api), 'delete', async () => ({}));
    await assert.rejects(
      () => api.removeMovieFromDestination(550, 7),
      /identity mismatch/
    );
    assert.equal(del.mock.callCount(), 0);
  });

  it('confirms absence using the library after a stale record returns 404', async () => {
    const api = buildRadarr();
    const get = mock.method(getAxios(api), 'get', async (url: string) => {
      if (url === '/movie/7') throw { response: { status: 404 } };
      return { data: [] };
    });
    const del = mock.method(getAxios(api), 'delete', async () => ({}));
    await api.removeMovieFromDestination(550, 7);
    assert.equal(get.mock.callCount(), 2);
    assert.deepEqual(get.mock.calls[1].arguments, [
      '/movie',
      { params: { tmdbId: 550 } },
    ]);
    assert.equal(del.mock.callCount(), 0);
  });

  it('uses an authoritative library record when no linkage remains', async () => {
    const api = buildRadarr();
    mock.method(getAxios(api), 'get', async () => ({
      data: [{ id: 9, tmdbId: 550 }],
    }));
    const del = mock.method(getAxios(api), 'delete', async () => ({}));
    await api.removeMovieFromDestination(550, null);
    assert.equal(del.mock.calls[0].arguments[0], '/movie/9');
  });

  it('accepts a DELETE 404 only after record identity is verified', async () => {
    const api = buildRadarr();
    mock.method(getAxios(api), 'get', async () => ({
      data: { id: 7, tmdbId: 550 },
    }));
    mock.method(getAxios(api), 'delete', async () => {
      throw { response: { status: 404 } };
    });
    await assert.doesNotReject(() => api.removeMovieFromDestination(550, 7));
  });

  for (const data of [
    undefined,
    null,
    {},
    [{ id: 0, tmdbId: 550 }],
    [{ id: 7 }],
    [
      { id: 7, tmdbId: 550 },
      { id: 8, tmdbId: 550 },
    ],
  ]) {
    it(`rejects inconclusive library results ${JSON.stringify(data)}`, async () => {
      const api = buildRadarr();
      mock.method(getAxios(api), 'get', async () => ({ data }));
      const del = mock.method(getAxios(api), 'delete', async () => ({}));
      await assert.rejects(() => api.removeMovieFromDestination(550, null));
      assert.equal(del.mock.callCount(), 0);
    });
  }

  for (const failure of [
    { code: 'ETIMEDOUT' },
    { code: 'ECONNRESET' },
    ...[401, 403, 404, 500, 503].map((status) => ({ response: { status } })),
  ]) {
    it(`propagates failed library lookups ${JSON.stringify(failure)}`, async () => {
      const api = buildRadarr();
      mock.method(getAxios(api), 'get', async () => {
        throw failure;
      });
      const del = mock.method(getAxios(api), 'delete', async () => ({}));
      await assert.rejects(() => api.removeMovieFromDestination(550, null));
      assert.equal(del.mock.callCount(), 0);
    });
  }

  for (const failure of [
    { code: 'ETIMEDOUT' },
    { code: 'ECONNRESET' },
    ...[401, 403, 500].map((status) => ({ response: { status } })),
  ]) {
    it(`propagates DELETE failures ${JSON.stringify(failure)}`, async () => {
      const api = buildRadarr();
      mock.method(getAxios(api), 'get', async () => ({
        data: { id: 7, tmdbId: 550 },
      }));
      mock.method(getAxios(api), 'delete', async () => {
        throw failure;
      });
      await assert.rejects(() => api.removeMovieFromDestination(550, 7));
    });
  }
});
