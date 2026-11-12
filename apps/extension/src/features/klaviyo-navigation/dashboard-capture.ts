import { REPORT_CAPTURE_SPEC_V1, type ReportPeriod, type ScreenshotType } from "@tention/report-schema";
import type { PeriodEntryApi } from "./injected/period-entry-contract.js";
import type { BusinessPerformanceEvidence } from "@tention/report-schema";
import { MIN_KLAVIYO_VIEWPORT_WIDTH } from "../automatic-capture/klaviyo-viewport.js";

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
  | "KLAVIYO_VIEWPORT_TOO_NARROW"
  | "TARGET_NOT_VISIBLE"
  | "TARGET_BOUNDS_INVALID"
  | "TARGET_LAYOUT_NOT_STABLE"
  | "KLAVIYO_PAGE_ADAPTER_ERROR";

export interface DashboardTargetBounds {
  x: number; y: number; width: number; height: number; viewportWidth: number; viewportHeight: number;
  /** The width Klaviyo lays out to (classic scrollbars excluded); `viewportWidth` stays the screenshot's CSS width. */
  layoutViewportWidth?: number;
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
  /** Reported as the required width when the target cannot fit; travels on the descriptor (the adapter is serialized). */
  minLayoutWidth?: number;
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
  minLayoutWidth: MIN_KLAVIYO_VIEWPORT_WIDTH,
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
  | { ok: true; sourceUrl: string; targetRect: DashboardTargetBounds; observedPeriod: { startDate: string; endDate: string };
      /** Executive Summary only: the card's own rendered money values, read after its exact period was proven. */
      businessPerformance?: BusinessPerformanceEvidence | null; businessPerformanceIssues?: string[];
      /** Per value: the labels found and the values beside them (diagnosis only). */
      businessPerformanceReadout?: Record<string, { labels: string[]; values: string[] }> }
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
  // Chrome reports an exception that escapes an injected function as a bare `null` result (run 8fdc5fcc), and a
  // DOM object or cycle in the result cannot cross back to the extension. Every exit is therefore plain JSON, and
  // any exception — including one raised while building failure diagnostics — becomes a typed, serializable failure.
  try {
    const result = await (async (): Promise<DashboardAdapterResult> => {
      const stageTimingsMs: Record<string, number> = {};
      // What the Time period step saw and did; every failure from that stage on carries it.
      let periodDiagnostics: Record<string, unknown> | null = null;
      // Every re-positioning step (scroller, scroll delta, target and visible-area geometry) for failure diagnostics.
      const positioning: Record<string, unknown>[] = [];
      // Top Flows only: viewport geometry, header/table rects, and every candidate row with why it was or was not counted.
      let selection: Record<string, unknown> | null = null;
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
        return { code, message: redact(message), failureStage, ...(periodDiagnostics ? { periodSetting: periodDiagnostics } : {}), ...(positioning.length ? { positioning: positioning.slice(-6) } : {}), ...(selection ? { selection: JSON.parse(JSON.stringify(selection, (key, value) => key === "text" && typeof value === "string" ? redact(value) : value)) } : {}), stageTimingsMs: { ...stageTimingsMs, totalMs: Math.max(0, Math.round(performance.now() - operationStartedAt)) }, currentUrl: safeUrl, expectedUrl: safeUrl, expectedSourceIdentity, expectedPeriod: { startDate: expected.startDate, endDate: expected.endDate }, observedPeriod: periodControl ? visibleText(periodControl) : null, dateControlState: periodControl ? { text: visibleText(periodControl), tag: periodControl.tagName.toLowerCase(), role: periodControl.getAttribute("role"), ariaLabel: redact(periodControl.getAttribute("aria-label") ?? "") } : null, dateDialogState: dateDialog ? visibleText(dateDialog).slice(0, 1000) : null, headings, tableHeaders, expectedSemanticCard: target.heading, expectedView: "default", visibleControls: controls, loading: Array.from(document.querySelectorAll("[aria-busy=true],[role=progressbar],[data-loading=true],[data-asc=Spinner]")).some(isVisible), usableRowCount: table?.querySelectorAll("tbody tr,[role=rowgroup] [role=row]").length ?? null, pageHtml: bodyClone.outerHTML.slice(0, 40_000), cardHtml: sanitizeHtml(card), viewRegionHtml: sanitizeHtml(table?.parentElement ?? null) };
      };
      const fail = (code: DashboardFailureCode, message: string): DashboardAdapterResult => ({ ok: false, code, message, diagnostics: (() => { try { return diagnosticSnapshot(code, message); } catch (error) { return { snapshotError: error instanceof Error ? error.message : String(error) }; } })() });
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
          const range = selectedRange(value);
          return range?.startDate === expected.startDate && range?.endDate === expected.endDate;
        };
        // Only the selected range proves the period: "<selected> compared to <comparison>" is split by the shared helper,
        // and without the helper nothing is proven (the period step then fails closed).
        const sharedPeriod = () => (globalThis as unknown as { __tentionPeriodEntry?: PeriodEntryApi }).__tentionPeriodEntry;
        const selectedRange = (value: string) => { const helper = sharedPeriod(); return helper?.currentPeriodText ? parseCampaignPeriodText(helper.currentPeriodText(value)) : null; };
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
        // Chrome runs no animation frames in a hidden or background tab; a frame wait must never hang there.
        const nextFrame = () => new Promise<void>((resolve) => { const fallback = window.setTimeout(resolve, 100); requestAnimationFrame(() => { window.clearTimeout(fallback); resolve(); }); });
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
          const rounds: Record<string, unknown>[] = [];
          periodDiagnostics = { regionBefore, renderedPeriodBefore: regionBefore, expectedPeriod: { startDate: expected.startDate, endDate: expected.endDate }, sourcePage: location.pathname, dialogFound: false, rounds };
          const periodEntry = sharedPeriod();
          if (!periodEntry?.timePeriodSection || !periodEntry.currentPeriodText) return failClosed("REPORT_PERIOD_NOT_CONFIRMED", "The shared period helper was not loaded, so the report month could not be set. Nothing was captured.");
          /**
           * One pass over Klaviyo's Time period dialog. Round 2 runs only when round 1 applied the dates but the page kept
           * another range, and it always re-selects Custom before entering the dates again.
           */
          const setReportPeriod = async (round: number): Promise<{ confirmed: boolean; failure: string | null }> => {
            const record: Record<string, unknown> = { round, renderedPeriodBefore: regionText() }; rounds.push(record);
            if (openDialogs().length) await dismissPicker();
            const current = periodControl(); if (!current) { record.failureReason = "time period control not found"; return { confirmed: false, failure: "Klaviyo's Time period control was not found." }; }
            // Klaviyo opens its picker only for a control on screen; scrolling is a temporary view change.
            (current as HTMLElement).scrollIntoView?.({ block: "center", inline: "nearest", behavior: "auto" }); await nextFrame(); await nextFrame();
            record.timePeriodControlText = visible(current).slice(0, 80);
            (current as HTMLElement).click(); await nextFrame();
            const open = await poll(dialog, dialogTimeoutMs);
            if (!open) { record.failureReason = "dialog not found"; return { confirmed: false, failure: "Klaviyo's Time period dialog was not found." }; }
            periodDiagnostics!.dialogFound = true; if (round === 1) periodDiagnostics!.dialogBefore = structure(open);
            const section = () => periodEntry.timePeriodSection(open);
            const before = section();
            record.pickerMode = before.pickerText.slice(0, 40); record.hasComparisonPeriod = before.hasComparison;
            const shownBefore = before.fields();
            record.pickerStartValueBefore = shownBefore?.start.value ?? null; record.pickerEndValueBefore = shownBefore?.end.value ?? null;
            // Switches the Time period picker (never the Comparison period's) to Custom; proven only by its own date fields.
            const chooseCustomPreset = async () => {
              const select = section().picker;
              // The mode Klaviyo showed first; each round's own mode is in `rounds`.
              if (!("timePeriodSelect" in periodDiagnostics!)) periodDiagnostics!.timePeriodSelect = select ? visible(select).slice(0, 40) : null;
              if (select instanceof HTMLSelectElement) {
                const option = Array.from(select.options).find((item) => /^custom\b/i.test(item.text.trim()));
                if (option) { Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")?.set?.call(select, option.value); select.dispatchEvent(new Event("change", { bubbles: true })); periodDiagnostics!.customChosen = true; }
              } else if (select) {
                const existing = new Set(Array.from(document.querySelectorAll("*")));
                (select as HTMLElement).click();
                // Only an option that appeared for this picker, labelled exactly "Custom" (the page has other "Custom…" text).
                const custom = await poll(() => Array.from(document.querySelectorAll("[role=option],[role=menuitem],[role=menuitemradio],li,button,[role=button]")).find((element) => !existing.has(element) && shown(element) && /^custom$/i.test(normalize(visible(element)))) as HTMLElement | undefined, 3_000);
                periodDiagnostics!.customOptionFound = Boolean(custom);
                if (custom) { custom.click(); periodDiagnostics!.customChosen = true; }
              }
              return Boolean(await poll(() => section().isCustom && section().fields(), 3_000));
            };
            // A preset ("Last 30 days", "Last 7 days", …) is never kept: Time period must be Custom, whatever fields are
            // visible elsewhere in the dialog. Round 2 re-selects Custom even when the picker already says so.
            if (!before.isCustom || !before.fields() || round > 1) record.customChosen = await chooseCustomPreset();
            const fields = await poll(() => section().fields(), 3_000);
            if (!fields) { periodDiagnostics!.dialogAfterCustom = structure(open); record.failureReason = "time period date fields not found"; return { confirmed: false, failure: "The requested report period could not be selected safely." }; }
            // Type in the field's own displayed format ("Aug 01, 2026", "Aug 1, 2026", "08/01/2026", or ISO for date inputs).
            const formatFor = (input: HTMLInputElement, iso: string) => {
              const [year, month, day] = iso.split("-") as [string, string, string];
              if (input.type === "date") return iso;
              const shownValues = [input.value, ...Array.from(open.querySelectorAll("input")).map((field) => field.value)].filter((value) => /\d{4}/.test(value));
              if (/\d{1,2}\/\d{1,2}\/\d{4}|mm\/dd/i.test(`${shownValues.join(" ")} ${input.placeholder}`)) return `${month}/${day}/${year}`;
              const short = format(iso);
              const padded = !shownValues.some((value) => /\b[a-z]{3}\.? \d, \d{4}/i.test(value)) && shownValues.some((value) => /\b[a-z]{3}\.? \d{2}, \d{4}/i.test(value));
              return padded ? short.replace(/ (\d),/, " 0$1,") : short;
            };
            // Round 2 starts from the calendar-first helper path with fresh fields; the helper itself escalates strategies.
            const entry = await periodEntry.enterDateRange({ fields: () => section().fields(), startDate: expected.startDate, endDate: expected.endDate, format: formatFor, reselectCustom: chooseCustomPreset });
            // The first round's entry stays the headline diagnostic; every round keeps its own.
            record.entry = entry;
            if (round === 1) { periodDiagnostics!.entry = entry; periodDiagnostics!.pickerValuesEntered = entry.pickerValuesEntered; periodDiagnostics!.valuesAfterSet = entry.observed; }
            record.interactionMethod = entry.strategy ?? (entry.attempts.length ? entry.attempts.map(({ strategy }) => strategy).join("+") : "none");
            const after = section().fields();
            record.pickerStartValueAfter = after?.start.value ?? null; record.pickerEndValueAfter = after?.end.value ?? null;
            record.pickerModeAfterEntry = section().pickerText.slice(0, 40);
            if (!entry.ok) { record.failureReason = "date fields did not accept the report dates"; return { confirmed: false, failure: `Klaviyo's date fields did not accept ${expected.startDate} – ${expected.endDate}; Apply was not clicked and nothing was captured.` }; }
            if (!section().isCustom) { record.failureReason = "time period picker is not Custom"; return { confirmed: false, failure: "Klaviyo's Time period did not stay on Custom; Apply was not clicked and nothing was captured." }; }
            const apply = await poll(() => Array.from(open.querySelectorAll("button, [role=button]")).find((element) => shown(element) && normalize(visible(element)) === "apply" && !(element as HTMLButtonElement).disabled && element.getAttribute("aria-disabled") !== "true"), 3_000);
            periodDiagnostics!.dialogAtApply = structure(open);
            periodDiagnostics!.applyFound = Boolean(apply); record.applyFound = Boolean(apply);
            if (!apply) { record.failureReason = "apply not found"; return { confirmed: false, failure: "Klaviyo's Apply button was not found." }; }
            (apply as HTMLElement).click(); periodDiagnostics!.applyClicked = true; record.applyClicked = true;
            const closed = await waitForClose(open);
            periodDiagnostics!.dialogClosed = closed; record.dialogClosed = closed;
            // Klaviyo refetches after Apply; only its re-rendered, painted selected range proves the month.
            // Round 1 stops waiting once Klaviyo has visibly kept its previous range for a while; round 2 then reacts.
            const keptSince = Date.now(); const previous = JSON.stringify(selectedRange(String(record.renderedPeriodBefore ?? "")));
            const settled = () => verifyDashboardPeriod() ? "confirmed" : round === 1 && Date.now() - keptSince >= Math.min(6_000, periodConfirmTimeoutMs) && JSON.stringify(selectedRange(regionText() ?? "")) === previous ? "kept" : null;
            const confirmed = Boolean(closed && await poll(settled, periodConfirmTimeoutMs) === "confirmed");
            record.renderedPeriodAfter = regionText(); periodDiagnostics!.regionAfter = record.renderedPeriodAfter; periodDiagnostics!.renderedPeriodAfter = record.renderedPeriodAfter;
            if (!confirmed) record.failureReason = `page kept ${JSON.stringify(selectedRange(String(record.renderedPeriodAfter ?? "")))} after Apply`;
            return { confirmed, failure: confirmed ? null : "Klaviyo did not show the selected report month after applying it." };
          };
          let result = await setReportPeriod(1);
          // React to what round 1 actually did. Only when Apply was clicked and Klaviyo still shows the range it showed
          // before (it ignored or restored it, e.g. back to Last 30 days) is a second, different pass worth it: Custom is
          // re-selected and the dates entered again. Any other outcome is reported as it is.
          const before = JSON.stringify(selectedRange(String(rounds[0]?.renderedPeriodBefore ?? "")));
          const kept = JSON.stringify(selectedRange(String(rounds[0]?.renderedPeriodAfter ?? "")));
          if (!result.confirmed && rounds[0]?.applyClicked && before === kept) { rounds[0]!.retryReason = "Klaviyo kept or restored the previous range after Apply"; result = await setReportPeriod(2); }
          if (!result.confirmed) return failClosed("REPORT_PERIOD_NOT_CONFIRMED", result.failure ?? "Klaviyo did not show the selected report month.");
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
        /**
         * Business performance summary values beside their own labels: a label's nearest container holding exactly one
         * money value and no other summary label. Percentages and compact values are never money.
         */
        const readBusinessPerformance = (card: Element): { evidence: BusinessPerformanceEvidence | null; issues: string[]; readout: Record<string, { labels: string[]; values: string[] }> } => {
          const LABELS: Array<[string, RegExp]> = [["totalRevenue", /^total revenue$/i], ["totalAttributedRevenue", /^attributed revenue(?: \(.*\))?$/i], ["campaignRevenue", /^campaigns$/i], ["flowRevenue", /^flows$/i], ["emailAttributedRevenue", /^email$/i], ["smsAttributedRevenue", /^(?:text message|sms)$/i], ["perRecipient", /^per recipient$/i], ["push", /^push$/i], ["whatsapp", /^whatsapp$/i]];
          const MONEY = /^[-\u2212]?\s*[^\d\s.,%-]{1,4}\s?\d{1,3}(?:,\d{3})*(?:\.\d+)?$|^[-\u2212]?\s*\d{1,3}(?:,\d{3})*(?:\.\d+)?\s?[^\d\s.,%-]{1,4}$/;
          const textOf = (element: Element) => (element.textContent ?? "").replace(/\s+/g, " ").trim();
          const labelKey = (element: Element) => LABELS.find(([, pattern]) => pattern.test(textOf(element)))?.[0] ?? null;
          const all = Array.from(card.querySelectorAll("*"));
          // The deepest element whose whole text is the label or the money value, even when Klaviyo splits that text
          // across child elements ("Attributed revenue <span>(20.83% of total)</span>").
          const labelled = all.filter((element) => labelKey(element) !== null && !Array.from(element.children).some((child) => labelKey(child) !== null));
          const leaves = all.filter((element) => MONEY.test(textOf(element)) && !Array.from(element.children).some((child) => MONEY.test(textOf(child))));
          const valueBeside = (label: Element) => {
            for (let node: Element | null = label.parentElement, depth = 0; node && node !== card && depth < 4; node = node.parentElement, depth += 1) {
              if (labelled.filter((other) => node!.contains(other)).length > 1) return null;
              const monies = leaves.filter((leaf) => node!.contains(leaf) && MONEY.test(textOf(leaf)));
              if (monies.length === 1) return textOf(monies[0]!);
              if (monies.length > 1) return null;
            }
            return null;
          };
          const readout: Record<string, { labels: string[]; values: string[] }> = {};
          const read = (key: string) => {
            const labels = labelled.filter((leaf) => labelKey(leaf) === key);
            const values = [...new Set(labels.map(valueBeside).filter((value): value is string => value !== null))];
            readout[key] = { labels: labels.map((label) => textOf(label).slice(0, 60)), values: values.slice(0, 4) };
            return values.length === 1 ? values[0]! : null;
          };
          const periodText = (paintedText(card).match(/[A-Z][a-z]{2,8}\.? \d{1,2}, \d{4}\s*[-–—]\s*[A-Z][a-z]{2,8}\.? \d{1,2}, \d{4}/) ?? [""])[0];
          const values = { totalRevenue: read("totalRevenue"), totalAttributedRevenue: read("totalAttributedRevenue"), emailAttributedRevenue: read("emailAttributedRevenue"), smsAttributedRevenue: read("smsAttributedRevenue"), campaignRevenue: read("campaignRevenue"), flowRevenue: read("flowRevenue") };
          const names: Record<string, string> = { totalRevenue: "Total Revenue", emailAttributedRevenue: "Email Attributed Revenue", campaignRevenue: "Revenue from Campaigns", flowRevenue: "Revenue from Flows" };
          const issues = Object.keys(names).filter((key) => values[key as keyof typeof values] === null).map((key) => `${names[key]} was not found beside its label on the Business performance summary.`);
          if (!periodText) issues.push("The Business performance summary did not show its period beside the values.");
          if (issues.length) return { evidence: null, issues, readout };
          return { readout, evidence: { totalRevenue: values.totalRevenue!, totalAttributedRevenue: values.totalAttributedRevenue, emailAttributedRevenue: values.emailAttributedRevenue!, smsAttributedRevenue: values.smsAttributedRevenue, campaignRevenue: values.campaignRevenue!, flowRevenue: values.flowRevenue!, visiblePeriodText: periodText }, issues: [] };
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
        // Live and Manual flows send messages and are ranked; Draft flows are not.
        const QUALIFYING_FLOW_STATUS = /\b(?:live|manual)\b/i;
        const ANY_FLOW_STATUS = /\b(?:live|manual|draft)\b/i;
        // The area Klaviyo paints into: the window minus classic (space-taking, e.g. Windows) scrollbars of the document
        // and of Klaviyo's full-width app scroller. Mirrors readKlaviyoLayoutViewport (klaviyo-viewport.ts). On macOS
        // overlay scrollbars take no space and this equals innerWidth × innerHeight.
        const layoutViewport = () => {
          const doc = document.documentElement;
          const width = doc.clientWidth > 0 ? Math.min(doc.clientWidth, window.innerWidth) : window.innerWidth;
          const height = doc.clientHeight > 0 ? Math.min(doc.clientHeight, window.innerHeight) : window.innerHeight;
          let appGutter = 0;
          for (const element of Array.from(document.querySelectorAll("body *"))) {
            const html = element as HTMLElement;
            if (html.offsetWidth < width / 2 || html.clientWidth <= 0 || html.scrollHeight <= html.clientHeight + 1) continue;
            const style = getComputedStyle(html);
            if (!/^(?:auto|scroll|overlay)$/.test(style.overflowY)) continue;
            const gutter = html.offsetWidth - html.clientWidth - (parseFloat(style.borderLeftWidth) || 0) - (parseFloat(style.borderRightWidth) || 0);
            if (gutter > appGutter && gutter < 60) appGutter = gutter;
          }
          return { width: Math.round(width - appGutter), height };
        };
        // Where `element` can actually be seen: the layout viewport ∩ every overflow-clipping ancestor.
        const visibleAreaOf = (element: Element) => {
          const viewport = layoutViewport();
          const bounds = { top: 0, left: 0, right: viewport.width, bottom: viewport.height };
          for (let node = element.parentElement; node && node !== document.body && node !== document.documentElement; node = node.parentElement) {
            const style = getComputedStyle(node);
            if (/^(?:visible)?$/.test(style.overflowY) && /^(?:visible)?$/.test(style.overflowX)) continue;
            const box = node.getBoundingClientRect(); if (box.width <= 0 || box.height <= 0) continue;
            bounds.top = Math.max(bounds.top, box.top); bounds.left = Math.max(bounds.left, box.left); bounds.right = Math.min(bounds.right, box.right); bounds.bottom = Math.min(bounds.bottom, box.bottom);
          }
          return bounds;
        };
        // Painted = rendered (no hidden/aria-hidden/display:none/visibility:hidden ancestor), not fully transparent, with a box.
        const painted = (element: Element) => {
          if (!rendered(element)) return false;
          for (let node: Element | null = element; node && node !== document.body; node = node.parentElement) if (getComputedStyle(node).opacity === "0") return false;
          const box = boxOf(element); return box.width > 0 && box.height > 0;
        };
        const domOrder = (left: Element, right: Element) => left === right ? 0 : left.compareDocumentPosition(right) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1;
        type FlowCandidate = { element: Element; box: ReturnType<typeof boxOf>; status: string; statusSource: "role=status" | "status-column" | "row-text"; flowRow: boolean; qualifying: boolean };
        /**
         * Every rendered row of the flow table that owns the verified header, in Klaviyo's own ranking order (DOM order).
         * Only that table's rows can qualify: nothing else on Home (Pick up where you left off, campaign cards, drafts,
         * navigation) and nothing else inside the card. Geometry never decides rank; it is only checked afterwards.
         */
        const flowCandidates = (card: Element, header: Element): { scope: Element; statusColumn: number; candidates: FlowCandidate[] } => {
          renderedCache.clear();
          const table = header.closest("table,[role=table],[role=grid]");
          const scope = table && card.contains(table) ? table : card;
          const headerCells = (() => { const cells = Array.from(header.querySelectorAll("th,[role=columnheader]")); return cells.length ? cells : Array.from(header.children); })();
          const statusColumn = headerCells.findIndex((cell) => normalize(separatedText(cell)) === "status");
          const isHeaderPart = (row: Element) => row === header || row.contains(header) || header.contains(row) || Boolean(row.closest("thead"));
          // A flow row names one flow. A structured element holding several flow links is a wrapper around the list.
          const linkCount = (element: Element) => element.querySelectorAll("a, [role=link]").length;
          const structured = [...new Set([
            ...Array.from(scope.querySelectorAll("tbody tr")).filter((row) => row.querySelectorAll("td").length >= 2),
            ...Array.from(scope.querySelectorAll('[role="row"]')).filter((row) => Boolean(row.querySelector('[role="gridcell"], [role="cell"]'))),
          ])].filter((row) => !isHeaderPart(row) && linkCount(row) <= 1 && painted(row) && ANY_FLOW_STATUS.test(separatedText(row)));
          let rows = structured;
          if (!rows.length) {
            // Non-table layouts: a flow row is the largest ancestor of exactly one flow link that shows a status and a number.
            const flowLinks = Array.from(scope.querySelectorAll("a, [role=link]")).filter((link) => Boolean(separatedText(link).trim()) && !isHeaderPart(link));
            const rowFromLink = (link: Element) => {
              for (let candidate = link.parentElement; candidate && candidate !== scope && candidate !== card; candidate = candidate.parentElement) {
                if (flowLinks.filter((other) => candidate!.contains(other)).length > 1) return null;
                const text = separatedText(candidate);
                if (ANY_FLOW_STATUS.test(text) && /\d/.test(text) && painted(candidate)) return candidate;
              }
              return null;
            };
            rows = [...new Set(flowLinks.flatMap((link) => { const row = rowFromLink(link); return row ? [row] : []; }))];
          }
          const candidates = rows.sort(domOrder).map((element): FlowCandidate => {
            // Status comes from the row's own Status cell; whole-row text (which also holds the flow name) is the last resort.
            const marked = Array.from(element.querySelectorAll("[role=status]")).filter((node) => rendered(node)).map((node) => separatedText(node)).join(" ").trim();
            const cells = Array.from(element.children);
            const [status, statusSource] = marked ? [marked, "role=status" as const]
              : statusColumn >= 0 && cells.length === headerCells.length ? [separatedText(cells[statusColumn]!), "status-column" as const]
              : [separatedText(element), "row-text" as const];
            const flowRow = ANY_FLOW_STATUS.test(status);
            return { element, box: boxOf(element), status: status.slice(0, 40), statusSource, flowRow, qualifying: flowRow && QUALIFYING_FLOW_STATUS.test(status) };
          });
          return { scope, statusColumn, candidates };
        };
        // Klaviyo Home cards can be narrower than the content they paint (tables and
        // summary panels overflow the wrapper). Crop the painted extent, not the box,
        // limited to what Klaviyo paints (never a classic scrollbar).
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
          return { left: Math.max(0, left), right: Math.min(layoutViewport().width, right) };
        };
        type Measurement = { rect: { x: number; y: number; width: number; height: number; left: number; top: number; right: number; bottom: number }; availableRowCount?: number; includedRowCount?: number };
        type MeasurementIssue = "no_header" | "no_rows" | "non_qualifying_in_view" | "layout_unstable" | "needs_horizontal_scroll" | "too_narrow";
        const r = (value: number) => Math.round(value * 10) / 10;
        const rectOf = (box: { left: number; top: number; width: number; height: number }) => ({ x: r(box.left), y: r(box.top), w: r(box.width), h: r(box.height) });
        const viewportGeometry = () => {
          const viewport = window.visualViewport; const scroller = document.scrollingElement ?? document.documentElement; const layout = layoutViewport();
          return { innerWidth: window.innerWidth, innerHeight: window.innerHeight, layoutWidth: layout.width, layoutHeight: layout.height, classicScrollbarWidth: Math.max(0, window.innerWidth - layout.width), devicePixelRatio: window.devicePixelRatio,
            visualViewport: viewport ? { width: r(viewport.width), height: r(viewport.height), scale: viewport.scale, offsetLeft: r(viewport.offsetLeft), pageLeft: r(viewport.pageLeft) } : null,
            scrollX: r(window.scrollX), scrollY: r(window.scrollY), pageScrollLeft: r(scroller.scrollLeft), horizontalOverflow: scroller.scrollWidth > scroller.clientWidth + 1 };
        };
        const measureTarget = (value: NonNullable<ReturnType<typeof findDashboardCard>>): Measurement | MeasurementIssue => {
          const cardRect = value.card.getBoundingClientRect();
          const paintedRect = (bottom: number) => { const extent = paintedHorizontalExtent(value.card, bottom); return { x: extent.left, y: cardRect.y, width: extent.right - extent.left, height: bottom - cardRect.top, left: extent.left, top: cardRect.top, right: extent.right, bottom }; };
          if (target.screenshotType !== "top_flows") return { rect: paintedRect(cardRect.bottom) };
          const header = findFlowHeader(value.card);
          if (!header) { selection = { decision: "no_header", viewport: viewportGeometry(), card: rectOf(cardRect) }; return "no_header"; }
          const { scope, statusColumn, candidates } = flowCandidates(value.card, header);
          const flowRows = candidates.filter((candidate) => candidate.flowRow);
          const qualifying = flowRows.filter((candidate) => candidate.qualifying);
          // Chrome serializes this function, so the limit travels on the target descriptor. Never pad: 1-4 rows are the real count.
          const included = qualifying.slice(0, target.rowLimit ?? 5);
          const last = included[included.length - 1];
          const headerBox = boxOf(header); const area = visibleAreaOf(header);
          const decide = <T extends MeasurementIssue | "ok">(decision: T, reason: string): T => {
            selection = {
              decision, reason, viewport: viewportGeometry(), card: rectOf(cardRect), header: rectOf(headerBox), table: rectOf(boxOf(scope)), tableIsCard: scope === value.card,
              visibleArea: { left: r(area.left), top: r(area.top), right: r(area.right), bottom: r(area.bottom) }, statusColumn,
              availableRowCount: qualifying.length, includedRowCount: included.length, lastIncludedRank: last ? candidates.indexOf(last) + 1 : null,
              candidates: candidates.slice(0, 15).map((candidate, index) => ({
                rank: index + 1, rect: rectOf(candidate.box), status: candidate.status, statusSource: candidate.statusSource, qualifying: candidate.qualifying, included: included.includes(candidate),
                rejection: included.includes(candidate) ? null : !candidate.flowRow ? "no Live/Manual/Draft status" : !candidate.qualifying ? `status ${candidate.status}: not ranked` : `ranked below the top ${target.rowLimit ?? 5}`,
                // Text is used only in failure diagnostics; it is stripped from success evidence.
                text: separatedText(candidate.element).replace(/\s+/g, " ").slice(0, 90),
              })),
            };
            return decision;
          };
          if (!last) return decide("no_rows", "the flow table rendered no Live or Manual flow row");
          // Semantic (layout independent): a Draft flow ranked above the last counted flow would be painted inside a
          // contiguous crop without being counted.
          const lastRank = flowRows.indexOf(last);
          if (flowRows.slice(0, lastRank).some((candidate) => !candidate.qualifying)) return decide("non_qualifying_in_view", "a Draft flow is ranked between the counted Live/Manual flows");
          // Every column must be visible: the header row is the semantic proof of the full table width.
          if (headerBox.width > area.right - area.left + 1) return decide("too_narrow", `the flow table (${Math.round(headerBox.width)} px) is wider than the visible area (${Math.round(area.right - area.left)} px)`);
          if (headerBox.left < area.left - 1 || headerBox.right > area.right + 1) return decide("needs_horizontal_scroll", "the flow table is horizontally outside the visible area");
          // Geometry must agree with the ranking: counted rows sit below the header, in order, without overlapping, and no
          // other flow row is painted inside the crop. Anything else is a layout still moving (reflow, zoom, side panel).
          let previousBottom = headerBox.bottom;
          for (const candidate of included) {
            if (candidate.box.top < previousBottom - 2 || candidate.box.bottom > cardRect.bottom + 1) return decide("layout_unstable", `row ${candidates.indexOf(candidate) + 1} is not below the previous counted row`);
            previousBottom = candidate.box.bottom;
          }
          const intruder = flowRows.find((candidate) => !included.includes(candidate) && (candidate.box.top + candidate.box.bottom) / 2 > headerBox.bottom && (candidate.box.top + candidate.box.bottom) / 2 < last.box.bottom);
          if (intruder) return decide("layout_unstable", `uncounted row ${candidates.indexOf(intruder) + 1} is painted inside the crop`);
          decide("ok", "top flows verified");
          return { rect: paintedRect(last.box.bottom), availableRowCount: qualifying.length, includedRowCount: included.length };
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
        const measurementFailure = (value: MeasurementIssue) => {
          if (value === "no_rows") return fail("TOP_FLOWS_NO_DATA", "Top performing flows showed its table header but no usable flow rows for the selected month.");
          if (value === "non_qualifying_in_view") return fail("TOP_FLOWS_NON_QUALIFYING_ROW_IN_VIEW", "A Draft flow is ranked between the top Live/Manual flows, so a contiguous Top Flows crop would show a flow it does not count.");
          if (value === "too_narrow") {
            const header = (selection?.header ?? null) as { w: number } | null; const area = (selection?.visibleArea ?? null) as { left: number; right: number } | null;
            const actualWidth = layoutViewport().width;
            const requiredWidth = Math.max(target.minLayoutWidth ?? 0, Math.ceil(actualWidth + (header && area ? Math.max(0, header.w - (area.right - area.left)) + 16 : 0)));
            selection = { ...(selection ?? {}), actualWidth, requiredWidth };
            return fail("KLAVIYO_VIEWPORT_TOO_NARROW", `Klaviyo lays the page out only ${actualWidth} px wide, so the Top performing flows table does not fit (at least ${requiredWidth} px is required).`);
          }
          if (value === "needs_horizontal_scroll") return fail("TARGET_NOT_VISIBLE", "The Top performing flows table could not be scrolled fully into view horizontally.");
          if (value === "layout_unstable") return fail("TARGET_LAYOUT_NOT_STABLE", "The Top performing flows rows did not settle into a consistent layout.");
          return fail("TOP_FLOW_ROWS_NOT_FOUND", "The Top performing flows table header or visible flow rows were not found.");
        };
        // Klaviyo keeps re-laying out Overview after the one-off scroll above (cards above finish loading and grow; the
        // side panel or a zoom change reflows the page), so the target is re-located and re-measured on every pass and,
        // when it has left the visible area (layout viewport ∩ clipping ancestors), moved back by scrolling its real
        // scroll container — never to a fixed coordinate (run 67311d57). Geometry from before a layout-width change is
        // discarded. A semantic verdict (no rows, Draft in range, table too wide) must repeat on a later pass to count.
        const scrollerOf = (element: Element): HTMLElement => {
          for (let node = element.parentElement; node && node !== document.body; node = node.parentElement) if (/^(?:auto|scroll|overlay)$/.test(getComputedStyle(node).overflowY)) return node;
          return (document.scrollingElement ?? document.documentElement) as HTMLElement;
        };
        const scrollerName = (scroller: Element) => scroller === document.scrollingElement || scroller === document.documentElement ? "document" : `${scroller.tagName.toLowerCase()}${scroller.id ? `#${scroller.id}` : ""}`;
        const placeInVisibleArea = async (card: Element, rect: { top: number; bottom: number; height: number }) => {
          const area = visibleAreaOf(card); const margin = 8; const fits = rect.height <= area.bottom - area.top - 2 * margin;
          const delta = rect.top < area.top + 1 || !fits ? rect.top - (area.top + margin) : rect.bottom > area.bottom - 1 ? rect.bottom - (area.bottom - margin) : 0;
          const scroller = scrollerOf(card); const before = scroller.scrollTop;
          if (Math.abs(delta) >= 1) scroller.scrollTop = before + Math.round(delta);
          positioning.push({ axis: "y", scroller: scrollerName(scroller), scrollTopBefore: Math.round(before), scrollTopAfter: Math.round(scroller.scrollTop), delta: Math.round(delta), fits,
            target: { top: Math.round(rect.top), bottom: Math.round(rect.bottom), height: Math.round(rect.height) }, visibleArea: { top: Math.round(area.top), bottom: Math.round(area.bottom) }, viewport: { width: window.innerWidth, height: window.innerHeight, layoutWidth: layoutViewport().width } });
          if (scroller.scrollTop !== before) { await nextFrame(); await pause(200); }
        };
        // Brings the flow table's header (its full column set) horizontally into the visible area by scrolling the
        // nearest horizontal scroller (an overflowing page on a narrow Windows layout) — never by fixed coordinates.
        const placeHorizontally = async (element: Element) => {
          const area = visibleAreaOf(element); const box = boxOf(element); const margin = 8;
          const delta = box.left < area.left ? box.left - (area.left + margin) : box.right > area.right ? box.right - (area.right - margin) : 0;
          let scroller = (document.scrollingElement ?? document.documentElement) as HTMLElement;
          for (let node = element.parentElement; node && node !== document.body; node = node.parentElement) if (/^(?:auto|scroll|overlay)$/.test(getComputedStyle(node).overflowX) && node.scrollWidth > node.clientWidth + 1) { scroller = node; break; }
          const before = scroller.scrollLeft;
          if (Math.abs(delta) >= 1) scroller.scrollLeft = before + Math.round(delta);
          positioning.push({ axis: "x", scroller: scrollerName(scroller), scrollLeftBefore: Math.round(before), scrollLeftAfter: Math.round(scroller.scrollLeft), delta: Math.round(delta), target: { left: Math.round(box.left), right: Math.round(box.right) }, visibleArea: { left: Math.round(area.left), right: Math.round(area.right) } });
          await nextFrame(); await pause(200);
        };
        const SEMANTIC_ISSUES: readonly MeasurementIssue[] = ["no_header", "no_rows", "non_qualifying_in_view", "too_narrow"];
        let previous: Measurement["rect"] | null = null; let stable = 0; let placements = 0;
        let lastIssue: MeasurementIssue | null = null; let issueRepeats = 0; let measuredLayoutWidth = layoutViewport().width;
        for (let attempt = 0; attempt < 16; attempt += 1) {
          await nextFrame(); resolved = findDashboardCard();
          if (!resolved) return fail(target.missingCode, `The ${target.heading} card was replaced without its required semantic evidence.`);
          const layoutWidth = layoutViewport().width;
          if (layoutWidth !== measuredLayoutWidth) { measuredLayoutWidth = layoutWidth; previous = null; stable = 0; lastIssue = null; issueRepeats = 0; positioning.push({ layoutWidthChangedTo: layoutWidth }); await pause(250); continue; }
          const measurement = measureTarget(resolved);
          if (typeof measurement === "string") {
            previous = null; stable = 0;
            issueRepeats = measurement === lastIssue ? issueRepeats + 1 : 1; lastIssue = measurement;
            if (SEMANTIC_ISSUES.includes(measurement) && issueRepeats >= 2) return measurementFailure(measurement);
            if (measurement === "needs_horizontal_scroll" && placements < 6) { placements += 1; const header = findFlowHeader(resolved.card); if (header) await placeHorizontally(header); continue; }
            await pause(250); continue;
          }
          lastIssue = null; issueRepeats = 0;
          const rect = measurement.rect; const headingRect = resolved.heading.getBoundingClientRect(); const area = visibleAreaOf(resolved.card);
          const fullyVisible = rect.width > 0 && rect.height > 0 && rect.left >= 0 && rect.right <= layoutWidth + 0.5 && rect.top >= area.top - 0.5 && rect.bottom <= area.bottom + 0.5;
          if (!fullyVisible) { previous = rect; stable = 0; if (placements < 6) { placements += 1; await placeInVisibleArea(resolved.card, rect); } else await pause(200); continue; }
          if (previous && rect.x === previous.x && rect.y === previous.y && rect.width === previous.width && rect.height === previous.height) stable += 1; else stable = 0;
          previous = rect;
          if (stable >= 1) {
            if (!hasMeaningfulBounds(rect, headingRect)) return fail("TARGET_BOUNDS_INVALID", `The ${target.heading} target bounds only cover a heading-sized region.`);
            const visibleControls = Array.from(resolved.card.querySelectorAll("button,[role=tab],[role=button],[aria-selected],[aria-pressed],[data-state],[data-active]")).filter((element) => { const style = getComputedStyle(element); const controlRect = element.getBoundingClientRect(); return !element.closest("[hidden],[aria-hidden=true]") && style.display !== "none" && style.visibility !== "hidden" && controlRect.width > 0 && controlRect.height > 0; }).slice(0, 40).map((element) => ({ text: visible(element).slice(0, 180), tag: element.tagName.toLowerCase(), role: element.getAttribute("role"), ariaSelected: element.getAttribute("aria-selected"), ariaPressed: element.getAttribute("aria-pressed"), visible: true }));
            stageTimingsMs.contentReadyMs = Math.max(0, Math.round(performance.now() - contentReadyStartedAt));
            stageTimingsMs.totalMs = Math.max(0, Math.round(performance.now() - operationStartedAt));
            // Report cover values: DOM text of this verified card only (never OCR, never another card or period).
            const performance_ = target.screenshotType === "overview" ? readBusinessPerformance(resolved.card) : null;
            // Success evidence is geometry only: row text stays out of it.
            const recorded = selection as Record<string, unknown> | null;
            const selectionGeometry = recorded ? { ...recorded, candidates: (recorded.candidates as Array<Record<string, unknown>> | undefined)?.map(({ text: _text, ...rest }) => rest) } : null;
            return { ...(performance_ ? { businessPerformance: performance_.evidence, businessPerformanceIssues: performance_.issues, businessPerformanceReadout: performance_.readout } : {}), ok: true, sourceUrl: window.location.href, targetRect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height, viewportWidth: window.innerWidth, viewportHeight: window.innerHeight, layoutViewportWidth: layoutWidth, visibleControls, stageTimingsMs: { ...stageTimingsMs }, layoutEvidence: { ...layoutEvidence(resolved.card, resolved.heading), ...(selectionGeometry ? { selection: selectionGeometry } : {}) }, ...(measurement.availableRowCount === undefined ? {} : { availableRowCount: measurement.availableRowCount, includedRowCount: measurement.includedRowCount }) }, observedPeriod: { startDate: expected.startDate, endDate: expected.endDate } };
          }
        }
        if (lastIssue) return measurementFailure(lastIssue);
        const finalRect = previous;
        if (!finalRect) return fail("TARGET_LAYOUT_NOT_STABLE", `The ${target.heading} target layout did not stabilize.`);
        const finalArea = visibleAreaOf(resolved!.card);
        if (finalRect.width <= 0 || finalRect.height <= 0 || finalRect.left < 0 || finalRect.top < finalArea.top - 0.5 || finalRect.right > layoutViewport().width + 0.5 || finalRect.bottom > finalArea.bottom + 0.5) return fail("TARGET_NOT_VISIBLE", `The ${target.heading} target is not fully visible.`);
        if (!hasMeaningfulBounds(finalRect, resolved!.heading.getBoundingClientRect())) return fail("TARGET_BOUNDS_INVALID", `The ${target.heading} target bounds only cover a heading-sized region.`);
        return fail("TARGET_LAYOUT_NOT_STABLE", `The ${target.heading} target layout did not stabilize.`);
      } catch (error) {
        return fail("KLAVIYO_PAGE_ADAPTER_ERROR", error instanceof Error && error.message ? error.message : "The Klaviyo home dashboard helper failed.");
      }
    })();
    return JSON.parse(JSON.stringify(result)) as DashboardAdapterResult;
  } catch (error) {
    return { ok: false, code: "KLAVIYO_PAGE_ADAPTER_ERROR", message: `The Klaviyo page helper failed: ${error instanceof Error ? error.message : String(error)}`.slice(0, 500), diagnostics: { failureStage: "UNCAUGHT_EXCEPTION", errorName: error instanceof Error ? error.name : typeof error, stack: (error instanceof Error && error.stack ? error.stack : "").split("\n").slice(0, 8).join("\n").slice(0, 2_000), currentUrl: `${location.origin}${location.pathname}` } };
  }
}
