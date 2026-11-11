import { KLAVIYO_ACTIVE_TAB_GRANT_KEY } from "../klaviyo-navigation/active-tab-grant.js";

/**
 * Why automatic capture could not start, phrased for what the user must actually do. A missing toolbar invocation is
 * Chrome's activeTab rule, not a client-setup problem: a configured client only needs its Klaviyo tab opened and the
 * Tention Reports extension clicked once. "Client setup" is reported only when saved configuration is really missing.
 */
export type PreflightBlockerKind = "KLAVIYO_TAB_ACCESS_REQUIRED" | "KLAVIYO_ACCOUNT_MISMATCH" | "CLIENT_CONFIGURATION_MISSING" | "KLAVIYO_VERIFICATION_FAILED";

export interface PreflightBlocker {
  kind: PreflightBlockerKind;
  code: string | null;
  title: string;
  message: string;
  /** True when one toolbar click on the right Klaviyo tab can resolve it; the pending start then continues by itself. */
  resumesOnToolbarClick: boolean;
}

/** Chrome activeTab invocation/grant states: resolved by opening the Klaviyo tab and clicking the extension. */
export const TAB_ACCESS_CODES: ReadonlySet<string> = new Set([
  "ACTION_NOT_INVOKED", "KLAVIYO_ACTIVE_TAB_GRANT_REQUIRED", "KLAVIYO_CAPTURE_PERMISSION_REQUIRED",
  "GRANTED_TAB_CLOSED", "GRANTED_TAB_NOT_ACTIVE", "GRANTED_TAB_CHANGED_ORIGIN", "GRANTED_TAB_ROUTE_NOT_SUPPORTED",
]);
/** The open Klaviyo account is not (or cannot be proven to be) the report's client: capture fails closed. */
export const ACCOUNT_MISMATCH_CODES: ReadonlySet<string> = new Set(["ACCOUNT_CONTEXT_MISMATCH", "ACCOUNT_CONTEXT_NOT_VERIFIED", "SUBSCRIBER_GROWTH_ACCOUNT_UNPROVEN"]);

/** Reads the leading `CODE:` from a preflight error string such as "ACTION_NOT_INVOKED: Open the …". */
export function preflightErrorCode(error: string | null): string | null {
  return error?.match(/^([A-Z][A-Z0-9_]+):/)?.[1] ?? null;
}

export function classifyPreflightFailure(error: string | null, input: { clientName: string; profileConfigured: boolean; sourceConfigured: boolean }): PreflightBlocker {
  const code = preflightErrorCode(error);
  const detail = error && code ? error.slice(code.length + 1).trim() : error ?? "";
  if (!input.profileConfigured) {
    return { kind: "CLIENT_CONFIGURATION_MISSING", code: code ?? "CLIENT_CONFIGURATION_MISSING", title: "Client setup needs attention", message: `Save ${input.clientName}'s client configuration before capture.${detail ? ` ${detail}` : ""}`, resumesOnToolbarClick: false };
  }
  if (code && TAB_ACCESS_CODES.has(code)) {
    return { kind: "KLAVIYO_TAB_ACCESS_REQUIRED", code, title: "Klaviyo tab access required", message: `Open ${input.clientName} in Klaviyo and click the Tention Reports extension once to continue.`, resumesOnToolbarClick: true };
  }
  if (code && ACCOUNT_MISMATCH_CODES.has(code)) {
    return { kind: "KLAVIYO_ACCOUNT_MISMATCH", code, title: "Wrong Klaviyo account", message: `The open Klaviyo account could not be verified as ${input.clientName}. Nothing was captured. Switch to ${input.clientName} in Klaviyo and click the Tention Reports extension once to continue.`, resumesOnToolbarClick: true };
  }
  if (!input.sourceConfigured) {
    return { kind: "CLIENT_CONFIGURATION_MISSING", code, title: "Client setup needs attention", message: `${input.clientName}'s Klaviyo reporting source is not saved yet.${detail ? ` ${detail}` : ""}`, resumesOnToolbarClick: false };
  }
  return { kind: "KLAVIYO_VERIFICATION_FAILED", code, title: "Klaviyo could not be verified", message: `${detail || "The Klaviyo page could not be verified."} The saved ${input.clientName} configuration is unchanged.`, resumesOnToolbarClick: true };
}

/**
 * Calls `callback` each time a Tention Reports toolbar click grants a supported Klaviyo tab. The service worker writes
 * the grant after the invocation record, so the grant (not the invocation) is what proves capture can now run.
 */
export function watchToolbarInvocation(callback: () => void): () => void {
  type Listener = (changes: Record<string, { newValue?: unknown }>, area: string) => void;
  const storage = (globalThis as typeof globalThis & { chrome?: { storage?: { onChanged?: { addListener(listener: Listener): void; removeListener(listener: Listener): void } } } }).chrome?.storage?.onChanged;
  if (!storage) return () => undefined;
  const listener: Listener = (changes, area) => { if (area === "session" && changes[KLAVIYO_ACTIVE_TAB_GRANT_KEY]?.newValue) callback(); };
  storage.addListener(listener);
  return () => storage.removeListener(listener);
}
