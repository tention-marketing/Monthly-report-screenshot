AGENTS.md — Tention Monthly Performance Report Extension

0. Purpose

This file is the source-of-truth implementation brief for the Tention monthly reporting product.

The highest priority is data correctness. Visual polish, automation, screenshots, and AI are all secondary to producing the correct numbers for the correct client and the correct completed calendar month.

Claude/code agents working in this repository must:

Read this file before changing reporting logic.

Audit the existing code before rewriting anything.

Preserve existing verified data logic unless a test proves it is wrong.

Never guess metric definitions, date ranges, provider semantics, or attribution logic.

Stop and report uncertainty when a data rule is not explicitly defined.

Separate numeric calculation from AI-generated narrative.

Add tests for every financial/date/ranking rule that changes.

Prefer small, reviewable changes over broad rewrites.

1. What we are building right now

We are building an internal Tention Chrome extension + backend reporting system that helps the Tention team generate monthly client performance PDFs.

We are not building a separate public website in V1.

The Chrome extension is the team-facing interface. It may also open a full-page extension dashboard for a larger workspace.

The backend remains responsible for data, calculations, storage, report generation, and security.

Tention team member
        |
        v
Chrome Extension
        |
        +--> choose client
        +--> choose completed report month
        +--> guided Klaviyo screenshot capture
        +--> review screenshot checklist
        +--> preview report
        +--> generate final PDF
        |
        v
Tention Backend
        |
        +--> existing verified reporting/data engine
        +--> provider APIs
        +--> deterministic calculations
        +--> report JSON
        +--> screenshot storage
        +--> optional AI narrative
        +--> HTML/CSS report renderer
        +--> PDF generator
        |
        v
Final monthly PDF

The system is for an agency workflow with 100+ client accounts, so the architecture must support reuse, consistency, retries, history, and future batch generation.

2. V1 product goal

A Tention employee should be able to:

Open the extension.

Select a client.

Select a completed calendar month.

Fetch/verify report data.

Follow a guided checklist to capture the required Klaviyo screens.

Review or retake screenshots.

Add/edit the account manager's next-month plan.

Preview the report.

Generate the PDF.

Download/open the final PDF.

Target workflow:

Select client
    ↓
Select month
    ↓
Fetch validated data
    ↓
Capture required Klaviyo sections
    ↓
Review
    ↓
Preview
    ↓
Generate PDF

The extension should reduce repetitive report preparation while keeping a human review step before the client-facing PDF is finalized.

3. Core product principles

3.1 Data correctness comes first

The final report must never:

use the wrong month,

mix two reporting periods,

mix two clients,

silently change attribution definitions,

calculate financial metrics through an LLM,

OCR financial values from screenshots when structured data exists,

invent missing numbers,

reuse a screenshot from the wrong reporting period,

silently fall back to partial data,

label a metric as "email" if it actually includes SMS,

show a percentage comparison whose source period is unclear.

If a required metric cannot be verified, the report must be blocked or clearly marked incomplete.

3.2 API/data is the numeric source of truth

Screenshots are visual evidence and context.

They are not the numeric source of truth when the same value is available through a structured source.

Correct:

Provider/API/database
        ↓
validated deterministic calculations
        ↓
report JSON
        ↓
PDF

Incorrect:

Screenshot
   ↓
OCR/AI
   ↓
financial calculation

3.3 AI interprets; code calculates

Code must calculate all quantitative metrics, including:

revenue,

attributed revenue,

campaign revenue,

flow revenue,

recipients,

percentages,

month-over-month change,

top campaigns,

top flows,

revenue per recipient,

average order value,

list growth,

customer/non-customer counts,

deliverability metrics.

AI may produce:

concise observations,

wins,

opportunities,

recommended actions,

executive summary copy,

draft next-month commentary if explicitly enabled.

AI output must only use validated values passed to it.

4. Reporting period — LOCKED

Monthly reports use complete calendar months only.

No rolling 30-day windows.

Examples:

July 2026       = 2026-07-01 through 2026-07-31
August 2026     = 2026-08-01 through 2026-08-31
September 2026  = 2026-09-01 through 2026-09-30
February 2028   = 2028-02-01 through 2028-02-29

The user selects only:

Month + Year

The system computes the exact first and last day automatically.

4.1 Completed months only

Default selected month = the most recently completed calendar month.

If today is September 9, 2026:

August 2026     allowed and default
July 2026       allowed
June 2026       allowed
September 2026  blocked/incomplete

V1 final reports are completed months only.

4.2 Previous-month comparison

Comparison is always the immediately previous complete calendar month.

Examples:

Report: August 1-31
Compare: July 1-31

Report: July 1-31
Compare: June 1-30

Report: March 1-31
Compare: February 1-28/29

Do not implement "previous 30 days".

4.3 Timezone

Month boundaries must be evaluated in the client/provider account timezone, not server UTC.

Proposed default:

Use Klaviyo account timezone for Klaviyo reporting data.

If Shopify is used, use the store timezone and explicitly reconcile any mismatch.

Never silently include/exclude data from the wrong local date.

If existing verified code uses another policy, document it before changing it.

5. Previous-month screenshot rule

For a July 2026 report, the Klaviyo comparison screenshot should show:

Jul 1, 2026 - Jul 31, 2026
compared to previous period

The visible chart is July performance.

Percentage deltas are July compared with June.

Example:

Attributed revenue $8,459.00 = current selected month
Campaigns $3.38K             = current selected month
Flows $5.08K                 = current selected month

+23.8% = current month vs previous month
+27.3% = current campaign revenue vs previous month
+21.5% = current flow revenue vs previous month

Never describe those deltas as current-month totals.

6. Existing report logic — reuse before rewrite

There is already a monthly report/data pipeline.

Do not rebuild verified provider integrations and calculations simply because a new extension or PDF layout is being added.

Before changing data logic:

Locate the current report-generation code.

Identify all provider calls.

Identify all metric definitions.

Identify date-range logic.

Identify previous-month logic.

Identify attribution/conversion metric configuration.

Run current tests.

Compare representative output against provider UI.

Document discrepancies.

Change only what is necessary.

Preferred approach:

Existing verified data engine
          ↓
normalized Report JSON
          ↓
new extension + new PDF presentation layer

7. Conversion metric / attribution — DATA-CRITICAL

The report must use the intended conversion metric consistently across all sections.

The example report currently shows a Klaviyo conversion metric similar to:

PLACED ORDER - SUBSCRIPTION EXCLUDED

Do not assume this is correct for every client until product rules are confirmed.

Support explicit configuration when needed:

{
  "conversionMetricId": "provider_metric_id",
  "conversionMetricLabel": "Placed Order - Subscription Excluded"
}

Never identify a conversion metric only by display text when a stable provider ID exists.

Never silently switch to a different Placed Order event.

Never combine values calculated with different conversion metrics.

8. Metric naming — DATA-CRITICAL

Labels must match what the value actually represents.

Example:

Email attributed revenue = $6,227.70
SMS attributed revenue   = $2,231.30
Combined                 = $8,459.00

If $8,459.00 is combined, it must not be labeled "Total Email Attributed Revenue".

Use an approved label such as:

Total Attributed Revenue
Klaviyo Attributed Revenue
Email + SMS Attributed Revenue

If the product truly wants "Email Attributed Revenue", calculate email only.

Apply the same rule to every metric.

9. Report data contract

The backend produces normalized report data before rendering.

Illustrative shape:

{
  "reportId": "uuid",
  "client": {
    "id": "uuid",
    "name": "Client Name",
    "timezone": "client_timezone",
    "currency": "USD"
  },
  "period": {
    "month": "2026-07",
    "startDate": "2026-07-01",
    "endDate": "2026-07-31",
    "previousStartDate": "2026-06-01",
    "previousEndDate": "2026-06-30"
  },
  "metricDefinition": {
    "conversionMetricId": "...",
    "conversionMetricLabel": "..."
  },
  "overview": {},
  "campaigns": {
    "top": []
  },
  "flows": {
    "top": []
  },
  "deliverability": {},
  "listGrowth": {},
  "customers": {},
  "forms": {},
  "screenshots": {},
  "insights": {},
  "nextMonthPlan": null,
  "validation": {
    "status": "pending",
    "errors": [],
    "warnings": []
  }
}

This shape is illustrative. Reuse the real existing model when appropriate.

10. Top Campaigns

V1 default:

Top Campaigns = 3

Ranking is deterministic.

Default:

revenue descending

Do not let AI choose top campaigns.

11. Top Flows — LOCKED

V1 must display:

Top Flows = 5

when at least five qualifying flows exist.

Default ranking:

revenue descending

If fewer than five qualifying flows exist, show the actual count.

Do not display the entire flow list.

Do not let AI choose top flows.

12. Screenshot-driven sections

V1 should support guided captures for:

Overview / Business Performance Summary

Top Campaigns

Top 5 Flows

Comparison to Previous Month

Campaign Performance Summary

Flow Performance Summary

Signup Form Performance

Welcome Flow Performance

Customers vs Non-Customers

Deliverability Score

Campaign Metric Performance

Flow Metric Performance

List Growth

Not every client needs every section.

Required/optional/disabled status must be configurable.

13. Screenshot capture — V1

V1 should prioritize reliability over fragile full automation.

Recommended:

Open correct Klaviyo page
        ↓
Extension shows required section
        ↓
User clicks Capture
        ↓
Capture visible tab
        ↓
Select/confirm crop
        ↓
Preview
        ↓
Retake / Crop / Approve
        ↓
Upload to report

Screenshot modes

A. Guided manual region capture — required

This remains usable even if Klaviyo changes layout.

B. Automatic known-section crop — optional later

The extension may preselect a stable component.

The user still approves.

C. Stitched long capture — later

For sections taller than the viewport:

capture
scroll
capture
stitch

Do not make this a V1 dependency unless proven reliable.

14. Screenshot quality

Do not place full-browser screenshots into tiny PDF boxes.

Crop tightly around the relevant Klaviyo card, chart, or table.

Each screenshot should store:

{
  "type": "top_campaigns",
  "clientId": "uuid",
  "reportMonth": "2026-07",
  "capturedAt": "timestamp",
  "sourceUrl": "https://...",
  "width": 1440,
  "height": 720,
  "approved": true
}

Before final generation verify:

correct client,

correct report month,

correct screenshot type,

required screenshots present,

screenshot approved.

Wrong-month screenshots must block finalization or create a hard warning requiring correction.

15. Chrome extension responsibilities

The extension may:

authenticate Tention team member,

select client,

select completed month,

display report status,

guide capture sequence,

capture visible tab,

crop screenshot,

preview screenshot,

retake screenshot,

approve screenshot,

upload screenshot,

show missing-section checklist,

edit next-month plan,

request report preview,

request PDF generation,

open/download generated PDF,

open a full-page extension dashboard.

The extension must not contain provider private API keys.

16. Backend responsibilities

The backend owns:

provider credentials,

secure credential storage,

API requests,

retries,

pagination,

rate-limit handling,

data normalization,

financial calculations,

date-range calculations,

previous-month calculations,

validation,

screenshot storage,

report state,

report JSON,

AI prompt execution,

HTML rendering,

PDF generation,

report history,

future queue/batch processing.

17. Security — LOCKED

Never ship these in extension source code:

Klaviyo private API keys,

Shopify Admin tokens,

OpenAI/Anthropic keys,

database credentials,

storage secrets.

Correct flow:

Extension
   ↓ authenticated Tention request
Backend
   ↓
encrypted provider credentials
   ↓
Provider API

Do not log secrets.

18. PDF generation

Preferred pipeline:

Report JSON
   ↓
HTML/React master report template
   ↓
CSS print styles
   ↓
Playwright/Chromium
   ↓
PDF

If an existing verified PDF renderer already works well, do not replace it without a concrete reason.

19. PDF design direction

The report should remain highly visual and screenshot-friendly.

Recommended structure:

Executive Summary

client name,

complete calendar month,

total revenue,

attributed revenue,

campaign revenue,

flow revenue,

key MoM deltas,

overview screenshot.

Top Campaigns

Top 3,

screenshot,

concise metrics.

Top Flows

Top 5,

screenshot,

concise metrics.

Month Comparison

current complete month,

previous complete month,

comparison screenshot,

campaign and flow summary.

Supporting Performance

Configurable:

signup forms,

welcome flow,

customers vs non-customers,

deliverability,

campaign metrics,

flow metrics,

list growth.

Analysis + Next Month Plan

Default:

3 wins,

2 opportunities,

3 next actions,

Account Manager next-month plan.

Avoid walls of text and unnecessary blank pages.

20. Next Month's Plan

V1 recommendation:

Account Manager text is authoritative.

Field is editable before final PDF generation.

AI may optionally draft.

AI never overwrites approved human input.

Do not create a mostly blank standalone page for this section.

21. Report states

Suggested:

draft
data_fetching
data_ready
captures_incomplete
ready_for_review
approved
generating
generated
failed

Backend determines readiness.

22. Validation gates before PDF generation

Final PDF generation requires:

Client

valid client,

provider connection belongs to client.

Period

month complete,

exact start/end resolved,

previous month resolved,

timezone resolved.

Data

provider requests succeeded,

required metrics present,

pagination complete,

currency known,

conversion metric known,

no unresolved calculation errors.

Ranking

campaigns deterministic,

flows deterministic,

Top Flows max 5.

Screenshots

required types present,

correct client,

correct month,

approved.

Narrative

no unsupported AI numbers,

AM plan approved if required.

Generation

report JSON snapshot frozen,

template version recorded.

23. Report snapshots/history

For each generated report store:

report_id
client_id
report_month
period_start
period_end
previous_period_start
previous_period_end
timezone
currency
conversion_metric_id
conversion_metric_label
report_data_snapshot
screenshot references
template_version
generated_at
generated_by
pdf_location
validation status

Provider data can change later, so historical reports need an immutable data snapshot.

24. Template versioning

Every PDF records its template version.

Example:

monthly-report-v1
monthly-report-v2

Do not mutate already-generated historical PDFs when the template changes.

25. One master template, not one per client

Do not create:

ClientAReport
ClientBReport
ClientCReport

Use one master report system plus configuration.

Example:

{
  "clientId": "uuid",
  "reporting": {
    "topCampaignCount": 3,
    "topFlowCount": 5,
    "conversionMetricId": "...",
    "sections": {
      "signupForms": true,
      "sms": true
    }
  }
}

26. 100+ client scalability

Future system must support:

100+ clients,

separate credentials,

report history,

retry per client,

failed-state visibility,

queued generation,

safe concurrency,

per-client configuration,

per-client timezone,

per-client conversion metric if required.

Future batch generation:

Generate completed-month reports
        ↓
queue
        ↓
client A
client B
client C
...
        ↓
success / failed / needs screenshot

27. Extension architecture

Suggested:

Manifest V3
React + TypeScript

popup/side panel
full-page extension dashboard
content script
service worker
capture/crop UI
shared API client

If the existing backend/data engine is Python, keep it Python unless there is a strong reason to rewrite it.

Do not rewrite the backend merely to match the extension's language.

28. Screenshot technical approach

General visible-region flow:

content script gets selected/candidate rectangle
        ↓
extension captures visible tab
        ↓
map CSS pixels to screenshot pixels
        ↓
crop
        ↓
preview
        ↓
approve
        ↓
upload

Be careful with:

devicePixelRatio,

browser zoom,

sticky headers,

scrolling offsets,

Retina displays,

side panels,

window resizing.

Never assume CSS pixels equal screenshot pixels.

29. Data reconciliation

If screenshot and API disagree:

Do not silently choose one.

Record discrepancy.

Verify:

date range,

timezone,

conversion metric,

channel filter,

attribution setting,

message type,

data freshness,

pagination,

UI rounding.

Resolve client-facing financial discrepancies before finalization.

A screenshot may display $3.38K while validated API data is $3,382.57.

Use exact validated data for textual metrics.

30. Formatting and rounding

Keep internal values at source precision.

Round only for display.

Exact display:

$47,061.15
$3,382.57

Compact visual display may use:

$47.1K
$3.38K

Never parse compact display text back into calculations.

Percentages must handle divide-by-zero explicitly.

31. Missing vs zero

Treat distinctly:

0       = confirmed zero
null    = unavailable/not applicable
error   = fetch/calculation failure

Never convert null/error into zero.

32. Pagination and completeness

Fully paginate provider endpoints when required.

Never calculate totals from only the first page.

Partial pulls fail validation.

33. Error handling

User-facing examples:

Klaviyo data could not be fetched.
Top Campaign screenshot is missing.
Selected month is incomplete.
Conversion metric is not configured.
Screenshot belongs to another report month.
Report validation failed.

Never expose secrets.

34. AI analysis rules

AI receives only validated structured metrics.

Rules:

do not invent numbers,

do not recalculate financial values,

do not infer unsupported causation,

use only supplied facts,

distinguish observation from recommendation,

keep copy concise,

return structured output.

Suggested output:

{
  "wins": ["...", "...", "..."],
  "opportunities": ["...", "..."],
  "actions": ["...", "...", "..."]
}

Validate before rendering.

35. No separate website in V1

Build:

Chrome Extension
    +
full-page extension dashboard
    +
backend

A web dashboard can be added later using the same backend.

36. V1 non-goals

Do not prioritize:

public client portal,

public SaaS website,

fully autonomous Klaviyo navigation,

brittle DOM bots for every page,

automatic sending to all clients,

full batch screenshot capture,

rebuilding verified integrations,

AI financial calculations,

separate custom report code per client.

37. Implementation phases

Phase 0 — Audit and data lock

inspect existing reporting engine,

document data sources,

document metric IDs,

document timezone behavior,

document attribution/conversion rules,

test calendar-month boundaries,

test previous-month comparison,

reconcile a known report with provider UI.

Phase 1 — Report model + validation

normalized report data,

month helper,

previous-month helper,

validation rules,

Top 3 campaign ranking,

Top 5 flow ranking,

report states.

Phase 2 — Visual PDF template

master template,

screenshot slots,

print CSS,

PDF renderer,

template versioning,

visual QA.

Phase 3 — Extension capture

auth,

client selector,

month selector,

completed-month lock,

capture checklist,

visible-tab capture,

crop,

preview,

retake,

approve,

upload.

Phase 4 — Preview/finalization

report preview,

missing-data warnings,

next-month-plan editor,

final validation,

Generate PDF,

history.

Phase 5 — AI narrative

Only after data correctness is locked.

Phase 6 — Scale

queue,

bulk status,

retry failures,

report search/history,

semi-automatic stable capture steps.

38. Testing requirements

Date tests

31-day month,

30-day month,

February normal year,

February leap year,

January/December year transition,

incomplete current month blocked,

timezone boundaries.

Financial tests

exact decimals,

zero previous value,

null values,

negative/refund handling if supported,

currency formatting,

exact vs compact values.

Ranking tests

more than five flows,

exactly five flows,

fewer than five flows,

ties,

missing revenue,

campaign ranking.

Screenshot tests

correct month,

wrong month,

correct client,

wrong client,

missing required capture,

approved/unapproved,

high-DPI crop handling.

Validation tests

partial provider fetch,

provider failure,

missing metric,

label/value scope mismatch,

incomplete month.

PDF tests

all sections render,

no clipped screenshots,

no overlapping content,

stable page breaks,

long names wrap,

optional sections do not create blank pages,

next-month plan does not create a mostly blank page.

39. V1 acceptance criteria

V1 is ready when:

Client can be selected.

Completed month can be selected.

Dates are automatically correct.

Previous calendar month is correct.

Existing verified data logic is reused.

Numeric data is validated.

Top Campaigns are deterministic.

Top Flows show max 5 and default to 5 when available.

Screenshots can be captured/cropped.

Each screenshot is tied to client + month + section.

Screenshots can be retaken/approved.

Extension shows completion checklist.

Wrong-month capture is detected.

Report can be previewed.

Next-month plan can be edited.

Final validation blocks bad/incomplete reports.

PDF uses reusable master template.

PDF has no accidental blank pages.

AI does not calculate financial values.

Report snapshot/history is stored.

No provider secrets are in extension source.

40. Coding-agent rules

Before coding:

Read CLAUDE.md.

Inspect current implementation.

Identify relevant files/data paths.

Run baseline tests.

Do not rewrite working logic just for cleanliness.

During coding:

Keep diffs narrow.

Reuse verified functions.

Add tests.

Do not casually rename metric semantics.

Do not alter financial formulas without evidence.

Do not replace deterministic logic with AI.

Do not expose credentials.

After coding, report:

What changed
Why
Data semantics changed? yes/no
Tests added
Tests run
Results
Known limitations
Manual verification required

41. STOP conditions

Claude must stop and ask/report instead of guessing when unclear:

exact conversion metric,

whether a total is Email-only or Email + SMS,

source of Total Revenue,

attribution window/setting,

currency semantics,

client timezone,

provider UI and API materially disagree,

existing calculation cannot be verified,

required provider field is unavailable,

screenshot cannot be associated with the selected month/client.

For data-critical uncertainty, do not silently make a "reasonable assumption".

42. OPEN PRODUCT QUESTIONS — OWNER CONFIRMATION REQUIRED

Q1. What exactly is $8,459.00 in the Orion example?

The report labels it like "Total Email Attributed Revenue", but the Klaviyo view appears to include both Email and SMS.

Choose:

A. Email + SMS / total attributed revenue → rename the metric.

B. Email-only attributed revenue → exclude SMS from the value.

This must be resolved.

Q2. Is Placed Order - Subscription Excluded required for every client?

Choose:

A. One fixed conversion metric for all clients.

B. Configurable per client.

C. Another global metric.

Need exact intended metric/ID.

Q3. What is the authoritative source for Total Revenue?

Choose/confirm:

A. Klaviyo reporting/Business Review.

B. Shopify calculation.

C. Existing monthly-report engine's verified formula.

D. Client-specific configuration.

Q4. Screenshot V1 workflow

Recommended:

A. Guided manual capture + crop + approve.

Alternative:

B. Automatic Klaviyo DOM detection immediately.

Recommendation: A.

Q5. Next Month's Plan

Choose:

A. Manual Account Manager input.

B. AI draft + Account Manager approval.

C. Fully AI generated.

Recommendation: A or B.

Q6. Internal access

Confirm:

A. Tention team only.

B. Tention team + clients.

Current assumption: Tention team only.

43. Current recommended decisions

Product:
Chrome extension + backend

Separate website:
No in V1

Existing report/data engine:
Keep and audit

Monthly period:
Complete calendar month only

Default month:
Most recently completed month

Previous comparison:
Immediately previous complete calendar month

Top Campaigns:
3

Top Flows:
5

Screenshot source:
Klaviyo UI

Screenshot V1:
Guided manual crop + approval

Numeric source:
API/database/verified calculations

Screenshot role:
Visual evidence

AI:
Narrative only

PDF:
Reusable HTML/CSS template -> Playwright/Chromium PDF

Client templates:
One master system + configuration

Secrets:
Backend only

Finalization:
Human review required

44. Definition of success

The product succeeds when the Tention team can create correct, visual monthly reports for 100+ clients without manually rebuilding data, copying numbers, resizing screenshots in documents, or maintaining a different report template for every client.

Ideal workflow:

Open extension
    ↓
Choose client
    ↓
Choose last completed month
    ↓
Data validates
    ↓
Follow screenshot checklist
    ↓
Approve captures
    ↓
Review insights + next month plan
    ↓
Preview
    ↓
Generate PDF

Correct first. Visual second. Automated third.