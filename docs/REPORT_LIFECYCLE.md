# Report Lifecycle

Report status changes occur only through domain events. Direct status mutation is not an API operation.

Creation records an append-only `REPORT_CREATED` history entry at report version 1. Every successful lifecycle transition increments the report version once and writes its history entry in the same PostgreSQL transaction. Illegal transitions and version conflicts change neither the report nor its history.

| Current state | Event | Next state | Guard |
|---|---|---|---|
| `draft` | `START_DATA_FETCH` | `data_fetching` | — |
| `draft` | `SUBMIT_FOR_REVIEW` | `ready_for_review` | No validation errors; capture-only workflow |
| `data_fetching` | `DATA_FETCH_SUCCEEDED` | `data_ready` | — |
| `data_fetching` | `DATA_FETCH_FAILED` | `failed` | — |
| `data_ready` | `MARK_CAPTURES_INCOMPLETE` | `captures_incomplete` | — |
| `data_ready` | `SUBMIT_FOR_REVIEW` | `ready_for_review` | No validation errors |
| `captures_incomplete` | `SUBMIT_FOR_REVIEW` | `ready_for_review` | No validation errors |
| `ready_for_review` | `MARK_CAPTURES_INCOMPLETE` | `captures_incomplete` | A required screenshot is replaced |
| `ready_for_review` | `START_GENERATION` | `generating` | Valid capture review; API-managed PDF generation only |
| `approved` | `START_GENERATION` | `generating` | Legacy compatibility only |
| `generating` | `GENERATION_SUCCEEDED` | `generated` | — |
| `generating` | `GENERATION_FAILED` | `failed` | — |
| `generated` | `MIGRATE_LEGACY_GENERATED_CAPTURE_REVIEW` | `ready_for_review` | Valid capture-only report created before PDF generation exists |
| `generated` | `MARK_CAPTURES_INCOMPLETE` | `captures_incomplete` | A required screenshot is replaced; prior PDF is stale |
| `failed` | `RESET_TO_DRAFT` | `draft` | Explicit reset only |
| `failed` | `START_GENERATION` | `generating` | Valid retained capture review; API-managed retry only |

`generated` means a real, persisted PDF artifact exists for the current deterministic source fingerprint; it is not a capture-complete status. Phase 1 exposed simulation controls before PDF generation existed, so already-persisted capture-only reports may have reached `generated` without a PDF. The migration event is the only compatibility path: it is validation-gated, writes an explicit lifecycle entry, and moves the report to `ready_for_review`. New UI flows do not expose generation simulation controls.

All other state/event combinations return a typed `ILLEGAL_REPORT_TRANSITION` domain error. `SUBMIT_FOR_REVIEW` runs authoritative domain validation; errors return `REPORT_VALIDATION_FAILED` with inspectable validation issues, while warnings permit transition. `START_GENERATION`, `GENERATION_SUCCEEDED`, and `GENERATION_FAILED` are API-managed PDF-generation events and cannot be invoked through the generic lifecycle endpoint. Replacing a required screenshot after submission writes the documented `MARK_CAPTURES_INCOMPLETE` event atomically with the replacement, so the prior capture review cannot be reused for the new screenshot set; any older artifact remains historical and no longer matches the current source fingerprint.
