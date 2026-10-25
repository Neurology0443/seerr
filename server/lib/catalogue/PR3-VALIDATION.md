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
