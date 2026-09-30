import SonarrAPI from '@server/api/servarr/sonarr';
import { removeRequestServiceGrants } from '@server/lib/requestServices';
import { allocateServiceId, hasServiceReferences } from '@server/lib/serviceId';
import type { SonarrSettings } from '@server/lib/settings';
import { getSettings } from '@server/lib/settings';
import logger from '@server/logger';
import {
  isMultiServiceTarget,
  normalizeButtonLabel,
  validateServiceTargetConfig,
} from '@server/utils/serviceTarget';
import { Router } from 'express';

const sonarrRoutes = Router();

sonarrRoutes.get('/', (_req, res) => {
  const settings = getSettings();

  res.status(200).json(settings.sonarr);
});

sonarrRoutes.post('/', async (req, res, next) => {
  const settings = getSettings();
  const candidate = {
    ...req.body,
    buttonLabel: normalizeButtonLabel(req.body.buttonLabel),
  } as SonarrSettings;
  const validationError = validateServiceTargetConfig(candidate);
  if (validationError) return next({ status: 400, message: validationError });
  const newSonarr = { ...candidate, id: await allocateServiceId('sonarr') };

  // If we are setting this as the default, clear any previous defaults for the same type first
  // ex: if is4k is true, it will only remove defaults for other servers that have is4k set to true
  // and are the default
  if (candidate.isDefault) {
    settings.sonarr
      .filter((sonarrInstance) => sonarrInstance.is4k === candidate.is4k)
      .forEach((sonarrInstance) => {
        sonarrInstance.isDefault = false;
      });
  }

  settings.sonarr = [...settings.sonarr, newSonarr];
  await settings.save();

  return res.status(201).json(newSonarr);
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
  const settings = getSettings();

  const sonarrIndex = settings.sonarr.findIndex(
    (r) => r.id === Number(req.params.id)
  );

  if (sonarrIndex === -1) {
    return res
      .status(404)
      .json({ status: '404', message: 'Settings instance not found' });
  }
  const existing = settings.sonarr[sonarrIndex];
  const candidate = {
    ...req.body,
    id: existing.id,
    buttonLabel: normalizeButtonLabel(req.body.buttonLabel),
  } as SonarrSettings;
  const validationError = validateServiceTargetConfig(candidate);
  if (validationError) return next({ status: 400, message: validationError });
  if (
    (isMultiServiceTarget(existing) !== isMultiServiceTarget(candidate) ||
      existing.is4k !== candidate.is4k) &&
    (await hasServiceReferences('sonarr', existing.id))
  ) {
    return next({
      status: 409,
      message:
        'This server is already referenced and its request role or 4K identity cannot be changed. Delete and recreate the server instead.',
    });
  }

  // If we are setting this as the default, clear any previous defaults for the same type first
  // ex: if is4k is true, it will only remove defaults for other servers that have is4k set to true
  // and are the default
  if (candidate.isDefault) {
    settings.sonarr
      .filter((sonarrInstance) => sonarrInstance.is4k === candidate.is4k)
      .forEach((sonarrInstance) => {
        sonarrInstance.isDefault = false;
      });
  }

  settings.sonarr[sonarrIndex] = candidate;
  await settings.save();

  return res.status(200).json(settings.sonarr[sonarrIndex]);
});

sonarrRoutes.delete<{ id: string }>('/:id', async (req, res) => {
  const settings = getSettings();

  const sonarrIndex = settings.sonarr.findIndex(
    (r) => r.id === Number(req.params.id)
  );

  if (sonarrIndex === -1) {
    return res
      .status(404)
      .json({ status: '404', message: 'Settings instance not found' });
  }

  const removed = settings.sonarr.splice(sonarrIndex, 1);
  await settings.save();

  await removeRequestServiceGrants('sonarr', removed[0].id);

  return res.status(200).json(removed[0]);
});

export default sonarrRoutes;
