// Runs against the existing Cypress app/database, like movie-details.cy.ts.
// Arr, request mutations and requestability are stubbed for these UI regressions.
import type {
  MovieRequestTarget,
  TvRequestTarget,
} from '@server/interfaces/api/requestInterfaces';

const movieId = 438148;
const tvId = 66732;
const animeKeywords = [{ id: 210024, name: 'Anime' }];
const admin = {
  id: 1,
  displayName: 'Admin',
  email: 'admin@seerr.dev',
  avatar: '/avatar.png',
  permissions: 2,
  warnings: [],
  userType: 1,
};
const beneficiary = { ...admin, id: 2, displayName: 'Beneficiary' };
const servers = [1, 2].map((id) => ({
  id,
  name: id === 1 ? 'FR' : 'EN',
  is4k: false,
  isDefault: id === 1,
  independentRequestDestination: false,
  activeProfileId: id * 10,
  activeDirectory: `/${id}`,
  activeLanguageProfileId: id * 10,
  activeTags: [id],
}));
const details = (id: number) => ({
  server: servers[id - 1],
  profiles: [
    { id: id * 10, name: 'Default' },
    { id: id * 10 + 1, name: 'Custom' },
  ],
  rootFolders: [
    { id: 1, path: `/${id}` },
    { id: 2, path: '/custom' },
  ],
  languageProfiles: [
    { id: id * 10, name: 'Default' },
    { id: 31, name: 'Custom' },
  ],
  tags: [{ id, label: `Tag ${id}` }],
});
const expectCreationOverrides = (
  body: Record<string, unknown>,
  expected: Record<string, unknown> = {}
) => {
  for (const field of [
    'profileId',
    'rootFolder',
    'languageProfileId',
    'tags',
  ]) {
    if (Object.prototype.hasOwnProperty.call(expected, field))
      expect(body[field]).to.deep.eq(expected[field]);
    else expect(body).not.to.have.property(field);
  }
};
const pending = (id: number, serverId: number | null) => ({
  id,
  editRevision: `revision-${id}`,
  serverId,
  is4k: false,
  status: 1,
  requestedBy: admin,
  profileId: 11 as number | null,
  rootFolder: '/custom' as string | null,
  languageProfileId: 31 as number | null,
  tags: [] as number[] | null,
  createdAt: '2020-01-01T00:00:00Z',
  updatedAt: '2020-01-01T00:00:00Z',
  seasonCount: 1,
  seasons: [{ id, seasonNumber: 1, status: 1 }],
});

const createdRequest = (
  type: 'movie' | 'tv',
  serverId: number,
  seasons: number[] = []
) => ({
  ...pending(201, serverId),
  type,
  status: 2,
  profileId: serverId * 10,
  rootFolder: `/${serverId}`,
  languageProfileId: type === 'tv' ? serverId * 10 : undefined,
  tags: [serverId],
  seasonCount: seasons.length,
  seasons: seasons.map((number) => ({
    id: 200 + number,
    seasonNumber: number,
    status: 2,
  })),
  media: {
    id: 100,
    tmdbId: type === 'movie' ? movieId : tvId,
    mediaType: type,
    status: 1,
    status4k: 1,
  },
  target: {
    serverId,
    name: servers[serverId - 1].name,
    is4k: false,
    isIndependent: true,
    deleted: false,
    status: 3,
  },
});

const visitMedia = (
  type: 'movie' | 'tv',
  requests: ReturnType<typeof pending>[] = [],
  blocklisted = false,
  independent = false,
  targetOverrides?: (MovieRequestTarget | TvRequestTarget)[],
  seasonNumbers = [1, 2],
  isAnime = false
) => {
  const id = type === 'movie' ? movieId : tvId;
  const media = {
    id: 100,
    tmdbId: id,
    mediaType: type,
    requests: requests.map((request) => ({
      ...request,
      type,
      media: { id: 100, tmdbId: id, status: 1, status4k: 1 },
    })),
    status: blocklisted ? 6 : 1,
    status4k: blocklisted ? 6 : 1,
    seasons: [],
    issues: [],
  };
  const common = {
    id,
    genres: [],
    keywords: isAnime ? animeKeywords : [],
    credits: { cast: [], crew: [] },
    productionCompanies: [],
    productionCountries: [],
    externalIds: { tvdbId: 123 },
    spokenLanguages: [],
    relatedVideos: [],
    watchProviders: [],
    voteCount: 0,
    voteAverage: 0,
    popularity: 0,
    overview: 'UI regression fixture',
    mediaInfo: media,
  };
  const title =
    type === 'movie'
      ? {
          ...common,
          title: 'Correction Movie',
          originalTitle: 'Correction Movie',
          releaseDate: '2020-01-01',
          releases: { results: [] },
          status: 'Released',
        }
      : {
          ...common,
          name: 'Correction Series',
          originalName: 'Correction Series',
          firstAirDate: '2020-01-01',
          contentRatings: { results: [] },
          networks: [],
          createdBy: [],
          episodeRunTime: [],
          languages: [],
          originCountry: [],
          numberOfSeasons: 2,
          seasons: seasonNumbers.map((number) => ({
            id: number,
            seasonNumber: number,
            episodeCount: 10,
            name: `Season ${number}`,
          })),
        };
  cy.intercept('GET', `/api/v1/${type}/${id}`, title).as('title');
  for (const request of media.requests) {
    cy.intercept('GET', `/api/v1/request/${request.id}`, request).as('detail');
  }
  const requestTargets = targetOverrides ?? [
    ...servers.map((server) => ({
      serverId: server.id,
      name: server.name,
      is4k: false,
      isDefault: server.isDefault,
      isIndependent: independent,
      status: 1,
      requestable: true,
      seasons: seasonNumbers.map((number) => ({
        seasonNumber: number,
        status: 1,
        requestable: true,
      })),
    })),
    {
      serverId: 3,
      name: '4K',
      is4k: true,
      isDefault: true,
      isIndependent: independent,
      status: 1,
      requestable: true,
      seasons: [],
    },
  ];
  cy.intercept(
    'GET',
    `/api/v1/${type}/${id}/request-targets`,
    requestTargets
  ).as('targets');
  cy.visit(`/${type}/${id}`);
  cy.wait(['@title', '@targets']);
  if (requests.length > 0) {
    // The initial SSR data does not contain this scenario's pending requests.
    // Waiting for the response alone does not mean React has rendered it yet.
    const firstRequest = requests[0];
    const destination =
      servers.find((server) => server.id === firstRequest.serverId)?.name ??
      `Request #${firstRequest.id}`;
    cy.get('[data-testid="request-button"]').should(
      'have.text',
      `View Request — ${destination}`
    );
  }
  return title;
};

const clickAction = (label: RegExp) => {
  cy.get('[data-testid="request-button"]').then(($button) => {
    if (label.test($button.text())) {
      cy.contains('[data-testid="request-button"]', label).click();
    } else {
      cy.wrap($button).parent().find('button[aria-label="Expand"]').click();
      // Only menu items are actionable while Headless UI's modal menu is open.
      cy.get('[role="menu"]').contains('[role="menuitem"]', label).click();
    }
  });
};

// Use the existing SWR revalidation test pattern: control its deduplication
// timer from page load, then reconnect and wait for the actual responses.
const refreshEditCaches = () => {
  cy.tick(2000);
  cy.window().then((win) => {
    win.dispatchEvent(new win.Event('offline'));
    win.dispatchEvent(new win.Event('online'));
  });
  cy.tick(0);
  cy.clock().then((clock) => clock.restore());
};

// Hold a revalidation while a parent/form rerender commits newer callbacks.
const delayRequestDetail = (
  request: ReturnType<typeof pending> & { type: 'movie' | 'tv' }
) => {
  let release: (() => void) | undefined;
  cy.intercept(
    'GET',
    `/api/v1/request/${request.id}`,
    (req) =>
      new Promise<void>((resolve) => {
        release = () => {
          req.reply(request);
          resolve();
        };
      })
  ).as('remoteDetail');
  return () => {
    cy.wrap(null).should(() => expect(release).to.be.a('function'));
    cy.then(() => release?.());
  };
};

// Custom controls must reject activation themselves; fieldset disabling alone
// does not protect their click and keyboard handlers.
const expectLockedEditControls = (type: 'movie' | 'tv') => {
  for (const id of [
    'server',
    'profile',
    'folder',
    ...(type === 'tv' ? ['language'] : []),
  ]) {
    cy.get(`#${id}`)
      .should('be.disabled')
      .trigger('mousedown', { force: true })
      .trigger('keydown', { key: 'ArrowDown', force: true });
  }
  cy.get('.react-select__control')
    .should('have.class', 'react-select__control--is-disabled')
    .click({ force: true })
    .trigger('keydown', { key: 'ArrowDown', force: true });
  cy.get('.react-select__menu').should('not.exist');
  cy.contains('[role="dialog"] button', 'Admin')
    .should('be.disabled')
    .click({ force: true })
    .trigger('keydown', { key: 'ArrowDown', force: true });
  cy.get('[role="option"]').should('not.exist');
  if (type === 'tv') {
    cy.contains('[role="dialog"] label', 'Bypass User Quota')
      .parent()
      .find('[role="checkbox"]')
      .should('have.attr', 'aria-disabled', 'true')
      .and('have.attr', 'aria-checked', 'false')
      .click({ force: true })
      .trigger('keydown', { key: 'Enter', force: true })
      .trigger('keydown', { key: ' ', force: true })
      .should('have.attr', 'aria-checked', 'false');
  }
  cy.get('#server').should('have.value', '1');
  cy.get('#profile').should('have.value', '10');
  cy.get('#folder').should('have.value', '/custom');
  if (type === 'tv') cy.get('#language').should('have.value', '31');
  cy.get('.react-select__multi-value').should('not.exist');
  cy.contains('[role="dialog"] button', 'Admin').should('be.visible');
};

describe('Request destinations', () => {
  beforeEach(() => {
    cy.loginAsAdmin();
    cy.intercept('GET', '/api/v1/auth/me', admin);
    cy.intercept('GET', '/api/v1/user?*', { results: [admin, beneficiary] });
    cy.intercept('GET', '/api/v1/user/*/quota', {
      movie: { limit: 0, restricted: false },
      tv: { limit: 0, restricted: false },
    });
    cy.intercept('GET', '/api/v1/settings/public', (req) => {
      req.continue((res) =>
        Object.assign(res.body, {
          movie4kEnabled: true,
          series4kEnabled: true,
          partialRequestsEnabled: true,
        })
      );
    });
    for (const kind of ['radarr', 'sonarr']) {
      cy.intercept('GET', `/api/v1/service/${kind}`, servers);
      cy.intercept('GET', `/api/v1/service/${kind}/1`, details(1)).as(
        'server1'
      );
      cy.intercept('GET', `/api/v1/service/${kind}/2`, details(2)).as(
        'server2'
      );
    }
    cy.intercept('POST', '/api/v1/overrideRule/advancedRequest', {}).as(
      'rules'
    );
    cy.intercept('POST', '/api/v1/request', {
      statusCode: 409,
      body: { message: 'Conflict' },
    }).as('create');
    cy.intercept('PUT', '/api/v1/request/*', {
      editRevision: 'saved-revision',
    }).as('edit');
    cy.intercept('DELETE', '/api/v1/request/*', { statusCode: 204 }).as(
      'delete'
    );
    cy.intercept('POST', '/api/v1/request/*/approve', {}).as('approve');
    cy.intercept('POST', '/api/v1/request/*/decline', {}).as('decline');
  });

  describe('explicit creation overrides', () => {
    for (const type of ['movie', 'tv'] as const) {
      for (const independent of [false, true]) {
        const openCreation = () => {
          const kind = type === 'movie' ? 'radarr' : 'sonarr';
          const configuredServers = servers.map((server) => ({
            ...server,
            independentRequestDestination: independent,
          }));
          cy.intercept('GET', `/api/v1/service/${kind}`, configuredServers);
          for (const id of [1, 2])
            cy.intercept('GET', `/api/v1/service/${kind}/${id}`, {
              ...details(id),
              server: configuredServers[id - 1],
            });
          visitMedia(type, [], false, independent);
          clickAction(/^Request$/);
          cy.get('#profile').should('not.be.disabled').and('have.value', '10');
          cy.get('#folder').should('have.value', '/1');
          cy.get('.react-select__multi-value').should('contain', 'Tag 1');
          if (type === 'tv') cy.get('#language').should('have.value', '10');
        };
        const submit = (
          serverId: number,
          manual: Record<string, unknown> = {}
        ) => {
          if (type === 'tv')
            cy.get('[role="dialog"] tbody [role="checkbox"]').first().click();
          cy.contains(
            '[role="dialog"] button',
            type === 'movie' ? /^Request$/ : /^Request 1 Season$/
          )
            .should('not.be.disabled')
            .click();
          cy.wait('@create').then(({ request }) => {
            expect(request.body.serverId).to.eq(serverId);
            expectCreationOverrides(request.body, manual);
          });
        };
        const context = `${type} on a ${independent ? 'independent' : 'native'} destination`;

        it(`omits displayed defaults for ${context}`, () => {
          openCreation();
          cy.get('@rules.all').should((calls) => {
            for (const call of calls as unknown as {
              request: { body: Record<string, unknown> };
            }[])
              expect(call.request.body).not.to.have.property('tags');
          });
          submit(1);
        });

        for (const [field, value, expected] of [
          ['profile', '11', { profileId: 11 }],
          ['folder', '/custom', { rootFolder: '/custom' }],
          ...(type === 'tv'
            ? [['language', '31', { languageProfileId: 31 }]]
            : []),
        ] as [string, string, Record<string, unknown>][]) {
          it(`sends only the manual ${field} for ${context}`, () => {
            openCreation();
            cy.get(`#${field}`).select(value);
            submit(1, expected);
          });
        }

        it(`keeps an explicitly restored default profile for ${context}`, () => {
          openCreation();
          cy.get('#profile').select('11').should('have.value', '11');
          cy.get('#profile').select('10').should('have.value', '10');
          submit(1, { profileId: 10 });
        });

        it(`previews and submits explicit empty tags for ${context}`, () => {
          openCreation();
          cy.get('.react-select__multi-value__remove').click();
          cy.get('@rules.all').should((calls) => {
            const evaluations = calls as unknown as {
              request: { body: Record<string, unknown> };
            }[];
            expect(
              evaluations[evaluations.length - 1].request.body.tags
            ).to.deep.eq([]);
          });
          submit(1, { tags: [] });
        });

        for (const returnToOriginal of [false, true]) {
          it(`clears manual configuration across ${returnToOriginal ? 'A → B → A' : 'A → B'} for ${context}`, () => {
            openCreation();
            cy.get('#profile').select('11');
            cy.get('#folder').select('/custom');
            if (type === 'tv') cy.get('#language').select('31');
            cy.get('.react-select__multi-value__remove').click();
            cy.get('#profile').should('not.be.disabled');
            cy.get('#server').select('2');
            cy.get('#profile')
              .should('not.be.disabled')
              .and('have.value', '20');
            cy.get('#folder').should('have.value', '/2');
            cy.get('.react-select__multi-value').should('contain', 'Tag 2');
            if (type === 'tv') cy.get('#language').should('have.value', '20');
            if (returnToOriginal) {
              cy.get('#profile').select('21');
              cy.get('#server').select('1');
              cy.get('#profile')
                .should('not.be.disabled')
                .and('have.value', '10');
              cy.get('#folder').should('have.value', '/1');
            }
            submit(returnToOriginal ? 1 : 2);
          });
        }

        it(`displays rule tags without adding destination defaults for ${context}`, () => {
          const kind = type === 'movie' ? 'radarr' : 'sonarr';
          // Keep the rule tag valid in both native and independent inventories.
          const metadata = details(1);
          metadata.tags.push({ id: 2, label: 'Tag 2' });
          cy.intercept(
            'POST',
            '/api/v1/overrideRule/advancedRequest',
            (req) => {
              expect(req.body).not.to.have.property('tags');
              req.reply({ profileId: 11, rootFolder: '/custom', tags: [2] });
            }
          ).as('creationRules');
          const configuredServers = servers.map((server) => ({
            ...server,
            independentRequestDestination: independent,
          }));
          cy.intercept('GET', `/api/v1/service/${kind}`, configuredServers);
          cy.intercept('GET', `/api/v1/service/${kind}/1`, {
            ...metadata,
            server: configuredServers[0],
          });
          visitMedia(type, [], false, independent);
          clickAction(/^Request$/);
          cy.get('#profile').should('not.be.disabled').and('have.value', '11');
          cy.get('#folder').should('have.value', '/custom');
          cy.get('.react-select__multi-value')
            .should('have.length', 1)
            .and('contain', 'Tag 2');
          submit(1);
        });
      }
    }
  });

  describe('confirmed configuration invalidation', () => {
    // Keep SWR's deduplication timers controlled across multiple retries.
    const revalidateMetadata = () => {
      cy.tick(2000);
      cy.window().then((win) => {
        win.dispatchEvent(new win.Event('offline'));
        win.dispatchEvent(new win.Event('online'));
      });
      cy.tick(0);
    };
    const creationButton = /^Request(?: 1 Season)?(?: in 4K| 4K)?$/;
    const openCreation = (type: 'movie' | 'tv', is4k = false) => {
      visitMedia(type);
      clickAction(is4k ? /^Request in 4K$/ : /^Request$/);
      cy.get('#server').should('have.prop', 'value', '1');
      cy.get('#profile').should('not.be.disabled');
      if (type === 'tv') {
        cy.get('[role="dialog"] tbody [role="checkbox"]').first().click();
      }
      cy.contains('[role="dialog"] button', creationButton).should(
        'not.be.disabled'
      );
    };
    beforeEach(() => {
      cy.clock(Date.now(), ['setTimeout', 'clearTimeout']);
    });

    describe('anime classification resolution', () => {
      const normal = { profile: 10, folder: '/1', language: 10, tags: [1] };
      const anime = (sharedTags: boolean) => ({
        profile: 12,
        folder: '/anime',
        language: 13,
        tags: sharedTags ? [1] : [2],
      });
      const genericRules = { profileId: 11, rootFolder: '/custom' };
      const normalWithRules = {
        ...normal,
        profile: genericRules.profileId,
        folder: genericRules.rootFolder,
      };
      const interceptClassificationRules = (initiallyAnime = false) => {
        let classification = initiallyAnime;
        cy.intercept('POST', '/api/v1/overrideRule/advancedRequest', (req) => {
          // Generic rules stop applying when TMDB classifies the series as anime.
          req.reply(classification ? {} : genericRules);
          classification = !classification;
        }).as('rules');
      };
      const configureAnime = (sharedTags = true) => {
        const metadata = details(1);
        cy.intercept('GET', '/api/v1/service/sonarr/1', {
          ...metadata,
          server: {
            ...metadata.server,
            activeAnimeProfileId: 12,
            activeAnimeDirectory: '/anime',
            activeAnimeLanguageProfileId: 13,
            activeAnimeTags: sharedTags ? [1] : [2],
          },
          profiles: [...metadata.profiles, { id: 12, name: 'Anime' }],
          rootFolders: [...metadata.rootFolders, { id: 3, path: '/anime' }],
          languageProfiles: [
            ...metadata.languageProfiles,
            { id: 13, name: 'Anime' },
          ],
          tags: [
            { id: 1, label: 'Tag 1' },
            { id: 2, label: 'Tag 2' },
          ],
        });
      };
      const changeClassification = (
        title: ReturnType<typeof visitMedia>,
        isAnime: boolean
      ) => {
        cy.intercept('GET', `/api/v1/tv/${tvId}`, {
          ...title,
          keywords: isAnime ? animeKeywords : [],
        }).as('classification');
        revalidateMetadata();
        cy.wait('@classification');
        cy.contains('[role="dialog"]', '* This series is an anime.').should(
          isAnime ? 'be.visible' : 'not.exist'
        );
      };
      const expectConfiguration = (values: typeof normal) => {
        cy.get('#server').should('have.prop', 'value', '1');
        cy.get('#profile')
          .should('not.be.disabled')
          .and('have.prop', 'value', String(values.profile));
        cy.get('#folder').should('have.prop', 'value', values.folder);
        cy.get('#language').should(
          'have.prop',
          'value',
          String(values.language)
        );
        cy.get('.react-select__multi-value').should(
          'have.length',
          values.tags.length
        );
        for (const id of values.tags)
          cy.get('.react-select__multi-value').should('contain', `Tag ${id}`);
      };
      const expectCreation = (manual: Record<string, unknown> = {}) => {
        cy.contains('[role="dialog"] button', creationButton)
          .should('not.be.disabled')
          .click();
        cy.wait('@create').then(({ request }) => {
          expect(request.body.serverId).to.eq(1);
          expectCreationOverrides(request.body, manual);
          expect(request.body.seasons).to.deep.eq([1]);
        });
      };
      const expectRuleCalls = (count: number, identicalInputs = false) => {
        cy.get('@rules.all').should((calls) => {
          const requests = calls as unknown as {
            request: { body: { tags: number[] } };
          }[];
          expect(requests.length).to.eq(count);
          for (const call of requests) {
            expect(call.request.body).not.to.have.property('isAnime');
            if (identicalInputs)
              expect(call.request.body).to.deep.eq(requests[0].request.body);
          }
        });
      };

      for (const initiallyAnime of [false, true]) {
        it(`reevaluates ${initiallyAnime ? 'anime to normal' : 'normal to anime'} rules despite identical HTTP inputs`, () => {
          configureAnime();
          interceptClassificationRules(initiallyAnime);
          const title = visitMedia(
            'tv',
            [],
            false,
            false,
            undefined,
            [1, 2],
            initiallyAnime
          );
          clickAction(/^Request$/);
          cy.get('[role="dialog"] tbody [role="checkbox"]').first().click();
          expectConfiguration(initiallyAnime ? anime(true) : normalWithRules);
          expectRuleCalls(1);
          changeClassification(title, !initiallyAnime);
          const expected = initiallyAnime ? normalWithRules : anime(true);
          expectConfiguration(expected);
          expectRuleCalls(2, true);
          // Revalidating metadata without another transition must not replay rules.
          changeClassification(title, !initiallyAnime);
          expectConfiguration(expected);
          expectRuleCalls(2, true);
          expectCreation();
        });
      }

      it('resolves distinct anime tags in both directions with fresh rule evaluations', () => {
        configureAnime(false);
        const title = visitMedia('tv');
        clickAction(/^Request$/);
        cy.get('[role="dialog"] tbody [role="checkbox"]').first().click();
        expectConfiguration(normal);
        changeClassification(title, true);
        expectConfiguration(anime(false));
        expectRuleCalls(2);
        changeClassification(title, false);
        expectConfiguration(normal);
        expectRuleCalls(3);
        expectCreation();
      });

      for (const sharedTags of [true, false]) {
        it(`keeps the latest anime rules after an obsolete evaluation with ${sharedTags ? 'shared' : 'distinct'} default tags and identical HTTP inputs`, () => {
          configureAnime(sharedTags);
          let release: (() => void) | undefined;
          let evaluations = 0;
          cy.intercept(
            'POST',
            '/api/v1/overrideRule/advancedRequest',
            (req) => {
              if (++evaluations > 1) {
                req.reply({ rootFolder: '/custom' });
                return;
              }
              return new Promise<void>((resolve) => {
                release = () => {
                  req.reply(genericRules);
                  resolve();
                };
              });
            }
          ).as('rules');
          const title = visitMedia('tv');
          clickAction(/^Request$/);
          cy.get('[role="dialog"] tbody [role="checkbox"]').first().click();
          cy.wrap(null).should(() => expect(release).to.be.a('function'));
          changeClassification(title, true);
          const expected = { ...anime(sharedTags), folder: '/custom' };
          expectConfiguration(expected);
          expectRuleCalls(2, true);
          cy.contains('[role="dialog"] button', creationButton).should(
            'not.be.disabled'
          );
          cy.then(() => release?.());
          cy.wait(['@rules', '@rules']);
          expectConfiguration(expected);
          expectRuleCalls(2, true);
          expectCreation();
        });
      }

      it('preserves manual fields while resolving unprotected anime fields', () => {
        configureAnime(false);
        cy.intercept('POST', '/api/v1/overrideRule/advancedRequest', {
          profileId: 10,
          rootFolder: '/1',
        }).as('rules');
        const title = visitMedia('tv');
        clickAction(/^Request$/);
        cy.get('[role="dialog"] tbody [role="checkbox"]').first().click();
        expectConfiguration(normal);
        cy.get('#profile').select('11');
        cy.get('#folder').select('/custom');
        changeClassification(title, true);
        expectConfiguration({
          ...anime(false),
          profile: 11,
          folder: '/custom',
        });
        cy.get('#language').select('31');
        cy.get('.react-select__multi-value__remove').click();
        const protectedValues = {
          profile: 11,
          folder: '/custom',
          language: 31,
          tags: [],
        };
        expectConfiguration(protectedValues);
        expectRuleCalls(3);
        changeClassification(title, false);
        expectConfiguration(protectedValues);
        expectRuleCalls(4);
        expectCreation({
          profileId: 11,
          rootFolder: '/custom',
          languageProfileId: 31,
          tags: [],
        });
      });

      for (const nullable of [false, true]) {
        it(`preserves ${nullable ? 'nullable' : 'explicit'} independent edit overrides on anime classification changes`, () => {
          configureAnime(false);
          interceptClassificationRules();
          const request = pending(101, 1);
          if (nullable) {
            request.profileId = null;
            request.rootFolder = null;
            request.languageProfileId = null;
          }
          const title = visitMedia('tv', [request], false, true);
          clickAction(/^View Request — FR$/);
          expectConfiguration(
            nullable
              ? { ...normalWithRules, tags: [] }
              : { profile: 11, folder: '/custom', language: 31, tags: [] }
          );
          changeClassification(title, true);
          expectConfiguration(
            nullable
              ? { ...anime(false), tags: [] }
              : { profile: 11, folder: '/custom', language: 31, tags: [] }
          );
          cy.get('#server').should('be.disabled');
          expectRuleCalls(2, true);
          cy.contains('[role="dialog"] button', /^Approve Request$/)
            .should('not.be.disabled')
            .click();
          cy.wait('@edit').then(({ request: edit }) => {
            expect(edit.headers['if-match']).to.eq('"revision-101"');
            expect(edit.body).to.include({
              serverId: 1,
              profileId: request.profileId,
              rootFolder: request.rootFolder,
              languageProfileId: request.languageProfileId,
            });
            expect(edit.body.tags).to.deep.eq([]);
            expect(edit.body.seasons).to.deep.eq([1]);
          });
        });
      }
    });

    for (const type of ['movie', 'tv'] as const) {
      const kind = type === 'movie' ? 'radarr' : 'sonarr';
      for (const field of [
        'profile',
        'folder',
        ...(type === 'tv' ? ['language'] : []),
      ]) {
        for (const automatic of [false, true]) {
          it(`preserves an invalid ${automatic ? 'automatically resolved ' : ''}${type} ${field} and exposes its only replacement`, () => {
            openCreation(type);
            const selected = automatic
              ? field === 'folder'
                ? '/1'
                : '10'
              : field === 'profile'
                ? '11'
                : field === 'folder'
                  ? '/custom'
                  : '31';
            const replacement = automatic
              ? field === 'folder'
                ? '/replacement'
                : '20'
              : field === 'folder'
                ? '/1'
                : '10';
            let rulesCount = 0;
            cy.get('@rules.all').then((calls) => {
              rulesCount = (calls as unknown as unknown[]).length;
            });
            if (automatic)
              cy.get(`#${field}`).should('have.prop', 'value', selected);
            else cy.get(`#${field}`).select(selected);
            const refreshed = details(1);
            if (field === 'profile') {
              refreshed.profiles = automatic
                ? [{ id: 20, name: 'New default' }]
                : refreshed.profiles.slice(0, 1);
              if (automatic)
                refreshed.server = { ...refreshed.server, activeProfileId: 20 };
            }
            if (field === 'folder') {
              refreshed.rootFolders = automatic
                ? [{ id: 3, path: '/replacement' }]
                : refreshed.rootFolders.slice(0, 1);
              if (automatic)
                refreshed.server = {
                  ...refreshed.server,
                  activeDirectory: '/replacement',
                };
            }
            if (field === 'language') {
              refreshed.languageProfiles = automatic
                ? [{ id: 20, name: 'New default' }]
                : refreshed.languageProfiles.slice(0, 1);
              if (automatic)
                refreshed.server = {
                  ...refreshed.server,
                  activeLanguageProfileId: 20,
                };
            }
            cy.intercept('GET', `/api/v1/service/${kind}/1`, refreshed).as(
              'metadata'
            );
            revalidateMetadata();
            cy.wait('@metadata');
            cy.get(`#${field}`)
              .should('be.visible')
              .and('not.be.disabled')
              .and('have.prop', 'value', selected);
            cy.get(`#${field} option:selected`)
              .should('be.disabled')
              .and('contain', 'Unavailable');
            cy.contains('[role="dialog"] button', creationButton).should(
              'be.disabled'
            );
            cy.get('#server').should('have.prop', 'value', '1');
            cy.get('@rules.all').should((calls) => {
              expect((calls as unknown as unknown[]).length).to.eq(rulesCount);
            });
            cy.get(`#${field}`).select(replacement);
            cy.contains('[role="dialog"] button', creationButton).should(
              'not.be.disabled'
            );
            cy.get('@create.all').should('have.length', 0);
            if (automatic) {
              cy.contains('[role="dialog"] button', creationButton).click();
              cy.wait('@create').then(({ request }) => {
                const key =
                  field === 'profile'
                    ? 'profileId'
                    : field === 'folder'
                      ? 'rootFolder'
                      : 'languageProfileId';
                expect(request.body[key]).to.eq(
                  field === 'folder' ? replacement : Number(replacement)
                );
              });
            }
          });
        }
      }

      it(`preserves missing ${type} tags until the user removes them`, () => {
        openCreation(type);
        let rulesCount = 0;
        cy.get('@rules.all').then((calls) => {
          rulesCount = (calls as unknown as unknown[]).length;
        });
        cy.intercept('GET', `/api/v1/service/${kind}/1`, {
          ...details(1),
          server: { ...servers[0], activeTags: [] },
          tags: [],
        }).as('metadata');
        revalidateMetadata();
        cy.wait('@metadata');
        cy.get('.react-select__multi-value').should(
          'contain',
          '1 (Unavailable)'
        );
        cy.contains('[role="dialog"] button', creationButton).should(
          'be.disabled'
        );
        cy.get('@rules.all').should((calls) => {
          expect((calls as unknown as unknown[]).length).to.eq(rulesCount);
        });
        cy.get('.react-select__multi-value__remove').click();
        cy.get('.react-select__multi-value').should('not.exist');
        cy.contains('[role="dialog"] button', creationButton).should(
          'not.be.disabled'
        );
        cy.get('@rules.all').should((calls) => {
          const requests = calls as unknown as {
            request: { body: { tags: number[] } };
          }[];
          expect(requests[requests.length - 1].request.body.tags).to.deep.eq(
            []
          );
        });
      });

      for (const is4k of [false, true]) {
        it(`blocks a ${type} ${is4k ? '4K to Standard' : 'Standard to 4K'} tier change without retargeting`, () => {
          const initial = servers.map((server) => ({ ...server, is4k }));
          cy.intercept('GET', `/api/v1/service/${kind}`, initial);
          for (const id of [1, 2]) {
            cy.intercept('GET', `/api/v1/service/${kind}/${id}`, {
              ...details(id),
              server: initial[id - 1],
            });
          }
          if (is4k) {
            cy.request('/api/v1/settings/public').then(({ body }) => {
              cy.intercept('GET', '/api/v1/settings/public', {
                ...body,
                movie4kEnabled: true,
                series4kEnabled: true,
                partialRequestsEnabled: true,
              }).as('tierSettings');
            });
            // The targets and service inventories describe the same initial tier.
            visitMedia(
              type,
              [],
              false,
              false,
              initial.map((server) => ({
                serverId: server.id,
                name: server.name,
                is4k,
                isDefault: server.isDefault,
                isIndependent: false,
                status: 1,
                requestable: true,
                seasons: [1, 2].map((seasonNumber) => ({
                  seasonNumber,
                  status: 1,
                  requestable: true,
                })),
              }))
            );
            cy.wait('@tierSettings');
            cy.tick(0);
            clickAction(/^Request in 4K$/);
            cy.get('#profile').should('not.be.disabled');
            if (type === 'tv')
              cy.get('[role="dialog"] tbody [role="checkbox"]').first().click();
          } else openCreation(type);
          cy.contains('[role="dialog"] button', creationButton).should(
            'not.be.disabled'
          );
          cy.intercept('GET', `/api/v1/service/${kind}`, [
            { ...initial[0], is4k: !is4k },
            initial[1],
          ]).as('inventory');
          // Deliberately retain the original detail tier to exercise SWR disagreement.
          revalidateMetadata();
          cy.wait('@inventory');
          cy.contains('[role="alert"]', 'Destination FR (#1)').should(
            'be.visible'
          );
          cy.get('#server').should('be.visible').and('have.prop', 'value', '1');
          cy.contains('[role="dialog"] button', creationButton).should(
            'be.disabled'
          );
          cy.get('#server').select('2');
          cy.get('#profile')
            .should('not.be.disabled')
            .and('have.prop', 'value', '20');
          if (type === 'tv') {
            cy.get('[role="dialog"] tbody [role="checkbox"]')
              .first()
              .should('have.attr', 'aria-checked', 'false')
              .click();
          }
          cy.contains('[role="dialog"] button', creationButton).should(
            'not.be.disabled'
          );
        });
      }

      it(`blocks a deleted ${type} destination and a mismatched detail without replacing it`, () => {
        openCreation(type);
        cy.intercept('GET', `/api/v1/service/${kind}/1`, {
          ...details(1),
          server: { ...servers[0], is4k: true },
        }).as('metadata');
        revalidateMetadata();
        cy.wait('@metadata');
        cy.get('#server').should('have.prop', 'value', '1');
        cy.contains('[role="dialog"] button', creationButton).should(
          'be.disabled'
        );
        cy.intercept('GET', `/api/v1/service/${kind}/1`, details(1));
        cy.intercept('GET', `/api/v1/service/${kind}`, [servers[1]]).as(
          'inventory'
        );
        revalidateMetadata();
        cy.wait('@inventory');
        cy.get('#server option:selected')
          .should('be.disabled')
          .and('contain', '#1');
        cy.contains('[role="dialog"] button', creationButton).should(
          'be.disabled'
        );
        cy.get('#server').select('2');
        cy.get('#profile')
          .should('not.be.disabled')
          .and('have.prop', 'value', '20');
      });

      it(`keeps ${type} manual values through loading, failure and confirmed recovery`, () => {
        openCreation(type);
        cy.get('#profile').select('11');
        cy.get('#folder').select('/custom');
        let release: (() => void) | undefined;
        cy.intercept(
          'GET',
          `/api/v1/service/${kind}/1`,
          (req) =>
            new Promise<void>((resolve) => {
              release = () => {
                req.reply({ statusCode: 500 });
                resolve();
              };
            })
        ).as('failure');
        revalidateMetadata();
        cy.wrap(null).should(() => expect(release).to.be.a('function'));
        cy.contains('[role="dialog"] button', creationButton).should(
          'be.disabled'
        );
        cy.then(() => release?.());
        cy.wait('@failure');
        cy.contains(
          '[role="alert"]',
          'Unable to load destination metadata.'
        ).should('be.visible');
        cy.contains('[role="alert"]', 'Some selected configuration').should(
          'not.exist'
        );
        cy.intercept('GET', `/api/v1/service/${kind}/1`, details(1)).as(
          'recovery'
        );
        revalidateMetadata();
        cy.wait('@recovery');
        cy.get('#profile')
          .should('not.be.disabled')
          .and('have.prop', 'value', '11');
        cy.get('#folder').should('have.prop', 'value', '/custom');
        cy.contains('[role="dialog"] button', creationButton).should(
          'not.be.disabled'
        );
        cy.intercept('GET', `/api/v1/service/${kind}/1`, {
          ...details(1),
          profiles: details(1).profiles.slice(0, 1),
        }).as('removed');
        revalidateMetadata();
        cy.wait('@removed');
        cy.get('#profile').should('have.prop', 'value', '11');
        cy.contains('[role="dialog"] button', creationButton).should(
          'be.disabled'
        );
        cy.intercept('GET', `/api/v1/service/${kind}/1`, details(1)).as(
          'restored'
        );
        revalidateMetadata();
        cy.wait('@restored');
        cy.get('#profile')
          .should('not.be.disabled')
          .and('have.prop', 'value', '11');
        cy.contains('[role="dialog"] button', creationButton).should(
          'not.be.disabled'
        );
      });

      it(`blocks confirmed invalid historical ${type} fields and preserves conditional editing`, () => {
        visitMedia(type, [pending(101, 1)]);
        clickAction(/^View Request — FR$/);
        cy.get('#profile').should('not.be.disabled');
        cy.intercept('GET', `/api/v1/service/${kind}/1`, {
          ...details(1),
          server: {
            ...servers[0],
            activeProfileId: 20,
            activeDirectory: '/replacement',
          },
          profiles: [{ id: 20, name: 'New default' }],
          rootFolders: [{ id: 3, path: '/replacement' }],
        }).as('metadata');
        revalidateMetadata();
        cy.wait('@metadata');
        cy.get('#profile')
          .should('have.prop', 'value', '11')
          .and('not.be.disabled');
        cy.get('#folder').should('have.prop', 'value', '/custom');
        cy.contains(
          '[role="dialog"] button',
          /^Approve Request$|^Edit Request$/
        ).should('be.disabled');
        cy.get('#profile').select('20');
        cy.contains(
          '[role="dialog"] button',
          /^Approve Request$|^Edit Request$/
        ).should('be.disabled');
        cy.get('#folder').select('/replacement');
        cy.contains(
          '[role="dialog"] button',
          /^Approve Request$|^Edit Request$/
        )
          .should('not.be.disabled')
          .click();
        cy.wait('@edit').then(({ request }) => {
          expect(request.headers['if-match']).to.eq('"revision-101"');
          expect(request.body.serverId).to.eq(1);
          expect(request.body.profileId).to.eq(20);
          expect(request.body.rootFolder).to.eq('/replacement');
          if (type === 'tv') expect(request.body.seasons).to.deep.eq([1]);
        });
      });

      it(`keeps cancellation available for an invalid ${type} configuration`, () => {
        cy.intercept('GET', `/api/v1/service/${kind}/1`, {
          ...details(1),
          profiles: details(1).profiles.slice(0, 1),
        });
        visitMedia(type, [pending(101, 1)]);
        clickAction(/^View Request — FR$/);
        cy.get('#profile')
          .should('not.be.disabled')
          .and('have.prop', 'value', '11');
        cy.contains(
          '[role="dialog"] button',
          /^Approve Request$|^Edit Request$/
        ).should('be.disabled');
        if (type === 'tv')
          cy.get('[role="dialog"] tbody [role="checkbox"]').first().click();
        cy.contains('[role="dialog"] button', /^Cancel Request$/)
          .should('not.be.disabled')
          .click();
        cy.wait('@delete');
        cy.get('@edit.all').should('have.length', 0);
      });

      it(`blocks a confirmed missing unresolved ${type} destination while allowing cancellation`, () => {
        cy.intercept('GET', `/api/v1/service/${kind}/99`, { statusCode: 404 });
        visitMedia(type, [pending(101, 99)]);
        clickAction(/^View Request — Request #101$/);
        cy.contains('[role="alert"]', '(#99)').should('be.visible');
        cy.get('#server').should('be.disabled').and('have.prop', 'value', '99');
        cy.contains('[role="dialog"] button', /^Approve Request$/).should(
          'be.disabled'
        );
        if (type === 'tv')
          cy.get('[role="dialog"] tbody [role="checkbox"]').first().click();
        cy.contains('[role="dialog"] button', /^Cancel Request$/)
          .should('not.be.disabled')
          .click();
        cy.wait('@delete');
        cy.get('@edit.all').should('have.length', 0);
      });

      for (const independent of [false, true]) {
        it(`keeps an invalid ${independent ? 'immutable independent' : 'newly ineligible native'} ${type} edit destination`, () => {
          visitMedia(type, [pending(101, 1)], false, independent);
          clickAction(/^View Request — FR$/);
          cy.get('#profile').should('not.be.disabled');
          cy.intercept('GET', `/api/v1/service/${kind}`, [
            {
              ...servers[0],
              independentRequestDestination: true,
              is4k: independent,
            },
            servers[1],
          ]).as('inventory');
          revalidateMetadata();
          cy.wait('@inventory');
          cy.contains('[role="alert"]', 'Destination FR (#1)').should(
            'be.visible'
          );
          cy.get('#server')
            .should('have.prop', 'value', '1')
            .and(independent ? 'be.disabled' : 'not.be.disabled');
          cy.contains(
            '[role="dialog"] button',
            /^Approve Request$|^Edit Request$/
          ).should('be.disabled');
          if (!independent) {
            cy.get('#server').select('2');
            cy.get('#profile')
              .should('not.be.disabled')
              .and('have.prop', 'value', '20');
            cy.contains(
              '[role="dialog"] button',
              /^Approve Request$|^Edit Request$/
            ).should('not.be.disabled');
          }
        });
      }
    }

    for (const languageProfiles of [undefined, null]) {
      it(`accepts Sonarr v4 with ${String(languageProfiles)} language metadata`, () => {
        cy.intercept('GET', '/api/v1/service/sonarr/1', {
          ...details(1),
          languageProfiles,
        });
        openCreation('tv');
        cy.get('#language').should('not.exist');
        cy.contains('[role="dialog"] button', creationButton).should(
          'not.be.disabled'
        );
      });
    }

    it('exposes invalid fields even when every valid selector would otherwise be hidden', () => {
      cy.intercept('GET', '/api/v1/user?*', { results: [admin] });
      cy.intercept('GET', '/api/v1/service/radarr', [servers[0]]);
      cy.intercept('GET', '/api/v1/service/radarr/1', {
        ...details(1),
        server: { ...servers[0], activeTags: [] },
        profiles: details(1).profiles.slice(0, 1),
        rootFolders: details(1).rootFolders.slice(0, 1),
        languageProfiles: undefined,
        tags: [],
      });
      visitMedia('movie', [pending(101, 1)]);
      clickAction(/^View Request — FR$/);
      cy.contains(
        '[role="alert"]',
        'Some selected configuration values are unavailable'
      ).should('be.visible');
      cy.get('#profile')
        .should('be.visible')
        .and('not.be.disabled')
        .and('have.prop', 'value', '11');
      cy.get('#folder')
        .should('be.visible')
        .and('not.be.disabled')
        .and('have.prop', 'value', '/custom');
      cy.contains('[role="dialog"] button', /^Approve Request$/).should(
        'be.disabled'
      );
      cy.get('#profile').select('10');
      cy.get('#folder').select('/1');
      cy.get('#profile').should('not.exist');
      cy.get('#folder').should('not.exist');
      cy.contains('[role="dialog"] button', /^Approve Request$/).should(
        'not.be.disabled'
      );
    });

    it('keeps a deleted destination identifiable and blocked when no replacement exists', () => {
      openCreation('movie');
      cy.intercept('GET', '/api/v1/service/radarr', []).as('inventory');
      revalidateMetadata();
      cy.wait('@inventory');
      cy.contains('[role="alert"]', 'Destination FR (#1)').should('be.visible');
      cy.get('#server').should('have.prop', 'value', '1');
      cy.get('#server option').should('have.length', 1).and('be.disabled');
      cy.contains('[role="dialog"] button', creationButton).should(
        'be.disabled'
      );
    });

    it('retains resolved rules on metadata refresh and reevaluates actual user inputs', () => {
      cy.intercept('GET', '/api/v1/service/radarr/1', {
        ...details(1),
        tags: [
          { id: 1, label: 'Tag 1' },
          { id: 2, label: 'Tag 2' },
        ],
      });
      cy.intercept('POST', '/api/v1/overrideRule/advancedRequest', {
        profileId: 11,
      }).as('resolvedRules');
      openCreation('movie');
      cy.get('#profile').should('have.prop', 'value', '11');
      let rulesCount = 0;
      cy.get('@resolvedRules.all').then((calls) => {
        rulesCount = (calls as unknown as unknown[]).length;
      });
      cy.intercept('GET', '/api/v1/service/radarr/1', {
        ...details(1),
        server: {
          ...servers[0],
          activeProfileId: 20,
          activeDirectory: '/new-default',
        },
        profiles: [
          { id: 20, name: 'New default' },
          { id: 21, name: 'User rule' },
        ],
        rootFolders: [
          { id: 1, path: '/1' },
          { id: 3, path: '/new-default' },
        ],
        tags: [
          { id: 1, label: 'Tag 1' },
          { id: 2, label: 'Tag 2' },
        ],
      }).as('metadata');
      revalidateMetadata();
      cy.wait('@metadata');
      cy.get('#profile')
        .should('not.be.disabled')
        .and('have.prop', 'value', '11');
      cy.get('#profile option:selected').should('contain', 'Unavailable');
      cy.get('#folder').should('have.prop', 'value', '/1');
      cy.get('@resolvedRules.all').should((calls) => {
        expect((calls as unknown as unknown[]).length).to.eq(rulesCount);
      });
      cy.contains('[role="dialog"] button', creationButton).should(
        'be.disabled'
      );
      cy.get('#profile').select('20');
      cy.contains('[role="dialog"] button', creationButton).should(
        'not.be.disabled'
      );
      cy.intercept('POST', '/api/v1/overrideRule/advancedRequest', {
        profileId: 21,
        tags: [2],
      }).as('userRules');
      cy.contains('[role="dialog"] button', 'Admin').click();
      cy.contains('[role="option"]', 'Beneficiary').click();
      cy.wait('@userRules').then(({ request }) => {
        expect(request.body.requestUser).to.eq(2);
        expect(request.body.serviceId).to.eq(1);
        expect(request.body).not.to.have.property('tags');
      });
      cy.get('#profile')
        .should('not.be.disabled')
        .and('have.prop', 'value', '20');
      cy.get('#folder').should('have.prop', 'value', '/new-default');
      cy.get('.react-select__multi-value').should('contain', 'Tag 2');
      cy.contains('[role="dialog"] button', creationButton)
        .should('not.be.disabled')
        .click();
      cy.wait('@create').then(({ request }) => {
        expectCreationOverrides(request.body, { profileId: 20 });
      });
    });

    it('keeps the resolution defaults when metadata changes during pending rules', () => {
      let release: (() => void) | undefined;
      cy.intercept(
        'POST',
        '/api/v1/overrideRule/advancedRequest',
        (req) =>
          new Promise<void>((resolve) => {
            release = () => {
              req.reply({});
              resolve();
            };
          })
      ).as('pendingRules');
      visitMedia('movie');
      clickAction(/^Request$/);
      cy.wrap(null).should(() => expect(release).to.be.a('function'));
      cy.intercept('GET', '/api/v1/service/radarr/1', {
        ...details(1),
        server: { ...servers[0], activeProfileId: 20 },
        profiles: [{ id: 20, name: 'New default' }],
      }).as('metadata');
      revalidateMetadata();
      cy.wait('@metadata');
      cy.then(() => release?.());
      cy.wait('@pendingRules');
      cy.get('@pendingRules.all').should('have.length', 1);
      cy.get('#profile')
        .should('not.be.disabled')
        .and('have.prop', 'value', '10');
      cy.get('#profile option:selected').should('contain', 'Unavailable');
      cy.contains('[role="dialog"] button', creationButton).should(
        'be.disabled'
      );
      cy.get('#profile').select('20');
      cy.contains('[role="dialog"] button', creationButton).should(
        'not.be.disabled'
      );
    });

    it('validates resolved defaults and Override Rules without silently replacing them', () => {
      cy.intercept('GET', '/api/v1/service/radarr/1', {
        ...details(1),
        server: { ...servers[0], activeProfileId: 99 },
      });
      cy.intercept('POST', '/api/v1/overrideRule/advancedRequest', {
        rootFolder: '/removed-rule-folder',
      });
      visitMedia('movie');
      clickAction(/^Request$/);
      cy.get('#profile')
        .should('not.be.disabled')
        .and('have.prop', 'value', '99');
      cy.get('#folder').should('have.prop', 'value', '/removed-rule-folder');
      cy.contains('[role="dialog"] button', creationButton).should(
        'be.disabled'
      );
      cy.get('#profile').select('10');
      cy.get('#folder').select('/1');
      cy.contains('[role="dialog"] button', creationButton).should(
        'not.be.disabled'
      );
    });
  });

  for (const operation of ['approval', 'cancellation'] as const) {
    it(
      `ignores an obsolete successful ${operation} after reopening`,
      { defaultCommandTimeout: 15000 },
      () => {
        const type = operation === 'approval' ? 'tv' : 'movie';
        let release: (() => void) | undefined;
        cy.intercept(
          operation === 'approval' ? 'POST' : 'DELETE',
          operation === 'approval'
            ? '/api/v1/request/101/approve'
            : '/api/v1/request/101',
          (req) =>
            new Promise<void>((resolve) => {
              release = () => {
                req.reply({
                  statusCode: operation === 'approval' ? 200 : 204,
                  body: {},
                });
                resolve();
              };
            })
        ).as('oldMutation');
        visitMedia(type, [pending(101, 1)]);
        clickAction(/^View Request — FR$/);
        cy.get('#profile').should('have.value', '11');
        cy.contains(
          '[role="dialog"] button',
          operation === 'approval' ? /^Approve Request$/ : /^Cancel Request$/
        ).click();
        cy.wrap(null).should(() => expect(release).to.be.a('function'));
        cy.contains('[role="dialog"] button', /^Close$/).click();
        cy.get('[role="dialog"]').should('not.exist');
        clickAction(/^View Request — FR$/);
        cy.get('#profile').select('10');
        cy.intercept('GET', '/api/v1/request/101', {
          ...pending(101, 1),
          type,
        }).as('afterOldMutation');
        cy.then(() => release?.());
        cy.wait('@oldMutation');
        cy.wait('@afterOldMutation');
        cy.get('[role="dialog"]').should('be.visible');
        cy.get('#profile').should('have.value', '10');
        cy.contains('[role="dialog"] button', /^Approve Request$/).should(
          'not.be.disabled'
        );
        cy.contains(
          /Request for Correction (Movie|Series) (approved|canceled|cancelled)/
        ).should('not.exist');
      }
    );
  }

  for (const type of ['movie', 'tv'] as const) {
    it(
      `completes an active ${type} edit exactly once after a committed parent rerender`,
      { defaultCommandTimeout: 15000 },
      () => {
        cy.clock(Date.now(), ['setTimeout', 'clearTimeout']);
        const title = visitMedia(type, [pending(101, 1)]);
        let release: (() => void) | undefined;
        cy.intercept(
          'PUT',
          '/api/v1/request/101',
          (req) =>
            new Promise<void>((resolve) => {
              release = () => {
                req.reply({ editRevision: 'saved-revision' });
                resolve();
              };
            })
        ).as('delayedEdit');
        clickAction(/^View Request — FR$/);
        cy.get('#profile').select('10');
        cy.contains('[role="dialog"] button', /^Approve Request$/).click();
        cy.wrap(null).should(() => expect(release).to.be.a('function'));
        const path = `/api/v1/${type}/${type === 'movie' ? movieId : tvId}`;
        const rerendered = {
          ...title,
          overview: 'Active edit parent rerender committed',
        };
        cy.intercept('GET', path, rerendered).as('parentRerender');
        refreshEditCaches();
        cy.wait('@parentRerender');
        cy.contains(rerendered.overview).should('be.visible');
        cy.get('#profile').should('have.value', '10').and('be.disabled');
        cy.intercept('GET', path, rerendered).as('completionRefresh');
        cy.then(() => release?.());
        cy.wait('@delayedEdit');
        cy.wait('@approve');
        // One mutation cache refresh and exactly one parent's onComplete refresh.
        cy.wait(['@completionRefresh', '@completionRefresh']);
        cy.get('@completionRefresh.all').should('have.length', 2);
        cy.get('@approve.all').should('have.length', 1);
        cy.get('[role="dialog"]').should('not.exist');
        cy.get('.toast')
          .filter(
            `:contains("Request for Correction ${type === 'movie' ? 'Movie' : 'Series'} approved!")`
          )
          .should('have.length', 1);
      }
    );

    for (const outcome of ['success', 'error'] as const) {
      it(
        `isolates a reopened ${type} editor from an obsolete PUT ${outcome}`,
        { defaultCommandTimeout: 15000 },
        () => {
          let release: (() => void) | undefined;
          let releaseCurrent: (() => void) | undefined;
          const submitAgain = type === 'tv' && outcome === 'error';
          cy.intercept(
            'PUT',
            '/api/v1/request/101',
            (req) =>
              new Promise<void>((resolve) => {
                release = () => {
                  req.reply(
                    outcome === 'success'
                      ? {
                          statusCode: 200,
                          body: {
                            ...pending(101, 1),
                            editRevision: 'old-saved',
                          },
                        }
                      : { statusCode: 409, body: { message: 'Old conflict' } }
                  );
                  resolve();
                };
              })
          ).as('oldEdit');
          visitMedia(type, [pending(101, 1)]);
          clickAction(/^View Request — FR$/);
          cy.get('#profile').select('10');
          cy.contains('[role="dialog"] button', /^Approve Request$/).click();
          cy.wrap(null).should(() => expect(release).to.be.a('function'));
          cy.contains('[role="dialog"] button', /^Close$/).click();
          cy.get('[role="dialog"]').should('not.exist');
          clickAction(/^View Request — FR$/);
          cy.get('#profile').should('have.value', '11').select('10');
          cy.get('#folder').select('/1');
          if (submitAgain) {
            cy.intercept(
              'PUT',
              '/api/v1/request/101',
              (req) =>
                new Promise<void>((resolve) => {
                  releaseCurrent = () => {
                    req.reply({
                      statusCode: 500,
                      body: { message: 'Current failure' },
                    });
                    resolve();
                  };
                })
            ).as('currentEdit');
            cy.contains('[role="dialog"] button', /^Approve Request$/).click();
            cy.wrap(null).should(() =>
              expect(releaseCurrent).to.be.a('function')
            );
          }
          // The old server operation remains real and must still revalidate caches.
          cy.intercept('GET', '/api/v1/request/101', {
            ...pending(101, 1),
            type,
          }).as('afterOldMutation');
          cy.then(() => release?.());
          cy.wait('@oldEdit');
          cy.wait('@afterOldMutation');
          cy.get('[role="dialog"]').should('be.visible');
          cy.get('#profile').should('have.value', '10');
          cy.get('#folder').should('have.value', '/1');
          cy.contains('[role="dialog"] button', /^Approve Request$/).should(
            submitAgain ? 'be.disabled' : 'not.be.disabled'
          );
          cy.get('@approve.all').should(
            'have.length',
            outcome === 'success' ? 1 : 0
          );
          if (outcome === 'success')
            cy.get('@approve')
              .its('request.headers.if-match')
              .should('eq', '"old-saved"');
          cy.contains('This request changed while you were editing.').should(
            'not.exist'
          );
          cy.contains(
            /Request for Correction (Movie|Series) (edited successfully|approved)/
          ).should('not.exist');
          if (submitAgain) {
            cy.get('#profile').should('be.disabled');
            cy.then(() => releaseCurrent?.());
            cy.wait('@currentEdit');
            cy.get('#profile')
              .should('not.be.disabled')
              .and('have.value', '10');
          }
        }
      );
    }

    it(
      `disables every ${type} edit control during submission and restores them after failure`,
      { defaultCommandTimeout: 15000 },
      () => {
        let release: (() => void) | undefined;
        cy.intercept('GET', '/api/v1/user/*/quota', {
          movie: { limit: 10, remaining: 10, restricted: false },
          tv: { limit: 10, remaining: 10, restricted: false },
        });
        cy.intercept(
          'PUT',
          '/api/v1/request/101',
          (req) =>
            new Promise<void>((resolve) => {
              release = () => {
                req.reply({
                  statusCode: 500,
                  body: { message: 'Retryable failure' },
                });
                resolve();
              };
            })
        ).as('failedEdit');
        visitMedia(type, [pending(101, 1)]);
        clickAction(/^View Request — FR$/);
        cy.get('#profile').select('10');
        cy.contains('[role="dialog"] button', /^Approve Request$/).click();
        cy.wrap(null).should(() => expect(release).to.be.a('function'));
        expectLockedEditControls(type);
        cy.then(() => release?.());
        cy.wait('@failedEdit');
        cy.get('#server').should('not.be.disabled');
        cy.get('#profile').should('not.be.disabled').select('11');
        cy.get('#folder').should('not.be.disabled').select('/1');
        if (type === 'tv') {
          cy.get('#language').should('not.be.disabled').select('10');
          cy.contains('[role="dialog"] label', 'Bypass User Quota')
            .parent()
            .find('[role="checkbox"]')
            .should('have.attr', 'aria-disabled', 'false')
            .focus()
            .trigger('keydown', { key: ' ' })
            .should('have.attr', 'aria-checked', 'true')
            .trigger('keydown', { key: 'Enter' })
            .should('have.attr', 'aria-checked', 'false');
        }
        cy.get('.react-select__input-container input').type('Tag');
        cy.contains('[role="option"]', 'Tag 1').click();
        cy.contains('.react-select__multi-value', 'Tag 1').should('be.visible');
        cy.contains('[role="dialog"] button', 'Admin')
          .should('not.be.disabled')
          .click();
        cy.contains('[role="option"]', 'Beneficiary').click();
        cy.contains('[role="dialog"] button', 'Beneficiary').should(
          'be.visible'
        );
      }
    );

    it(`blocks ${type} editing when initial detail revalidation fails`, () => {
      visitMedia(type, [pending(101, 1)]);
      cy.intercept('GET', '/api/v1/request/101', {
        statusCode: 404,
        body: { message: 'Request not found.' },
      }).as('missingDetail');
      clickAction(/^View Request — FR$/);
      cy.wait('@missingDetail');
      cy.contains('[role="dialog"]', 'This request cannot be edited.').should(
        'be.visible'
      );
      cy.get('#profile').should('not.exist');
      cy.contains('[role="dialog"] button', /^Approve Request$/).should(
        'not.exist'
      );
      cy.get('@edit.all').should('have.length', 0);
      cy.get('@approve.all').should('have.length', 0);
      cy.get('@delete.all').should('have.length', 0);
    });

    it(`blocks a no-longer-pending ${type} detail`, () => {
      visitMedia(type, [pending(101, 1)]);
      cy.intercept('GET', '/api/v1/request/101', {
        ...pending(101, 1),
        type,
        status: 2,
      }).as('approvedDetail');
      clickAction(/^View Request — FR$/);
      cy.wait('@approvedDetail');
      cy.contains('[role="dialog"]', 'This request cannot be edited.').should(
        'be.visible'
      );
      cy.get('#profile').should('be.disabled');
      cy.get('#folder').should('be.disabled');
      cy.contains('[role="dialog"] button', /^Approve Request$/).should(
        'be.disabled'
      );
      cy.get('@edit.all').should('have.length', 0);
    });

    it(
      `adopts a complete pristine ${type} revision and uses the returned revision for approval`,
      { defaultCommandTimeout: 15000 },
      () => {
        cy.clock(Date.now(), ['setTimeout', 'clearTimeout']);
        const title = visitMedia(type, [pending(101, 1)]);
        clickAction(/^View Request — FR$/);
        cy.get('#profile').should('have.value', '11');
        const remote = {
          ...pending(101, 2),
          type,
          editRevision: 'remote-revision',
          profileId: 21,
          rootFolder: '/2',
          languageProfileId: 20,
          tags: [2],
          requestedBy: beneficiary,
          seasons: [1, 2].map((seasonNumber) => ({
            id: seasonNumber,
            seasonNumber,
            status: 1,
          })),
        };
        const release = delayRequestDetail(remote);
        const rerendered = {
          ...title,
          overview: 'Pristine revalidation parent rerender committed',
        };
        cy.intercept(
          'GET',
          `/api/v1/${type}/${type === 'movie' ? movieId : tvId}`,
          rerendered
        ).as('parentRerender');
        refreshEditCaches();
        cy.wait('@parentRerender');
        cy.contains(rerendered.overview).should('be.visible');
        cy.get('#profile').should('have.value', '11');
        release();
        cy.wait('@remoteDetail');
        cy.get('#server').should('have.value', '2');
        cy.get('#profile').should('have.value', '21');
        cy.get('#folder').should('have.value', '/2');
        cy.get('[role="dialog"]').should('contain.text', 'Beneficiary');
        if (type === 'tv') {
          cy.get('#language').should('have.value', '20');
          cy.contains('[role="dialog"] tbody tr', 'Season 2')
            .find('[role="checkbox"]')
            .should('have.attr', 'aria-checked', 'true');
        }
        cy.contains('[role="dialog"] button', /^Approve Request$/)
          .should('not.be.disabled')
          .click();
        cy.wait('@edit').then(({ request }) => {
          expect(request.headers['if-match']).to.eq('"remote-revision"');
          expect(request.body.serverId).to.eq(2);
          expect(request.body.profileId).to.eq(21);
          expect(request.body.rootFolder).to.eq('/2');
          expect(request.body.userId).to.eq(beneficiary.id);
          expect(request.body.tags).to.deep.eq([2]);
          if (type === 'tv') expect(request.body.seasons).to.deep.eq([1, 2]);
        });
        cy.wait('@approve')
          .its('request.headers.if-match')
          .should('eq', '"saved-revision"');
      }
    );

    it(
      `preserves dirty ${type} choices and blocks all submissions on a remote revision`,
      { defaultCommandTimeout: 15000 },
      () => {
        cy.intercept('GET', '/api/v1/user/*/quota', {
          movie: { limit: 10, remaining: 10, restricted: false },
          tv: { limit: 10, remaining: 10, restricted: false },
        });
        cy.clock(Date.now(), ['setTimeout', 'clearTimeout']);
        const title = visitMedia(type, [pending(101, 1)]);
        clickAction(/^View Request — FR$/);
        cy.get('#profile').should('have.value', '11');
        const release = delayRequestDetail({
          ...pending(101, 2),
          type,
          editRevision: 'remote-revision',
          profileId: 21,
        });
        const rerendered = {
          ...title,
          overview: 'Dirty revalidation parent rerender committed',
        };
        cy.intercept(
          'GET',
          `/api/v1/${type}/${type === 'movie' ? movieId : tvId}`,
          rerendered
        ).as('parentRerender');
        refreshEditCaches();
        cy.wait('@parentRerender');
        cy.contains(rerendered.overview).should('be.visible');
        // This change commits after revalidation starts, before it resolves.
        cy.get('#profile').select('10').should('have.value', '10');
        release();
        cy.wait('@remoteDetail');
        cy.contains('[role="dialog"]', 'Close and reopen the editor').should(
          'be.visible'
        );
        expectLockedEditControls(type);
        cy.get('#profile').should('have.value', '10');
        cy.get('#server').should('have.value', '1');
        cy.contains('[role="dialog"] button', /^Approve Request$/).should(
          'be.disabled'
        );
        if (type === 'movie')
          cy.contains('[role="dialog"] button', /^Cancel Request$/).should(
            'be.disabled'
          );
        cy.get('@edit.all').should('have.length', 0);
        cy.get('@approve.all').should('have.length', 0);
        cy.get('@delete.all').should('have.length', 0);
      }
    );

    it(`keeps manual ${type} values on a same-revision request and metadata refresh`, () => {
      cy.clock(Date.now(), ['setTimeout', 'clearTimeout']);
      visitMedia(type, [pending(101, 1)]);
      clickAction(/^View Request — FR$/);
      cy.get('#profile').select('10');
      const metadata = details(1);
      metadata.profiles[0].name = 'Refreshed Default';
      cy.intercept(
        'GET',
        `/api/v1/service/${type === 'movie' ? 'radarr' : 'sonarr'}/1`,
        metadata
      ).as('refreshedMetadata');
      cy.get('@rules.all').then((calls) => {
        const count = (calls as unknown as unknown[]).length;
        refreshEditCaches();
        cy.wait('@refreshedMetadata');
        cy.get('#profile').should('have.value', '10');
        cy.get('@rules.all').should('have.length', count);
      });
      cy.contains('[role="dialog"]', 'Close and reopen the editor').should(
        'not.exist'
      );
      cy.contains('[role="dialog"] button', /^Approve Request$/).should(
        'not.be.disabled'
      );
    });

    it(`treats a local ${type} owner selection as dirty independently of configuration`, () => {
      cy.clock(Date.now(), ['setTimeout', 'clearTimeout']);
      visitMedia(type, [pending(101, 1)]);
      clickAction(/^View Request — FR$/);
      cy.get('#profile').should('have.value', '11');
      cy.contains('[role="dialog"] button', 'Admin').click();
      cy.contains('[role="option"]', 'Beneficiary').click();
      cy.intercept('GET', '/api/v1/request/101', {
        ...pending(101, 2),
        type,
        editRevision: 'remote-owner',
      }).as('remoteDetail');
      refreshEditCaches();
      cy.wait('@remoteDetail');
      cy.contains('[role="dialog"]', 'Close and reopen the editor').should(
        'be.visible'
      );
      cy.contains('[role="dialog"] button', 'Beneficiary').should('be.visible');
      cy.get('#server').should('have.value', '1');
      cy.contains('[role="dialog"] button', /^Approve Request$/).should(
        'be.disabled'
      );
      cy.get('@edit.all').should('have.length', 0);
      cy.get('@approve.all').should('have.length', 0);
    });

    it(`keeps a stale ${type} PUT open, never approves, and reloads on a new session`, () => {
      visitMedia(type, [pending(101, 1)]);
      clickAction(/^View Request — FR$/);
      cy.get('#profile').select('10');
      const remote = {
        ...pending(101, 1),
        type,
        editRevision: 'remote-revision',
        profileId: 11,
        seasons: [1, 2].map((seasonNumber) => ({
          id: seasonNumber,
          seasonNumber,
          status: 1,
        })),
      };
      cy.intercept('GET', '/api/v1/request/101', remote).as('remoteDetail');
      cy.intercept('PUT', '/api/v1/request/101', {
        statusCode: 409,
        body: { message: 'Concurrent edit' },
      }).as('staleEdit');
      cy.contains('[role="dialog"] button', /^Approve Request$/).click();
      cy.wait('@staleEdit')
        .its('request.headers.if-match')
        .should('eq', '"revision-101"');
      cy.wait('@remoteDetail');
      cy.get('#profile').should('have.value', '10');
      cy.contains('[role="dialog"]', 'Close and reopen the editor').should(
        'be.visible'
      );
      cy.contains('[role="dialog"] button', /^Approve Request$/).should(
        'be.disabled'
      );
      cy.get('@approve.all').should('have.length', 0);
      cy.contains('[role="dialog"] button', /^Close$/).click();
      cy.get('[role="dialog"]').should('not.exist');
      clickAction(/^View Request — FR$/);
      cy.get('#profile').should('have.value', '11');
      if (type === 'tv')
        cy.contains('[role="dialog"] tbody tr', 'Season 2')
          .find('[role="checkbox"]')
          .should('have.attr', 'aria-checked', 'true');
      cy.contains('[role="dialog"]', 'Close and reopen the editor').should(
        'not.exist'
      );
    });

    it(`reports a saved ${type} edit whose conditional approval conflicts`, () => {
      visitMedia(type, [pending(101, 1)]);
      clickAction(/^View Request — FR$/);
      cy.get('#profile').select('10');
      cy.intercept('POST', '/api/v1/request/101/approve', {
        statusCode: 409,
        body: { message: 'Concurrent edit' },
      }).as('staleApproval');
      cy.contains('[role="dialog"] button', /^Approve Request$/).click();
      cy.wait('@edit');
      cy.wait('@staleApproval')
        .its('request.headers.if-match')
        .should('eq', '"saved-revision"');
      cy.contains(
        'The request was edited successfully, but approval failed.'
      ).should('be.visible');
      cy.contains('[role="dialog"]', 'Close and reopen the editor').should(
        'be.visible'
      );
      cy.contains('[role="dialog"] button', /^Approve Request$/).should(
        'be.disabled'
      );
      cy.get('[role="dialog"]').should('be.visible');
    });

    it(`hides all new ${type} request actions when globally blocklisted`, () => {
      visitMedia(type, [], true, true);
      cy.get('[data-testid="request-button"]').should('not.exist');
    });

    it(`retains historical ${type} overrides and omits an unchanged null destination`, () => {
      visitMedia(type, [pending(101, null)]);
      clickAction(/^View Request — Request #101$/);
      cy.get('[role="dialog"] #profile').should('have.value', '11');
      cy.get('[role="dialog"] #folder').should('have.value', '/custom');
      cy.contains('[role="dialog"] button', /^Approve Request$/).click();
      cy.wait('@edit').then(({ request }) => {
        expect(request.body).not.to.have.property('serverId');
        expect(request.body.profileId).to.eq(11);
        expect(request.body.rootFolder).to.eq('/custom');
        expect(request.body.tags).to.deep.eq([]);
        if (type === 'tv') expect(request.body.languageProfileId).to.eq(31);
      });
    });

    it(`allows a historical ${type} request to explicitly choose a native destination`, () => {
      visitMedia(type, [pending(101, null)]);
      clickAction(/^View Request — Request #101$/);
      cy.get('[role="dialog"] #server').should('not.be.disabled').select('2');
      cy.get('[role="dialog"] #profile').should('have.value', '20');
      cy.contains('[role="dialog"] button', /^Approve Request$/)
        .should('not.be.disabled')
        .click();
      cy.wait('@edit').then(({ request }) => {
        expect(request.body.serverId).to.eq(2);
        expect(request.body.profileId).to.eq(20);
        expect(request.body.rootFolder).to.eq('/2');
        expect(request.body.tags).to.deep.eq([2]);
        if (type === 'tv') expect(request.body.languageProfileId).to.eq(20);
      });
    });

    for (const manual of [false, true]) {
      it(`saves ${manual ? 'manual' : 'resolved'} ${type} configuration after switching native destinations`, () => {
        cy.intercept('POST', '/api/v1/overrideRule/advancedRequest', (req) => {
          req.reply({
            body:
              req.body.serviceId === 2
                ? { profileId: 21, rootFolder: '/2', tags: [2] }
                : {},
          });
        }).as('switchRules');
        visitMedia(type, [pending(101, 1)]);
        clickAction(/^View Request — FR$/);
        cy.get('#profile').should('not.be.disabled').and('have.value', '11');
        cy.get('#server').select('2');
        cy.get('#profile').should('not.be.disabled').and('have.value', '21');
        cy.get('#folder').should('have.value', '/2');
        cy.contains('.react-select__multi-value', 'Tag 2').should('be.visible');
        if (type === 'tv') cy.get('#language').should('have.value', '20');
        if (manual) {
          cy.get('@switchRules.all').then((calls) => {
            const count = (calls as unknown as unknown[]).length;
            cy.get('#profile').select('20');
            cy.get('#folder').select('/custom');
            if (type === 'tv') cy.get('#language').select('31');
            cy.get('@switchRules.all').should('have.length', count);
          });
          cy.get('[role="dialog"] .react-select__multi-value__remove').click();
          cy.get('#profile').should('not.be.disabled').and('have.value', '20');
          cy.get('#folder').should('have.value', '/custom');
          cy.get('[role="dialog"] .react-select__multi-value').should(
            'not.exist'
          );
        }
        cy.contains('[role="dialog"] button', /^Approve Request$/)
          .should('not.be.disabled')
          .click();
        cy.wait('@edit').then(({ request }) => {
          expect(request.body.serverId).to.eq(2);
          expect(request.body.profileId).to.eq(manual ? 20 : 21);
          expect(request.body.rootFolder).to.eq(manual ? '/custom' : '/2');
          expect(request.body.tags).to.deep.eq(manual ? [] : [2]);
          if (type === 'tv')
            expect(request.body.languageProfileId).to.eq(manual ? 31 : 20);
        });
        cy.wait('@approve');
      });
    }

    for (const historical of [false, true]) {
      it(`restores ${historical ? 'historical nullable' : 'explicit'} ${type} settings after returning to the original effective destination`, () => {
        const original = historical
          ? {
              ...pending(101, null),
              profileId: null,
              rootFolder: null,
              languageProfileId: null,
              tags: null,
            }
          : pending(101, 1);
        visitMedia(type, [original]);
        clickAction(
          historical ? /^View Request — Request #101$/ : /^View Request — FR$/
        );
        cy.get('#profile').should('not.be.disabled');
        cy.get('#server').select('2');
        cy.get('#profile')
          .should('not.be.disabled')
          .and('have.value', '20')
          .select('21');
        cy.get('#folder').select('/custom');
        cy.get('#server').select('1');
        cy.get('#profile')
          .should('not.be.disabled')
          .and('have.value', historical ? '10' : '11');
        cy.get('#folder').should('have.value', historical ? '/1' : '/custom');
        if (type === 'tv')
          cy.get('#language').should('have.value', historical ? '10' : '31');
        cy.contains('[role="dialog"] button', /^Approve Request$/)
          .should('not.be.disabled')
          .click();
        cy.wait('@edit').then(({ request }) => {
          if (historical) expect(request.body).not.to.have.property('serverId');
          else expect(request.body.serverId).to.eq(1);
          expect(request.body.profileId).to.eq(original.profileId);
          expect(request.body.rootFolder).to.eq(original.rootFolder);
          expect(request.body.tags).to.deep.eq(original.tags);
          if (type === 'tv')
            expect(request.body.languageProfileId).to.eq(
              original.languageProfileId
            );
        });
        cy.wait('@approve');
      });
    }

    it(`preserves nullable historical ${type} fields when only the folder is edited`, () => {
      cy.intercept('POST', '/api/v1/overrideRule/advancedRequest', {
        profileId: 10,
        rootFolder: '/1',
        tags: [1],
      });
      visitMedia(type, [
        {
          ...pending(101, null),
          profileId: null,
          rootFolder: null,
          languageProfileId: null,
          tags: null,
        },
      ]);
      clickAction(/^View Request — Request #101$/);
      cy.get('#profile').should('not.be.disabled').and('have.value', '10');
      cy.get('#folder').should('have.value', '/1').select('/custom');
      cy.contains('[role="dialog"] button', /^Approve Request$/)
        .should('not.be.disabled')
        .click();
      cy.wait('@edit').then(({ request }) => {
        expect(request.body).not.to.have.property('serverId');
        expect(request.body.profileId).to.eq(null);
        expect(request.body.rootFolder).to.eq('/custom');
        expect(request.body.tags).to.eq(null);
        if (type === 'tv') expect(request.body.languageProfileId).to.eq(null);
      });
      cy.wait('@approve');
    });

    it(`persists an explicit ${type} profile matching the displayed default without saving unrelated defaults`, () => {
      visitMedia(type, [
        { ...pending(101, 1), profileId: null, rootFolder: null },
      ]);
      clickAction(/^View Request — FR$/);
      cy.get('#profile').should('not.be.disabled').and('have.value', '10');
      // Move away and back: selecting an already-selected native option emits
      // no React change event. The final explicit override still matches default.
      cy.get('#profile').select('11').should('have.value', '11');
      cy.get('#profile').select('10').should('have.value', '10');
      cy.contains('[role="dialog"] button', /^Approve Request$/)
        .should('not.be.disabled')
        .click();
      cy.wait('@edit').then(({ request }) => {
        expect(request.body.profileId).to.eq(10);
        expect(request.body.rootFolder).to.eq(null);
        expect(request.body.tags).to.deep.eq([]);
        if (type === 'tv') expect(request.body.languageProfileId).to.eq(31);
      });
      cy.wait('@approve');
    });

    it(`preserves explicit ${type} settings during an independent profile edit`, () => {
      cy.intercept('GET', '/api/v1/auth/me', {
        ...admin,
        permissions: 32 | 8192 | 16384, // REQUEST, REQUEST_ADVANCED, REQUEST_VIEW
      });
      visitMedia(type, [pending(101, 1)], false, true);
      clickAction(/^View Request — FR$/);
      cy.get('#server').should('be.disabled');
      cy.get('#profile').should('not.be.disabled').select('10');
      cy.contains('[role="dialog"] button', /^Edit Request$/).click();
      cy.wait('@edit').then(({ request }) => {
        expect(request.body.serverId).to.eq(1);
        expect(request.body.profileId).to.eq(10);
        expect(request.body.rootFolder).to.eq('/custom');
        expect(request.body.tags).to.deep.eq([]);
        if (type === 'tv') expect(request.body.languageProfileId).to.eq(31);
      });
      cy.get('[role="dialog"]').should('not.exist');
      cy.get('@approve.all').should('have.length', 0);
    });

    it(`preserves an explicit native ${type} destination`, () => {
      visitMedia(type, [pending(101, 1)]);
      clickAction(/^View Request — FR$/);
      cy.get('[role="dialog"] #server').should('not.be.disabled');
      cy.get('[role="dialog"] #profile').should('have.value', '11');
      cy.contains('[role="dialog"] button', /^Approve Request$/).click();
      cy.wait('@edit').its('request.body.serverId').should('eq', 1);
    });

    it(`allows an unchanged ${type} edit when Arr configuration is unavailable`, () => {
      cy.intercept('GET', '/api/v1/service/*/1', { statusCode: 500 });
      visitMedia(type, [pending(101, 1)]);
      clickAction(/^View Request — FR$/);
      cy.contains('[role="dialog"] button', /^Approve Request$/)
        .should('not.be.disabled')
        .click();
      cy.wait('@edit').then(({ request }) => {
        expect(request.body.profileId).to.eq(11);
        expect(request.body.rootFolder).to.eq('/custom');
        expect(request.body.tags).to.deep.eq([]);
        if (type === 'tv') expect(request.body.languageProfileId).to.eq(31);
      });
    });

    it(`locks a confirmed independent ${type} destination`, () => {
      visitMedia(type, [pending(101, 1)], false, true);
      clickAction(/^View Request — FR$/);
      cy.get('[role="dialog"] #server')
        .should('be.disabled')
        .and('have.value', '1');
      cy.contains('[role="dialog"] button', /^Approve Request$/).click();
      cy.wait('@edit').its('request.body.serverId').should('eq', 1);
    });

    it(`does not retarget unresolved ${type} requests or require Arr for an unchanged edit`, () => {
      // A successful inventory excluding #99 now confirms an invalid target.
      // This regression covers unavailable metadata without such confirmation.
      const kind = type === 'movie' ? 'radarr' : 'sonarr';
      cy.intercept('GET', `/api/v1/service/${kind}`, { statusCode: 500 }).as(
        'unavailableInventory'
      );
      cy.intercept('GET', `/api/v1/service/${kind}/99`, { statusCode: 500 });
      visitMedia(type, [pending(101, 99)]);
      clickAction(/^View Request — Request #101$/);
      cy.wait('@unavailableInventory');
      cy.contains('[role="dialog"] button', /^Approve Request$/)
        .should('not.be.disabled')
        .click();
      cy.wait('@edit').then(({ request }) => {
        expect(request.body).not.to.have.property('serverId');
        expect(request.body.profileId).to.eq(11);
      });
    });

    it(`recovers ${type} creation readiness by explicitly retrying failed Override Rules`, () => {
      cy.intercept('POST', '/api/v1/overrideRule/advancedRequest', {
        statusCode: 500,
        body: { message: 'Rules unavailable' },
      }).as('failedRules');
      if (type === 'movie') {
        // Errors must remain recoverable even when no advanced choices would
        // ordinarily be displayed (one server, profile, folder and user).
        cy.intercept('GET', '/api/v1/user?*', { results: [admin] });
        cy.intercept('GET', '/api/v1/service/radarr', [servers[0]]);
        cy.intercept('GET', '/api/v1/service/radarr/1', {
          ...details(1),
          server: { ...servers[0], activeTags: [] },
          profiles: [{ id: 10, name: 'Default' }],
          rootFolders: [{ id: 1, path: '/1' }],
          languageProfiles: [],
          tags: [],
        });
      }
      visitMedia(type);
      clickAction(/^Request$/);
      if (type === 'tv') {
        cy.contains('[role="dialog"] tbody tr', 'Season 1')
          .find('[role="checkbox"]')
          .click();
      }
      cy.wait('@failedRules');
      cy.contains(
        '[role="dialog"] [role="alert"]',
        'Unable to load Override Rules'
      ).should('be.visible');
      const submit = type === 'movie' ? /^Request$/ : /^Request 1 Season$/;
      cy.contains('[role="dialog"] button', submit).should('be.disabled');
      cy.get('@create.all').should('have.length', 0);

      cy.intercept('POST', '/api/v1/overrideRule/advancedRequest', {}).as(
        'retriedRules'
      );
      cy.contains('[role="dialog"] button', /^Retry$/).click();
      cy.wait('@retriedRules').then(({ request }) => {
        expect(request.body.serviceId).to.eq(1);
        expect(request.body.requestUser).to.eq(1);
      });
      cy.get('@retriedRules.all').should('have.length', 1);
      cy.get('[role="dialog"] [role="alert"]').should('not.exist');
      cy.contains('[role="dialog"] button', submit).should('not.be.disabled');
    });

    it(`allows an unchanged ${type} edit when Override Rules fail`, () => {
      cy.intercept('POST', '/api/v1/overrideRule/advancedRequest', {
        statusCode: 500,
        body: { message: 'Rules unavailable' },
      }).as('failedRules');
      visitMedia(type, [pending(101, 1)]);
      clickAction(/^View Request — FR$/);
      cy.wait('@failedRules');
      cy.contains('[role="dialog"] button', /^Retry$/).should('be.visible');
      cy.contains('[role="dialog"] button', /^Approve Request$/)
        .should('not.be.disabled')
        .click();
      cy.wait('@edit').then(({ request }) => {
        expect(request.body.profileId).to.eq(11);
        expect(request.body.rootFolder).to.eq('/custom');
        expect(request.body.tags).to.deep.eq([]);
        if (type === 'tv') expect(request.body.languageProfileId).to.eq(31);
      });
    });

    it(`submits manual ${type} settings without reevaluating rules or losing readiness`, () => {
      const response = createdRequest(type, 1, type === 'tv' ? [1] : []);
      cy.intercept('POST', '/api/v1/request', {
        statusCode: 201,
        body: {
          ...response,
          profileId: 11,
          rootFolder: '/custom',
          languageProfileId: type === 'tv' ? 31 : undefined,
          target: { ...response.target, isIndependent: false },
          media: { ...response.media, status: 3 },
        },
      }).as('manualCreate');
      visitMedia(type);
      clickAction(/^Request$/);
      if (type === 'tv') {
        cy.contains('[role="dialog"] tbody tr', 'Season 1')
          .find('[role="checkbox"]')
          .click();
      }
      const submit = type === 'movie' ? /^Request$/ : /^Request 1 Season$/;
      cy.contains('[role="dialog"] button', submit).should('not.be.disabled');
      cy.get('@rules.all').then((calls) => {
        const count = (calls as unknown as unknown[]).length;
        // Any unnecessary evaluation would now fail and leave the form blocked.
        cy.intercept('POST', '/api/v1/overrideRule/advancedRequest', {
          statusCode: 500,
          body: { message: 'Unexpected local-field evaluation' },
        }).as('unexpectedRules');
        cy.get('#profile').select('11').should('not.be.disabled');
        cy.contains('[role="dialog"] button', submit).should('not.be.disabled');
        cy.get('#folder').select('/custom').should('not.be.disabled');
        cy.contains('[role="dialog"] button', submit).should('not.be.disabled');
        if (type === 'tv') {
          cy.get('#language').select('31').should('not.be.disabled');
          cy.contains('[role="dialog"] button', submit).should(
            'not.be.disabled'
          );
          cy.get('#language').select('31');
        }
        cy.get('#profile').select('11');
        cy.get('#folder').select('/custom');
        cy.get('@unexpectedRules.all').should('have.length', 0);
        cy.get('@rules.all').should('have.length', count);
        cy.get('[role="dialog"] [role="alert"]').should('not.exist');
        cy.contains('[role="dialog"] button', submit)
          .should('not.be.disabled')
          .click();
      });
      cy.wait('@manualCreate').then(({ request }) => {
        expect(request.body).to.include({
          mediaType: type,
          mediaId: type === 'movie' ? movieId : tvId,
          serverId: 1,
          profileId: 11,
          rootFolder: '/custom',
          userId: 1,
        });
        if (type === 'tv') {
          expect(request.body.languageProfileId).to.eq(31);
          expect(request.body.seasons).to.deep.eq([1]);
        }
      });
      cy.get('[role="dialog"]').should('not.exist');
      cy.contains(
        `${type === 'movie' ? 'Correction Movie' : 'Correction Series'} requested successfully!`
      ).should('be.visible');
    });
  }

  it('preserves dirty TV seasons without merging a newer remote selection', () => {
    cy.clock(Date.now(), ['setTimeout', 'clearTimeout']);
    visitMedia('tv', [pending(101, 1)], false, true, undefined, [1, 2, 3]);
    clickAction(/^View Request — FR$/);
    cy.contains('[role="dialog"] tbody tr', 'Season 1')
      .find('[role="checkbox"]')
      .should('have.attr', 'aria-checked', 'true');
    cy.contains('[role="dialog"] tbody tr', 'Season 3')
      .find('[role="checkbox"]')
      .click();
    cy.intercept('GET', '/api/v1/request/101', {
      ...pending(101, 1),
      type: 'tv',
      editRevision: 'remote-seasons',
      seasons: [1, 2].map((seasonNumber) => ({
        id: seasonNumber,
        seasonNumber,
        status: 1,
      })),
    }).as('remoteDetail');
    refreshEditCaches();
    cy.wait('@remoteDetail');
    cy.contains('[role="dialog"]', 'Close and reopen the editor').should(
      'be.visible'
    );
    for (const seasonNumber of [1, 3])
      cy.contains('[role="dialog"] tbody tr', `Season ${seasonNumber}`)
        .find('[role="checkbox"]')
        .should('have.attr', 'aria-checked', 'true');
    cy.contains('[role="dialog"] tbody tr', 'Season 2')
      .find('[role="checkbox"]')
      .should('have.attr', 'aria-checked', 'false');
    cy.contains('[role="dialog"] button', /^Approve Request$/).should(
      'be.disabled'
    );
    cy.get('@edit.all').should('have.length', 0);
    cy.get('@approve.all').should('have.length', 0);
  });

  for (const selectAll of [true, false]) {
    it(`blocks TV ${selectAll ? 'select-all' : 'deselect-all'} submission on a newer remote revision`, () => {
      cy.clock(Date.now(), ['setTimeout', 'clearTimeout']);
      visitMedia('tv', [pending(101, 1)], false, true);
      clickAction(/^View Request — FR$/);
      cy.contains('[role="dialog"] tbody tr', 'Season 1')
        .find('[role="checkbox"]')
        .should('have.attr', 'aria-checked', 'true');
      cy.get('[role="dialog"] thead [role="checkbox"]').click();
      if (!selectAll) cy.get('[role="dialog"] thead [role="checkbox"]').click();
      cy.intercept('GET', '/api/v1/request/101', {
        ...pending(101, 1),
        type: 'tv',
        editRevision: 'remote-all-seasons',
        seasons: [1, 2].map((seasonNumber) => ({
          id: seasonNumber,
          seasonNumber,
          status: 1,
        })),
      }).as('remoteDetail');
      refreshEditCaches();
      cy.wait('@remoteDetail');
      cy.contains('[role="dialog"]', 'Close and reopen the editor').should(
        'be.visible'
      );
      cy.get('[role="dialog"] tbody [role="checkbox"]').should(
        'have.attr',
        'aria-checked',
        selectAll ? 'true' : 'false'
      );
      cy.contains(
        '[role="dialog"] button',
        selectAll ? /^Approve Request$/ : /^Cancel Request$/
      ).should('be.disabled');
      cy.get('@edit.all').should('have.length', 0);
      cy.get('@delete.all').should('have.length', 0);
      cy.get('@approve.all').should('have.length', 0);
    });
  }

  for (const type of ['movie', 'tv'] as const) {
    it(`conditionally cancels ${type} without AdvancedRequester and preserves the modal on 409`, () => {
      cy.intercept('GET', '/api/v1/auth/me', {
        ...admin,
        permissions: 32 | 16384,
      });
      visitMedia(type, [pending(101, 1)]);
      clickAction(/^View Request — FR$/);
      cy.get('#profile').should('not.exist');
      if (type === 'tv')
        cy.contains('[role="dialog"] tbody tr', 'Season 1')
          .find('[role="checkbox"]')
          .click();
      cy.intercept('DELETE', '/api/v1/request/101', {
        statusCode: 409,
        body: { message: 'Concurrent edit' },
      }).as('staleDelete');
      cy.contains('[role="dialog"] button', /^Cancel Request$/).click();
      cy.wait('@staleDelete')
        .its('request.headers.if-match')
        .should('eq', '"revision-101"');
      cy.contains('[role="dialog"]', 'Close and reopen the editor').should(
        'be.visible'
      );
      cy.contains('[role="dialog"] button', /^Cancel Request$/).should(
        'be.disabled'
      );
      cy.get('@edit.all').should('have.length', 0);
      cy.get('@approve.all').should('have.length', 0);
    });
  }

  for (const alsoApprove of [false, true]) {
    it(`keeps a refused TV ${alsoApprove ? 'Edit and Approve' : 'edit'} open without approval and retries successfully`, () => {
      if (!alsoApprove) {
        cy.intercept('GET', '/api/v1/auth/me', {
          ...admin,
          permissions: 32 | 8192 | 16384, // REQUEST, REQUEST_ADVANCED, REQUEST_VIEW
        });
      }
      visitMedia('tv', [pending(101, 1)], false, alsoApprove);
      clickAction(/^View Request — FR$/);
      cy.get('#profile').should('not.be.disabled');
      cy.contains('[role="dialog"] tbody tr', 'Season 1')
        .find('[role="checkbox"]')
        .click();
      cy.contains('[role="dialog"] tbody tr', 'Season 2')
        .find('[role="checkbox"]')
        .click();
      cy.intercept(
        'GET',
        `/api/v1/tv/${tvId}/request-targets`,
        servers.map((server) => ({
          serverId: server.id,
          name: server.name,
          is4k: false,
          isDefault: server.isDefault,
          isIndependent: alsoApprove,
          status: 2,
          requestable: true,
          seasons: [1, 2].map((seasonNumber) => ({
            seasonNumber,
            status: seasonNumber === 1 ? 2 : 5,
            requestable: false,
          })),
        }))
      ).as('editRefreshedTargets');
      cy.intercept('PUT', '/api/v1/request/101', {
        statusCode: 202,
        body: { message: 'No seasons available to request' },
      }).as('refusedEdit');
      const submit = alsoApprove ? /^Approve Request$/ : /^Edit Request$/;
      cy.get('@title.all').then((calls) => {
        const count = (calls as unknown as unknown[]).length;
        cy.contains('[role="dialog"] button', submit)
          .should('not.be.disabled')
          .click();
        cy.wait('@refusedEdit')
          .its('request.body.seasons')
          .should('deep.eq', [2]);
        cy.wait('@editRefreshedTargets');
        cy.get('@title.all').should((requests) => {
          expect((requests as unknown as unknown[]).length).to.be.greaterThan(
            count
          );
        });
      });
      cy.contains('No seasons available to request').should('be.visible');
      cy.contains('Request for Correction Series edited successfully!').should(
        'not.exist'
      );
      cy.contains('Request for Correction Series approved!').should(
        'not.exist'
      );
      cy.get('[role="dialog"]').should('be.visible');
      cy.get('@approve.all').should('have.length', 0);
      cy.get('@delete.all').should('have.length', 0);
      cy.contains('[role="dialog"] tbody tr', 'Season 1')
        .find('[role="checkbox"]')
        .should('have.attr', 'aria-checked', 'true');
      cy.contains('[role="dialog"] tbody tr', 'Season 2').should(
        'contain.text',
        'Available'
      );
      const updatedRequest = createdRequest('tv', 1, [1]);
      cy.intercept('PUT', '/api/v1/request/101', {
        statusCode: 200,
        body: {
          ...updatedRequest,
          ...pending(101, 1),
          target: {
            ...updatedRequest.target,
            isIndependent: alsoApprove,
            status: 2,
          },
        },
      }).as('successfulEdit');
      cy.contains('[role="dialog"] button', submit)
        .should('not.be.disabled')
        .click();
      cy.wait('@successfulEdit')
        .its('request.body.seasons')
        .should('deep.eq', [1]);
      if (alsoApprove) {
        cy.wait('@approve');
        cy.get('@approve.all').should('have.length', 1);
      } else cy.get('@approve.all').should('have.length', 0);
      cy.contains(
        alsoApprove
          ? 'Request for Correction Series approved!'
          : 'Request for Correction Series edited successfully!'
      ).should('be.visible');
      cy.get('[role="dialog"]').should('not.exist');
    });
  }

  for (const independent of [false, true]) {
    it(`keeps the ${independent ? 'independent' : 'native'} TV modal open after 202, refreshes availability and retries valid seasons`, () => {
      visitMedia('tv', [], false, independent);
      clickAction(/^Request$/);
      cy.contains('[role="dialog"] tbody tr', 'Season 1')
        .find('[role="checkbox"]')
        .click();
      cy.contains('[role="dialog"] button', /^Request 1 Season$/).should(
        'not.be.disabled'
      );
      // The backend wins a race for Season 1, but Season 2 remains requestable.
      cy.intercept(
        'GET',
        `/api/v1/tv/${tvId}/request-targets`,
        servers.map((server) => ({
          serverId: server.id,
          name: server.name,
          is4k: false,
          isDefault: server.isDefault,
          isIndependent: independent,
          status: server.id === 1 ? 4 : 1,
          requestable: true,
          seasons: [1, 2].map((seasonNumber) => ({
            seasonNumber,
            status: server.id === 1 && seasonNumber === 1 ? 5 : 1,
            requestable: server.id !== 1 || seasonNumber !== 1,
          })),
        }))
      ).as('refreshedTargets');
      cy.intercept('POST', '/api/v1/request', {
        statusCode: 202,
        body: { message: 'No seasons available to request' },
      }).as('notCreated');
      cy.get('@title.all').then((calls) => {
        const count = (calls as unknown as unknown[]).length;
        cy.contains('[role="dialog"] button', /^Request 1 Season$/).click();
        cy.wait('@notCreated').then(({ request }) => {
          expect(request.body.serverId).to.eq(1);
          expect(request.body.seasons).to.deep.eq([1]);
        });
        cy.wait('@refreshedTargets');
        cy.get('@title.all').should((requests) => {
          expect((requests as unknown as unknown[]).length).to.be.greaterThan(
            count
          );
        });
      });
      cy.contains('No seasons available to request').should('be.visible');
      cy.contains('Correction Series requested successfully!').should(
        'not.exist'
      );
      // RequestButton's successful completion callback closes the modal.
      cy.get('[role="dialog"]').should('be.visible');
      cy.contains('[role="dialog"] tbody tr', 'Season 1').should(
        'contain.text',
        'Available'
      );
      cy.contains('[role="dialog"] button', /^Select Season\(s\)$/).should(
        'be.disabled'
      );
      cy.contains('[role="dialog"] tbody tr', 'Season 2')
        .find('[role="checkbox"]')
        .click();
      const response = createdRequest('tv', 1, [2]);
      cy.intercept('POST', '/api/v1/request', {
        statusCode: 201,
        body: {
          ...response,
          target: { ...response.target, isIndependent: independent },
          media: { ...response.media, status: independent ? 1 : 3 },
        },
      }).as('retriedCreate');
      cy.contains('[role="dialog"] button', /^Request 1 Season$/)
        .should('not.be.disabled')
        .click();
      cy.wait('@retriedCreate').then(({ request }) => {
        expect(request.body.serverId).to.eq(1);
        expect(request.body.seasons).to.deep.eq([2]);
      });
      cy.contains('Correction Series requested successfully!').should(
        'be.visible'
      );
      cy.get('[role="dialog"]').should('not.exist');
    });
  }

  it('reevaluates changed effective tags and keeps submission blocked until they resolve', () => {
    cy.intercept('GET', '/api/v1/service/radarr/1', {
      ...details(1),
      tags: [
        { id: 1, label: 'Tag 1' },
        { id: 99, label: 'Extra' },
      ],
    });
    visitMedia('movie');
    clickAction(/^Request$/);
    cy.contains('[role="dialog"] button', /^Request$/).should(
      'not.be.disabled'
    );
    let releaseRules: (() => void) | undefined;
    cy.intercept('POST', '/api/v1/overrideRule/advancedRequest', (req) => {
      return new Promise<void>((resolve) => {
        releaseRules = () => {
          req.reply({
            body: { profileId: 11, rootFolder: '/custom', tags: [1, 99] },
          });
          resolve();
        };
      });
    }).as('tagRules');
    cy.get('[role="dialog"] .react-select__input-container input').type(
      'Extra'
    );
    cy.contains('[role="option"]', /^Extra$/).click();
    cy.wrap(null).should(() => {
      expect(releaseRules).to.be.a('function');
    });
    cy.contains('[role="dialog"] button', /^Request$/).should('be.disabled');
    cy.then(() => {
      releaseRules?.();
    });
    cy.wait('@tagRules').then(({ request }) => {
      expect(request.body.serviceId).to.eq(1);
      expect(request.body.requestUser).to.eq(1);
      expect(request.body.tags).to.deep.eq([1, 99]);
    });
    cy.get('#profile').should('not.be.disabled').and('have.value', '11');
    cy.get('#folder').should('have.value', '/custom');
    cy.contains('[role="dialog"] button', /^Request$/).should(
      'not.be.disabled'
    );
    cy.get('#profile').select('11');
    cy.get('@tagRules.all').should('have.length', 1);
  });

  it('creates a movie on an eligible independent destination when the default is unavailable', () => {
    const independentServers = servers.map((server) => ({
      ...server,
      independentRequestDestination: true,
    }));
    cy.intercept('GET', '/api/v1/service/radarr', independentServers);
    for (const id of [1, 2]) {
      cy.intercept('GET', `/api/v1/service/radarr/${id}`, {
        ...details(id),
        server: independentServers[id - 1],
      });
    }
    const targets: MovieRequestTarget[] = independentServers.map((server) => ({
      serverId: server.id,
      name: server.name,
      is4k: false,
      isDefault: server.isDefault,
      isIndependent: true,
      status: server.id === 1 ? 5 : 1,
      requestable: server.id === 2,
    }));
    cy.intercept('POST', '/api/v1/request', {
      statusCode: 201,
      body: createdRequest('movie', 2),
    }).as('successfulCreate');
    visitMedia('movie', [], false, true, targets);
    clickAction(/^Request$/);
    cy.get('[role="dialog"] #server').should('have.value', '1');
    cy.get('[role="dialog"] #profile').should('not.be.disabled');
    cy.contains('[role="dialog"] button', /^Request$/).should('be.disabled');
    cy.get('[role="dialog"] #server').select('2');
    cy.get('[role="dialog"] #profile').should('have.value', '20');
    cy.get('[role="dialog"] #folder').should('have.value', '/2');
    cy.contains('[role="dialog"] button', /^Request$/)
      .should('not.be.disabled')
      .click();
    cy.wait('@successfulCreate').then(({ request, response }) => {
      expect(response?.statusCode).to.eq(201);
      expect(request.body).to.include({
        mediaType: 'movie',
        mediaId: movieId,
        is4k: false,
        serverId: 2,
        userId: 1,
      });
      expectCreationOverrides(request.body);
    });
    cy.get('[role="dialog"]').should('not.exist');
    cy.contains('Correction Movie requested successfully!').should(
      'be.visible'
    );
  });

  it('creates TV seasons for the selected independent destination and clears selections when switching', () => {
    const independentServers = servers.map((server) => ({
      ...server,
      independentRequestDestination: true,
    }));
    cy.intercept('GET', '/api/v1/service/sonarr', independentServers);
    for (const id of [1, 2]) {
      cy.intercept('GET', `/api/v1/service/sonarr/${id}`, {
        ...details(id),
        server: independentServers[id - 1],
      });
    }
    const targets: TvRequestTarget[] = independentServers.map((server) => ({
      serverId: server.id,
      name: server.name,
      is4k: false,
      isDefault: server.isDefault,
      isIndependent: true,
      status: server.id === 1 ? 2 : 1,
      requestable: true,
      seasons: [1, 2].map((number) => ({
        seasonNumber: number,
        status: number === server.id ? 1 : server.id === 1 ? 2 : 5,
        requestable: number === server.id,
      })),
    }));
    cy.intercept('POST', '/api/v1/request', {
      statusCode: 201,
      body: createdRequest('tv', 2, [2]),
    }).as('successfulCreate');
    // FR's pending Season 2 must not occupy EN's Season 2 request slot.
    const frRequest = {
      ...pending(101, 1),
      seasons: [{ id: 101, seasonNumber: 2, status: 1 }],
    };
    visitMedia('tv', [frRequest], false, true, targets);
    clickAction(/^Request$/);
    cy.get('[role="dialog"] #server').should('have.value', '1');
    cy.contains('[role="dialog"] tbody tr', 'Season 2').should(
      'contain',
      'Pending'
    );
    cy.contains('[role="dialog"] tbody tr', 'Season 1')
      .find('[role="checkbox"]')
      .should('have.attr', 'aria-checked', 'false')
      .click()
      .should('have.attr', 'aria-checked', 'true');
    cy.contains('[role="dialog"] button', /^Request 1 Season$/).should(
      'not.be.disabled'
    );
    cy.get('[role="dialog"] #server').select('2');
    cy.get('[role="dialog"] #profile')
      .should('not.be.disabled')
      .and('have.value', '20');
    cy.contains('[role="dialog"] tbody tr', 'Season 1').should(
      'contain',
      'Available'
    );
    cy.contains('[role="dialog"] tbody tr', 'Season 2')
      .find('[role="checkbox"]')
      .should('have.attr', 'aria-checked', 'false');
    cy.contains('[role="dialog"] button', /^Select Season\(s\)$/).should(
      'be.disabled'
    );
    cy.contains('[role="dialog"] tbody tr', 'Season 1')
      .find('[role="checkbox"]')
      .click();
    cy.contains('[role="dialog"] button', /^Select Season\(s\)$/).should(
      'be.disabled'
    );
    cy.contains('[role="dialog"] tbody tr', 'Season 2')
      .find('[role="checkbox"]')
      .click();
    cy.contains('[role="dialog"] button', /^Request 1 Season$/)
      .should('not.be.disabled')
      .click();
    cy.wait('@successfulCreate').then(({ request, response }) => {
      expect(response?.statusCode).to.eq(201);
      expect(request.body).to.include({
        mediaType: 'tv',
        mediaId: tvId,
        tvdbId: 123,
        is4k: false,
        serverId: 2,
        userId: 1,
      });
      expect(request.body.seasons).to.deep.eq([2]);
      expectCreationOverrides(request.body);
    });
    cy.get('[role="dialog"]').should('not.exist');
    cy.contains('Correction Series requested successfully!').should(
      'be.visible'
    );
  });

  it('preserves manual fields across a failed beneficiary rule evaluation and retry', () => {
    visitMedia('movie');
    clickAction(/^Request$/);
    cy.get('#profile').should('not.be.disabled').select('11');
    cy.get('#folder').should('not.be.disabled').select('/custom');
    cy.contains('[role="dialog"] button', /^Request$/).should(
      'not.be.disabled'
    );
    cy.intercept('POST', '/api/v1/overrideRule/advancedRequest', {
      statusCode: 500,
      body: { message: 'Rules unavailable' },
    }).as('failedRules');
    cy.contains('[role="dialog"] button', 'Admin').click();
    cy.contains('[role="option"]', 'Beneficiary').click();
    cy.wait('@failedRules');
    cy.contains('[role="dialog"] button', /^Retry$/).should('be.visible');
    cy.contains('[role="dialog"] button', /^Request$/).should('be.disabled');
    cy.intercept('POST', '/api/v1/overrideRule/advancedRequest', {
      profileId: 10,
      rootFolder: '/1',
      tags: [],
    }).as('retriedRules');
    cy.contains('[role="dialog"] button', /^Retry$/).click();
    cy.wait('@retriedRules').then(({ request }) => {
      expect(request.body.serviceId).to.eq(1);
      expect(request.body.requestUser).to.eq(2);
    });
    cy.get('#profile').should('not.be.disabled').and('have.value', '11');
    cy.get('#folder').should('have.value', '/custom');
    cy.contains('[role="dialog"] button', /^Request$/).should(
      'not.be.disabled'
    );
  });

  it('ignores a stale retry response after destination, beneficiary and manual selection changes', () => {
    let retryStarted = false;
    let releaseRetry: (() => void) | undefined;
    cy.intercept('POST', '/api/v1/overrideRule/advancedRequest', (req) => {
      if (req.body.serviceId === 1) {
        if (!retryStarted) {
          req.alias = 'failedRules';
          req.reply({
            statusCode: 500,
            body: { message: 'Rules unavailable' },
          });
          return;
        }
        req.alias = 'staleRetry';
        return new Promise<void>((resolve) => {
          releaseRetry = () => {
            req.reply({ body: { profileId: 11, rootFolder: '/custom' } });
            resolve();
          };
        });
      }
      req.reply({
        body: {
          profileId: req.body.requestUser === 2 ? 21 : 20,
          rootFolder: req.body.requestUser === 2 ? '/custom' : '/2',
        },
      });
    });
    visitMedia('movie');
    clickAction(/^Request$/);
    cy.wait('@failedRules');
    cy.contains('[role="dialog"] button', /^Retry$/).should('be.visible');
    cy.then(() => {
      retryStarted = true;
    });
    cy.contains('[role="dialog"] button', /^Retry$/).click();
    cy.wrap(null).should(() => {
      expect(releaseRetry).to.be.a('function');
    });
    cy.get('#server').select('2');
    cy.get('#profile').should('not.be.disabled').and('have.value', '20');
    cy.contains('[role="dialog"] button', 'Admin').click();
    cy.contains('[role="option"]', 'Beneficiary').click();
    cy.get('#profile')
      .should('not.be.disabled')
      .and('have.value', '21')
      .select('20');
    cy.contains('[role="dialog"] button', /^Request$/).should(
      'not.be.disabled'
    );
    cy.then(() => {
      releaseRetry?.();
    });
    cy.wait('@staleRetry');
    cy.get('#server').should('have.value', '2');
    cy.get('#profile').should('not.be.disabled').and('have.value', '20');
    cy.get('#folder').should('have.value', '/custom');
    cy.contains('[role="dialog"] button', /^Request$/).should(
      'not.be.disabled'
    );
  });

  it('cancels a movie and deletes an empty TV edit when Override Rules fail', () => {
    cy.intercept('POST', '/api/v1/overrideRule/advancedRequest', {
      statusCode: 500,
      body: { message: 'Rules unavailable' },
    }).as('failedRules');
    visitMedia('movie', [pending(101, 1)]);
    clickAction(/^View Request — FR$/);
    cy.wait('@failedRules');
    cy.contains('[role="dialog"] button', /^Retry$/).should('be.visible');
    cy.contains('[role="dialog"] button', /^Cancel Request$/)
      .should('not.be.disabled')
      .click();
    cy.wait('@delete').its('request.url').should('include', '/request/101');
    visitMedia('tv', [pending(102, 1)]);
    clickAction(/^View Request — FR$/);
    cy.contains('[role="dialog"] button', /^Retry$/).should('be.visible');
    cy.get('[role="dialog"] tbody [role="checkbox"]').first().click();
    cy.contains('[role="dialog"] button', /^Cancel Request$/)
      .should('not.be.disabled')
      .click();
    cy.wait('@delete').its('request.url').should('include', '/request/102');
    cy.get('@edit.all').should('have.length', 0);
  });

  it('hides native TV Request More actions when globally blocklisted', () => {
    visitMedia('tv', [], true);
    cy.get('[data-testid="request-button"]').should('not.exist');
  });

  it('only approves/declines the selected native TV destination group', () => {
    visitMedia('tv', [pending(101, 1), pending(102, 1), pending(103, 2)]);
    clickAction(/^Approve Request — EN$/);
    cy.wait('@approve')
      .its('request.url')
      .should('include', '/request/103/approve');
    clickAction(/^Decline 2 Requests — FR$/);
    cy.wait(['@decline', '@decline']).then((calls) => {
      expect(
        calls.map((call) => call.request.url.split('/').slice(-2)[0]).sort()
      ).to.deep.eq(['101', '102']);
    });
    cy.get('@approve.all').should('have.length', 1);
  });

  it('cancels a movie and deletes an empty TV edit while Arr loading fails', () => {
    cy.intercept('GET', '/api/v1/service/*/1', { statusCode: 500 });
    visitMedia('movie', [pending(101, 1)]);
    clickAction(/^View Request — FR$/);
    cy.contains('[role="dialog"] button', /^Cancel Request$/)
      .should('not.be.disabled')
      .click();
    cy.wait('@delete').its('request.url').should('include', '/request/101');
    visitMedia('tv', [pending(102, 1)]);
    clickAction(/^View Request — FR$/);
    cy.get('[role="dialog"] tbody [role="checkbox"]').first().click();
    cy.contains('[role="dialog"] button', /^Cancel Request$/)
      .should('not.be.disabled')
      .click();
    cy.wait('@delete').its('request.url').should('include', '/request/102');
    cy.get('@edit.all').should('have.length', 0);
  });

  it('blocks creation while destination configuration fails', () => {
    cy.intercept('GET', '/api/v1/service/*/1', { statusCode: 500 });
    visitMedia('movie');
    clickAction(/^Request$/);
    cy.contains('[role="dialog"] button', /^Request$/).should('be.disabled');
    cy.contains('[role="dialog"] button', /^Retry$/).should('not.exist');
    cy.get('@create.all').should('have.length', 0);
  });

  it('waits for configuration when editing a destination while cancellation stays available', () => {
    visitMedia('movie', [pending(101, 1)]);
    clickAction(/^View Request — FR$/);
    cy.get('#profile').should('not.be.disabled');
    cy.intercept('POST', '/api/v1/overrideRule/advancedRequest', {
      delay: 500,
      body: {},
    }).as('editingRules');
    cy.get('#server').select('2');
    cy.contains('[role="dialog"] button', /^Approve Request$/).should(
      'be.disabled'
    );
    cy.contains('[role="dialog"] button', /^Cancel Request$/).should(
      'not.be.disabled'
    );
    cy.wait('@editingRules');
    cy.contains('[role="dialog"] button', /^Approve Request$/)
      .should('not.be.disabled')
      .click();
    cy.wait('@edit').then(({ request }) => {
      expect(request.body.serverId).to.eq(2);
      expect(request.body.profileId).to.eq(20);
      expect(request.body.rootFolder).to.eq('/2');
      expect(request.body.tags).to.deep.eq([2]);
    });
  });

  it('preserves manual settings during server revalidation and beneficiary changes', () => {
    let initialRulesCount = 0;
    // Control SWR's documented 2000ms request-deduplication timer, not network
    // latency. Install before page load so even prefetched Arr data uses it.
    cy.clock(Date.now(), ['setTimeout', 'clearTimeout']);
    visitMedia('movie');
    clickAction(/^Request$/);
    cy.get('#profile').should('not.be.disabled');
    cy.get('@rules.all').then((calls) => {
      initialRulesCount = (calls as unknown as unknown[]).length;
    });
    cy.get('#profile').should('not.be.disabled').select('11');
    cy.get('#folder').should('not.be.disabled').select('/custom');
    const revalidatedDetails = details(1);
    revalidatedDetails.profiles[0].name = 'Revalidated Default';
    cy.intercept('GET', '/api/v1/service/radarr/1', revalidatedDetails).as(
      'revalidated'
    );
    cy.tick(2000);
    cy.window().then((win) => {
      win.dispatchEvent(new win.Event('offline'));
      win.dispatchEvent(new win.Event('online'));
    });
    cy.tick(0);
    cy.clock().then((clock) => clock.restore());
    cy.wait('@revalidated');
    // A changed response exercises the component's revalidation effect; an
    // identical response can be discarded by SWR's deep equality comparison.
    cy.get('#profile option[value="10"]').should(
      'have.text',
      'Revalidated Default (Default)'
    );
    cy.get('#profile').should('not.be.disabled').and('have.value', '11');
    cy.get('#folder').should('have.value', '/custom');
    cy.get('@rules.all').should((calls) => {
      expect((calls as unknown as unknown[]).length).to.eq(initialRulesCount);
    });
    cy.contains('[role="dialog"] button', 'Admin').click();
    cy.contains('[role="option"]', 'Beneficiary').click();
    cy.get('@rules.all').should((calls) => {
      const last = (
        calls as unknown as {
          request: { body: { serviceId: number; requestUser: number } };
        }[]
      ).slice(-1)[0];
      expect((calls as unknown as unknown[]).length).to.eq(
        initialRulesCount + 1
      );
      expect(last?.request.body.serviceId).to.eq(1);
      expect(last?.request.body.requestUser).to.eq(2);
    });
    cy.get('#profile').should('not.be.disabled').and('have.value', '11');
    cy.get('#folder').should('have.value', '/custom');
    cy.get('#server').select('2');
    cy.get('#profile').should('not.be.disabled').and('have.value', '20');
    cy.get('#folder').should('have.value', '/2');
    cy.get('@rules.all').should((calls) => {
      const requests = calls as unknown as {
        request: { body: { serviceId: number; requestUser: number } };
      }[];
      expect(requests.length).to.eq(initialRulesCount + 2);
      expect(requests[requests.length - 1].request.body).to.include({
        serviceId: 2,
        requestUser: 2,
      });
    });
    cy.get('#server').select('2');
    cy.contains('[role="dialog"] button', 'Beneficiary').click();
    cy.contains('[role="option"]', 'Beneficiary').click();
    cy.get('#profile').should('not.be.disabled').and('have.value', '20');
    cy.get('@rules.all').should((calls) => {
      expect((calls as unknown as unknown[]).length).to.eq(
        initialRulesCount + 2
      );
    });
  });

  it('ignores delayed Override Rules from a previous destination', () => {
    cy.intercept('POST', '/api/v1/overrideRule/advancedRequest', (req) => {
      req.reply({
        delay: req.body.serviceId === 1 ? 500 : 0,
        body: { profileId: req.body.serviceId === 1 ? 11 : 20 },
      });
    }).as('delayedRules');
    visitMedia('movie');
    clickAction(/^Request$/);
    cy.get('@delayedRules.all').should((calls) => {
      expect((calls as unknown as unknown[]).length).to.be.greaterThan(0);
    });
    cy.get('#server').select('2');
    cy.get('#profile').should('not.be.disabled').and('have.value', '20');
    cy.wait(['@delayedRules', '@delayedRules']);
    cy.get('#profile').should('have.value', '20');
  });
});
