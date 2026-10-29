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
