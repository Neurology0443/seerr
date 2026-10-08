import type { ServiceCommonServer } from '@server/interfaces/api/serviceInterfaces';
import type { OverrideRulesResult } from '@server/lib/overrideRules';

export type DestinationValues = {
  profile?: number;
  folder?: string;
  language?: number;
  tags?: number[];
};

type PersistedDestinationValues = {
  [Field in keyof DestinationValues]: DestinationValues[Field] | null;
};

// Display defaults and rule results are not persisted overrides. PUT assigns
// every configuration field, so untouched fields must retain their exact value.
export const getEditedDestinationValues = (
  persisted: PersistedDestinationValues,
  manual: DestinationValues = {}
): PersistedDestinationValues => ({ ...persisted, ...manual });

export const getDestinationDefaults = (
  server: ServiceCommonServer,
  isAnime: boolean
): DestinationValues => ({
  profile: (isAnime && server.activeAnimeProfileId) || server.activeProfileId,
  folder: (isAnime && server.activeAnimeDirectory) || server.activeDirectory,
  language:
    (isAnime && server.activeAnimeLanguageProfileId) ||
    server.activeLanguageProfileId,
  tags: (isAnime ? server.activeAnimeTags : server.activeTags) ?? [],
});

// Persisted edit overrides and subsequent manual selections have precedence
// over rules. Only unprotected fields are recalculated when rule inputs change.
export const applyDestinationRules = (
  defaults: DestinationValues,
  override: Partial<OverrideRulesResult>,
  protectedValues: DestinationValues
): DestinationValues => ({
  profile: protectedValues.profile ?? override.profileId ?? defaults.profile,
  folder: protectedValues.folder ?? override.rootFolder ?? defaults.folder,
  language: protectedValues.language ?? defaults.language,
  tags: protectedValues.tags ?? override.tags ?? defaults.tags,
});
