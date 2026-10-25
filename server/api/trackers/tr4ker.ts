import { getSettings } from '@server/lib/settings';
import { TrackerAdapterError } from './errors';
import { TorznabAPI } from './torznab';
import type { PageRequest, TrackerAdapter } from './types';

export interface Tr4kerConfig {
  trackerId: string;
  apiKey: string;
  endpoint?: string;
  timeout?: number;
}

export const TR4KER_CONTRACT = {
  endpoint: 'https://tr4ker.net/api/torznab/all',
  categories: { movie: 2000, tv: 5000 },
  authenticationQueryParameter: 'apikey',
  // GUID and title are required. The engine projects only these scalar fields
  // and attributes. Comments, download links and enclosures are never read.
  fields: ['guid', 'title', 'pubDate', 'size'],
  attributes: [
    'category',
    'infohash',
    'size',
    'seeders',
    'leechers',
    'tmdbid',
    'tvdbid',
    'season',
    'episode',
  ],
  canonicalizeGuid(value: string): string | null {
    try {
      const url = new URL(value);
      if (
        url.protocol !== 'https:' ||
        url.hostname !== 'tr4ker.net' ||
        url.port ||
        url.username ||
        url.password ||
        value.includes('?') ||
        value.includes('#') ||
        !/^\/torrent\/[a-z0-9]+(?:-[a-z0-9]+)+$/i.test(url.pathname) ||
        url.href !== value
      )
        return null;
      return value;
    } catch {
      return null;
    }
  },
};

function validateConfiguration(config: Tr4kerConfig): string {
  try {
    const configuredEndpoint = config.endpoint ?? TR4KER_CONTRACT.endpoint;
    const endpoint = new URL(configuredEndpoint);
    // Compare every URL component through its canonical serialization, and
    // reject overrides normalized by URL (default ports, dot segments, etc.).
    if (
      endpoint.href !== TR4KER_CONTRACT.endpoint ||
      endpoint.href !== configuredEndpoint ||
      !config.apiKey?.trim() ||
      !/^[a-z0-9][a-z0-9._-]{0,127}$/i.test(config.trackerId) ||
      config.trackerId.includes(config.apiKey) ||
      (config.timeout !== undefined &&
        (!Number.isSafeInteger(config.timeout) || config.timeout <= 0))
    )
      throw new Error();
    return TR4KER_CONTRACT.endpoint;
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
  extends TorznabAPI
  implements TrackerAdapter
{
  constructor(config: Tr4kerConfig) {
    super({
      endpoint: validateConfiguration(config),
      trackerId: config.trackerId,
      parameters: {
        [TR4KER_CONTRACT.authenticationQueryParameter]: config.apiKey,
      },
      timeout: config.timeout ?? getSettings().network.apiRequestTimeout,
      contract: TR4KER_CONTRACT,
      secrets: [config.apiKey],
    });
  }

  fetchRecentPage(params: PageRequest) {
    return this.fetchPage(params);
  }
  fetchHistoricalPage(params: PageRequest) {
    return this.fetchPage(params);
  }

  private async fetchPage(params: PageRequest) {
    const page = validateTr4kerPage(params);
    return this.fetchSearchPage(
      page,
      TR4KER_CONTRACT.categories[page.category]
    );
  }
}
