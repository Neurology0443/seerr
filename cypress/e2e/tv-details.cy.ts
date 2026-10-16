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

  it('preserves native TV destination status labels, 4K summaries and independent season-pack tooltips', () => {
    cy.viewport(1440, 1000);
    cy.intercept('GET', '/api/v1/settings/public', (req) => {
      delete req.headers['if-none-match'];
      delete req.headers['if-modified-since'];
      req.continue((res) => Object.assign(res.body, { series4kEnabled: true }));
    });
    const data = fixture(66732, 100, 'Label series');
    cy.intercept('GET', '/api/v1/tv/66732', {
      ...data,
      mediaInfo: { ...data.mediaInfo, serviceId4k: 2 },
    }).as('labelTitle');
    const pack = (season: number) =>
      Array.from({ length: 23 }, (_, index) => ({
        mediaType: 'tv',
        externalId: 100,
        downloadId: `pack-${season}`,
        title: `Season ${season} original release`,
        size: 100,
        sizeLeft: 40,
        status: 'paused',
        timeLeft: '00:10:00',
        estimatedCompletionTime: '2030-01-01T00:00:00Z',
        episode: {
          id: index + 1,
          seasonNumber: season,
          episodeNumber: index + 1,
          absoluteEpisodeNumber: index + 1,
        },
      }));
    const native = {
      serverId: 1,
      name: 'Native series',
      is4k: false,
      isIndependent: false,
      status: 3,
      downloads: [],
    };
    cy.intercept('GET', '/api/v1/media/100/downloads', {
      groups: [
        native,
        {
          ...native,
          serverId: 2,
          name: 'Native ultra HD',
          is4k: true,
          status: 4,
          downloads: pack(2),
        },
        {
          ...native,
          serverId: 3,
          name: 'Independent series',
          isIndependent: true,
          status: 5,
          downloads: [1, 2, 3].flatMap(pack),
        },
      ],
    }).as('statusSnapshot');
    cy.intercept('GET', '/api/v1/media/100/watch_data', {});
    cy.visit('/tv/66732');
    cy.wait(['@labelTitle', '@statusSnapshot']);
    cy.contains('.media-status a', 'Native series')
      .should('contain.text', 'Requested')
      .and('have.attr', 'href', '/tv/66733')
      .trigger('mouseenter');
    cy.get('[data-popper-placement]').should('contain.text', 'Play on Plex');
    cy.contains('.media-status a', 'Native series').trigger('mouseleave');
    cy.contains('.media-status a', 'Native ultra HD')
      .should('contain.text', '4K Processing')
      .and('contain.text', '· S2')
      .and('not.contain.text', 'S2E1')
      .trigger('mouseenter');
    cy.get('[data-popper-placement] li').should('have.length', 1);
    cy.get('[data-popper-placement]')
      .should('contain.text', 'Native ultra HD (4K)')
      .and('contain.text', 'Season 2 original release')
      .and('contain.text', '60%')
      .and('contain.text', 'paused');
    cy.contains('.media-status a', 'Native ultra HD').trigger('mouseleave');
    cy.contains('.media-status a', 'Independent series')
      .should('contain.text', 'Available')
      .and('contain.text', '· 3');
    cy.contains('.media-status a', 'Independent series')
      .find('div.absolute')
      .should('not.exist');
    cy.contains('.media-status a', 'Independent series').trigger('mouseenter');
    cy.get('[data-popper-placement] li').should('have.length', 3);
    for (const season of [1, 2, 3]) {
      cy.get('[data-popper-placement]').should(
        'contain.text',
        `Season ${season} original release`
      );
    }
    cy.contains('.media-status a', 'Independent series')
      .trigger('mouseleave')
      .click();
    cy.get('.slideover').should('be.visible');
    cy.contains('[data-testid="manage-download-group"]', 'Independent series')
      .find('li')
      .should('have.length', 3);
    cy.get('@statusSnapshot.all').should('have.length', 1);
  });

  for (const permissions of [2, 48]) {
    it(`preserves native polling alongside the shared snapshot with permissions ${permissions}`, () => {
      cy.intercept('GET', '/api/v1/auth/me', {
        id: 1,
        permissions,
        userType: 1,
        warnings: [],
      });
      const first = fixture(66732, 100, 'First series');
      const second = fixture(66733, 200, 'Polling series');
      const download = {
        mediaType: 'tv',
        externalId: 100,
        downloadId: 'native',
        title: 'Native release',
        size: 100,
        sizeLeft: 40,
        status: 'downloading',
        timeLeft: '00:10:00',
        estimatedCompletionTime: '2030-01-01T00:00:00Z',
      };
      const initial = {
        ...second,
        mediaInfo: { ...second.mediaInfo, downloadStatus: [download] },
      };
      let details = initial;
      let destination = 'Independent before refresh';
      cy.intercept('GET', '/api/v1/tv/66732', first).as('firstTitle');
      cy.intercept('GET', '/api/v1/tv/66733', (req) => req.reply(details)).as(
        'polledTitle'
      );
      cy.intercept('GET', '/api/v1/media/100/downloads', { groups: [] });
      cy.intercept('GET', '/api/v1/media/200/downloads', (req) =>
        req.reply({
          groups: [
            {
              serverId: 2,
              name: destination,
              is4k: false,
              isIndependent: true,
              status: 5,
              downloads: [],
            },
          ],
        })
      ).as('polledSnapshot');
      cy.intercept('GET', '/api/v1/media/200/watch_data', {});
      let appProps: Record<string, unknown>;
      cy.intercept('GET', '/_next/data/**/tv/66733.json*', (req) =>
        req.reply({
          ...appProps,
          pageProps: { tv: initial },
          __N_SSP: true,
        })
      );
      cy.clock(Date.now(), ['Date', 'setTimeout', 'clearTimeout']);
      cy.visit('/tv/66732');
      cy.wait('@firstTitle');
      cy.window().then((win) => {
        appProps = (
          win as unknown as {
            __NEXT_DATA__: { props: Record<string, unknown> };
          }
        ).__NEXT_DATA__.props;
      });
      cy.get('.media-status a[href="/tv/66733"]').click();
      cy.wait(['@polledTitle', '@polledSnapshot']);
      cy.contains('.media-status a', 'Independent before refresh').click();
      cy.get('.slideover').should('be.visible');
      cy.get('@polledSnapshot.all').should('have.length', 1);
      cy.then(() => {
        details = {
          ...initial,
          name: 'Refreshed series',
          mediaInfo: { ...initial.mediaInfo, status: 5, downloadStatus: [] },
        };
        destination = 'Independent after refresh';
      });
      cy.tick(14999);
      cy.get('@polledTitle.all').should('have.length', 1);
      cy.get('@polledSnapshot.all').should('have.length', 1);
      cy.tick(1);
      cy.wait(['@polledTitle', '@polledSnapshot']);
      cy.get('[data-testid="media-title"]').should(
        'contain.text',
        'Refreshed series'
      );
      cy.contains('.media-status a', /^Available$/).should('be.visible');
      cy.get('.media-status').should(
        'contain.text',
        'Independent after refresh'
      );
      cy.tick(15000);
      cy.wait(['@polledTitle', '@polledSnapshot']);
      cy.get('@polledTitle.all').should('have.length', 3);
      cy.get('@polledSnapshot.all').should('have.length', 3);
    });
  }

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
