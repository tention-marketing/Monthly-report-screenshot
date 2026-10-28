/**
 * Produces the default internal identifier for a new client. Existing report
 * identities are never rewritten; callers must retain their stored id.
 */
export function deriveClientId(name: string): string {
  const normalized = name.trim().replace(/\.(?:com|net|org|io|co|ai)$/i, "").normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (!normalized) throw new Error("Client name must contain at least one letter or number.");
  return normalized.slice(0, 80);
}
