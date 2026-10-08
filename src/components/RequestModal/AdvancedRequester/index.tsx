/* eslint-disable react-hooks/exhaustive-deps */
import Alert from '@app/components/Common/Alert';
import Button from '@app/components/Common/Button';
import CachedImage from '@app/components/Common/CachedImage';
import { SmallLoadingSpinner } from '@app/components/Common/LoadingSpinner';
import SlideCheckbox from '@app/components/Common/SlideCheckbox';
import {
  applyDestinationRules,
  getDestinationDefaults,
  validateDestinationSelection,
  type DestinationValues,
} from '@app/components/RequestModal/AdvancedRequester/state';
import type { User } from '@app/hooks/useUser';
import { Permission, useUser } from '@app/hooks/useUser';
import globalMessages from '@app/i18n/globalMessages';
import defineMessages from '@app/utils/defineMessages';
import { formatBytes } from '@app/utils/numberHelpers';
import {
  Label,
  Listbox,
  ListboxButton,
  ListboxOption,
  ListboxOptions,
  Transition,
} from '@headlessui/react';
import { CheckIcon, ChevronDownIcon } from '@heroicons/react/24/solid';
import type {
  ServiceCommonServer,
  ServiceCommonServerWithDetails,
} from '@server/interfaces/api/serviceInterfaces';
import type { UserResultsResponse } from '@server/interfaces/api/userInterfaces';
import type { OverrideRulesResult } from '@server/lib/overrideRules';
import { hasPermission } from '@server/lib/permissions';
import axios from 'axios';
import { isEqual } from 'lodash';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useIntl } from 'react-intl';
import Select from 'react-select';
import useSWR from 'swr';

type OptionType = {
  value: number;
  label: string;
};

const messages = defineMessages('components.RequestModal.AdvancedRequester', {
  advancedoptions: 'Advanced',
  destinationserver: 'Destination Server',
  qualityprofile: 'Quality Profile',
  rootfolder: 'Root Folder',
  animenote: '* This series is an anime.',
  default: '{name} (Default)',
  selectserver: 'Select destination server',
  unavailableserver: 'Unavailable destination (#{id})',
  invalidserver:
    'Destination {name} (#{id}) is unavailable or incompatible with this request. Select an eligible destination or correct its configuration.',
  invalidconfiguration:
    'Some selected configuration values are unavailable. Choose valid replacements or remove unavailable tags to continue.',
  unavailablevalue: '{value} (Unavailable)',
  metadataerror: 'Unable to load destination metadata.',
  overrideruleserror:
    'Unable to load Override Rules. Retry to finish configuring this request.',
  folder: '{path} ({space})',
  requestas: 'Request As',
  languageprofile: 'Language Profile',
  tags: 'Tags',
  selecttags: 'Select tags',
  notagoptions: 'No tags.',
  ignoreQuotaTitle: 'Bypass User Quota',
  ignoreQuotaDescription:
    "This request will not count against the user's quota limits. Use with caution.",
});

export type RequestOverrides = {
  server?: number;
  profile?: number;
  folder?: string;
  tags?: number[];
  language?: number;
  user?: User;
  ignoreQuota?: boolean;
  isReady?: boolean;
  hasConfigurationChanges?: boolean;
  hasInvalidConfiguration?: boolean;
  hasLocalChanges?: boolean;
  manualValues?: DestinationValues;
  destinationChanged?: boolean;
};

interface AdvancedRequesterProps {
  type: 'movie' | 'tv';
  tmdbId?: number;
  is4k: boolean;
  isAnime?: boolean;
  defaultOverrides?: RequestOverrides;
  initialServerId?: number;
  destinationReadOnly?: boolean;
  disabled?: boolean;
  hideDestinationSelector?: boolean;
  requestUser?: User;
  requestId?: number;
  quota?: { movie: { limit?: number }; tv: { limit?: number } };
  onServerChange?: (serverId: number) => void;
  onChange: (overrides: RequestOverrides) => void;
}

const AdvancedRequester = ({
  type,
  tmdbId,
  is4k = false,
  isAnime = false,
  defaultOverrides,
  initialServerId,
  destinationReadOnly = false,
  disabled = false,
  hideDestinationSelector = false,
  requestUser,
  requestId,
  quota,
  onServerChange,
  onChange,
}: AdvancedRequesterProps) => {
  const intl = useIntl();
  const { user: currentUser, hasPermission: currentHasPermission } = useUser();
  const {
    data,
    error,
    isValidating: isListValidating,
  } = useSWR<ServiceCommonServer[]>(
    `/api/v1/service/${type === 'movie' ? 'radarr' : 'sonarr'}`,
    {
      refreshInterval: 0,
      refreshWhenHidden: false,
      revalidateOnFocus: false,
      revalidateOnMount: true,
    }
  );
  const [selectedServer, setSelectedServer] = useState<number | null>(
    defaultOverrides?.server !== undefined && defaultOverrides?.server >= 0
      ? defaultOverrides?.server
      : (initialServerId ?? null)
  );
  const [selectedProfile, setSelectedProfile] = useState<number>(
    defaultOverrides?.profile ?? -1
  );
  const [selectedFolder, setSelectedFolder] = useState<string>(
    defaultOverrides?.folder ?? ''
  );

  const [selectedLanguage, setSelectedLanguage] = useState<number>(
    defaultOverrides?.language ?? -1
  );

  const [selectedTags, setSelectedTags] = useState<number[]>(
    defaultOverrides?.tags ?? []
  );

  const [ignoreQuota, setIgnoreQuota] = useState<boolean>(
    defaultOverrides?.ignoreQuota ?? false
  );
  const [configuredServerId, setConfiguredServerId] = useState<number | null>(
    null
  );
  const [overrideRulesError, setOverrideRulesError] = useState(false);
  const [rulesRetry, setRulesRetry] = useState(0);
  const [destinationChanged, setDestinationChanged] = useState(false);
  const [hasLocalActions, setHasLocalActions] = useState(false);
  const originalServer = useRef(selectedServer);
  const [manualValues, setManualValues] = useState<DestinationValues>({});
  const manualValuesRef = useRef<DestinationValues>({});
  const ruleEvaluationRef = useRef<{
    key: string;
    resolutionInputKey: string;
    tags: number[];
    defaults: DestinationValues;
    applied: boolean;
    result: Promise<Partial<OverrideRulesResult>>;
  } | null>(null);
  const initializedServer = useRef<number | null>(null);
  const formRevision = useRef(0);
  const persistedOverrides = useRef(defaultOverrides);
  const hasConfigurationChanges =
    destinationChanged || Object.keys(manualValues).length > 0;
  const isIgnoreQuotaVisible =
    currentHasPermission([Permission.MANAGE_REQUESTS]) &&
    ((type === 'movie' ? quota?.movie.limit : quota?.tv.limit) ?? 0) > 0;

  const {
    data: loadedServerData,
    isValidating,
    error: serverError,
  } = useSWR<ServiceCommonServerWithDetails>(
    selectedServer !== null
      ? `/api/v1/service/${
          type === 'movie' ? 'radarr' : 'sonarr'
        }/${selectedServer}`
      : null,
    {
      refreshInterval: 0,
      refreshWhenHidden: false,
      revalidateOnFocus: false,
    }
  );
  const serverData =
    loadedServerData?.server.id === selectedServer
      ? loadedServerData
      : undefined;
  const tierServers =
    data?.filter(
      (server) =>
        server.is4k === is4k &&
        (!requestId ||
          destinationReadOnly ||
          !server.independentRequestDestination)
    ) ?? [];
  const invalid = validateDestinationSelection({
    selectedServer,
    is4k,
    servers: data,
    eligibleServers: data ? tierServers : undefined,
    serverData: loadedServerData,
    values: {
      profile: selectedProfile,
      folder: selectedFolder,
      language: type === 'tv' ? selectedLanguage : undefined,
      tags: selectedTags,
    },
  });
  const hasInvalidConfiguration =
    invalid.server ||
    invalid.profile ||
    invalid.folder ||
    invalid.language ||
    invalid.tags.length > 0;
  const isConfigurationResolved =
    selectedServer !== null &&
    !!data &&
    !!serverData &&
    configuredServerId === selectedServer &&
    !isListValidating &&
    !error &&
    !isValidating &&
    !serverError &&
    !overrideRulesError;
  const isConfigurationReady =
    isConfigurationResolved && !hasInvalidConfiguration;
  const original = persistedOverrides.current;
  const usePersistedOverrides =
    !destinationChanged &&
    (original?.server == null || original.server === selectedServer);
  const [selectedUser, setSelectedUser] = useState<User | null>(
    requestUser ?? null
  );
  const selectedUserId = selectedUser?.id;
  const previousSelectedUserIdRef = useRef<number | undefined>(selectedUserId);
  const ruleParameters = {
    mediaType: type,
    is4k,
    requestUser: selectedUserId ?? requestUser?.id ?? currentUser?.id,
    tmdbId,
    serviceId: selectedServer,
    requestId,
  };
  // Classification affects local defaults, not the Override Rules HTTP payload.
  const resolutionInputKey = JSON.stringify([
    ruleParameters,
    rulesRetry,
    isAnime,
  ]);
  // A default-tag metadata change is not a user/rule-input change. Retain the
  // evaluation's tags until another resolution event or explicit tag selection.
  const ruleTags =
    manualValues.tags ??
    (usePersistedOverrides ? original?.tags : undefined) ??
    (initializedServer.current === selectedServer &&
    ruleEvaluationRef.current?.resolutionInputKey === resolutionInputKey
      ? ruleEvaluationRef.current.tags
      : serverData
        ? getDestinationDefaults(serverData.server, isAnime).tags
        : []) ??
    [];
  const ruleTagsKey = JSON.stringify(ruleTags);

  const { data: userData } = useSWR<UserResultsResponse>(
    currentHasPermission([Permission.MANAGE_REQUESTS, Permission.MANAGE_USERS])
      ? '/api/v1/user?take=1000&sort=displayname'
      : null
  );
  const filteredUserData = useMemo(
    () =>
      userData?.results.filter((user) =>
        hasPermission(
          is4k
            ? [
                Permission.REQUEST_4K,
                type === 'movie'
                  ? Permission.REQUEST_4K_MOVIE
                  : Permission.REQUEST_4K_TV,
              ]
            : [
                Permission.REQUEST,
                type === 'movie'
                  ? Permission.REQUEST_MOVIE
                  : Permission.REQUEST_TV,
              ],
          user.permissions,
          { type: 'or' }
        )
      ),
    [userData?.results]
  );

  useEffect(() => {
    if (filteredUserData && !requestUser && !selectedUser) {
      const nextSelectedUser =
        filteredUserData.find((u) => u.id === currentUser?.id) ?? null;

      if (nextSelectedUser?.id !== selectedUserId) {
        setIgnoreQuota(false);
      }

      setSelectedUser(nextSelectedUser);
    }
  }, [filteredUserData]);

  useEffect(() => {
    const requestedServer = defaultOverrides?.server ?? initialServerId;
    const defaultServer = data?.find(
      (server) =>
        server.isDefault &&
        is4k === server.is4k &&
        (!requestId || !server.independentRequestDestination)
    );
    const nextServer = requestedServer ?? defaultServer?.id;

    if (selectedServer === null && nextServer !== undefined) {
      originalServer.current ??= nextServer;
      setSelectedServer(nextServer);
    }
  }, [data, defaultOverrides?.server, initialServerId, is4k]);

  useEffect(() => {
    const selectedUserChanged =
      previousSelectedUserIdRef.current !== selectedUserId;
    previousSelectedUserIdRef.current = selectedUserId;

    if (!isIgnoreQuotaVisible || selectedUserChanged) {
      setIgnoreQuota(false);
    }
  }, [isIgnoreQuotaVisible, selectedUserId]);

  useEffect(() => {
    const unchangedHistorical =
      requestId &&
      persistedOverrides.current?.server == null &&
      !destinationChanged;
    onChange({
      folder: selectedFolder !== '' ? selectedFolder : undefined,
      profile: selectedProfile !== -1 ? selectedProfile : undefined,
      server: unchangedHistorical ? undefined : (selectedServer ?? undefined),
      user: selectedUser ?? undefined,
      language: selectedLanguage !== -1 ? selectedLanguage : undefined,
      tags: selectedTags,
      ignoreQuota: isIgnoreQuotaVisible && ignoreQuota ? true : undefined,
      isReady: isConfigurationReady,
      hasConfigurationChanges,
      hasInvalidConfiguration,
      hasLocalChanges: hasLocalActions || hasConfigurationChanges,
      manualValues,
      destinationChanged,
    });
  }, [
    selectedFolder,
    selectedServer,
    selectedProfile,
    selectedUser,
    selectedLanguage,
    selectedTags,
    ignoreQuota,
    isIgnoreQuotaVisible,
    isConfigurationReady,
    hasConfigurationChanges,
    hasInvalidConfiguration,
    hasLocalActions,
    manualValues,
    destinationChanged,
  ]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!serverData || serverData.server.id !== selectedServer) {
        return;
      }

      const revision = formRevision.current;
      const protectedValues: DestinationValues = {
        ...(usePersistedOverrides
          ? {
              ...(original?.profile != null && { profile: original.profile }),
              ...(original?.folder && { folder: original.folder }),
              ...(original?.language != null && {
                language: original.language,
              }),
              ...(original?.tags != null && { tags: original.tags }),
            }
          : {}),
        ...manualValuesRef.current,
      };
      const defaults = getDestinationDefaults(serverData.server, isAnime);
      const applyValues = (values: DestinationValues) => {
        setSelectedProfile(values.profile ?? -1);
        setSelectedFolder(values.folder ?? '');
        setSelectedLanguage(values.language ?? -1);
        setSelectedTags(values.tags ?? []);
      };

      // Initialize once per destination, including an explicit return to it.
      const initializing = initializedServer.current !== selectedServer;
      if (initializing) {
        initializedServer.current = selectedServer;
        applyValues(applyDestinationRules(defaults, {}, protectedValues));
      }
      try {
        const parameters = { ...ruleParameters, tags: ruleTags };
        const key = JSON.stringify([parameters, rulesRetry]);
        // Reuse the current evaluation (including an in-flight response or
        // failure) when API inputs are unchanged. Only Retry repeats failures.
        if (ruleEvaluationRef.current?.key !== key) {
          setConfiguredServerId(null);
          setOverrideRulesError(false);
          ruleEvaluationRef.current = {
            key,
            resolutionInputKey,
            tags: ruleTags,
            defaults,
            applied: false,
            result: tmdbId
              ? axios
                  .post<OverrideRulesResult>(
                    '/api/v1/overrideRule/advancedRequest',
                    parameters
                  )
                  .then(({ data }) => data)
              : Promise.resolve({}),
          };
        }
        const evaluation = ruleEvaluationRef.current;
        if (
          initializing ||
          evaluation.resolutionInputKey !== resolutionInputKey
        ) {
          setConfiguredServerId(null);
          evaluation.resolutionInputKey = resolutionInputKey;
          evaluation.tags = ruleTags;
          evaluation.defaults = defaults;
          evaluation.applied = false;
        }
        // Metadata-only refreshes validate established values without replaying
        // defaults or cached rules. A pending evaluation keeps its own defaults.
        if (evaluation.applied) return;
        const override = await evaluation.result;
        if (
          cancelled ||
          revision !== formRevision.current ||
          evaluation.resolutionInputKey !== resolutionInputKey
        ) {
          return;
        }

        applyValues(
          applyDestinationRules(evaluation.defaults, override, {
            ...protectedValues,
            ...manualValuesRef.current,
          })
        );
        evaluation.applied = true;
        setConfiguredServerId(serverData.server.id);
      } catch {
        if (!cancelled && revision === formRevision.current) {
          setOverrideRulesError(true);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [
    tmdbId,
    type,
    is4k,
    serverData,
    selectedServer,
    selectedUserId,
    requestUser?.id,
    currentUser?.id,
    isAnime,
    requestId,
    destinationChanged,
    ruleTagsKey,
    rulesRetry,
  ]);

  const isServerConfigurationLoading =
    selectedServer !== null && !isConfigurationResolved;
  const changeServer = (serverId: number) => {
    if (
      disabled ||
      destinationReadOnly ||
      serverId === selectedServer ||
      !tierServers.some((server) => server.id === serverId)
    ) {
      return;
    }

    formRevision.current += 1;
    initializedServer.current = null;
    setHasLocalActions(true);
    setDestinationChanged(serverId !== originalServer.current);
    manualValuesRef.current = {};
    setManualValues({});
    setConfiguredServerId(null);
    setOverrideRulesError(false);
    setSelectedProfile(-1);
    setSelectedFolder('');
    setSelectedLanguage(-1);
    setSelectedTags([]);
    setSelectedServer(serverId);
    onServerChange?.(serverId);
  };
  const changeValue = (values: DestinationValues) => {
    if (disabled) return;
    const nextManualValues = { ...manualValuesRef.current, ...values };
    // An explicit selection can match a displayed default while still changing
    // a persisted null. Only an already-recorded selection is a no-op.
    if (isEqual(nextManualValues, manualValuesRef.current)) {
      return;
    }

    // Profile, folder and language are local overrides, not rule inputs.
    // Keep them authoritative even if an evaluation is already in flight.
    manualValuesRef.current = nextManualValues;
    setHasLocalActions(true);
    setManualValues(manualValuesRef.current);
    if (values.tags !== undefined && !isEqual(values.tags, ruleTags)) {
      formRevision.current += 1;
      setConfiguredServerId(null);
      setOverrideRulesError(false);
    }
    if (values.profile !== undefined) setSelectedProfile(values.profile);
    if (values.folder !== undefined) setSelectedFolder(values.folder);
    if (values.language !== undefined) setSelectedLanguage(values.language);
    if (values.tags !== undefined) setSelectedTags(values.tags);
  };
  const retryOverrideRules = () => {
    if (disabled || !serverData || serverError || isValidating) return;

    formRevision.current += 1;
    setOverrideRulesError(false);
    setConfiguredServerId(null);
    setRulesRetry((previous) => previous + 1);
  };

  if (!data && !error) {
    return (
      <div className="mb-2 w-full">
        <SmallLoadingSpinner />
      </div>
    );
  }

  if (
    isConfigurationReady &&
    !error &&
    !serverError &&
    !overrideRulesError &&
    (!data ||
      (selectedServer !== null &&
        tierServers.length < 2 &&
        (!serverData ||
          (serverData.profiles.length < 2 &&
            serverData.rootFolders.length < 2 &&
            (serverData.languageProfiles ?? []).length < 2 &&
            !serverData.tags?.length)))) &&
    (!selectedUser || (filteredUserData ?? []).length < 2)
  ) {
    return null;
  }

  return (
    <>
      <div className="mb-2 mt-4 flex items-center text-lg font-semibold">
        {intl.formatMessage(messages.advancedoptions)}
      </div>
      {invalid.server && (
        <div role="alert">
          <Alert
            type="error"
            title={intl.formatMessage(messages.invalidserver, {
              name:
                data?.find((server) => server.id === selectedServer)?.name ??
                serverData?.server.name ??
                '',
              id: selectedServer,
            })}
          />
        </div>
      )}
      {hasInvalidConfiguration && !invalid.server && (
        <div role="alert">
          <Alert
            type="error"
            title={intl.formatMessage(messages.invalidconfiguration)}
          />
        </div>
      )}
      {(error || serverError) && (
        <div role="alert">
          <Alert
            type="error"
            title={intl.formatMessage(messages.metadataerror)}
          />
        </div>
      )}
      {overrideRulesError && (
        <div role="alert">
          <Alert
            type="error"
            title={intl.formatMessage(messages.overrideruleserror)}
          >
            <Button
              type="button"
              buttonSize="sm"
              onClick={retryOverrideRules}
              disabled={
                disabled || !serverData || !!serverError || isValidating
              }
            >
              {intl.formatMessage(globalMessages.retry)}
            </Button>
          </Alert>
        </div>
      )}
      <div className="rounded-md">
        {(!!data || selectedServer !== null) && (
          <div className="flex flex-col md:flex-row">
            {!hideDestinationSelector &&
              (tierServers.length > 1 ||
                selectedServer === null ||
                invalid.server ||
                destinationReadOnly) && (
                <div className="mb-3 w-full flex-shrink-0 flex-grow last:pr-0 md:w-1/4 md:pr-4">
                  <label htmlFor="server">
                    {intl.formatMessage(messages.destinationserver)}
                  </label>
                  <select
                    id="server"
                    name="server"
                    value={selectedServer ?? ''}
                    onChange={(e) => changeServer(Number(e.target.value))}
                    className="border-gray-700 bg-gray-800"
                    disabled={disabled || destinationReadOnly}
                  >
                    {selectedServer === null && (
                      <option value="" disabled>
                        {intl.formatMessage(messages.selectserver)}
                      </option>
                    )}
                    {selectedServer !== null &&
                      (invalid.server ||
                        !tierServers.some(
                          (server) => server.id === selectedServer
                        )) && (
                        <option value={selectedServer} disabled>
                          {intl.formatMessage(messages.unavailableserver, {
                            id: selectedServer,
                          })}
                        </option>
                      )}
                    {tierServers
                      .filter(
                        (server) =>
                          !invalid.server || server.id !== selectedServer
                      )
                      .map((server) => (
                        <option
                          key={`server-list-${server.id}`}
                          value={server.id}
                        >
                          {server.isDefault
                            ? intl.formatMessage(messages.default, {
                                name: server.name,
                              })
                            : server.name}
                        </option>
                      ))}
                  </select>
                </div>
              )}
            {(isServerConfigurationLoading ||
              invalid.profile ||
              !serverData ||
              serverData.profiles.length > 1) && (
              <div className="mb-3 w-full flex-shrink-0 flex-grow last:pr-0 md:w-1/4 md:pr-4">
                <label htmlFor="profile">
                  {intl.formatMessage(messages.qualityprofile)}
                </label>
                <select
                  id="profile"
                  name="profile"
                  value={selectedProfile}
                  onChange={(e) =>
                    changeValue({ profile: Number(e.target.value) })
                  }
                  className="border-gray-700 bg-gray-800"
                  disabled={
                    disabled || isServerConfigurationLoading || !serverData
                  }
                >
                  {invalid.profile && (
                    <option value={selectedProfile} disabled>
                      {intl.formatMessage(messages.unavailablevalue, {
                        value: selectedProfile,
                      })}
                    </option>
                  )}
                  {(isServerConfigurationLoading || !serverData) && (
                    <option value="">
                      {intl.formatMessage(globalMessages.loading)}
                    </option>
                  )}
                  {!isServerConfigurationLoading &&
                    serverData &&
                    serverData.profiles
                      .toSorted((a, b) =>
                        a.name.localeCompare(b.name, intl.locale, {
                          numeric: true,
                          sensitivity: 'base',
                        })
                      )
                      .map((profile) => (
                        <option
                          key={`profile-list${profile.id}`}
                          value={profile.id}
                        >
                          {isAnime &&
                          serverData.server.activeAnimeProfileId === profile.id
                            ? intl.formatMessage(messages.default, {
                                name: profile.name,
                              })
                            : !isAnime &&
                                serverData.server.activeProfileId === profile.id
                              ? intl.formatMessage(messages.default, {
                                  name: profile.name,
                                })
                              : profile.name}
                        </option>
                      ))}
                </select>
              </div>
            )}
            {(isServerConfigurationLoading ||
              invalid.folder ||
              !serverData ||
              serverData.rootFolders.length > 1) && (
              <div className="mb-3 w-full flex-shrink-0 flex-grow last:pr-0 md:w-1/4 md:pr-4">
                <label htmlFor="folder">
                  {intl.formatMessage(messages.rootfolder)}
                </label>
                <select
                  id="folder"
                  name="folder"
                  value={selectedFolder}
                  onChange={(e) => changeValue({ folder: e.target.value })}
                  className="border-gray-700 bg-gray-800"
                  disabled={
                    disabled || isServerConfigurationLoading || !serverData
                  }
                >
                  {invalid.folder && (
                    <option value={selectedFolder} disabled>
                      {intl.formatMessage(messages.unavailablevalue, {
                        value: selectedFolder,
                      })}
                    </option>
                  )}
                  {(isServerConfigurationLoading || !serverData) && (
                    <option value="">
                      {intl.formatMessage(globalMessages.loading)}
                    </option>
                  )}
                  {!isServerConfigurationLoading &&
                    serverData &&
                    serverData.rootFolders.map((folder) => (
                      <option
                        key={`folder-list${folder.id}`}
                        value={folder.path}
                      >
                        {isAnime &&
                        serverData.server.activeAnimeDirectory === folder.path
                          ? intl.formatMessage(messages.default, {
                              name: intl.formatMessage(messages.folder, {
                                path: folder.path,
                                space: formatBytes(folder.freeSpace ?? 0),
                              }),
                            })
                          : !isAnime &&
                              serverData.server.activeDirectory === folder.path
                            ? intl.formatMessage(messages.default, {
                                name: intl.formatMessage(messages.folder, {
                                  path: folder.path,
                                  space: formatBytes(folder.freeSpace ?? 0),
                                }),
                              })
                            : intl.formatMessage(messages.folder, {
                                path: folder.path,
                                space: formatBytes(folder.freeSpace ?? 0),
                              })}
                      </option>
                    ))}
                </select>
              </div>
            )}
            {type === 'tv' &&
              (isServerConfigurationLoading ||
                invalid.language ||
                !serverData ||
                (serverData.languageProfiles ?? []).length > 1) && (
                <div className="mb-3 w-full flex-shrink-0 flex-grow last:pr-0 md:w-1/4 md:pr-4">
                  <label htmlFor="language">
                    {intl.formatMessage(messages.languageprofile)}
                  </label>
                  <select
                    id="language"
                    name="language"
                    value={selectedLanguage}
                    onChange={(e) =>
                      changeValue({ language: Number(e.target.value) })
                    }
                    className="border-gray-700 bg-gray-800"
                    disabled={
                      disabled || isServerConfigurationLoading || !serverData
                    }
                  >
                    {invalid.language && (
                      <option value={selectedLanguage} disabled>
                        {intl.formatMessage(messages.unavailablevalue, {
                          value: selectedLanguage,
                        })}
                      </option>
                    )}
                    {(isServerConfigurationLoading || !serverData) && (
                      <option value="">
                        {intl.formatMessage(globalMessages.loading)}
                      </option>
                    )}
                    {!isServerConfigurationLoading &&
                      serverData &&
                      serverData.languageProfiles?.map((language) => (
                        <option
                          key={`folder-list${language.id}`}
                          value={language.id}
                        >
                          {isAnime &&
                          serverData.server.activeAnimeLanguageProfileId ===
                            language.id
                            ? intl.formatMessage(messages.default, {
                                name: language.name,
                              })
                            : !isAnime &&
                                serverData.server.activeLanguageProfileId ===
                                  language.id
                              ? intl.formatMessage(messages.default, {
                                  name: language.name,
                                })
                              : language.name}
                        </option>
                      ))}
                  </select>
                </div>
              )}
          </div>
        )}
        {selectedServer !== null &&
          (isServerConfigurationLoading ||
            invalid.tags.length > 0 ||
            !serverData ||
            !!serverData?.tags?.length) && (
            <div className="mb-2">
              <label htmlFor="tags">{intl.formatMessage(messages.tags)}</label>
              <Select<OptionType, true>
                name="tags"
                options={(serverData?.tags ?? []).map((tag) => ({
                  label: tag.label,
                  value: tag.id,
                }))}
                isMulti
                isDisabled={
                  disabled || isServerConfigurationLoading || !serverData
                }
                placeholder={
                  isServerConfigurationLoading || !serverData
                    ? intl.formatMessage(globalMessages.loading)
                    : intl.formatMessage(messages.selecttags)
                }
                className="react-select-container react-select-container-dark"
                classNamePrefix="react-select"
                value={selectedTags.map((tagId) => {
                  const foundTag = serverData?.tags.find(
                    (tag) => tag.id === tagId
                  );

                  return {
                    value: tagId,
                    label:
                      foundTag?.label ??
                      intl.formatMessage(messages.unavailablevalue, {
                        value: tagId,
                      }),
                  };
                })}
                onChange={(value) => {
                  changeValue({ tags: value.map((option) => option.value) });
                }}
                noOptionsMessage={() =>
                  intl.formatMessage(messages.notagoptions)
                }
              />
            </div>
          )}
        {isIgnoreQuotaVisible && (
          <div className="mb-2">
            <label htmlFor="ignoreQuota">
              {intl.formatMessage(messages.ignoreQuotaTitle)}
            </label>
            <div className="flex items-center justify-between">
              <p className="text-sm text-gray-400">
                {intl.formatMessage(messages.ignoreQuotaDescription)}
              </p>
              <SlideCheckbox
                checked={ignoreQuota}
                disabled={disabled}
                onClick={() => {
                  if (disabled) return;
                  setHasLocalActions(true);
                  setIgnoreQuota(!ignoreQuota);
                }}
              />
            </div>
          </div>
        )}
        {currentHasPermission([
          Permission.MANAGE_REQUESTS,
          Permission.MANAGE_USERS,
        ]) &&
          selectedUser &&
          (filteredUserData ?? []).length > 1 && (
            <Listbox
              disabled={disabled}
              as="div"
              value={selectedUser}
              onChange={(value) => {
                if (disabled || value.id === selectedUserId) return;
                setHasLocalActions(true);
                formRevision.current += 1;
                setConfiguredServerId(null);
                setOverrideRulesError(false);
                setIgnoreQuota(false);
                setSelectedUser(value);
              }}
              className="space-y-1"
            >
              {({ open }) => (
                <>
                  <Label>{intl.formatMessage(messages.requestas)}</Label>
                  <div className="relative">
                    <span className="inline-block w-full rounded-md shadow-sm">
                      <ListboxButton className="focus:shadow-outline-blue relative w-full cursor-default rounded-md border border-gray-700 bg-gray-800 py-2 pl-3 pr-10 text-left text-white transition duration-150 ease-in-out focus:border-blue-300 focus:outline-none sm:text-sm sm:leading-5">
                        <span className="flex items-center">
                          <CachedImage
                            type="avatar"
                            src={selectedUser.avatar}
                            alt=""
                            className="h-6 w-6 flex-shrink-0 rounded-full object-cover"
                            width={24}
                            height={24}
                          />
                          <span className="ml-3 block">
                            {selectedUser.displayName}
                          </span>
                          {selectedUser.displayName.toLowerCase() !==
                            selectedUser.email && (
                            <span className="ml-1 truncate text-gray-400">
                              ({selectedUser.email})
                            </span>
                          )}
                        </span>
                        <span className="pointer-events-none absolute inset-y-0 right-0 flex items-center pr-2 text-gray-500">
                          <ChevronDownIcon className="h-5 w-5" />
                        </span>
                      </ListboxButton>
                    </span>

                    <Transition
                      as="div"
                      show={open}
                      enter="transition-opacity ease-in duration-300"
                      enterFrom="opacity-0"
                      enterTo="opacity-100"
                      leave="transition-opacity ease-in duration-100"
                      leaveFrom="opacity-100"
                      leaveTo="opacity-0"
                      className="mt-1 w-full rounded-md border border-gray-700 bg-gray-800 shadow-lg"
                    >
                      <ListboxOptions
                        static
                        className="shadow-xs max-h-60 overflow-auto rounded-md py-1 text-base leading-6 focus:outline-none sm:text-sm sm:leading-5"
                      >
                        {filteredUserData?.map((user) => (
                          <ListboxOption
                            key={user.id}
                            value={user}
                            disabled={disabled}
                          >
                            {({ selected, active }) => (
                              <div
                                className={`${
                                  active
                                    ? 'bg-indigo-600 text-white'
                                    : 'text-gray-300'
                                } relative cursor-default select-none py-2 pl-8 pr-4`}
                              >
                                <span
                                  className={`${
                                    selected ? 'font-semibold' : 'font-normal'
                                  } flex items-center`}
                                >
                                  <CachedImage
                                    type="avatar"
                                    src={user.avatar}
                                    alt=""
                                    className="h-6 w-6 flex-shrink-0 rounded-full object-cover"
                                    width={24}
                                    height={24}
                                  />
                                  <span className="ml-3 block flex-shrink-0">
                                    {user.displayName}
                                  </span>
                                  {user.displayName.toLowerCase() !==
                                    user.email && (
                                    <span className="ml-1 truncate text-gray-400">
                                      ({user.email})
                                    </span>
                                  )}
                                </span>
                                {selected && (
                                  <span
                                    className={`${
                                      active ? 'text-white' : 'text-indigo-600'
                                    } absolute inset-y-0 left-0 flex items-center pl-1.5`}
                                  >
                                    <CheckIcon className="h-5 w-5" />
                                  </span>
                                )}
                              </div>
                            )}
                          </ListboxOption>
                        ))}
                      </ListboxOptions>
                    </Transition>
                  </div>
                </>
              )}
            </Listbox>
          )}
        {isAnime && (
          <div className="mt-4 italic">
            {intl.formatMessage(messages.animenote)}
          </div>
        )}
      </div>
    </>
  );
};

export default AdvancedRequester;
