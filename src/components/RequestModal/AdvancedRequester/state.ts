import type {
  ServiceCommonServer,
  ServiceCommonServerWithDetails,
} from '@server/interfaces/api/serviceInterfaces';
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

// Creation sends intent only; displayed defaults and rule results stay local.
export const getCreationDestinationOverrides = (
  manual: DestinationValues = {}
): {
  profileId?: number;
  rootFolder?: string;
  languageProfileId?: number;
  tags?: number[];
} => ({
  ...(manual.profile !== undefined &&
    manual.profile >= 0 && { profileId: manual.profile }),
  ...(manual.folder && { rootFolder: manual.folder }),
  ...(manual.language !== undefined &&
    manual.language >= 0 && { languageProfileId: manual.language }),
  ...(manual.tags !== undefined && { tags: manual.tags }),
});

export type InvalidDestinationSelection = {
  server: boolean;
  profile: boolean;
  folder: boolean;
  language: boolean;
  tags: number[];
};

// Undefined metadata cannot confirm invalidity. Cached successful inventories
// still describe known-invalid selections during a retry or network failure.
// Only the exact destination's inventory may validate its configuration.
export const validateDestinationSelection = ({
  selectedServer,
  is4k,
  servers,
  eligibleServers,
  serverData,
  values,
}: {
  selectedServer: number | null;
  is4k: boolean;
  servers?: ServiceCommonServer[];
  eligibleServers?: ServiceCommonServer[];
  serverData?: ServiceCommonServerWithDetails;
  values: PersistedDestinationValues;
}): InvalidDestinationSelection => {
  const exactMetadata =
    serverData?.server.id === selectedServer ? serverData : undefined;
  const selected = servers?.find((server) => server.id === selectedServer);

  return {
    server:
      selectedServer !== null &&
      ((servers !== undefined && (!selected || selected.is4k !== is4k)) ||
        (eligibleServers !== undefined &&
          !eligibleServers.some((server) => server.id === selectedServer)) ||
        (serverData !== undefined &&
          (!exactMetadata || exactMetadata.server.is4k !== is4k))),
    profile:
      !!exactMetadata &&
      values.profile != null &&
      values.profile >= 0 &&
      !exactMetadata.profiles.some((profile) => profile.id === values.profile),
    folder:
      !!exactMetadata &&
      values.folder != null &&
      values.folder !== '' &&
      !exactMetadata.rootFolders.some(
        (folder) => folder.path === values.folder
      ),
    language:
      !!exactMetadata?.languageProfiles &&
      values.language != null &&
      values.language >= 0 &&
      !exactMetadata.languageProfiles.some(
        (profile) => profile.id === values.language
      ),
    tags: exactMetadata
      ? (values.tags ?? []).filter(
          (id) => !exactMetadata.tags.some((tag) => tag.id === id)
        )
      : [],
  };
};

// Display defaults and rule results are not persisted overrides. PUT assigns
// every configuration field, so untouched fields must retain their exact value
// unless the destination changes, in which case the new resolved values apply.
export const getEditedDestinationValues = (
  persisted: PersistedDestinationValues,
  manual: DestinationValues = {},
  resolved?: DestinationValues & { destinationChanged?: boolean }
): PersistedDestinationValues => ({
  ...(resolved?.destinationChanged
    ? {
        profile: resolved.profile ?? null,
        folder: resolved.folder ?? null,
        language: resolved.language ?? null,
        tags: resolved.tags ?? null,
      }
    : persisted),
  ...manual,
});

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
