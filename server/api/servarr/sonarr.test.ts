import assert from 'node:assert/strict';
import { afterEach, describe, it, mock } from 'node:test';

import type { AxiosInstance } from 'axios';

import SonarrAPI from '@server/api/servarr/sonarr';

function buildSonarr(): SonarrAPI {
  return new SonarrAPI({ url: 'http://localhost:8989/api/v3', apiKey: 'test' });
}

function getAxios(sonarr: SonarrAPI): AxiosInstance {
  return (sonarr as unknown as { axios: AxiosInstance }).axios;
}

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
