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
