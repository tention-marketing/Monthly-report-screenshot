# Report Capture Specification

## Version 1

`REPORT_CAPTURE_SPEC_V1` (version `1`) is the canonical capture contract for report visuals. It is owned in `@tention/report-schema`; the API, extension, validation gate, preview, and PDF renderer use the same contract. The report stores a source-proof record, including `captureSpecVersion`, alongside every screenshot.

The capture proof records the intended section, source family, semantic card/tab, deterministic source identity, date policy, expected period, observed period, and (when applicable) configured entity identity. It is evidence metadata, not OCR and not a substitute for human approval.

| Section | Source family | Navigation mode | Semantic target / identity | Automation status | Live evidence status |
| --- | --- | --- | --- | --- | --- |
| `executive_summary` | `klaviyo-home` | toolbar-authorized home dashboard | Business performance summary / `klaviyo-home|business-performance-summary|default` | AUTO | C1.1 `/dashboard` semantic evidence |
| `month_comparison` | `business-review` | shared dashboard + custom comparison period | Growth Overview → Message type breakdown / `business-review|growth-overview|message-type-breakdown|previous-period` | MANUAL_BY_DESIGN | Live UI can render exact current and previous ranges together; isolated probe did not render a comparison data card suitable for semantic capture |
| `top_campaigns` | `business-review` | same toolbar-authorized tab, configured Business Review | Campaign performance summary / Top performing messages / `business-review|campaign-performance|top-performing` | AUTO | C1.2 semantic evidence; first three qualifying rows |
| `top_flows` | `klaviyo-home` | same toolbar-authorized tab, Klaviyo Home (`/dashboard`) with the exact month applied through the Home Time period | Top performing flows / default / `klaviyo-home|top-performing-flows|default` | AUTO | Crops the first five usable ranked rows, or every usable row when only 1–4 exist (real count recorded, never padded); zero usable rows fails closed with `TOP_FLOWS_NO_DATA`; each row's text and Percent-change direction recorded; three byte-identical frames required |
| `campaign_performance` | `business-review` | shared dashboard + semantic tab | Campaign Performance Summary / Overview | AUTO | C1 semantic evidence |
| `campaign_metrics` | `business-review` | shared dashboard + semantic tab | Campaign Performance Summary / Metrics | AUTO | C1 semantic evidence |
| `flow_performance` | `business-review` | shared dashboard + semantic tab | Flow Performance Summary / Overview | AUTO | C1 semantic evidence |
| `flow_metrics` | `business-review` | shared dashboard + semantic tab | Flow Performance Summary / Metrics | AUTO | C1 semantic evidence |
| `signup_form_performance` | `signup-forms` | direct configured URL | Performance / all | DEFERRED | No C1 source evidence |
| `welcome_flow_performance` | `flow` | configured entity | Configured Welcome Flow / performance | DEFERRED | No C1 source evidence |
| `customer_split` | `segments` | configured entity | Configured customer split / overview | DEFERRED | No C1 source evidence |
| `deliverability` | `klaviyo-deliverability` | direct configured URL | Email Deliverability Score / `klaviyo-deliverability|deliverability-score|email` | AUTO | Standalone Score page, rolling last 30 days, score gauge and complete rate table |
| `email_subscriber_growth` (Section 10) | `klaviyo-subscriber-growth` | saved client source (`subscriberGrowthUrl`) | Subscriber growth → Email → Growth / `klaviyo-subscriber-growth|email|growth` | AUTO, per-report opt-in | Exact report month; exact Email subscribers / New subscribers / Exclusions counts; plotted line and bar charts; stable card |

`signup_form` and `welcome_flow` remain the stored wire values for backward compatibility. Their canonical capture keys clarify their semantics without changing persisted screenshot types.

`AUTO` means the retained C1 semantic engine can verify the source. The runner uses one toolbar-authorized tab: it captures the Klaviyo Home (`/dashboard`) sections first (Executive Summary, then Top 5 Flows, both navigated through the configured `sourceUrls.overviewUrl`), then navigates that same tab to the configured Business Review dashboard for its canonical captures, retaining crop/review/approval for each capture. Business Review is not a source, fallback, or proof for Top 5 Flows. `MANUAL_BY_DESIGN` means the source is known but the UI does not expose all proof needed for automatic acceptance. `DEFERRED` has no C1 source adapter.

For Month Comparison, the live Klaviyo date control supports a Custom comparison period. The local acceptance runner selects and verifies both the exact current month and immediately previous complete month in one rendered line (for example, Aug 1–31, 2026 compared to Jul 1–31, 2026). The capture uses the Growth overview card's Message type breakdown view: attributed revenue with its change vs the previous period, split into Campaigns and Flows (revenue, share, change) with the Campaigns / Flows chart. The Conversion summary view (total, attributed and unattributed revenue, total recipients) is not accepted for this section; evidence captured from it under the earlier `conversion-summary` source identity is stale and must be recaptured. Automation also requires the exact current and previous calendar-month range pair; generic comparison wording alone is insufficient. Approval and duplicate-hash checks are unchanged.

Deliverability is captured only from Klaviyo's standalone Email Deliverability Score page at `/analytics/deliverability/email/score`. It requires visible score/gauge evidence, the "Based on last 30 days of data" statement, and the Open, Click, Bounce, Unsubscribe, and Spam Complaint rate table. Its score is a rolling-window view: the source proof records no fabricated report-month period. Action Center actions are excluded from both navigation and crop selection.

Subscriber Growth (Section 10, `email_subscriber_growth`) is a new section, separate from the retired List Growth (`list_growth`, identity `list|configured-primary-list|growth`), which stays retired and is never migrated. Its canonical source is Audience → Profiles → View subscriber growth → Email → Growth. The page has no fixed route in this product: the client's `subscriberGrowthUrl` (origin + path, e.g. `/people/subscribers`; never a query) is set up once, in one transaction at the toolbar click on that page in any view or date — the extension identifies the Subscriber growth page before clicking anything, selects Email → Growth itself (tab-like controls only), waits for the three metrics, and records the clicked tab's address; the panel saves it on the client's targets only for the report client's account, confirms it by reloading the configuration, and reuses it every month. Automatic navigation waits while setup validates or saves (bounded). Each attempt reloads that source, selects Email → Growth (Overview, Text message, Opt-in sources and Exclusion sources are rejected), sets and proves the exact report month, and accepts the card only when the three counts are exact whole numbers, both charts are plotted, no spinner or skeleton remains, and three samples 500 ms apart are identical. The proof carries the structured counts (`subscriberGrowth`). Section 10 is opt-in per report: reports created before it keep exactly the nine core sections until it is enabled explicitly. The PDF renders it on its own page after the nine core sections.

## Client target preflight

The capture contract also drives client-target readiness. Only `signup_form_performance`, `welcome_flow_performance`, `customer_split`, and `deliverability` require saved client targets; their mappings and required-versus-optional behavior are documented in [Client Report Targets](CLIENT_REPORT_TARGETS.md). Business Review configuration is useful context but is not itself a blocking dependency in this version of the capture specification. List Growth is retired from the current product; legacy records remain readable but are not part of this contract.

## Enforcement

An enabled screenshot must have source proof exactly matching its type's specification. Month-scoped captures must record the report's current period; the comparison capture must additionally record the previous complete calendar month. Rolling and static views intentionally have no fabricated report-month proof.

The upload endpoint rejects mismatched or malformed proof, and rejects a byte-identical SHA-256 asset if it is being attached to a different enabled capture section. Replacements for the same screenshot type remain allowed and retain version-locking behavior.

Validation repeats those checks for all persisted reports. Preview and PDF generation construct their model only after this validation succeeds, so an invalid or duplicated visual cannot reach the PDF. This is a correctness gate; it does not automate navigation or infer a screenshot's UI content.

Visual similarity alone is not a hard failure in version 1. Different cards and tabs can legitimately look similar; only an exact cross-section SHA-256 match or a mismatched source identity blocks capture. Perceptual similarity warnings are deliberately deferred.

Existing screenshots that lack source proof—or whose proof belongs to a superseded canonical source identity—are retained but cannot newly pass review, preview, or PDF validation. They appear as stale and must be recaptured through the documented capture flow; no lifecycle history, file, or provenance is synthesized or rewritten.


### Top 5 Flows source change (2026-10-26)

The product owner confirmed Klaviyo Home → "Top performing flows" as the canonical Top 5 Flows source. The former Business Review → Flow performance summary → Top performing view is retired for this section: it ranks by Conversion Value across all flows (it surfaced a Draft flow at #1), while the Home card lists the ranked rows the report must show. Existing evidence with the old `business-review|flow-performance|top-performing` identity is stale and must be recaptured; the capture spec version was not bumped, so other sections' evidence is unaffected.

Canonical path: Klaviyo Home → `/dashboard` → "Top performing flows" card (default view), with the exact report month applied through the Home Time period control. The Home adapter requires the `/dashboard` route, the card heading, the exact report period on the card, the Flow / Status / Type / Deliveries / Placed Order / Percent change header, and visible Live flow rows. It never clicks a flow name or opens Flow Builder.

Row count rule:

- 5 or more usable rows: capture exactly the first five.
- 1–4 usable rows: capture automatically, including every real row; the review screen and diagnostics report the actual count (`includedRowCount`/`usableRowCount`). Manual capture is not forced and no rows are invented.
- 0 usable rows: fail closed with the typed `TOP_FLOWS_NO_DATA` result. Nothing is captured.

Ranking stays Klaviyo's own order on the Home card; the extension only selects the leading rows and does not re-rank.
