import ExternalAPI from '@server/api/externalapi';
import { getSettings } from '@server/lib/settings';
import axios from 'axios';
import { httpError, TrackerAdapterError } from './errors';
import {
  MAX_XML_BYTES,
  normalizeTorznabPage,
  parseTorznabCapabilities,
} from './torznab';
import type { PageRequest, TrackerAdapter } from './types';

export interface Tr4kerConfig {
  trackerId: string;
  apiKey: string;
  endpoint?: string;
  timeout?: number;
}

const DEFAULT_ENDPOINT = 'https://tr4ker.net/api/torznab/all';
const CATEGORIES = { movie: 2000, tv: 5000 };

function validateConfiguration(config: Tr4kerConfig): string {
  try {
    const endpoint = new URL(config.endpoint ?? DEFAULT_ENDPOINT);
    if (
      endpoint.protocol !== 'https:' ||
      endpoint.username ||
      endpoint.password ||
      endpoint.search ||
      endpoint.hash ||
      !config.apiKey?.trim() ||
      !/^[a-z0-9][a-z0-9._-]{0,127}$/i.test(config.trackerId) ||
      config.trackerId.includes(config.apiKey) ||
      (config.timeout !== undefined &&
        (!Number.isSafeInteger(config.timeout) || config.timeout <= 0))
    )
      throw new Error();
    return endpoint.toString();
  } catch {
    throw new TrackerAdapterError('invalid_configuration');
  }
}

export function validateTr4kerPage(params: PageRequest): Required<PageRequest> {
  if (!params || typeof params !== 'object')
    throw new TrackerAdapterError('invalid_request');
  const limit = params.limit === undefined ? 100 : params.limit;
  if (
    !['movie', 'tv'].includes(params.category) ||
    !Number.isSafeInteger(limit) ||
    limit <= 0 ||
    limit > 100 ||
    !Number.isSafeInteger(params.offset) ||
    params.offset < 0
  )
    throw new TrackerAdapterError('invalid_request');
  return { category: params.category, limit, offset: params.offset };
}

export default class Tr4kerAdapter
  extends ExternalAPI
  implements TrackerAdapter
{
  private readonly trackerId: string;
  private readonly secrets: readonly string[];

  constructor(config: Tr4kerConfig) {
    super(
      validateConfiguration(config),
      { apikey: config.apiKey },
      {
        timeout: config.timeout ?? getSettings().network.apiRequestTimeout,
        headers: {
          Accept: 'application/xml',
          'Content-Type': 'application/xml',
        },
      }
    );
    this.trackerId = config.trackerId;
    this.secrets = [config.apiKey];
  }

  getCapabilities() {
    return this.request({ t: 'caps' }, (xml) =>
      parseTorznabCapabilities(xml, this.trackerId, this.secrets)
    );
  }

  fetchRecentPage(params: PageRequest) {
    return this.fetchSearchPage(params);
  }

  fetchHistoricalPage(params: PageRequest) {
    return this.fetchSearchPage(params);
  }

  private async fetchSearchPage(params: PageRequest) {
    const page = validateTr4kerPage(params);
    return this.request(
      {
        t: 'search',
        cat: CATEGORIES[page.category],
        limit: page.limit,
        offset: page.offset,
      },
      (xml, observedAt) =>
        normalizeTorznabPage(
          xml,
          {
            ...page,
            trackerId: this.trackerId,
            observedAt,
          },
          this.secrets
        )
    );
  }

  private async request<T>(
    params: Record<string, string | number>,
    parse: (xml: string, observedAt: Date) => Promise<T>
  ): Promise<T> {
    let status: number | null = null;
    try {
      // No application cache, retries or redirect forwarding of the API key.
      const response = await this.axios.get<string>('', {
        params,
        responseType: 'text',
        transformResponse: [(data) => data],
        maxRedirects: 0,
        maxContentLength: MAX_XML_BYTES,
        headers: { 'Cache-Control': 'no-cache' },
      });
      status = response.status;
      if (status < 200 || status >= 300)
        throw httpError(status, response.headers['retry-after']);
      const observedAt = new Date();
      return await parse(response.data, observedAt);
    } catch (error: unknown) {
      if (error instanceof TrackerAdapterError) {
        throw new TrackerAdapterError(error.code, error.retryable, {
          httpStatus: error.httpStatus ?? status,
          retryAfter: error.retryAfter,
          apiCode: error.apiCode,
        });
      }
      // Never retain the Axios exception, its cause, config, URL or response body.
      if (axios.isAxiosError(error) && error.response) {
        throw httpError(
          error.response.status,
          error.response.headers['retry-after']
        );
      }
      const code =
        error && typeof error === 'object' && 'code' in error
          ? error.code
          : null;
      throw new TrackerAdapterError(
        code === 'ECONNABORTED' || code === 'ETIMEDOUT'
          ? 'timeout'
          : 'transport',
        true,
        { httpStatus: status }
      );
    }
  }
}
