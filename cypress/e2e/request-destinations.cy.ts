// Runs against the existing Cypress app/database, like movie-details.cy.ts.
// Arr, request mutations and requestability are stubbed for these UI regressions.
import type {
  MovieRequestTarget,
  TvRequestTarget,
} from '@server/interfaces/api/requestInterfaces';

const movieId = 438148;
const tvId = 66732;
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
const pending = (id: number, serverId: number | null) => ({
  id,
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
  targetOverrides?: (MovieRequestTarget | TvRequestTarget)[]
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
    keywords: [],
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
          seasons: [1, 2].map((number) => ({
            id: number,
            seasonNumber: number,
            episodeCount: 10,
            name: `Season ${number}`,
          })),
        };
  cy.intercept('GET', `/api/v1/${type}/${id}`, title).as('title');
  const requestTargets = targetOverrides ?? [
    ...servers.map((server) => ({
      serverId: server.id,
      name: server.name,
      is4k: false,
      isDefault: server.isDefault,
      isIndependent: independent,
      status: 1,
      requestable: true,
      seasons: [1, 2].map((number) => ({
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
    cy.intercept('PUT', '/api/v1/request/*', {}).as('edit');
    cy.intercept('DELETE', '/api/v1/request/*', { statusCode: 204 }).as(
      'delete'
    );
    cy.intercept('POST', '/api/v1/request/*/approve', {}).as('approve');
    cy.intercept('POST', '/api/v1/request/*/decline', {}).as('decline');
  });

  for (const type of ['movie', 'tv'] as const) {
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
      cy.wait('@edit').its('request.body.serverId').should('eq', 2);
    });

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
      visitMedia(type, [pending(101, 99)]);
      clickAction(/^View Request — Request #101$/);
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
        profileId: 20,
        rootFolder: '/2',
        userId: 1,
      });
      expect(request.body.tags).to.deep.eq([2]);
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
        profileId: 20,
        rootFolder: '/2',
        languageProfileId: 20,
        userId: 1,
      });
      expect(request.body.seasons).to.deep.eq([2]);
      expect(request.body.tags).to.deep.eq([2]);
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
      expect(request.body.profileId).to.eq(11);
      expect(request.body.rootFolder).to.eq('/custom');
      expect(request.body.tags).to.deep.eq([]);
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
