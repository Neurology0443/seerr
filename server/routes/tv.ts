import { getMetadataProvider } from '@server/api/metadata';
import RottenTomatoes from '@server/api/rating/rottentomatoes';
import TheMovieDb from '@server/api/themoviedb';
import { ANIME_KEYWORD_ID } from '@server/api/themoviedb/constants';
import type { TmdbKeyword } from '@server/api/themoviedb/interfaces';
import { MediaType } from '@server/constants/media';
import { getRepository } from '@server/datasource';
import Media from '@server/entity/Media';
import { MediaDestinationSeasonStatus } from '@server/entity/MediaDestinationSeasonStatus';
import { MediaDestinationStatus } from '@server/entity/MediaDestinationStatus';
import { Watchlist } from '@server/entity/Watchlist';
import type { TvRequestTarget } from '@server/interfaces/api/requestInterfaces';
import {
  classifyActiveRequestTargets,
  getConfiguredRequestTargetState,
  serializeMediaRequest,
} from '@server/lib/requestTargetState';
import { getSettings } from '@server/lib/settings';
import logger from '@server/logger';
import { mapTvResult } from '@server/models/Search';
import { mapSeasonWithEpisodes, mapTvDetails } from '@server/models/Tv';
import { Router } from 'express';
import { In } from 'typeorm';

const tvRoutes = Router();

tvRoutes.get<{ id: string }, TvRequestTarget[]>(
  '/:id/request-targets',
  async (req, res, next) => {
    try {
      const tmdb = new TheMovieDb();
      const show = await tmdb.getTvShow({ tvId: Number(req.params.id) });
      const settings = getSettings();
      const seasonNumbers = show.seasons
        .filter(
          (season) =>
            season.episode_count > 0 &&
            (settings.main.enableSpecialEpisodes || season.season_number > 0)
        )
        .map((season) => season.season_number);
      const mediaRepository = getRepository(Media);
      const media = await mediaRepository.findOne({
        where: { tmdbId: Number(req.params.id), mediaType: MediaType.TV },
        relations: { requests: true },
      });
      const destinations = media
        ? await getRepository(MediaDestinationStatus).find({
            where: { mediaId: media.id },
          })
        : [];
      const destinationSeasons =
        destinations.length > 0
          ? await getRepository(MediaDestinationSeasonStatus).find({
              where: {
                destinationStatusId: In(
                  destinations.map((destination) => destination.id)
                ),
              },
            })
          : [];
      const activeRequests = await classifyActiveRequestTargets(
        media?.requests ?? [],
        mediaRepository.manager
      );

      const targets = settings.sonarr.map((server) => {
        const destination = destinations.find(
          (candidate) => candidate.serverId === server.id
        );
        const seasons = seasonNumbers.map((seasonNumber) => {
          const state = getConfiguredRequestTargetState({
            server,
            destinationStatus: destinationSeasons.find(
              (season) =>
                season.destinationStatusId === destination?.id &&
                season.seasonNumber === seasonNumber
            )?.status,
            nativeStatus: media?.seasons?.find(
              (season) => season.seasonNumber === seasonNumber
            )?.[server.is4k ? 'status4k' : 'status'],
            activeRequests,
            seasonNumber,
          });

          return {
            seasonNumber,
            status: state.status,
            requestable: state.requestable,
          };
        });
        const parentState = getConfiguredRequestTargetState({
          media: media ?? undefined,
          server,
          destinationStatus: destination?.status,
          activeRequests,
        });

        return {
          serverId: server.id,
          name: server.name,
          is4k: Boolean(server.is4k),
          isDefault: Boolean(server.isDefault),
          isIndependent: parentState.isIndependent,
          status: parentState.status,
          requestable: seasons.some((season) => season.requestable),
          seasons,
        };
      });

      return res.status(200).json(targets);
    } catch (e) {
      logger.debug('Something went wrong retrieving series request targets', {
        label: 'API',
        errorMessage: e.message,
        tvId: req.params.id,
      });
      return next({
        status: 500,
        message: 'Unable to retrieve series request targets.',
      });
    }
  }
);

tvRoutes.get('/:id', async (req, res, next) => {
  const tmdb = new TheMovieDb();

  try {
    const tmdbTv = await tmdb.getTvShow({
      tvId: Number(req.params.id),
    });
    const metadataProvider = tmdbTv.keywords.results.some(
      (keyword: TmdbKeyword) => keyword.id === ANIME_KEYWORD_ID
    )
      ? await getMetadataProvider('anime')
      : await getMetadataProvider('tv');
    const tv = await metadataProvider.getTvShow({
      tvId: Number(req.params.id),
      language: (req.query.language as string) ?? req.locale,
    });
    const media = await Media.getMedia(tv.id, MediaType.TV);

    const onUserWatchlist = await getRepository(Watchlist).exist({
      where: {
        tmdbId: Number(req.params.id),
        mediaType: MediaType.TV,
        requestedBy: {
          id: req.user?.id,
        },
      },
    });

    const data = mapTvDetails(tv, media?.filter(req.user), onUserWatchlist);

    if (data.mediaInfo) {
      data.mediaInfo.requests = await Promise.all(
        data.mediaInfo.requests.map((request) =>
          serializeMediaRequest(request, getRepository(Media).manager)
        )
      );
    }

    // TMDB issue where it doesnt fallback to English when no overview is available in requested locale.
    if (!data.overview) {
      const tvEnglish = await metadataProvider.getTvShow({
        tvId: Number(req.params.id),
      });
      data.overview = tvEnglish.overview;
    }

    return res.status(200).json(data);
  } catch (e) {
    logger.debug('Something went wrong retrieving series', {
      label: 'API',
      errorMessage: e.message,
      tvId: req.params.id,
    });
    return next({
      status: 500,
      message: 'Unable to retrieve series.',
    });
  }
});

tvRoutes.get('/:id/season/:seasonNumber', async (req, res, next) => {
  try {
    const tmdb = new TheMovieDb();
    const tmdbTv = await tmdb.getTvShow({
      tvId: Number(req.params.id),
    });
    const metadataProvider = tmdbTv.keywords.results.some(
      (keyword: TmdbKeyword) => keyword.id === ANIME_KEYWORD_ID
    )
      ? await getMetadataProvider('anime')
      : await getMetadataProvider('tv');

    const season = await metadataProvider.getTvSeason({
      tvId: Number(req.params.id),
      seasonNumber: Number(req.params.seasonNumber),
      language: (req.query.language as string) ?? req.locale,
    });

    return res.status(200).json(mapSeasonWithEpisodes(season));
  } catch (e) {
    logger.debug('Something went wrong retrieving season', {
      label: 'API',
      errorMessage: e.message,
      tvId: req.params.id,
      seasonNumber: req.params.seasonNumber,
    });
    return next({
      status: 500,
      message: 'Unable to retrieve season.',
    });
  }
});

tvRoutes.get('/:id/recommendations', async (req, res, next) => {
  const tmdb = new TheMovieDb();

  try {
    const results = await tmdb.getTvRecommendations({
      tvId: Number(req.params.id),
      page: Number(req.query.page),
      language: (req.query.language as string) ?? req.locale,
    });

    const media = await Media.getRelatedMedia(
      req.user,
      results.results.map((result) => ({
        tmdbId: result.id,
        mediaType: MediaType.TV,
      })),
      { includeActiveRequest: true }
    );

    return res.status(200).json({
      page: results.page,
      totalPages: results.total_pages,
      totalResults: results.total_results,
      results: results.results.map((result) =>
        mapTvResult(
          result,
          media.find(
            (req) => req.tmdbId === result.id && req.mediaType === MediaType.TV
          )
        )
      ),
    });
  } catch (e) {
    logger.debug('Something went wrong retrieving series recommendations', {
      label: 'API',
      errorMessage: e.message,
      tvId: req.params.id,
    });
    return next({
      status: 500,
      message: 'Unable to retrieve series recommendations.',
    });
  }
});

tvRoutes.get('/:id/similar', async (req, res, next) => {
  const tmdb = new TheMovieDb();

  try {
    const results = await tmdb.getTvSimilar({
      tvId: Number(req.params.id),
      page: Number(req.query.page),
      language: (req.query.language as string) ?? req.locale,
    });

    const media = await Media.getRelatedMedia(
      req.user,
      results.results.map((result) => ({
        tmdbId: result.id,
        mediaType: MediaType.TV,
      })),
      { includeActiveRequest: true }
    );

    return res.status(200).json({
      page: results.page,
      totalPages: results.total_pages,
      totalResults: results.total_results,
      results: results.results.map((result) =>
        mapTvResult(
          result,
          media.find(
            (req) => req.tmdbId === result.id && req.mediaType === MediaType.TV
          )
        )
      ),
    });
  } catch (e) {
    logger.debug('Something went wrong retrieving similar series', {
      label: 'API',
      errorMessage: e.message,
      tvId: req.params.id,
    });
    return next({
      status: 500,
      message: 'Unable to retrieve similar series.',
    });
  }
});

tvRoutes.get('/:id/ratings', async (req, res, next) => {
  const tmdb = new TheMovieDb();
  const rtapi = new RottenTomatoes();

  try {
    const tv = await tmdb.getTvShow({
      tvId: Number(req.params.id),
    });

    const rtratings = await rtapi.getTVRatings(
      tv.name,
      tv.first_air_date ? Number(tv.first_air_date.slice(0, 4)) : undefined
    );

    if (!rtratings) {
      return next({
        status: 404,
        message: 'Rotten Tomatoes ratings not found.',
      });
    }

    return res.status(200).json(rtratings);
  } catch (e) {
    logger.debug('Something went wrong retrieving series ratings', {
      label: 'API',
      errorMessage: e.message,
      tvId: req.params.id,
    });
    return next({
      status: 500,
      message: 'Unable to retrieve series ratings.',
    });
  }
});

export default tvRoutes;
