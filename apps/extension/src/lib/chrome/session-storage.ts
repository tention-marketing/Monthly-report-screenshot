/**
 * chrome.storage.session holds only small transient metadata (10 MB quota shared by every key). Screenshots, page
 * dumps and evidence never go there: capture images stay in service-worker memory and evidence goes to the backend.
 * This module measures usage, removes known obsolete transient Tention state, and writes critical records so that a
 * refused write is a typed error — never a silent "success".
 */
export interface SessionArea {
  get(key: string | null): Promise<Record<string, unknown>>;
  set(values: Record<string, unknown>): Promise<void>;
  remove(key: string): Promise<void>;
  getBytesInUse?(keys: string | string[] | null): Promise<number>;
}

export const SESSION_QUOTA_BYTES = 10 * 1024 * 1024;
/** Capture-state keys (see auto-capture-service `autoCaptureKey`). */
export const CAPTURE_STATE_KEY_PREFIX = "tention.business-review-auto-capture.";
/** Diagnostic keys that are useful but replaceable; they must stay small. */
const REPLACEABLE_DIAGNOSTIC_KEYS = ["tention.business-review-discovery:last", "tention.subscriber-growth-source:last"];
const MAX_DIAGNOSTIC_BYTES = 16 * 1024;

export function approxBytes(key: string, value: unknown): number {
  let json = "";
  try { json = JSON.stringify(value) ?? ""; } catch { json = ""; }
  return new TextEncoder().encode(key).length + new TextEncoder().encode(json).length;
}

export interface SessionKeyUsage { key: string; approxBytes: number; valueType: string; arrayLength: number | null; objectKeyCount: number | null }
export interface SessionUsage { totalApproxBytes: number; bytesInUse: number | null; keys: SessionKeyUsage[] }

/** A safe size report of every session key, largest first. Values themselves are never returned. */
export async function sessionUsage(session: SessionArea): Promise<SessionUsage> {
  const all = await session.get(null);
  const keys = Object.entries(all).map(([key, value]) => ({
    key: key.slice(0, 120), approxBytes: approxBytes(key, value), valueType: Array.isArray(value) ? "array" : value === null ? "null" : typeof value,
    arrayLength: Array.isArray(value) ? value.length : null, objectKeyCount: value && typeof value === "object" && !Array.isArray(value) ? Object.keys(value).length : null,
  })).sort((left, right) => right.approxBytes - left.approxBytes);
  const bytesInUse = session.getBytesInUse ? await session.getBytesInUse(null).catch(() => null) : null;
  return { totalApproxBytes: keys.reduce((sum, item) => sum + item.approxBytes, 0), bytesInUse, keys };
}

/** Obsolete transient state: any stored capture state (images now live in worker memory) and oversized diagnostics. */
export function isObsoleteTransientEntry(key: string, value: unknown): boolean {
  if (key.startsWith(CAPTURE_STATE_KEY_PREFIX)) return approxBytes(key, value) > 4 * 1024 || /"data:image\//.test(safeJson(value));
  if (REPLACEABLE_DIAGNOSTIC_KEYS.includes(key)) return approxBytes(key, value) > MAX_DIAGNOSTIC_BYTES;
  return key.startsWith("tention.") && /"data:image\//.test(safeJson(value));
}

/** Removes only known obsolete Tention transient entries; grants, routes and verified sources are never touched. */
export async function releaseObsoleteTransientState(session: SessionArea): Promise<string[]> {
  const removed: string[] = [];
  for (const [key, value] of Object.entries(await session.get(null))) {
    if (isObsoleteTransientEntry(key, value)) { await session.remove(key); removed.push(key); }
  }
  return removed;
}

export type SessionStorageFailureCode = "SESSION_STORAGE_QUOTA_EXCEEDED" | "SESSION_STORAGE_WRITE_FAILED";
export class SessionStorageWriteError extends Error {
  constructor(public readonly code: SessionStorageFailureCode, message: string, public readonly diagnostics: { attemptedKey: string; approxAttemptedBytes: number; bytesInUse: number | null; removedKeys: string[] }) {
    super(message); this.name = "SessionStorageWriteError";
  }
}

/**
 * Writes a critical record and proves it by reading it back. On a refused write it releases obsolete transient state
 * and retries exactly once; a second refusal is a typed SessionStorageWriteError (never an infinite loop).
 */
export async function writeCriticalSession(session: SessionArea, values: Record<string, unknown>): Promise<void> {
  const attemptedKey = Object.keys(values).join(",");
  const approxAttemptedBytes = Object.entries(values).reduce((sum, [key, value]) => sum + approxBytes(key, value), 0);
  let removedKeys: string[] = [];
  let lastError: unknown = null;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      await session.set(values);
      const back = (await session.get(Object.keys(values).length === 1 ? Object.keys(values)[0]! : null)) ?? {};
      // Chrome returns stored objects with their keys sorted, so the read-back is compared independently of key order.
      if (Object.entries(values).every(([key, value]) => stableJson(back[key]) === stableJson(value))) return;
      lastError = new Error("The stored value did not read back.");
    } catch (error) { lastError = error; }
    if (attempt === 0) removedKeys = await releaseObsoleteTransientState(session).catch(() => []);
  }
  const quota = /quota/i.test(lastError instanceof Error ? lastError.message : String(lastError));
  const bytesInUse = session.getBytesInUse ? await session.getBytesInUse(null).catch(() => null) : null;
  throw new SessionStorageWriteError(quota ? "SESSION_STORAGE_QUOTA_EXCEEDED" : "SESSION_STORAGE_WRITE_FAILED",
    `Extension session storage refused ${attemptedKey}${quota ? " (quota exceeded)" : ""}.`, { attemptedKey: attemptedKey.slice(0, 120), approxAttemptedBytes, bytesInUse, removedKeys });
}

/**
 * Flattens diagnostics to bounded primitives: strings truncated, nested objects summarised as short JSON, at most
 * `maxKeys` keys. No DOM objects, errors, or cycles can survive it.
 */
export function boundedDiagnostics(input: Record<string, unknown> | null | undefined, maxKeys = 40, maxString = 240): Record<string, string | number | boolean | null> {
  const out: Record<string, string | number | boolean | null> = {};
  for (const [key, value] of Object.entries(input ?? {}).slice(0, maxKeys)) {
    out[key.slice(0, 60)] = value === null || value === undefined ? null
      : typeof value === "number" ? (Number.isFinite(value) ? value : null)
        : typeof value === "boolean" ? value
          : typeof value === "string" ? value.slice(0, maxString)
            : safeJson(value).slice(0, maxString);
  }
  return out;
}

function safeJson(value: unknown): string { try { return JSON.stringify(value) ?? ""; } catch { return ""; } }
/** JSON with object keys sorted at every level, for order-independent comparison. */
export function stableJson(value: unknown): string {
  const sort = (item: unknown): unknown => Array.isArray(item) ? item.map(sort) : item && typeof item === "object" ? Object.fromEntries(Object.keys(item as object).sort().map((key) => [key, sort((item as Record<string, unknown>)[key])])) : item;
  try { return JSON.stringify(sort(value)) ?? ""; } catch { return ""; }
}
