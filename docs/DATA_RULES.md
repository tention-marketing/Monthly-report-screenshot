# Data Rules

These rules govern all report data. Unresolved financial meanings are listed in `OPEN_DECISIONS.md` and must not be guessed.

## Complete calendar months

Reports cover complete calendar months only. Rolling 30-day periods are prohibited.

| Month | Start | End |
|---|---|---|
| 2026-07 | 2026-07-01 | 2026-07-31 |
| 2026-08 | 2026-08-01 | 2026-08-31 |

The current incomplete month cannot be finalized. On 2026-09-09, August 2026 is allowed and is the default; September 2026 is incomplete.

## Previous period

The comparison period is the immediately previous calendar month: August 2026 compares with July 2026, July with June, and January 2026 with December 2025.

## Timezone boundary

Every client has a valid IANA timezone. Completion is evaluated by converting the server's absolute current instant to the client's local calendar date, then comparing that date with the timezone-independent `{ year, month }` report identifier. UTC must never silently become the business timezone. Provider timestamp-boundary conversion remains deferred.

For example, at `2026-08-31T20:00:00Z`, the local date is September 1 in Asia/Kolkata and August 31 in America/New_York. August is complete for the former client and incomplete for the latter.

## Period integrity

The backend derives `startDate`, `endDate`, `previousStartDate`, and `previousEndDate` from `ReportMonth`. API callers cannot supply or override these boundaries. Validation rejects stored boundaries that differ from the deterministic derivation.

## Validation invariants

- A report month must be complete in the client's IANA timezone.
- Stored period boundaries must match the report month.
- Unknown section keys are errors.
- Required screenshot-backed sections need matching, approved PNG asset metadata and explicit human period confirmation.
- Optional screenshots may be absent; when present, their metadata must still match.
- Disabled-section screenshot metadata creates a warning.
- Duplicate screenshot types and client/month mismatches are errors.
- Errors block review submission; warnings do not.

Screenshot metadata proves only that the system recorded a client, report month, screenshot type, PNG asset hash, and storage key. It does not prove that the screenshot pixels visibly show that client or month. Phase 1E requires an employee to explicitly confirm the selected report period before upload; this is an audit control, not machine pixel verification.

## Stable validation issue codes

- `REPORT_MONTH_INCOMPLETE`
- `INVALID_CLIENT_TIMEZONE`
- `REPORT_PERIOD_MISMATCH`
- `SCREENSHOT_CLIENT_MISMATCH`
- `SCREENSHOT_MONTH_MISMATCH`
- `SCREENSHOT_TYPE_MISMATCH`
- `REQUIRED_SCREENSHOT_MISSING`
- `REQUIRED_SCREENSHOT_UNAPPROVED`
- `REQUIRED_SCREENSHOT_PERIOD_UNCONFIRMED`
- `REQUIRED_SCREENSHOT_ASSET_MISSING`
- `DUPLICATE_SCREENSHOT_TYPE`
- `DISABLED_SECTION_SCREENSHOT_PRESENT`
- `UNKNOWN_SECTION_CONFIGURATION`

Issues carry `error` or `warning` severity and may identify a field, section, or screenshot type. The screenshot type mismatch is enforced while metadata is upserted because a stored screenshot has one canonical type.

## Source and calculation rules

- Deterministic code calculates every numeric metric.
- AI may interpret validated metrics but cannot calculate financial values.
- Screenshots are visual evidence and are not a numeric source of truth.
- `0` means a confirmed zero, `null` means unavailable or not applicable, and an error means the fetch or calculation failed. Nulls and errors must not become zero.
- Default display counts are Top 5 Campaigns and Top 5 Flows. Ranking formulas come later.
- Provider failures and incomplete pagination must never silently become client totals.
- Internal precision is retained; rounding is a presentation concern.

No attribution, conversion, revenue, refund, currency, or provider-specific ranking formula is defined in Phase 1B.
