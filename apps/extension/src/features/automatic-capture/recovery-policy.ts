/**
 * The one recovery policy shared by every automatic section. A failed attempt is classified into a typed category,
 * and the next attempt escalates through recovery levels instead of repeating the identical operation. Confirmed
 * live failure fingerprints live in KNOWN_FAILURES (mirrored in docs/RELIABILITY_REGISTRY.md) so a recurrence is
 * recognised and recovered from automatically rather than rediscovered.
 */
export type FailureCategory =
  | "PAGE_NOT_READY" | "CARD_NOT_READY" | "VIEW_NOT_SELECTED" | "PERIOD_NOT_CONFIRMED" | "LAYOUT_UNSTABLE"
  | "TARGET_OBSCURED" | "TARGET_BOUNDS_INVALID" | "SCRIPT_RESULT_INVALID" | "SCRIPT_INJECTION_FAILED"
  | "CAPTURE_FAILED" | "CAPTURE_STATE_STORAGE_FULL" | "STAGE_TIMEOUT" | "TAB_NOT_ACTIVE" | "UPLOAD_FAILED"
  | "PERSISTENCE_FAILED" | "SOURCE_PROOF_FAILED" | "NO_DATA" | "TOOLBAR_GRANT_LOST" | "WRONG_ACCOUNT"
  | "LOGIN_REQUIRED" | "CONFIGURATION" | "UNKNOWN";

/**
 * What an attempt does differently. Every attempt already starts from a freshly loaded source and a new attempt id
 * (states from abandoned attempts are ignored); these are the escalations on top of that.
 */
export type RecoveryAction =
  | "fresh-source"            // reload/re-enter the canonical read-only source; rebuild view/period/filter state
  | "extended-readiness"      // allow the page adapter a longer bounded readiness window
  | "settle-before-inject"    // wait until the reloaded page has stayed fully loaded before injecting the adapter
  | "release-capture-state"   // release every stored capture state (screenshots) before capturing again
  | "retry-backend-write"     // repeat only the bounded upload/persistence step's request on a fresh attempt
  | "cool-down-before-retry"; // the final level: pause briefly so Klaviyo and Chrome settle before rebuilding everything

export interface RecoveryPlan { level: number; actions: RecoveryAction[]; previousFailure: string | null; category: FailureCategory | null; knownFailure: string | null }

const PERMANENT: ReadonlySet<FailureCategory> = new Set(["TOOLBAR_GRANT_LOST", "WRONG_ACCOUNT", "LOGIN_REQUIRED", "CONFIGURATION", "SOURCE_PROOF_FAILED"]);

const BY_CODE: Record<string, FailureCategory> = {
  ACCOUNT_CONTEXT_MISMATCH: "WRONG_ACCOUNT", CAMPAIGNS_ACCOUNT_UNPROVEN: "PAGE_NOT_READY",
  ACTION_NOT_INVOKED: "TOOLBAR_GRANT_LOST", KLAVIYO_ACTIVE_TAB_GRANT_REQUIRED: "TOOLBAR_GRANT_LOST", KLAVIYO_CAPTURE_PERMISSION_REQUIRED: "TOOLBAR_GRANT_LOST",
  CAPTURE_PERMISSION_DENIED: "TOOLBAR_GRANT_LOST", GRANTED_TAB_CLOSED: "TOOLBAR_GRANT_LOST", GRANTED_TAB_CHANGED_ORIGIN: "TOOLBAR_GRANT_LOST",
  GRANTED_TAB_NOT_ACTIVE: "TAB_NOT_ACTIVE", CAPTURE_TARGET_NOT_ACTIVE: "TAB_NOT_ACTIVE",
  BUSINESS_REVIEW_URL_REQUIRED: "CONFIGURATION", DASHBOARD_URL_REQUIRED: "CONFIGURATION", DELIVERABILITY_SCORE_URL_REQUIRED: "CONFIGURATION",
  CAMPAIGNS_ROUTE_REQUIRED: "LOGIN_REQUIRED", SOURCE_PROOF_SCHEMA_INVALID: "SOURCE_PROOF_FAILED",
  SCRIPT_RESULT_EMPTY: "SCRIPT_RESULT_INVALID", SCRIPT_RESULT_UNDEFINED: "SCRIPT_RESULT_INVALID", SCRIPT_RESULT_INVALID: "SCRIPT_RESULT_INVALID",
  SCRIPT_INJECTION_FAILED: "SCRIPT_INJECTION_FAILED", KLAVIYO_PAGE_ADAPTER_ERROR: "SCRIPT_RESULT_INVALID",
  CAPTURE_TIMEOUT: "STAGE_TIMEOUT", PAGE_READY_TIMEOUT: "STAGE_TIMEOUT", CROP_TIMEOUT: "STAGE_TIMEOUT",
  UPLOAD_TIMEOUT: "UPLOAD_FAILED", PERSISTENCE_TIMEOUT: "PERSISTENCE_FAILED",
  BUSINESS_REVIEW_TARGET_OCCLUDED: "TARGET_OBSCURED", TARGET_NOT_VISIBLE: "TARGET_BOUNDS_INVALID", TARGET_BOUNDS_INVALID: "TARGET_BOUNDS_INVALID",
  TOP_CAMPAIGNS_ROWS_NOT_VISIBLE: "TARGET_BOUNDS_INVALID", TARGET_LAYOUT_NOT_STABLE: "LAYOUT_UNSTABLE", TOP_CAMPAIGNS_UNSTABLE: "LAYOUT_UNSTABLE",
  BUSINESS_REVIEW_UNEXPECTED_NAVIGATION: "PAGE_NOT_READY", BUSINESS_REVIEW_CHART_NOT_RENDERED: "CARD_NOT_READY",
  SUBSCRIBER_GROWTH_URL_REQUIRED: "CONFIGURATION", SUBSCRIBER_GROWTH_ACCOUNT_UNPROVEN: "PAGE_NOT_READY", SUBSCRIBER_GROWTH_TARGET_OCCLUDED: "TARGET_OBSCURED",
  SUBSCRIBER_GROWTH_METRIC_NOT_EXACT: "CARD_NOT_READY", SUBSCRIBER_GROWTH_NOT_STABLE: "LAYOUT_UNSTABLE", SUBSCRIBER_GROWTH_ROUTE_CHANGED: "PAGE_NOT_READY", SUBSCRIBER_GROWTH_SOURCE_SETUP_BUSY: "PAGE_NOT_READY",
  // Views the extension selects itself are retryable; only a wrong page or account cannot be fixed by retrying.
  SUBSCRIBER_GROWTH_EMAIL_TAB_NOT_FOUND: "VIEW_NOT_SELECTED", SUBSCRIBER_GROWTH_VIEW_NOT_FOUND: "VIEW_NOT_SELECTED", SUBSCRIBER_GROWTH_SOURCE_WRONG_PAGE: "CONFIGURATION",
  // A capture taken narrower than the safe width is retried after the viewport is normalized again; only a window
  // too narrow even at the lowest zoom cannot be fixed by retrying.
  KLAVIYO_VIEWPORT_TOO_NARROW: "LAYOUT_UNSTABLE", KLAVIYO_VIEWPORT_UNAVAILABLE: "PAGE_NOT_READY", KLAVIYO_VIEWPORT_CANNOT_BE_NORMALIZED: "CONFIGURATION",
  // The cover values render with the card; a late or partial render is retried like any card that is not ready.
  EXECUTIVE_SUMMARY_METRICS_UNVERIFIED: "CARD_NOT_READY",
  AUTOMATIC_PERIOD_PROOF_MISMATCH: "PERIOD_NOT_CONFIRMED", TOP_CAMPAIGNS_NO_DATA: "NO_DATA", TOP_FLOWS_NO_DATA: "NO_DATA",
  // "…_ROW_IN_VIEW" is about rows inside the crop, not a Klaviyo view selector; the word fallback below read it as
  // VIEW_NOT_SELECTED (Windows run 7417360d).
  TOP_FLOWS_NON_QUALIFYING_ROW_IN_VIEW: "CARD_NOT_READY", TOP_FLOW_ROWS_NOT_FOUND: "CARD_NOT_READY",
};

export function classifyFailure(code: string, message = ""): { category: FailureCategory; permanent: boolean; knownFailure: string | null } {
  const known = KNOWN_FAILURES.find((entry) => entry.matches(code, message));
  const words = new Set(code.split("_"));
  const has = (...names: string[]) => names.some((name) => words.has(name));
  const category: FailureCategory = known?.category ?? BY_CODE[code]
    ?? (has("PERIOD", "DATE", "COMPARISON") ? "PERIOD_NOT_CONFIRMED"
      : has("TAB", "VIEW") ? "VIEW_NOT_SELECTED"
      : has("CARD", "CONTENT", "ROWS", "CHART", "DATA") ? "CARD_NOT_READY"
      : has("PAGE", "NOT", "READY", "LOADING", "DIALOG") ? "PAGE_NOT_READY"
      : has("CAPTURE", "SCREENSHOT") ? "CAPTURE_FAILED"
      : "UNKNOWN");
  return { category, permanent: PERMANENT.has(category), knownFailure: known?.id ?? null };
}

/** The category's own first remedy; later attempts add the remaining remedies in a fixed escalation order. */
const PRIMARY: Record<FailureCategory, RecoveryAction> = {
  PAGE_NOT_READY: "extended-readiness", CARD_NOT_READY: "extended-readiness", VIEW_NOT_SELECTED: "extended-readiness",
  PERIOD_NOT_CONFIRMED: "extended-readiness", LAYOUT_UNSTABLE: "extended-readiness", TARGET_OBSCURED: "extended-readiness",
  TARGET_BOUNDS_INVALID: "extended-readiness", NO_DATA: "extended-readiness", UNKNOWN: "settle-before-inject",
  SCRIPT_RESULT_INVALID: "settle-before-inject", SCRIPT_INJECTION_FAILED: "settle-before-inject", TAB_NOT_ACTIVE: "settle-before-inject",
  CAPTURE_FAILED: "release-capture-state", CAPTURE_STATE_STORAGE_FULL: "release-capture-state", STAGE_TIMEOUT: "release-capture-state",
  UPLOAD_FAILED: "retry-backend-write", PERSISTENCE_FAILED: "retry-backend-write",
  SOURCE_PROOF_FAILED: "fresh-source", TOOLBAR_GRANT_LOST: "fresh-source", WRONG_ACCOUNT: "fresh-source", LOGIN_REQUIRED: "fresh-source", CONFIGURATION: "fresh-source",
};
const ESCALATION: readonly RecoveryAction[] = ["settle-before-inject", "extended-readiness", "release-capture-state", "cool-down-before-retry"];

/** Attempt 1 is a normal run; attempt n (2–5) applies recovery level n−1, each strictly adding to the last. */
export function recoveryPlan(attempt: number, previous: { code: string; message?: string } | null, earlier: readonly RecoveryAction[] = []): RecoveryPlan {
  if (attempt <= 1 || !previous) return { level: 0, actions: ["fresh-source"], previousFailure: null, category: null, knownFailure: null };
  const { category, knownFailure } = classifyFailure(previous.code, previous.message);
  const actions = new Set<RecoveryAction>(["fresh-source", ...earlier, PRIMARY[category]]);
  for (const action of ESCALATION) { if (actions.size >= attempt) break; actions.add(action); }
  if (attempt >= 5) ESCALATION.forEach((action) => actions.add(action));
  return { level: attempt - 1, actions: [...actions], previousFailure: previous.code, category, knownFailure };
}

/** Confirmed live failure fingerprints. Each names its shared subsystem, root cause, generic recovery, and the regression test proving it. */
export interface KnownFailure {
  id: string; discovered: string; category: FailureCategory; subsystem: string; rootCause: string; recovery: string; regressionTest: string;
  matches(code: string, message: string): boolean;
}
export const KNOWN_FAILURES: readonly KnownFailure[] = [
  {
    id: "BUSINESS_REVIEW_TITLE_CLIPPED", discovered: "2026-11-03 (September Campaign/Flow Metrics live run, accepted as PASS before the fix)", category: "TARGET_OBSCURED",
    subsystem: "Business Review capture adapter (scroll + crop)",
    rootCause: "Clearing the last Metrics row of the Composer bar scrolled the card until its top met viewport 0, but Klaviyo's dashboard scrolls inside a container below a non-scrolling page header, so the card title went under the header and the crop showed 'Dashboards / Business review' instead.",
    recovery: "Scrolling is bounded by the card's clip region (viewport ∩ overflow-clipping ancestors); a card scrolled under the header is scrolled back; otherwise the overlay is hidden. A crop whose own card title is not visible fails with BUSINESS_REVIEW_TARGET_OCCLUDED and is retried with extended-readiness.",
    regressionTest: "never scrolls its title under a non-scrolling page header; it hides the Composer instead",
    matches: (code, message) => code === "BUSINESS_REVIEW_TARGET_OCCLUDED" && /title is not visible/i.test(message),
  },
  {
    id: "SESSION_STORAGE_QUOTA", discovered: "2026-10-28 (June b4732590/b149eee7, September 07809233); recurred 2026-10-29 at the Subscriber Growth toolbar click", category: "CAPTURE_STATE_STORAGE_FULL",
    subsystem: "capture state store + every chrome.storage.session writer",
    rootCause: "Every section's state held a full-viewport screenshot and was never released, so the 10 MB session quota filled across sections, runs and months; later sections failed with 'Session storage quota bytes exceeded' or hung at Capturing when the failure write was refused too.",
    recovery: "Screenshots never go to session storage: capture states keep images in service-worker memory and store only small metadata; startup removes obsolete image-bearing states from older builds; the toolbar grant, click record and Subscriber Growth source are critical writes (cleanup, one retry, read-back, typed SESSION_STORAGE_QUOTA_EXCEEDED).",
    regressionTest: "never stores a screenshot in session storage and never throws when it is full",
    matches: (_code, message) => /quota bytes exceeded|QUOTA_BYTES/i.test(message),
  },
  {
    id: "HIDDEN_TAB_ANIMATION_FRAME_HANG", discovered: "2026-10-28 (September Flow Metrics 07809233/dbd864e0/d1e11bc9)", category: "STAGE_TIMEOUT",
    subsystem: "injected page adapters",
    rootCause: "Adapters awaited requestAnimationFrame directly; Chrome runs no frames in a hidden/background tab, so the adapter never returned and the section sat at 'Capturing' until the 120 s settle limit.",
    recovery: "Every adapter frame wait falls back to a timer; the runner's settle timeout aborts the stale attempt and the next one starts fresh with release-capture-state.",
    regressionTest: "does not hang when the tab runs no animation frames",
    matches: (code) => code === "CAPTURE_TIMEOUT",
  },
  {
    id: "SCRIPT_RESULT_NULL", discovered: "2026-10-28 (August Month Comparison 8fdc5fcc)", category: "SCRIPT_RESULT_INVALID",
    subsystem: "script execution / adapter result contract",
    rootCause: "An exception escaped the injected adapter (its own catch rebuilt diagnostics that threw again); Chrome reports that as result null — not a Month Comparison business-logic failure.",
    recovery: "All adapters return plain JSON from a guard that turns any exception into a typed failure; the next attempt settles the reloaded page before injecting a clean adapter.",
    regressionTest: "explains a null result from a replaced document, then loads the dashboard fresh again on the next attempt and passes",
    matches: (code) => code === "SCRIPT_RESULT_INVALID" || code === "SCRIPT_RESULT_UNDEFINED" || code === "SCRIPT_RESULT_EMPTY",
  },
  {
    id: "GRANTED_TAB_DEACTIVATED", discovered: "2026-10-28 (September d1e11bc9)", category: "TAB_NOT_ACTIVE",
    subsystem: "toolbar grant verification",
    rootCause: "Selecting another tab during a run invalidated the toolbar grant, turning a transient focus change into a permanent ACTION_NOT_INVOKED.",
    recovery: "Sources that reload a configured URL re-activate the same granted tab in its own window instead of destroying the grant.",
    regressionTest: "re-activates the same granted tab instead of destroying the grant",
    matches: (code) => code === "GRANTED_TAB_NOT_ACTIVE",
  },
  {
    id: "TOP_FLOWS_WINDOWS_LAYOUT", discovered: "2026-11-12 (Club Furniture October 2026, Windows Chrome run 7417360d; the same report passed on macOS)", category: "CARD_NOT_READY",
    subsystem: "Klaviyo viewport normalizer + Home dashboard adapter (Top performing flows row selection)",
    rootCause: "Klaviyo's width was measured as window.innerWidth, which on Windows includes classic scrollbars, so a tab normalized to 1390 px laid out narrower (horizontal scrollbar). Top Flows then ranked rows by painted top and judged 'a Draft in range' geometrically: any uncounted row painted above the fifth row's bottom produced TOP_FLOWS_NON_QUALIFYING_ROW_IN_VIEW, which the word fallback classified as VIEW_NOT_SELECTED.",
    recovery: "Width is Klaviyo's layout width (scrollbars excluded) in the normalizer, adapter, and runner. Rows come only from the table owning the verified header, ranked in DOM order, status read from the Status cell; geometry that disagrees with the ranking is a retried layout state; a table that cannot fit is KLAVIYO_VIEWPORT_TOO_NARROW with actual and required width.",
    regressionTest: "Windows layout: classic scrollbars, zoom, side panel and reflow give the same Top Flows decision",
    matches: (code) => code === "TOP_FLOWS_NON_QUALIFYING_ROW_IN_VIEW",
  },
  {
    id: "SUBSCRIBER_GROWTH_COMPOSER_OCCLUSION", discovered: "2026-11-12 (Steven Dann October 2026, Windows Chrome: sections 1–9 PASS, Section 10 failed 5/5 with Ask Composer over the card)", category: "TARGET_OBSCURED",
    subsystem: "Subscriber Growth capture adapter (crop placement + overlay handling)",
    rootCause: "Only an out-of-card element that was itself fixed/sticky/absolute was hidden; Klaviyo mounts the Composer in a static wrapper (or docks it in the page flow, where it ends the scroll area), so it was classed as page content and every attempt failed. The fit check used window.innerHeight, not the area Klaviyo actually paints, so a card clipped above the dock looked visible. Mac's taller window keeps the card above the Composer.",
    recovery: "The crop is placed inside the painted area (layout viewport ∩ clipping ancestors) by scrolling the card's own scroller; an in-flow Composer/assistant dock is collapsed only when the card cannot otherwise fit; floating non-report layers (whole chain, incl. static wrappers) are hidden with visibility+opacity, then the crop is re-measured and re-verified. Page content and modals still block. Every attempt records viewport, target, clip area and each occluder's element, text, rect, intersection and action.",
    regressionTest: "Windows Subscriber Growth occlusion: Ask Composer handled automatically, never captured through",
    matches: (code) => code === "SUBSCRIBER_GROWTH_TARGET_OCCLUDED",
  },
];
