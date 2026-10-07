import SonarrAPI from '@server/api/servarr/sonarr';
import type { SonarrSettings } from '@server/lib/settings';
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
import {
  withDvrIdentityLock,
  withDvrSettingsMutationLock,
} from '@server/utils/dvrIdentityLock';
import { Router } from 'express';

const sonarrRoutes = Router();

sonarrRoutes.get('/', (_req, res) => {
  const settings = getSettings();

  res.status(200).json(settings.sonarr);
});

sonarrRoutes.post('/', async (req, res, next) => {
  if (!hasValidIndependentRequestDestination(req.body)) {
    return next({
      status: 400,
      message: 'Independent request destination must be a boolean.',
    });
  }

  return withDvrSettingsMutationLock('sonarr', async () => {
    const settings = getSettings();

    const newSonarr = {
      ...req.body,
      independentRequestDestination:
        req.body.independentRequestDestination ?? false,
    } as SonarrSettings;

    if (
      newSonarr.independentRequestDestination === true &&
      newSonarr.syncEnabled !== true
    ) {
      return next({
        status: 400,
        message: 'Independent request destinations require sync to be enabled.',
      });
    }

    if (conflictsWithIndependentDvrEndpoint(newSonarr, settings.sonarr)) {
      return next({
        status: 409,
        message:
          'This Sonarr instance is already configured and cannot also be an independent destination.',
      });
    }

    newSonarr.id = await allocateDvrServerId('sonarr');

    // If we are setting this as the default, clear any previous defaults for the same type first
    // ex: if is4k is true, it will only remove defaults for other servers that have is4k set to true
    // and are the default
    if (newSonarr.isDefault) {
      settings.sonarr
        .filter((sonarrInstance) => sonarrInstance.is4k === newSonarr.is4k)
        .forEach((sonarrInstance) => {
          sonarrInstance.isDefault = false;
        });
    }

    settings.sonarr = [...settings.sonarr, newSonarr];
    await settings.save();

    return res.status(201).json(newSonarr);
  });
});

sonarrRoutes.post('/test', async (req, res, next) => {
  try {
    const sonarr = new SonarrAPI({
      apiKey: req.body.apiKey,
      url: SonarrAPI.buildUrl(req.body, '/api/v3'),
    });

    const systemStatus = await sonarr.getSystemStatus();
    const sonarrMajorVersion = Number(systemStatus.version.split('.')[0]);

    const urlBase = systemStatus.urlBase;
    const profiles = await sonarr.getProfiles();
    const folders = await sonarr.getRootFolders();
    const languageProfiles =
      sonarrMajorVersion <= 3 ? await sonarr.getLanguageProfiles() : null;
    const tags = await sonarr.getTags();

    return res.status(200).json({
      profiles,
      rootFolders: folders.map((folder) => ({
        id: folder.id,
        path: folder.path,
      })),
      languageProfiles,
      tags,
      urlBase,
    });
  } catch (e) {
    logger.error('Failed to test Sonarr', {
      label: 'Sonarr',
      message: e.message,
    });

    next({ status: 500, message: 'Failed to connect to Sonarr' });
  }
});

sonarrRoutes.put<{ id: string }>('/:id', async (req, res, next) => {
  if (!hasValidIndependentRequestDestination(req.body)) {
    return next({
      status: 400,
      message: 'Independent request destination must be a boolean.',
    });
  }

  const serverId = Number(req.params.id);

  const update = async (identityLocked = false): Promise<unknown> => {
    const settings = getSettings();
    const sonarrIndex = settings.sonarr.findIndex((r) => r.id === serverId);

    if (sonarrIndex === -1) {
      return next({ status: 404, message: 'Settings instance not found' });
    }

    const currentSonarr = settings.sonarr[sonarrIndex];
    const currentIndependentRequestDestination =
      currentSonarr.independentRequestDestination ?? false;
    const updatedSonarr = {
      ...req.body,
      independentRequestDestination: hasIndependentRequestDestination(req.body)
        ? req.body.independentRequestDestination
        : currentIndependentRequestDestination,
      id: currentSonarr.id,
    } as SonarrSettings;

    if (
      updatedSonarr.independentRequestDestination === true &&
      updatedSonarr.syncEnabled !== true
    ) {
      return next({
        status: 400,
        message: 'Independent request destinations require sync to be enabled.',
      });
    }

    if (
      conflictsWithIndependentDvrEndpoint(
        updatedSonarr,
        settings.sonarr,
        currentSonarr.id
      )
    ) {
      return next({
        status: 409,
        message:
          'This Sonarr instance is already configured and cannot also be an independent destination.',
      });
    }

    const independentRoleChanged =
      updatedSonarr.independentRequestDestination !==
      currentIndependentRequestDestination;
    const is4kRoleChanged = updatedSonarr.is4k !== currentSonarr.is4k;

    if ((independentRoleChanged || is4kRoleChanged) && !identityLocked) {
      return withDvrIdentityLock('sonarr', serverId, () => update(true));
    }

    if (
      (independentRoleChanged || is4kRoleChanged) &&
      (await isDvrServerHistoricallyUsed('sonarr', currentSonarr.id))
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
    if (updatedSonarr.isDefault) {
      settings.sonarr
        .filter((sonarrInstance) => sonarrInstance.is4k === updatedSonarr.is4k)
        .forEach((sonarrInstance) => {
          sonarrInstance.isDefault = false;
        });
    }

    settings.sonarr[sonarrIndex] = updatedSonarr;
    await settings.save();

    return res.status(200).json(settings.sonarr[sonarrIndex]);
  };

  return withDvrSettingsMutationLock('sonarr', update);
});

sonarrRoutes.delete<{ id: string }>('/:id', async (req, res, next) => {
  const serverId = Number(req.params.id);

  return withDvrSettingsMutationLock('sonarr', () =>
    withDvrIdentityLock('sonarr', serverId, async () => {
      const settings = getSettings();
      const sonarrIndex = settings.sonarr.findIndex((r) => r.id === serverId);

      if (sonarrIndex === -1) {
        return next({ status: 404, message: 'Settings instance not found' });
      }

      if (await hasActiveDvrRequests('sonarr', serverId)) {
        return next({
          status: 409,
          message: 'A server with active requests cannot be deleted.',
        });
      }

      const removed = settings.sonarr.splice(sonarrIndex, 1);
      await settings.save();

      return res.status(200).json(removed[0]);
    })
  );
});

export default sonarrRoutes;
