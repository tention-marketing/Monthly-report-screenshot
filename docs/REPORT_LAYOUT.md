# REPORT_LAYOUT_V1

`apps/api/src/reports/report-layout.ts` owns the versioned PDF information architecture. Its version is `tention-monthly-v1` and is stored as the PDF artifact template version.

This is deliberately separate from `REPORT_CAPTURE_SPEC_V1`:

- Capture spec answers where an approved screenshot came from and how its period/source proof is validated.
- Layout answers where approved content appears in the final report.
- `ReportDocumentModel` resolves a particular report's approved screenshot assets and typed content into those layout slots.

| Canonical page | Slots |
| --- | --- |
| 1 - Summary | headline metrics, Overview (`executive_summary`), Top Campaigns (`top_campaigns`) |
| 2 | Top Flows (`top_flows`), Comparison to Previous Month (`month_comparison`) |
| 3 | Campaigns (`campaign_performance`), Flows (`flow_performance`) |
| 4 | Sign Up Form, Welcome Flow, Customers vs Non Customers, Deliverability |
| 5 | Metric Performance - Campaigns (`campaign_metrics`) |
| 6 | Metric Performance - Flows (`flow_metrics`), Analysis start |
| 7 | Analysis continuation, when text flows beyond page 6 |

List Growth is retired from the current product and has no layout slot or PDF page. Historical records remain readable, but cannot add a current-report page. The renderer omits absent optional slots and any page with no renderable content. It contains approved PNG assets with `object-fit: contain`; it does not crop, stretch, OCR, or derive values from them.

Headline metrics, analysis blocks, and the next-month plan are typed `ReportDocumentContent` fields. They are absent by default. A null metric is omitted, not converted to zero. Analysis and the plan render only when the supplied typed content is approved. Supplying such content is a separate authoritative-data/manual-approval concern and is intentionally not implemented by the capture or renderer code.
