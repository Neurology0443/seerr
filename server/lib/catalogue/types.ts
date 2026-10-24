export type CatalogueEngine = 'sqlite' | 'postgres';
export type MediaIdentity = {
  mediaType: 'movie' | 'tv';
  idNamespace: 'tmdb' | 'tvdb';
  externalId: number;
};

export interface CatalogueTracker {
  id: string;
  name: string;
  connectorType: string;
  enabled: boolean;
}
export interface CatalogueTorrent {
  id: number;
  trackerId: string;
  canonicalGuid: string;
  infohash: string | null;
  releaseName: string;
  size: number | null;
  publishedAt: Date | null;
  seeders: number | null;
  leechers: number | null;
  firstSeenAt: Date;
  lastSeenAt: Date;
  seedersObservedAt: Date | null;
}
export interface CatalogueCategory {
  id: number;
  torrentId: number;
  categoryId: number;
}
export interface CatalogueMediaAssociation extends MediaIdentity {
  id: number;
  torrentId: number;
  identificationStatus: 'resolved' | 'ambiguous' | 'rejected';
  provenance: string;
  parserVersion: string | null;
}
export interface CatalogueCoverage {
  id: number;
  mediaAssociationId: number;
  kind: 'movie' | 'season' | 'episode' | 'range' | 'partial' | 'unknown';
  completeness: 'presumed' | 'verified' | 'incomplete' | 'uncertain';
  seasonNumber: number | null;
  episodeStart: number | null;
  episodeEnd: number | null;
  provenance: string;
}
export interface CatalogueSyncState {
  id: number;
  trackerId: string;
  categoryId: number;
  mode: 'recent' | 'historical';
  checkpoint: string | null;
  phase: string;
  status: 'idle' | 'running' | 'backoff' | 'suspended' | 'error';
  pagesProcessed: number;
  cycleId: string | null;
  lastSuccessfulAt: Date | null;
  lastObservedAt: Date | null;
  updatedAt: Date;
  retryAfterAt: Date | null;
  errorCode: string | null;
  lastHttpStatus: number | null;
}
export interface CatalogueDestinationIndexer {
  id: number;
  arrType: 'radarr' | 'sonarr';
  serverId: number;
  indexerId: number;
  name: string | null;
  observedAt: Date;
  state: 'unverified' | 'verified' | 'stale' | 'error';
}
export interface CatalogueDestinationTrackerLink {
  id: number;
  destinationIndexerId: number;
  trackerId: string;
  observedAt: Date;
  state: 'unverified' | 'verified' | 'ambiguous' | 'disabled';
}
export type ObservedTorrent = Pick<
  CatalogueTorrent,
  'trackerId' | 'canonicalGuid' | 'releaseName'
> &
  Partial<
    Pick<
      CatalogueTorrent,
      'infohash' | 'size' | 'publishedAt' | 'seeders' | 'leechers'
    >
  > & {
    observedAt: Date;
    categories?: number[];
  };
export type SyncCheckpoint = Omit<CatalogueSyncState, 'id'>;
