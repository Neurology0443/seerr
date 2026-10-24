import { createCatalogueDataSource } from '@server/lib/catalogue/datasource';
import { catalogueEntityNames } from '@server/lib/catalogue/entities';
import {
  CatalogueIdentityConflictError,
  CatalogueRepository,
  assertSafeCanonicalGuid,
  upsertObservedTorrents,
} from '@server/lib/catalogue/repository';
import type { CatalogueTorrent } from '@server/lib/catalogue/types';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { TrackerAdapterError } from './errors';
import {
  canonicalizeTorznabGuid,
  normalizeTorznabPage,
  parseTorznabCapabilities,
} from './torznab';
import type { TrackerPageContext } from './types';

const key = 'P2_API_KEY_SENTINEL';
const fixture = (name: string) =>
  readFileSync(path.join(__dirname, '__fixtures__', name + '.xml'), 'utf8');
const context: TrackerPageContext = {
  trackerId: 'tr4ker',
  category: 'movie',
  limit: 100,
  offset: 387200,
  observedAt: new Date('2026-10-24T12:00:00Z'),
};
const attr = (name: string, value: string) =>
  `<torznab:attr name="${name}" value="${value}"/>`;
const item = (guid: string, fields = '') =>
  `<item><guid>${guid}</guid><title>Example.Release</title>${fields}</item>`;
const rss = (items: string) =>
  `<rss xmlns:torznab="http://torznab.com/schemas/2015/feed"><channel>${items}</channel></rss>`;
const normalize = (xml: string) => normalizeTorznabPage(xml, context, [key]);

describe('Torznab normalization', () => {
  it('preserves nullable P1 fields, categories, raw metadata and provenance deterministically', async () => {
    const page = await normalize(fixture('results'));
    assert.deepEqual(page, await normalize(fixture('results')));
    assert.equal(page.receivedCount, 6);
    assert.equal(page.records.length, 4);
    assert.equal(page.offset, 387200);
    const [movie, tv, unknown, invalid] = page.records;
    assert.equal(movie.trackerId, 'tr4ker');
    assert.equal(movie.canonicalGuid, 'https://tr4ker.net/torrents/101');
    assert.equal(movie.infohash, 'a'.repeat(40));
    assert.equal(movie.releaseName, 'Example.Movie.2026.1080p');
    assert.deepEqual(movie.categories, [2000, 2040]);
    assert.equal(movie.seeders, 0);
    assert.equal(movie.leechers, 2);
    assert.equal(movie.size, 4294967296);
    assert.equal(movie.publishedAt?.toISOString(), '2026-10-24T08:30:00.000Z');
    assert.deepEqual(movie.observedAt, context.observedAt);
    assert.deepEqual(movie.trackerMetadata, {
      tmdbId: 12345,
      tvdbId: null,
      season: null,
      episode: null,
    });
    assert.deepEqual(movie.provenance.seeders, {
      source: 'tracker',
      field: 'torznab:attr/seeders',
    });
    assert.deepEqual(movie.provenance.canonicalGuid, {
      source: 'tracker',
      field: 'guid',
    });
    assert.deepEqual(movie.provenance.observedAt, {
      source: 'application',
      field: 'successful_page_retrieval',
    });
    assert.equal(tv.publishedAt?.toISOString(), '2026-10-24T08:31:00.000Z');
    assert.deepEqual(tv.trackerMetadata, {
      tmdbId: null,
      tvdbId: 45678,
      season: 2,
      episode: 3,
    });
    for (const record of [unknown, invalid]) {
      for (const field of [
        'seeders',
        'leechers',
        'size',
        'infohash',
        'publishedAt',
      ] as const)
        assert.equal(record[field], null);
      assert.deepEqual(record.trackerMetadata, {
        tmdbId: null,
        tvdbId: null,
        season: null,
        episode: null,
      });
      assert.deepEqual(record.categories, []);
    }
    assert.equal(unknown.provenance.seeders, undefined);
    assert.equal(unknown.provenance.season, undefined);
    assert.deepEqual(
      page.anomalies
        .filter((value) => value.itemIndex === 3)
        .map((value) => value.field)
        .sort(),
      [
        'categories',
        'episode',
        'infohash',
        'leechers',
        'publishedAt',
        'season',
        'seeders',
        'size',
        'tmdbId',
        'tvdbId',
      ].sort()
    );
    assert.deepEqual(
      page.anomalies
        .filter((value) => value.code === 'invalid_identity')
        .map((value) => value.itemIndex),
      [4, 5]
    );
    assert.doesNotMatch(
      JSON.stringify(page),
      /P2_.*SENTINEL|download|enclosure/
    );
    for (const record of page.records)
      assertSafeCanonicalGuid(record.canonicalGuid);
  });

  it('recognizes namespace aliases and default namespaces without conflating other namespaces', async () => {
    const fields =
      '<x:attr xmlns:x="http://torznab.com/schemas/2015/feed" name="seeders" value="0"/><attr xmlns="http://torznab.com/schemas/2015/feed" name="category" value="5000"/><fake:attr xmlns:fake="https://invalid.example" name="seeders" value="999"/>';
    const page = await normalize(rss(item('torrent-1', fields)));
    assert.equal(page.records[0].seeders, 0);
    assert.deepEqual(page.records[0].categories, [5000]);
  });

  it('reports conflicting repeated attributes and validates equivalent RSS size', async () => {
    const page = await normalize(
      rss(
        item(
          'a',
          attr('seeders', '1') + attr('seeders', '2') + '<size>12</size>'
        ) + item('b', attr('size', '-1') + '<size>13</size>')
      )
    );
    assert.equal(page.records[0].seeders, null);
    assert.equal(page.records[0].size, 12);
    assert.deepEqual(page.records[0].provenance.size, {
      source: 'tracker',
      field: 'size',
    });
    assert.equal(page.records[1].size, null);
    assert.ok(
      page.anomalies.some(
        (value) =>
          value.code === 'conflicting_field' && value.field === 'seeders'
      )
    );
  });

  for (const value of [
    '',
    '-1',
    '1.2',
    '1e3',
    'NaN',
    'Infinity',
    '2147483648',
    '9007199254740992',
  ]) {
    it(`keeps invalid integer ${JSON.stringify(value)} unknown`, async () => {
      const page = await normalize(rss(item('a', attr('seeders', value))));
      assert.equal(page.records[0].seeders, null);
      assert.deepEqual(page.anomalies, [
        { itemIndex: 0, code: 'invalid_field', field: 'seeders' },
      ]);
    });
  }

  it('accepts empty RSS without interpreting total or inferring completion', async () => {
    const page = await normalize(fixture('empty'));
    assert.deepEqual(page.records, []);
    assert.deepEqual(page.anomalies, []);
    assert.equal(page.receivedCount, 0);
    assert.equal('total' in page, false);
    assert.equal('complete' in page, false);
  });

  it('parses RFC publication zones consistently and rejects invalid calendar fields', async () => {
    const dates = [
      'Fri, 21 Nov 1997 09:55:06 -0600',
      '21 Nov 1997 15:55:06 GMT',
      '21 Nov 1997 10:55:06 EST',
    ];
    for (const date of dates) {
      const result = await normalize(
        rss(item('a', `<pubDate>${date}</pubDate>`))
      );
      assert.equal(
        result.records[0].publishedAt?.toISOString(),
        '1997-11-21T15:55:06.000Z'
      );
    }
    for (const date of [
      '2026-10-24',
      '31 Feb 2026 08:00:00 +0000',
      '24 Oct 2026 25:00:00 +0000',
      '24 Oct 2026 08:00:00 +2460',
      '24 Oct 0000 08:00:00 +0000',
    ]) {
      const result = await normalize(
        rss(item('a', `<pubDate>${date}</pubDate>`))
      );
      assert.equal(result.records[0].publishedAt, null);
      assert.equal(result.anomalies[0].field, 'publishedAt');
    }
  });

  for (const xml of [
    '<rss><channel>',
    rss('') + 'broken',
    rss('') + '<another/>',
    '<rss><channel></rss>',
    '<!DOCTYPE rss [<!ENTITY secret SYSTEM "file:///etc/passwd">]><rss><channel/></rss>',
  ]) {
    it('rejects malformed XML including trailing data and entity declarations', async () => {
      await assert.rejects(
        normalize(xml),
        (error) =>
          error instanceof TrackerAdapterError && error.code === 'invalid_xml'
      );
    });
  }

  for (const xml of [
    '',
    '<html><body>Unavailable</body></html>',
    '<rss/>',
    '<rss><channel/><channel/></rss>',
    '<rss><channel>Bad data</channel></rss>',
    '<rss><channel><html/></channel></rss>',
    '<rss><channel><item xmlns="https://invalid.example"/></channel></rss>',
    '<other><channel/></other>',
  ]) {
    it('rejects invalid page envelopes instead of returning an empty page', async () => {
      await assert.rejects(
        normalize(xml),
        (error) =>
          error instanceof TrackerAdapterError &&
          ['invalid_xml', 'invalid_response'].includes(error.code)
      );
    });
  }

  it('rejects API errors without exposing their upstream description', async () => {
    await assert.rejects(
      normalize(`<error code="100" description="${key}"/>`),
      (error) => {
        assert.ok(error instanceof TrackerAdapterError);
        assert.equal(error.code, 'torznab_error');
        assert.equal(error.apiCode, 100);
        assert.equal(error.retryable, false);
        assert.doesNotMatch(JSON.stringify(error), new RegExp(key));
        return true;
      }
    );
  });
});

describe('Torznab identity and security', () => {
  it('removes only credential URL components while retaining stable identity components', () => {
    const canonical = 'https://tr4ker.net/details.php?id=42&torrentid=43';
    const guid = `https://user:${key}@tr4ker.net/details.php?torrentid=43&apikey=${key}&id=42&passkey=OTHER_SECRET&token=TOKEN#FRAGMENT`;
    assert.equal(canonicalizeTorznabGuid(guid, [key]), canonical);
    assert.equal(canonicalizeTorznabGuid(canonical), canonical);
    assert.notEqual(
      canonicalizeTorznabGuid('https://tr4ker.net/torrents/42'),
      canonicalizeTorznabGuid('https://tr4ker.net/torrents/43')
    );
    assert.equal(
      canonicalizeTorznabGuid('urn:uuid:1234-5678'),
      'urn:uuid:1234-5678'
    );
  });

  for (const guid of [
    null,
    '',
    'https://tr4ker.net/?apikey=KEY',
    'https://tr4ker.net/torrents/42?variant=2',
    'https://tr4ker.net/torrents/42?id=1&id=2',
    'https://tr4ker.net/passkey/KEY/42',
    'https://tr4ker.net/torrents/%34%32',
    'ftp://tr4ker.net/42',
    'missing identity',
    key,
    `https://tr4ker.net/${key}/42`,
    'https://tr4ker.net/torrents/\n42',
  ]) {
    it('rejects ambiguous or sensitive GUIDs without inventing an identity', () => {
      assert.equal(canonicalizeTorznabGuid(guid, [key]), null);
    });
  }

  it('isolates every record in a GUID/hash conflict, including unknown hashes', async () => {
    const page = await normalize(
      rss(
        item('same', attr('infohash', 'a'.repeat(40))) +
          item('same', attr('infohash', 'b'.repeat(40))) +
          item('same') +
          item('distinct', attr('infohash', 'a'.repeat(40)))
      )
    );
    assert.deepEqual(
      page.records.map((record) => record.canonicalGuid),
      ['distinct']
    );
    assert.deepEqual(
      page.anomalies.map((value) => value.code),
      ['identity_conflict', 'identity_conflict', 'identity_conflict']
    );
    assert.deepEqual(
      page.anomalies.map((value) => value.itemIndex),
      [0, 1, 2]
    );
  });

  it('keeps same hashes with distinct GUIDs and compatible repeated identities', async () => {
    const fields = attr('infohash', 'a'.repeat(40));
    const page = await normalize(
      rss(item('a', fields) + item('b', fields) + item('a', fields))
    );
    assert.deepEqual(
      page.records.map((record) => record.canonicalGuid),
      ['a', 'b', 'a']
    );
    assert.deepEqual(page.anomalies, []);
  });

  it('isolates contradictions inside one item and in items rejected for other fields', async () => {
    const a = attr('infohash', 'a'.repeat(40));
    const b = attr('infohash', 'b'.repeat(40));
    for (const xml of [
      rss(item('same', a) + item('same', a + b)),
      rss(item('same', a) + `<item><guid>same</guid>${b}</item>`),
      rss(item('same', a) + item('same', b + attr('infohash', 'invalid'))),
    ]) {
      const page = await normalize(xml);
      assert.deepEqual(page.records, []);
      assert.deepEqual(
        page.anomalies
          .filter((anomaly) => anomaly.code === 'identity_conflict')
          .map((anomaly) => anomaly.itemIndex),
        [0, 1]
      );
    }
  });

  it('rejects valid-looking infohashes that echo the configured credential', async () => {
    const secret = 'a'.repeat(40);
    const page = await normalizeTorznabPage(
      rss(item('torrent-1', attr('infohash', secret.toUpperCase()))),
      context,
      [secret]
    );
    assert.equal(page.records[0].infohash, null);
    assert.deepEqual(page.anomalies, [
      { itemIndex: 0, code: 'invalid_field', field: 'infohash' },
    ]);
    assert.ok(!JSON.stringify(page).includes(secret));
  });

  it('does not persist credentials echoed in arbitrary release text', async () => {
    const page = await normalize(
      rss(
        `<item><guid>a</guid><title>Release.${key}</title></item><item><guid>b</guid><title>Release?passkey=OTHER_SECRET</title></item>`
      )
    );
    assert.deepEqual(page.records, []);
    assert.equal(page.anomalies.length, 2);
    assert.doesNotMatch(JSON.stringify(page), /SENTINEL|OTHER_SECRET/);
  });

  it('preserves literal percent signs while rejecting encoded credentials in text', async () => {
    const encoded = [...key]
      .map((character) => '%' + character.charCodeAt(0).toString(16))
      .join('');
    const result = await normalize(
      rss(
        `<item><guid>a</guid><title>100% Wolf</title></item><item><guid>b</guid><title>${encoded}</title></item>`
      )
    );
    assert.equal(result.records[0].releaseName, '100% Wolf');
    assert.equal(result.records.length, 1);
    assert.equal(result.anomalies[0].itemIndex, 1);
  });

  it('returns only declared page context fields and rejects sensitive tracker identities', async () => {
    const suppliedContext = {
      ...context,
      apiKey: key,
      authenticatedUrl: `https://tr4ker.net?apikey=${key}`,
    };
    const result = await normalizeTorznabPage(
      fixture('empty'),
      suppliedContext,
      [key]
    );
    assert.ok(!JSON.stringify(result).includes(key));
    assert.equal('apiKey' in result, false);
    assert.equal('authenticatedUrl' in result, false);
    await assert.rejects(
      normalizeTorznabPage(fixture('empty'), { ...context, trackerId: key }, [
        key,
      ]),
      TrackerAdapterError
    );
    await assert.rejects(
      parseTorznabCapabilities(fixture('caps'), key, [key]),
      TrackerAdapterError
    );
  });

  it('feeds the existing P1 repository and preserves its cross-page conflict boundary', async () => {
    const database = createCatalogueDataSource({
      type: 'sqlite',
      database: ':memory:',
    });
    try {
      await database.initialize();
      await database.runMigrations();
      await new CatalogueRepository(database).saveTracker({
        id: 'tr4ker',
        name: 'TR4KER',
        connectorType: 'torznab',
        enabled: true,
      });
      const page = await normalize(fixture('results'));
      await database.transaction((manager) =>
        upsertObservedTorrents(manager, page.records)
      );
      const torrents = database.getRepository<CatalogueTorrent>(
        catalogueEntityNames.torrent
      );
      const stored = await torrents.findOneByOrFail({
        canonicalGuid: page.records[0].canonicalGuid,
      });
      assert.equal(stored.seeders, 0);
      assert.deepEqual(stored.seedersObservedAt, context.observedAt);
      assert.deepEqual(stored.firstSeenAt, context.observedAt);
      assert.deepEqual(stored.lastSeenAt, context.observedAt);
      assert.equal(
        await database.getRepository(catalogueEntityNames.media).count(),
        0
      );
      await assert.rejects(
        database.transaction((manager) =>
          upsertObservedTorrents(manager, [
            { ...page.records[0], infohash: 'c'.repeat(40) },
          ])
        ),
        CatalogueIdentityConflictError
      );
      assert.equal(
        (await torrents.findOneByOrFail({ id: stored.id })).infohash,
        'a'.repeat(40)
      );
      assert.doesNotMatch(
        JSON.stringify(await torrents.find()),
        /SENTINEL|download/
      );
    } finally {
      if (database.isInitialized) await database.destroy();
    }
  });
});

describe('Torznab capabilities', () => {
  it('exposes advertised limits, hierarchy and operations without claiming validation', async () => {
    const caps = await parseTorznabCapabilities(fixture('caps'), 'tr4ker');
    assert.deepEqual(caps.advertised.limits, { default: 50, max: 100 });
    assert.deepEqual(caps.advertised.categories, [
      { id: 2000, name: 'Movies', parentId: null },
      { id: 2040, name: 'Movies/HD', parentId: 2000 },
      { id: 5000, name: 'TV', parentId: null },
      { id: 5070, name: 'TV/Anime', parentId: 5000 },
    ]);
    assert.ok(
      caps.advertised.operations
        .find((operation) => operation.name === 'movie-search')
        ?.parameters.includes('tmdbid')
    );
    assert.equal(
      caps.advertised.operations.find(
        (operation) => operation.name === 'book-search'
      )?.available,
      false
    );
    await assert.rejects(
      parseTorznabCapabilities('<caps/>', 'tr4ker'),
      TrackerAdapterError
    );
  });

  it('does not expose credentials echoed in capability labels or parameters', async () => {
    const xml = fixture('caps')
      .replace('name="Movies"', `name="${key}"`)
      .replace('q,cat,limit,offset,apikey', `q,cat,${key},limit,offset,apikey`);
    const caps = await parseTorznabCapabilities(xml, 'tr4ker', [key]);
    assert.equal(caps.advertised.categories[0].name, null);
    assert.ok(!JSON.stringify(caps).includes(key));
  });
});
