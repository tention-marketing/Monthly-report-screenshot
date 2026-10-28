/**
 * Client-agnostic Klaviyo account identity check for the local live runner.
 * Mirrors the extension's discovery rules: a ".com" suffix and legal-entity
 * suffixes are ignored, and Klaviyo's 2-3 letter avatar initials may prefix the
 * visible account label (for example "AC Acme Home": avatar initials, then the account name).
 */
export function normalizeClientName(value: string): string {
  const trimmed = value.trim();
  let normalized = trimmed.toLocaleLowerCase().replace(/[^a-z0-9]+/g, "");
  if (/\.com\s*$/i.test(trimmed)) normalized = normalized.slice(0, -3);
  return normalized.replace(/(?:limitedliabilitycompany|incorporated|corporation|company|llc|inc|corp|ltd|limited)$/i, "");
}

export function accountLabelMatchesClient(accountLabel: string, clientName: string): boolean {
  const expected = normalizeClientName(clientName);
  if (!expected) return false;
  const label = accountLabel.replace(/\s+/g, " ").trim();
  return normalizeClientName(label) === expected
    || (/^[A-Z]{2,3}\s+(?=[A-Za-z0-9])/.test(label) && normalizeClientName(label.replace(/^[A-Z]{2,3}\s+/, "")) === expected);
}

export type AccountIdentityResult =
  | { ok: true; matchedLabel: string }
  | { ok: false; code: "ACCOUNT_CONTEXT_NOT_VERIFIED" | "ACCOUNT_CONTEXT_MISMATCH"; observedLabels: string[] };

/** The visible navigation must expose the configured client's account label; otherwise capture is refused. */
export function verifyAccountIdentity(observedLabels: readonly string[], clientName: string): AccountIdentityResult {
  const labels = [...new Set(observedLabels.map((label) => label.replace(/\s+/g, " ").trim()).filter(Boolean))];
  const matched = labels.find((label) => accountLabelMatchesClient(label, clientName));
  if (matched) return { ok: true, matchedLabel: matched };
  return { ok: false, code: labels.length === 0 ? "ACCOUNT_CONTEXT_NOT_VERIFIED" : "ACCOUNT_CONTEXT_MISMATCH", observedLabels: labels.slice(-40) };
}
