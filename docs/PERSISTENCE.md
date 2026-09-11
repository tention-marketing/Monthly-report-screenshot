# Report Persistence

Phase 1C stores report drafts and lifecycle history in PostgreSQL using parameterized SQL through `pg`. Domain services remain independent of PostgreSQL through `ReportDraftRepository`.

## Tables

`report_drafts` stores searchable identity and guard fields in columns, business period boundaries as `DATE`, audit timestamps as `TIMESTAMPTZ`, and sections, screenshots, and validation as schema-checked `JSONB`.

`report_lifecycle_events` stores append-only application history with event type, before/after status, report version, absolute creation instant, and optional non-financial metadata. History sorts by timestamp, then report version, then event ID, so equal timestamps remain deterministic and preserve lifecycle order.

`schema_migrations` records applied migration filenames and timestamps. Migrations run in filename order, skip recorded versions, stop on failure, and require the explicit `npm run migrate` command.

## Immutable identity

The report ID, client ID, report year/month, and creation timestamp cannot change after creation. PostgreSQL enforces one draft for each client ID and report year/month. Future generated-report revisions require a separate design.

## Optimistic locking

Drafts start at version 1. Screenshot metadata changes and lifecycle transitions require the caller's `expectedVersion` and increment exactly once. Updates compare both ID and version in SQL. A stale writer receives `REPORT_VERSION_CONFLICT` with expected and current versions; changes are never silently overwritten.

## Transaction boundaries

Draft creation and `REPORT_CREATED` history are one transaction. A lifecycle mutation updates status/version and appends history in one transaction. Screenshot metadata uses one atomic compare-and-swap `UPDATE`. Failed writes roll back.

## Data boundaries

Rows are parsed through shared Zod schemas before becoming trusted domain objects. Invalid persisted JSON or columns produce `PERSISTENCE_DATA_INVALID`; the application does not repair them silently.

Calendar reporting boundaries use PostgreSQL `DATE` and round-trip as `YYYY-MM-DD`. Creation, update, and lifecycle audit instants use `TIMESTAMPTZ` and serialize as ISO timestamps.

## Storage selection

`DATABASE_URL` selects PostgreSQL. A configured but unavailable database fails loudly. Memory mode requires explicit `REPORT_STORAGE_MODE=memory` and is non-production. There is no fallback from PostgreSQL to memory.

## Screenshot assets

Phase 1E keeps the current screenshot metadata in `report_drafts.screenshots` and stores the PNG binary through a `ScreenshotStorage` adapter. The local filesystem adapter is explicitly DEVELOPMENT / NON-PRODUCTION storage; `SCREENSHOT_STORAGE_DIR` defaults to `./data/screenshots`, which is gitignored. Server-generated keys use `reports/{reportId}/{screenshotType}/{assetId}.png`; client paths, IDs, report months, dimensions, storage keys, and hashes are never trusted.

The API accepts only PNG uploads up to 10 MB, derives identity and dimensions from the report/PNG, records a SHA-256 digest, and requires `periodConfirmed=true` before it writes approved metadata. The prior metadata-only approval route is removed.

Filesystem writes and database compare-and-swap updates are not one ACID transaction. The service writes a unique new asset, performs the versioned metadata update, deletes the new asset best-effort if that update fails, and deletes an old replaced asset best-effort only after success. A process crash can leave an orphan asset; reconciliation is deferred.

## Draft deletion

Development report deletion requires the caller's current `expectedVersion`. PostgreSQL locks the draft row, verifies its version, then deletes its report-owned lifecycle rows and draft in one transaction. The lifecycle foreign key does not use a global cascade; dependent history is explicitly deleted only for the selected report.

After the transaction commits, the API best-effort deletes the selected report's recorded screenshot storage keys. Asset cleanup is deliberately after database success because filesystem deletion is not transactional. A cleanup failure is logged and does not restore the deleted draft; a failed database deletion leaves assets intact.

## Current limitations

There is no authentication, production object storage, backup policy, financial data snapshot, screenshot revision history, or report revision model. Real PostgreSQL tests require a safe dedicated database through `TEST_DATABASE_URL`.
