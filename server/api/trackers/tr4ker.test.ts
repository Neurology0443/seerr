import { getSettings } from '@server/lib/settings';
import logger from '@server/logger';
import { getUserAgent } from '@server/utils/userAgent';
import type {
  AxiosAdapter,
  AxiosResponse,
  InternalAxiosRequestConfig,
} from 'axios';
import { AxiosError } from 'axios';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, it, mock } from 'node:test';
import { inspect } from 'node:util';
import { TrackerAdapterError, parseRetryAfter } from './errors';
import Tr4kerAdapter from './tr4ker';
import type { PageRequest } from './types';

const key = 'P2_API_KEY_SENTINEL';
const fixture = (name: string) =>
  readFileSync(path.join(__dirname, '__fixtures__', name + '.xml'), 'utf8');
const page: PageRequest = { category: 'movie', offset: 387200 };

class TestAdapter extends Tr4kerAdapter {
  installAdapter(adapter: AxiosAdapter) {
    this.axios.defaults.adapter = adapter;
  }
}

function response(
  config: InternalAxiosRequestConfig,
  data = fixture('empty'),
  status = 200,
  headers: Record<string, string> = {}
): AxiosResponse {
  return {
    config,
    data,
    status,
    headers,
    statusText: 'mock response',
    request: {},
  };
}

function adapter(transport: AxiosAdapter) {
  const client = new TestAdapter({ trackerId: 'tr4ker', apiKey: key });
  client.installAdapter(transport);
  return client;
}

describe('TR4KER HTTP contract', () => {
  afterEach(() => mock.restoreAll());

  it('requests caps with query authentication and existing timeout/user-agent conventions', async () => {
    let calls = 0;
    const client = adapter(async (config) => {
      calls++;
      assert.equal(config.baseURL, 'https://tr4ker.net/api/torznab/all');
      assert.equal(config.url, '');
      assert.deepEqual(config.params, { apikey: key, t: 'caps' });
      assert.equal(config.headers.get('X-Api-Key'), undefined);
      assert.equal(config.headers.get('User-Agent'), getUserAgent());
      assert.equal(config.headers.get('Accept'), 'application/xml');
      assert.equal(config.timeout, getSettings().network.apiRequestTimeout);
      assert.equal(config.maxRedirects, 0);
      return response(config, fixture('caps'));
    });
    assert.equal(calls, 0);
    const capabilities = await client.getCapabilities();
    assert.equal(calls, 1);
    assert.equal(capabilities.advertised.limits.max, 100);
  });

  it('accepts injected endpoint, tracker identity and timeout without persisting configuration', async () => {
    const client = new TestAdapter({
      trackerId: 'test-tracker',
      apiKey: key,
      endpoint: 'https://fixture.invalid/api/torznab/all',
      timeout: 1234,
    });
    client.installAdapter(async (config) => {
      assert.equal(config.baseURL, 'https://fixture.invalid/api/torznab/all');
      assert.equal(config.timeout, 1234);
      return response(config);
    });
    const result = await client.fetchRecentPage(page);
    assert.equal(result.trackerId, 'test-tracker');
    assert.doesNotMatch(JSON.stringify(result), /SENTINEL|fixture.invalid/);
  });

  for (const method of ['fetchRecentPage', 'fetchHistoricalPage'] as const) {
    for (const [category, cat] of [
      ['movie', 2000],
      ['tv', 5000],
    ] as const) {
      it(`${method} fetches only the requested ${category} offset with t=search`, async () => {
        let calls = 0;
        const client = adapter(async (config) => {
          calls++;
          assert.deepEqual(config.params, {
            apikey: key,
            t: 'search',
            cat,
            offset: 387280,
            limit: 60,
          });
          return response(config, fixture('results'));
        });
        const before = Date.now();
        const result = await client[method]({
          category,
          offset: 387280,
          limit: 60,
        });
        assert.equal(calls, 1);
        assert.equal(result.offset, 387280);
        assert.equal(result.limit, 60);
        assert.equal(result.category, category);
        assert.equal(result.records.length, 5);
        assert.ok(
          result.observedAt.getTime() >= before &&
            result.observedAt.getTime() <= Date.now()
        );
        assert.ok(
          result.records.every(
            (record) =>
              record.observedAt.getTime() === result.observedAt.getTime()
          )
        );
      });
    }
  }

  it('uses default limit 100 and fresh responses on identical repeated requests', async () => {
    let calls = 0;
    const client = adapter(async (config) => {
      assert.equal(config.params.limit, 100);
      assert.equal(config.headers.get('Cache-Control'), 'no-cache');
      calls++;
      return response(
        config,
        fixture('results').replace(
          'name="seeders" value="0"',
          `name="seeders" value="${calls - 1}"`
        )
      );
    });
    assert.equal((await client.fetchRecentPage(page)).records[0].seeders, 0);
    assert.equal((await client.fetchRecentPage(page)).records[0].seeders, 1);
    assert.equal(calls, 2);
  });

  it('returns safe contract drift diagnostics from the adapter without retries or persistence', async () => {
    const good =
      '<item><guid>https://tr4ker.net/torrent/Secret-Invasion-S01E01</guid><title>Secret: Invasion S01E01</title></item>';
    const bad = `<item><guid>https://other.invalid/passkey/${key}/42</guid><title>REJECTED_TITLE</title><link>https://tr4ker.net/download?apikey=${key}</link></item>`;
    let calls = 0;
    const client = adapter(async (config) => {
      calls++;
      return response(
        config,
        `<rss><channel>${calls === 1 ? good + bad : bad}</channel></rss>`
      );
    });
    const partial = await client.fetchRecentPage(page);
    assert.equal(calls, 1);
    assert.equal(partial.contractStatus, 'partial');
    assert.equal(partial.records.length, 1);
    assert.equal(partial.records[0].releaseName, 'Secret: Invasion S01E01');
    assert.equal(partial.receivedCount, 2);
    assert.deepEqual(partial.anomalies, [
      { itemIndex: 1, code: 'contract_incompatible', field: 'canonicalGuid' },
    ]);
    const incompatible = await client.fetchHistoricalPage({
      category: 'tv',
      offset: 80,
    });
    assert.equal(calls, 2);
    assert.equal(incompatible.contractStatus, 'incompatible');
    assert.deepEqual(incompatible.records, []);
    assert.equal(incompatible.receivedCount, 1);
    assert.equal(incompatible.category, 'tv');
    assert.equal(incompatible.offset, 80);
    assert.ok(Number.isFinite(incompatible.observedAt.getTime()));
    assert.deepEqual(incompatible.anomalies, [
      { itemIndex: 0, code: 'contract_incompatible', field: 'canonicalGuid' },
    ]);
    for (const result of [partial, incompatible]) {
      assert.doesNotMatch(
        JSON.stringify(result),
        /SENTINEL|REJECTED_TITLE|download|Axios/
      );
      assert.equal('checkpoint' in result, false);
      assert.equal('suspended' in result, false);
    }
  });

  it('returns all records even beyond the declared total and does not paginate itself', async () => {
    let calls = 0;
    const client = adapter(async (config) => {
      calls++;
      return response(config, fixture('results'));
    });
    const result = await client.fetchHistoricalPage({
      ...page,
      offset: 400000,
    });
    assert.equal(result.records.length, 5);
    assert.equal(result.receivedCount, 7);
    assert.equal(result.offset, 400000);
    assert.equal(calls, 1);
    assert.equal('total' in result, false);
  });

  for (const invalid of [
    { limit: 0 },
    { limit: -1 },
    { limit: 101 },
    { limit: 1.5 },
    { limit: NaN },
    { limit: Infinity },
    { limit: null },
    { offset: -1 },
    { offset: 0.5 },
    { offset: NaN },
    { offset: Number.MAX_SAFE_INTEGER + 1 },
    { category: 'invalid' },
    { category: 'movie,tv' },
  ]) {
    it(`rejects invalid page parameters before transport: ${JSON.stringify(invalid)}`, async () => {
      let calls = 0;
      const client = adapter(async (config) => {
        calls++;
        return response(config);
      });
      for (const method of [
        'fetchRecentPage',
        'fetchHistoricalPage',
      ] as const) {
        await assert.rejects(
          async () => client[method]({ ...page, ...invalid } as PageRequest),
          (error) =>
            error instanceof TrackerAdapterError &&
            error.code === 'invalid_request'
        );
      }
      assert.equal(calls, 0);
    });
  }

  it('rejects unsafe configuration with a static credential-free error', () => {
    for (const config of [
      { endpoint: `https://user:${key}@fixture.invalid/all` },
      { endpoint: `https://fixture.invalid/all?apikey=${key}` },
      { endpoint: 'http://fixture.invalid/all' },
      { apiKey: '' },
      { trackerId: key },
      { timeout: -1 },
    ]) {
      assert.throws(
        () =>
          new Tr4kerAdapter({ trackerId: 'tr4ker', apiKey: key, ...config }),
        (error) => {
          assert.ok(error instanceof TrackerAdapterError);
          assert.equal(error.code, 'invalid_configuration');
          assert.doesNotMatch(inspect(error), /P2_API_KEY_SENTINEL/);
          return true;
        }
      );
    }
  });
});

describe('TR4KER safe errors', () => {
  afterEach(() => mock.restoreAll());

  for (const test of [
    { status: 401, code: 'authentication', retryable: false },
    { status: 403, code: 'authentication', retryable: false },
    {
      status: 429,
      code: 'rate_limited',
      retryable: true,
      retryAfter: '120',
      expected: { seconds: 120 },
    },
    {
      status: 429,
      code: 'rate_limited',
      retryable: true,
      retryAfter: 'Sun, 25 Oct 2026 12:00:00 GMT',
      expected: { date: '2026-10-25T12:00:00.000Z' },
    },
    { status: 429, code: 'rate_limited', retryable: true },
    { status: 429, code: 'rate_limited', retryable: true, retryAfter: key },
    { status: 503, code: 'service_unavailable', retryable: true },
    { status: 500, code: 'http_error', retryable: true },
    { status: 404, code: 'http_error', retryable: false },
    { status: 302, code: 'http_error', retryable: false },
  ]) {
    it(`classifies HTTP ${test.status} with Retry-After ${test.retryAfter ?? 'absent'}`, async () => {
      let calls = 0;
      const client = adapter(async (config) => {
        calls++;
        const upstream = response(
          config,
          key,
          test.status,
          test.retryAfter ? { 'retry-after': test.retryAfter } : {}
        );
        throw new AxiosError(
          `URL?apikey=${key}`,
          'ERR_BAD_RESPONSE',
          config,
          { secret: key },
          upstream
        );
      });
      await assert.rejects(client.fetchRecentPage(page), (error) => {
        assert.ok(error instanceof TrackerAdapterError);
        assert.equal(error.code, test.code);
        assert.equal(error.retryable, test.retryable);
        assert.equal(error.httpStatus, test.status);
        assert.deepEqual(error.retryAfter, test.expected ?? null);
        assert.doesNotMatch(
          JSON.stringify(error) + inspect(error),
          new RegExp(key)
        );
        assert.equal('cause' in error, false);
        assert.equal('config' in error, false);
        return true;
      });
      assert.equal(calls, 1);
    });
  }

  for (const code of [
    'ECONNABORTED',
    'ETIMEDOUT',
    'ECONNRESET',
    'ENOTFOUND',
    undefined,
  ]) {
    it(`classifies ${code ?? 'untyped'} transport errors without serializing Axios metadata`, async () => {
      const logs = ['log', 'error', 'warn', 'info', 'debug'].map((method) =>
        mock.method(logger, method as 'error')
      );
      const client = adapter(async (config) => {
        throw new AxiosError(
          `${key} https://fixture.invalid/?apikey=${key}`,
          code,
          config,
          { secret: key }
        );
      });
      await assert.rejects(client.fetchHistoricalPage(page), (error) => {
        assert.ok(error instanceof TrackerAdapterError);
        assert.equal(
          error.code,
          code === 'ECONNABORTED' || code === 'ETIMEDOUT'
            ? 'timeout'
            : 'transport'
        );
        assert.equal(error.retryable, true);
        assert.equal(error.httpStatus, null);
        assert.doesNotMatch(
          JSON.stringify(error) + inspect(error),
          new RegExp(key)
        );
        return true;
      });
      assert.ok(logs.every((log) => log.mock.callCount() === 0));
    });
  }

  for (const [xml, code] of [
    ['<rss><channel>', 'invalid_xml'],
    ['<html><body>Bad gateway</body></html>', 'invalid_response'],
    [`<error code="100" description="${key}"/>`, 'torznab_error'],
  ]) {
    it(`classifies HTTP 200 ${code} and keeps diagnostics safe`, async () => {
      const client = adapter(async (config) => response(config, xml));
      await assert.rejects(client.fetchRecentPage(page), (error) => {
        assert.ok(error instanceof TrackerAdapterError);
        assert.equal(error.code, code);
        assert.equal(error.httpStatus, 200);
        assert.doesNotMatch(
          inspect(error) + JSON.stringify(error),
          new RegExp(key)
        );
        return true;
      });
    });
  }

  it('validates Retry-After rather than returning raw header data', () => {
    for (const value of [
      undefined,
      null,
      '-1',
      '1.2',
      '9007199254740992',
      'tomorrow',
      key,
      'Sun, 31 Feb 2026 12:00:00 GMT',
      '120\r\nsecret',
    ])
      assert.equal(parseRetryAfter(value), null);
    assert.deepEqual(parseRetryAfter(' 0 '), { seconds: 0 });
  });
});
