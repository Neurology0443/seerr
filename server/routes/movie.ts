import IMDBRadarrProxy from '@server/api/rating/imdbRadarrProxy';
import RottenTomatoes from '@server/api/rating/rottentomatoes';
import { type RatingResponse } from '@server/api/ratings';
import TheMovieDb from '@server/api/themoviedb';
import { MediaType } from '@server/constants/media';
import { getRepository } from '@server/datasource';
import Media from '@server/entity/Media';
import { MediaDestinationStatus } from '@server/entity/MediaDestinationStatus';
import { Watchlist } from '@server/entity/Watchlist';
import type { MovieRequestTarget } from '@server/interfaces/api/requestInterfaces';
import {
  classifyActiveRequestTargets,
  getConfiguredRequestTargetState,
} from '@server/lib/requestTargetState';
import { getSettings } from '@server/lib/settings';
import logger from '@server/logger';
import { mapMovieDetails } from '@server/models/Movie';
import { mapMovieResult } from '@server/models/Search';
import { Router } from 'express';

const movieRoutes = Router();

movieRoutes.get<{ id: string }, MovieRequestTarget[]>(
  '/:id/request-targets',
  async (req, res, next) => {
    try {
      const mediaRepository = getRepository(Media);
      const media = await mediaRepository.findOne({
        where: {
          tmdbId: Number(req.params.id),
          mediaType: MediaType.MOVIE,
        },
        relations: { requests: true },
      });
      const destinations = media
        ? await getRepository(MediaDestinationStatus).find({
            where: { mediaId: media.id },
          })
        : [];
      const activeRequests = await classifyActiveRequestTargets(
        media?.requests ?? [],
        mediaRepository.manager
      );

      const targets = getSettings().radarr.map((server) => {
        const state = getConfiguredRequestTargetState({
          media: media ?? undefined,
          server,
          destinationStatus: destinations.find(
            (destination) => destination.serverId === server.id
          )?.status,
          activeRequests,
        });

        return {
          serverId: server.id,
          name: server.name,
          is4k: Boolean(server.is4k),
          isDefault: Boolean(server.isDefault),
          isIndependent: state.isIndependent,
          status: state.status,
          requestable: state.requestable,
        };
      });

      return res.status(200).json(targets);
    } catch (e) {
      logger.debug('Something went wrong retrieving movie request targets', {
        label: 'API',
        errorMessage: e.message,
        movieId: req.params.id,
      });
      return next({
        status: 500,
        message: 'Unable to retrieve movie request targets.',
      });
    }
  }
);

movieRoutes.get('/:id', async (req, res, next) => {
  const tmdb = new TheMovieDb();

  try {
    const tmdbMovie = await tmdb.getMovie({
      movieId: Number(req.params.id),
      language: (req.query.language as string) ?? req.locale,
    });

    const media = await Media.getMedia(tmdbMovie.id, MediaType.MOVIE);

    const onUserWatchlist = await getRepository(Watchlist).exist({
      where: {
        tmdbId: Number(req.params.id),
        mediaType: MediaType.MOVIE,
        requestedBy: {
          id: req.user?.id,
        },
      },
    });

    const data = mapMovieDetails(
      tmdbMovie,
      media?.filter(req.user),
      onUserWatchlist
    );

    // TMDB issue where it doesnt fallback to English when no overview is available in requested locale.
    if (!data.overview) {
      const tvEnglish = await tmdb.getMovie({ movieId: Number(req.params.id) });
      data.overview = tvEnglish.overview;
    }

    return res.status(200).json(data);
  } catch (e) {
    logger.debug('Something went wrong retrieving movie', {
      label: 'API',
      errorMessage: e.message,
      movieId: req.params.id,
    });
    return next({
      status: 500,
      message: 'Unable to retrieve movie.',
    });
  }
});

movieRoutes.get('/:id/recommendations', async (req, res, next) => {
  const tmdb = new TheMovieDb();

  try {
    const results = await tmdb.getMovieRecommendations({
      movieId: Number(req.params.id),
      page: Number(req.query.page),
      language: (req.query.language as string) ?? req.locale,
    });

    const media = await Media.getRelatedMedia(
      req.user,
      results.results.map((result) => ({
        tmdbId: result.id,
        mediaType: MediaType.MOVIE,
      })),
      { includeActiveRequest: true }
    );

    return res.status(200).json({
      page: results.page,
      totalPages: results.total_pages,
      totalResults: results.total_results,
      results: results.results.map((result) =>
        mapMovieResult(
          result,
          media.find(
            (req) =>
              req.tmdbId === result.id && req.mediaType === MediaType.MOVIE
          )
        )
      ),
    });
  } catch (e) {
    logger.debug('Something went wrong retrieving movie recommendations', {
      label: 'API',
      errorMessage: e.message,
      movieId: req.params.id,
    });
    return next({
      status: 500,
      message: 'Unable to retrieve movie recommendations.',
    });
  }
});

movieRoutes.get('/:id/similar', async (req, res, next) => {
  const tmdb = new TheMovieDb();

  try {
    const results = await tmdb.getMovieSimilar({
      movieId: Number(req.params.id),
      page: Number(req.query.page),
      language: (req.query.language as string) ?? req.locale,
    });

    const media = await Media.getRelatedMedia(
      req.user,
      results.results.map((result) => ({
        tmdbId: result.id,
        mediaType: MediaType.MOVIE,
      })),
      { includeActiveRequest: true }
    );

    return res.status(200).json({
      page: results.page,
      totalPages: results.total_pages,
      totalResults: results.total_results,
      results: results.results.map((result) =>
        mapMovieResult(
          result,
          media.find(
            (req) =>
              req.tmdbId === result.id && req.mediaType === MediaType.MOVIE
          )
        )
      ),
    });
  } catch (e) {
    logger.debug('Something went wrong retrieving similar movies', {
      label: 'API',
      errorMessage: e.message,
      movieId: req.params.id,
    });
    return next({
      status: 500,
      message: 'Unable to retrieve similar movies.',
    });
  }
});

/**
 * Endpoint backed by RottenTomatoes
 */
movieRoutes.get('/:id/ratings', async (req, res, next) => {
  const tmdb = new TheMovieDb();
  const rtapi = new RottenTomatoes();

  try {
    const movie = await tmdb.getMovie({
      movieId: Number(req.params.id),
    });

    const rtratings = await rtapi.getMovieRatings(
      movie.title,
      Number(movie.release_date.slice(0, 4))
    );

    if (!rtratings) {
      return next({
        status: 404,
        message: 'Rotten Tomatoes ratings not found.',
      });
    }

    return res.status(200).json(rtratings);
  } catch (e) {
    logger.debug('Something went wrong retrieving movie ratings', {
      label: 'API',
      errorMessage: e.message,
      movieId: req.params.id,
    });
    return next({
      status: 500,
      message: 'Unable to retrieve movie ratings.',
    });
  }
});

/**
 * Endpoint combining RottenTomatoes and IMDB
 */
movieRoutes.get('/:id/ratingscombined', async (req, res, next) => {
  const tmdb = new TheMovieDb();
  const rtapi = new RottenTomatoes();
  const imdbApi = new IMDBRadarrProxy();

  try {
    const movie = await tmdb.getMovie({
      movieId: Number(req.params.id),
    });

    const rtratings = await rtapi.getMovieRatings(
      movie.title,
      Number(movie.release_date.slice(0, 4))
    );

    let imdbRatings;
    if (movie.imdb_id) {
      imdbRatings = await imdbApi.getMovieRatings(movie.imdb_id);
    }

    if (!rtratings && !imdbRatings) {
      return next({
        status: 404,
        message: 'No ratings found.',
      });
    }

    const ratings: RatingResponse = {
      ...(rtratings ? { rt: rtratings } : {}),
      ...(imdbRatings ? { imdb: imdbRatings } : {}),
    };

    return res.status(200).json(ratings);
  } catch (e) {
    logger.debug('Something went wrong retrieving movie ratings', {
      label: 'API',
      errorMessage: e.message,
      movieId: req.params.id,
    });
    return next({
      status: 500,
      message: 'Unable to retrieve movie ratings.',
    });
  }
});

export default movieRoutes;
