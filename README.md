# Tention Monthly Performance Report Extension

Production foundation for creating correct, visual monthly performance reports for the Tention internal team. Phase 1D adds the extension workflow for creating and reviewing durable report drafts; Phase 1C provides PostgreSQL storage, optimistic locking, migrations, and lifecycle history.

## Architecture

```text
Chrome extension -> typed API client -> Fastify backend
                         |
              report schema + report core
```

The backend will eventually own provider credentials, validation, calculations, report history, screenshots, and PDF generation. None of those integrations is implemented in Phase 1A.

## Workspaces

- `apps/api`: Fastify API with `/health` and `/api/v1/health`.
- `apps/extension`: Manifest V3 React report-draft workspace.
- `packages/report-schema`: Zod schemas and inferred TypeScript types.
- `packages/report-core`: deterministic calendar-month helpers.
- `packages/report-domain`: report draft services, validation, lifecycle, and repository abstraction.
- `packages/api-client`: typed backend client for health, drafts, validation, history, and lifecycle events.
- `docs`: product, data, report, and open-decision specifications.

## Prerequisites

- Node.js 20 or newer
- npm 10 or newer
- PostgreSQL for durable API storage

## Commands

```bash
npm install
npm run migrate
npm run typecheck
npm run test
npm run build
npm run dev:api
npm run dev:extension
```

Copy `.env.example` to an untracked local environment file or export `DATABASE_URL`, then run migrations explicitly before starting the API. The API does not run migrations at startup and does not silently fall back to memory if PostgreSQL is unavailable.

```bash
export DATABASE_URL=postgresql://postgres:postgres@localhost:5432/tention_reports
npm run migrate
npm run dev:api
```

`REPORT_STORAGE_MODE=memory` is available only as an explicit non-production development option. The API defaults to `http://127.0.0.1:3000`.

### Extension development

Set `VITE_API_BASE_URL` to the API origin when it differs from the local default. It is compiled into the extension bundle, so it must not contain secrets.

```bash
export REPORT_STORAGE_MODE=memory
npm run dev:api

# In a separate terminal; defaults to http://127.0.0.1:3000
VITE_API_BASE_URL=http://127.0.0.1:3000 npm run dev:extension

# Produce the unpacked-extension directory.
VITE_API_BASE_URL=http://127.0.0.1:3000 npm run build --workspace @tention/extension
```

In Chrome, open `chrome://extensions`, enable **Developer mode**, choose **Load unpacked**, and select `apps/extension/dist`. The manifest currently grants access only to `http://127.0.0.1:3000/*`; update the manifest deliberately if the configured API origin changes.

The Phase 1D workspace supports API connectivity status and retry, temporary manual client identity, timezone-aware selection of the most recent 24 completed months, per-draft section settings, durable draft creation/loading, recent drafts, the shared screenshot checklist, authoritative validation, lifecycle history, and safe version-conflict reload. Screenshot capture, image upload, provider fetching, and PDF generation are not implemented yet.

Real PostgreSQL integration tests require a dedicated `TEST_DATABASE_URL` whose database name contains `test`. These tests clear their dedicated test tables.

## Current boundaries

Klaviyo, Shopify, authentication, queues, financial calculations, provider ranking formulas, AI analysis, binary screenshot capture, image storage, and PDF generation are intentionally absent. Their data semantics remain unresolved or belong to later phases.

Read [AGENTS.md](./AGENTS.md) before changing reporting logic. Detailed requirements live in [docs/PRODUCT_SPEC.md](./docs/PRODUCT_SPEC.md), [docs/DATA_RULES.md](./docs/DATA_RULES.md), [docs/REPORT_SPEC.md](./docs/REPORT_SPEC.md), and [docs/OPEN_DECISIONS.md](./docs/OPEN_DECISIONS.md).
