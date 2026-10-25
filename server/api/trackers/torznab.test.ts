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
import type { TorznabContract } from './torznab';
import {
  canonicalizeTorznabGuid as canonicalizeGuid,
  canonicalizeNumericTorznabGuid,
  normalizeTorznabPage,
  parseTorznabCapabilities,
} from './torznab';
import { TR4KER_CONTRACT } from './tr4ker';
import type { TrackerPageContext } from './types';

const key = 'P2_API_KEY_SENTINEL';
// Explicit fixture-only identities for protocol tests. Production TR4KER never
// receives this contract and cannot fall back to its opaque/numeric forms.
const fixtureContract: TorznabContract = {
  fields: TR4KER_CONTRACT.fields,
  attributes: TR4KER_CONTRACT.attributes,
  canonicalizeGuid(value) {
    if (/^[a-z0-9._:-]+$/i.test(value)) return value;
    const tr4kerGuid = TR4KER_CONTRACT.canonicalizeGuid(value);
    if (tr4kerGuid !== null) return tr4kerGuid;
    const url = new URL(value);
    if (
      url.origin !== 'https://tracker.invalid' ||
      !/^(?:\/details\.php|\/torrents\/\d+\/?|\/torrent\/Example-Release-42)$/.test(
        url.pathname
      )
    )
      return null;
    return canonicalizeNumericTorznabGuid(url);
  },
};
const canonicalizeTorznabGuid = (
  value: string | null,
  secrets: readonly string[] = []
) => canonicalizeGuid(value, fixtureContract, secrets);
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
const normalize = (xml: string) =>
  normalizeTorznabPage(xml, context, fixtureContract, [key]);
const normalizeTr4ker = (xml: string) =>
  normalizeTorznabPage(xml, context, TR4KER_CONTRACT, [key]);

describe('Torznab normalization', () => {
  it('preserves nullable P1 fields, categories, raw metadata and provenance deterministically', async () => {
    const page = await normalize(fixture('results'));
    assert.deepEqual(page, await normalize(fixture('results')));
    assert.equal(page.receivedCount, 7);
    assert.equal(page.records.length, 5);
    assert.equal(page.offset, 387200);
    const [movie, tv, unknown, invalid] = page.records;
    assert.equal(movie.trackerId, 'tr4ker');
    assert.equal(
      movie.canonicalGuid,
      'https://tr4ker.net/torrent/Marvel-Secret-Wars-2026-1080p-1a2b3c4d'
    );
    assert.equal(movie.infohash, 'a'.repeat(40));
    assert.equal(movie.releaseName, 'Marvel.Secret-Wars.2026.1080p');
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
      season: 1,
      episode: 4,
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
        .filter((value) => value.code === 'contract_incompatible')
        .map((value) => value.itemIndex),
      [5, 6]
    );
    assert.doesNotMatch(
      JSON.stringify(page),
      /P2_.*SENTINEL|download|enclosure/
    );
    for (const record of page.records)
      assertSafeCanonicalGuid(record.canonicalGuid);
  });

  it('retains season-only tracker claims without inferring coverage', async () => {
    const page = await normalize(fixture('results'));
    const season = page.records[4];
    assert.equal(
      season.canonicalGuid,
      'https://tr4ker.net/torrent/Example-Show-S01-01234567'
    );
    assert.deepEqual(season.trackerMetadata, {
      tmdbId: 123456,
      tvdbId: 456789,
      season: 1,
      episode: null,
    });
    assert.equal(season.seeders, 0);
    assert.equal(season.leechers, 0);
    assert.equal(season.size, 107374182400);
    assert.equal(season.publishedAt, null);
    assert.deepEqual(season.categories, [5000]);
    for (const [field, source] of [
      ['tmdbId', 'tmdbid'],
      ['tvdbId', 'tvdbid'],
      ['season', 'season'],
    ] as const) {
      assert.deepEqual(season.provenance[field], {
        source: 'tracker',
        field: `torznab:attr/${source}`,
      });
    }
    assert.equal(season.provenance.episode, undefined);
    assert.equal('coverage' in season, false);
    assert.equal('mediaAssociation' in season, false);
    assert.ok(!page.anomalies.some((anomaly) => anomaly.itemIndex === 4));
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
  for (const [title, slug] of [
    ['Marvel.Secret-Wars.2026.1080p', 'Marvel-Secret-Wars-2026-1080p-Ab12Cd34'],
    ['Secret_Story.S01E01.2024', 'Secret-Story-S01E01-2024-CaFeBaBe'],
    ['The.Secret-War.2010', 'The-Secret-War-2010'],
    ['Token-Ring.S01E01.1080p', 'Token-Ring-S01E01-1080p'],
    ['Password-Story.2026', 'Password-Story-2026'],
    ['Passkey_Story.S01', 'Passkey-Story-S01'],
    ['APIKey-Story.2026', 'APIKey-Story-2026'],
    ['Secret: Invasion S01E01', 'Secret-Invasion-S01E01'],
    ['The Secret: Dare to Dream', 'The-Secret-Dare-to-Dream'],
    ['Token: The Series', 'Token-The-Series'],
    ['War.S01E04.MULTI.2160p.AMEN', 'war-s01e04-multi-2160p-amen-8bb905c7'],
    [
      'Secret.Token.Password.Passkey.APIKey',
      'Secret-Token-Password-Passkey-APIKey',
    ],
  ]) {
    it(`preserves the legitimate release title and full slug: ${title}`, async () => {
      const guid = `https://tr4ker.net/torrent/${slug}`;
      const hash = 'b'.repeat(40);
      const page = await normalizeTr4ker(
        rss(item(guid, attr('infohash', hash))).replace(
          '<title>Example.Release</title>',
          `<title>${title}</title>`
        )
      );
      assert.equal(canonicalizeTorznabGuid(guid), guid);
      assertSafeCanonicalGuid(guid);
      assert.equal(page.records.length, 1);
      assert.equal(page.records[0].canonicalGuid, guid);
      assert.equal(page.records[0].releaseName, title);
      assert.equal(page.records[0].infohash, hash);
      assert.deepEqual(page.anomalies, []);
    });
  }

  it('keeps complete distinct slugs when hashes match', async () => {
    const first = 'https://tr4ker.net/torrent/Example-Release-AbCdEf12';
    const second = 'https://tr4ker.net/torrent/Example-Release-AbCdEf13';
    const hash = 'a'.repeat(40);
    const page = await normalize(
      rss(
        item(first, attr('infohash', hash)) +
          item(second, attr('infohash', hash))
      )
    );
    assert.deepEqual(
      page.records.map((record) => record.canonicalGuid),
      [first, second]
    );
    assert.deepEqual(page.anomalies, []);
    for (const record of page.records)
      assertSafeCanonicalGuid(record.canonicalGuid);
  });

  it('canonicalizes equivalent numeric aliases regardless of case, duplication or ordering', () => {
    for (const query of [
      'id=42',
      'id=42&ID=42',
      'TORRENTID=42',
      'Torrent_Id=42',
      'ID=42&torrentid=42&TORRENT_ID=42',
      'torrent_id=042&ID=42',
      'TORRENT_ID=42&torrentid=42&ID=42',
    ]) {
      const canonical = canonicalizeTorznabGuid(
        `https://tracker.invalid/details.php?${query}`
      );
      assert.equal(canonical, 'https://tracker.invalid/details.php?id=42');
      assertSafeCanonicalGuid(canonical!);
    }
    const numericPath = canonicalizeTorznabGuid(
      'https://tracker.invalid/torrents/42?ID=42&Torrent_Id=42'
    );
    assert.equal(numericPath, 'https://tracker.invalid/torrents/42?id=42');
    assertSafeCanonicalGuid(numericPath!);
    // Legacy generic numeric queries do not establish equivalence to slugs.
    const slug = 'https://tracker.invalid/torrent/Example-Release-42';
    assert.equal(canonicalizeTorznabGuid(`${slug}?ID=43`), `${slug}?id=43`);
    assert.notEqual(
      canonicalizeTorznabGuid(`${slug}?id=43`),
      canonicalizeTorznabGuid(slug)
    );
    assert.equal(
      canonicalizeTorznabGuid(
        'https://tracker.invalid/details.php?ID=9007199254740993'
      ),
      'https://tracker.invalid/details.php?id=9007199254740993'
    );
  });

  for (const guid of [
    'https://tracker.invalid/details.php?id=42&ID=43',
    'https://tracker.invalid/details.php?id=42&torrentid=43',
    'https://tracker.invalid/details.php?TORRENT_ID=42&TorrentId=43',
    'https://tracker.invalid/torrents/42?id=43',
    'https://tracker.invalid/torrents/42?TORRENT_ID=43',
    'https://tracker.invalid/torrents/42/?TorrentId=43',
  ]) {
    it(`rejects contradictory logical torrent identifiers: ${guid}`, () => {
      assert.equal(canonicalizeTorznabGuid(guid), null);
    });
  }

  it('rejects unexpected TR4KER URL components with safe identity anomalies', async () => {
    for (const guid of [
      'https://other.invalid/torrent/Example-Release',
      'http://tr4ker.net/torrent/Example-Release',
      'https://www.tr4ker.net/torrent/Example-Release',
      'https://tr4ker.net.other.invalid/torrent/Example-Release',
      'https://tr4ker.net:444/torrent/Example-Release',
      'https://other.invalid/torrents/42',
      'https://tracker.invalid/torrents/42',
      'https://tr4ker.net/torrents/42',
      'https://tr4ker.net/details.php?id=42',
      'torrent-1',
      `https://user:${key}@tr4ker.net/torrent/Example-Release`,
      `https://tr4ker.net/torrent/Example-Release?apikey=${key}`,
      `https://tr4ker.net/torrent/Example-Release?token=${key}`,
      'https://tr4ker.net/torrent/Example-Release?id=42',
      'https://tr4ker.net/torrent/Example-Release?',
      `https://tr4ker.net/torrent/Example-Release#${key}`,
      'https://tr4ker.net/torrent/Example-Release#',
      'https://tr4ker.net/torrent/',
      'https://tr4ker.net/torrents/Example-Release',
      'https://tr4ker.net/torrent/Example-Release/extra',
      'https://tr4ker.net/torrent/Example-Release/',
      'https://tr4ker.net/torrent/Example_Release',
      'https://tr4ker.net/torrent/Example.Release',
      'https://tr4ker.net/torrent/-Example-Release',
      'https://tr4ker.net/torrent/Example--Release',
      'https://tr4ker.net/torrent/Example-Release-',
      'https://tr4ker.net/torrent/Example-%52elease',
      'https://tr4ker.net/torrent/Example-%ZZRelease',
      'https://tr4ker.net/torrent/Example-Release\n',
      'https://tr4ker.net/torrent/Example-\tRelease',
      'https://tr4ker.net\\torrent\\Example-Release',
      'https://tr4ker.net/other/../torrent/Example-Release',
      `https://tr4ker.net/torrent/Example-${key.replaceAll('_', '-')}-Release`,
    ]) {
      assert.equal(
        canonicalizeGuid(guid, TR4KER_CONTRACT, [
          key,
          key.replaceAll('_', '-'),
        ]),
        null
      );
      const page = await normalizeTorznabPage(
        rss(item(guid.replaceAll('&', '&amp;'))),
        context,
        TR4KER_CONTRACT,
        [key, key.replaceAll('_', '-')]
      );
      assert.deepEqual(page.records, []);
      assert.deepEqual(page.anomalies, [
        { itemIndex: 0, code: 'contract_incompatible', field: 'canonicalGuid' },
      ]);
      assert.ok(!JSON.stringify(page).includes(key));
      assert.ok(!JSON.stringify(page).includes(guid));
    }
  });

  it('applies the source-provided identity and projection contract in the shared engine', async () => {
    const guid = 'https://fixture.invalid/release/42';
    const contract: TorznabContract = {
      fields: ['guid', 'title'],
      attributes: ['seeders'],
      canonicalizeGuid: (value) => (value === guid ? value : null),
    };
    const xml = rss(
      item(
        guid,
        attr('seeders', '0') +
          attr('tmdbid', '1234') +
          '<pubDate>excluded-invalid-date</pubDate><size>excluded-invalid-size</size>' +
          `<link>https://fixture.invalid/download?apikey=${key}</link>`
      )
    );
    const page = await normalizeTorznabPage(xml, context, contract, [key]);
    assert.equal(page.records[0].canonicalGuid, guid);
    assertSafeCanonicalGuid(page.records[0].canonicalGuid);
    assert.equal(page.records[0].seeders, 0);
    assert.equal(page.records[0].trackerMetadata.tmdbId, null);
    assert.equal(page.records[0].provenance.tmdbId, undefined);
    assert.equal(page.contractStatus, 'compatible');
    assert.deepEqual(page.anomalies, []);
    assert.ok(!JSON.stringify(page).includes(key));
    const tr4ker = await normalizeTr4ker(xml);
    assert.deepEqual(tr4ker.records, []);
    assert.equal(tr4ker.contractStatus, 'incompatible');
    assert.deepEqual(tr4ker.anomalies, [
      { itemIndex: 0, code: 'contract_incompatible', field: 'canonicalGuid' },
    ]);
  });

  it('distinguishes partial, incompatible and genuinely empty pages without collection decisions', async () => {
    const good = item(
      'https://tr4ker.net/torrent/Good-Release',
      attr('seeders', '0')
    );
    const badGuid = `https://tracker.invalid/passkey/${key}/42`;
    const bad = item(badGuid).replace('Example.Release', 'REJECTED_TITLE');
    for (const [xml, status, received, valid, rejected] of [
      [rss(good + bad), 'partial', 2, 1, [1]],
      [rss(good + bad + bad), 'partial', 3, 1, [1, 2]],
      [rss(bad + bad), 'incompatible', 2, 0, [0, 1]],
      [fixture('empty'), 'compatible', 0, 0, []],
    ] as const) {
      const page = await normalizeTr4ker(xml);
      assert.equal(page.contractStatus, status);
      assert.equal(page.receivedCount, received);
      assert.equal(page.records.length, valid);
      assert.deepEqual(
        page.anomalies,
        rejected.map((itemIndex) => ({
          itemIndex,
          code: 'contract_incompatible',
          field: 'canonicalGuid',
        }))
      );
      assert.equal(page.trackerId, context.trackerId);
      assert.equal(page.category, context.category);
      assert.equal(page.offset, context.offset);
      assert.deepEqual(page.observedAt, context.observedAt);
      const diagnostics = JSON.stringify({
        anomalies: page.anomalies,
        contractStatus: page.contractStatus,
      });
      assert.doesNotMatch(diagnostics, /SENTINEL|REJECTED_TITLE|https|<rss/);
      for (const field of ['checkpoint', 'complete', 'suspended', 'coverage'])
        assert.equal(field in page, false);
    }
  });

  it('treats unusable required titles as critical but missing optional fields as unknown', async () => {
    const guid = 'https://tr4ker.net/torrent/Valid-Release';
    const invalid = `<item><guid>${guid}</guid><title>Release.${key}</title></item>`;
    const page = await normalizeTr4ker(
      rss(
        item(guid, attr('seeders', '-1')) +
          invalid +
          `<item><guid>${guid}</guid></item>`
      )
    );
    assert.equal(page.records.length, 1);
    assert.equal(page.records[0].seeders, null);
    assert.equal(page.records[0].leechers, null);
    assert.equal(page.contractStatus, 'partial');
    assert.deepEqual(page.anomalies, [
      { itemIndex: 0, code: 'invalid_field', field: 'seeders' },
      { itemIndex: 1, code: 'contract_incompatible', field: 'releaseName' },
      { itemIndex: 2, code: 'contract_incompatible', field: 'releaseName' },
    ]);
    const optionalOnly = await normalizeTr4ker(
      rss(item(guid, attr('seeders', '-1')))
    );
    assert.equal(optionalOnly.contractStatus, 'compatible');
    assert.ok(!JSON.stringify(page).includes(key));
  });

  it('rejects credential assignments and encoded secrets without returning sensitive diagnostics', async () => {
    for (const name of ['apikey', 'passkey', 'token', 'password', 'secret']) {
      const assignment = `${name}=${key}`;
      for (const text of [
        assignment,
        encodeURIComponent(assignment),
        encodeURIComponent(encodeURIComponent(assignment)),
      ]) {
        const page = await normalize(
          rss(`<item><guid>safe-id</guid><title>Release.${text}</title></item>`)
        );
        assert.deepEqual(page.records, []);
        assert.deepEqual(page.anomalies, [
          { itemIndex: 0, code: 'contract_incompatible', field: 'releaseName' },
        ]);
        assert.ok(!JSON.stringify(page).includes(key));
        assert.equal(canonicalizeTorznabGuid(text, [key]), null);
        assert.throws(
          () => assertSafeCanonicalGuid(text),
          (error: Error) => error.message === 'Unsafe catalogue GUID'
        );
      }
    }
    for (const guid of [
      `https://tr4ker.net/torrent/Example-${key}-Release`,
      `https://tr4ker.net/torrent/Example-${encodeURIComponent(key).replace('P', '%50')}-Release`,
      `https://tr4ker.net/passkey_${key}/42`,
    ]) {
      const page = await normalize(rss(item(guid)));
      assert.deepEqual(page.records, []);
      assert.deepEqual(page.anomalies, [
        { itemIndex: 0, code: 'contract_incompatible', field: 'canonicalGuid' },
      ]);
      assert.ok(!JSON.stringify(page).includes(key));
    }
  });

  it('retains safe generic identities and rejects their unsafe URL components', () => {
    const canonical = 'https://tracker.invalid/details.php?id=42';
    assert.equal(canonicalizeTorznabGuid(canonical), canonical);
    assert.notEqual(
      canonicalizeTorznabGuid('https://tracker.invalid/torrents/42'),
      canonicalizeTorznabGuid('https://tracker.invalid/torrents/43')
    );
    assert.equal(
      canonicalizeTorznabGuid('urn:uuid:1234-5678'),
      'urn:uuid:1234-5678'
    );
    for (const guid of [
      'https://tracker.invalid/torrents/42?apikey=UNKNOWN',
      'https://user:UNKNOWN@tracker.invalid/torrents/42',
      'https://tracker.invalid/torrents/42#UNKNOWN',
      'https://tracker.invalid/torrents/42?unknown=1',
    ])
      assert.equal(canonicalizeTorznabGuid(guid), null);
  });

  it('does not replace a missing or invalid GUID with other tracker fields', async () => {
    const fields = `<comments>https://tr4ker.net/torrent/Example-Release</comments><link>https://tr4ker.net/download?apikey=${key}</link><enclosure url="https://tr4ker.net/download?apikey=${key}"/>${attr('infohash', 'a'.repeat(40))}`;
    for (const guid of ['', '<guid>invalid/guid</guid>']) {
      const page = await normalize(
        rss(`<item>${guid}<title>Example.Release</title>${fields}</item>`)
      );
      assert.deepEqual(page.records, []);
      assert.deepEqual(page.anomalies, [
        { itemIndex: 0, code: 'contract_incompatible', field: 'canonicalGuid' },
      ]);
      assert.ok(!JSON.stringify(page).includes(key));
    }
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
      fixtureContract,
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
        `<item><guid>a</guid><title>Release.${key}</title></item><item><guid>b</guid><title>Release?passkey=${key}</title></item>`
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
      fixtureContract,
      [key]
    );
    assert.ok(!JSON.stringify(result).includes(key));
    assert.equal('apiKey' in result, false);
    assert.equal('authenticatedUrl' in result, false);
    await assert.rejects(
      normalizeTorznabPage(
        fixture('empty'),
        { ...context, trackerId: key },
        fixtureContract,
        [key]
      ),
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
