# PR3 validation — 25 October 2026

Implemented against the inspected P1/P2 worktree and the current PR3 specification.
The architecture and roadmap agree with the implemented scope; CAT-010 is the sole
P5-adjacent addition. No media identification, coverage inference, Arr changes or
tracker administration UI was added.

## Files changed

- `server/api/trackers/types.ts`: maintain P2 structural compatibility with the additive observation fields.
- `server/lib/catalogue/collectionConfig.ts`: opt-in non-secret settings, bounded defaults and validation.
- `server/lib/catalogue/collectionState.ts`: versioned bounded checkpoints, separate coverage state and safe aggregated diagnostics.
- `server/lib/catalogue/collectionStore.ts`: database time, SQL request reservations, scope leases, renewal, cooldown, suspension and explicit recovery.
- `server/lib/catalogue/collector.ts`: Recent/Historical coordination, overlapping pagination, terminal confirmation, maintenance, retries and recovery.
- `server/lib/catalogue/collectionRuntime.ts`: configured startup, durable work polling and bounded shutdown.
- `server/lib/catalogue/transactions.ts`: shared SQLite write queue, database clock and fencing error.
- `server/lib/catalogue/entities.ts`, `types.ts`, `repository.ts`: additive native claims and dispatch/scope state; atomic fenced persistence and conflict quarantine.
- `server/lib/catalogue/migration/collectionEngine.ts` and `migration/{sqlite,postgres}/1792886400000-CollectionEngine.ts`: isolated additive migrations. Native SQLite ALTER operations preserve referencing rows.
- `server/lib/catalogue/index.ts`: start collection after readiness and stop dispatch before storage shutdown.
- `server/job/schedule.ts`: separate staggered Recent jobs and duplicate startup protection.
- `server/lib/settings/index.ts`, `server/lib/settings/migrations/0010_add_catalogue_collection.ts`: JobIds, disabled defaults and additive settings migration.
- `server/lib/catalogue/collector.test.ts`, `fixtures/collectionWorker.ts`: offline dual-engine pagination, metadata, atomicity, leases, cross-process contention/fencing, quotas and error tests.
- `server/lib/catalogue/collectionRuntime.test.ts`, `server/job/schedule.test.ts`, `server/lib/settings/catalogue.test.ts`: configuration, startup failure isolation, shutdown, scheduling and migration regressions.
- `server/lib/catalogue/catalogue.test.ts`: assert both catalogue migrations and unwind both while retaining existing P1 assertions.
- `server/lib/catalogue/README.md`, this file: P3 configuration, recovery and validation record.
- `codex/catalogue/backlog.md`: CAT-010 marked Resolved with implementation/test evidence. This existing project-reference path is Git-ignored; its local update is intentionally unstaged.

## Focused checks and results

All commands ran from the repository root in its existing `devenv` environment.
Only isolated temporary SQLite files and a disposable PostgreSQL 17.9 cluster were
used. The cluster was created under `/tmp/seerr-p3-pg`, listening on loopback port
56483, with an empty `seerr_migration_control` database and the test-only
`seerr_migration_test` role. Test suites create/drop their own randomly named databases.
No application data or tracker credentials were used.

Final P3 command:

```sh
devenv shell -- env SEERR_MIGRATION_PG_DISPOSABLE=true SEERR_MIGRATION_PG_PORT=56483 SEERR_MIGRATION_PG_PASSWORD=p3-disposable pnpm test server/lib/catalogue/collector.test.ts server/lib/settings/catalogue.test.ts server/lib/catalogue/collectionRuntime.test.ts server/job/schedule.test.ts
```

**47 passed, 0 failed, 0 skipped.** Both database engines exercised real child
processes competing for reservations, expired-owner takeover, rejection of stale
page writes, shared quota persistence, restart/reopening, additive migrations,
rollback between observations and checkpoint, Recent recovery and Historical
maintenance continuation. Controlled-clock tests cover sustained 3s/6s spacing
and 20/10 starts per half-open minute; production-clock tests use SQL time.

Relevant existing regression command:

```sh
devenv shell -- env SEERR_MIGRATION_PG_DISPOSABLE=true SEERR_MIGRATION_PG_PORT=56483 SEERR_MIGRATION_PG_PASSWORD=p3-disposable pnpm test server/lib/catalogue/catalogue.test.ts server/lib/catalogue/lifecycle.test.ts server/api/trackers/torznab.test.ts server/api/trackers/tr4ker.test.ts server/lib/settings/migrations.test.ts server/lib/settings/catalogue.test.ts server/job/schedule.test.ts server/lib/catalogue/collectionRuntime.test.ts
```

**190 passed, 0 failed, 0 skipped.** Includes real PostgreSQL P1 schema permissions,
native migration isolation, storage/lifecycle regressions and P2 adapter contracts.
Five new settings/runtime/scheduling cases appear in both commands; counts should
not be added as unique tests.

Static checks:

```sh
devenv shell -- pnpm exec tsc --project server/tsconfig.json --noEmit
devenv shell -- pnpm exec eslint server/api/trackers/types.ts server/job/schedule.ts server/job/schedule.test.ts server/lib/catalogue/*.ts server/lib/catalogue/fixtures/collectionWorker.ts server/lib/catalogue/migration/collectionEngine.ts server/lib/catalogue/migration/sqlite/1792886400000-CollectionEngine.ts server/lib/catalogue/migration/postgres/1792886400000-CollectionEngine.ts server/lib/settings/index.ts server/lib/settings/catalogue.test.ts server/lib/settings/migrations/0010_add_catalogue_collection.ts
```

Both passed, with no ESLint errors or warnings. Modified files were formatted with
the repository's Prettier. A final Prettier check and `git diff --check` passed.

Earlier validation findings were corrected and rerun: the first PostgreSQL fixture
omitted schema creation and leaked its temporary connection; the fixture now
creates the namespace and closes on setup failure. That leaked database caused an
initial P1 disposable-instance sentinel failure; it was removed before the passing
run. A scheduling test initially lacked a parameter type. Initial lint findings
(unused destructuring, fixture import paths and loose test types) were fixed.
An initial SQLite-only run skipped PostgreSQL; the final dual-engine runs above
supersede it. The sandbox initially blocked Nix daemon/shared-memory access;
approved devenv and disposable PostgreSQL execution resolved that provisioning issue.

## Operational limits and checks not performed

No implementation blocker remains. Collection stays disabled until configured
with `catalogue.tr4ker.enabled` and the process environment variable `TR4KER_KEY`.
Maintenance remains inactive until a valid explicit interval is supplied. Settings
and recovery details are in [README.md](./README.md).

Moving offsets and confirmed empty boundaries are observed evidence, without a
claim of absolute catalogue exhaustiveness. Partial evidence remains partial until
reprocessed; error recovery retains it. The request rates are the approved initial
policy, not a claim about the tracker's official quota.

The complete repository suite, production build, full interactive HTTP server and
live tracker crawl were not run. Native startup behavior was checked through the
focused lifecycle/runtime/scheduling regressions; final broad validation remains
with the human operator. No branches, staging, commits, pushes or sibling worktree
files were changed.

## Corrective pass — collection reliability and tracker isolation

Modified only `collectionConfig.ts`, `collectionState.ts`, `collectionStore.ts`,
`collector.ts`, `collectionRuntime.ts`, `collector.test.ts`,
`fixtures/collectionWorker.ts`, `README.md` and this validation record, all under
`server/lib/catalogue/`. The catalogue SQL schema, P2 adapters, settings format and
native scheduler are unchanged. No backlog entries were created or updated.

Corrections:

- Ordered GUID intersections tolerate ordinary front insertions/removals while
  broken continuity, reordered overlaps and repeated pages remain conservative.
- Scope acquisition/preparation precedes the final SQL permit. Adapter invocation
  immediately follows that permit; preparation failure consumes no request slot.
  A durable pending-dispatch flag retains Recent priority during preparation and
  prevents reuse of an already dispatched permit. Global/maintenance spacing,
  database time, cross-process leases and transactional page fencing remain shared.
- The runtime supplies identity, category mappings, page size and overlap. Progress
  derives from those parameters. Version 2 checkpoints record them; compatible v1
  checkpoints upgrade without rescanning, and incompatible pagination restarts only
  the affected pass without deleting observations or claiming immediate coverage.
- At most one local operation per tracker runs concurrently. Repeated ticks can
  advance another tracker while one request is blocked. Stop/drain tracks all work.
- Recording bounded safe diagnostics is independent of coverage. Optional metadata
  anomalies remain visible without false coverage degradation. Critical failures
  remain partial through completion/restart; a later clean pass can repair them.

Targeted P3/configuration/runtime/scheduling command:

```sh
devenv shell -- env SEERR_MIGRATION_PG_DISPOSABLE=true SEERR_MIGRATION_PG_PORT=56484 SEERR_MIGRATION_PG_PASSWORD=corrective-disposable pnpm test server/lib/catalogue/collector.test.ts server/lib/catalogue/collectionRuntime.test.ts server/job/schedule.test.ts server/lib/settings/catalogue.test.ts
```

**65 passed, 0 failed, 0 cancelled, 0 skipped.** Both SQLite and real isolated
PostgreSQL exercised the changes. Adapter-invocation timestamps, deliberately
blocked preparation, separate collector instances, existing child-process quota
and stale-owner tests, blocked/suspended trackers, multitracker drain, moving pages,
coverage repair, optional anomalies, settings isolation and v1 recovery are covered.

Directly affected P1/P2 command (run separately against the same empty disposable
instance, after P3 removed its own test databases):

```sh
devenv shell -- env SEERR_MIGRATION_PG_DISPOSABLE=true SEERR_MIGRATION_PG_PORT=56484 SEERR_MIGRATION_PG_PASSWORD=corrective-disposable pnpm test server/lib/catalogue/catalogue.test.ts server/lib/catalogue/lifecycle.test.ts server/api/trackers/torznab.test.ts server/api/trackers/tr4ker.test.ts
```

**183 passed, 0 failed, 0 skipped.** This includes persistence/checkpoint atomicity,
native isolation, migrations, lifecycle and existing offline P2 normalization.

Focused lint and formatting commands:

```sh
devenv shell -- pnpm exec eslint server/lib/catalogue/collectionConfig.ts server/lib/catalogue/collectionState.ts server/lib/catalogue/collectionStore.ts server/lib/catalogue/collector.ts server/lib/catalogue/collectionRuntime.ts server/lib/catalogue/collector.test.ts server/lib/catalogue/fixtures/collectionWorker.ts
devenv shell -- pnpm exec prettier --check server/lib/catalogue/collectionConfig.ts server/lib/catalogue/collectionState.ts server/lib/catalogue/collectionStore.ts server/lib/catalogue/collector.ts server/lib/catalogue/collectionRuntime.ts server/lib/catalogue/collector.test.ts server/lib/catalogue/fixtures/collectionWorker.ts server/lib/catalogue/README.md server/lib/catalogue/PR3-VALIDATION.md
git diff --check
```

All passed. Only modified files were formatted. No global lint, formatting,
typecheck, i18n check, full repository test suite or production build was run.
No live tracker calls or benchmarks were performed. The existing observed-boundary
limitation remains; no implementation blocker remains.

The initial corrective test run cancelled the controlled shutdown fixture: tracker
recovery re-enabled Recent scopes while the fixture awaited a Historical response.
The fixture now explicitly selects its intended scopes after recovery. The complete
passing run above supersedes that cancelled run; no assertion or production
recovery rule was weakened. PostgreSQL 17.9 was provisioned in the disposable
`/tmp/seerr-p3-corrective-pg` directory on loopback port 56484 and stopped after the
checks. No project environment configuration or real data was changed.

## Corrective pass — collection reliability and tracker independence

Modified files:

- `server/lib/catalogue/collector.ts`: unadvanced Historical retries, unusable-page handling and logical Recent enqueue mapping.
- `server/lib/catalogue/repository.ts`: protocol-independent validation of bounded native tracker provenance.
- `server/lib/catalogue/collectionRuntime.ts`, `server/job/schedule.ts`: logical movie/TV triggers and runtime wake-up after isolated enqueue errors.
- `server/lib/catalogue/collector.test.ts`, `server/lib/catalogue/collectionRuntime.test.ts`, `server/job/schedule.test.ts`: focused regression coverage for these boundaries.
- `server/lib/catalogue/README.md`, this validation record: recovery, scheduling and provenance contract documentation.

Corrections:

- Timeout, 429 and 503 failures retain an unadvanced Historical checkpoint without
  inventing a permanent dirty range. Backoff and Retry-After survive reopening;
  successful same-offset reprocessing can finish the pass as observed. Existing
  critical gaps remain partial, and Recent interruption safeguards are retained.
- Nonempty pages with no usable records use bounded scope retries regardless of
  normalized contract status. Repository quarantine of every record restores
  tentative page progress and success state inside the same transaction. Rejected
  pages invalidate pending terminal emptiness. Partial acceptance retains valid
  records and conservative coverage.
- Native provenance retains the existing tracker-source and numeric value
  requirements while accepting bounded symbolic field paths from other protocols.
  Malformed structures, unsafe sources, credential paths, URLs and raw payloads
  are rejected transactionally. Existing TR4KER provenance is unchanged.
- The two existing jobs trigger logical `movie`/`tv` work, mapped to each tracker's
  configured IDs. Unsupported mappings are ignored; one enqueue error or suspended
  tracker does not prevent another's scheduled work. Job IDs, crons, fairness,
  leases, Recent priority and per-tracker request budgets retain their behavior.

Focused collection/runtime/scheduling command:

```sh
devenv shell -- env SEERR_MIGRATION_PG_DISPOSABLE=true SEERR_MIGRATION_PG_PORT=56485 SEERR_MIGRATION_PG_PASSWORD=independence-disposable pnpm test server/lib/catalogue/collector.test.ts server/lib/catalogue/collectionRuntime.test.ts server/job/schedule.test.ts
```

**74 passed, 0 failed, 0 cancelled, 0 skipped.** Real isolated SQLite and PostgreSQL
cover all four corrections plus existing Historical/Recent pagination, coverage,
metadata, transactions, leases, fencing, quotas, restart and failure isolation.
An initial new scheduling fixture expected consecutive movie pages; its expectation
was corrected to preserve the existing movie/TV alternation. No production fairness
rule or assertion was weakened. The passing run supersedes that fixture failure.

Directly affected P1/P2 command, run separately after the preceding tests removed
their own databases:

```sh
devenv shell -- env SEERR_MIGRATION_PG_DISPOSABLE=true SEERR_MIGRATION_PG_PORT=56485 SEERR_MIGRATION_PG_PASSWORD=independence-disposable pnpm test server/lib/catalogue/catalogue.test.ts server/lib/catalogue/lifecycle.test.ts server/api/trackers/torznab.test.ts server/api/trackers/tr4ker.test.ts
```

**183 passed, 0 failed, 0 cancelled, 0 skipped.** Includes storage/checkpoint
atomicity, native isolation, lifecycle and offline P2/TR4KER normalization.

Modified-file checks:

```sh
devenv shell -- pnpm exec eslint server/lib/catalogue/collector.ts server/lib/catalogue/repository.ts server/lib/catalogue/collectionRuntime.ts server/lib/catalogue/collectionRuntime.test.ts server/lib/catalogue/collector.test.ts server/job/schedule.ts server/job/schedule.test.ts
devenv shell -- pnpm exec prettier --check server/lib/catalogue/collector.ts server/lib/catalogue/repository.ts server/lib/catalogue/collectionRuntime.ts server/lib/catalogue/collectionRuntime.test.ts server/lib/catalogue/collector.test.ts server/job/schedule.ts server/job/schedule.test.ts server/lib/catalogue/README.md server/lib/catalogue/PR3-VALIDATION.md
git diff --check
```

All passed. Only modified files were formatted. PostgreSQL 17.9 used the disposable
`/tmp/seerr-p3-independence-pg` directory on loopback port 56485 and was stopped
and removed after testing. No real data or tracker credentials were used.

No schema, migrations, adapters, settings format or project environment changes
were needed. No backlog entries were created or updated. No global lint,
formatting, typecheck, i18n, full repository suite, production build or live tracker
calls were run. Observed boundaries retain their existing exhaustiveness limits;
no implementation blocker remains. No staging, commit, push, branch changes or
sibling-worktree modifications were performed.

## Corrective pass — release diagnostics and Historical repair (26 October 2026)

CAT-012 and CAT-013 are corrected within P3. The strict accepted TR4KER GUID
contract, native Seerr behavior, page fencing, shared quotas and P2 metadata
semantics are preserved. No diagnostic API, P4 UI or P5/P6 behavior was added.

Files changed:

- `server/api/trackers/diagnostics.ts`: independent safe diagnostic identity/title projection and keyed fingerprints.
- `server/api/trackers/{types,torznab,tr4ker}.ts`: additive release rejection details and precise stable GUID rejection reasons; ingestion rules are unchanged.
- `server/api/trackers/{torznab,tr4ker}.test.ts`: safe rejected GUIDs, opaque fingerprints, precise causes and credential/encoded-value regressions.
- `server/lib/catalogue/{types,entities}.ts`: isolated per-release diagnostic and repair metadata.
- `server/lib/catalogue/migration/releaseDiagnostics.ts`, `migration/{sqlite,postgres}/1792972800000-ReleaseDiagnostics.ts`: additive diagnostic table, uniqueness, foreign key and repair/retention/identity indexes.
- `server/lib/catalogue/collectionRepairs.ts`: diagnostic deduplication, retention, evidence-based resolution, bounded repair attempts and quarantine.
- `server/lib/catalogue/{collector,collectionState,collectionStore,repository}.ts`: atomic integration into existing checkpoint transactions, legacy-state recovery and maintenance-independent repair scheduling.
- `server/lib/catalogue/{collector,catalogue}.test.ts`: dual-engine diagnostic/repair regressions and updated migration-history/down-up checks.
- `server/lib/catalogue/README.md`, this record: explicit dirty/coverage and repair-completion contracts.
- `codex/catalogue/backlog.md`: CAT-012/CAT-013 marked Resolved with evidence; this project-reference path remains Git-ignored and unstaged.

Historical `dirty` now represents outstanding critical repair work. Release
resolution requires a later accepted observation of the same safe GUID with the
affected field validated; another GUID sharing an infohash does not resolve it.
A continuity region requires a complete clean rescan, including confirmed terminal
emptiness. A page-budget stop cannot verify that region. Unknown legacy gaps,
unidentified releases and evicted evidence retain uncertainty without inferred
absence. Three unsuccessful controlled rescans quarantine an issue; quarantine
can clear dirty while coverage stays partial. Repairs run with maintenance disabled,
share the existing limiter/leases, and retain Recent priority and Retry-After.

Repair attempts are capped at three, each with a 10,000-page budget and bounded
30–900 second exponential backoff. Unidentified sightings retain distinct rows
and null release keys, but share a bounded scope repair budget. Release storage is
capped at 5,000 rows per tracker/category/mode; resolved history expires 30 days
after resolution. Capacity eviction of uncertain evidence leaves an explicit
quarantined coverage marker. Stable non-null release keys distinguish releases
from occurrences and multiple rejection causes.
The retention marker retains a scope-level attempt budget, tested with discarded
and recreated diagnostic rows, so capacity churn cannot restart repairs forever.

All commands ran in the existing devenv with offline fixtures, temporary SQLite
files and an isolated PostgreSQL 17.9 cluster on loopback port 56486. The cluster
used `/tmp/seerr-p3-repairs-pg`, the disposable test role and empty control database;
test suites created/dropped only their own randomly named databases.

```sh
devenv shell -- env SEERR_MIGRATION_PG_DISPOSABLE=true SEERR_MIGRATION_PG_PORT=56486 SEERR_MIGRATION_PG_PASSWORD=repairs-disposable pnpm test server/lib/catalogue/collector.test.ts server/lib/catalogue/collectionRuntime.test.ts server/job/schedule.test.ts
devenv shell -- pnpm test server/api/trackers/torznab.test.ts server/api/trackers/tr4ker.test.ts
devenv shell -- env SEERR_MIGRATION_PG_DISPOSABLE=true SEERR_MIGRATION_PG_PORT=56486 SEERR_MIGRATION_PG_PASSWORD=repairs-disposable pnpm test server/lib/catalogue/catalogue.test.ts server/lib/catalogue/lifecycle.test.ts
```

Results: **92 P3 + 150 P2 + 34 storage/lifecycle tests passed; 0 failed, cancelled
or skipped.** PostgreSQL suites ran sequentially against the dedicated instance.
Coverage includes restart during backoff, independent issues, moved releases,
quarantine, unknown-identity budgets, retention, atomic rollback, stale-owner
fencing, concurrent collectors, cross-process quotas and native metadata changes.

```sh
devenv shell -- pnpm exec eslint server/api/trackers/diagnostics.ts server/api/trackers/torznab.ts server/api/trackers/tr4ker.ts server/api/trackers/torznab.test.ts server/api/trackers/tr4ker.test.ts server/api/trackers/types.ts server/lib/catalogue/collectionRepairs.ts server/lib/catalogue/collectionState.ts server/lib/catalogue/collectionStore.ts server/lib/catalogue/collector.ts server/lib/catalogue/collector.test.ts server/lib/catalogue/entities.ts server/lib/catalogue/types.ts server/lib/catalogue/repository.ts server/lib/catalogue/catalogue.test.ts server/lib/catalogue/migration/releaseDiagnostics.ts server/lib/catalogue/migration/sqlite/1792972800000-ReleaseDiagnostics.ts server/lib/catalogue/migration/postgres/1792972800000-ReleaseDiagnostics.ts
git diff --check
```

Modified files were formatted and checked with the repository's Prettier; targeted
lint and whitespace checks passed. Earlier runs exposed new-fixture placement,
unknown-sighting retry timing and migration-count expectations; these were corrected
before the passing runs. The terminal-only rejection regression now retains partial
coverage as required; its separate corrected-release fixture actually re-observes
the rejected release. No accepted-identity, transaction or quota assertion was weakened.

The disposable PostgreSQL cluster was stopped and removed after testing. No live
tracker calls, global lint/typecheck/format/i18n, full repository suite or build
were run. No project environment configuration, real data, staging, branches,
commits, pushes or sibling-worktree files were changed. No implementation blocker
remains. Quarantined, unknown or evicted evidence intentionally retains partial
coverage; HMAC identity across authentication-key rotation remains conservative
as documented in the README.

## Corrective pass — Historical repair boundaries and diagnostic isolation

Files changed:

- `collectionRepairs.ts`: non-repairable source diagnostics, scoped repair eligibility, explicit targeted cross-mode resolution, batched persistence, SQL aggregates and bounded eviction selection.
- `collectionState.ts`, `collectionStore.ts`, `collector.ts`: repair-state v2 upgrade, retirement of obsolete source-driven rescans, filtered-page continuity context and same-checkpoint recovery.
- `entities.ts`, `migration/diagnosticScopeIndex.ts`, `migration/{sqlite,postgres}/1792972800001-DiagnosticScopeIndex.ts`: one additive scope/state index on both engines; frozen migrations remain unchanged.
- `collector.test.ts`, `catalogue.test.ts`: focused boundary/isolation/volume regressions and four-migration down/up/history expectations.
- `README.md`, this validation record: current state transitions and validation evidence.
- `codex/catalogue/backlog.md`: clarification appended to CAT-013; this local reference remains Git-ignored and unstaged. No entries were deleted or created.

All paths above except the backlog are relative to `server/lib/catalogue/`.

Individual source-data rejections immediately retain `quarantined` diagnostics with
`source_data_unrepairable`, no retry date and no new repair attempt. Re-observation
updates occurrence history without scheduling extra requests. A later accepted
observation resolves only the same safe GUID and validated field; missing optional
data cannot resolve that field. Critical uncertainty still makes coverage partial.

Automatic scope repair requires an unresolved, evidenced collection cause: broken
continuity, repeated pages, changed pagination or an invalid checkpoint. Existing
backoff, suspension, shared quotas, Recent priority, leases and fences remain in
effect. An unusable page stays at its pending checkpoint; a rejected/filtered page
cannot invent an advanced missing region. Genuine region rescans remain capped at
three attempts and 10,000 pages each. New source anomalies never extend that budget.
Partial coverage alone never schedules a repair. Obsolete persisted source-driven
jobs stop conservatively without losing observations or fabricating terminal evidence.

Lookup, aggregates, retention and repair transitions include tracker/category/mode.
The only intentional cross-mode operation resolves a matching release diagnostic
from accepted identity/field evidence; it does not update the other mode's checkpoint,
retry counters or schedule. Concurrent response tests exercise that isolation.

Validation used the existing devenv environment, offline fixtures, temporary SQLite
files and PostgreSQL 17.9 in `/tmp/seerr-p3-boundaries-pg` on loopback port 56487.
The empty disposable control database and test-only role were used; suites created
and dropped only their own randomly named databases. PostgreSQL suites ran sequentially.

```sh
devenv shell -- env SEERR_MIGRATION_PG_DISPOSABLE=true SEERR_MIGRATION_PG_PORT=56487 SEERR_MIGRATION_PG_PASSWORD=boundaries-disposable pnpm test server/lib/catalogue/collector.test.ts server/lib/catalogue/collectionRuntime.test.ts server/job/schedule.test.ts
devenv shell -- env SEERR_MIGRATION_PG_DISPOSABLE=true SEERR_MIGRATION_PG_PORT=56487 SEERR_MIGRATION_PG_PASSWORD=boundaries-disposable pnpm test server/lib/catalogue/catalogue.test.ts server/lib/catalogue/lifecycle.test.ts server/api/trackers/torznab.test.ts server/api/trackers/tr4ker.test.ts
```

**112 P3 tests and 184 persistence/lifecycle/P2 regressions passed: 0 failed,
cancelled or skipped.** Both real SQL engines cover normal partial completion,
recurring/new rejected releases across 12 pages without extra Historical passes,
restart and legacy upgrade, configured maintenance resolution, concurrent mode
isolation, explicit cross-mode resolution, same-offset unusable/repeated page
recovery, bounded genuine repairs, metadata, identity conflicts and request budgets.

The per-page diagnostic fixture processes 100 rejections plus an accepted observation.
With 4,000 prior diagnostic rows, both engines use **12 diagnostic SQL calls** versus
**11** before seeding, the extra call resolving the relevant seeded record. No
diagnostic SELECT returns more than **100 rows**; unrelated rows/counters are
unchanged. Capacity cleanup selects only evicted rows, not the complete category.

```sh
devenv shell -- pnpm exec eslint server/lib/catalogue/collectionRepairs.ts server/lib/catalogue/collectionState.ts server/lib/catalogue/collectionStore.ts server/lib/catalogue/collector.ts server/lib/catalogue/collector.test.ts server/lib/catalogue/catalogue.test.ts server/lib/catalogue/entities.ts server/lib/catalogue/migration/diagnosticScopeIndex.ts server/lib/catalogue/migration/sqlite/1792972800001-DiagnosticScopeIndex.ts server/lib/catalogue/migration/postgres/1792972800001-DiagnosticScopeIndex.ts
git diff --check
```

Targeted lint and whitespace checks passed. All modified files were formatted and
checked with the repository's Prettier. Source-anomaly rescan fixtures were updated
to assert the newly required non-repairable behavior; the shared quota/Retry-After
fixture now uses a genuine continuity defect. Identity, metadata, transactional and
rate-limit assertions were preserved.

The disposable PostgreSQL cluster was stopped and removed after validation. No
global formatting, lint, typecheck, i18n, full repository suite, build, live tracker
request or benchmark was run. No environment configuration, real data, staging,
branch, commit, push or sibling worktree was changed. No implementation blocker
remains. Quarantined source/legacy/evicted uncertainty intentionally retains partial
coverage and is never converted into evidence of absence.
