# Local authenticated Klaviyo acceptance

Synthetic safety coverage is separate from live Klaviyo verification:

```bash
npm run acceptance:synthetic
npm run klaviyo:test-login
npm run acceptance:local -- --client autoledtech --month 2026-08
```

`klaviyo:test-login` opens a headed, dedicated Playwright Chromium profile at `data/klaviyo-test-browser-profile`. It never opens or copies a normal Chrome profile. Complete login/MFA and press Enter; only a non-secret initialization marker is written. The profile and marker are ignored by Git.

If Playwright's managed headful Chromium exits before the login page is usable, point `TENTION_KLAVIYO_BROWSER_EXECUTABLE_PATH` to a compatible local Chromium executable. The command still supplies the dedicated profile directory, so it does not access the normal Chrome profile. It records only a non-secret `login-diagnostics.json` beside the ignored profile.

Create an untracked `data/local-clients.json` from `data/local-clients.example.json`. The runner derives the internal client ID from the configured client name; do not put a client ID, cookie, API key, or any credential in that file. Every URL must be a credential-free HTTPS Klaviyo URL previously verified for that client.

The only required fields for the supported live captures are `name`, `timezone`, `overviewUrl`, and `businessReviewUrl`. The runner accepts these optional, evidence-backed additions when they are known:

| Capture | Local configuration required before source work can begin |
| --- | --- |
| Signup Forms | `signupFormsUrl` and `signupForms` (`mode: "all"` or stable IDs/names); current AutoLEDTech scope is all forms |
| Welcome Flow | `flowsUrl` and `welcomeFlowListing` (the verified Email Welcome listing rows; individual flows are never opened) |
| Customer Split | `segmentsUrl`, `customerSegment`, and `nonCustomerSegment` (stable IDs or names) |
| Deliverability | `deliverabilityUrl` |

The fields are deliberately optional because configuring a URL or entity does not manufacture a DOM adapter. The runner records each missing prerequisite in `results.json` and `acceptance-report.html`; it never guesses a Klaviyo route, list, flow, form, or segment.

The local runner is deliberately fail-closed. Until a date-control adapter has genuine live DOM evidence for the configured client, it writes redacted page HTML, viewport/full-page screenshots, headings, controls, and table-header diagnostics and exits with `LIVE_ACCEPTANCE_BLOCKED_DATE_CONTROL`. It never uploads or approves an unverified capture. Missing/expired login returns `LIVE_ACCEPTANCE_BLOCKED_AUTH`.

For a successful supported live pass, the output directory contains the nine verified capture PNGs, SHA-256 diagnostics, redacted DOM evidence, `results.json`, and `acceptance-report.html`. Business Review custom comparison controls must render both the exact current and previous calendar-month ranges together. The Month Comparison capture then requires the live Growth overview Conversion summary card and its “vs previous period” evidence; the accepted screenshot is bound to both exact ranges in Phase A proof. Deliverability is captured only from `/analytics/deliverability/email/score`: the score/gauge, rolling-last-30-days declaration, and rate table must render, while Action Center is excluded. Klaviyo counts the gauge number up after render, so the card is captured only after its text and gauge geometry stay identical across consecutive samples, and the capture is rejected if the card changed while the screenshot was taken. The card must fit fully inside the viewport. The PDF labels this rolling view as not limited to the report month.

Before any capture, the runner reads the visible Klaviyo account switcher label and refuses to continue (`LIVE_ACCEPTANCE_BLOCKED_ACCOUNT_MISMATCH`) unless it matches the configured client name. Switch the isolated profile to the client's account (for example with `TENTION_LIVE_HEADED=true` or `npm run klaviyo:test-login`) before running another client. The runner does not create a client PDF until every other required manual/deferred capture has valid source proof and human review approval.

The local runner waits for the report data card—not merely the navigation shell—before changing dates. A blank/loading dashboard or provider-side session/storage failure produces `LIVE_ACCEPTANCE_BLOCKED_PAGE_NOT_READY` with redacted DOM and screenshots; it never accepts the previously displayed month as proof for the requested report month.

`npm run acceptance:synthetic` separately exercises the full PDF pipeline. It writes `tention-pdf-acceptance-fixture.pdf`, `pdf-pages/page-*.png`, `contact-sheet.png`, and diagnostics. PDF.js plus native canvas render every physical page; a page with no visible non-white raster content fails QA. This is layout/pipeline verification only—the fixture is not client evidence or numeric validation.

## Importing verified acceptance evidence into the canonical draft

`acceptance:local` writes its live PNGs and diagnostics to `output/local-acceptance`; it does not create an API report draft. To reconcile a successful supported AutoLEDTech run into the same PostgreSQL-backed draft used by the extension, start the API with the already-configured `DATABASE_URL` and filesystem screenshot storage, then run:

```bash
npm run acceptance:import-live -- --client autoledtech --month 2026-08
```

This development-only bridge is registered only for a non-production API bound to loopback and refuses memory storage. It revalidates run identity, exact periods, source identities, SHA-256 values, PNG dimensions, duplicate hashes, and Top Campaigns/Top Flows row bounds before storing assets through the normal screenshot storage and report repository. Imported records are marked `captureOrigin: "live_acceptance_import"`, remain unapproved and pending human review, and cannot satisfy the production generation gate. The bridge is idempotent for the same evidence and will not replace another capture origin. Only verified current-product target fields from `data/local-clients.json` are persisted; unresolved customer segments remain unset. List Growth is not a current capture target.

To review a pending imported screenshot without recapturing it, reload the unpacked extension from `apps/extension/dist`, reopen the canonical AutoLEDTech August report, choose `Review saved capture` for each imported item, inspect the displayed image and metadata, then explicitly select `Approve this saved evidence`. The local API checks report identity, canonical source proof and periods, stored PNG dimensions and bytes, SHA-256, and duplicate hashes again; it saves with optimistic version checking, returns a typed acknowledgement, and the extension reloads the canonical draft before updating its checklist. Backing out leaves the screenshot unapproved. This review endpoint exists only on a persistent, non-production loopback API; it never transitions the report lifecycle or weakens final report validation. Signup Form and Welcome Flow are not currently present in the canonical AutoLEDTech draft, so those must be recaptured through the extension's normal listing-only capture/review/upload flow.

## Extension E2E targets

`npm run acceptance:extension` drives the real unpacked extension against one canonical live-imported report. AutoLEDTech is the default target; select another with `TENTION_E2E_CLIENT=club-furniture npm run acceptance:extension` (npm drops a nested `--client` flag). Targets and their report IDs live in `apps/api/src/reports/extension-e2e-contract.ts`; each run asserts that target's own identity end to end and never borrows another client's data.

A report still in `draft` exercises the development review PDF; a report already `generated` exercises the final Preview Report / Open PDF / Download PDF controls and proves that open, download, reopen, and redownload all return the same persisted artifact (artifact ID, SHA-256, byte size, page count) without regeneration. If any required capture no longer matches the capture contract, the run stops with `overall: "BLOCKED"` and names the stale capture instead of reporting a code failure.

## Pending: AutoLEDTech live acceptance (account unavailable)

As of 2026-10-26 the AutoLEDTech.com Klaviyo account is not available in the isolated profile's account switcher, so AutoLEDTech live acceptance is **pending**, not passed.

- The canonical AutoLEDTech August 2026 report (`f577d631-a1f6-4cc0-9052-68e30460876d`) has 8 of 9 required captures approved (reviewed 2026-10-26). Its Deliverability evidence is still the retired Business Review card (`business-review|deliverability|email`), which validation correctly rejects. This is **unresolved**.
- `npm run acceptance:extension` (AutoLEDTech default) therefore reports `BLOCKED` at "Required evidence matches the current capture contract".
- The runner's account-identity gate refuses to capture AutoLEDTech while another account is active; do not bypass it and never substitute another client's evidence.

When the account is available again:

1. Make AutoLEDTech.com the active account in the isolated profile (`npm run klaviyo:test-login`, switch account, press Enter).
2. `npm run acceptance:local -- --client "AutoLEDTech.com" --month 2026-08 --section deliverability`
3. `npm run acceptance:import-live -- --client autoledtech --month 2026-08 --section deliverability`
4. Review and approve the imported Deliverability Score in the extension, submit for review, and generate the PDF.
5. `npm run acceptance:extension` must report `PASS`.

## Single-section recapture

Any one automated section can be recaptured without touching the other eight:

```
npm run acceptance:local -- --client "<Client>" --month YYYY-MM --section top_flows
npm run acceptance:import-live -- --client <client-id> --month YYYY-MM --section top_flows
```

The runner still applies and proves the exact calendar month on Overview and Business Review (temporary view controls only) but screenshots only the requested card. The import replaces only that section; a report in `ready_for_review` or `generated` atomically returns to `captures_incomplete`, so the prior PDF is never reused, and the new capture enters pending review.

Every automated card screenshot is accepted only after three consecutive screenshots are byte-identical (`renderStability` in the section diagnostics). A single screenshot taken while Klaviyo is repainting a table can contain stale raster rectangles over individual glyphs (Club Furniture August 2026 Top Flows showed "2.61K" as "2.□1K"), so an unstable card fails the capture instead of being persisted.
