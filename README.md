# Tention Monthly Performance Report Extension

Production foundation for creating correct, visual monthly performance reports for the Tention internal team. Phase 1C adds durable PostgreSQL storage, optimistic locking, migrations, and lifecycle history.

## Architecture

```text
Chrome extension -> typed API client -> Fastify backend
                         |
              report schema + report core
```

The backend will eventually own provider credentials, validation, calculations, report history, screenshots, and PDF generation. None of those integrations is implemented in Phase 1A.

## Workspaces

- `apps/api`: Fastify API with `/health` and `/api/v1/health`.
- `apps/extension`: minimal Manifest V3 React extension.
- `packages/report-schema`: Zod schemas and inferred TypeScript types.
- `packages/report-core`: deterministic calendar-month helpers.
- `packages/report-domain`: report draft services, validation, lifecycle, and repository abstraction.
- `packages/api-client`: typed backend health client.
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

`REPORT_STORAGE_MODE=memory` is available only as an explicit non-production development option. The API defaults to `http://localhost:3000`. For extension development, run the Vite build and load `apps/extension/dist` as an unpacked extension in Chrome.

Real PostgreSQL integration tests require a dedicated `TEST_DATABASE_URL` whose database name contains `test`. These tests clear their dedicated test tables.

## Current boundaries

Klaviyo, Shopify, authentication, queues, financial calculations, provider ranking formulas, AI analysis, binary screenshot capture, image storage, and PDF generation are intentionally absent. Their data semantics remain unresolved or belong to later phases.

Read [AGENTS.md](./AGENTS.md) before changing reporting logic. Detailed requirements live in [docs/PRODUCT_SPEC.md](./docs/PRODUCT_SPEC.md), [docs/DATA_RULES.md](./docs/DATA_RULES.md), [docs/REPORT_SPEC.md](./docs/REPORT_SPEC.md), and [docs/OPEN_DECISIONS.md](./docs/OPEN_DECISIONS.md).
