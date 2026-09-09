# Report Specification

The future monthly report uses one reusable, configurable master structure across more than 100 clients.

## Default sections

1. Executive Summary
2. Top 3 Campaigns
3. Top 5 Flows
4. Comparison to Previous Month
5. Signup Form Performance
6. Welcome Flow Performance
7. Customers vs Non-Customers
8. Deliverability
9. Campaign Metrics
10. Flow Metrics
11. List Growth
12. Analysis
13. Next Month's Plan

Not every client requires every section. Each report draft carries its own section configuration, with `required`, `optional`, or `disabled` for each configured section. The schema does not impose one universal client configuration.

## Screenshot mapping

| Screenshot type | Report section |
|---|---|
| `overview` | `executive_summary` |
| `top_campaigns` | `top_campaigns` |
| `top_flows` | `top_flows` |
| `month_comparison` | `month_comparison` |
| `campaign_performance` | `campaign_performance` |
| `flow_performance` | `flow_performance` |
| `signup_form` | `signup_form` |
| `welcome_flow` | `welcome_flow` |
| `customer_split` | `customer_split` |
| `deliverability` | `deliverability` |
| `campaign_metrics` | `campaign_metrics` |
| `flow_metrics` | `flow_metrics` |
| `list_growth` | `list_growth` |

`analysis` and `next_month_plan` have no screenshot type. The mapping is defined once in the shared report schema and consumed by domain validation.

The report should be visual, easy to skim, friendly to tightly cropped screenshots, and free of long text blocks and accidental blank pages. Structured validated data supplies numeric values; approved screenshots supply visual context. AI narrative, if enabled later, receives only validated data.

PDF rendering, binary screenshot capture, preview, template versioning, and finalization are not implemented in Phase 1B.
