export {};

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
  mediaUrl: 'https://native-playback.example/item/100',
  mediaUrl4k: 'https://native-playback.example/item/100-4k',
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

describe('destination removal management', () => {
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
      'destination-removal-admin',
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

  const managementTargets = [
    {
      serverId: 1,
      name: 'FR',
      is4k: false,
      isDefault: false,
      isIndependent: true,
      status: 5,
      requestable: false,
      canRemove: true,
      serviceUrl: 'https://fr.example/movie/exact',
    },
    {
      serverId: 2,
      name: 'EN',
      is4k: true,
      isDefault: true,
      isIndependent: true,
      status: 5,
      requestable: false,
      canRemove: true,
      serviceUrl: 'https://en.example/movie/exact',
    },
    {
      serverId: 3,
      name: 'No linkage',
      is4k: false,
      isDefault: false,
      isIndependent: true,
      status: 7,
      requestable: true,
      canRemove: false,
    },
  ];

  const setupManagement = () => {
    cy.intercept('GET', `/api/v1/movie/${movieId}`, {
      ...movie,
      mediaInfo: { ...movie.mediaInfo, requests: [] },
    }).as('mediaDetails');
    cy.intercept(
      'GET',
      `/api/v1/movie/${movieId}/request-targets`,
      managementTargets
    ).as('targets');
    cy.intercept('GET', '/api/v1/settings/radarr', []);
    cy.intercept('GET', '/api/v1/settings/sonarr', []);
    cy.visit(`/movie/${movieId}?manage=1`);
    cy.wait('@targets');
  };

  it('manages scanner-discovered FR and EN independently, including exact service links', () => {
    setupManagement();
    cy.contains('[data-testid="manage-destination"]', 'FR (Standard)').within(
      () => {
        cy.contains('a', 'Open in Radarr').should(
          'have.attr',
          'href',
          'https://fr.example/movie/exact'
        );
      }
    );
    cy.contains('[data-testid="manage-destination"]', 'EN (4K)').within(() => {
      cy.contains('a', 'Open in Radarr').should(
        'have.attr',
        'href',
        'https://en.example/movie/exact'
      );
    });
    cy.contains('[data-testid="manage-destination"]', 'No linkage').within(
      () => {
        cy.contains('Remove from Radarr').should('not.exist');
      }
    );
    cy.contains('multi-destination tracking data').should(
      'contain',
      'does not delete media files'
    );
  });

  it('confirms and removes exact EN, then refreshes targets and media details', () => {
    setupManagement();
    cy.intercept('DELETE', '/api/v1/media/100/file?serverId=2', {
      statusCode: 204,
    }).as('remove');
    cy.contains('[data-testid="manage-destination"]', 'EN (4K)').within(() => {
      cy.contains('button', 'Remove from Radarr').click();
      cy.contains(
        'button',
        'Remove this movie and its files from Radarr destination "EN"?'
      )
        .should('be.visible')
        .click();
    });
    cy.wait('@remove').its('request.url').should('not.contain', 'is4k');
    cy.wait('@targets');
    cy.wait('@mediaDetails');
    cy.get('[data-testid="manage-destination"]').should('not.exist');
  });

  it('reports independent HTTP 404 as an error and keeps management open', () => {
    setupManagement();
    cy.intercept('DELETE', '/api/v1/media/100/file?serverId=2', {
      statusCode: 404,
      body: { message: 'Missing target' },
    }).as('remove');
    cy.contains('[data-testid="manage-destination"]', 'EN (4K)').within(() => {
      cy.contains('button', 'Remove from Radarr').click();
      cy.contains('button', 'Remove this movie and its files').click();
    });
    cy.wait('@remove');
    cy.contains('Something went wrong while removing the media.').should(
      'be.visible'
    );
    cy.contains('[data-testid="manage-destination"]', 'EN (4K)').should(
      'be.visible'
    );
  });

  it('does not expose management actions without MANAGE_REQUESTS', () => {
    cy.intercept('GET', '/api/v1/auth/me', {
      ...admin,
      permissions: 32 | 16384,
    });
    setupManagement();
    cy.get('[data-testid="manage-destination"]').should('not.exist');
  });

  const setupRequestList = (independent = true) => {
    const row = {
      ...makeRequest(2, 'EN', 5),
      canRemove: true,
      target: independent
        ? { ...makeRequest(2, 'EN', 5).target, canRemove: true }
        : null,
    };
    cy.intercept('GET', '/api/v1/request?*', {
      pageInfo: { pages: 1, page: 1, results: 1, pageSize: 10 },
      results: [row],
      serviceErrors: { radarr: [], sonarr: [] },
    }).as('list');
    cy.intercept('GET', '/api/v1/request/2', row).as('detail');
    cy.intercept('GET', '/api/v1/request/count', {
      total: 1,
      pending: 0,
      approved: 1,
    }).as('count');
    cy.intercept(
      'GET',
      `/api/v1/movie/${movieId}/request-targets`,
      managementTargets
    ).as('targets');
    cy.visit('/requests?filter=all');
    cy.wait('@list');
    cy.wait('@detail');
  };

  it('RequestItem confirms exact EN and refreshes list, count, detail, media and targets', () => {
    setupRequestList();
    cy.intercept('DELETE', '/api/v1/media/100/file?serverId=2', {
      statusCode: 204,
    }).as('remove');
    cy.contains('button', 'Remove from Radarr').click();
    cy.contains(
      'button',
      'Remove this movie and its files from Radarr destination "EN"?'
    ).click();
    cy.wait('@remove');
    cy.wait('@list');
    cy.wait('@count');
    cy.wait('@detail');
    cy.wait('@movie');
  });

  it('RequestItem preserves native is4k removal', () => {
    setupRequestList(false);
    cy.intercept('DELETE', '/api/v1/media/100/file?is4k=false', {
      statusCode: 204,
    }).as('nativeRemove');
    cy.contains('button', 'Remove from Radarr')
      .as('nativeRemoveButton')
      .click();
    cy.get('@nativeRemoveButton').should('contain', 'Are you sure?').click();
    cy.wait('@nativeRemove')
      .its('request.url')
      .should('not.contain', 'serverId');
  });

  it('RequestItem reports independent deletion failure', () => {
    setupRequestList();
    cy.intercept('DELETE', '/api/v1/media/100/file?serverId=2', {
      statusCode: 404,
    }).as('remove');
    cy.contains('button', 'Remove from Radarr').click();
    cy.contains('button', 'Remove this movie and its files').click();
    cy.wait('@remove');
    cy.contains('Something went wrong while removing the media.').should(
      'be.visible'
    );
  });

  it('Delete Request does not call Arr removal', () => {
    setupRequestList();
    let removalCalls = 0;
    cy.intercept('DELETE', '/api/v1/media/*/file*', () => {
      removalCalls++;
    });
    cy.intercept('DELETE', '/api/v1/request/2', { statusCode: 204 }).as(
      'deleteRequest'
    );
    cy.contains('button', 'Delete Request').click();
    cy.contains('button', 'Are you sure?').click();
    cy.wait('@deleteRequest');
    cy.then(() => expect(removalCalls).to.equal(0));
  });
});
