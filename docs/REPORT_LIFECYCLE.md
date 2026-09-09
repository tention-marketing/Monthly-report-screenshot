# Report Lifecycle

Report status changes occur only through domain events. Direct status mutation is not an API operation.

| Current state | Event | Next state | Guard |
|---|---|---|---|
| `draft` | `START_DATA_FETCH` | `data_fetching` | — |
| `data_fetching` | `DATA_FETCH_SUCCEEDED` | `data_ready` | — |
| `data_fetching` | `DATA_FETCH_FAILED` | `failed` | — |
| `data_ready` | `MARK_CAPTURES_INCOMPLETE` | `captures_incomplete` | — |
| `data_ready` | `SUBMIT_FOR_REVIEW` | `ready_for_review` | No validation errors |
| `captures_incomplete` | `SUBMIT_FOR_REVIEW` | `ready_for_review` | No validation errors |
| `ready_for_review` | `APPROVE` | `approved` | — |
| `approved` | `START_GENERATION` | `generating` | — |
| `generating` | `GENERATION_SUCCEEDED` | `generated` | — |
| `generating` | `GENERATION_FAILED` | `failed` | — |
| `failed` | `RESET_TO_DRAFT` | `draft` | Explicit reset only |

All other state/event combinations return a typed `ILLEGAL_REPORT_TRANSITION` domain error. `SUBMIT_FOR_REVIEW` runs authoritative domain validation; errors return `REPORT_VALIDATION_FAILED` with inspectable validation issues, while warnings permit transition.
