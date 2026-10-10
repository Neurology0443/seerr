import {
  refreshUxSettings,
  stubUxNavigation,
  uxMedia,
  uxMovie,
  uxTv,
  uxUser,
} from 'cypress/support/ux-correction';

// Button eligibility smoke checks complement the existing PR5 modal/POST tests.
describe('Detail request entry points after card Quick Request removal', () => {
  beforeEach(() => {
    cy.loginAsAdmin();
    cy.intercept('GET', '/api/v1/settings/discover', [
      { id: 1, type: 4, enabled: true, isBuiltIn: true, order: 0 },
    ]);
    cy.intercept('GET', '/api/v1/settings/public', (req) => {
      delete req.headers['if-none-match'];
      req.continue((res) => {
        res.body = { ...res.body, movie4kEnabled: true, series4kEnabled: true };
      });
    }).as('uxSettings');
  });

  const scenarios = [
    {
      name: 'native Movie requestable',
      type: 'movie',
      native: true,
      independent: false,
      permissions: 32,
      expected: 'Request',
    },
    {
      name: 'independent Movie requestable with native AVAILABLE',
      type: 'movie',
      native: false,
      independent: true,
      permissions: 32 | 8192,
      expected: 'Request',
    },
    {
      name: 'all Movie destinations unavailable',
      type: 'movie',
      native: false,
      independent: false,
      permissions: 32,
      expected: undefined,
    },
    {
      name: 'unavailable default for non-Advanced Movie user',
      type: 'movie',
      native: false,
      independent: true,
      permissions: 32,
      expected: undefined,
    },
    {
      name: 'native TV complete with independent season requestable',
      type: 'tv',
      native: false,
      independent: true,
      permissions: 32 | 8192,
      expected: 'Request',
    },
    {
      name: 'all TV seasons unavailable',
      type: 'tv',
      native: false,
      independent: false,
      permissions: 32 | 8192,
      expected: undefined,
    },
    {
      name: '4K-only Movie requestability with 4K permission',
      type: 'movie',
      native: false,
      independent: false,
      fourK: true,
      permissions: 32 | 1024,
      expected: 'Request in 4K',
    },
    {
      name: '4K-only Movie requestability without 4K permission',
      type: 'movie',
      native: false,
      independent: false,
      fourK: true,
      permissions: 32,
      expected: undefined,
    },
    {
      name: '4K-only TV requestability with 4K permission',
      type: 'tv',
      native: false,
      independent: false,
      fourK: true,
      permissions: 32 | 1024,
      expected: 'Request in 4K',
    },
    {
      name: '4K-only TV requestability without 4K permission',
      type: 'tv',
      native: false,
      independent: false,
      fourK: true,
      permissions: 32,
      expected: undefined,
    },
  ] as const;

  const visit = (scenario: (typeof scenarios)[number], pending = false) => {
    const { type } = scenario;
    const base = type === 'movie' ? uxMovie : uxTv;
    const media = {
      ...uxMedia(scenario.native ? 1 : 5),
      tmdbId: base.id,
      mediaType: type,
    };
    const request = {
      id: 201,
      type,
      serverId: 2,
      is4k: false,
      status: 1,
      requestedBy: uxUser,
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
      media,
      seasons: [],
      target: {
        serverId: 2,
        name: 'Independent',
        isIndependent: true,
        is4k: false,
        deleted: false,
        status: 2,
      },
    };
    const title = {
      ...base,
      mediaInfo: { ...media, requests: pending ? [request] : [] },
    };
    cy.intercept('GET', '/api/v1/auth/me', {
      ...uxUser,
      permissions: scenario.permissions,
    });
    cy.intercept('GET', '/api/v1/discover/trending*', {
      page: 1,
      totalPages: 1,
      totalResults: 1,
      results: [{ ...base, mediaType: type }],
    });
    const targets = [
      {
        serverId: 1,
        name: 'Native',
        isDefault: true,
        isIndependent: false,
        is4k: false,
        requestable: scenario.native,
      },
      {
        serverId: 2,
        name: 'Independent',
        isDefault: false,
        isIndependent: true,
        is4k: false,
        requestable: scenario.independent,
      },
      {
        serverId: 3,
        name: '4K',
        isDefault: true,
        isIndependent: false,
        is4k: true,
        requestable: 'fourK' in scenario && scenario.fourK,
      },
    ].map((target) => ({
      ...target,
      status: target.requestable ? 1 : 5,
      ...(type === 'tv'
        ? {
            seasons: [
              {
                seasonNumber: 1,
                status: target.requestable ? 1 : 5,
                requestable: target.requestable,
              },
            ],
          }
        : {}),
    }));
    cy.intercept('GET', `/api/v1/${type}/${base.id}`, title).as('entryDetails');
    cy.intercept(
      'GET',
      `/api/v1/${type}/${base.id}/request-targets`,
      targets
    ).as('entryTargets');
    cy.clock(Date.now(), ['setTimeout', 'clearTimeout']);
    cy.visit('/');
    stubUxNavigation(
      `/${type}/${base.id}`,
      { [type]: title },
      { movie4kEnabled: true, series4kEnabled: true }
    );
    cy.get('[data-testid="title-card"]')
      .first()
      .trigger('mouseover')
      .find(`a[href="/${type}/${base.id}"]`)
      .click();
    cy.wait(['@entryDetails', '@entryTargets']);
    refreshUxSettings();
    cy.get('[data-testid="media-title"]').should(
      'contain',
      type === 'movie' ? 'UX Movie' : 'UX Series'
    );
  };

  scenarios.forEach((scenario) => {
    it(`preserves ${scenario.name}`, () => {
      visit(scenario);
      if (scenario.expected) {
        cy.get('[data-testid="request-button"]')
          .should('have.text', scenario.expected)
          .and('be.visible');
      } else {
        cy.get('[data-testid="request-button"]').should('not.exist');
      }
    });
  });

  for (const type of ['movie', 'tv'] as const) {
    it(`preserves existing pending ${type} request actions when all targets are unavailable`, () => {
      const scenario = scenarios.find(
        (item) => item.type === type && item.name.startsWith('all')
      )!;
      visit(scenario, true);
      cy.get('[data-testid="request-button"]').should(
        'have.text',
        'View Request — Independent'
      );
    });
  }
});
