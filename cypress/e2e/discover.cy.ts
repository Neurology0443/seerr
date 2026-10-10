import {
  refreshUxSettings,
  stubUxNavigation,
  uxCollection,
  uxMedia,
  uxMovie,
  uxTv,
  uxUser,
} from '../support/ux-correction';

const clickFirstTitleCardInSlider = (sliderTitle: string): void => {
  cy.contains('.slider-header', sliderTitle)
    .next('[data-testid=media-slider]')
    .find('[data-testid=title-card]')
    .first()
    .trigger('mouseover')
    .find('[data-testid=title-card-title]')
    .invoke('text')
    .then((text) => {
      cy.contains('.slider-header', sliderTitle)
        .next('[data-testid=media-slider]')
        .find('[data-testid=title-card]')
        .first()
        .click();
      cy.get('[data-testid=media-title]').should('contain', text);
    });
};

describe('Discover', () => {
  beforeEach(() => {
    cy.loginAsAdmin();
  });

  it('loads a trending item', () => {
    cy.intercept('/api/v1/discover/trending*').as('getTrending');
    cy.visit('/');
    cy.wait('@getTrending');
    clickFirstTitleCardInSlider('Trending');
  });

  it('loads popular movies', () => {
    cy.intercept('/api/v1/discover/movies*').as('getPopularMovies');
    cy.visit('/');
    cy.wait('@getPopularMovies');
    clickFirstTitleCardInSlider('Popular Movies');
  });

  it('loads upcoming movies', () => {
    cy.intercept('/api/v1/discover/movies?page=1&primaryReleaseDateGte*').as(
      'getUpcomingMovies'
    );
    cy.visit('/');
    cy.wait('@getUpcomingMovies');
    clickFirstTitleCardInSlider('Upcoming Movies');
  });

  it('loads popular series', () => {
    cy.intercept('/api/v1/discover/tv*').as('getPopularTv');
    cy.visit('/');
    cy.wait('@getPopularTv');
    clickFirstTitleCardInSlider('Popular Series');
  });

  it('loads upcoming series', () => {
    cy.intercept('/api/v1/discover/tv?page=1&firstAirDateGte=*').as(
      'getUpcomingSeries'
    );
    cy.visit('/');
    cy.wait('@getUpcomingSeries');
    clickFirstTitleCardInSlider('Upcoming Series');
  });

  it('displays error for media with invalid TMDB ID', () => {
    cy.intercept('GET', '/api/v1/media?*', {
      pageInfo: { pages: 1, pageSize: 20, results: 1, page: 1 },
      results: [
        {
          downloadStatus: [],
          downloadStatus4k: [],
          id: 1922,
          mediaType: 'movie',
          tmdbId: 998814,
          tvdbId: null,
          imdbId: null,
          status: 5,
          status4k: 1,
          createdAt: '2022-08-18T18:11:13.000Z',
          updatedAt: '2022-08-18T19:56:41.000Z',
          lastSeasonChange: '2022-08-18T19:56:41.000Z',
          mediaAddedAt: '2022-08-18T19:56:41.000Z',
          serviceId: null,
          serviceId4k: null,
          externalServiceId: null,
          externalServiceId4k: null,
          externalServiceSlug: null,
          externalServiceSlug4k: null,
          ratingKey: null,
          ratingKey4k: null,
          seasons: [],
        },
      ],
    }).as('getMedia');

    cy.visit('/');
    cy.wait('@getMedia');
    cy.contains('.slider-header', 'Recently Added')
      .next('[data-testid=media-slider]')
      .find('[data-testid=title-card]')
      .first()
      .find('[data-testid=title-card-title]')
      .contains('Movie Not Found');
  });

  it('displays error for request with invalid TMDB ID', () => {
    cy.intercept('GET', '/api/v1/request?*', {
      pageInfo: { pages: 1, pageSize: 10, results: 1, page: 1 },
      results: [
        {
          id: 582,
          status: 1,
          createdAt: '2022-08-18T18:11:13.000Z',
          updatedAt: '2022-08-18T18:11:13.000Z',
          type: 'movie',
          is4k: false,
          serverId: null,
          profileId: null,
          rootFolder: null,
          languageProfileId: null,
          tags: null,
          media: {
            downloadStatus: [],
            downloadStatus4k: [],
            id: 1922,
            mediaType: 'movie',
            tmdbId: 998814,
            tvdbId: null,
            imdbId: null,
            status: 2,
            status4k: 1,
            createdAt: '2022-08-18T18:11:13.000Z',
            updatedAt: '2022-08-18T18:11:13.000Z',
            lastSeasonChange: '2022-08-18T18:11:13.000Z',
            mediaAddedAt: null,
            serviceId: null,
            serviceId4k: null,
            externalServiceId: null,
            externalServiceId4k: null,
            externalServiceSlug: null,
            externalServiceSlug4k: null,
            ratingKey: null,
            ratingKey4k: null,
          },
          seasons: [],
          modifiedBy: null,
          requestedBy: {
            permissions: 4194336,
            id: 18,
            email: 'demo@seerr.dev',
            plexUsername: null,
            username: '',
            recoveryLinkExpirationDate: null,
            userType: 2,
            avatar:
              'https://gravatar.com/avatar/c77fdc27cab83732b8623d2ea873d330?default=mm&size=200',
            movieQuotaLimit: null,
            movieQuotaDays: null,
            tvQuotaLimit: null,
            tvQuotaDays: null,
            createdAt: '2022-08-17T04:55:28.000Z',
            updatedAt: '2022-08-17T04:55:28.000Z',
            requestCount: 1,
            displayName: 'demo@seerr.dev',
          },
          seasonCount: 0,
        },
      ],
    }).as('getRequests');

    cy.visit('/');
    cy.wait('@getRequests');
    cy.contains('.slider-header', 'Recent Requests')
      .next('[data-testid=media-slider]')
      .find('[data-testid=request-card]')
      .first()
      .find('[data-testid=request-card-title]')
      .contains('Movie Not Found');
  });

  it('loads plex watchlist', () => {
    cy.intercept('/api/v1/discover/watchlist', {
      fixture: 'watchlist.json',
    }).as('getWatchlist');
    // Wait for one of the watchlist movies to resolve
    cy.intercept('/api/v1/movie/361743').as('getTmdbMovie');

    cy.visit('/');

    cy.wait('@getWatchlist');

    const sliderHeader = cy.contains('.slider-header', 'Watchlist');

    sliderHeader.scrollIntoView();

    cy.wait('@getTmdbMovie');
    // Wait a little longer to make sure the movie component reloaded
    cy.wait(500);

    sliderHeader
      .next('[data-testid=media-slider]')
      .find('[data-testid=title-card]')
      .first()
      .trigger('mouseover')
      .find('[data-testid=title-card-title]')
      .invoke('text')
      .then((text) => {
        cy.contains('.slider-header', 'Watchlist')
          .next('[data-testid=media-slider]')
          .find('[data-testid=title-card]')
          .first()
          .click();
        cy.get('[data-testid=media-title]').should('contain', text);
      });
  });
});

// Request entry points belong to detail pages; every shared card stays navigable.
describe('TitleCard UX correction', () => {
  const statuses = [1, 7, 2, 3, 4, 5, 6, undefined];
  const cards = ['movie', 'tv'].flatMap((mediaType, typeIndex) =>
    statuses.map((status, index) => ({
      ...(mediaType === 'movie' ? uxMovie : uxTv),
      id: (mediaType === 'movie' ? uxMovie.id : uxTv.id) + index,
      mediaType,
      title: `UX Movie ${index}`,
      name: `UX Series ${index}`,
      // Include posters so hover/touch reveal is exercised, too.
      posterPath: index === 0 ? '/ux-poster.jpg' : undefined,
      mediaInfo:
        status === undefined
          ? undefined
          : {
              ...uxMedia(status),
              downloadStatus:
                typeIndex === 0 && status === 3
                  ? [{ downloadId: 'active' }]
                  : [],
            },
    }))
  );
  const card = (index = 0) => cy.get('[data-testid="title-card"]').eq(index);
  const noQuickRequest = () => {
    cy.get('[data-testid="title-card"]')
      .contains('button', /^Request(?: in 4K)?$/)
      .should('not.exist');
    cy.get('[role="dialog"]').should('not.exist');
    cy.get('@cardTargets.all').should('have.length', 0);
  };

  beforeEach(() => {
    cy.loginAsAdmin();
    cy.viewport(1440, 1000);
    cy.intercept('GET', '/api/v1/auth/me', uxUser);
    cy.intercept('GET', '/api/v1/settings/discover', [
      { id: 1, type: 4, enabled: true, isBuiltIn: true, order: 0 },
    ]);
    cy.intercept('GET', '/api/v1/settings/public', (req) => {
      // A cached 304 has no body to patch; always receive the settings JSON.
      delete req.headers['if-none-match'];
      req.continue((res) => {
        res.body = {
          ...res.body,
          hideAvailable: false,
          hideRequested: false,
          hideBlocklisted: false,
          movie4kEnabled: true,
        };
      });
    }).as('uxSettings');
    cy.intercept('GET', '/api/v1/discover/trending*', {
      page: 1,
      totalPages: 1,
      totalResults: cards.length,
      results: cards,
    }).as('uxCards');
    cy.intercept('GET', '**/request-targets', []).as('cardTargets');
    cy.intercept('GET', '/api/v1/movie/438148', uxMovie).as('uxMovie');
    cy.intercept('GET', '/api/v1/tv/66732', uxTv);
  });

  it('removes Quick Request for every native movie/TV status while preserving metadata, badges and actions', () => {
    cy.visit('/');
    cy.wait('@uxCards');
    cy.get('[data-testid="title-card"]').should('have.length', cards.length);
    cards.forEach((item, index) => {
      card(index).scrollIntoView().trigger('mouseover');
      card(index).find('[data-testid="title-card-title"]').should('be.visible');
      card(index)
        .should('contain', 'Card regression summary')
        .and('contain', '2020');
      card(index)
        .find('button')
        .should(
          'have.length',
          item.mediaInfo?.status === 6 ||
            [2, 3, 4, 5].includes(item.mediaInfo?.status ?? 1)
            ? 1
            : 2
        );
      noQuickRequest();
      card(index).trigger('mouseout');
    });
    // Existing native status badges, plus the active-download spinner.
    card(3)
      .find('[class*="border-indigo-400"] svg animateTransform')
      .should('exist');
    card(5).find('[class*="border-green-400"] svg').should('exist');
    card(6).find('[class*="bg-red-500"] svg').should('exist');
  });

  for (const type of ['movie', 'tv'] as const) {
    it(`keeps desktop ${type} card navigation`, () => {
      cy.visit('/');
      cy.wait('@uxCards');
      const detail = type === 'movie' ? uxMovie : uxTv;
      stubUxNavigation(`/${type}/${detail.id}`, { [type]: detail });
      card(type === 'movie' ? 0 : statuses.length)
        .scrollIntoView()
        .trigger('mouseover');
      noQuickRequest();
      card(type === 'movie' ? 0 : statuses.length)
        .find(`a[href="/${type}/${detail.id}"]`)
        .click();
      cy.location('pathname').should('eq', `/${type}/${detail.id}`);
      cy.get('[data-testid="media-title"]').should(
        'contain',
        type === 'movie' ? 'UX Movie' : 'UX Series'
      );
    });
  }

  it('keeps keyboard access to the detail link', () => {
    cy.visit('/');
    cy.wait('@uxCards');
    stubUxNavigation('/movie/438148', { movie: uxMovie });
    card().find('[role="link"]').focus().trigger('keydown', { key: 'Enter' });
    card().find('a[href="/movie/438148"]').should('be.visible').focus();
    noQuickRequest();
    // Cypress press dispatches a real key, including the link's native activation.
    cy.press('Enter');
    cy.location('pathname').should('eq', '/movie/438148');
  });

  for (const type of ['movie', 'tv'] as const) {
    it(`keeps touch access to ${type} details without a request interaction`, () => {
      cy.viewport('iphone-6');
      cy.visit('/', {
        onBeforeLoad(win) {
          Object.defineProperty(win, 'ontouchstart', {
            value: null,
            configurable: true,
          });
        },
      });
      cy.wait('@uxCards');
      const detail = type === 'movie' ? uxMovie : uxTv;
      stubUxNavigation(`/${type}/${detail.id}`, { [type]: detail });
      const index = type === 'movie' ? 0 : statuses.length;
      card(index).scrollIntoView().find('[role="link"]').click();
      noQuickRequest();
      card(index)
        .find(`a[href="/${type}/${detail.id}"]`)
        .should('be.visible')
        .click();
      cy.location('pathname').should('eq', `/${type}/${detail.id}`);
    });
  }

  it('preserves watchlist updates, loading, blocklisting and unblocking', () => {
    let releaseWatchlist: (() => void) | undefined;
    cy.intercept(
      'POST',
      '/api/v1/watchlist',
      (req) =>
        new Promise<void>((resolve) => {
          releaseWatchlist = () => {
            req.reply({ id: 1 });
            resolve();
          };
        })
    ).as('addWatchlist');
    cy.intercept('DELETE', '/api/v1/watchlist/438148?mediaType=movie', {
      statusCode: 204,
    }).as('removeWatchlist');
    cy.intercept('POST', '/api/v1/blocklist', { statusCode: 201, body: {} }).as(
      'blocklist'
    );
    cy.intercept('DELETE', '/api/v1/blocklist/438148?mediaType=movie', {
      statusCode: 204,
    }).as('unblocklist');
    cy.visit('/');
    cy.wait('@uxCards');
    card().trigger('mouseover').find('button').first().click();
    cy.wrap(null).should(() => expect(releaseWatchlist).to.be.a('function'));
    card().find('.bg-gray-800\\/75 svg').should('be.visible');
    cy.then(() => releaseWatchlist?.());
    cy.wait('@addWatchlist')
      .its('request.body')
      .should('include', { tmdbId: 438148, mediaType: 'movie' });
    cy.contains('added to watchlist').should('be.visible');
    card().find('button').first().click();
    cy.wait('@removeWatchlist');
    cy.contains('Removed from watchlist').should('be.visible');
    card().find('button').last().click();
    cy.contains('[role="dialog"]', 'Blocklist Movie').should('be.visible');
    cy.get('[data-testid="modal-ok-button"]').click();
    cy.wait('@blocklist')
      .its('request.body')
      .should('include', { tmdbId: 438148, mediaType: 'movie' });
    cy.get('[role="dialog"]').should('not.exist');
    card().trigger('mouseover').find('button').should('have.length', 1).click();
    cy.wait('@unblocklist');
    card().find('button').should('have.length', 2);
    noQuickRequest();
  });

  it('keeps watchlist but hides Blocklist without MANAGE_BLOCKLIST', () => {
    cy.intercept('GET', '/api/v1/auth/me', { ...uxUser, permissions: 32 });
    cy.visit('/');
    cy.wait('@uxCards');
    card().trigger('mouseover').find('button').should('have.length', 1);
    noQuickRequest();
  });

  it('keeps collection-card navigation and collection Standard/4K requests while removing movie-card requests', () => {
    cy.clock(Date.now(), ['setTimeout', 'clearTimeout']);
    cy.intercept('GET', '/api/v1/search*', {
      page: 1,
      totalPages: 1,
      totalResults: 1,
      results: [
        {
          id: 10,
          title: uxCollection.name,
          mediaType: 'collection',
          overview: uxCollection.overview,
        },
      ],
    }).as('collectionSearch');
    cy.intercept('GET', '/api/v1/collection/10', uxCollection).as(
      'uxCollection'
    );
    cy.intercept('GET', '/api/v1/service/radarr', []);
    cy.visit('/search?query=UX');
    cy.wait('@collectionSearch');
    stubUxNavigation(
      '/collection/10',
      { collection: uxCollection },
      { movie4kEnabled: true }
    );
    card().trigger('mouseover');
    noQuickRequest();
    card().find('a[href="/collection/10"]').click();
    cy.location('pathname').should('eq', '/collection/10');
    refreshUxSettings();
    cy.contains('button', /^Request Collection$/)
      .should('be.visible')
      .click();
    cy.contains('[role="dialog"]', 'Request Collection').should('be.visible');
    cy.get('[data-testid="modal-cancel-button"]').click();
    cy.get('[role="dialog"]').should('not.exist');
    cy.get('.media-actions button[aria-label="Expand"]').click();
    cy.contains('[role="menuitem"]', 'Request Collection in 4K').click();
    cy.contains('[role="dialog"]', 'Request Collection in 4K').should(
      'be.visible'
    );
    cy.get('[data-testid="modal-cancel-button"]').click();
    cy.get('[role="dialog"]').should('not.exist');
    card().trigger('mouseover');
    noQuickRequest();
    stubUxNavigation('/movie/438148', { movie: uxMovie });
    card().find('a[href="/movie/438148"]').click();
    cy.location('pathname').should('eq', '/movie/438148');
  });
});
