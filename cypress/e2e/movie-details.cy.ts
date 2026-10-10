import {
  stubUxNavigation,
  uxMedia,
  uxMovie,
  uxUser,
} from 'cypress/support/ux-correction';

describe('Movie Details', () => {
  it('loads a movie page', () => {
    cy.loginAsAdmin();
    // Try to load minions: rise of gru
    cy.visit('/movie/438148');

    cy.get('[data-testid=media-title]').should(
      'contain',
      'Minions: The Rise of Gru (2022)'
    );
  });

  it('does not reopen the manager panel after closing and going back', () => {
    cy.loginAsAdmin();

    cy.visit('/movie/438148');
    cy.visit('/movie/438148?manage=1');

    cy.get('button[aria-label="Close panel"]').should('be.visible').click();
    cy.location('search').should('eq', '');
    cy.get('button[aria-label="Close panel"]').should('not.exist');

    cy.go('back');

    cy.location('search').should('eq', '');
    cy.get('button[aria-label="Close panel"]').should('not.exist');
  });
});

describe('Movie management gear UX correction', () => {
  const gear = () =>
    cy.get('.media-actions button').filter(':has(svg path[d^="M4.5 12"])');
  const request = (serverId: number) => ({
    id: 200 + serverId,
    type: 'movie',
    serverId,
    is4k: false,
    status: 2,
    requestedBy: uxUser,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    seasons: [],
    media: uxMedia(),
    target: {
      serverId,
      name: `Independent Radarr ${serverId}`,
      is4k: false,
      isIndependent: true,
      deleted: false,
      status: 3,
      downloadStatus: [],
    },
  });

  const visitMovie = (
    mediaInfo: Record<string, unknown> | undefined,
    permissions = 16,
    touch = false
  ) => {
    const movie = { ...uxMovie, mediaInfo };
    cy.intercept('GET', '/api/v1/auth/me', { ...uxUser, permissions });
    cy.intercept('GET', '/api/v1/movie/438148', movie).as('managedMovie');
    cy.intercept('GET', '/api/v1/movie/438148/request-targets', []).as(
      'managedTargets'
    );
    cy.visit(
      '/',
      touch
        ? {
            onBeforeLoad(win) {
              Object.defineProperty(win, 'ontouchstart', {
                value: null,
                configurable: true,
              });
            },
          }
        : {}
    );
    stubUxNavigation('/movie/438148', { movie });
    cy.get('[data-testid="title-card"]')
      .first()
      .trigger('mouseover')
      .find('a[href="/movie/438148"]')
      .click();
    cy.wait(['@managedMovie', '@managedTargets']);
    cy.get('[data-testid="media-title"]').should('contain', 'UX Movie');
  };

  beforeEach(() => {
    cy.loginAsAdmin();
    cy.viewport(1440, 1000);
    cy.intercept('GET', '/api/v1/settings/discover', [
      { id: 1, type: 4, enabled: true, isBuiltIn: true, order: 0 },
    ]);
    cy.intercept('GET', '/api/v1/discover/trending*', {
      page: 1,
      totalPages: 1,
      totalResults: 1,
      results: [{ ...uxMovie, mediaType: 'movie' }],
    });
    cy.intercept('GET', '/api/v1/settings/radarr', []);
    cy.intercept('GET', '/api/v1/settings/sonarr', []);
    cy.intercept('GET', '/api/v1/media/100/watch_data', {
      data: { users: [] },
    });
    // Guard against any unexpected management mutation; no real Arr is used.
    cy.intercept(
      { method: '+(POST|PUT|DELETE)', url: '**/api/v1/media/**' },
      { statusCode: 500 }
    ).as('managementMutation');
  });

  for (const [label, status] of [
    ['UNKNOWN', 1],
    ['PROCESSING', 3],
    ['AVAILABLE', 5],
  ] as const) {
    it(`shows the gear for a manager with a native ${label} media record`, () => {
      visitMovie(uxMedia(status));
      gear().should('have.length', 1).and('be.visible').trigger('mouseenter');
      cy.contains('[data-popper-placement]', 'Manage Movie').should(
        'be.visible'
      );
      gear().click();
      cy.contains('.slideover h2', 'Manage Movie').should('be.visible');
      cy.contains('.slideover button', 'Mark as Available').should('not.exist');
      cy.contains('.slideover button', 'Clear Data').should('not.exist');
      cy.get('@managementMutation.all').should('have.length', 0);
    });
  }

  for (const count of [1, 2]) {
    it(`opens existing requests for a native UNKNOWN record with ${count} independent Radarr destination(s)`, () => {
      const requests = Array.from({ length: count }, (_, index) =>
        request(index + 1)
      );
      // Both statuses UNKNOWN, no Jellyfin IDs: the old condition hid this gear.
      visitMovie({ ...uxMedia(), requests });
      gear().should('be.visible').click();
      cy.contains('.slideover h3', 'Requests').should('be.visible');
      requests.forEach((item) => {
        cy.get('.slideover [data-testid="request-destination"]').should(
          'contain',
          item.target.name
        );
      });
      cy.contains('.slideover button', 'Mark as Available').should('not.exist');
      cy.contains('.slideover button', 'Clear Data').should('not.exist');
      cy.contains('.slideover button', /Remove from.*Radarr/).should(
        'not.exist'
      );
      cy.get('@managementMutation.all').should('have.length', 0);
    });
  }

  it('preserves native administrator controls without adding independent management actions', () => {
    visitMovie({ ...uxMedia(), requests: [request(1), request(2)] }, 2);
    gear().click();
    cy.contains('.slideover button', /^Mark as Available$/).should(
      'be.visible'
    );
    cy.contains('.slideover button', 'Clear Data').should('exist');
    cy.get('.slideover')
      .contains('button', /Remove from.*Radarr/)
      .should('not.exist');
    cy.get('.slideover')
      .contains('button', /Mark.*Independent/)
      .should('not.exist');
    cy.get('@managementMutation.all').should('have.length', 0);
  });

  for (const status of [1, 3, 5]) {
    it(`hides the gear without MANAGE_REQUESTS for native status ${status}`, () => {
      visitMovie(uxMedia(status), 32);
      gear().should('not.exist');
      cy.get('button[aria-label="Close panel"]').should('not.exist');
    });
  }

  it('hides the gear when mediaInfo is missing even for an administrator', () => {
    visitMovie(undefined, 2);
    gear().should('not.exist');
  });

  it('opens the UNKNOWN Movie manager on a touch viewport', () => {
    cy.viewport('iphone-6');
    visitMovie({ ...uxMedia(), requests: [request(1)] }, 16, true);
    gear().should('be.visible').click();
    cy.contains('.slideover h2', 'Manage Movie').should('be.visible');
    cy.get('.slideover [data-testid="request-destination"]').should(
      'contain',
      'Independent Radarr 1'
    );
    cy.get('button[aria-label="Close panel"]').click();
    cy.get('.slideover').should('not.exist');
  });
});
