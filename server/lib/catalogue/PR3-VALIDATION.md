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
