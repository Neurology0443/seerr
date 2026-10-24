import { assertSafeCanonicalGuid } from '@server/lib/catalogue/repository';
import xml2js from 'xml2js';
import { TrackerAdapterError } from './errors';
import type {
  NormalizedTrackerPage,
  NormalizedTrackerTorrent,
  TorrentField,
  TrackerAnomaly,
  TrackerCapabilities,
  TrackerPageContext,
} from './types';

const TORZNAB_NAMESPACE = 'http://torznab.com/schemas/2015/feed';
const MAX_INTEGER = 2147483647;
export const MAX_XML_BYTES = 8 * 1024 * 1024;
const secretMarker =
  /(?:^|[^a-z0-9])(?:passkey|api[_-]?key|auth(?:orization)?|token|password|secret)\s*[=:/]/i;
const credentialPath =
  /\/(?:passkey|api[_-]?key|auth(?:orization)?|token|password|secret)[_-][^/]*\//i;

interface XmlNode {
  $ns: { local: string; uri: string };
  $?: Record<string, { value: string; uri: string; local: string }>;
  _?: string;
  [key: string]: unknown;
}

function isNode(value: unknown): value is XmlNode {
  return typeof value === 'object' && value !== null && '$ns' in value;
}

function children(node: XmlNode, local: string, uri = ''): XmlNode[] {
  return Object.values(node)
    .filter(Array.isArray)
    .flat()
    .filter(
      (child): child is XmlNode =>
        isNode(child) && child.$ns.local === local && child.$ns.uri === uri
    );
}

function attribute(node: XmlNode, name: string): string | null {
  const values = Object.values(node.$ ?? {}).filter(
    (attr) => attr.local === name && !attr.uri
  );
  return values.length === 1 ? values[0].value : null;
}

function text(node: XmlNode): string | null {
  if (Object.values(node).some(Array.isArray)) return null;
  return typeof node._ === 'string' ? node._.trim() : null;
}

function integer(
  value: string | null,
  min = 0,
  max = MAX_INTEGER
): number | null {
  if (value === null || !/^\d+$/.test(value.trim())) return null;
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= min && number <= max
    ? number
    : null;
}

function decode(value: string): string | null {
  try {
    for (let i = 0; i < 3; i++) {
      const next = decodeURIComponent(
        value.replace(/%(?![a-f0-9]{2})/gi, '%25')
      );
      if (next === value) return value;
      value = next;
    }
    return /%[a-f0-9]{2}/i.test(value) ? null : value;
  } catch {
    return null;
  }
}

// Arbitrary upstream text is never used in diagnostics. Required text containing
// credentials is rejected rather than persisting a subtly altered release name.
function safeText(
  value: string | null,
  secrets: readonly string[]
): string | null {
  if (
    !value ||
    [...value].some(
      (character) =>
        character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127
    )
  )
    return null;
  const decoded = decode(value);
  if (
    decoded === null ||
    secretMarker.test(decoded) ||
    credentialPath.test(decoded)
  )
    return null;
  if (secrets.some((secret) => secret && decoded.includes(secret))) return null;
  if (/https?:\/\/[^\s/]*@/i.test(decoded)) return null;
  return value;
}

/** Retain the full verified TR4KER slug or an unambiguous supported numeric
 * identity. Unknown query semantics are rejected rather than discarded. */
export function canonicalizeTorznabGuid(
  input: string | null,
  secrets: readonly string[] = []
): string | null {
  if (!input || input.length > 2048) return null;
  let guid = input.trim();
  if (
    [...guid].some(
      (character) =>
        character.charCodeAt(0) <= 32 || character.charCodeAt(0) === 127
    )
  )
    return null;
  if (/^https?:\/\//i.test(guid)) {
    try {
      const url = new URL(guid);
      url.username = '';
      url.password = '';
      url.hash = '';
      // Reject encoded paths and embedded credentials rather than guessing which
      // path components identify the torrent and which are authentication.
      if (
        !safeText(url.origin + url.pathname, secrets) ||
        url.pathname.includes('%')
      )
        return null;
      let queryId: string | null = null;
      for (const [key, value] of url.searchParams) {
        if (
          /^(?:api[_-]?key|passkey|token|access[_-]?token|auth|authorization|password|secret)$/i.test(
            key
          )
        )
          continue;
        if (
          !['id', 'torrentid', 'torrent_id'].includes(key.toLowerCase()) ||
          !/^\d+$/.test(value)
        )
          return null;
        const id = value.replace(/^0+(?=\d)/, '');
        if (queryId !== null && queryId !== id) return null;
        queryId = id;
      }
      const pathId =
        /\/(\d+)\/?$/.exec(url.pathname)?.[1].replace(/^0+(?=\d)/, '') ?? null;
      if (pathId !== null && queryId !== null && pathId !== queryId)
        return null;
      const verifiedSlug =
        url.origin === 'https://tr4ker.net' &&
        /^\/torrent\/[a-z0-9]+(?:-[a-z0-9]+)+$/i.test(url.pathname);
      if (queryId === null && pathId === null && !verifiedSlug) return null;
      url.search = queryId === null ? '' : `id=${queryId}`;
      guid = url.toString();
    } catch {
      return null;
    }
  }
  if (!safeText(guid, secrets)) return null;
  try {
    assertSafeCanonicalGuid(guid);
    return guid;
  } catch {
    return null;
  }
}

function publicationDate(value: string | null): Date | null {
  if (value === null) return null;
  const match =
    /^(?:(Mon|Tue|Wed|Thu|Fri|Sat|Sun),\s+)?(\d{1,2})\s+(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+(\d{4})\s+(\d{2}):(\d{2})(?::(\d{2}))?\s+([+-]\d{4}|UT|GMT|[ECMP][SD]T)$/i.exec(
      value
    );
  if (!match) return null;
  const months = [
    'jan',
    'feb',
    'mar',
    'apr',
    'may',
    'jun',
    'jul',
    'aug',
    'sep',
    'oct',
    'nov',
    'dec',
  ];
  const [day, month, year, hour, minute, second] = [
    Number(match[2]),
    months.indexOf(match[3].toLowerCase()),
    Number(match[4]),
    Number(match[5]),
    Number(match[6]),
    Number(match[7] ?? 0),
  ];
  const zone = match[8].toUpperCase();
  const zones: Record<string, number> = {
    UT: 0,
    GMT: 0,
    EST: -300,
    EDT: -240,
    CST: -360,
    CDT: -300,
    MST: -420,
    MDT: -360,
    PST: -480,
    PDT: -420,
  };
  const zoneHour = Number(zone.slice(1, 3));
  const zoneMinute = Number(zone.slice(3));
  if (/^[+-]/.test(zone) && (zoneHour > 23 || zoneMinute > 59)) return null;
  const offset =
    zones[zone] ?? (zone[0] === '-' ? -1 : 1) * (zoneHour * 60 + zoneMinute);
  const date = new Date(0);
  date.setUTCFullYear(year, month, day);
  date.setUTCHours(hour, minute, second, 0);
  if (
    year < 1900 ||
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month ||
    date.getUTCDate() !== day ||
    hour > 23 ||
    minute > 59 ||
    second > 59
  )
    return null;
  if (
    match[1] &&
    date.toUTCString().slice(0, 3).toLowerCase() !== match[1].toLowerCase()
  )
    return null;
  return new Date(date.getTime() - offset * 60000);
}

async function parseXml(xml: string): Promise<XmlNode> {
  if (typeof xml !== 'string' || Buffer.byteLength(xml) > MAX_XML_BYTES)
    throw new TrackerAdapterError('invalid_response');
  if (!xml.trim()) throw new TrackerAdapterError('invalid_xml');
  if (/<!\s*(?:DOCTYPE|ENTITY)\b/i.test(xml))
    throw new TrackerAdapterError('invalid_xml');
  let parsed: unknown;
  try {
    const parser = new xml2js.Parser({
      explicitArray: true,
      explicitRoot: true,
      explicitCharkey: true,
      xmlns: true,
      strict: true,
    });
    let rootsClosed = 0;
    let invalid = false;
    // The promise/callback API resets at the first closing root and can hide
    // trailing malformed XML. Keep listeners until the synchronous parse ends.
    parser.on('end', (value: unknown) => {
      parsed = value;
      rootsClosed++;
    });
    parser.on('error', () => {
      invalid = true;
    });
    parser.parseString(xml);
    if (invalid || rootsClosed !== 1) throw new Error();
  } catch {
    throw new TrackerAdapterError('invalid_xml');
  }
  const roots =
    parsed && typeof parsed === 'object' ? Object.values(parsed) : [];
  if (roots.length !== 1 || !isNode(roots[0]))
    throw new TrackerAdapterError('invalid_response');
  const root = roots[0];
  if (root.$ns.local === 'error') {
    throw new TrackerAdapterError('torznab_error', false, {
      apiCode: integer(attribute(root, 'code')),
    });
  }
  return root;
}

export async function normalizeTorznabPage(
  xml: string,
  context: TrackerPageContext,
  secrets: readonly string[] = []
): Promise<NormalizedTrackerPage> {
  if (
    !/^[a-z0-9][a-z0-9._-]{0,127}$/i.test(context.trackerId) ||
    !safeText(context.trackerId, secrets) ||
    !(context.observedAt instanceof Date) ||
    !Number.isFinite(context.observedAt.getTime()) ||
    !['movie', 'tv'].includes(context.category) ||
    !Number.isSafeInteger(context.limit) ||
    context.limit <= 0 ||
    !Number.isSafeInteger(context.offset) ||
    context.offset < 0
  )
    throw new TrackerAdapterError('invalid_request');
  const root = await parseXml(xml);
  const channels = children(root, 'channel');
  if (
    root.$ns.local !== 'rss' ||
    root.$ns.uri ||
    channels.length !== 1 ||
    root._?.trim() ||
    channels[0]._?.trim()
  )
    throw new TrackerAdapterError('invalid_response');
  const channel = channels[0];
  if (children(channel, 'error').length)
    throw new TrackerAdapterError('torznab_error');
  const channelElements = Object.values(channel)
    .filter(Array.isArray)
    .flat()
    .filter(isNode);
  const rssElements = new Set([
    'item',
    'title',
    'link',
    'description',
    'language',
    'copyright',
    'managingEditor',
    'webMaster',
    'pubDate',
    'lastBuildDate',
    'category',
    'generator',
    'docs',
    'cloud',
    'ttl',
    'image',
    'rating',
    'textInput',
    'skipHours',
    'skipDays',
  ]);
  if (
    channelElements.some(
      (node) =>
        (!node.$ns.uri && !rssElements.has(node.$ns.local)) ||
        (node.$ns.local === 'item' && node.$ns.uri)
    )
  )
    throw new TrackerAdapterError('invalid_response');
  const items = children(channel, 'item');
  const anomalies: TrackerAnomaly[] = [];
  const candidates: NormalizedTrackerTorrent[] = [];
  const identities = new Map<string, Set<string>>();
  const identifiedItems: { canonicalGuid: string; itemIndex: number }[] = [];
  for (const [itemIndex, item] of items.entries()) {
    const report = (
      field: TorrentField,
      code: TrackerAnomaly['code'] = 'invalid_field'
    ) => {
      anomalies.push({ itemIndex, code, field });
    };
    const scalar = (name: string): string | null => {
      const nodes = children(item, name);
      return nodes.length === 1 ? text(nodes[0]) : null;
    };
    const canonicalGuid = canonicalizeTorznabGuid(scalar('guid'), secrets);
    if (canonicalGuid === null) {
      report('canonicalGuid', 'invalid_identity');
      continue;
    }
    const attrs = children(item, 'attr', TORZNAB_NAMESPACE);
    const attributeValues = (name: string) =>
      attrs
        .filter((attr) => attribute(attr, 'name') === name)
        .map((attr) => attribute(attr, 'value'));
    const hashes = attributeValues('infohash');
    const validHashes = hashes
      .filter((hash): hash is string =>
        Boolean(
          hash &&
          /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(hash) &&
          !secrets.some(
            (secret) =>
              secret && hash.toLowerCase().includes(secret.toLowerCase())
          )
        )
      )
      .map((hash) => hash.toLowerCase());
    const knownHashes = identities.get(canonicalGuid) ?? new Set<string>();
    for (const hash of validHashes) knownHashes.add(hash);
    identities.set(canonicalGuid, knownHashes);
    identifiedItems.push({ canonicalGuid, itemIndex });
    const invalidHash = validHashes.length !== hashes.length;
    if (invalidHash) report('infohash');
    const infohash =
      !invalidHash && new Set(validHashes).size === 1 ? validHashes[0] : null;
    const releaseName = safeText(scalar('title'), secrets);
    if (releaseName === null) {
      report('releaseName');
      continue;
    }
    const provenance: NormalizedTrackerTorrent['provenance'] = {
      trackerId: { source: 'configuration', field: 'trackerId' },
      canonicalGuid: { source: 'tracker', field: 'guid' },
      releaseName: { source: 'tracker', field: 'title' },
      observedAt: { source: 'application', field: 'successful_page_retrieval' },
    };
    const numeric = (
      name: string,
      field: TorrentField,
      min = 0,
      max = MAX_INTEGER
    ): number | null => {
      const values = attributeValues(name);
      if (!values.length) return null;
      const numbers = values.map((value) => integer(value, min, max));
      if (numbers.some((value) => value === null)) {
        report(field);
        return null;
      }
      if (new Set(numbers).size !== 1) {
        report(field, 'conflicting_field');
        return null;
      }
      provenance[field] = { source: 'tracker', field: `torznab:attr/${name}` };
      return numbers[0];
    };
    const categories = new Set<number>();
    for (const value of attributeValues('category')) {
      const category = integer(value, 1);
      if (category === null) report('categories');
      else categories.add(category);
    }
    if (categories.size)
      provenance.categories = {
        source: 'tracker',
        field: 'torznab:attr/category',
      };
    if (infohash !== null)
      provenance.infohash = {
        source: 'tracker',
        field: 'torznab:attr/infohash',
      };
    let size = numeric('size', 'size', 0, Number.MAX_SAFE_INTEGER);
    // A validated RSS size is an equivalent only when the primary attr is absent.
    if (!attributeValues('size').length && children(item, 'size').length) {
      size = integer(scalar('size'), 0, Number.MAX_SAFE_INTEGER);
      if (size === null) report('size');
      else provenance.size = { source: 'tracker', field: 'size' };
    }
    const publishedAt = publicationDate(scalar('pubDate'));
    if (children(item, 'pubDate').length) {
      if (publishedAt === null) report('publishedAt');
      else provenance.publishedAt = { source: 'tracker', field: 'pubDate' };
    }
    const record: NormalizedTrackerTorrent = {
      trackerId: context.trackerId,
      canonicalGuid,
      releaseName,
      infohash,
      categories: [...categories].sort((a, b) => a - b),
      size,
      publishedAt,
      seeders: numeric('seeders', 'seeders'),
      leechers: numeric('leechers', 'leechers'),
      observedAt: new Date(context.observedAt),
      trackerMetadata: {
        tmdbId: numeric('tmdbid', 'tmdbId', 1),
        tvdbId: numeric('tvdbid', 'tvdbId', 1),
        season: numeric('season', 'season'),
        episode: numeric('episode', 'episode'),
      },
      provenance,
    };
    candidates.push(record);
  }
  for (const { canonicalGuid, itemIndex } of identifiedItems) {
    if (identities.get(canonicalGuid)!.size > 1)
      anomalies.push({
        itemIndex,
        field: 'infohash',
        code: 'identity_conflict',
      });
  }
  const records = candidates.filter(
    (record) => identities.get(record.canonicalGuid)!.size < 2
  );
  anomalies.sort(
    (a, b) =>
      a.itemIndex - b.itemIndex ||
      (a.field < b.field ? -1 : a.field > b.field ? 1 : 0)
  );
  return {
    trackerId: context.trackerId,
    category: context.category,
    limit: context.limit,
    offset: context.offset,
    observedAt: new Date(context.observedAt),
    records,
    anomalies,
    receivedCount: items.length,
  };
}

export async function parseTorznabCapabilities(
  xml: string,
  trackerId: string,
  secrets: readonly string[] = []
): Promise<TrackerCapabilities> {
  if (
    !/^[a-z0-9][a-z0-9._-]{0,127}$/i.test(trackerId) ||
    !safeText(trackerId, secrets)
  )
    throw new TrackerAdapterError('invalid_request');
  const root = await parseXml(xml);
  const limits = children(root, 'limits');
  const searching = children(root, 'searching');
  const categoryRoots = children(root, 'categories');
  if (
    root.$ns.local !== 'caps' ||
    root.$ns.uri ||
    limits.length !== 1 ||
    searching.length !== 1 ||
    categoryRoots.length !== 1
  )
    throw new TrackerAdapterError('invalid_response');
  const categories: TrackerCapabilities['advertised']['categories'] = [];
  const addCategories = (node: XmlNode, parentId: number | null) => {
    for (const child of [
      ...children(node, 'category'),
      ...children(node, 'subcat'),
    ]) {
      const id = integer(attribute(child, 'id'), 1);
      if (id === null) throw new TrackerAdapterError('invalid_response');
      categories.push({
        id,
        name: safeText(attribute(child, 'name'), secrets),
        parentId,
      });
      addCategories(child, id);
    }
  };
  addCategories(categoryRoots[0], null);
  const operations = [
    'search',
    'movie-search',
    'tv-search',
    'music-search',
    'book-search',
  ].flatMap((name) => {
    const nodes = children(searching[0], name);
    if (nodes.length > 1) throw new TrackerAdapterError('invalid_response');
    return nodes.map((node) => ({
      name,
      available: attribute(node, 'available') === 'yes',
      parameters: [
        ...new Set(
          (attribute(node, 'supportedParams') ?? '')
            .split(',')
            .map((value) => value.trim())
            .filter(
              (value) =>
                /^[a-z][a-z0-9_-]*$/i.test(value) && safeText(value, secrets)
            )
        ),
      ].sort(),
    }));
  });
  return {
    trackerId,
    advertised: {
      limits: {
        default: integer(attribute(limits[0], 'default'), 1),
        max: integer(attribute(limits[0], 'max'), 1),
      },
      categories: categories.sort((a, b) => a.id - b.id),
      operations,
    },
  };
}
