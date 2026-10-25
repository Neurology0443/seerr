import type { ObservedTorrent } from '@server/lib/catalogue/types';

export interface PageRequest {
  category: 'movie' | 'tv';
  offset: number;
  limit?: number;
}

export interface TrackerPageContext extends Required<PageRequest> {
  trackerId: string;
  observedAt: Date;
}

export type TorrentField =
  | 'trackerId'
  | 'canonicalGuid'
  | 'infohash'
  | 'releaseName'
  | 'categories'
  | 'size'
  | 'publishedAt'
  | 'seeders'
  | 'leechers'
  | 'tmdbId'
  | 'tvdbId'
  | 'season'
  | 'episode'
  | 'observedAt';

export interface FieldOrigin {
  source: 'configuration' | 'tracker' | 'application';
  field: string;
}

// Structurally compatible with P1 writes. These IDs are tracker claims, not
// resolved media associations. P1 owns first/last-seen and seeder freshness.
export type NormalizedTrackerTorrent = Required<
  Omit<ObservedTorrent, 'categories'>
> &
  Pick<ObservedTorrent, 'categories'> & {
    trackerMetadata: {
      tmdbId: number | null;
      tvdbId: number | null;
      season: number | null;
      episode: number | null;
    };
    provenance: Partial<Record<TorrentField, FieldOrigin>>;
  };

export interface TrackerAnomaly {
  itemIndex: number;
  code:
    | 'invalid_identity'
    | 'contract_incompatible'
    | 'invalid_field'
    | 'conflicting_field'
    | 'identity_conflict';
  field: TorrentField;
}

export interface NormalizedTrackerPage extends TrackerPageContext {
  records: NormalizedTrackerTorrent[];
  anomalies: TrackerAnomaly[];
  receivedCount: number;
  // Describes only this response's critical field structure, not scan coverage.
  contractStatus: 'compatible' | 'partial' | 'incompatible';
}

export interface TrackerCapabilities {
  trackerId: string;
  advertised: {
    limits: { default: number | null; max: number | null };
    categories: { id: number; name: string | null; parentId: number | null }[];
    operations: {
      name: string;
      available: boolean;
      parameters: string[];
    }[];
  };
}

export interface TrackerAdapter {
  getCapabilities(): Promise<TrackerCapabilities>;
  fetchRecentPage(params: PageRequest): Promise<NormalizedTrackerPage>;
  fetchHistoricalPage(params: PageRequest): Promise<NormalizedTrackerPage>;
}
