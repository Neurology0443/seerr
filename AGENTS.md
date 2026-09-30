# AGENTS.md — Seerr multi-service fork

## Mission

This repository is a fork of current `seerr-team/seerr:develop` adding **independent per-service request slots and availability** across multiple Sonarr/Radarr destinations.

The feature is additive. Preserve upstream behavior unless a change is directly required by the multi-service contract.

Use the historical `Simoneu01/seerr#2` implementation as functional reference only. Do not treat it as the authoritative architecture when it conflicts with current upstream behavior or this file.

---

## Highest-priority rule: upstream-first, minimum delta

Always prefer:

```text
current upstream behavior
+ smallest coherent multi-service change
```

over refactoring or redesigning surrounding systems.

Preserve native behavior for:

- Standard requests;
- 4K requests;
- Advanced Requests;
- native permissions;
- quotas;
- auto-approval;
- Override Rules;
- request locks and serialization;
- transaction-safe subscribers;
- native lifecycle;
- legacy scanners;
- notifications;
- Plex/Jellyfin integrations;
- existing API fields.

Do not make unrelated cleanup/refactors part of the feature.

---

## Seerr is the source of truth

Seerr owns:

- request identity;
- target service;
- `requestServices` grants;
- permissions;
- canonical 4K semantics;
- duplicate detection;
- quotas;
- auto-approval;
- Override Rules;
- availability;
- per-season availability;
- lifecycle;
- completion;
- scanner reconciliation;
- validation errors.

Do not move these decisions to Moonbase or Moonfin.

---

## Fundamental target model: native and multi-service targets are disjoint

A service ID has exactly one role.

### Native target

```text
buttonLabel is empty
```

It may be default Standard, default 4K, or a non-default server selectable through the native Advanced Request flow.

### Multi-service target

```text
buttonLabel is non-empty
isDefault = false
syncEnabled = true
```

It is reserved for service-specific requests.

### Required validation

Reject invalid configurations such as:

```text
isDefault=true + non-empty buttonLabel
non-empty buttonLabel + syncEnabled=false
```

A labelled target MUST NOT be offered as a server override in the native Advanced Request selector.

A labelled target is selected only through the service-specific flow. In that flow the target server is fixed, while other allowed Advanced options may still be used.

Do not allow the same `serverId` to represent both a native slot and an independent service slot.

---

## Service request marker

### Native request

```text
isServiceRequest = false
```

A native Advanced Request may have `serverId`.

`serverId` alone MUST remain a native Advanced override and MUST NOT imply a service request.

### Service-specific request

```text
serverId = <labelled target>
isServiceRequest = true
```

Never implement globally:

```text
serverId exists => isServiceRequest=true
```

---

## Slot identity

For service-specific movies:

```text
(media, serverId)
```

For service-specific TV:

```text
(media, serverId, season)
```

`is4k` is not part of service-slot identity.

Use the same slot comparison semantics for POST, PUT/edit, duplicate checks, lifecycle, and season filtering. Prefer a shared helper if it reduces semantic drift.

---

## Native Standard/4K remain additive

Do NOT implement a service-only user mode.

`User.requestServices` adds service targets and MUST NOT hide or disable native Standard/4K buttons.

Do not copy the PR #2 `restrictToServices` behavior that suppresses native request buttons when a user has service grants.

Expected UI can be:

```text
Request
Request 4K
Request Deutsch
Request English
```

A native target that already represents FR should remain the native `Request` target rather than being duplicated as an independent `Request Français` slot.

---

## `requestServices`

Use grants such as:

```text
radarr:<id>
sonarr:<id>
```

For a regular user, a service request requires:

- native permission to request the media type;
- matching `requestServices` grant;
- native 4K permissions when target is 4K;
- all normal validations.

`REQUEST_ADVANCED` alone does not grant all multi-service targets.

`MANAGE_REQUESTS` may use/manage all targets without an individual grant, preserving its native administrative role.

---

## Canonical 4K semantics

For service-specific requests, do not trust request-body `is4k` as authoritative.

Resolve and validate the target first, then use:

```text
target.is4k
```

as the canonical value before applying permissions, quotas, auto-approval, and any other 4K-dependent logic.

Reject attempts to use a 4K target without the native required 4K permission.

---

## Advanced Request behavior

### Native Advanced Request

- only native/unlabelled targets are valid server overrides;
- preserve upstream behavior otherwise.

### Service-specific Advanced Request

- target is fixed by the service button / explicit service request;
- user cannot switch to a different server inside that flow;
- profile/root/tags and other applicable upstream Advanced options remain available;
- do not create a second Advanced logic stack.

---

## Override Rules

Reuse upstream `overrideRules()` behavior.

For a service-specific request, pass the actual selected target service ID.

Do not define custom precedence.

Current upstream semantics must remain authoritative, including preserving explicit Advanced/manager values where upstream does so and filling only missing values from rules.

A service request to Sonarr DE must never accidentally use the default Sonarr's Override Rules.

---

## Duplicate detection and history

History is preserved.

Never decide duplicate state from `existing[0]` or any arbitrary first historical row.

The rule is:

```text
Does ANY active request exist in the same slot?
```

At minimum, `PENDING` and `APPROVED` are active/open states for this purpose.

Historical `DECLINED`, `FAILED`, and `COMPLETED` requests must not permanently block a new request when the slot becomes requestable again.

---

## Availability model

Use `MediaServiceStatus` for live service-specific state.

One service's availability must never satisfy another service.

Do not use service-specific state to reserve the legacy `Media.status/status4k` tracks.

For TV, availability/requestability is per `(service, season)`.

Do not hide a TV service button solely because its aggregate service status is `PARTIALLY_AVAILABLE`.

A fully available DE target must not prevent an absent FR target from being requested.

A continuing series must become requestable again in a service when a new season appears there as missing.

---

## Quotas and lifecycle

Do not add per-language/per-service quota systems in V1.

Reuse native quotas, auto-approval, and request lifecycle.

For TV service requests, quota calculation must use the final set of newly requested seasons in that target after removing seasons already available or covered by an active request in the same slot.

---

## `animeOnly`

Keep `animeOnly` as an optional target restriction.

Enforce it in both UI and backend validation. Do not rely only on hiding a button.

Do not hard-code language names or infer anime from service naming.

---

## Scanner rules

Each scanner mutates only its own service status.

A destructive stale cleanup is allowed only after a scan that is known to have a reliable inventory.

Do not treat secondary failures as absence:

- TMDB lookup error;
- metadata conversion error;
- processing exception for one item;
- partial scan.

On service outage/auth failure/5xx/invalid response, preserve the last known state and do not perform destructive cleanup.

Meaning:

```text
UNKNOWN = no reliable state / never observed
DELETED = confirmed disappearance after a healthy scan
```

Completion must come only from the request's target. For TV, all requested seasons must be available in that target.

---

## `syncEnabled` is required for multi-service

A labelled target depends on its scanner for availability and completion.

Therefore:

```text
buttonLabel non-empty => syncEnabled=true
```

must be validated server-side.

Do not expose or accept service-specific requests for an unsynced target.

---

## Durable service identity

A service ID is a durable logical identity.

### ID allocation

- monotonic per service type;
- persistent;
- deleted IDs are never reused;
- initial seed must consider historical references, not only current settings.

Seed from at least:

- currently configured services;
- historical `MediaRequest.serverId`;
- Override Rule service references;
- existing `requestServices` grants when migrating compatible custom data.

### Editing identity

Connection maintenance is allowed when it is still the same logical destination:

- API key;
- hostname;
- port;
- base URL;
- network migration;
- display text changes that do not change native-vs-service role.

Do not silently recycle a service identity by changing a used service between:

- native and multi-service roles;
- Standard and 4K roles;
- one logical backend and a different backend.

Once relevant references/history exist, structural identity changes require delete + create.

---

## Service deletion

For labelled multi-service targets, if any service-specific request is active (`PENDING` or `APPROVED`), deletion MUST fail with `409 Conflict`.

Do not auto-decline, auto-fail, redirect, or retarget those requests.

After active requests are resolved, deletion should:

- remove user grants for that target;
- remove live `MediaServiceStatus` rows for that target;
- remove/invalidate target-specific Override Rules/config references;
- preserve historical `MediaRequest` rows;
- never reuse the ID.

Historical UI may use `Deleted service (#id)` / localized equivalent.

Do not add a historical service-name snapshot solely for V1 presentation unless correctness requires it later.

---

## Media deletion from one *Arr

A confirmed disappearance from a target should mark only that target as `DELETED`.

Preserve request history.

A new request may be created later if no active request remains in the same slot.

Never mutate another target because one target removed the media.

---

## Validation and HTTP errors

Bad client/service-specific input is a client error, not a generic 500.

Explicitly validate and test:

- `isServiceRequest=true` without `serverId`;
- missing target;
- wrong target type;
- target not labelled;
- target default+label invalid config;
- target unsynced;
- labelled target used as native Advanced override;
- missing service grant;
- missing 4K permission;
- animeOnly mismatch;
- duplicate active slot;
- service deletion with active requests.

Preserve meaningful upstream error behavior where applicable.

---

## Migrations

All persistent fields require proper migrations for both SQLite and PostgreSQL.

Expected multi-service persistent changes include:

- `User.requestServices`;
- `MediaRequest.isServiceRequest`;
- `MediaServiceStatus`;
- relations/indexes;
- persistent monotonic ID allocator if implemented in DB/settings.

Do not use production `synchronize` as migration strategy.

Regenerate/rewrite migrations against current upstream after rebases rather than copying stale migration files from the historical PR.

---

## Concurrency

Preserve current upstream request locking/serialization.

Mandatory behavior:

```text
same media + same service concurrently => one active request
same media + different services concurrently => independent requests
same TV season + same service concurrently => one active request
same TV season + different services concurrently => independent requests
```

Do not weaken upstream protections to simplify service-slot logic.

---

## Regression matrix

Before considering the Seerr feature complete, test at least:

### Native

- Standard movie/TV;
- 4K movie/TV;
- Advanced native target selection;
- Override Rules;
- quotas;
- auto-approval;
- manager actions;
- current request locking/concurrency;
- scanner/lifecycle behavior.

### Multi-service

- movie slots across services;
- TV seasons across services;
- partial availability;
- continuing series/new season;
- 4K targets;
- animeOnly;
- historical completed + re-request;
- deletion and `409`;
- stable IDs;
- degraded scans;
- same-slot concurrency;
- cross-slot concurrency.

---

## Do not do these

Do NOT:

- modify Moonfin;
- create a new language model unless explicitly re-scoped;
- encode language via `is4k`, profile, folder, tags, or quality dimensions;
- create service-only users;
- hide native request buttons because `requestServices` is non-empty;
- infer service requests from `serverId` alone;
- allow labelled targets to remain native Advanced targets;
- duplicate Override Rule logic;
- add per-service quota engines;
- let scanners infer deletion from partial failures;
- delete request history for cleanup convenience;
- reuse service IDs;
- add broad refactors unrelated to this feature.

---

## Definition of done for Seerr

Seerr is ready for Moonbase work only when:

- all target-role invariants are enforced;
- movie and TV slots are correct for create/edit/lifecycle;
- native Standard/4K/Advanced regressions are green;
- scanners and completion are target-safe;
- history/deletion/ID identity are safe;
- SQLite and PostgreSQL migrations pass;
- concurrency tests pass;
- contract fixtures for Moonbase are stable.
