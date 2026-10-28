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
  AUTOMATIC_PERIOD_PROOF_MISMATCH: "PERIOD_NOT_CONFIRMED", TOP_CAMPAIGNS_NO_DATA: "NO_DATA", TOP_FLOWS_NO_DATA: "NO_DATA",
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
    id: "SESSION_STORAGE_QUOTA", discovered: "2026-10-28 (June b4732590/b149eee7, September 07809233)", category: "CAPTURE_STATE_STORAGE_FULL",
    subsystem: "capture state store (chrome.storage.session)",
    rootCause: "Every section's state held a full-viewport screenshot and was never released, so the 10 MB session quota filled across sections, runs and months; later sections failed with 'Session storage quota bytes exceeded' or hung at Capturing when the failure write was refused too.",
    recovery: "Runner releases each section's state once consumed and all states at run start; the store releases stale states and falls back to memory instead of throwing.",
    regressionTest: "never throws when session storage is full: releases stale capture states, then falls back to memory",
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
];
