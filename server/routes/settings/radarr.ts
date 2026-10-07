import RadarrAPI from '@server/api/servarr/radarr';
import type { RadarrSettings } from '@server/lib/settings';
import { getSettings } from '@server/lib/settings';
import {
  allocateDvrServerId,
  hasActiveDvrRequests,
  isDvrServerHistoricallyUsed,
} from '@server/lib/settings/dvrId';
import {
  conflictsWithIndependentDvrEndpoint,
  hasIndependentRequestDestination,
  hasValidIndependentRequestDestination,
} from '@server/lib/settings/dvrValidation';
import logger from '@server/logger';
import { withDvrIdentityLock } from '@server/utils/dvrIdentityLock';
import { Router } from 'express';

const radarrRoutes = Router();

radarrRoutes.get('/', (_req, res) => {
  const settings = getSettings();

  res.status(200).json(settings.radarr);
});

radarrRoutes.post('/', async (req, res, next) => {
  if (!hasValidIndependentRequestDestination(req.body)) {
    return next({
      status: 400,
      message: 'Independent request destination must be a boolean.',
    });
  }

  const settings = getSettings();

  const newRadarr = {
    ...req.body,
    independentRequestDestination:
      req.body.independentRequestDestination ?? false,
  } as RadarrSettings;

  if (
    newRadarr.independentRequestDestination === true &&
    newRadarr.syncEnabled !== true
  ) {
    return next({
      status: 400,
      message: 'Independent request destinations require sync to be enabled.',
    });
  }

  if (conflictsWithIndependentDvrEndpoint(newRadarr, settings.radarr)) {
    return next({
      status: 409,
      message:
        'This Radarr instance is already configured and cannot also be an independent destination.',
    });
  }

  newRadarr.id = await allocateDvrServerId('radarr');

  // If we are setting this as the default, clear any previous defaults for the same type first
  // ex: if is4k is true, it will only remove defaults for other servers that have is4k set to true
  // and are the default
  if (newRadarr.isDefault) {
    settings.radarr
      .filter((radarrInstance) => radarrInstance.is4k === newRadarr.is4k)
      .forEach((radarrInstance) => {
        radarrInstance.isDefault = false;
      });
  }

  settings.radarr = [...settings.radarr, newRadarr];
  await settings.save();

  return res.status(201).json(newRadarr);
});

radarrRoutes.post<
  undefined,
  Record<string, unknown>,
  RadarrSettings & { tagLabel?: string }
>('/test', async (req, res, next) => {
  try {
    const radarr = new RadarrAPI({
      apiKey: req.body.apiKey,
      url: RadarrAPI.buildUrl(req.body, '/api/v3'),
    });

    const urlBase = await radarr
      .getSystemStatus()
      .then((value) => value.urlBase)
      .catch(() => req.body.baseUrl);
    const profiles = await radarr.getProfiles();
    const folders = await radarr.getRootFolders();
    const tags = await radarr.getTags();

    return res.status(200).json({
      profiles,
      rootFolders: folders.map((folder) => ({
        id: folder.id,
        path: folder.path,
      })),
      tags,
      urlBase,
    });
  } catch (e) {
    logger.error('Failed to test Radarr', {
      label: 'Radarr',
      message: e.message,
    });

    next({ status: 500, message: 'Failed to connect to Radarr' });
  }
});

radarrRoutes.put<{ id: string }, RadarrSettings, RadarrSettings>(
  '/:id',
  async (req, res, next) => {
    if (!hasValidIndependentRequestDestination(req.body)) {
      return next({
        status: 400,
        message: 'Independent request destination must be a boolean.',
      });
    }

    const serverId = Number(req.params.id);

    const update = async (identityLocked = false): Promise<unknown> => {
      const settings = getSettings();
      const radarrIndex = settings.radarr.findIndex((r) => r.id === serverId);

      if (radarrIndex === -1) {
        return next({ status: 404, message: 'Settings instance not found' });
      }

      const currentRadarr = settings.radarr[radarrIndex];
      const currentIndependentRequestDestination =
        currentRadarr.independentRequestDestination ?? false;
      const updatedRadarr = {
        ...req.body,
        independentRequestDestination: hasIndependentRequestDestination(
          req.body
        )
          ? req.body.independentRequestDestination
          : currentIndependentRequestDestination,
        id: currentRadarr.id,
      } as RadarrSettings;

      if (
        updatedRadarr.independentRequestDestination === true &&
        updatedRadarr.syncEnabled !== true
      ) {
        return next({
          status: 400,
          message:
            'Independent request destinations require sync to be enabled.',
        });
      }

      if (
        conflictsWithIndependentDvrEndpoint(
          updatedRadarr,
          settings.radarr,
          currentRadarr.id
        )
      ) {
        return next({
          status: 409,
          message:
            'This Radarr instance is already configured and cannot also be an independent destination.',
        });
      }

      const independentRoleChanged =
        updatedRadarr.independentRequestDestination !==
        currentIndependentRequestDestination;
      const is4kRoleChanged = updatedRadarr.is4k !== currentRadarr.is4k;

      if ((independentRoleChanged || is4kRoleChanged) && !identityLocked) {
        return withDvrIdentityLock('radarr', serverId, () => update(true));
      }

      if (
        (independentRoleChanged || is4kRoleChanged) &&
        (await isDvrServerHistoricallyUsed('radarr', currentRadarr.id))
      ) {
        if (independentRoleChanged) {
          return next({
            status: 409,
            message:
              'The independent destination role cannot change after this server ID has been used.',
          });
        }
        if (is4kRoleChanged) {
          return next({
            status: 409,
            message:
              'The 4K role cannot change after this server ID has been used.',
          });
        }
      }

      // If we are setting this as the default, clear any previous defaults for the same type first
      // ex: if is4k is true, it will only remove defaults for other servers that have is4k set to true
      // and are the default
      if (updatedRadarr.isDefault) {
        settings.radarr
          .filter(
            (radarrInstance) => radarrInstance.is4k === updatedRadarr.is4k
          )
          .forEach((radarrInstance) => {
            radarrInstance.isDefault = false;
          });
      }

      settings.radarr[radarrIndex] = updatedRadarr;
      await settings.save();

      return res.status(200).json(settings.radarr[radarrIndex]);
    };

    return update();
  }
);

radarrRoutes.get<{ id: string }>('/:id/profiles', async (req, res, next) => {
  const settings = getSettings();

  const radarrSettings = settings.radarr.find(
    (r) => r.id === Number(req.params.id)
  );

  if (!radarrSettings) {
    return next({ status: '404', message: 'Settings instance not found' });
  }

  const radarr = new RadarrAPI({
    apiKey: radarrSettings.apiKey,
    url: RadarrAPI.buildUrl(radarrSettings, '/api/v3'),
  });

  const profiles = await radarr.getProfiles();

  return res.status(200).json(
    profiles.map((profile) => ({
      id: profile.id,
      name: profile.name,
    }))
  );
});

radarrRoutes.delete<{ id: string }>('/:id', async (req, res, next) => {
  const serverId = Number(req.params.id);

  return withDvrIdentityLock('radarr', serverId, async () => {
    const settings = getSettings();
    const radarrIndex = settings.radarr.findIndex((r) => r.id === serverId);

    if (radarrIndex === -1) {
      return next({ status: 404, message: 'Settings instance not found' });
    }

    if (await hasActiveDvrRequests('radarr', serverId)) {
      return next({
        status: 409,
        message: 'A server with active requests cannot be deleted.',
      });
    }

    const removed = settings.radarr.splice(radarrIndex, 1);
    await settings.save();

    return res.status(200).json(removed[0]);
  });
});

export default radarrRoutes;
