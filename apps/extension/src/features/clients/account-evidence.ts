import { klaviyoAccountDisplayName } from "@tention/report-schema";

/**
 * Which Klaviyo account a page belongs to, judged from the account labels it shows, against the client's account
 * binding verified during onboarding (primary) and the client name (secondary).
 *
 * Harmless presentation differences are normalized: Klaviyo prefixes an account with a 2–3 letter avatar code
 * ("AC Acme Home" vs "Acme Home"), and controls read "Account: …". A page that shows another saved client's
 * account is WRONG_ACCOUNT; a page that shows no recognizable account is UNKNOWN (never treated as a match).
 */
export type AccountEvidence = "THIS_CLIENT" | "WRONG_ACCOUNT" | "UNKNOWN";
export interface AccountIdentity { name: string; accountLabel?: string | null }

/** Avatar initials are removed by the shared rule (only when they are the name's own first letters). */
export function accountIdentityKey(label: string): string {
  const text = klaviyoAccountDisplayName(label.trim().replace(/^(?:account|workspace|organization)(?:\s+name)?\s*[:\-]\s*/i, ""));
  return text.toLocaleLowerCase().normalize("NFKD").replace(/[^a-z0-9]/g, "");
}

function keysOf(identity: AccountIdentity): string[] {
  return [identity.accountLabel, identity.name].filter((value): value is string => Boolean(value?.trim())).map(accountIdentityKey).filter((key) => key.length >= 4);
}
const shows = (labels: readonly string[], keys: readonly string[]) => labels.some((label) => {
  const key = accountIdentityKey(label);
  return keys.some((expected) => key === expected || key.includes(expected));
});

export function klaviyoAccountEvidence(labels: readonly string[], client: AccountIdentity, otherClients: readonly AccountIdentity[]): AccountEvidence {
  const own = keysOf(client);
  if (shows(labels, own)) return "THIS_CLIENT";
  // Only another client that is not a name-variant of this one can make the page definitively someone else's.
  const others = otherClients.flatMap(keysOf).filter((key) => !own.some((mine) => mine.includes(key) || key.includes(mine)));
  return shows(labels, others) ? "WRONG_ACCOUNT" : "UNKNOWN";
}
