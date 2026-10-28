import { REPORT_CAPTURE_SPEC_V1, type ReportPeriod, type ScreenshotType } from "@tention/report-schema";

/** Klaviyo Home (`/dashboard`) targets: Executive Summary and Top 5 Flows, both for the exact report month. */
export const dashboardScreenshotTypes = ["overview", "top_flows"] as const satisfies readonly ScreenshotType[];
export type DashboardScreenshotType = typeof dashboardScreenshotTypes[number];
/** Every Home target is canonical: automatic capture for these types is routed only to the Home dashboard adapter. */
export const canonicalDashboardScreenshotTypes = dashboardScreenshotTypes;
/** Top 5 Flows includes at most this many rows; 1-4 usable rows are captured as-is and 0 fails closed. */
export const TOP_FLOW_ROW_COUNT = 5;

export type DashboardFailureCode =
  | "DASHBOARD_NOT_FOUND"
  | "DASHBOARD_PAGE_NOT_READY"
  | "DASHBOARD_URL_REQUIRED"
  | "REPORT_PERIOD_NOT_CONFIRMED"
  | "BUSINESS_PERFORMANCE_SUMMARY_NOT_FOUND"
  | "TOP_PERFORMING_FLOWS_NOT_FOUND"
  | "TOP_FLOW_ROWS_NOT_FOUND"
  | "TOP_FLOWS_NO_DATA"
  | "TOP_FLOWS_NON_QUALIFYING_ROW_IN_VIEW"
  | "TARGET_NOT_VISIBLE"
  | "TARGET_BOUNDS_INVALID"
  | "TARGET_LAYOUT_NOT_STABLE"
  | "KLAVIYO_PAGE_ADAPTER_ERROR";

export interface DashboardTargetBounds {
  x: number; y: number; width: number; height: number; viewportWidth: number; viewportHeight: number;
  availableRowCount?: number; includedRowCount?: number;
  visibleControls?: Array<Record<string, string | boolean | null>>;
  stageTimingsMs?: Record<string, number>;
  /** Geometry only (no text): how the page and target were laid out when measured. */
  layoutEvidence?: Record<string, unknown>;
}
export interface DashboardInjectionPeriod { startDate: string; endDate: string; previousStartDate: string; previousEndDate: string }
export interface DashboardTargetDefinition {
  screenshotType: DashboardScreenshotType;
  sectionKey: string;
  sourceIdentity: string;
  semanticCard: "business-performance-summary" | "top-performing-flows";
  heading: string;
  missingCode: "BUSINESS_PERFORMANCE_SUMMARY_NOT_FOUND" | "TOP_PERFORMING_FLOWS_NOT_FOUND";
  /** When set, the crop ends at row min(rowLimit, usable rows); zero usable rows fail closed. */
  rowLimit?: number;
}

const definition = (
  screenshotType: DashboardScreenshotType,
  semanticCard: DashboardTargetDefinition["semanticCard"],
  heading: string,
  missingCode: DashboardTargetDefinition["missingCode"],
  rowLimit?: number,
): DashboardTargetDefinition => ({
  screenshotType,
  sectionKey: REPORT_CAPTURE_SPEC_V1.find((spec) => spec.screenshotType === screenshotType)!.key,
  sourceIdentity: REPORT_CAPTURE_SPEC_V1.find((spec) => spec.screenshotType === screenshotType)!.sourceIdentity,
  semanticCard,
  heading,
  missingCode,
  ...(rowLimit === undefined ? {} : { rowLimit }),
});

export const DASHBOARD_TARGETS: Readonly<Record<DashboardScreenshotType, DashboardTargetDefinition>> = {
  overview: definition("overview", "business-performance-summary", "Business performance summary", "BUSINESS_PERFORMANCE_SUMMARY_NOT_FOUND"),
  top_flows: definition("top_flows", "top-performing-flows", "Top performing flows", "TOP_PERFORMING_FLOWS_NOT_FOUND", TOP_FLOW_ROW_COUNT),
};

export function isDashboardScreenshotType(value: ScreenshotType): value is DashboardScreenshotType {
  return (dashboardScreenshotTypes as readonly ScreenshotType[]).includes(value);
}
export function isCanonicalDashboardScreenshotType(value: ScreenshotType): value is typeof canonicalDashboardScreenshotTypes[number] {
  return (canonicalDashboardScreenshotTypes as readonly ScreenshotType[]).includes(value);
}

export type DashboardAdapterResult =
  | { ok: true; sourceUrl: string; targetRect: DashboardTargetBounds; observedPeriod: { startDate: string; endDate: string } }
  | { ok: false; code: DashboardFailureCode; message: string; diagnostics?: Record<string, unknown> };

/**
 * Serialized into the explicitly toolbar-authorized `/dashboard` tab. Runtime
 * helpers are local because Chrome serializes this function, not module scope.
 */
export async function prepareDashboardCaptureDocument(
  target: DashboardTargetDefinition,
  expected: DashboardInjectionPeriod,
  dialogTimeoutMs = 6_000,
  periodConfirmTimeoutMs = 15_000,
): Promise<DashboardAdapterResult> {
  const stageTimingsMs: Record<string, number> = {};
  // What the Time period step saw and did; every failure from that stage on carries it.
  let periodDiagnostics: Record<string, unknown> | null = null;
  const operationStartedAt = performance.now();
  let failureStage = "PAGE_READY";
  const diagnosticSnapshot = (code: string, message: string) => {
    const redact = (value: string) => value.replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, "[redacted-email]").replace(/\b(?:bearer\s+)?[A-Za-z0-9_-]{32,}\b/gi, "[redacted-token]").replace(/\+?\d[\d ()-]{7,}\d/g, "[redacted-phone]");
    const normalized = (value: string) => value.replace(/\s+/g, " ").trim().toLocaleLowerCase();
    const safeUrl = `${location.origin}${location.pathname}`;
    const visibleText = (element: Element) => redact(((element as HTMLElement).innerText || element.textContent || "").replace(/\s+/g, " ").trim());
    const isVisible = (element: Element) => { const style = getComputedStyle(element); const rect = element.getBoundingClientRect(); return !element.closest("[hidden],[aria-hidden=true]") && style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0; };
    const heading = Array.from(document.querySelectorAll("h1,h2,h3,h4,h5,h6,[role=heading]")).find((element) => normalized(visibleText(element)) === normalized(target.heading));
    let card: Element | null = heading?.parentElement ?? null;
    while (card && card !== document.body && card !== document.documentElement && card.tagName !== "MAIN" && !card.querySelector("table,[role=table],[role=grid]")) card = card.parentElement;
    const sanitizeHtml = (source: Element | null) => {
      if (!source) return null;
      const clone = source.cloneNode(true) as Element;
      clone.querySelectorAll("script,style,iframe,svg,input,textarea,select,[contenteditable=true]").forEach((element) => element.remove());
      for (const element of [clone, ...Array.from(clone.querySelectorAll("*"))]) {
        for (const attribute of Array.from(element.attributes)) if (!["role", "aria-label", "aria-selected", "aria-pressed", "aria-current", "aria-busy", "data-state", "data-active"].includes(attribute.name)) element.removeAttribute(attribute.name); else attribute.value = redact(attribute.value);
        for (const child of Array.from(element.childNodes)) if (child.nodeType === Node.TEXT_NODE && child.textContent) child.textContent = redact(child.textContent);
      }
      return clone.outerHTML.slice(0, 40_000);
    };
    const controls = Array.from(document.querySelectorAll("button,[role=tab],[role=button],[aria-selected],[aria-pressed],[data-state],[data-active]")).filter(isVisible).slice(0, 80).map((element) => ({ text: visibleText(element).slice(0, 180), tag: element.tagName.toLowerCase(), role: element.getAttribute("role"), ariaSelected: element.getAttribute("aria-selected"), ariaPressed: element.getAttribute("aria-pressed"), visible: true }));
    const periodControl = Array.from(document.querySelectorAll("button,[role=button],[role=combobox]")).find((element) => /time period|date range|reporting period/i.test(visibleText(element)));
    const table = card?.querySelector("table,[role=table],[role=grid]") ?? null;
    const tableHeaders = table ? Array.from(table.querySelectorAll("thead th,[role=columnheader]")).map((element) => visibleText(element)).filter(Boolean).slice(0, 40) : [];
    const headings = Array.from(document.querySelectorAll("h1,h2,h3,h4,h5,h6,[role=heading]")).filter(isVisible).map((element) => visibleText(element)).filter(Boolean).slice(0, 60);
    const dateDialog = Array.from(document.querySelectorAll("dialog,[role=dialog]")).find(isVisible);
    const bodyClone = document.body.cloneNode(true) as HTMLElement;
    bodyClone.querySelectorAll("script,style,iframe,svg,input,textarea,select,[contenteditable=true]").forEach((element) => element.remove());
    for (const element of Array.from(bodyClone.querySelectorAll("*"))) for (const attribute of Array.from(element.attributes)) attribute.value = redact(attribute.value);
    for (const node of Array.from(bodyClone.querySelectorAll("*")).flatMap((element) => Array.from(element.childNodes)).filter((item) => item.nodeType === Node.TEXT_NODE && item.textContent)) node.textContent = redact(node.textContent!);
    // The descriptor crosses Chrome's serialization boundary with the
    // injected function; do not access module imports in this failure path.
    const expectedSourceIdentity = target.sourceIdentity;
    return { code, message: redact(message), failureStage, ...(periodDiagnostics ? { periodSetting: periodDiagnostics } : {}), stageTimingsMs: { ...stageTimingsMs, totalMs: Math.max(0, Math.round(performance.now() - operationStartedAt)) }, currentUrl: safeUrl, expectedUrl: safeUrl, expectedSourceIdentity, expectedPeriod: { startDate: expected.startDate, endDate: expected.endDate }, observedPeriod: periodControl ? visibleText(periodControl) : null, dateControlState: periodControl ? { text: visibleText(periodControl), tag: periodControl.tagName.toLowerCase(), role: periodControl.getAttribute("role"), ariaLabel: redact(periodControl.getAttribute("aria-label") ?? "") } : null, dateDialogState: dateDialog ? visibleText(dateDialog).slice(0, 1000) : null, headings, tableHeaders, expectedSemanticCard: target.heading, expectedView: "default", visibleControls: controls, loading: Array.from(document.querySelectorAll("[aria-busy=true],[role=progressbar],[data-loading=true],[data-asc=Spinner]")).some(isVisible), usableRowCount: table?.querySelectorAll("tbody tr,[role=rowgroup] [role=row]").length ?? null, pageHtml: bodyClone.outerHTML.slice(0, 40_000), cardHtml: sanitizeHtml(card), viewRegionHtml: sanitizeHtml(table?.parentElement ?? null) };
  };
  const fail = (code: DashboardFailureCode, message: string): DashboardAdapterResult => ({ ok: false, code, message, diagnostics: diagnosticSnapshot(code, message) });
  try {
    const normalize = (value: string | null | undefined) => (value ?? "").replace(/\s+/g, " ").trim().toLocaleLowerCase();
    const visible = (element: Element) => (element as HTMLElement).innerText?.trim() || element.textContent?.trim() || "";
    const name = (element: Element) => [element.getAttribute("aria-label"), element.getAttribute("aria-labelledby")?.split(/\s+/).map((id) => document.getElementById(id)?.textContent ?? "").join(" "), visible(element)].filter(Boolean).join(" ");
    // Verbatim copy of campaigns-capture's exported parser (drift-tested): one contiguous range, never two loose dates.
    function parseCampaignPeriodText(value: string | null | undefined): { startDate: string; endDate: string } | null {
      // One contiguous range only, with month and year inherited from whichever side shows them:
      // "August 1 – 31, 2026", "Aug 1 – Aug 31, 2026", "Aug 1, 2026 – Aug 31, 2026", "08/01/2026 – 08/31/2026".
      const text = (value ?? "").replace(/\s+/g, " ").trim().toLocaleLowerCase();
      const months = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
      const monthName = "(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\\.?";
      const day = "(\\d{1,2})(?:st|nd|rd|th)?";
      const dash = "\\s*(?:[–—-]|to)\\s*";
      const iso = (year: number, month: number, dayOfMonth: number) => {
        const date = new Date(Date.UTC(year, month - 1, dayOfMonth));
        return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === dayOfMonth ? date.toISOString().slice(0, 10) : null;
      };
      const month = (name: string) => months.indexOf(name.slice(0, 3)) + 1;
      const range = (start: string | null, end: string | null) => start && end && start <= end ? { startDate: start, endDate: end } : null;
      const match = (pattern: string) => text.match(new RegExp(`(?:^|[^\\w/])${pattern}(?![\\w/])`));
      const both = match(`${monthName} ${day},? (\\d{4})${dash}${monthName} ${day},? (\\d{4})`);
      if (both) return range(iso(Number(both[3]), month(both[1]!), Number(both[2])), iso(Number(both[6]), month(both[4]!), Number(both[5])));
      const sharedYear = match(`${monthName} ${day}${dash}${monthName} ${day},? (\\d{4})`);
      if (sharedYear) return range(iso(Number(sharedYear[5]), month(sharedYear[1]!), Number(sharedYear[2])), iso(Number(sharedYear[5]), month(sharedYear[3]!), Number(sharedYear[4])));
      const sharedMonth = match(`${monthName} ${day}${dash}${day},? (\\d{4})`);
      if (sharedMonth) return range(iso(Number(sharedMonth[4]), month(sharedMonth[1]!), Number(sharedMonth[2])), iso(Number(sharedMonth[4]), month(sharedMonth[1]!), Number(sharedMonth[3])));
      const numeric = match(`(\\d{1,2})/(\\d{1,2})/(\\d{4})${dash}(\\d{1,2})/(\\d{1,2})/(\\d{4})`);
      if (numeric) return range(iso(Number(numeric[3]), Number(numeric[1]), Number(numeric[2])), iso(Number(numeric[6]), Number(numeric[4]), Number(numeric[5])));
      const isoRange = match(`(\\d{4})-(\\d{2})-(\\d{2})${dash}(\\d{4})-(\\d{2})-(\\d{2})`);
      if (isoRange) return range(iso(Number(isoRange[1]), Number(isoRange[2]), Number(isoRange[3])), iso(Number(isoRange[4]), Number(isoRange[5]), Number(isoRange[6])));
      return null;
    }
    const hasExpectedPeriod = (value: string) => {
      const range = parseCampaignPeriodText(value);
      return range?.startDate === expected.startDate && range?.endDate === expected.endDate;
    };
    // Klaviyo keeps closed pickers (with stale date fields) in the DOM. Proof text must be what is painted
    // on the page: never hidden nodes, never text inside a dialog, popover, or listbox.
    const renderedCache = new Map<Element, boolean>();
    const rendered = (element: Element | null): boolean => {
      if (!element) return true;
      const cached = renderedCache.get(element); if (cached !== undefined) return cached;
      const style = getComputedStyle(element);
      const value = !element.hasAttribute("hidden") && element.getAttribute("aria-hidden") !== "true" && style.display !== "none" && style.visibility !== "hidden" && !(element.tagName === "DIALOG" && !element.hasAttribute("open")) && rendered(element.parentElement);
      renderedCache.set(element, value); return value;
    };
    const POPOVER = "dialog,[role=dialog],[role=listbox],[role=menu],[data-popper-placement]";
    const paintedTextIncludingPopover = (element: Element) => {
      renderedCache.clear();
      const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
      const parts: string[] = []; let node: Node | null;
      while ((node = walker.nextNode())) { const parent = node.parentElement; if (node.textContent?.trim() && parent && rendered(parent)) parts.push(node.textContent.trim()); }
      return parts.join(" ");
    };
    const paintedText = (element: Element) => {
      renderedCache.clear();
      const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
      const parts: string[] = []; let node: Node | null;
      while ((node = walker.nextNode())) { const parent = node.parentElement; if (node.textContent?.trim() && parent && rendered(parent) && !parent.closest(POPOVER)) parts.push(node.textContent.trim()); }
      return parts.join(" ");
    };
    const interactives = () => Array.from(document.querySelectorAll("button, input, select, [role=button], [role=combobox], [role=option], [role=menuitem]"));
    const periodControl = () => interactives().find((element) => /time period|date range|reporting period/i.test(name(element))) ?? null;
    const separatedText = (element: Element) => {
      const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
      const parts: string[] = []; let node: Node | null;
      while ((node = walker.nextNode())) if (node.textContent?.trim()) parts.push(node.textContent.trim());
      return parts.join(" ");
    };
    const findDashboardPeriodRegion = (control: Element) => {
      const parts = [paintedText(control)]; let ancestor: Element | null = control.parentElement;
      for (let depth = 0; ancestor && depth < 3 && ancestor !== document.body && ancestor !== document.documentElement && ancestor.tagName !== "MAIN"; depth += 1, ancestor = ancestor.parentElement) parts.push(paintedText(ancestor));
      return parts.join(" ");
    };
    const verifyDashboardPeriod = () => {
      const control = periodControl();
      return Boolean(control && hasExpectedPeriod(findDashboardPeriodRegion(control)));
    };
    const nextFrame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    const openDialogs = () => { renderedCache.clear(); return Array.from(document.querySelectorAll("dialog, [role=dialog]")).filter((element) => rendered(element) && element.getBoundingClientRect().width > 0); };
    const dialog = () => openDialogs().find((element) => /time period|date range|reporting period/i.test(name(element))) ?? null;
    const waitForClose = (open: Element) => new Promise<boolean>((resolve) => {
      const started = Date.now(); const check = () => {
        renderedCache.clear();
        if (!open.isConnected || !rendered(open) || open.getBoundingClientRect().width <= 0) { resolve(true); return; }
        if (Date.now() - started >= dialogTimeoutMs) { resolve(false); return; }
        window.setTimeout(check, 50);
      }; check();
    });
    const setValue = (input: HTMLInputElement, value: string) => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(input, value);
      input.dispatchEvent(new Event("input", { bubbles: true })); input.dispatchEvent(new Event("change", { bubbles: true }));
    };
    const format = (iso: string) => {
      const [year, month, day] = iso.split("-").map(Number);
      return new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" }).format(new Date(Date.UTC(year!, month! - 1, day!)));
    };

    const onDashboard = /^https:\/\/(?:[a-z0-9-]+\.)*klaviyo\.com$/i.test(window.location.origin) && /^\/dashboard\/?$/.test(window.location.pathname);
    if (!onDashboard) return fail("DASHBOARD_NOT_FOUND", "This is not the verified Klaviyo home dashboard.");
    const hasConversionMetric = () => Array.from(document.querySelectorAll("span, label, button, [aria-label], [role=heading], h1, h2, h3, h4, h5, h6"))
      .some((element) => normalize(name(element)) === "conversion metric");
    // Browser navigation can finish while the Klaviyo SPA is still painting
    // its shell. Wait for the actual report controls, not tabs.status=complete.
    const pageReadyStartedAt = performance.now();
    const shellDeadline = Date.now() + 12_000;
    while ((!hasConversionMetric() || !periodControl()) && Date.now() < shellDeadline) {
      await Promise.race([nextFrame(), new Promise<void>((resolve) => window.setTimeout(resolve, 100))]);
    }
    stageTimingsMs.pageReadyMs = Math.max(0, Math.round(performance.now() - pageReadyStartedAt));
    if (!hasConversionMetric() || !periodControl()) return fail("DASHBOARD_PAGE_NOT_READY", "The Klaviyo Overview shell and date controls did not become ready.");
    failureStage = "PERIOD";
    const periodStartedAt = performance.now();
    let control = periodControl();
    if (!control) return fail("REPORT_PERIOD_NOT_CONFIRMED", "Klaviyo's Time period control was not found.");
    const regionText = () => { const current = periodControl(); return current ? findDashboardPeriodRegion(current).slice(0, 300) : null; };
    const pause = (ms: number) => new Promise<void>((resolve) => window.setTimeout(resolve, ms));
    const poll = async <T,>(probe: () => T | null | undefined | false, timeoutMs: number): Promise<T | null> => {
      const deadline = Date.now() + timeoutMs;
      for (;;) { const value = probe(); if (value) return value; if (Date.now() >= deadline) return null; await pause(200); }
    };
    const shown = (element: Element) => { renderedCache.clear(); const rect = element.getBoundingClientRect(); return rendered(element) && rect.width > 0 && rect.height > 0; };
    // Cancel discards the picker's temporary state; it never changes Klaviyo settings.
    const dismissPicker = async () => {
      for (const open of openDialogs()) {
        const cancel = Array.from(open.querySelectorAll("button,[role=button]")).find((element) => shown(element) && normalize(visible(element)) === "cancel") as HTMLElement | undefined;
        if (cancel) cancel.click(); else open.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
      }
      return Boolean(await poll(() => openDialogs().length === 0, 3_000));
    };
    const failClosed = async (code: DashboardFailureCode, message: string) => { if (periodDiagnostics) periodDiagnostics.pickerDismissed = await dismissPicker(); return fail(code, message); };
    const regionBefore = regionText();
    if (!hasExpectedPeriod(findDashboardPeriodRegion(control))) {
      const describe = (input: HTMLInputElement) => ({ type: input.type, role: input.getAttribute("role"), label: name(input).slice(0, 80), placeholder: input.placeholder.slice(0, 40), value: input.value.slice(0, 40), shown: shown(input), disabled: input.disabled || input.readOnly });
      const pickers = (open: Element) => Array.from(open.querySelectorAll("select,[role=combobox],button[aria-haspopup],[aria-haspopup=listbox],button")).filter((element) => shown(element) && !/^(?:apply|cancel)$/i.test(normalize(visible(element))));
      const structure = (open: Element) => ({ inputs: Array.from(open.querySelectorAll("input")).map(describe).slice(0, 8), pickers: pickers(open).map((element) => visible(element).slice(0, 40)).slice(0, 6), buttons: Array.from(open.querySelectorAll("button,[role=button],[role=option],[role=radio],[role=menuitem]")).filter(shown).map((element) => visible(element).slice(0, 40)).filter(Boolean).slice(0, 20), text: paintedTextIncludingPopover(open).slice(0, 300) });
      periodDiagnostics = { regionBefore, dialogFound: false };
      if (openDialogs().length) await dismissPicker();
      // Klaviyo opens its picker only for a control on screen; scrolling is a temporary view change.
      (control as HTMLElement).scrollIntoView?.({ block: "center", inline: "nearest", behavior: "auto" }); await nextFrame(); await nextFrame();
      (control as HTMLElement).click(); await nextFrame();
      const open = await poll(dialog, dialogTimeoutMs);
      if (!open) return failClosed("REPORT_PERIOD_NOT_CONFIRMED", "Klaviyo's Time period dialog was not found.");
      Object.assign(periodDiagnostics, { dialogFound: true, dialogBefore: structure(open) });
      // Only fields painted in the picker count; Time period's own range precedes the comparison period's.
      const fieldText = (input: HTMLInputElement) => [name(input), input.placeholder, input.getAttribute("aria-label"), input.name].filter(Boolean).join(" ");
      const pickInputs = () => {
        const inputs = Array.from(open.querySelectorAll("input")).filter((input) => shown(input) && !input.disabled && !input.readOnly && !["hidden", "checkbox", "radio", "search", "file"].includes(input.type) && input.getAttribute("role") !== "combobox");
        const start = inputs.find((input) => /start|from/i.test(fieldText(input))) ?? null;
        const end = start ? inputs.slice(inputs.indexOf(start) + 1).find((input) => /end|\bto\b/i.test(fieldText(input))) ?? null : null;
        return start && end ? { start, end } : null;
      };
      if (!pickInputs()) {
        // The Time period select (first picker in the dialog) must be switched to Custom to expose its fields.
        const select = pickers(open)[0];
        periodDiagnostics.timePeriodSelect = select ? visible(select).slice(0, 40) : null;
        if (select instanceof HTMLSelectElement) {
          const option = Array.from(select.options).find((item) => /^custom\b/i.test(item.text.trim()));
          if (option) { Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")?.set?.call(select, option.value); select.dispatchEvent(new Event("change", { bubbles: true })); periodDiagnostics.customChosen = true; }
        } else if (select) {
          (select as HTMLElement).click();
          const custom = await poll(() => Array.from(document.querySelectorAll("[role=option],[role=menuitem],[role=menuitemradio],li,button,[role=button]")).find((element) => shown(element) && /^custom\b/i.test(normalize(visible(element)))) as HTMLElement | undefined, 3_000);
          periodDiagnostics.customOptionFound = Boolean(custom);
          if (custom) { custom.click(); periodDiagnostics.customChosen = true; }
        }
      }
      const fields = await poll(pickInputs, 3_000);
      if (!fields) { periodDiagnostics.dialogAfterCustom = structure(open); return failClosed("REPORT_PERIOD_NOT_CONFIRMED", "The requested report period could not be selected safely."); }
      // Type in the field's own displayed format ("Aug 01, 2026", "Aug 1, 2026", "08/01/2026", or ISO for date inputs).
      const formatFor = (input: HTMLInputElement, iso: string) => {
        const [year, month, day] = iso.split("-") as [string, string, string];
        if (input.type === "date") return iso;
        // Klaviyo may clear a field when Custom is chosen; any field in the picker shows its display format.
        const shownValues = [input.value, ...Array.from(open.querySelectorAll("input")).map((field) => field.value)].filter((value) => /\d{4}/.test(value));
        if (/\d{1,2}\/\d{1,2}\/\d{4}|mm\/dd/i.test(`${shownValues.join(" ")} ${input.placeholder}`)) return `${month}/${day}/${year}`;
        const short = format(iso);
        // "Aug 1, 2026" anywhere means unpadded days; otherwise "Mmm dd, yyyy" values mean Klaviyo pads them ("Aug 01, 2026").
        const padded = !shownValues.some((value) => /\b[a-z]{3}\.? \d, \d{4}/i.test(value)) && shownValues.some((value) => /\b[a-z]{3}\.? \d{2}, \d{4}/i.test(value));
        return padded ? short.replace(/ (\d),/, " 0$1,") : short;
      };
      // React tracks the native value setter; focus, set, then fire the events its inputs commit on.
      const commit = (input: HTMLInputElement, value: string) => {
        input.focus(); setValue(input, value);
        input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })); input.dispatchEvent(new KeyboardEvent("keyup", { key: "Enter", bubbles: true }));
        input.dispatchEvent(new FocusEvent("blur")); input.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
      };
      commit(fields.start, formatFor(fields.start, expected.startDate)); await nextFrame();
      commit(fields.end, formatFor(fields.end, expected.endDate)); await nextFrame();
      periodDiagnostics.valuesAfterSet = [fields.start.value, fields.end.value];
      const apply = await poll(() => Array.from(open.querySelectorAll("button, [role=button]")).find((element) => shown(element) && normalize(visible(element)) === "apply" && !(element as HTMLButtonElement).disabled && element.getAttribute("aria-disabled") !== "true"), 3_000);
      periodDiagnostics.dialogAtApply = structure(open);
      periodDiagnostics.applyFound = Boolean(apply);
      if (!apply) return failClosed("REPORT_PERIOD_NOT_CONFIRMED", "Klaviyo's Apply button was not found.");
      (apply as HTMLElement).click(); periodDiagnostics.applyClicked = true;
      const closed = await waitForClose(open);
      periodDiagnostics.dialogClosed = closed;
      // Klaviyo refetches after Apply; only its re-rendered, painted Time period region proves the month.
      const confirmed = closed && await poll(verifyDashboardPeriod, periodConfirmTimeoutMs);
      periodDiagnostics.regionAfter = regionText();
      if (!confirmed) return failClosed("REPORT_PERIOD_NOT_CONFIRMED", "Klaviyo did not show the selected report month after applying it.");
      control = periodControl(); if (!control || !hasExpectedPeriod(findDashboardPeriodRegion(control))) return failClosed("REPORT_PERIOD_NOT_CONFIRMED", "Klaviyo did not confirm the selected report month.");
    }
    // Nothing may cover the page when it is captured: a left-open picker would hide the card.
    if (openDialogs().length && !await dismissPicker()) return fail("TARGET_NOT_VISIBLE", "A Klaviyo picker stayed open over the dashboard.");
    stageTimingsMs.periodSetMs = Math.max(0, Math.round(performance.now() - periodStartedAt));
    const headings = () => Array.from(document.querySelectorAll("h1, h2, h3, h4, h5, h6, [role=heading]"));
    const includes = (text: string, phrase: string) => normalize(text).includes(normalize(phrase));
    const hasCardStructure = (candidate: Element) => {
      const text = separatedText(candidate);
      if (!includes(text, target.heading)) return false;
      if (target.screenshotType === "overview") return includes(text, "Total revenue") && includes(text, "Attributed revenue");
      return includes(text, "Flow") && includes(text, "Status") && (includes(text, "Deliveries") || includes(text, "Conversion"));
    };
    const isDashboardRoot = (candidate: Element) => candidate.tagName === "MAIN" || candidate.getAttribute("role") === "main";
    // Klaviyo's own Home section titles (product labels, identical for every account).
    const otherCardHeadings = ["Business performance summary", "Top performing flows", "Recent campaign messages", "Account alerts", "Pick up where you left off"].filter((heading) => normalize(heading) !== normalize(target.heading));
    // The card is the smallest ancestor of its heading holding the card's own labels. It never grows past
    // that point to find a period: a region holding the Time period control or another card is the page,
    // and the page's control range is not the card's (Klaviyo re-renders cards after the control).
    const structuralCard = () => {
      const heading = headings().find((element) => normalize(visible(element)) === normalize(target.heading));
      if (!heading) return null;
      let candidate = heading.parentElement;
      while (candidate && candidate !== document.body && candidate !== document.documentElement && !isDashboardRoot(candidate)) {
        if (hasCardStructure(candidate)) {
          const control = periodControl();
          const holdsPage = (control && candidate.contains(control)) || headings().some((other) => candidate!.contains(other) && otherCardHeadings.some((name) => normalize(visible(other)) === normalize(name)));
          return holdsPage ? null : { card: candidate, heading };
        }
        candidate = candidate.parentElement;
      }
      return null;
    };
    const findDashboardCard = () => { const found = structuralCard(); return found && hasExpectedPeriod(paintedText(found.card)) ? found : null; };
    const hasMeaningfulBounds = (card: { width: number; height: number }, heading: DOMRect) =>
      card.width > 0 && card.height > Math.max(80, heading.height * 2);
    const flowHeaderLabels = ["Flow", "Status", "Type", "Deliveries", "Placed Order", "Percent change"];
    const hasFlowHeaderLabels = (element: Element) => {
      const text = separatedText(element);
      return flowHeaderLabels.every((label) => includes(text, label));
    };
    const findFlowHeader = (card: Element) => {
      const all = Array.from(card.querySelectorAll("*"));
      const flowLabel = all.find((element) => normalize(separatedText(element)) === "flow") ?? null;
      let candidate = flowLabel?.parentElement ?? null;
      while (candidate && candidate !== card) {
        if (hasFlowHeaderLabels(candidate)) return candidate;
        candidate = candidate.parentElement;
      }
      return all.find((element) => hasFlowHeaderLabels(element)) ?? null;
    };
    // A `display: contents` row (CSS-grid tables) has no box of its own; its
    // painted extent is the union of its cells.
    const boxOf = (element: Element): { left: number; top: number; right: number; bottom: number; width: number; height: number } => {
      const rect = element.getBoundingClientRect();
      if ((rect.width > 0 && rect.height > 0) || getComputedStyle(element).display !== "contents") return { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom, width: rect.width, height: rect.height };
      const boxes = Array.from(element.children).map(boxOf).filter((box) => box.width > 0 && box.height > 0);
      if (!boxes.length) return { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom, width: 0, height: 0 };
      const left = Math.min(...boxes.map((box) => box.left)); const top = Math.min(...boxes.map((box) => box.top));
      const right = Math.max(...boxes.map((box) => box.right)); const bottom = Math.max(...boxes.map((box) => box.bottom));
      return { left, top, right, bottom, width: right - left, height: bottom - top };
    };
    // Live and Manual flows send messages and are ranked; Draft flows are not. The status pattern also
    // identifies "any flow row" so a crop can be checked for rows it would show without counting.
    const QUALIFYING_FLOW_STATUS = /\b(?:live|manual)\b/i;
    const ANY_FLOW_STATUS = /\b(?:live|manual|draft)\b/i;
    const usableFlowRows = (card: Element, header: Element, status: RegExp = QUALIFYING_FLOW_STATUS) => {
      const cardRect = card.getBoundingClientRect(); const headerRect = boxOf(header);
      const visibleBelowHeader = (row: Element) => {
        const rect = boxOf(row);
        return rect.width > 0 && rect.height > 0 && rect.top >= headerRect.bottom && rect.top >= cardRect.top && rect.bottom <= cardRect.bottom;
      };
      const byTop = (left: Element, right: Element) => boxOf(left).top - boxOf(right).top;
      const nativeRows = Array.from(card.querySelectorAll("tbody tr")).filter((row) => visibleBelowHeader(row) && status.test(separatedText(row)) && row.querySelectorAll("td").length >= 2);
      const ariaRows = Array.from(card.querySelectorAll('[role="row"]')).filter((row) => visibleBelowHeader(row) && status.test(separatedText(row)) && Boolean(row.querySelector('[role="gridcell"], [role="cell"]')));
      // A flow row names one flow. A structured element holding several flow links
      // is a wrapper around the list (e.g. a layout row), never a flow row.
      const linkCount = (element: Element) => element.querySelectorAll("a, [role=link]").length;
      const structuredRows = [...new Set([...nativeRows, ...ariaRows])].filter((row) => linkCount(row) <= 1);
      if (structuredRows.length) return structuredRows.sort(byTop);
      const flowLinks = Array.from(card.querySelectorAll("a, [role=link]")).filter((link) => Boolean(separatedText(link).trim()));
      // A flow row holds exactly one flow link. Climbing past that point reaches
      // the shared container of every row, which must never count as one row.
      const rowFromLink = (link: Element) => {
        let candidate = link.parentElement;
        while (candidate && candidate !== card) {
          if (flowLinks.filter((other) => candidate!.contains(other)).length > 1) return null;
          const text = separatedText(candidate);
          if (status.test(text) && /\d/.test(text) && visibleBelowHeader(candidate)) return candidate;
          candidate = candidate.parentElement;
        }
        return null;
      };
      return [...new Set(flowLinks.flatMap((link) => {
        const row = rowFromLink(link); return row ? [row] : [];
      }))].sort(byTop);
    };
    // Klaviyo Home cards can be narrower than the content they paint (tables and
    // summary panels overflow the wrapper). Crop the painted extent, not the box.
    const paintedHorizontalExtent = (card: Element, bottom: number) => {
      const cardRect = card.getBoundingClientRect();
      let left = cardRect.left; let right = cardRect.right;
      for (const element of Array.from(card.querySelectorAll("*"))) {
        const rect = element.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0 || rect.top >= bottom || rect.bottom <= cardRect.top) continue;
        const style = getComputedStyle(element);
        if (style.visibility === "hidden" || style.display === "none" || element.closest("[hidden],[aria-hidden=true]")) continue;
        left = Math.min(left, rect.left); right = Math.max(right, rect.right);
      }
      return { left: Math.max(0, left), right: Math.min(window.innerWidth, right) };
    };
    type Measurement = { rect: { x: number; y: number; width: number; height: number; left: number; top: number; right: number; bottom: number }; availableRowCount?: number; includedRowCount?: number };
    const measureTarget = (value: NonNullable<ReturnType<typeof findDashboardCard>>): Measurement | "no_header" | "no_rows" | "non_qualifying_in_view" => {
      const cardRect = value.card.getBoundingClientRect();
      const painted = (bottom: number) => { const extent = paintedHorizontalExtent(value.card, bottom); return { x: extent.left, y: cardRect.y, width: extent.right - extent.left, height: bottom - cardRect.top, left: extent.left, top: cardRect.top, right: extent.right, bottom }; };
      if (target.screenshotType !== "top_flows") return { rect: painted(cardRect.bottom) };
      const header = findFlowHeader(value.card);
      if (!header) return "no_header";
      const rows = usableFlowRows(value.card, header);
      if (!rows.length) return "no_rows";
      // Chrome serializes this function, so the limit travels on the target descriptor.
      // Never pad: 1-4 usable rows are captured as the real count.
      const includedRowCount = Math.min(target.rowLimit ?? 5, rows.length);
      const finalRowRect = boxOf(rows[includedRowCount - 1]!);
      if (finalRowRect.bottom > cardRect.bottom || finalRowRect.bottom <= cardRect.top) return "no_header";
      // The crop is contiguous, so every flow row painted above the last counted row must itself be counted.
      const counted = new Set(rows.slice(0, includedRowCount));
      if (usableFlowRows(value.card, header, ANY_FLOW_STATUS).some((row) => !counted.has(row) && boxOf(row).top < finalRowRect.bottom)) return "non_qualifying_in_view";
      return {
        rect: painted(finalRowRect.bottom),
        availableRowCount: rows.length,
        includedRowCount,
      };
    };
    const box = (element: Element | null) => { if (!element) return null; const rect = element.getBoundingClientRect(); return { x: Math.round(rect.left * 10) / 10, y: Math.round(rect.top * 10) / 10, w: Math.round(rect.width * 10) / 10, h: Math.round(rect.height * 10) / 10 }; };
    const describe = (element: Element) => ({ tag: element.tagName.toLowerCase(), role: element.getAttribute("role"), display: getComputedStyle(element).display, box: box(element), links: element.querySelectorAll("a, [role=link]").length });
    const layoutEvidence = (card: Element, heading: Element) => {
      const viewport = window.visualViewport;
      const rows = Array.from(card.querySelectorAll('tbody tr, [role="row"]'));
      const links = Array.from(card.querySelectorAll("a, [role=link]"));
      const widest = Array.from(card.querySelectorAll("*")).reduce<Element | null>((best, element) => !best || element.getBoundingClientRect().right > best.getBoundingClientRect().right ? element : best, null);
      return {
        window: { innerWidth: window.innerWidth, innerHeight: window.innerHeight, clientWidth: document.documentElement.clientWidth, devicePixelRatio: window.devicePixelRatio, scrollX: window.scrollX, scrollY: window.scrollY },
        visualViewport: viewport ? { width: viewport.width, height: viewport.height, offsetLeft: viewport.offsetLeft, offsetTop: viewport.offsetTop, pageLeft: viewport.pageLeft, scale: viewport.scale } : null,
        card: describe(card), heading: box(heading), rightmostDescendant: widest ? describe(widest) : null,
        structuredRows: { count: rows.length, first: rows.slice(0, 3).map(describe) },
        links: { count: links.length, first: links.slice(0, 3).map(describe) },
      };
    };
    const cardLoading = (candidate: Element) => Array.from(candidate.querySelectorAll("[aria-busy=true],[role=progressbar],[data-loading=true],[data-asc=Spinner]"))
      .some((element) => { const style = getComputedStyle(element); const bounds = element.getBoundingClientRect(); return style.display !== "none" && style.visibility !== "hidden" && bounds.width > 0 && bounds.height > 0; });
    const hasVisibleLoading = () => Array.from(document.querySelectorAll("[aria-busy=true],[role=progressbar],[data-loading=true],[data-asc=Spinner]"))
      .some((element) => { const style = getComputedStyle(element); const bounds = element.getBoundingClientRect(); return style.display !== "none" && style.visibility !== "hidden" && bounds.width > 0 && bounds.height > 0; });
    failureStage = "CARD_RESOLUTION";
    const cardResolveStartedAt = performance.now();
    let resolved = findDashboardCard();
    if (!resolved && !structuralCard() && !hasVisibleLoading()) return fail(target.missingCode, `The ${target.heading} card was not found with its required semantic evidence.`);
    const cardDeadline = Date.now() + 15_000;
    while ((!resolved || cardLoading(resolved.card)) && Date.now() < cardDeadline) {
      await Promise.race([nextFrame(), new Promise<void>((resolve) => window.setTimeout(resolve, 100))]);
      resolved = findDashboardCard();
    }
    if (!resolved && structuralCard()) { periodDiagnostics = { ...(periodDiagnostics ?? {}), cardPeriodText: paintedText(structuralCard()!.card).slice(0, 200) }; return fail("REPORT_PERIOD_NOT_CONFIRMED", `The ${target.heading} card did not show the selected report month.`); }
    if (!resolved || cardLoading(resolved.card)) return fail("DASHBOARD_PAGE_NOT_READY", `The ${target.heading} content did not finish rendering on Klaviyo Overview.`);
    stageTimingsMs.cardResolveMs = Math.max(0, Math.round(performance.now() - cardResolveStartedAt));
    failureStage = "CONTENT_READY";
    const contentReadyStartedAt = performance.now();
    const scrollStartedAt = performance.now();
    resolved.card.scrollIntoView?.({ block: "nearest", inline: "nearest", behavior: "auto" });
    stageTimingsMs.scrollMs = Math.max(0, Math.round(performance.now() - scrollStartedAt));
    const measurementFailure = (value: "no_header" | "no_rows" | "non_qualifying_in_view") => value === "no_rows"
      ? fail("TOP_FLOWS_NO_DATA", "Top performing flows showed its table header but no usable flow rows for the selected month.")
      : value === "non_qualifying_in_view" ? fail("TOP_FLOWS_NON_QUALIFYING_ROW_IN_VIEW", "A Draft flow sits between the top-ranked Live/Manual flows, so a contiguous Top Flows crop would show a flow it does not count.")
      : fail("TOP_FLOW_ROWS_NOT_FOUND", "The Top performing flows table header or visible flow rows were not found.");
    const initial = measureTarget(resolved);
    if (typeof initial === "string") return measurementFailure(initial);
    let previous = initial.rect; let stable = 0;
    for (let attempt = 0; attempt < 8; attempt += 1) {
      await nextFrame(); resolved = findDashboardCard();
      if (!resolved) return fail(target.missingCode, `The ${target.heading} card was replaced without its required semantic evidence.`);
      const measurement = measureTarget(resolved);
      if (typeof measurement === "string") return measurementFailure(measurement);
      const rect = measurement.rect; const headingRect = resolved.heading.getBoundingClientRect(); const fullyVisible = rect.width > 0 && rect.height > 0 && rect.left >= 0 && rect.top >= 0 && rect.right <= window.innerWidth && rect.bottom <= window.innerHeight;
      if (!fullyVisible) { previous = rect; continue; }
      if (rect.x === previous.x && rect.y === previous.y && rect.width === previous.width && rect.height === previous.height) stable += 1; else stable = 0;
      previous = rect;
      if (stable >= 1) {
        if (!hasMeaningfulBounds(rect, headingRect)) return fail("TARGET_BOUNDS_INVALID", `The ${target.heading} target bounds only cover a heading-sized region.`);
        const visibleControls = Array.from(resolved.card.querySelectorAll("button,[role=tab],[role=button],[aria-selected],[aria-pressed],[data-state],[data-active]")).filter((element) => { const style = getComputedStyle(element); const controlRect = element.getBoundingClientRect(); return !element.closest("[hidden],[aria-hidden=true]") && style.display !== "none" && style.visibility !== "hidden" && controlRect.width > 0 && controlRect.height > 0; }).slice(0, 40).map((element) => ({ text: visible(element).slice(0, 180), tag: element.tagName.toLowerCase(), role: element.getAttribute("role"), ariaSelected: element.getAttribute("aria-selected"), ariaPressed: element.getAttribute("aria-pressed"), visible: true }));
        stageTimingsMs.contentReadyMs = Math.max(0, Math.round(performance.now() - contentReadyStartedAt));
        stageTimingsMs.totalMs = Math.max(0, Math.round(performance.now() - operationStartedAt));
        return { ok: true, sourceUrl: window.location.href, targetRect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height, viewportWidth: window.innerWidth, viewportHeight: window.innerHeight, visibleControls, stageTimingsMs: { ...stageTimingsMs }, layoutEvidence: layoutEvidence(resolved.card, resolved.heading), ...(measurement.availableRowCount === undefined ? {} : { availableRowCount: measurement.availableRowCount, includedRowCount: measurement.includedRowCount }) }, observedPeriod: { startDate: expected.startDate, endDate: expected.endDate } };
      }
    }
    const finalRect = previous;
    if (finalRect.width <= 0 || finalRect.height <= 0 || finalRect.left < 0 || finalRect.top < 0 || finalRect.right > window.innerWidth || finalRect.bottom > window.innerHeight) return fail("TARGET_NOT_VISIBLE", `The ${target.heading} target is not fully visible.`);
    if (!hasMeaningfulBounds(finalRect, resolved!.heading.getBoundingClientRect())) return fail("TARGET_BOUNDS_INVALID", `The ${target.heading} target bounds only cover a heading-sized region.`);
    return fail("TARGET_LAYOUT_NOT_STABLE", `The ${target.heading} target layout did not stabilize.`);
  } catch (error) {
    return fail("KLAVIYO_PAGE_ADAPTER_ERROR", error instanceof Error && error.message ? error.message : "The Klaviyo home dashboard helper failed.");
  }
}
