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

  for (const permissions of [2, 48]) {
    it(`preserves native polling alongside the shared snapshot with permissions ${permissions}`, () => {
      const nextId = id + 1;
      const first = {
        ...title(5),
        mediaInfo: { ...title(5).mediaInfo, mediaUrl: `/movie/${nextId}` },
      };
      const download = {
        mediaType: 'movie',
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
        ...title(3),
        id: nextId,
        title: 'Polling movie',
        mediaInfo: {
          ...title(3).mediaInfo,
          id: 200,
          tmdbId: nextId,
          downloadStatus: [download],
        },
      };
      let details = initial;
      let destination = 'Independent before refresh';
      cy.intercept('GET', `/api/v1/movie/${nextId}`, (req) =>
        req.reply(details)
      ).as('polledTitle');
      cy.intercept('GET', `/api/v1/movie/${nextId}/request-targets`, []);
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
      cy.intercept('GET', `/_next/data/**/movie/${nextId}.json*`, (req) =>
        req.reply({
          ...appProps,
          pageProps: { movie: initial },
          __N_SSP: true,
        })
      );
      cy.clock(Date.now(), ['Date', 'setTimeout', 'clearTimeout']);
      visit(first, permissions);
      cy.window().then((win) => {
        appProps = (
          win as unknown as {
            __NEXT_DATA__: { props: Record<string, unknown> };
          }
        ).__NEXT_DATA__.props;
      });
      cy.contains('.media-status a', 'Available').click();
      cy.wait(['@polledTitle', '@polledSnapshot']);
      cy.get('[data-testid="manage-movie-button"]').click();
      cy.get('.slideover').should('be.visible');
      cy.get('@polledSnapshot.all').should('have.length', 1);
      cy.then(() => {
        details = {
          ...initial,
          title: 'Refreshed movie',
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
        'Refreshed movie'
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

  it('uses exact native snapshots and preserves playback navigation beside independent badges', () => {
    cy.viewport(1440, 1000);
    cy.clock(Date.now(), ['Date', 'setTimeout', 'clearTimeout']);
    cy.intercept('GET', '/api/v1/settings/public', (req) => {
      // Login may have cached the unmodified public settings. A 304 response
      // would keep that cached body instead of this scenario's 4K fixture.
      delete req.headers['if-none-match'];
      delete req.headers['if-modified-since'];
      req.continue((res) => Object.assign(res.body, { movie4kEnabled: true }));
    }).as('publicSettings');
    const data = title(3);
    const fixture = {
      ...data,
      mediaInfo: {
        ...data.mediaInfo,
        serviceId: 1,
        serviceId4k: 2,
        mediaUrl: 'https://native.example/movie/100',
        mediaUrl4k: 'https://native.example/movie/100-4k',
      },
    };
    cy.intercept('GET', '/api/v1/media/100/downloads', {
      groups: [
        {
          serverId: 1,
          name: 'Native standard',
          is4k: false,
          isIndependent: false,
          status: 5,
          downloads: [],
        },
        {
          serverId: 2,
          name: 'Native 4K',
          is4k: true,
          isIndependent: false,
          status: 4,
          downloads: [],
        },
        {
          serverId: 3,
          name: 'Independent movie',
          is4k: false,
          isIndependent: true,
          status: 3,
          downloads: [],
        },
      ],
    }).as('snapshot');
    visit(fixture, 2);
    cy.wait('@snapshot');
    cy.tick(2000);
    cy.window().then((win) => {
      win.dispatchEvent(new win.Event('offline'));
      win.dispatchEvent(new win.Event('online'));
    });
    cy.tick(0);
    cy.wait('@publicSettings')
      .its('response.body.movie4kEnabled')
      .should('eq', true);
    cy.tick(0);
    cy.contains('.media-status a', 'Native standard')
      .should('contain.text', 'Available')
      .and('have.attr', 'href', 'https://native.example/movie/100')
      .trigger('mouseenter');
    cy.tick(0);
    cy.get('[data-popper-placement]').should('contain.text', 'Play on Plex');
    cy.contains('.media-status a', 'Native standard').trigger('mouseleave');
    cy.contains('.media-status a', 'Native 4K')
      .should('contain.text', '4K Partially Available')
      .and('have.attr', 'href', 'https://native.example/movie/100-4k');
    cy.contains('.media-status a', 'Independent movie')
      .should('contain.text', 'Processing')
      .and('have.attr', 'href', `/movie/${id}?manage=1`);
  });
});
