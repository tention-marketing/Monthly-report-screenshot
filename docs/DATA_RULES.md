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

Report timestamps must eventually be bounded in the client/provider account timezone. UTC must never silently become the business timezone. Phase 1A helpers use a timezone-independent `{ year, month }` identifier and ISO calendar dates; provider timestamp conversion is deferred.

## Source and calculation rules

- Deterministic code calculates every numeric metric.
- AI may interpret validated metrics but cannot calculate financial values.
- Screenshots are visual evidence and are not a numeric source of truth.
- `0` means a confirmed zero, `null` means unavailable or not applicable, and an error means the fetch or calculation failed. Nulls and errors must not become zero.
- Default display counts are Top 3 Campaigns and Top 5 Flows. Ranking formulas come later.
- Provider failures and incomplete pagination must never silently become client totals.
- Internal precision is retained; rounding is a presentation concern.

No attribution, conversion, revenue, refund, currency, or ranking formula is defined in Phase 1A.
