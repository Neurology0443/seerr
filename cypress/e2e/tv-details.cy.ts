describe('TV Details', () => {
  it('loads a tv details page', () => {
    cy.loginAsAdmin();
    // Try to load stranger things
    cy.visit('/tv/66732');

    cy.get('[data-testid=media-title]').should(
      'contain',
      'Stranger Things (2016)'
    );
  });

  it('shows seasons and expands episodes', () => {
    cy.loginAsAdmin();

    // Try to load stranger things
    cy.visit('/tv/66732');

    // intercept request for season info
    cy.intercept('/api/v1/tv/66732/season/4').as('season4');

    cy.contains('Season 4').should('be.visible').scrollIntoView().click();

    cy.wait('@season4');

    cy.contains('Chapter Nine').should('be.visible');
  });
});

describe('Destination-aware TV snapshots', () => {
  const fixture = (id: number, mediaId: number, name: string) => ({
    id,
    name,
    originalName: name,
    firstAirDate: '2020-01-01',
    genres: [],
    keywords: [],
    credits: { cast: [], crew: [] },
    productionCompanies: [],
    productionCountries: [],
    externalIds: {},
    spokenLanguages: [],
    relatedVideos: [],
    watchProviders: [],
    voteCount: 0,
    voteAverage: 0,
    popularity: 0,
    overview: 'Snapshot regression',
    contentRatings: { results: [] },
    networks: [],
    createdBy: [],
    episodeRunTime: [],
    languages: [],
    originCountry: [],
    numberOfSeasons: 0,
    seasons: [],
    mediaInfo: {
      id: mediaId,
      tmdbId: id,
      mediaType: 'tv',
      status: 3,
      status4k: 1,
      serviceId: 1,
      mediaUrl: '/tv/66733',
      requests: [],
      seasons: [],
      issues: [],
    },
  });
  beforeEach(() => {
    cy.session(
      'tv-snapshot-admin',
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
    cy.intercept('GET', '/api/v1/auth/me', {
      id: 1,
      displayName: 'Admin',
      permissions: 2,
      warnings: [],
      userType: 1,
      avatar: '/user-icon-192x192.png',
    });
    for (const id of [66732, 66733])
      cy.intercept('GET', `/api/v1/tv/${id}/request-targets`, []);
  });

  it('clears the previous media snapshot during client navigation and revalidates renamed destinations', () => {
    const first = fixture(66732, 100, 'First series');
    const second = fixture(66733, 200, 'Second series');
    const native = {
      serverId: 1,
      name: 'Native',
      is4k: false,
      isIndependent: false,
      status: 5,
      downloads: [],
    };
    cy.intercept('GET', '/api/v1/tv/66732', first).as('firstTitle');
    cy.intercept('GET', '/api/v1/tv/66733', second).as('secondTitle');
    let appProps: Record<string, unknown>;
    cy.intercept('GET', '/_next/data/**/tv/66733.json*', (req) =>
      req.reply({
        ...appProps,
        pageProps: { tv: second },
        __N_SSP: true,
      })
    ).as('secondPage');
    cy.intercept('GET', '/api/v1/media/100/downloads', {
      groups: [
        native,
        {
          ...native,
          serverId: 2,
          name: 'Old destination',
          isIndependent: true,
        },
      ],
    }).as('firstSnapshot');
    let name = 'New destination';
    cy.intercept('GET', '/api/v1/media/200/downloads', (req) =>
      req.reply({
        delay: 1000,
        body: {
          groups: [
            native,
            { ...native, serverId: 3, name, isIndependent: true },
          ],
        },
      })
    ).as('secondSnapshot');
    cy.clock(Date.now(), ['Date', 'setTimeout', 'clearTimeout']);
    cy.visit('/tv/66732');
    cy.wait(['@firstTitle', '@firstSnapshot']);
    cy.get('.media-status').should('contain.text', 'Old destination');
    cy.window().then((win) => {
      appProps = (
        win as unknown as { __NEXT_DATA__: { props: Record<string, unknown> } }
      ).__NEXT_DATA__.props;
    });
    cy.contains('.media-status a', 'Native').click();
    cy.wait('@secondPage');
    cy.get('[data-testid="media-title"]').should(
      'contain.text',
      'Second series'
    );
    cy.get('.media-status').should('not.contain.text', 'Old destination');
    cy.wait('@secondSnapshot');
    cy.get('.media-status')
      .should('contain.text', 'New destination')
      .then(() => {
        name = 'Renamed destination';
      });
    cy.tick(2000);
    cy.window().then((win) => {
      win.dispatchEvent(new win.Event('offline'));
      win.dispatchEvent(new win.Event('online'));
    });
    cy.tick(0);
    cy.wait('@secondSnapshot');
    cy.get('.media-status')
      .should('contain.text', 'Renamed destination')
      .and('not.contain.text', 'New destination');
    cy.get('@firstSnapshot.all').should('have.length', 1);
  });
});
