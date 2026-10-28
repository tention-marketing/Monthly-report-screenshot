/**
 * Shared diagnostics for a Klaviyo page-adapter injection that did not return a usable result. They are gathered
 * only after a failure, so a successful capture runs exactly as before, and they make an opaque Chrome result
 * (`null`, `undefined`, no frame) explainable: what came back, whether it was plain JSON, which path failed the
 * adapter contract, and whether the page navigated or its document was replaced while the script ran.
 */
export interface InjectionResultLike { frameId?: number; documentId?: string; result?: unknown; error?: unknown }
interface ProbeScripting { executeScript<Result>(details: { target: { tabId: number; frameIds: [number] }; func: (...args: never[]) => Result | Promise<Result>; args?: unknown[] }): Promise<Array<{ frameId?: number; documentId?: string; result?: Result }>> }
interface ProbeTabs { get(tabId: number): Promise<{ url?: string; status?: string }> }

export interface PageProbe { url: string; readyState: string; spinnerCount: number; cardReady: boolean | null }

/** Runs in the page: plain values only. */
export function probeKlaviyoPage(cardAliases: string[]): PageProbe {
  const shown = (element: Element) => { const rect = element.getBoundingClientRect(); const style = getComputedStyle(element); return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden" && !element.closest("[hidden],[aria-hidden=true]"); };
  const normalize = (value: string | null | undefined) => (value ?? "").replace(/\s+/g, " ").trim().toLocaleLowerCase();
  const spinners = Array.from(document.querySelectorAll("[aria-busy=true],[role=progressbar],[data-loading=true],[data-asc=Spinner]")).filter(shown);
  const heading = cardAliases.length ? Array.from(document.querySelectorAll("h1,h2,h3,h4,h5,h6,[role=heading]")).find((element) => shown(element) && cardAliases.some((alias) => normalize((element as HTMLElement).innerText || element.textContent) === normalize(alias))) : undefined;
  let cardReady: boolean | null = null;
  if (cardAliases.length) {
    cardReady = Boolean(heading);
    for (let node = heading?.parentElement ?? null, depth = 0; cardReady && node && depth < 7 && node.tagName !== "MAIN"; node = node.parentElement, depth += 1) if (spinners.some((spinner) => node!.contains(spinner))) cardReady = false;
  }
  return { url: `${location.origin}${location.pathname}`, readyState: document.readyState, spinnerCount: spinners.length, cardReady };
}

/** The first path at which a value breaks the shared page-adapter result contract, or null when it holds. */
export function adapterResultShapeError(value: unknown): string | null {
  if (value === null) return "result: null";
  if (typeof value !== "object" || Array.isArray(value)) return `result: ${Array.isArray(value) ? "array" : typeof value}`;
  const record = value as Record<string, unknown>;
  if (typeof record.ok !== "boolean") return "result.ok: not a boolean";
  if (!record.ok) return typeof record.code !== "string" ? "result.code: not a string" : typeof record.message !== "string" ? "result.message: not a string" : null;
  if (typeof record.sourceUrl !== "string") return "result.sourceUrl: not a string";
  const rect = record.targetRect;
  if (!rect || typeof rect !== "object") return "result.targetRect: missing";
  for (const key of ["x", "y", "width", "height", "viewportWidth", "viewportHeight"]) {
    if (typeof (rect as Record<string, unknown>)[key] !== "number" || !Number.isFinite((rect as Record<string, number>)[key])) return `result.targetRect.${key}: not a finite number`;
  }
  return null;
}

function jsonSerializable(value: unknown): boolean {
  try { JSON.stringify(value); return true; } catch { return false; }
}

export async function injectionFailureDiagnostics(input: {
  section: string; scripting: ProbeScripting; tabs: ProbeTabs; tabId: number; urlBefore: string | null;
  results: readonly InjectionResultLike[] | null; main: InjectionResultLike | null; cardAliases?: string[]; failureStage: string;
}): Promise<Record<string, unknown>> {
  const safe = (url: string | undefined | null) => { try { const parsed = new URL(url ?? ""); return `${parsed.origin}${parsed.pathname}`; } catch { return null; } };
  let probe: PageProbe | null = null; let probeDocumentId: string | null = null;
  try {
    const [first] = await input.scripting.executeScript<PageProbe>({ target: { tabId: input.tabId, frameIds: [0] }, func: probeKlaviyoPage as never, args: [input.cardAliases ?? []] });
    probe = first?.result && typeof first.result === "object" ? first.result : null; probeDocumentId = first?.documentId ?? null;
  } catch { /* the probe is best effort; its absence is itself recorded below */ }
  const after = await input.tabs.get(input.tabId).catch(() => null);
  const urlAfter = probe?.url ?? safe(after?.url);
  const value = input.main?.result;
  const chromeError = input.main?.error;
  return {
    SECTION: input.section,
    URL_BEFORE_SCRIPT: safe(input.urlBefore),
    URL_AFTER_SCRIPT: urlAfter,
    FRAME_ID: input.main?.frameId ?? null,
    FRAME_COUNT: input.results?.length ?? 0,
    EXECUTE_SCRIPT_RETURNED: input.results !== null,
    RESULT_TYPE: value === null ? "null" : Array.isArray(value) ? "array" : typeof value,
    RESULT_KEYS: value && typeof value === "object" ? Object.keys(value).slice(0, 20) : [],
    RESULT_JSON_SERIALIZABLE: jsonSerializable(value),
    SCHEMA_VALID: adapterResultShapeError(value) === null,
    SCHEMA_ERROR: value === undefined ? "result: undefined" : adapterResultShapeError(value),
    CHROME_ERROR: chromeError === undefined ? null : String(chromeError instanceof Error ? chromeError.message : typeof chromeError === "object" && chromeError && "message" in chromeError ? (chromeError as { message: unknown }).message : chromeError).slice(0, 500),
    NAVIGATION_DURING_SCRIPT: Boolean(input.urlBefore && urlAfter && safe(input.urlBefore) !== urlAfter) || after?.status === "loading",
    DOM_GENERATION_CHANGED: Boolean(input.main?.documentId && probeDocumentId && input.main.documentId !== probeDocumentId),
    CARD_READY: probe?.cardReady ?? null,
    SPINNER_COUNT: probe?.spinnerCount ?? null,
    PAGE_READY_STATE: probe?.readyState ?? null,
    FAILURE_STAGE: input.failureStage,
  };
}
