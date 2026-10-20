import type { RadarrMovie } from '@server/api/servarr/radarr';
import RadarrAPI from '@server/api/servarr/radarr';
import { MediaStatus, MediaType } from '@server/constants/media';
import { getRepository } from '@server/datasource';
import Media from '@server/entity/Media';
import {
  findIndependentDestinationCandidates,
  markMissingMovieDestination,
  notifyAvailableRequests,
  notifyDeclinedRequests,
  updateIndependentMovieDestination,
} from '@server/lib/destinationAvailability';
import type {
  RunnableScanner,
  StatusBase,
} from '@server/lib/scanners/baseScanner';
import BaseScanner from '@server/lib/scanners/baseScanner';
import type { RadarrSettings } from '@server/lib/settings';
import { getSettings } from '@server/lib/settings';
import { findAmbiguousIndependentDvrServerIds } from '@server/lib/settings/dvrValidation';
import {
  beginDestinationScan,
  withDestinationOperationLock,
} from '@server/utils/destinationOperationLock';
import { withDvrIdentityLock } from '@server/utils/dvrIdentityLock';
import { uniqWith } from 'lodash';

type SyncStatus = StatusBase & {
  currentServer: RadarrSettings;
  servers: RadarrSettings[];
};

class RadarrScanner
  extends BaseScanner<RadarrMovie>
  implements RunnableScanner<SyncStatus>
{
  private servers: RadarrSettings[];
  private currentServer: RadarrSettings;
  private radarrApi: RadarrAPI;
  private scannedTmdbIds: Set<number> = new Set();
  private scanned4kTmdbIds: Set<number> = new Set();
  private didScanStandard = false;
  private didScan4k = false;
  private serverReturnedEmpty = false;
  private server4kReturnedEmpty = false;

  constructor() {
    super('Radarr Scan', { bundleSize: 50 });
  }

  public status(): SyncStatus {
    return {
      running: this.running,
      progress: this.progress,
      total: this.items.length,
      currentServer: this.currentServer,
      servers: this.servers,
    };
  }

  public async run(): Promise<void> {
    let destinationScan: ReturnType<typeof beginDestinationScan> | undefined;
    const settings = getSettings();
    const sessionId = this.startRun();
    this.scannedTmdbIds.clear();
    this.scanned4kTmdbIds.clear();
    this.didScanStandard = false;
    this.didScan4k = false;
    this.serverReturnedEmpty = false;
    this.server4kReturnedEmpty = false;

    try {
      const ambiguousServerIds = findAmbiguousIndependentDvrServerIds(
        settings.radarr
      );
      const ambiguousServers = settings.radarr.filter((server) =>
        ambiguousServerIds.has(server.id)
      );
      if (ambiguousServers.length > 0) {
        this.log(
          `Skipping ambiguous Radarr configuration sharing a physical instance: ${ambiguousServers
            .map((server) => `${server.name} (${server.id})`)
            .join(', ')}`,
          'error'
        );
      }
      this.servers = uniqWith(
        settings.radarr.filter((server) => !ambiguousServerIds.has(server.id)),
        (radarrA, radarrB) =>
          radarrA.hostname === radarrB.hostname &&
          radarrA.port === radarrB.port &&
          radarrA.baseUrl === radarrB.baseUrl
      );

      for (const configuredServer of this.servers) {
        const server =
          configuredServer.independentRequestDestination === true
            ? getSettings().radarr.find(
                (current) =>
                  current.id === configuredServer.id &&
                  current.independentRequestDestination === true
              )
            : configuredServer;
        if (!server) continue;
        this.currentServer = server;
        if (server.syncEnabled) {
          this.log(
            `Beginning to process Radarr server: ${server.name}`,
            'info'
          );

          this.radarrApi = new RadarrAPI({
            apiKey: server.apiKey,
            url: RadarrAPI.buildUrl(server, '/api/v3'),
          });

          destinationScan =
            server.independentRequestDestination === true
              ? beginDestinationScan(MediaType.MOVIE, server.id, server)
              : undefined;
          this.items = await this.radarrApi.getMovies();
          if (
            server.independentRequestDestination === true &&
            (!Array.isArray(this.items) ||
              this.items.some(
                (movie) =>
                  !movie ||
                  !Number.isSafeInteger(movie.id) ||
                  (movie.id ?? 0) <= 0 ||
                  !Number.isSafeInteger(movie.tmdbId) ||
                  movie.tmdbId <= 0 ||
                  typeof movie.hasFile !== 'boolean' ||
                  typeof movie.monitored !== 'boolean'
              ))
          ) {
            this.log(
              `Invalid independent Radarr inventory. Skipping server: ${server.name} (${server.id})`,
              'warn'
            );
            destinationScan?.close();
            destinationScan = undefined;
            // Reset progress only; this inventory must never be reconciled.
            this.items = [];
            this.progress = 0;
            continue;
          }

          const server4k = this.enable4kMovie && server.is4k;
          if (server.independentRequestDestination !== true) {
            if (server4k) {
              this.didScan4k = true;
            } else {
              this.didScanStandard = true;
            }

            if (this.items.length === 0) {
              if (server4k) {
                this.server4kReturnedEmpty = true;
              } else {
                this.serverReturnedEmpty = true;
              }
            }
          }

          if (this.items.length === 0) {
            this.log(
              `Radarr server ${server.name} returned no movies. Orphan cleanup for this profile type will be skipped.`,
              'warn'
            );
          }

          const observation = destinationScan;
          await this.loop(
            (movie) => this.processRadarrMovie(movie, observation),
            { sessionId }
          );
          if (
            server.independentRequestDestination === true &&
            this.items.length > 0
          ) {
            await this.cleanupIndependentOrphanedMovies(
              server,
              this.items,
              observation
            );
          }
          destinationScan?.close();
          destinationScan = undefined;
        } else {
          this.log(`Sync not enabled. Skipping Radarr server: ${server.name}`);
        }
      }

      // Only run cleanup if all servers of this profile type have sync enabled.
      // If any server is skipped, we can't distinguish truly orphaned media from
      // media that exists on an unscanned server (e.g. separate instances for
      // anime, regional content, or different languages).
      const allStandardScanned = this.servers
        .filter(
          (s) =>
            s.independentRequestDestination !== true &&
            (!this.enable4kMovie || !s.is4k)
        )
        .every((s) => s.syncEnabled);
      const all4kScanned = this.servers
        .filter(
          (s) =>
            s.independentRequestDestination !== true &&
            this.enable4kMovie &&
            s.is4k
        )
        .every((s) => s.syncEnabled);

      if (!allStandardScanned) {
        this.didScanStandard = false;
      }
      if (!all4kScanned) {
        this.didScan4k = false;
      }

      if (
        ambiguousServers.some(
          (server) =>
            server.independentRequestDestination !== true &&
            (!this.enable4kMovie || !server.is4k)
        )
      ) {
        this.didScanStandard = false;
      }
      if (
        ambiguousServers.some(
          (server) =>
            server.independentRequestDestination !== true &&
            this.enable4kMovie &&
            server.is4k
        )
      ) {
        this.didScan4k = false;
      }

      if (this.serverReturnedEmpty) {
        this.didScanStandard = false;
      }
      if (this.server4kReturnedEmpty) {
        this.didScan4k = false;
      }

      await this.cleanupOrphanedMovies();
      this.log('Radarr scan complete', 'info');
    } catch (e) {
      this.log('Scan interrupted', 'error', { errorMessage: e.message });
    } finally {
      destinationScan?.close();
      this.endRun(sessionId);
    }
  }

  private async processRadarrMovie(
    radarrMovie: RadarrMovie,
    observation?: ReturnType<typeof beginDestinationScan>
  ): Promise<void> {
    const server = this.currentServer;
    const server4k = this.enable4kMovie && this.currentServer.is4k;
    if (this.currentServer.independentRequestDestination !== true) {
      if (server4k) {
        this.scanned4kTmdbIds.add(radarrMovie.tmdbId);
      } else {
        this.scannedTmdbIds.add(radarrMovie.tmdbId);
      }
    }

    try {
      if (this.currentServer.independentRequestDestination === true) {
        await this.asyncLock.dispatch(radarrMovie.tmdbId, async () => {
          const completedRequests = await withDestinationOperationLock(
            MediaType.MOVIE,
            radarrMovie.tmdbId,
            server.id,
            () =>
              withDvrIdentityLock('radarr', server.id, async () => {
                if (!observation?.isFresh(radarrMovie.tmdbId)) return [];
                const result = await updateIndependentMovieDestination({
                  tmdbId: radarrMovie.tmdbId,
                  serverId: server.id,
                  externalServiceId: radarrMovie.id,
                  externalServiceSlug: radarrMovie.titleSlug,
                  hasFile: radarrMovie.hasFile,
                  monitored: radarrMovie.monitored,
                });
                return result.completedRequests;
              })
          );
          await notifyAvailableRequests(completedRequests);
        });
        return;
      }

      await this.processMovie(radarrMovie.tmdbId, {
        is4k: server4k,
        serviceId: this.currentServer.id,
        externalServiceId: radarrMovie.id,
        externalServiceSlug: radarrMovie.titleSlug,
        title: radarrMovie.title,
        processing: !radarrMovie.hasFile && radarrMovie.monitored,
        hasFile: radarrMovie.hasFile,
      });
    } catch (e) {
      this.log('Failed to process Radarr media', 'error', {
        errorMessage: e.message,
        title: radarrMovie.title,
      });
    }
  }

  private async existsInAnyNativeServer(
    tmdbId: number,
    is4k: boolean
  ): Promise<boolean> {
    const servers = this.servers.filter(
      (server) =>
        server.independentRequestDestination !== true &&
        server.syncEnabled &&
        (this.enable4kMovie && server.is4k) === is4k
    );

    for (const server of servers) {
      try {
        const api = new RadarrAPI({
          apiKey: server.apiKey,
          url: RadarrAPI.buildUrl(server, '/api/v3'),
        });
        const movies = await api.getLibraryMoviesByTmdbId(tmdbId);

        if (movies.some((movie) => movie.tmdbId === tmdbId)) {
          return true;
        }
      } catch (e) {
        this.log(
          `Could not confirm movie ${tmdbId} against Radarr server ${server.name}. Skipping cleanup for it.`,
          'warn',
          { errorMessage: e.message }
        );
        return true;
      }
    }

    return false;
  }

  private async cleanupIndependentOrphanedMovies(
    server: RadarrSettings,
    movies: RadarrMovie[],
    observation?: ReturnType<typeof beginDestinationScan>
  ): Promise<void> {
    const scannedTmdbIds = new Set(movies.map((movie) => movie.tmdbId));
    const candidates = await findIndependentDestinationCandidates(
      server.id,
      MediaType.MOVIE,
      [MediaStatus.PROCESSING, MediaStatus.AVAILABLE]
    );

    for (const destination of candidates) {
      if (scannedTmdbIds.has(destination.media.tmdbId)) {
        continue;
      }
      const declinedRequests = await withDestinationOperationLock(
        MediaType.MOVIE,
        destination.media.tmdbId,
        server.id,
        async () => {
          if (!observation?.isFresh(destination.media.tmdbId)) return [];
          try {
            const exactMovies = await this.radarrApi.getLibraryMoviesByTmdbId(
              destination.media.tmdbId
            );
            if (
              !Array.isArray(exactMovies) ||
              exactMovies.some(
                (movie) =>
                  !movie ||
                  !Number.isSafeInteger(movie.id) ||
                  (movie.id ?? 0) <= 0 ||
                  !Number.isSafeInteger(movie.tmdbId) ||
                  movie.tmdbId <= 0
              )
            ) {
              return [];
            }
            if (
              exactMovies.some(
                (movie) => movie.tmdbId === destination.media.tmdbId
              )
            ) {
              return [];
            }
          } catch (e) {
            this.log(
              `Could not confirm movie ${destination.media.tmdbId} against independent Radarr server ${server.name}. Skipping cleanup for it.`,
              'warn',
              { errorMessage: e.message }
            );
            return [];
          }

          return withDvrIdentityLock('radarr', server.id, async () => {
            if (!observation?.isFresh(destination.media.tmdbId)) return [];
            return markMissingMovieDestination(destination.mediaId, server.id);
          });
        }
      );
      await notifyDeclinedRequests(declinedRequests);
    }
  }

  private async cleanupOrphanedMovies(): Promise<void> {
    const mediaRepository = getRepository(Media);

    if (this.didScanStandard) {
      const processingMovies = await mediaRepository.find({
        where: { mediaType: MediaType.MOVIE, status: MediaStatus.PROCESSING },
        relations: { requests: true },
      });

      for (const media of processingMovies) {
        if (!this.scannedTmdbIds.has(media.tmdbId)) {
          if (await this.existsInAnyNativeServer(media.tmdbId, false)) {
            continue;
          }

          media.status = MediaStatus.UNKNOWN;
          await mediaRepository.save(media);
          await this.declineOrphanedRequests(media, false);
          this.log(
            `Movie ${media.tmdbId} not found in any Radarr server. Status reset to UNKNOWN.`,
            'info'
          );
        }
      }
    } else {
      this.log(
        'Skipping orphaned movie cleanup: no standard Radarr servers were scanned.',
        'info'
      );
    }

    if (this.didScan4k) {
      const processing4kMovies = await mediaRepository.find({
        where: {
          mediaType: MediaType.MOVIE,
          status4k: MediaStatus.PROCESSING,
        },
        relations: { requests: true },
      });

      for (const media of processing4kMovies) {
        if (!this.scanned4kTmdbIds.has(media.tmdbId)) {
          if (await this.existsInAnyNativeServer(media.tmdbId, true)) {
            continue;
          }

          media.status4k = MediaStatus.UNKNOWN;
          await mediaRepository.save(media);
          await this.declineOrphanedRequests(media, true);
          this.log(
            `Movie ${media.tmdbId} not found in any 4K Radarr server. 4K status reset to UNKNOWN.`,
            'info'
          );
        }
      }
    } else if (this.enable4kMovie) {
      this.log(
        'Skipping orphaned 4K movie cleanup: no 4K Radarr servers were scanned.',
        'info'
      );
    }
  }
}

export const radarrScanner = new RadarrScanner();
