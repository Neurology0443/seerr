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

// Visibility only: management actions retain their own existing permissions.
describe('Manage Movie visibility', () => {
  const id = 438148;
  const title = (status = 1, requests: object[] = [], withMedia = true) => ({
    id,
    title: 'Manage Fixture',
    originalTitle: 'Manage Fixture',
    releaseDate: '2020-01-01',
    genres: [],
    keywords: [],
    credits: { cast: [], crew: [] },
    productionCompanies: [],
    productionCountries: [],
    externalIds: {},
    spokenLanguages: [],
    relatedVideos: [],
    watchProviders: [],
    releases: { results: [] },
    voteCount: 0,
    voteAverage: 0,
    popularity: 0,
    overview: 'Visibility regression',
    status: 'Released',
    mediaInfo: withMedia
      ? {
          id: 100,
          tmdbId: id,
          mediaType: 'movie',
          status,
          status4k: 1,
          requests,
          seasons: [],
          issues: [],
        }
      : undefined,
  });
  beforeEach(() => {
    cy.loginAsAdmin();
  });
  const visit = (data: ReturnType<typeof title>, permissions = 16) => {
    cy.intercept('GET', '/api/v1/auth/me', {
      id: 1,
      permissions,
      userType: 1,
      email: 'admin@seerr.dev',
      warnings: [],
    });
    cy.intercept('GET', `/api/v1/movie/${id}`, data).as('manageTitle');
    cy.intercept('GET', `/api/v1/movie/${id}/request-targets`, []);
    cy.visit(`/movie/${id}`);
    cy.wait('@manageTitle');
    cy.get('[data-testid=media-title]').should('contain', 'Manage Fixture');
  };
  for (const status of [1, 3, 5]) {
    it(`shows and opens Manage Movie for native status ${status} with MANAGE_REQUESTS`, () => {
      visit(title(status));
      cy.get('[data-testid=manage-movie-button]').should('be.visible').click();
      cy.get('button[aria-label="Close panel"]').should('be.visible');
      cy.contains('button', 'Clear Data').should('not.exist');
      cy.contains('button', 'Remove from Radarr').should('not.exist');
    });
  }
  for (const count of [1, 2]) {
    it(`native UNKNOWN remains manageable with ${count} independent requests on a touch viewport`, () => {
      cy.viewport('iphone-6');
      const requests = Array.from({ length: count }, (_, i) => ({
        id: 200 + i,
        serverId: i + 1,
        status: 2,
        type: 'movie',
        is4k: false,
        requestedBy: { id: 1, displayName: 'Admin', avatar: '/avatar.png' },
        media: {
          id: 100,
          tmdbId: id,
          mediaType: 'movie',
          status: 1,
          status4k: 1,
        },
        seasons: [],
        createdAt: '2020-01-01',
        target: {
          serverId: i + 1,
          name: `Independent ${i}`,
          isIndependent: true,
          is4k: false,
          status: 3,
          canRemove: false,
        },
      }));
      visit(title(1, requests));
      cy.get('[data-testid=manage-movie-button]').click();
      cy.get('button[aria-label="Close panel"]').should('be.visible');
      cy.contains('button', 'Remove from Radarr').should('not.exist');
      cy.contains('button', 'Clear Data').should('not.exist');
    });
  }
  it('preserves existing admin management actions', () => {
    visit(title(), 2);
    cy.get('[data-testid=manage-movie-button]').click();
    cy.contains('button', 'Clear Data').should('be.visible');
    cy.contains('button', 'Mark as Available').should('be.visible');
  });
  it('requires MANAGE_REQUESTS', () => {
    visit(title(5), 32);
    cy.get('[data-testid=manage-movie-button]').should('not.exist');
  });
  it('requires mediaInfo', () => {
    visit(title(1, [], false));
    cy.get('[data-testid=manage-movie-button]').should('not.exist');
  });
});
