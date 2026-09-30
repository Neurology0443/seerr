import RadarrAPI from '@server/api/servarr/radarr';
import { removeRequestServiceGrants } from '@server/lib/requestServices';
import { allocateServiceId, hasServiceReferences } from '@server/lib/serviceId';
import type { RadarrSettings } from '@server/lib/settings';
import { getSettings } from '@server/lib/settings';
import logger from '@server/logger';
import {
  isMultiServiceTarget,
  normalizeButtonLabel,
  validateServiceTargetConfig,
} from '@server/utils/serviceTarget';
import { Router } from 'express';

const radarrRoutes = Router();

radarrRoutes.get('/', (_req, res) => {
  const settings = getSettings();

  res.status(200).json(settings.radarr);
});

radarrRoutes.post('/', async (req, res, next) => {
  const settings = getSettings();
  if (
    req.body.buttonLabel !== undefined &&
    req.body.buttonLabel !== null &&
    typeof req.body.buttonLabel !== 'string'
  ) {
    return next({ status: 400, message: 'buttonLabel must be a string.' });
  }
  const candidate = {
    ...req.body,
    buttonLabel: normalizeButtonLabel(req.body.buttonLabel),
  } as RadarrSettings;
  const validationError = validateServiceTargetConfig(candidate);
  if (validationError) return next({ status: 400, message: validationError });

  const newRadarr = { ...candidate, id: await allocateServiceId('radarr') };

  // If we are setting this as the default, clear any previous defaults for the same type first
  // ex: if is4k is true, it will only remove defaults for other servers that have is4k set to true
  // and are the default
  if (candidate.isDefault) {
    settings.radarr
      .filter((radarrInstance) => radarrInstance.is4k === candidate.is4k)
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
    const settings = getSettings();

    const radarrIndex = settings.radarr.findIndex(
      (r) => r.id === Number(req.params.id)
    );

    if (radarrIndex === -1) {
      return next({ status: '404', message: 'Settings instance not found' });
    }
    if (
      req.body.buttonLabel !== undefined &&
      req.body.buttonLabel !== null &&
      typeof req.body.buttonLabel !== 'string'
    ) {
      return next({ status: 400, message: 'buttonLabel must be a string.' });
    }
    const existing = settings.radarr[radarrIndex];
    const candidate = {
      ...req.body,
      id: existing.id,
      buttonLabel: normalizeButtonLabel(req.body.buttonLabel),
    } as RadarrSettings;
    const validationError = validateServiceTargetConfig(candidate);
    if (validationError) return next({ status: 400, message: validationError });
    if (
      (isMultiServiceTarget(existing) !== isMultiServiceTarget(candidate) ||
        existing.is4k !== candidate.is4k) &&
      (await hasServiceReferences('radarr', existing.id))
    ) {
      return next({
        status: 409,
        message:
          'This server is already referenced and its request role or 4K identity cannot be changed.',
      });
    }

    // If we are setting this as the default, clear any previous defaults for the same type first
    // ex: if is4k is true, it will only remove defaults for other servers that have is4k set to true
    // and are the default
    if (candidate.isDefault) {
      settings.radarr
        .filter((radarrInstance) => radarrInstance.is4k === candidate.is4k)
        .forEach((radarrInstance) => {
          radarrInstance.isDefault = false;
        });
    }

    settings.radarr[radarrIndex] = candidate;
    await settings.save();

    return res.status(200).json(settings.radarr[radarrIndex]);
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
  const settings = getSettings();

  const radarrIndex = settings.radarr.findIndex(
    (r) => r.id === Number(req.params.id)
  );

  if (radarrIndex === -1) {
    return next({ status: '404', message: 'Settings instance not found' });
  }

  const existing = settings.radarr[radarrIndex];
  if (await hasServiceReferences('radarr', existing.id)) {
    return next({
      status: 409,
      message: 'This server is still referenced and cannot be deleted.',
    });
  }

  const removed = settings.radarr.splice(radarrIndex, 1);
  await settings.save();

  await removeRequestServiceGrants('radarr', removed[0].id);

  return res.status(200).json(removed[0]);
});

export default radarrRoutes;
