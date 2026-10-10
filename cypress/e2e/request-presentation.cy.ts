const movieId = 438148;
const admin = {
  id: 1,
  displayName: 'Admin',
  avatar: '/user-icon-192x192.png',
  permissions: 2,
  warnings: [],
  userType: 1,
};
const queue = (name: string) => [
  {
    mediaType: 'movie',
    externalId: 10,
    downloadId: name,
    title: `${name} download`,
    size: 1000,
    sizeLeft: 500,
    status: 'downloading',
    timeLeft: '00:05:00',
    estimatedCompletionTime: '2030-01-01T00:00:00Z',
  },
];
const media = {
  id: 100,
  tmdbId: movieId,
  mediaType: 'movie',
  status: 5,
  status4k: 5,
  serviceUrl: 'https://native.example',
  downloadStatus: queue('native'),
  requests: [],
  seasons: [],
  issues: [],
};
const makeRequest = (id: number, name: string, status: number) => ({
  id,
  type: 'movie',
  serverId: id,
  is4k: false,
  status: 2,
  requestedBy: admin,
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
  seasons: [],
  media,
  target: {
    serverId: id,
    name,
    is4k: false,
    isIndependent: true,
    deleted: false,
    status,
    downloadStatus: status === 3 ? queue(name) : [],
    serviceUrl: `https://${name.toLowerCase()}.example/movie/exact`,
  },
});
const requests = [
  makeRequest(1, 'FR', 5),
  makeRequest(2, 'EN', 3),
  {
    ...makeRequest(3, 'Deleted Radarr server (#3)', 7),
    target: {
      ...makeRequest(3, 'Deleted Radarr server (#3)', 7).target,
      deleted: true,
      serviceUrl: undefined,
      downloadStatus: [],
    },
  },
];
const movie = {
  id: movieId,
  title: 'Presentation Movie',
  originalTitle: 'Presentation Movie',
  releaseDate: '2020-01-01',
  status: 'Released',
  overview: 'Presentation fixture',
  genres: [],
  keywords: [],
  credits: { cast: [], crew: [] },
  productionCompanies: [],
  productionCountries: [],
  spokenLanguages: [],
  relatedVideos: [],
  watchProviders: [],
  voteCount: 0,
  voteAverage: 0,
  popularity: 0,
  externalIds: {},
  releases: { results: [] },
  mediaInfo: { ...media, serviceUrl: undefined, downloadStatus: [], requests },
};

describe('independent request presentation', () => {
  beforeEach(() => {
    cy.viewport(1440, 1000);
    cy.intercept('GET', '/api/v1/auth/me', admin);
    cy.intercept('GET', '/api/v1/settings/discover', [
      { id: 1, type: 2, enabled: true, isBuiltIn: true, order: 0 },
    ]);
    cy.intercept('GET', '/api/v1/request?*', {
      pageInfo: { pages: 1, page: 1, results: 3, pageSize: 10 },
      results: requests,
      serviceErrors: { radarr: [], sonarr: [] },
    });
    cy.intercept('GET', '/api/v1/request/count', {
      total: 3,
      pending: 0,
      approved: 3,
    });
    for (const request of requests)
      cy.intercept('GET', `/api/v1/request/${request.id}`, request);
    cy.intercept('GET', `/api/v1/movie/${movieId}`, movie).as('movie');
    cy.intercept('GET', `/api/v1/movie/${movieId}/request-targets`, []);
    cy.intercept('GET', '/api/v1/service/radarr', [
      { id: 1, name: 'FR', is4k: false, isDefault: true },
    ]);
    cy.intercept('GET', '/api/v1/service/radarr/*', {
      server: { id: 1 },
      profiles: [],
      rootFolders: [],
      tags: [],
    });
    cy.intercept('GET', '/api/v1/media/100/watch_data', {
      data: { users: [] },
    });
    // Authenticate directly so the login page's asynchronous redirect cannot
    // navigate away from the page whose polling is being measured.
    cy.session(
      'request-presentation-admin',
      () => {
        cy.request('POST', '/api/v1/auth/local', {
          email: Cypress.env('ADMIN_EMAIL'),
          password: Cypress.env('ADMIN_PASSWORD'),
        })
          .its('status')
          .should('eq', 200);
      },
      {
        validate() {
          cy.request('/api/v1/auth/me').its('status').should('eq', 200);
        },
      }
    );
  });

  for (const view of ['cards', 'list']) {
    for (const fallback of [false, true]) {
      it(`discovers a later download and stops terminal polling in ${view}${fallback ? ' when title loading fails' : ''}`, () => {
        let pageLoads = 0;
        cy.on('window:before:load', () => {
          pageLoads += 1;
        });
        let current: ReturnType<typeof makeRequest> = {
          ...makeRequest(2, 'EN', 3),
          target: { ...makeRequest(2, 'EN', 3).target, downloadStatus: [] },
        };
        cy.intercept('GET', '/api/v1/request?*', {
          pageInfo: { pages: 1, page: 1, results: 1, pageSize: 10 },
          results: [current],
          serviceErrors: { radarr: [], sonarr: [] },
        });
        cy.intercept('GET', '/api/v1/request/2', (req) =>
          req.reply(current)
        ).as('progress');
        if (fallback)
          cy.intercept('GET', `/api/v1/movie/${movieId}`, {
            statusCode: 500,
            body: { message: 'Unavailable' },
          });
        cy.visit(view === 'cards' ? '/' : '/requests?filter=all');
        cy.wait('@progress');
        cy.contains('[data-testid="request-destination"]', 'EN')
          .parent()
          .should('contain', 'Requested');
        cy.contains('EN download').should('not.exist');
        cy.then(() => {
          current = makeRequest(2, 'EN', 3);
        });
        cy.wait('@progress', { requestTimeout: 20000 });
        cy.contains('[data-testid="request-destination"]', 'EN')
          .parent()
          .contains('a', 'Processing')
          .trigger('mouseenter');
        cy.contains('EN download').should('be.visible');
        cy.contains('native download').should('not.exist');
        cy.then(() => {
          current = { ...makeRequest(2, 'EN', 5), status: 5 };
        });
        cy.wait('@progress', { requestTimeout: 20000 });
        cy.contains('[data-testid="request-destination"]', 'EN')
          .parent()
          .should('contain', 'Available');
        cy.get('@progress.all').then((calls) => {
          // Observe two full polling intervals after the terminal response.
          cy.wait(30000);
          const expectedCalls = calls.length;
          cy.get('@progress.all').should((laterCalls) => {
            expect(pageLoads, 'no page reload during polling').to.equal(1);
            expect(laterCalls.length).to.equal(expectedCalls);
          });
        });
      });

      it(`shows exact destinations, status and progress in ${view}${fallback ? ' when title loading fails' : ''}`, () => {
        if (fallback)
          cy.intercept('GET', `/api/v1/movie/${movieId}`, {
            statusCode: 500,
            body: { message: 'Unavailable' },
          });
        cy.visit(view === 'cards' ? '/' : '/requests?filter=all');
        for (const [name, status] of [
          ['FR', 'Available'],
          ['EN', 'Processing'],
          ['Deleted Radarr server (#3)', 'Deleted'],
        ]) {
          cy.contains('[data-testid="request-destination"]', name)
            .should('be.visible')
            .parent()
            .should('contain', status);
        }
        cy.contains('[data-testid="request-destination"]', 'EN')
          .parent()
          .contains('a', 'Processing')
          .trigger('mouseenter');
        cy.contains('EN download').should('be.visible');
        cy.contains('native download').should('not.exist');
        cy.contains('FR download').should('not.exist');
        if (fallback) {
          cy.contains('[data-testid="request-destination"]', 'FR')
            .parent()
            .contains('a', 'Available')
            .should('have.attr', 'href', 'https://fr.example/movie/exact');
          cy.contains('[data-testid="request-destination"]', 'EN')
            .parent()
            .contains('a', 'Processing')
            .should('have.attr', 'href', 'https://en.example/movie/exact');
          cy.contains(
            '[data-testid="request-destination"]',
            'Deleted Radarr server (#3)'
          )
            .parent()
            .contains('Deleted')
            .should('not.have.attr', 'href');
        }
      });
    }
  }

  for (const view of ['cards', 'list']) {
    it(`preserves pending, declined and failed lifecycle badges in ${view}`, () => {
      const lifecycle = [
        ['Pending', 1],
        ['Declined', 3],
        ['Failed', 4],
      ].map(([name, status], index) => ({
        ...makeRequest(index + 1, String(name), 1),
        status,
      }));
      cy.intercept('GET', '/api/v1/request?*', {
        pageInfo: { pages: 1, page: 1, results: 3, pageSize: 10 },
        results: lifecycle,
        serviceErrors: { radarr: [], sonarr: [] },
      });
      for (const request of lifecycle)
        cy.intercept('GET', `/api/v1/request/${request.id}`, request);
      cy.visit(view === 'cards' ? '/' : '/requests?filter=all');
      for (const request of lifecycle)
        cy.contains('[data-testid="request-destination"]', request.target.name)
          .parent()
          .contains('span, a', request.target.name)
          .should('be.visible');
    });
  }

  it('shows the default independent destination and deleted identity once in management blocks', () => {
    cy.visit(`/movie/${movieId}?manage=1`);
    cy.wait('@movie');
    cy.contains('[data-testid="request-destination"]', 'FR').should(
      'be.visible'
    );
    cy.get('[data-testid="request-destination"]')
      .filter(':contains("FR")')
      .should('have.length', 1);
    cy.contains(
      '[data-testid="request-destination"]',
      'Deleted Radarr server (#3)'
    ).should('be.visible');
    cy.get('[data-testid="request-destination-status"]')
      .eq(0)
      .should('contain', 'Available');
    cy.get('[data-testid="request-destination-status"]')
      .eq(1)
      .should('contain', 'Requested');
    cy.contains('Approved').should('be.visible');
    cy.contains('Remove from Radarr').should('not.exist');
  });
});
