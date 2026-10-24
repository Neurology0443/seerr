# Tracker adapters (P2)

`TrackerAdapter` exposes capability discovery and one Recent or Historical page
per call. `Tr4kerAdapter` accepts server-side `trackerId`, `apiKey`, optional
`endpoint` and optional `timeout`. The defaults are TR4KER's HTTPS Torznab `/all`
endpoint and Seerr's configured `network.apiRequestTimeout`. Constructing or
importing the client performs no requests.

```ts
const adapter = new Tr4kerAdapter({ trackerId, apiKey });
const capabilities = await adapter.getCapabilities();
const page = await adapter.fetchRecentPage({ category: 'movie', offset: 0 });
```

Movies and TV use separate `t=search` requests with categories 2000 and 5000.
Both page methods share the same implementation. Limits default to 100 and must
be integers from 1 through 100; offsets must be nonnegative safe integers.
Capabilities describe advertised operations, including unverified ID searches.
The adapter only calls `caps` and `search`. Page reads bypass application caches.
Redirects are rejected to avoid forwarding query credentials to another endpoint.

`normalizeTorznabPage(xml, context, secrets)` is independently testable. Supply
the injected credential in `secrets` when using it directly; the HTTP adapter
does this automatically. Its records extend P1's `ObservedTorrent` without
changing storage. Dates use `Date`, unknown optional values use `null`, and zero
seeders remain zero. `observedAt` describes this successful page retrieval; P1
owns stored first/last observations and seeder freshness. `trackerMetadata` holds
unresolved tracker TMDB/TVDB IDs and explicit season/episode numbers. `provenance`
identifies the source of each present field. P2 does not write these claims as
media associations or infer coverage from titles.

`CatalogueRepository.persistPage()` does not persist `trackerMetadata` or its
field provenance. Durable retention belongs to the existing CAT-010 follow-up
for P3/P5; this adapter correction does not change the P1 persistence contract.

Page context echoes the requested category, limit and offset. `receivedCount`
includes rejected items; `anomalies` contain only item indexes, fixed codes and
field names, never raw XML or identifiers. Every record implicated in a known
GUID/infohash contradiction is excluded, including compatible or unknown-hash
duplicates of that GUID. Other duplicates remain observations for P1's existing
write boundary. Cross-page conflicts remain P1's responsibility.

GUID canonicalization structurally validates the verified TR4KER structure
`https://tr4ker.net/torrent/<hyphenated-release-slug>`. The entire slug retains its
case and suffix; the validated infohash remains separate. An eight-character
suffix matching the start of the infohash was observed in two examples, but this
relationship is not guaranteed or required. Identity is never derived from a
title, hash or presumed suffix format. The GUID must already be in this canonical
HTTPS form, with the exact hostname, one nonempty hyphenated slug and no port,
userinfo, query string, fragment or encoded path component. Unexpected components
are rejected, never removed to manufacture a valid identity.

Previously supported opaque P1-safe identifiers and generic Torznab numeric URL
identities remain supported separately from the strict TR4KER convention.
Generic query aliases `id`, `torrentid` and
`torrent_id` are case-insensitive and normalize to one `id` parameter. Repeated
aliases must agree, including with a numeric final path ID. Unknown parameters,
encoded paths, userinfo, fragments and contradictory identities are rejected.

Ordinary release words such as `Secret-Wars`, `Secret_Story` and `Token-Ring`
are accepted without modifying titles. GUID validation does not scan slug or
path words for hypothetical credentials. The configured API-key value is still
rejected wherever it appears, including supported encoded forms. Separate checks
for non-GUID tracker text retain explicit credential-assignment and control/
encoding safeguards. P1 applies generic URL component validation and rejects
explicit credential assignments in opaque identifiers. Download/enclosure URLs
are never returned or fetched, and `comments` is not used as a GUID fallback.

`TrackerAdapterError` provides a fixed message, code, retryability, HTTP status,
optional numeric Torznab API code and sanitized `retryAfter` (`{ seconds }` or
`{ date }`, with canonical ISO date). Raw upstream exceptions are discarded.
Malformed XML (including trailing data), invalid envelopes and API errors fail
the page; invalid optional item fields instead produce anomalies and `null`.

The adapter does not use `total`, infer scan completion, advance offsets, write
checkpoints, persist pages, retry, throttle, schedule collection or make native
availability/acquisition decisions. Those operations belong to later phases.

Offline checks:

```sh
devenv --no-tui shell -- pnpm test server/api/trackers/torznab.test.ts server/api/trackers/tr4ker.test.ts
```

Fixtures reproduce the documented TR4KER envelope and fields using synthetic
releases, IDs and credentials. No live tracker response or real key is included.
