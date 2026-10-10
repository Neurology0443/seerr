// Minimal API fixtures for the shared-card and management visibility correction.
export const uxUser = {
  id: 1,
  displayName: 'Admin',
  email: 'admin@seerr.dev',
  avatar: '/user-icon-192x192.png',
  permissions: 2,
  warnings: [],
  userType: 2,
};

export const uxMedia = (status = 1) => ({
  id: 100,
  tmdbId: 438148,
  mediaType: 'movie',
  status,
  status4k: 1,
  jellyfinMediaId: null,
  jellyfinMediaId4k: null,
  requests: [],
  seasons: [],
  issues: [],
  watchlists: [],
  downloadStatus: [],
  downloadStatus4k: [],
});

const common = {
  id: 438148,
  overview: 'Card regression summary',
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
};

export const uxMovie = {
  ...common,
  title: 'UX Movie',
  originalTitle: 'UX Movie',
  releaseDate: '2020-01-01',
  releases: { results: [] },
  status: 'Released',
};

export const uxTv = {
  ...common,
  id: 66732,
  name: 'UX Series',
  originalName: 'UX Series',
  firstAirDate: '2020-01-01',
  contentRatings: { results: [] },
  networks: [],
  createdBy: [],
  episodeRunTime: [],
  languages: [],
  originCountry: [],
  numberOfSeasons: 0,
  seasons: [],
};

export const uxCollection = {
  id: 10,
  name: 'UX Collection',
  overview: 'Collection regression summary',
  parts: [
    { ...uxMovie, mediaType: 'movie', genreIds: [], mediaInfo: uxMedia() },
  ],
};

// Follow the existing collection navigation pattern to stub SSR page data
// during real client-side Link navigation, without depending on live TMDB.
export const stubUxNavigation = (
  path: string,
  pageProps: Record<string, unknown>,
  settings: Record<string, unknown> = {}
) => {
  let appProps: Record<string, unknown>;
  cy.window().then((win) => {
    appProps = (
      win as unknown as {
        __NEXT_DATA__: { props: Record<string, unknown> };
      }
    ).__NEXT_DATA__.props;
  });
  cy.intercept('GET', `**/_next/data/**${path}.json*`, (req) =>
    req.reply({
      ...appProps,
      currentSettings: {
        ...(appProps.currentSettings as Record<string, unknown>),
        ...settings,
      },
      pageProps,
      __N_SSP: true,
    })
  );
};

// As in request-destinations.cy.ts, expire SWR's deduplication timer and
// reconnect to replace settings cached from the initial server-rendered page.
// Install cy.clock before visiting the page that will populate that cache.
export const refreshUxSettings = () => {
  cy.tick(2000);
  cy.window().then((win) => {
    win.dispatchEvent(new win.Event('offline'));
    win.dispatchEvent(new win.Event('online'));
  });
  cy.tick(0);
  cy.clock().then((clock) => clock.restore());
  cy.wait('@uxSettings');
};
