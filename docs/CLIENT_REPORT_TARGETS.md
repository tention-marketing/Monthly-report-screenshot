# Client Report Targets

Phase B stores one server-authoritative target configuration per client in `client_report_targets`. The JSONB payload is validated by `ClientReportTargets` in `packages/report-schema` before it is saved or read. It contains only durable identifiers and human-readable names—never provider credentials.

```json
{
  "businessReview": { "dashboardUrl": "https://www.klaviyo.com/analytics/dashboards/01HWZSHD83RW7CYWQ6EVVQD2BK" },
  "sourceUrls": null,
  "primarySmsList": null,
  "welcomeFlowListing": { "mode": "email_welcome_flows", "flows": [{ "id": "flow-id-1", "name": "Welcome 1", "channel": "email" }, { "id": "flow-id-2", "name": "Welcome 2", "channel": "email" }] },
  "customerSegment": { "id": "customer-segment" },
  "nonCustomerSegment": { "id": "non-customer-segment" },
  "signupForms": { "mode": "configured", "ids": ["form-id"], "names": [] }
}
```

Values are trimmed and case-insensitively de-duplicated where a list is allowed. A configured form scope needs an ID or name; a target entity needs an ID or name; customer and non-customer targets cannot be the same stable ID (or the same name when IDs are unavailable). Every source URL must be credential-free HTTPS on `klaviyo.com`; no defaults are invented.

`sourceUrls` may contain only current-product URLs: `overviewUrl`, `campaignsUrl`, `topFlowsUrl`, `businessReviewUrl`, `signupFormsUrl`, `flowsUrl`, `segmentsUrl`, and `deliverabilityUrl`. They describe per-client manual navigation sources. They do not enable automatic capture until corresponding real DOM evidence and an adapter exist; C1.1 now supplies that adapter for the fixed Klaviyo home-dashboard Overview and Top Flows captures. Both Klaviyo Home captures navigate through `overviewUrl` (`/dashboard`): Top 5 Flows' canonical source is Home → "Top performing flows" for the exact report month, not Business Review, so `businessReviewUrl`/`businessReview.dashboardUrl` is never used for Top Flows. `topFlowsUrl` remains a manual-navigation hint only and is not used by automatic capture. Signup Forms uses the all-account listing scope. Welcome Flow is a listing scope, not an individual object: the saved target records two stable IDs, names, and `channel: "email"`. The extension instructs the operator to use the listing filter and never open a form or flow. Legacy List Growth URL/list fields remain parseable only so historical records can be read; current target setup neither shows nor uses them.

## Readiness

`REPORT_CAPTURE_SPEC_V1` remains the authority for section requirements. The shared preflight maps only these client-specific capture sections to targets:

| Capture section | Target dependency |
| --- | --- |
| `signup_form_performance` | `signupForms` with `mode: "all"` |
| `welcome_flow_performance` | `welcomeFlowListing` |
| `customer_split` | `customerSegment` and `nonCustomerSegment` |
| `deliverability` | `sourceUrls.deliverabilityUrl` |

Business Review configuration improves capture reliability but does not independently block capture: the capture specification does not designate it as a target dependency. Generic sections never receive invented configuration requirements.

A required section with a missing dependency returns `missing_configuration` and `ready: false`, so a new capture run cannot start. An optional section returns `optional_not_configured`, does not block the run, and can be omitted. A disabled section returns `not_applicable`. Existing reports remain readable; this gate applies before a new capture run begins, not before review, retake, preview, or viewing history.

## API and persistence

- `GET /api/v1/clients/:clientId/report-targets` returns the configuration or an explicit empty configuration.
- `PUT /api/v1/clients/:clientId/report-targets` validates and upserts it.
- `POST /api/v1/clients/:clientId/report-readiness` accepts the report's section configuration and returns `{ ready, sections }` with deterministic per-section status and missing target names.

Migration `004_client_report_targets.sql` is additive: `client_id` is the primary key, `targets` is non-null JSONB, and `created_at`/`updated_at` are non-null timestamps. There is deliberately no client FK because report drafts currently embed client identity rather than using a client table.

## AutoLEDTech

The AutoLEDTech local development fixture includes the configured listing scopes: all Sign-up Forms and the two authorized Email Welcome rows (WN2GLE and Rex4Pp). Live Chrome showed the Forms listing with 27 forms and performance columns, and the Flows listing exposed the two relevant Email rows; the SMS row X6jdED is excluded. Capture remains human-reviewed and crop-based; neither individual forms nor flows are opened. Lists & Segments rendered as a listing, but the visible segments do not prove one canonical Customers/Non-Customers pair, so Customer Split remains unresolved. List Growth and primary-list configuration are retired from the current product. Deliverability uses only the standalone Email Deliverability Score page.
