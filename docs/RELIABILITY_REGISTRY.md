# Automatic capture reliability registry

Confirmed live failure fingerprints of the shared capture runtime. Each entry is mirrored in code by
`KNOWN_FAILURES` in `apps/extension/src/features/automatic-capture/recovery-policy.ts`; the runner recognises a
recurrence by its fingerprint and applies the known recovery automatically. `recovery-policy.test.ts` fails if an
entry here or in code loses its regression test.

**Rule:** a confirmed live failure gets an entry and a regression test *before* it is called fixed. Fix the shared
subsystem it belongs to — never the section that happened to fail.

## Recovery ladder (all sections)

| Attempt | Level | What changes |
|---|---|---|
| 1 | 0 | Normal run: fresh source load, new attempt id. |
| 2 | 1 | The failure category's own remedy (below). |
| 3 | 2 | + next escalation step. |
| 4 | 3 | + next escalation step. |
| 5 | 4 | Every remedy, including a bounded cool-down before rebuilding the section. |

Category remedies: page/card/view/period/layout/obscured/bounds → `extended-readiness`; script result/injection,
tab not active → `settle-before-inject`; capture failed, storage full, stage timeout → `release-capture-state`;
upload/persistence → `retry-backend-write`. Escalation order: `settle-before-inject`, `extended-readiness`,
`release-capture-state`, `cool-down-before-retry`. Permanent categories (wrong account, toolbar grant lost, login
required, configuration, source-proof schema) stop at once with their exact code.

Every attempt records `PREVIOUS_FAILURE`, `FAILURE_CATEGORY`, `KNOWN_FAILURE`, `RECOVERY_LEVEL`, `RECOVERY_ACTION`,
and a `stageTimeline` (`attemptStartedAt`, `controllerStartRequestedAt`, `preparedAt`, `captureReturnedAt`,
`cropCompletedAt`, `uploadStartedAt`, `uploadCompletedAt`, `sectionResultSavedAt`, `failedAt`). Stage bounds:
settle 120 s, crop 15 s, upload 30 s, persistence 30 s; page scripts 90 s.

## Known failures

### BUSINESS_REVIEW_TITLE_CLIPPED
- **Discovered:** 2026-11-03 — Club Furniture September 2026 Campaign Metrics and Flow Metrics, both accepted as PASS (wrong evidence, not a runtime failure at the time).
- **Fingerprint:** after the fix, `BUSINESS_REVIEW_TARGET_OCCLUDED` with “title is not visible”. Before it: a Metrics crop whose top shows “Dashboards / Business review” instead of the card title, so Campaign and Flow Metrics look identical.
- **Subsystem:** Business Review capture adapter — scroll and crop geometry.
- **Root cause:** the last-row step scrolled the card up until its top reached viewport 0 to clear the Composer bar. Klaviyo's dashboard scrolls inside its own container below a page header that does not scroll, so the title went under the header edge while the card still looked "in the viewport".
- **Fix / recovery:** every scroll and visibility check uses the card's clip region (viewport ∩ every overflow-clipping ancestor). A card already under the header is scrolled back; if the row cannot clear the bar without losing the title, the bar is hidden instead. Before capture, the card's own title must be inside the crop and the visible area with nothing outside the card on top; otherwise the attempt fails and is retried. The proof records `cardTitle` and `visibleTop`.
- **Regression tests:** “never scrolls its title under a non-scrolling page header; it hides the Composer instead”, “scrolls a card already partly under the page header back down until its title shows”, “refuses a crop whose title is painted over by page chrome outside the card”.

### FLOATING_PROMPT_BETWEEN_SAMPLES (wrong evidence, no failure code)
- **Discovered:** 2026-11-03 — Club Furniture September 2026 Flow Performance, accepted as PASS.
- **Fingerprint:** Klaviyo's AI prompt pill (“Which campaigns drove the most unsubscribes?”) visible over the bottom of a chart; x-axis dates and the $0 baseline hidden.
- **Subsystem:** overlay handling in the Business Review and Subscriber Growth adapters.
- **Root cause:** occluders were found by hit-testing a fixed 9 × 7 grid (~40 px apart on a 589 px card); the ~45 px pill fell between two sample rows.
- **Fix:** every Business Review target first hides each positioned layer that geometrically intersects the crop, then verifies with a dense hit-test (≈16 px × 48 px). Subscriber Growth uses the same dense grid.
- **Regression test:** “hides an AI prompt pill that sits between sparse hit-test rows, so the chart bottom stays visible”.

### SUBSCRIBER_GROWTH_BLANK_CROP (wrong evidence, no failure code)
- **Discovered:** 2026-11-03 — Club Furniture September 2026 Subscriber Growth (1415 × 1568 crop, ~800 px blank plus the AI prompt).
- **Subsystem:** Subscriber Growth capture adapter — crop bounds.
- **Root cause:** the crop was the smallest container holding the date range, tabs, metrics and charts; on the live page that is the page's reporting area, which stretches to the bottom of a tall window.
- **Fix:** the crop keeps that container's top (title, Email tab, date range) but ends 12 px below the Email subscribers card (the smallest container of the Growth view, three metrics and both charts). `trimmedBelowCard` is recorded in diagnostics.
- **Regression test:** “crops at the bottom of the Email subscribers card, leaving out blank page and the AI prompt below it”.

### SUBSCRIBER_GROWTH_EMAIL_ONLY_FALSE_NOT_READY (false PAGE_NOT_READY, adapter predicate)
- **Discovered:** 2026-11-11 — Purely Nutrient October 2026 (run 8fa3b760): sections 1–9 PASS, Section 10 failed 5/5 attempts with `SUBSCRIBER_GROWTH_PAGE_NOT_READY` while the page visibly showed Email subscribers 34,487 / New subscribers 882 / Exclusions 44, Growth selected, both charts, "Last 7 days".
- **Fingerprint:** `SUBSCRIBER_GROWTH_PAGE_NOT_READY` with `headings` containing "Subscriber growth" and "Email subscribers" but `tabs.channel: []`.
- **Subsystem:** Subscriber Growth capture adapter — page identity / readiness.
- **Root cause:** identity required the Overview | Email | Text message channel tabs. Accounts without SMS (Purely Nutrient) render no channel tabs and open directly on the Email subscribers card, so `channelTabs().some(Email)` stayed false on every poll; retries could never help.
- **Fix:** identity = a Subscriber growth heading plus either the Email channel tab or, when no channel tabs exist, a visible "Email subscribers" card heading (and no Text message/SMS card). A separate semantic PAGE_READY gate (Growth selected, all three metrics, a chart with real bounds, no visible loading over that evidence) runs before the period; the period is then set and proven separately (`REPORT_PERIOD_NOT_CONFIRMED` on mismatch). Loading counts only when a visible loading element overlaps the evidence. Every failure records a `readiness` object naming each condition.
- **Regression test:** “2 + 12. is PAGE READY with Last 7 days, sets Oct 1–31, verifies it, and captures the exact counts” (and the rest of “Section 10 readiness on the email-only layout”).

### AUTOMATIC_RUN_REVIEW_GATE_IN_PRODUCTION (workflow regression, no failure code)
- **Discovered:** 2026-11-11 — production build (API on Railway): "Start Automatic Capture · 10 sections" captured Executive Summary, then stopped on *Review screenshot* with Retake / Confirm & Continue; after approval it captured one more section and stopped again ("Final report readiness: 2 / 10 required screenshots approved", "Resume Automatic Capture · …").
- **Fingerprint:** any automatic run that renders the per-section *Review screenshot* screen or a *Confirm & Continue* button.
- **Subsystem:** report screen → automatic runner selection (`App.tsx` `startAutomaticRunner`) and per-section persistence.
- **Root cause:** the genuinely automatic runner (`LocalAutomaticAcceptanceRun`) was only used when the extension's API was localhost, because it saved sections to a dev-only run store (`/api/v1/dev/automatic-capture-runs`) and imported them into the report only after the whole run completed. With a production API it fell back to the legacy manual workflow, which stops on every section for human approval.
- **Fix:** one runner for every build. Each passed section is saved on the canonical report immediately through the production `PUT /report-drafts/:id/screenshots/:type/automatic-image` (machine-validated automatic evidence, `approved: false`; the server re-checks client, month, version, enabled section, source proof and period, Klaviyo URL, PNG and uniqueness). No review screen between sections; on 10/10 the report auto-generates (machine validation → PDF → Drive → Doc). A failure keeps the passed sections and Resume captures only what is missing. The dev run store is diagnostics only. Human review (view / approve / retake) stays optional and is available in production.
- **Regression tests:** “1–5, 8, 9, 13, 14: one click captures all 10 in order, saves each before the next, never shows review, then finalizes automatically” (and the rest of “one Start Automatic Capture click runs every section with no review gate”), plus `apps/api/src/automatic-capture-save.test.ts`.

### TOP_FLOWS_WINDOWS_LAYOUT
- **Discovered:** 2026-11-12 — Club Furniture October 2026 on Windows + Chrome (run 7417360d): Executive Summary PASS, Top 5 Flows FAIL 5/5. The same production build and report passed on macOS (Club Furniture October, 10 Live rows).
- **Fingerprint:** `TOP_FLOWS_NON_QUALIFYING_ROW_IN_VIEW`, shown with category `VIEW_NOT_SELECTED`; Klaviyo visibly narrower than on macOS with a horizontal scrollbar.
- **Subsystem:** viewport normalizer (`klaviyo-viewport.ts`), runner width backstop, Home dashboard adapter Top Flows row selection (`dashboard-capture.ts`), failure classification.
- **Root cause (two confirmed code defects; the exact DOM of 7417360d was not recoverable):**
  1. *Mac-only width assumption.* Klaviyo's width was `window.innerWidth`. macOS overlay scrollbars take no space; Windows classic scrollbars do (≈17 device px, ≈21 CSS px at 80% zoom), so a tab "normalized" to ≥1390 px laid Klaviyo out narrower than the proven floor — the horizontal scrollbar seen live.
  2. *Geometric "Draft in range" check.* Rows were collected from the whole card, ranked by painted `top`, and status was matched anywhere in the row text. `TOP_FLOWS_NON_QUALIFYING_ROW_IN_VIEW` fired whenever **any** uncounted flow-looking row was painted above the fifth row's bottom. With all-Live data the old adapter returns exactly this code for a flow-looking row painted inside the card band after reflow (e.g. a "Pick up where you left off" draft card) and for rows overlapping mid-reflow — both reproduced in regression tests.
  3. *Misclassification.* No `BY_CODE` entry; the word fallback split `…_ROW_IN_VIEW` and matched `VIEW` → `VIEW_NOT_SELECTED`. That is why two errors were shown for one failure.
  Production keeps attempt diagnostics in memory only (no dev run store), so 7417360d's candidate rows/rects could not be retrieved; which of the two layout paths fired there is unproven.
- **Fix / recovery:** width everywhere is Klaviyo's *layout* width (document and full-width app scroller scrollbars excluded) — normalizer, adapter, runner backstop; `viewportWidth` stays `innerWidth` for crop mapping. Top Flows rows come only from the table that owns the verified header, are ranked in DOM order (Klaviyo's ranking), and qualify by their Status cell (`role=status`, then the Status column, then row text). A Draft ranked above the last counted flow is still `TOP_FLOWS_NON_QUALIFYING_ROW_IN_VIEW` (unchanged strictness). Geometry that disagrees with the ranking is a moving layout: re-measured, never a semantic failure. A layout-width change discards earlier geometry; the table is scrolled into view vertically and horizontally; semantic verdicts must repeat on a later pass. A table wider than the visible area is `KLAVIYO_VIEWPORT_TOO_NARROW` with `actualWidth`/`requiredWidth`. Failures carry `selection` (viewport incl. DPR, visualViewport, scroll offsets, classic scrollbar width; card/header/table rects; every candidate row's rect, status, source, and rejection reason) plus the run's zoom; the panel's **Copy diagnostics** button exports a failed section's attempts in production.
- **Regression tests:** “Windows layout: classic scrollbars, zoom, side panel and reflow give the same Top Flows decision” (`dashboard-top-flows-layout.test.ts`), “Klaviyo layout width on macOS and Windows (classic scrollbars)” (`klaviyo-viewport.test.ts`), classification in `recovery-policy.test.ts`.

### SUBSCRIBER_GROWTH_COMPOSER_OCCLUSION
- **Discovered:** 2026-11-12 — Steven Dann October 2026 on Windows + Chrome: sections 1–9 PASS, Section 10 FAIL 5/5. The page itself was right (Email → Growth, Oct 1–31, metrics and charts); Klaviyo's "Ask Composer" sat over the lower part of the card.
- **Fingerprint:** `SUBSCRIBER_GROWTH_TARGET_OCCLUDED` (category `TARGET_OBSCURED`) with an Ask Composer element in `occluders`.
- **Subsystem:** Subscriber Growth capture adapter — crop placement and overlay handling.
- **Root cause (code defects; the live element chain of the Windows run was not recorded by the old build):**
  1. Only an out-of-card element that was *itself* `fixed/sticky/absolute` was hidden. The element hit-testing reported is the outermost one not containing the card; Klaviyo mounts the Composer inside a static wrapper (Business Review already hid any layer whose chain is positioned), so it was classed as page content.
  2. The fit check used `window.innerHeight`. Klaviyo scrolls inside its app container and its Composer dock (`ComposerDock`, seen in recorded page HTML) can sit in the page flow below it, so a card clipped above the dock still "fitted"; the dock was then hit in-flow and refused.
  Both reproduce the exact live code on the old adapter for every Windows geometry; on macOS the taller window keeps the card above the Composer.
- **Fix:** the crop is placed in the painted area (layout viewport without classic scrollbars ∩ clipping ancestors) by scrolling the card's own scroller. If it cannot fit and the space is taken by an in-flow Composer/assistant dock, that dock is collapsed (`display:none`), then everything is re-measured. Floating non-report layers over the crop (Composer, tooltips, popovers, toasts, other positioned layers outside the card — found geometrically and by dense hit-test, whole chain incl. static wrappers) get `visibility:hidden` + `opacity:0` (children cannot repaint), then the crop is re-measured and re-verified, up to 8 passes (a Composer re-rendered by React is hidden again). Nothing is clicked. In-flow page content and modal dialogs over the card still fail closed and are never hidden. Every attempt records `occlusion`: viewport (inner/layout size, DPR, visualViewport), target rect, clip area per pass, and each occluder's element, kind, text, rect, intersection area/percentage and action; it is included in the panel's Copy diagnostics.
- **Regression tests:** “Windows Subscriber Growth occlusion: Ask Composer handled automatically, never captured through” (`subscriber-growth-capture.test.ts`).

### SESSION_STORAGE_QUOTA
- **Discovered:** 2026-10-28 — June Top 5 Campaigns (b4732590, f7e3c851, 518179b8, b149eee7), September Flow Metrics (07809233). **Recurred:** 2026-10-29 — the Subscriber Growth toolbar click could not be recorded ("Session storage quota bytes exceeded" in background.js).
- **Fingerprint:** `CAPTURE_FAILED` with “Session storage quota bytes exceeded”; a section stuck at *Capturing* until `CAPTURE_TIMEOUT`; or a toolbar click / source setup that silently records nothing (`SUBSCRIBER_GROWTH_SOURCE_NOT_VERIFIED`).
- **Subsystem:** capture state store and every other `chrome.storage.session` writer (10 MB quota shared by all keys).
- **Root cause:** capture states held full-viewport screenshots (data URLs of 1–4 MB) in session storage. Releasing them after use was not enough: an abandoned run left them behind, and only the capture store itself recovered from a refused write — the toolbar grant, the click record and source setup did not, so a full session made the click itself fail.
- **Fix / recovery:** screenshots never go to session storage — the full state lives in service-worker memory and session storage holds only small metadata (a restarted worker reports a retryable `CAPTURE_STATE_LOST`). Startup removes obsolete image-bearing states from older builds. The grant, click record and verified Subscriber Growth source are critical writes: release obsolete transient state, retry once, read back, otherwise a typed `SESSION_STORAGE_QUOTA_EXCEEDED`. Diagnostics are compact fixed schemas; configured routes are deduplicated and capped. Advanced → *Inspect session storage* shows per-key sizes. Recovery action `release-capture-state`.
- **Regression test:** “never stores a screenshot in session storage and never throws when it is full”.

### HIDDEN_TAB_ANIMATION_FRAME_HANG
- **Discovered:** 2026-10-28 — September Flow Metrics attempt 1 (07809233, dbd864e0, d1e11bc9).
- **Fingerprint:** `CAPTURE_TIMEOUT` after 120 s with the target visibly rendered.
- **Subsystem:** injected page adapters.
- **Root cause:** adapters awaited `requestAnimationFrame` directly; Chrome runs no frames in a hidden/background tab, so the adapter never returned.
- **Fix / recovery:** every adapter frame wait falls back to a timer; the runner's settle bound aborts the attempt and the next one starts fresh.
- **Regression test:** “does not hang when the tab runs no animation frames”.

### SCRIPT_RESULT_NULL
- **Discovered:** 2026-10-28 — August Month Comparison (8fdc5fcc).
- **Fingerprint:** `SCRIPT_RESULT_INVALID` / `SCRIPT_RESULT_UNDEFINED` with result `null` while the correct view is visible.
- **Subsystem:** script execution / adapter result contract — not section business logic.
- **Root cause:** an exception escaped the injected adapter (its catch rebuilt diagnostics that threw again); Chrome reports that as `null`.
- **Fix / recovery:** every adapter returns plain JSON from a guard that turns any exception into a typed failure; injection diagnostics (`RESULT_TYPE`, `SCHEMA_ERROR`, `DOM_GENERATION_CHANGED`, …) are recorded; recovery action `settle-before-inject`.
- **Regression test:** “explains a null result from a replaced document, then loads the dashboard fresh again on the next attempt and passes”.

### GRANTED_TAB_DEACTIVATED
- **Discovered:** 2026-10-28 — September (d1e11bc9).
- **Fingerprint:** `GRANTED_TAB_NOT_ACTIVE`, then `ACTION_NOT_INVOKED` on the next attempt.
- **Subsystem:** toolbar grant verification.
- **Root cause:** selecting another tab during a run invalidated the toolbar grant, turning a transient focus change into a permanent failure.
- **Fix / recovery:** sources that reload a configured URL re-activate the same granted tab in its own window instead of destroying the grant.
- **Regression test:** “re-activates the same granted tab instead of destroying the grant”.
