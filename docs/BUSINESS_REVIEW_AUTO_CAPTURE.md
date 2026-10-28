# Business Review Semantic Auto-Capture (C1)

Phase C1 enhances, but does not replace, the Phase A capture gate. It uses the existing toolbar-authorized Klaviyo Business Review tab and `captureVisibleTab` pipeline. No new tabs are created for automatic capture, and manual capture remains available for every section.

## Supported semantic targets

| Stored screenshot type | Canonical section | Card | Required semantic state |
| --- | --- | --- | --- |
| `month_comparison` | `month_comparison` | Growth Overview → Message type breakdown | Campaigns / Flows attributed-revenue split plus exact previous-month proof; Conversion summary is rejected |
| `campaign_performance` | `campaign_performance` | Campaign Performance Summary | Overview tab selected |
| `campaign_metrics` | `campaign_metrics` | Campaign Performance Summary | Metrics tab selected |
| `flow_performance` | `flow_performance` | Flow Performance Summary | Overview tab selected |
| `flow_metrics` | `flow_metrics` | Flow Performance Summary | Metrics tab selected |

The adapter uses the Business Review dashboard route, accessible headings/navigation, ARIA tabs with `aria-selected`, and exact configured aliases. It does not use generated CSS classes, test IDs, OCR, or financial-value parsing. If a card, tab, selected state, exact current period, exact comparison period, visibility, or stable layout cannot be proven, it returns a typed failure and leaves manual capture available.

For each exact-month target the adapter opens/verifies the Time Period control, applies the report start/end dates when necessary, then re-reads the live control. It re-finds cards after Apply and tab changes, scrolls the current live card into view, and requires two consecutive bounded-frame geometry reads before capture. Month Comparison additionally requires visible evidence of the exact immediately preceding completed month.

`Start Automatic Capture` currently runs the four AUTO targets: Campaign Performance, Campaign Metrics, Flow Performance, and Flow Metrics. Month Comparison remains in the semantic engine but is MANUAL_BY_DESIGN until its live state exposes exact previous-month dates. Each automatic target is captured and cropped only after semantic verification; the employee must still use **Confirm & Continue** to upload it. This preserves version locking, Phase A source proof, source-identity, date-policy, SHA-256 duplicate, and later review rules. Failed sections remain isolated and can be retried or captured manually; earlier successful captures are not replaced.

The configured `businessReview.dashboardUrl`, if present, populates the manual Open Klaviyo field. It is not a global dashboard ID and automatic capture still requires the explicit toolbar grant on the authoritative active tab.

## Reclassified and deferred targets

Executive Summary is `klaviyo-home|business-performance-summary|default` and Top Campaigns is `campaigns|campaigns-list|default`. They are MANUAL_REQUIRED pending real source URL, semantic DOM, date-control, and capture-bounds evidence. C1 does not reuse Business Review for either of them.

Top 5 Flows is not a Business Review target. Its canonical source (2026-10-26) is Klaviyo Home → `/dashboard` → "Top performing flows" (default view), identity `klaviyo-home|top-performing-flows|default`, captured AUTO by the Home dashboard adapter for the exact report month. The former Business Review → Flow performance summary → "Top performing" view is retired: the Business Review adapter no longer accepts `top_flows`, and evidence with the old `business-review|flow-performance|top-performing` identity is stale. The Home adapter crops the first five usable rows, or all 1–4 real rows when fewer exist, and fails closed with `TOP_FLOWS_NO_DATA` when there are none. See `docs/REPORT_CAPTURE_SPEC.md`.

Signup Forms, Welcome Flow, and Customer Split have no C1 automatic adapter. Deliverability has a separate direct Score-page adapter; it does not use Business Review. List Growth is retired from the current product.
