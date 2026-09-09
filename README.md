# Tention Monthly Performance Report Extension

Production foundation for creating correct, visual monthly performance reports for the Tention internal team. Phase 1B adds the report draft domain, validation, lifecycle, timezone-aware month completion, metadata rules, and development API endpoints.

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

## Commands

```bash
npm install
npm run typecheck
npm run test
npm run build
npm run dev:api
npm run dev:extension
```

The API defaults to `http://localhost:3000`. For extension development, run the Vite build and load `apps/extension/dist` as an unpacked extension in Chrome.

## Current boundaries

Klaviyo, Shopify, authentication, production persistence, queues, financial calculations, provider ranking formulas, AI analysis, binary screenshot capture, and PDF generation are intentionally absent. Their data semantics remain unresolved or belong to later phases.

Read [AGENTS.md](./AGENTS.md) before changing reporting logic. Detailed requirements live in [docs/PRODUCT_SPEC.md](./docs/PRODUCT_SPEC.md), [docs/DATA_RULES.md](./docs/DATA_RULES.md), [docs/REPORT_SPEC.md](./docs/REPORT_SPEC.md), and [docs/OPEN_DECISIONS.md](./docs/OPEN_DECISIONS.md).
