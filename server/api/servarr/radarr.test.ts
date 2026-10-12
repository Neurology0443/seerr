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
