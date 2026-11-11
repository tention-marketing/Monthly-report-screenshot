import { REPORT_CAPTURE_SPEC_V1, type ReportPeriod, type ScreenshotType } from "@tention/report-schema";
import type { PeriodEntryApi } from "./injected/period-entry-contract.js";

export const businessReviewScreenshotTypes = [
  "month_comparison", "campaign_performance", "campaign_metrics", "flow_performance", "flow_metrics",
] as const satisfies readonly ScreenshotType[];
/** `top_campaigns` stays in the legacy adapter type only so historical test
 * fixtures/proof can be read; it is deliberately excluded from active routing. */
export type BusinessReviewScreenshotType = typeof businessReviewScreenshotTypes[number] | "top_campaigns";
export const automaticBusinessReviewScreenshotTypes = [
  "month_comparison", "campaign_performance", "campaign_metrics", "flow_performance", "flow_metrics",
] as const satisfies readonly BusinessReviewScreenshotType[];

export type BusinessReviewFailureCode =
  | "BUSINESS_REVIEW_CARD_NOT_FOUND" | "BUSINESS_REVIEW_TAB_NOT_FOUND" | "BUSINESS_REVIEW_TAB_NOT_SELECTED"
  | "REPORT_PERIOD_NOT_CONFIRMED" | "COMPARISON_PERIOD_NOT_CONFIRMED" | "TARGET_NOT_VISIBLE"
  | "TARGET_LAYOUT_NOT_STABLE" | "KLAVIYO_PAGE_NOT_SUPPORTED" | "PERIOD_NOT_FOUND" | "PERIOD_SET_FAILED"
  | "KLAVIYO_PERIOD_DIALOG_NOT_FOUND" | "KLAVIYO_PERIOD_APPLY_NOT_FOUND" | "KLAVIYO_PERIOD_APPLY_TIMEOUT"
  | "KLAVIYO_PERIOD_VERIFY_FAILED" | "BUSINESS_REVIEW_ROWS_NOT_FOUND" | "BUSINESS_REVIEW_CONTENT_NOT_RENDERED" | "BUSINESS_REVIEW_PAGE_NOT_READY" | "KLAVIYO_PAGE_ADAPTER_ERROR"
  | "BUSINESS_REVIEW_CHART_NOT_RENDERED" | "BUSINESS_REVIEW_TARGET_OCCLUDED" | "BUSINESS_REVIEW_UNEXPECTED_NAVIGATION";

export interface BusinessReviewTargetBounds { x: number; y: number; width: number; height: number; viewportWidth: number; viewportHeight: number; availableRowCount?: number; includedRowCount?: number; visibleControls?: Array<Record<string, string | boolean | null>>; stageTimingsMs?: Record<string, number>; hiddenOverlayCount?: number; lastRowProof?: Record<string, unknown>; cardTitle?: string }
export interface BusinessReviewInjectionPeriod { startDate: string; endDate: string; previousStartDate: string; previousEndDate: string }
export interface BusinessReviewTargetDefinition {
  screenshotType: BusinessReviewScreenshotType;
  sectionKey: string;
  sourceIdentity: string;
  cardAliases: readonly string[];
  tabAliases: readonly string[];
  requiresComparisonProof: boolean;
  requiredCardText?: readonly string[];
  /** Text that proves a different view of the same card is still rendered. */
  forbiddenCardText?: readonly string[];
  rowLimit?: number;
  rowHeaderLabels?: readonly (readonly string[])[];
  /** The live view plots a chart; it is captured only after the chart has real plotted marks. */
  requiresChart?: boolean;
  /** Titles of the Business Review cards; a card never extends into an ancestor holding another card's title. */
  cardTitles?: readonly string[];
  /** The card's table must be visible through its final row, with no floating page UI over it, before capture. */
  lastRowMustBeVisible?: boolean;
}

const BUSINESS_REVIEW_CARD_TITLES = ["Growth overview", "Campaign Performance Summary", "Flow Performance Summary", "Deliverability", "Deliverability Score"] as const;

const definition = (screenshotType: BusinessReviewScreenshotType, cardAliases: readonly string[], tabAliases: readonly string[], requiresComparisonProof = false, rowLimit?: number, rowHeaderLabels?: readonly (readonly string[])[]): BusinessReviewTargetDefinition => ({
  screenshotType, cardTitles: BUSINESS_REVIEW_CARD_TITLES, sectionKey: REPORT_CAPTURE_SPEC_V1.find((spec) => spec.screenshotType === screenshotType)!.key, sourceIdentity: REPORT_CAPTURE_SPEC_V1.find((spec) => spec.screenshotType === screenshotType)!.sourceIdentity, cardAliases, tabAliases, requiresComparisonProof,
  ...(rowLimit === undefined ? {} : { rowLimit }), ...(rowHeaderLabels === undefined ? {} : { rowHeaderLabels }),
});

/** Semantic labels are the only provider-specific evidence C1 uses. No CSS/test-id selectors are assumed. */
export const BUSINESS_REVIEW_TARGETS: Readonly<Record<BusinessReviewScreenshotType, BusinessReviewTargetDefinition>> = {
  top_campaigns: { ...definition("top_campaigns", ["Campaign Performance Summary", "Campaign Performance"], ["Top performing messages"], false, 3, [["Campaign message"], ["Sent date"], ["Type"], ["Total recipients"], ["Unique placed order"], ["Conversion value"]]), sourceIdentity: "business-review|campaign-performance|top-performing" },
  // Message type breakdown: attributed revenue split into Campaigns and Flows. Conversion summary
  // (total / unattributed revenue, recipients) is a different view and is never accepted here.
  month_comparison: { ...definition("month_comparison", ["Growth overview"], ["Message type breakdown"], true), requiredCardText: ["Attributed revenue", "Campaigns", "Flows"], forbiddenCardText: ["Unattributed revenue", "Total recipients"], requiresChart: true },
  // Overview and Metrics share one card. Each view is proven by its own content and by the absence of the
  // other view's content, so a stale panel left over from the previous view is never captured.
  campaign_performance: { ...definition("campaign_performance", ["Campaign Performance Summary", "Campaign Performance"], ["Overview"]), requiredCardText: ["Conversion Value", "Total Recipients"], forbiddenCardText: ["Open Rate", "Click Rate"], requiresChart: true },
  campaign_metrics: { ...definition("campaign_metrics", ["Campaign Performance Summary", "Campaign Performance"], ["Metrics"]), requiredCardText: ["Open Rate", "Click Rate", "Revenue Per Recipient"], lastRowMustBeVisible: true },
  flow_performance: { ...definition("flow_performance", ["Flow Performance Summary", "Flow Performance"], ["Overview"]), requiredCardText: ["Conversion Value", "Total Recipients"], forbiddenCardText: ["Open Rate", "Click Rate"], requiresChart: true },
  flow_metrics: { ...definition("flow_metrics", ["Flow Performance Summary", "Flow Performance"], ["Metrics"]), requiredCardText: ["Open Rate", "Click Rate", "Revenue Per Recipient"], lastRowMustBeVisible: true },
};

export function isBusinessReviewScreenshotType(value: ScreenshotType): value is BusinessReviewScreenshotType {
  return (businessReviewScreenshotTypes as readonly ScreenshotType[]).includes(value);
}
export function isAutomaticBusinessReviewScreenshotType(value: ScreenshotType): value is typeof automaticBusinessReviewScreenshotTypes[number] {
  return (automaticBusinessReviewScreenshotTypes as readonly ScreenshotType[]).includes(value);
}

export type BusinessReviewAdapterResult =
  | { ok: true; sourceUrl: string; targetRect: BusinessReviewTargetBounds; observedPeriod: { startDate: string; endDate: string; comparisonStartDate?: string; comparisonEndDate?: string } }
  | { ok: false; code: BusinessReviewFailureCode; message: string; diagnostics?: Record<string, unknown> };

/**
 * Serialized into the authoritative toolbar-granted tab. All helpers stay local
 * because chrome.scripting serializes this function rather than module closures.
 */
/** `readinessTimeoutMs` bounds each wait for a view to render; live injection uses the default. */
export async function prepareBusinessReviewCaptureDocument(target: BusinessReviewTargetDefinition, expected: BusinessReviewInjectionPeriod, dialogTimeoutMs = 6_000, readinessTimeoutMs = 20_000, stabilityIntervalMs = 500): Promise<BusinessReviewAdapterResult> {
  // Chrome reports an exception that escapes an injected function as a bare `null` result (run 8fdc5fcc), and a
  // DOM object or cycle in the result cannot cross back to the extension. Every exit is therefore plain JSON, and
  // any exception — including one raised while building failure diagnostics — becomes a typed, serializable failure.
  try {
    const result = await (async (): Promise<BusinessReviewAdapterResult> => {
      let failureStage = "PAGE_READY";
      let diagnosticCard: Element | null = null;
      let diagnosticClickAttempted = false;
      let diagnosticActiveStateObserved = false;
      let diagnosticRenderedViewVerified = false;
      const stageTimingsMs: Record<string, number> = {};
      let activeStageStartedAt = performance.now();
      // What the Time period step saw and did; every failure from that stage on carries it.
      let periodDiagnostics: Record<string, unknown> | null = null;
      // Every re-positioning step (scroller, scroll delta, card and visible-area geometry) for failure diagnostics.
      const positioning: Record<string, unknown>[] = [];
      const enterStage = (stage: string) => {
        stageTimingsMs[failureStage] = Math.max(0, Math.round(performance.now() - activeStageStartedAt));
        failureStage = stage; activeStageStartedAt = performance.now();
      };
      const diagnosticSnapshot = (code: string, message: string) => {
        const redact = (value: string) => value.replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, "[redacted-email]").replace(/\b(?:bearer\s+)?[A-Za-z0-9_-]{32,}\b/gi, "[redacted-token]").replace(/\+?\d[\d ()-]{7,}\d/g, "[redacted-phone]");
        const safeUrl = `${location.origin}${location.pathname}`;
        const isVisible = (element: Element) => { const style = getComputedStyle(element); const rect = element.getBoundingClientRect(); return !element.closest("[hidden],[aria-hidden=true]") && style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0; };
        const visibleText = (element: Element) => redact(((element as HTMLElement).innerText || element.textContent || "").replace(/\s+/g, " ").trim());
        const heading = Array.from(document.querySelectorAll("h1,h2,h3,h4,h5,h6,[role=heading]")).find((element) => target.cardAliases.some((alias) => visibleText(element).toLocaleLowerCase() === alias.toLocaleLowerCase()));
        let card: Element | null = diagnosticCard?.isConnected ? diagnosticCard : heading?.parentElement ?? null;
        if (!diagnosticCard?.isConnected) {
          while (card && card !== document.body && card !== document.documentElement && card.tagName !== "MAIN") {
            if (target.tabAliases.some((alias) => visibleText(card!).toLocaleLowerCase().includes(alias.toLocaleLowerCase()))) break;
            card = card.parentElement;
          }
        }
        const sanitizeHtml = (source: Element | null) => {
          if (!source) return null;
          const clone = source.cloneNode(true) as Element;
          clone.querySelectorAll("script,style,iframe,svg,input,textarea,select,[contenteditable=true]").forEach((element) => element.remove());
          const nodes = [clone, ...Array.from(clone.querySelectorAll("*"))];
          for (const element of nodes) {
            for (const attribute of Array.from(element.attributes)) if (!["role", "aria-label", "aria-selected", "aria-pressed", "aria-current", "aria-busy", "data-state", "data-active"].includes(attribute.name)) element.removeAttribute(attribute.name); else attribute.value = redact(attribute.value);
            for (const child of Array.from(element.childNodes)) if (child.nodeType === Node.TEXT_NODE && child.textContent) child.textContent = redact(child.textContent);
          }
          return clone.outerHTML.slice(0, 40_000);
        };
        const controls = Array.from(document.querySelectorAll("button,[role=tab],[role=button],[aria-selected],[aria-pressed],[data-state],[data-active]")).filter(isVisible).slice(0, 80).map((element) => ({ text: visibleText(element).slice(0, 180), tag: element.tagName.toLowerCase(), role: element.getAttribute("role"), ariaSelected: element.getAttribute("aria-selected"), ariaPressed: element.getAttribute("aria-pressed"), visible: true }));
        const periodControl = Array.from(document.querySelectorAll("button,[role=button],[role=combobox]")).find((element) => /time period|date range|reporting period/i.test(visibleText(element)));
        const periodRegion = (element: Element | null) => {
          if (!element) return null;
          let current: Element | null = element;
          let fallback = "";
          for (let depth = 0; current && depth < 8 && current !== document.body && current !== document.documentElement && current.tagName !== "MAIN"; depth += 1, current = current.parentElement) {
            const text = ((current as HTMLElement).innerText || current.textContent || "").replace(/\s+/g, " ").trim();
            fallback = text;
            const matches = text.match(/\b(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\.?\s+\d{1,2},?\s+\d{4}\b/gi) ?? [];
            if (matches.length >= (target.requiresComparisonProof ? 4 : 2)) return text;
          }
          return fallback;
        };
        const table = card?.querySelector("table,[role=table],[role=grid]") ?? null;
        const rows = table ? table.querySelectorAll("tbody tr,[role=rowgroup] [role=row]").length : null;
        const rankingGeometry = table ? {
          viewport: { width: window.innerWidth, height: window.innerHeight, devicePixelRatio: window.devicePixelRatio },
          headers: Array.from(table.querySelectorAll("thead th,[role=columnheader]")).map((element) => visibleText(element)).filter(Boolean).slice(0, 20),
          rows: Array.from(table.querySelectorAll("tbody tr,[role=rowgroup] [role=row]")).slice(0, 10).map((row) => {
            const rect = row.getBoundingClientRect();
            const cells = Array.from(row.querySelectorAll("td,[role=cell],[role=gridcell]")).slice(0, 10).map((cell) => {
              const cellRect = cell.getBoundingClientRect();
              return { x: cellRect.x, y: cellRect.y, width: cellRect.width, height: cellRect.height, bottom: cellRect.bottom };
            });
            return { text: visibleText(row).slice(0, 220), x: rect.x, y: rect.y, width: rect.width, height: rect.height, bottom: rect.bottom, cells };
          }),
        } : null;
        const tableHeaders = table ? Array.from(table.querySelectorAll("thead th,[role=columnheader]")).map((element) => visibleText(element)).filter(Boolean).slice(0, 40) : [];
        const headings = Array.from(document.querySelectorAll("h1,h2,h3,h4,h5,h6,[role=heading]")).filter(isVisible).map((element) => visibleText(element)).filter(Boolean).slice(0, 60);
        const dateDialog = Array.from(document.querySelectorAll("dialog,[role=dialog]")).find(isVisible);
        const bodyClone = document.body.cloneNode(true) as HTMLElement;
        bodyClone.querySelectorAll("script,style,iframe,svg,input,textarea,select,[contenteditable=true]").forEach((element) => element.remove());
        for (const element of Array.from(bodyClone.querySelectorAll("*"))) for (const attribute of Array.from(element.attributes)) attribute.value = redact(attribute.value);
        for (const node of Array.from(bodyClone.querySelectorAll("*")).flatMap((element) => Array.from(element.childNodes)).filter((item) => item.nodeType === Node.TEXT_NODE && item.textContent)) node.textContent = redact(node.textContent!);
        // `target` is structured-cloned into the Klaviyo page. Keep the injected
        // function self-contained: module imports are not available to its
        // serialized diagnostic closure when handling an early page failure.
        const expectedSourceIdentity = target.sourceIdentity;
        const loadingIndicators = Array.from(document.querySelectorAll("[aria-busy=true],[role=progressbar],[data-loading=true],[data-asc=Spinner]")).filter(isVisible).slice(0, 20).map((element) => ({ tag: element.tagName.toLowerCase(), role: element.getAttribute("role"), label: redact(element.getAttribute("aria-label") ?? ""), text: visibleText(element).slice(0, 120) }));
        const localControls = Array.from(card?.querySelectorAll("*") ?? []).filter((element) => isVisible(element) && (target.tabAliases.some((alias) => visibleText(element).toLocaleLowerCase() === alias.toLocaleLowerCase()) || element.matches("button,[role=tab],[role=button],[aria-selected],[aria-pressed],[data-state],[data-active]"))).slice(0, 60).map((element) => ({ text: visibleText(element).slice(0, 180), tag: element.tagName.toLowerCase(), role: element.getAttribute("role"), ariaSelected: element.getAttribute("aria-selected"), ariaPressed: element.getAttribute("aria-pressed"), visible: true }));
        return { code, message: redact(message), failureStage, ...(periodDiagnostics ? { periodSetting: periodDiagnostics } : {}), ...(positioning.length ? { positioning: positioning.slice(-6) } : {}), stageTimingsMs: { ...stageTimingsMs, [failureStage]: Math.max(0, Math.round(performance.now() - activeStageStartedAt)) }, currentUrl: safeUrl, expectedUrl: safeUrl, expectedSourceIdentity, expectedPeriod: expected, observedHeading: headings.find((headingText) => target.cardAliases.some((alias) => headingText.toLocaleLowerCase() === alias.toLocaleLowerCase())) ?? null, observedPeriod: periodControl ? periodRegion(periodControl) : null, dateControlState: periodControl ? { text: visibleText(periodControl), regionText: periodRegion(periodControl), tag: periodControl.tagName.toLowerCase(), role: periodControl.getAttribute("role"), ariaLabel: redact(periodControl.getAttribute("aria-label") ?? ""), dateInputs: Array.from(dateDialog?.querySelectorAll("input") ?? []).map((input) => ({ label: redact(input.getAttribute("aria-label") ?? input.getAttribute("name") ?? ""), value: redact((input as HTMLInputElement).value) })) } : null, dateDialogState: dateDialog ? visibleText(dateDialog).slice(0, 1000) : null, headings, tableHeaders, expectedSemanticCard: target.cardAliases[0], expectedView: target.tabAliases[0] ?? null, visibleControls: controls, cardLocalControls: localControls, targetControlFound: localControls.some((control) => target.tabAliases.some((alias) => control.text.toLocaleLowerCase() === alias.toLocaleLowerCase())), clickAttempted: diagnosticClickAttempted, activeStateObserved: diagnosticActiveStateObserved, renderedViewVerified: diagnosticRenderedViewVerified, loading: loadingIndicators.length > 0, loadingIndicators, usableRowCount: rows, rankingGeometry, pageHtml: bodyClone.outerHTML.slice(0, 40_000), cardHtml: sanitizeHtml(card), viewRegionHtml: sanitizeHtml(table?.parentElement ?? null) };
      };
      const fail = (code: BusinessReviewFailureCode, message: string): BusinessReviewAdapterResult => ({ ok: false, code, message, diagnostics: (() => { try { return diagnosticSnapshot(code, message); } catch (error) { return { snapshotError: error instanceof Error ? error.message : String(error) }; } })() });
      try {
        const normalize = (value: string | null | undefined) => (value ?? "").replace(/\s+/g, " ").trim().toLocaleLowerCase();
        const visible = (element: Element) => (element as HTMLElement).innerText?.trim() || element.textContent?.trim() || "";
        const name = (element: Element) => [element.getAttribute("aria-label"), element.getAttribute("aria-labelledby")?.split(/\s+/).map((id) => document.getElementById(id)?.textContent ?? "").join(" "), visible(element)].filter(Boolean).join(" ");
        const matches = (value: string, aliases: readonly string[]) => aliases.some((alias) => normalize(value) === normalize(alias));
        const months: Record<string, string> = { jan: "01", january: "01", feb: "02", february: "02", mar: "03", march: "03", apr: "04", april: "04", may: "05", jun: "06", june: "06", jul: "07", july: "07", aug: "08", august: "08", sep: "09", september: "09", oct: "10", october: "10", nov: "11", november: "11", dec: "12", december: "12" };
        const ranges = (value: string) => [...value.matchAll(/\b(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\.?\s+(\d{1,2}),?\s+(\d{4})\b/gi)].map((match) => {
          const month = months[match[1]!.replace(/\.$/, "").toLowerCase()]; const day = Number(match[2]); const year = match[3];
          return month && day >= 1 && day <= 31 ? `${year}-${month}-${String(day).padStart(2, "0")}` : null;
        }).filter((value): value is string => Boolean(value));
        const periodFrom = (value: string) => { const dates = ranges(value); return dates.length >= 2 ? { startDate: dates[0]!, endDate: dates[1]! } : null; };
        // The selected range is only what precedes "compared to"; the comparison half never proves the report month.
        // Without the shared period helper nothing is proven, and the period step fails closed.
        const sharedPeriod = () => (globalThis as unknown as { __tentionPeriodEntry?: PeriodEntryApi }).__tentionPeriodEntry;
        const splitPeriod = (value: string) => { const helper = sharedPeriod(); if (!helper?.currentPeriodText) return null; const current = helper.currentPeriodText(value); return { current, comparison: value.slice(current.length) }; };
        const hasExpectedPeriod = (value: string) => { const parts = splitPeriod(value); const period = parts ? periodFrom(parts.current) : null; return period?.startDate === expected.startDate && period.endDate === expected.endDate; };
        // Both ranges come from the report's own month: the current calendar month, compared to the immediately
        // previous calendar month. A comparison left over from another report (e.g. Jul 1–31 under Sep 1–30) fails.
        const hasBothPeriods = (value: string) => {
          const parts = splitPeriod(value); if (!parts || !hasExpectedPeriod(value)) return false;
          const comparison = ranges(parts.comparison);
          return comparison[0] === expected.previousStartDate && comparison[1] === expected.previousEndDate;
        };
        const interactives = () => Array.from(document.querySelectorAll("button, input, select, [role=button], [role=combobox], [role=option], [role=menuitem]"));
        const periodControl = () => interactives().find((element) => /time period|date range|reporting period/i.test(name(element))) ?? null;
        // The live selected range is not guaranteed to be inside the button. Read
        // the immediate semantic control/header region and deliberately stop before
        // broad document-level text, which could contain unrelated dashboard dates.
        // Klaviyo keeps closed pickers (with stale date fields) in the DOM. Period text must be what is painted:
        // never hidden nodes, never text inside a dialog, popover, or listbox.
        const renderedCache = new Map<Element, boolean>();
        const rendered = (element: Element | null): boolean => {
          if (!element) return true;
          const cached = renderedCache.get(element); if (cached !== undefined) return cached;
          const style = getComputedStyle(element);
          const value = !element.hasAttribute("hidden") && element.getAttribute("aria-hidden") !== "true" && style.display !== "none" && style.visibility !== "hidden" && !(element.tagName === "DIALOG" && !element.hasAttribute("open")) && rendered(element.parentElement);
          renderedCache.set(element, value); return value;
        };
        const POPOVER = "dialog,[role=dialog],[role=listbox],[role=menu],[data-popper-placement]";
        const separatedText = (element: Element) => {
          renderedCache.clear();
          const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
          const parts: string[] = []; let node: Node | null;
          while ((node = walker.nextNode())) { const parent = node.parentElement; if (node.textContent?.trim() && parent && rendered(parent) && !parent.closest(POPOVER)) parts.push(node.textContent.trim()); }
          return parts.join(" ");
        };
        const periodRegionText = (control: Element) => {
          let ancestor: Element | null = control;
          let fallback = name(control);
          for (let depth = 0; ancestor && depth < 8 && ancestor !== document.body && ancestor !== document.documentElement && ancestor.tagName !== "MAIN"; depth += 1, ancestor = ancestor.parentElement) {
            // Read each candidate region once. Concatenating nested ancestors
            // duplicates their date text and can scramble the current/previous
            // sequence (the live date label is a sibling of its button).
            const candidate = separatedText(ancestor);
            fallback = candidate || fallback;
            // Klaviyo renders the selected date ranges as a sibling of the Time
            // period button, sometimes several wrappers away. Read the smallest
            // containing region that proves the exact current range (and exact
            // previous range for comparison), never the page-wide body text.
            const observedDates = ranges(candidate);
            const hasCurrent = observedDates.some((date, index) => date === expected.startDate && observedDates[index + 1] === expected.endDate);
            const hasComparison = observedDates.some((date, index) => date === expected.startDate && observedDates[index + 1] === expected.endDate && observedDates[index + 2] === expected.previousStartDate && observedDates[index + 3] === expected.previousEndDate);
            if (hasCurrent && (!target.requiresComparisonProof || hasComparison)) return candidate;
          }
          return fallback;
        };
        const expectedPeriodFromLiveRegion = () => {
          const control = periodControl(); return control && hasExpectedPeriod(periodRegionText(control));
        };
        // Chrome runs no animation frames in a hidden or background tab; a frame wait must never hang there.
        const nextFrame = () => new Promise<void>((resolve) => { const fallback = window.setTimeout(resolve, 100); requestAnimationFrame(() => { window.clearTimeout(fallback); resolve(); }); });
        const waitFor = async (predicate: () => boolean, timeoutMs = 1_800): Promise<boolean> => {
          const deadline = Date.now() + timeoutMs;
          do {
            if (predicate()) return true;
            await Promise.race([nextFrame(), new Promise<void>((resolve) => window.setTimeout(resolve, 60))]);
          } while (Date.now() < deadline);
          return predicate();
        };
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
        const originMatches = /^https:\/\/(?:[a-z0-9-]+\.)*klaviyo\.com$/i.test(window.location.origin) && /^\/analytics\/dashboards(?:\/|$)/.test(window.location.pathname);
        // The section is captured only on the dashboard it started on; any client-side route change aborts it.
        const startPath = location.pathname;
        const navigatedAway = () => location.pathname !== startPath;
        let lastRowProof: Record<string, unknown> | null = null;
        const unexpectedNavigation = () => fail("BUSINESS_REVIEW_UNEXPECTED_NAVIGATION", `The ${target.sectionKey} view switch left the saved Business Review dashboard (now ${location.pathname}); nothing was captured.`);
        const elementVisible = (element: Element) => { const style = getComputedStyle(element); const rect = element.getBoundingClientRect(); return !element.closest("[hidden],[aria-hidden=true]") && style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0; };
        const businessReviewVisible = () => Array.from(document.querySelectorAll("h1, h2, h3, h4, h5, h6, [role=heading], [aria-label*=breadcrumb i], nav, [role=navigation]")).some((element) => /\bbusiness review\b/i.test(visible(element)) && elementVisible(element));
        const targetHeadingVisible = () => Array.from(document.querySelectorAll("h1,h2,h3,h4,h5,h6,[role=heading]")).some((element) => target.cardAliases.some((alias) => normalize(visible(element)) === normalize(alias)) && elementVisible(element));
        const targetCardIsLoading = () => {
          const heading = Array.from(document.querySelectorAll("h1,h2,h3,h4,h5,h6,[role=heading]")).find((element) => target.cardAliases.some((alias) => normalize(visible(element)) === normalize(alias)) && elementVisible(element));
          let region: Element | null = heading ?? null;
          for (let depth = 0; region && depth < 7 && region.tagName !== "MAIN"; depth += 1, region = region.parentElement) {
            if (Array.from(region.querySelectorAll("[aria-busy=true],[role=progressbar],[data-loading=true],[data-asc=Spinner]")).some(elementVisible)) return true;
          }
          return false;
        };
        const anyReportLoading = () => Array.from(document.querySelectorAll("[aria-busy=true],[role=progressbar],[data-loading=true],[data-asc=Spinner]")).some(elementVisible);
        const pageReady = () => { const control = periodControl(); return originMatches && (businessReviewVisible() || targetHeadingVisible()) && Boolean(control && elementVisible(control)) && targetHeadingVisible() && !targetCardIsLoading(); };
        if (!originMatches) return fail("KLAVIYO_PAGE_NOT_SUPPORTED", "This is not a Klaviyo Business Review dashboard.");
        enterStage("PAGE_READY");
        // A freshly loaded dashboard renders its cards asynchronously; poll for the card rather than failing at once.
        if (!targetHeadingVisible() && !await waitFor(targetHeadingVisible, readinessTimeoutMs)) return fail("BUSINESS_REVIEW_CARD_NOT_FOUND", `The ${target.sectionKey} card did not render within the readiness window${anyReportLoading() ? " (Klaviyo was still loading)" : ""}.`);
        const pageReadyDeadline = Date.now() + 7_000;
        let stablePageChecks = 0;
        while (Date.now() < pageReadyDeadline && stablePageChecks < 2) {
          stablePageChecks = pageReady() ? stablePageChecks + 1 : 0;
          if (stablePageChecks < 2) await Promise.race([nextFrame(), new Promise<void>((resolve) => window.setTimeout(resolve, 100))]);
        }
        if (stablePageChecks < 2) return fail("BUSINESS_REVIEW_PAGE_NOT_READY", "The Business Review app shell, date control, and requested semantic card did not become stable and ready.");
        enterStage("PERIOD");
        let control = periodControl();
        if (!control) return fail("PERIOD_NOT_FOUND", "Klaviyo's Time period control was not found.");
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
        // When Klaviyo already shows the report month and only the comparison is wrong, any failure to correct it is
        // reported as the comparison failure it is (the underlying step stays in the diagnostics).
        const comparisonOnly = hasExpectedPeriod(periodRegionText(control)) && !hasBothPeriods(periodRegionText(control));
        const failClosed = async (code: BusinessReviewFailureCode, message: string) => {
          if (periodDiagnostics) { periodDiagnostics.pickerDismissed = await dismissPicker(); periodDiagnostics.underlyingCode = code; }
          return comparisonOnly ? fail("COMPARISON_PERIOD_NOT_CONFIRMED", `Klaviyo showed the report month but not the immediately previous calendar month as its comparison (${message})`) : fail(code, message);
        };
        const regionText = () => { const current = periodControl(); return current ? periodRegionText(current).slice(0, 300) : null; };
        if (!hasBothPeriods(periodRegionText(control))) {
          const paintedAll = (element: Element) => { renderedCache.clear(); const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT); const parts: string[] = []; let node: Node | null; while ((node = walker.nextNode())) { const parent = node.parentElement; if (node.textContent?.trim() && parent && rendered(parent)) parts.push(node.textContent.trim()); } return parts.join(" "); };
          const describe = (input: HTMLInputElement) => ({ type: input.type, role: input.getAttribute("role"), label: name(input).slice(0, 80), placeholder: input.placeholder.slice(0, 40), value: input.value.slice(0, 40), shown: shown(input), disabled: input.disabled || input.readOnly });
          const pickers = (open: Element) => Array.from(open.querySelectorAll("select,[role=combobox],button[aria-haspopup],[aria-haspopup=listbox],button")).filter((element) => shown(element) && !/^(?:apply|cancel)$/i.test(normalize(visible(element))));
          const structure = (open: Element) => ({ inputs: Array.from(open.querySelectorAll("input")).map(describe).slice(0, 8), pickers: pickers(open).map((element) => visible(element).slice(0, 40)).slice(0, 6), buttons: Array.from(open.querySelectorAll("button,[role=button],[role=option],[role=radio],[role=menuitem]")).filter(shown).map((element) => visible(element).slice(0, 40)).filter(Boolean).slice(0, 20), text: paintedAll(open).slice(0, 300) });
          periodDiagnostics = { regionBefore: regionText(), expectedPeriod: { ...expected }, sourcePage: location.pathname, dialogFound: false };
          periodDiagnostics.renderedPeriodBefore = periodDiagnostics.regionBefore;
          if (openDialogs().length) await dismissPicker();
          (control as HTMLElement).click(); await nextFrame();
          const open = await poll(dialog, dialogTimeoutMs);
          if (!open) return failClosed("KLAVIYO_PERIOD_DIALOG_NOT_FOUND", "Klaviyo's Time period dialog was not found.");
          Object.assign(periodDiagnostics, { dialogFound: true, dialogBefore: structure(open) });
          // Only fields painted in the picker count; Time period's own range precedes the comparison period's.
          const fieldText = (input: HTMLInputElement) => [name(input), input.placeholder, input.getAttribute("aria-label"), input.name].filter(Boolean).join(" ");
          // Only the Time period's own fields: never the Comparison period's (they follow the "Comparison period" label).
          const pickInputs = () => sharedPeriod()?.timePeriodSection(open).fields() ?? null;
          // Switches a picker (native select or Klaviyo's own button + option list) to Custom, and reports success only
          // when `taken()` proves it (the picker's own Custom date fields appear). The option is looked for only among
          // elements that appeared after this picker was opened and must be labelled exactly "Custom": the page also
          // shows "Custom reports" (Analytics sidebar) and the Time period picker's own "Custom" label (runs bec0e780,
          // 95661f3d clicked a decoy and Comparison period stayed on "Previous year").
          const isCustomLabel = (text: string) => /^custom(?: (?:date )?range)?$/i.test(normalize(text));
          const OPTION_LIKE = "[role=option],[role=menuitem],[role=menuitemradio],[role=radio],li,button,[role=button],[tabindex],div,span";
          const press = (element: HTMLElement) => {
            const rect = element.getBoundingClientRect();
            const init = { bubbles: true, cancelable: true, composed: true, button: 0, clientX: rect.x + rect.width / 2, clientY: rect.y + rect.height / 2 };
            if (typeof PointerEvent === "function") element.dispatchEvent(new PointerEvent("pointerdown", { ...init, pointerId: 1, pointerType: "mouse", isPrimary: true }));
            element.dispatchEvent(new MouseEvent("mousedown", init));
            if (typeof PointerEvent === "function") element.dispatchEvent(new PointerEvent("pointerup", { ...init, pointerId: 1, pointerType: "mouse", isPrimary: true }));
            element.dispatchEvent(new MouseEvent("mouseup", init));
            element.click();
          };
          const chooseCustom = async (select: Element | undefined, taken: () => boolean, record: Record<string, unknown>): Promise<boolean> => {
            if (!select) return false;
            if (taken()) return true;
            if (select instanceof HTMLSelectElement) {
              const option = Array.from(select.options).find((item) => isCustomLabel(item.text));
              record.options = Array.from(select.options).map((item) => item.text.trim()).slice(0, 10);
              if (!option) return false;
              Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")?.set?.call(select, option.value); select.dispatchEvent(new Event("change", { bubbles: true }));
              return Boolean(await poll(taken, 3_000));
            }
            const own = pickers(open);
            const attempts: Record<string, unknown>[] = []; record.attempts = attempts;
            for (const strategy of ["click", "press"] as const) {
              const attempt: Record<string, unknown> = { strategy }; attempts.push(attempt);
              // Box size is a cheap stand-in for "painted" here; full visibility is checked only on the few new elements.
              const boxed = (element: Element) => { const rect = element.getBoundingClientRect(); return rect.width > 0 && rect.height > 0; };
              const before = new Set(Array.from(document.querySelectorAll(OPTION_LIKE)).filter(boxed));
              const activate = (element: HTMLElement) => strategy === "click" ? element.click() : press(element);
              activate(select as HTMLElement);
              const appeared = await poll(() => {
                const fresh = Array.from(document.querySelectorAll(OPTION_LIKE)).filter((element) => !before.has(element) && boxed(element) && !own.some((picker) => picker === element || picker.contains(element))).filter(shown);
                return fresh.length ? fresh : null;
              }, 3_000) ?? [];
              // Innermost labelled elements only: a menu container's combined text is never an option.
              const texted = appeared.filter((element) => normalize(visible(element)).length > 0 && normalize(visible(element)).length <= 40);
              const labelled = texted.filter((element) => !texted.some((other) => other !== element && element.contains(other)));
              attempt.options = Array.from(new Set(labelled.map((element) => visible(element).replace(/\s+/g, " ").trim()))).slice(0, 10);
              const exact = labelled.filter((element) => isCustomLabel(visible(element)));
              const custom = (exact.find((element) => element.matches("[role=option],[role=menuitem],[role=menuitemradio],[role=radio]")) ?? exact[0]) as HTMLElement | undefined;
              const target = (custom?.closest("[role=option],[role=menuitem],[role=menuitemradio],[role=radio],li,button,[role=button]") ?? custom) as HTMLElement | undefined;
              attempt.clicked = target ? { tag: target.tagName.toLowerCase(), role: target.getAttribute("role"), text: normalize(visible(target)).slice(0, 40) } : null;
              if (!target) { (select as HTMLElement).dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); await nextFrame(); continue; }
              activate(target);
              if (await poll(taken, 2_000)) { attempt.taken = true; return true; }
              attempt.taken = false;
            }
            return false;
          };
          // A preset ("Last 30 days", …) is never kept: the Time period picker itself is switched to Custom whenever it is
          // not Custom, even when the Comparison period's own date fields are visible (run c80dcbab).
          const timeSection = () => sharedPeriod()?.timePeriodSection(open) ?? null;
          const sectionBefore = timeSection();
          if (!sectionBefore) return failClosed("PERIOD_SET_FAILED", "The shared period helper was not loaded, so the report month could not be set. Nothing was captured.");
          periodDiagnostics.pickerMode = sectionBefore.pickerText.slice(0, 40);
          if (!sectionBefore.isCustom || !pickInputs()) {
            const select = sectionBefore.picker ?? undefined;
            periodDiagnostics.timePeriodSelect = select ? visible(select).slice(0, 40) : null;
            const choice: Record<string, unknown> = {}; periodDiagnostics.timePeriodChoice = choice;
            periodDiagnostics.customChosen = await chooseCustom(select, () => Boolean(timeSection()?.isCustom && pickInputs()), choice);
          }
          const fields = await poll(pickInputs, 3_000);
          if (!fields) { periodDiagnostics.dialogAfterCustom = structure(open); return failClosed("PERIOD_SET_FAILED", "The requested report period could not be selected safely."); }
          // Type in the field's own displayed format ("Aug 01, 2026", "Aug 1, 2026", "08/01/2026", or ISO for date inputs).
          const formatFor = (input: HTMLInputElement, iso: string) => {
            const [year, month, day] = iso.split("-") as [string, string, string];
            if (input.type === "date") return iso;
            const shownValues = [input.value, ...Array.from(open.querySelectorAll("input")).map((field) => field.value)].filter((value) => /\d{4}/.test(value));
            if (/\d{1,2}\/\d{1,2}\/\d{4}|mm\/dd/i.test(`${shownValues.join(" ")} ${input.placeholder}`)) return `${month}/${day}/${year}`;
            const short = format(iso);
            // "Aug 1, 2026" anywhere means unpadded days; otherwise "Mmm dd, yyyy" values mean Klaviyo pads them ("Aug 01, 2026").
            const padded = !shownValues.some((value) => /\b[a-z]{3}\.? \d, \d{4}/i.test(value)) && shownValues.some((value) => /\b[a-z]{3}\.? \d{2}, \d{4}/i.test(value));
            return padded ? short.replace(/ (\d),/, " 0$1,") : short;
          };
          // The shared period helper replaces whatever range Klaviyo kept (another report, client or session) and
          // proves the fields hold the report's exact dates. Apply is never clicked on any other values.
          const periodEntry = (globalThis as unknown as { __tentionPeriodEntry?: PeriodEntryApi }).__tentionPeriodEntry;
          if (!periodEntry) return failClosed("PERIOD_SET_FAILED", "The shared period helper was not loaded, so the report month could not be set. Nothing was captured.");
          const entry = await periodEntry.enterDateRange({ fields: pickInputs, startDate: expected.startDate, endDate: expected.endDate, format: formatFor,
            reselectCustom: () => chooseCustom(sharedPeriod()?.timePeriodSection(open).picker ?? undefined, () => Boolean(pickInputs()), {}) });
          periodDiagnostics.entry = entry; periodDiagnostics.pickerValuesEntered = entry.pickerValuesEntered;
          periodDiagnostics.valuesAfterSet = entry.observed;
          if (!entry.ok) return failClosed("PERIOD_SET_FAILED", `Klaviyo's date fields did not accept ${expected.startDate} – ${expected.endDate}; Apply was not clicked and nothing was captured.`);
          // Comparison period: never left on Klaviyo's "Previous period" (the preceding same-length span, or a stale
          // range from another report). It is switched to Custom and set to the report's own previous calendar month.
          const isComparisonLabel = (element: Element) => /^comparison period$/i.test(normalize(visible(element)));
          const comparisonLabel = Array.from(open.querySelectorAll("*")).find((element) => shown(element) && isComparisonLabel(element) && !Array.from(element.children).some(isComparisonLabel));
          const follows = (element: Element) => Boolean(comparisonLabel && (comparisonLabel.compareDocumentPosition(element) & Node.DOCUMENT_POSITION_FOLLOWING));
          const comparisonPicker = () => pickers(open).find((picker) => follows(picker) && normalize(visible(picker)).length > 0);
          periodDiagnostics.comparisonPickerBefore = comparisonPicker() ? visible(comparisonPicker()!).slice(0, 40) : null;
          if (!comparisonLabel || !comparisonPicker()) return failClosed("COMPARISON_PERIOD_NOT_CONFIRMED", "Klaviyo's Comparison period control was not found, so the previous calendar month could not be set.");
          const pickComparisonInputs = () => {
            const inputs = Array.from(open.querySelectorAll("input")).filter((input) => shown(input) && follows(input) && !input.disabled && !input.readOnly && !["hidden", "checkbox", "radio", "search", "file"].includes(input.type) && input.getAttribute("role") !== "combobox");
            const start = inputs.find((input) => /start|from/i.test(fieldText(input))) ?? null;
            const end = start ? inputs.slice(inputs.indexOf(start) + 1).find((input) => /end|\bto\b/i.test(fieldText(input))) ?? null : null;
            return start && end ? { start, end } : null;
          };
          const comparisonChoice: Record<string, unknown> = {}; periodDiagnostics.comparisonChoice = comparisonChoice;
          periodDiagnostics.comparisonCustomChosen = await chooseCustom(comparisonPicker(), () => Boolean(pickComparisonInputs()), comparisonChoice);
          const comparisonFields = await poll(pickComparisonInputs, 3_000);
          periodDiagnostics.comparisonPickerAfter = comparisonPicker() ? visible(comparisonPicker()!).slice(0, 40) : null;
          if (!comparisonFields) { periodDiagnostics.dialogAfterComparison = structure(open); return failClosed("COMPARISON_PERIOD_NOT_CONFIRMED", "Klaviyo's custom Comparison period fields did not appear."); }
          // The previous calendar month comes only from the report's stored period, never from browser date math.
          const comparisonEntry = await periodEntry.enterDateRange({ fields: pickComparisonInputs, startDate: expected.previousStartDate, endDate: expected.previousEndDate, format: formatFor,
            reselectCustom: () => chooseCustom(comparisonPicker(), () => Boolean(pickComparisonInputs()), {}) });
          periodDiagnostics.comparisonEntry = comparisonEntry; periodDiagnostics.comparisonValuesEntered = comparisonEntry.pickerValuesEntered;
          periodDiagnostics.comparisonValuesAfterSet = comparisonEntry.observed;
          if (!comparisonEntry.ok) return failClosed("COMPARISON_PERIOD_NOT_CONFIRMED", `Klaviyo's comparison fields did not accept ${expected.previousStartDate} – ${expected.previousEndDate}; Apply was not clicked and nothing was captured.`);
          // Entering the comparison must not have disturbed the report month already entered.
          const recheck = pickInputs();
          if (!recheck || periodEntry.parseDisplayedDate(recheck.start.value) !== expected.startDate || periodEntry.parseDisplayedDate(recheck.end.value) !== expected.endDate) return failClosed("PERIOD_SET_FAILED", "The report month changed while the comparison period was entered; Apply was not clicked.");
          const apply = await poll(() => Array.from(open.querySelectorAll("button, [role=button]")).find((element) => shown(element) && normalize(visible(element)) === "apply" && !(element as HTMLButtonElement).disabled && element.getAttribute("aria-disabled") !== "true"), 3_000);
          periodDiagnostics.dialogAtApply = structure(open);
          periodDiagnostics.applyFound = Boolean(apply);
          if (!apply) return failClosed("KLAVIYO_PERIOD_APPLY_NOT_FOUND", "Klaviyo's Apply button was not found.");
          (apply as HTMLElement).click(); periodDiagnostics.applyClicked = true;
          const closed = await waitForClose(open);
          periodDiagnostics.dialogClosed = closed;
          if (!closed) return failClosed("KLAVIYO_PERIOD_APPLY_TIMEOUT", "Klaviyo's Apply button did not finish.");
          // Klaviyo refetches after Apply and may update the two ranges separately; the live control is re-queried on
          // every poll and only its re-rendered region showing BOTH exact ranges proves the period.
          const confirmed = await poll(() => { const live = periodControl(); return Boolean(live && hasBothPeriods(periodRegionText(live))); }, Math.max(readinessTimeoutMs, 15_000));
          periodDiagnostics.regionAfter = regionText(); periodDiagnostics.renderedPeriodAfter = periodDiagnostics.regionAfter;
          if (!confirmed) {
            const live = periodControl();
            if (live && hasExpectedPeriod(periodRegionText(live))) return failClosed("COMPARISON_PERIOD_NOT_CONFIRMED", "Klaviyo showed the report month but not the immediately previous calendar month as its comparison.");
            return failClosed("KLAVIYO_PERIOD_VERIFY_FAILED", "Klaviyo did not show the selected report month after applying it.");
          }
          control = periodControl(); if (!control) return failClosed("KLAVIYO_PERIOD_VERIFY_FAILED", "Klaviyo did not show the selected report month after applying it.");
        }
        // Nothing may cover the page when it is captured: a left-open picker would hide the card.
        if (openDialogs().length && !await dismissPicker()) return fail("TARGET_NOT_VISIBLE", "A Klaviyo picker stayed open over the Business Review.");
        const headings = () => Array.from(document.querySelectorAll("h1, h2, h3, h4, h5, h6, [role=heading]"));
        const targetControlSelector = "[role=tab], button, a[href], [role=button], [aria-selected], [aria-current], [aria-pressed], [data-state], [data-active], [tabindex]";
        const controlLabels = (element: Element) => [
          element.getAttribute("aria-label"),
          element.getAttribute("aria-labelledby")?.split(/\s+/).map((id) => document.getElementById(id)?.textContent ?? "").join(" "),
          visible(element),
        ].filter((value): value is string => Boolean(value));
        // A card view tab never lives in page navigation and never links to another page. Klaviyo's sidebar has its
        // own "Metrics"/"Overview" entries (Analytics → Metrics, run c890faec); they must never be tab candidates.
        const PAGE_NAVIGATION = "nav, [role=navigation], aside";
        const leadsElsewhere = (element: Element) => {
          const link = element.closest("a[href]"); if (!link) return false;
          try { return new URL(link.getAttribute("href")!, location.href).pathname !== location.pathname; } catch { return true; }
        };
        const isTargetControl = (element: Element) => !element.closest(PAGE_NAVIGATION) && !leadsElsewhere(element) && controlLabels(element).some((label) => matches(label, target.tabAliases));
        const isRenderedControl = (element: Element) => {
          const style = window.getComputedStyle(element);
          const rect = element.getBoundingClientRect();
          return !element.closest("[hidden], [aria-hidden=true]") && style.display !== "none" && style.visibility !== "hidden"
            && style.opacity !== "0" && rect.width > 0 && rect.height > 0;
        };
        const findCard = () => {
          const heading = headings().find((element) => {
            const rect = element.getBoundingClientRect();
            return matches(visible(element), target.cardAliases) && rect.width > 1 && rect.height > 1;
          });
          if (!heading) return null;
          // Klaviyo's live Business Review uses a semantic heading inside a plain
          // card div (not an article, section, or ARIA region). Find the smallest
          // ancestor that contains the card-local target control, which keeps
          // similarly labelled controls in other dashboard cards out of scope.
          let candidate = heading.parentElement; let bounded: Element | null = null;
          // The card never extends into an ancestor that also holds page navigation: on a freshly loaded dashboard the
          // card's own tabs can mount after its heading, and climbing past the card would reach the sidebar.
          const otherCardTitles = (target.cardTitles ?? []).filter((title) => !matches(title, target.cardAliases));
          const holdsAnotherCard = (element: Element) => headings().some((other) => other !== heading && element.contains(other) && matches(visible(other), otherCardTitles));
          while (candidate && candidate !== document.body && candidate !== document.documentElement && candidate.tagName !== "MAIN" && !candidate.querySelector(PAGE_NAVIGATION) && !holdsAnotherCard(candidate)) {
            bounded = candidate;
            // Some Klaviyo dashboard versions render view labels as plain nested
            // div/span controls without role/tabindex. The exact semantic label
            // remains card-local proof and smallestMatchingLabel resolves its
            // clickable leaf below.
            const localTargetControl = Array.from(candidate.querySelectorAll("*")).some((element) => isTargetControl(element) && isRenderedControl(element));
            if (localTargetControl) return candidate;
            candidate = candidate.parentElement;
          }
          const semantic = heading.closest("article, section, [role=region], [role=group]");
          return (semantic && !semantic.querySelector(PAGE_NAVIGATION) && !holdsAnotherCard(semantic) ? semantic : null) ?? bounded ?? heading.parentElement;
        };
        enterStage("CARD_RESOLUTION");
        let card = findCard(); if (!card) return fail("BUSINESS_REVIEW_CARD_NOT_FOUND", `The ${target.sectionKey} card was not found.`);
        diagnosticCard = card;
        // Klaviyo may render the card heading before its view controls while React
        // is hydrating/replacing the card. Wait for semantic control evidence (not
        // an arbitrary longer page timeout), and reacquire the card on each pass.
        const waitForTargetControl = async (): Promise<Element | null> => {
          // The live DOM evidence shows the card heading/metric view can settle
          // before Klaviyo mounts the ranking selector. Wait only for that exact
          // visible, card-local control; do not delay unrelated sections.
          const deadline = Date.now() + readinessTimeoutMs;
          do {
            const current = findCard();
            if (current) {
              card = current;
              diagnosticCard = current;
              if (Array.from(current.querySelectorAll("*")).some((element) => isTargetControl(element) && isRenderedControl(element))) return current;
            }
            await Promise.race([nextFrame(), new Promise<void>((resolve) => window.setTimeout(resolve, 60))]);
          } while (Date.now() < deadline);
          card = findCard();
          return card;
        };
        // Klaviyo controls are not consistently native ARIA tabs. Keep discovery
        // inside the proven card and require an exact card-local visible label.
        const tabCandidates = (liveCard: Element) => Array.from(liveCard.querySelectorAll("[role=tab], button, a[href], [role=button], [aria-selected], [aria-current], [aria-pressed], [data-state], [data-active], [tabindex]")).filter((element) => {
          const control = element as HTMLElement;
          return !control.matches(":disabled, [aria-disabled=true]") && isTargetControl(element) && isRenderedControl(element);
        });
        const isSelected = (element: Element) => {
          const state = (name: string) => normalize(element.getAttribute(name));
          return state("aria-selected") === "true" || state("aria-current") === "true" || state("aria-current") === "page"
            || state("aria-pressed") === "true" || state("data-state") === "active" || state("data-active") === "true";
        };
        const selectedTab = (liveCard: Element) => tabCandidates(liveCard).find(isSelected) ?? null;
        const smallestMatchingLabel = (liveCard: Element) => {
          const matchesInCard = Array.from(liveCard.querySelectorAll("*")).filter((element) => isTargetControl(element) && isRenderedControl(element));
          return matchesInCard.find((element) => !Array.from(element.children).some((child) => isTargetControl(child) && isRenderedControl(child))) ?? matchesInCard[0] ?? null;
        };
        const rankingTable = (liveCard: Element): { table: Element; rows: Element[] } | null => {
          if (!target.rowLimit || !target.rowHeaderLabels) return null;
          const headerMatches = (candidate: Element) => {
            const labels = normalize(visible(candidate));
            return target.rowHeaderLabels!.every((alternatives) => alternatives.some((label) => labels.includes(normalize(label))));
          };
          const table = Array.from(liveCard.querySelectorAll("table, [role=table], [role=grid]")).find((candidate) => {
            const header = candidate.querySelector("thead, [role=rowgroup]") ?? candidate;
            return headerMatches(header);
          });
          if (!table) return null;
          const rows = Array.from(table.querySelectorAll("tbody tr, [role=rowgroup] [role=row]")).filter((row) => {
            const cells = Array.from(row.querySelectorAll("td, [role=cell], [role=gridcell]"));
            return cells.length >= 2 && visible(row).trim().length > 0;
          });
          return { table, rows };
        };
        const rankingRowBounds = (row: Element) => {
          const rowRect = row.getBoundingClientRect();
          if (rowRect.width > 0 && rowRect.height > 0) return rowRect;
          // Klaviyo's semantic table can paint its role=cell contents while the
          // containing row has no measurable box (for example display: contents).
          // Use the union of measurable cells for crop/visibility checks instead
          // of rejecting visibly rendered ranking data as zero usable rows.
          const cellRects = Array.from(row.querySelectorAll("td,[role=cell],[role=gridcell]"))
            .map((cell) => cell.getBoundingClientRect()).filter((rect) => rect.width > 0 && rect.height > 0);
          if (cellRects.length === 0) return rowRect;
          const left = Math.min(...cellRects.map((rect) => rect.left)); const top = Math.min(...cellRects.map((rect) => rect.top));
          const right = Math.max(...cellRects.map((rect) => rect.right)); const bottom = Math.max(...cellRects.map((rect) => rect.bottom));
          return { x: left, y: top, left, top, right, bottom, width: right - left, height: bottom - top, toJSON: () => ({}) } as DOMRect;
        };
        const rankingRows = (liveCard: Element): { rows: Element[]; available: number; included: number } | null => {
          const rendered = rankingTable(liveCard);
          if (!rendered || !target.rowLimit) return null;
          // Data readiness is semantic. Some provider table rows have no layout
          // box even though their cells are painted; use cell geometry when needed.
          // Top-level viewport/crop visibility remains a separate check below.
          const nativeRows = rendered.rows.filter((row) => {
            const cells = Array.from(row.querySelectorAll("td, [role=cell], [role=gridcell]"));
            const rowRect = rankingRowBounds(row);
            return cells.length >= 2 && visible(row).trim().length > 0 && rowRect.height > 0;
          });
          const rows = nativeRows.length > 0 ? nativeRows : Array.from(rendered.table.querySelectorAll("tr, [role=row]")).filter((row) => {
            const cells = Array.from(row.querySelectorAll("td, [role=cell], [role=gridcell]"));
            const rowRect = rankingRowBounds(row);
            return cells.length >= 2 && visible(row).trim().length > 0 && rowRect.height > 0;
          });
          return { rows: rows.slice(0, target.rowLimit), available: rendered.rows.length, included: Math.min(rows.length, target.rowLimit) };
        };
        const tabRequired = target.tabAliases.length > 0;
        enterStage("VIEW_RESOLUTION");
        if (tabRequired) {
          // Ranking views can prove that their requested view is already active
          // without relying on Klaviyo's control markup: the exact table headers
          // plus usable rows are stronger evidence than a visual tab treatment.
          const renderedView = (liveCard: Element) => {
            // Content can render below the fold before the card is scrolled into
            // view. Table identity plus body rows prove the selected view; viewport
            // geometry is checked only after scrollIntoView below.
            const ranking = rankingTable(liveCard);
            if (target.rowLimit) return Boolean(ranking && ranking.rows.length > 0);
            // For reporting cards whose view is defined by a stable set of visible
            // metrics, rendered content is stronger evidence than an ARIA state
            // Klaviyo may not expose (notably Email deliverability and comparison).
            const text = normalize(visible(liveCard));
            return Boolean(target.requiredCardText?.every((required) => text.includes(normalize(required))))
              && !target.forbiddenCardText?.some((forbidden) => text.includes(normalize(forbidden)));
          };
          // Ranking tabs must render their structured rows, and content-proven views
          // (requiredCardText) their own content, before they are accepted: a
          // selected tab can still show the previous view's panel while it loads.
          const requiresRenderedView = Boolean(target.rowLimit || target.requiredCardText);
          let active = renderedView(card);
          if (!active) {
            await waitForTargetControl();
            if (!card) return fail("BUSINESS_REVIEW_CARD_NOT_FOUND", `The ${target.sectionKey} card was replaced without a semantic match.`);
            let selected = selectedTab(card);
            const tab = tabCandidates(card)[0] ?? smallestMatchingLabel(card);
            if (!selected && !tab) return fail("BUSINESS_REVIEW_TAB_NOT_FOUND", `The ${target.tabAliases[0]} tab was not found.`);
            if (!selected) { enterStage("VIEW_SWITCH"); diagnosticClickAttempted = true; (tab as HTMLElement).click(); }
            // Klaviyo can update aria-selected immediately but defer table content
            // until its async query resolves. Reacquire the semantic card on every
            // bounded poll; a fixed handful of animation frames is not a render
            // completion signal.
            const settled = await waitFor(() => {
              if (navigatedAway()) return true;
              card = findCard();
              if (!card) return false;
              diagnosticCard = card;
              active = renderedView(card);
              selected = selectedTab(card);
              diagnosticActiveStateObserved ||= Boolean(selected);
              diagnosticRenderedViewVerified ||= active;
              return active || (!requiresRenderedView && Boolean(selected));
            }, requiresRenderedView ? readinessTimeoutMs : 1_800);
            if (navigatedAway()) return unexpectedNavigation();
            if (!card) return fail("BUSINESS_REVIEW_CARD_NOT_FOUND", `The ${target.sectionKey} card was replaced without a semantic match.`);
            if (!settled) return fail("BUSINESS_REVIEW_TAB_NOT_SELECTED", `The ${target.tabAliases[0]} view could not be verified as active.`);
          }
        diagnosticCard = card;
        diagnosticActiveStateObserved ||= Boolean(selectedTab(card));
        diagnosticRenderedViewVerified ||= renderedView(card);
        if (!active && !( !requiresRenderedView && selectedTab(card))) return fail("BUSINESS_REVIEW_TAB_NOT_SELECTED", `The ${target.tabAliases[0]} view could not be verified as active.`);
        }
        enterStage("CONTENT_READY");
        if (!card) return fail("BUSINESS_REVIEW_CARD_NOT_FOUND", `The ${target.sectionKey} card was not available after its view update.`);
        const verifiedCard = card;
        if (target.requiredCardText && !target.requiredCardText.every((text) => normalize(visible(verifiedCard)).includes(normalize(text)))) return fail("BUSINESS_REVIEW_CONTENT_NOT_RENDERED", `The ${target.sectionKey} card did not render all required semantic content.`);
        if (target.forbiddenCardText?.some((text) => normalize(visible(verifiedCard)).includes(normalize(text)))) return fail("BUSINESS_REVIEW_TAB_NOT_SELECTED", `The ${target.sectionKey} card still shows a different view than ${target.tabAliases[0]}.`);
        const periodReady = await waitFor(() => { const liveControl = periodControl(); return Boolean(liveControl && hasExpectedPeriod(periodRegionText(liveControl))); }, 6_000);
        control = periodControl();
        if (!periodReady || !control || !hasExpectedPeriod(periodRegionText(control))) return fail("REPORT_PERIOD_NOT_CONFIRMED", "Klaviyo no longer showed the selected report month after the page update.");
        const controlText = periodRegionText(control);
        if (target.requiresComparisonProof) {
          const hasExactComparison = () => {
            const dates = ranges(periodRegionText(periodControl() ?? control!));
            // Exact, ordered calendar ranges are the proof. Klaviyo's current UI
            // says only "compared to" (not always "previous period"), so do not
            // reject the real label when both ranges independently match.
            return dates.some((date, index) => date === expected.startDate && dates[index + 1] === expected.endDate && dates[index + 2] === expected.previousStartDate && dates[index + 3] === expected.previousEndDate);
          };
          if (!await waitFor(hasExactComparison, 1_800)) return fail("COMPARISON_PERIOD_NOT_CONFIRMED", "Klaviyo did not expose the exact immediately previous complete month for comparison.");
        }
        card = findCard(); if (!card) return fail("BUSINESS_REVIEW_CARD_NOT_FOUND", `The ${target.sectionKey} card was not available after the page update.`);
        enterStage("SCROLL");
        card.scrollIntoView?.({ block: "nearest", inline: "nearest", behavior: "auto" });
        // Text rendering is not section readiness: Klaviyo paints numbers first and charts later. A chart counts
        // only once it holds plotted marks with real geometry (SVG series marks, not axes/grid/legend; or a
        // painted canvas). Then three consecutive observations, ~500 ms apart, must agree on view, period,
        // content, geometry, and mark count with nothing loading, re-querying the live card on every read.
        enterStage("VISUAL_READY");
        const markClass = /axis|grid|tick|legend|label|reference|background/i;
        const chartMarks = (root: Element) => {
          let marks = 0;
          for (const svg of Array.from(root.querySelectorAll("svg"))) {
            const box = svg.getBoundingClientRect();
            if (box.width < 40 || box.height < 40 || !elementVisible(svg)) continue;
            marks += Array.from(svg.querySelectorAll("path,rect,circle,line,polyline,polygon")).filter((mark) => {
              for (let node: Element | null = mark; node && node !== svg; node = node.parentElement) if (markClass.test(node.getAttribute("class") ?? "")) return false;
              if (mark.tagName.toLowerCase() === "path" && (mark.getAttribute("d") ?? "").trim().length < 4) return false;
              const rect = mark.getBoundingClientRect(); return rect.width + rect.height >= 2 && (rect.width > 0 || rect.height > 0);
            }).length;
          }
          for (const canvas of Array.from(root.querySelectorAll("canvas"))) {
            const box = canvas.getBoundingClientRect();
            if (box.width < 40 || box.height < 40 || !canvas.width || !canvas.height || !elementVisible(canvas)) continue;
            let painted = true;
            try {
              const context = canvas.getContext("2d");
              if (context) { const data = context.getImageData(0, 0, canvas.width, canvas.height).data; painted = false; for (let index = 3; index < data.length; index += 16) if (data[index]) { painted = true; break; } }
            } catch { /* a tainted or WebGL canvas with real dimensions is accepted as rendered */ }
            if (painted) marks += 1;
          }
          return marks;
        };
        const cardLoading = (liveCard: Element) => Array.from(liveCard.querySelectorAll("[aria-busy=true],[role=progressbar],[data-loading=true],[data-asc=Spinner],[class*=skeleton i]")).some(elementVisible);
        const contentProven = (liveCard: Element) => {
          const text = normalize(visible(liveCard));
          return (target.requiredCardText ?? []).every((required) => text.includes(normalize(required))) && !(target.forbiddenCardText ?? []).some((forbidden) => text.includes(normalize(forbidden)));
        };
        const observe = () => {
          const liveCard = findCard(); if (!liveCard) return { ready: false, chartReady: false, signature: "" };
          const rect = liveCard.getBoundingClientRect(); const tab = selectedTab(liveCard); const liveControl = periodControl();
          const marks = target.requiresChart ? chartMarks(liveCard) : 0;
          const chartReady = !target.requiresChart || marks > 0;
          return {
            ready: chartReady && !cardLoading(liveCard) && contentProven(liveCard) && rect.width > 0 && rect.height > 0,
            chartReady,
            signature: JSON.stringify([tab ? normalize(visible(tab)) : null, liveControl ? normalize(periodRegionText(liveControl)) : null, normalize(visible(liveCard)), [rect.x, rect.y, rect.width, rect.height].map(Math.round), marks]),
          };
        };
        const visualDeadline = Date.now() + Math.max(stabilityIntervalMs * 4, target.requiresChart ? Math.round(readinessTimeoutMs * 1.5) : readinessTimeoutMs);
        let agreeing = 0; let lastSignature = ""; let lastObservation = observe();
        while (true) {
          if (navigatedAway()) return unexpectedNavigation();
          lastObservation = observe();
          agreeing = lastObservation.ready ? (lastObservation.signature === lastSignature ? agreeing + 1 : 1) : 0;
          lastSignature = lastObservation.signature;
          if (agreeing >= 3 || Date.now() >= visualDeadline) break;
          await new Promise<void>((resolve) => window.setTimeout(resolve, stabilityIntervalMs));
        }
        if (!lastObservation.chartReady) return fail("BUSINESS_REVIEW_CHART_NOT_RENDERED", `The ${target.sectionKey} chart had not plotted any marks; its metrics rendered but the visualization did not.`);
        if (agreeing < 3) return fail("TARGET_LAYOUT_NOT_STABLE", `The ${target.sectionKey} card did not hold the same view, content, and layout for three consecutive observations.`);
        card = findCard(); if (!card) return fail("BUSINESS_REVIEW_CARD_NOT_FOUND", `The ${target.sectionKey} card was replaced without a semantic match.`);
        // Floating page UI (Klaviyo's Composer/assistant bar, toasts, a sticky header) is found geometrically, not by
        // sparse hit-testing: any visible, painting element outside the card whose positioned (fixed/sticky/absolute)
        // layer intersects the card. A sparse point grid can fall between the rows of a short bar (Flow Performance,
        // 2026-11-03: the Composer pill covered the chart's x-axis and $0 baseline between two sample rows).
        const paints = (element: Element, style: CSSStyleDeclaration) => Array.from(element.childNodes).some((node) => node.nodeType === Node.TEXT_NODE && Boolean(node.textContent?.trim()))
          || /^(?:img|svg|canvas|input|textarea|button|video)$/i.test(element.tagName)
          || (style.backgroundColor !== "" && !/rgba\(\d+,\s*\d+,\s*\d+,\s*0\)|transparent/.test(style.backgroundColor)) || (style.backgroundImage !== "" && style.backgroundImage !== "none") || (style.boxShadow !== "" && style.boxShadow !== "none");
        const layerOf = (element: Element, liveCard: Element): HTMLElement | null => {
          let layer: Element | null = null;
          for (let node: Element | null = element; node && !node.contains(liveCard); node = node.parentElement) if (/^(?:fixed|sticky|absolute)$/.test(getComputedStyle(node).position)) layer = node;
          if (!layer) return null;
          for (let node: Element | null = layer.parentElement; node && !node.contains(liveCard); node = node.parentElement) layer = node;
          return layer as HTMLElement;
        };
        const obstructions = (liveCard: Element, bottom: number) => {
          const box = liveCard.getBoundingClientRect(); const found = new Map<HTMLElement, DOMRect>();
          for (const element of Array.from(document.body.querySelectorAll("*"))) {
            if (liveCard.contains(element) || element.contains(liveCard)) continue;
            const rect = element.getBoundingClientRect();
            if (rect.width <= 0 || rect.height <= 0 || rect.left >= box.right || rect.right <= box.left || rect.top >= bottom || rect.bottom <= box.top) continue;
            const style = getComputedStyle(element);
            if (style.display === "none" || style.visibility === "hidden" || style.opacity === "0" || !paints(element, style)) continue;
            const layer = layerOf(element, liveCard); if (!layer || layer.style.visibility === "hidden") continue;
            const previousRect = found.get(layer); if (!previousRect || rect.top < previousRect.top) found.set(layer, rect);
          }
          return [...found.entries()].map(([layer, rect]) => ({ layer, top: rect.top }));
        };
        const scrollerOf = (element: Element): HTMLElement => {
          for (let node = element.parentElement; node && node !== document.body; node = node.parentElement) if (/^(?:auto|scroll|overlay)$/.test(getComputedStyle(node).overflowY)) return node;
          return (document.scrollingElement ?? document.documentElement) as HTMLElement;
        };
        // Where the card can actually be seen: the viewport intersected with every ancestor that clips its overflow.
        // Klaviyo scrolls the dashboard inside its own container below a page header that does not scroll, so a card
        // whose top is still >= 0 in the viewport can have its title hidden above that container's top edge (Campaign
        // and Flow Metrics, 2026-11-03: the crop showed "Dashboards / Business review" where the card title belonged).
        const clipBoundsOf = (element: Element) => {
          const bounds = { top: 0, left: 0, right: window.innerWidth, bottom: window.innerHeight };
          for (let node = element.parentElement; node && node !== document.body && node !== document.documentElement; node = node.parentElement) {
            const style = getComputedStyle(node);
            if (/^(?:visible)?$/.test(style.overflowY) && /^(?:visible)?$/.test(style.overflowX)) continue;
            const box = node.getBoundingClientRect(); if (box.width <= 0 || box.height <= 0) continue;
            bounds.top = Math.max(bounds.top, box.top); bounds.left = Math.max(bounds.left, box.left); bounds.right = Math.min(bounds.right, box.right); bounds.bottom = Math.min(bounds.bottom, box.bottom);
          }
          return bounds;
        };
        // A card scrolled partly above its container's visible top is scrolled back down until its title shows.
        const revealCardTop = async () => {
          const liveCard = findCard(); if (!liveCard) return;
          const hiddenAbove = Math.ceil(clipBoundsOf(liveCard).top - liveCard.getBoundingClientRect().top);
          if (hiddenAbove <= 0) return;
          const scroller = scrollerOf(liveCard); const before = scroller.scrollTop;
          scroller.scrollTop = Math.max(0, before - hiddenAbove - 8);
          if (scroller.scrollTop !== before) { await nextFrame(); await pause(stabilityIntervalMs); }
        };
        await revealCardTop();
        card = findCard(); if (!card) return fail("BUSINESS_REVIEW_CARD_NOT_FOUND", `The ${target.sectionKey} card was replaced without a semantic match.`);
        if (target.lastRowMustBeVisible) {
          // The final metric row must be fully visible with nothing floating over it (Klaviyo's Composer/assistant
          // bar sits over the bottom of the page). The card is first scrolled so the row clears the overlay — but never
          // so far that its title leaves the visible area; only if that cannot work is the overlay's layer hidden as
          // temporary UI state. Nothing in Klaviyo is clicked or changed.
          enterStage("LAST_ROW_VISIBILITY");
          // Klaviyo renders table rows as `display: contents` (no box of their own, run 4ab3c8e7): a row's geometry is
          // the union of its cells' boxes.
          const rowBox = (row: Element) => {
            const own = row.getBoundingClientRect(); if (own.width > 0 && own.height > 0) return { top: own.top, bottom: own.bottom };
            const cells = Array.from(row.children).map((cell) => cell.getBoundingClientRect()).filter((box) => box.width > 0 && box.height > 0);
            return cells.length ? { top: Math.min(...cells.map((box) => box.top)), bottom: Math.max(...cells.map((box) => box.bottom)) } : null;
          };
          const lastRowOf = (liveCard: Element) => Array.from(liveCard.querySelectorAll("tbody tr, [role=row]")).filter((row) => !row.querySelector("th, [role=columnheader]") && normalize(visible(row)).length > 0 && rowBox(row) !== null).pop() ?? null;
          const proof: Record<string, unknown> = { scrolledBy: 0, hiddenOverlays: 0 };
          let clear = false;
          for (let attempt = 0; attempt < 4 && !clear; attempt += 1) {
            const liveCard = findCard(); const row = liveCard && lastRowOf(liveCard);
            if (!liveCard || !row) return fail("BUSINESS_REVIEW_ROWS_NOT_FOUND", `The ${target.sectionKey} table's final row was not found.`);
            const rowRect = rowBox(row)!; const cardRect = liveCard.getBoundingClientRect(); const clip = clipBoundsOf(liveCard);
            const covering = obstructions(liveCard, rowRect.bottom);
            Object.assign(proof, { lastMetric: normalize(visible(row.querySelector("td, [role=cell], [role=gridcell], th") ?? row)).slice(0, 60), lastRowBottom: Math.round(rowRect.bottom), overlayTop: covering.length ? Math.round(Math.min(...covering.map(({ top }) => top))) : null, visibleTop: Math.round(clip.top) });
            if (!covering.length && rowRect.bottom <= clip.bottom) {
              // An overlay left over the card's empty padding below the last row bounds the crop instead of appearing in it.
              const below = obstructions(liveCard, cardRect.bottom);
              if (below.length) proof.cropBottom = Math.max(rowRect.bottom + 4, Math.min(...below.map(({ top }) => top)));
              clear = true; break;
            }
            const limit = covering.length ? Math.min(clip.bottom, ...covering.map(({ top }) => top)) : clip.bottom;
            const needed = Math.ceil(rowRect.bottom - limit + 8);
            // Scroll only as far as keeps the card's title inside the visible area (below any page header that clips
            // the dashboard's scroll container); otherwise fall back to hiding the overlay layer.
            if (needed > 0 && cardRect.top - needed >= clip.top) {
              const scroller = scrollerOf(liveCard); const before = scroller.scrollTop;
              scroller.scrollTop = before + needed;
              proof.scrolledBy = Number(proof.scrolledBy) + (scroller.scrollTop - before);
              if (scroller.scrollTop !== before) { await nextFrame(); await new Promise<void>((resolve) => window.setTimeout(resolve, stabilityIntervalMs)); continue; }
            }
            for (const { layer } of covering) { layer.style.setProperty("visibility", "hidden", "important"); proof.hiddenOverlays = Number(proof.hiddenOverlays) + 1; }
            await nextFrame();
          }
          Object.assign(proof, { visible: clear, overlap: clear ? "none" : "found" });
          lastRowProof = proof;
          if (!clear) return fail("BUSINESS_REVIEW_TARGET_OCCLUDED", `The ${target.sectionKey} final row (${String(proof.lastMetric ?? "")}) stayed hidden behind floating page UI or below the viewport.`);
          card = findCard(); if (!card) return fail("BUSINESS_REVIEW_CARD_NOT_FOUND", `The ${target.sectionKey} card was replaced without a semantic match.`);
        }
        // Klaviyo keeps re-laying out the dashboard after the one-off scroll above (cards above this one finish loading
        // and grow), so the card is re-measured on every pass and, whenever it has left the visible area (viewport ∩
        // clipping ancestors, i.e. below sticky page headers), moved back into it by scrolling its real scroll
        // container. A card that fits is placed wholly inside; a taller one is top-aligned. Never a fixed coordinate.
        // Run 08be2f58 (1648×1188 viewport + feedback banner): Campaign performance was pushed below the fold after
        // its single scroll and the old loop only waited, failing TARGET_NOT_VISIBLE on all five attempts.
        const placeInVisibleArea = async (liveCard: Element, rect: DOMRect, clip: { top: number; left: number; right: number; bottom: number }) => {
          const margin = 8; const room = clip.bottom - clip.top - 2 * margin;
          const fits = rect.height <= room;
          const delta = rect.top < clip.top + 1 || !fits || target.rowLimit ? rect.top - (clip.top + margin) : rect.bottom > clip.bottom - 1 ? rect.bottom - (clip.bottom - margin) : 0;
          const scroller = scrollerOf(liveCard); const before = scroller.scrollTop;
          if (Math.abs(delta) >= 1) scroller.scrollTop = before + Math.round(delta);
          positioning.push({ scroller: scroller === document.scrollingElement || scroller === document.documentElement ? "document" : `${scroller.tagName.toLowerCase()}${scroller.id ? `#${scroller.id}` : ""}`, scrollTopBefore: Math.round(before), scrollTopAfter: Math.round(scroller.scrollTop), delta: Math.round(delta), fits,
            card: { top: Math.round(rect.top), bottom: Math.round(rect.bottom), height: Math.round(rect.height) }, visibleArea: { top: Math.round(clip.top), bottom: Math.round(clip.bottom) }, viewport: { width: window.innerWidth, height: window.innerHeight } });
          if (scroller.scrollTop !== before) { await nextFrame(); await pause(Math.min(stabilityIntervalMs, 250)); }
          return scroller.scrollTop !== before;
        };
        let previous = card.getBoundingClientRect(); let stable = 0; let placements = 0;
        for (let attempt = 0; attempt < 14; attempt += 1) {
          await nextFrame(); card = findCard(); if (!card) return fail("BUSINESS_REVIEW_CARD_NOT_FOUND", `The ${target.sectionKey} card was replaced without a semantic match.`);
          const rect = card.getBoundingClientRect(); const clip = clipBoundsOf(card);
          const inViewport = rect.width > 0 && rect.height > 0 && rect.left >= clip.left - 1 && rect.top >= clip.top - 1 && rect.right <= clip.right + 1 && (target.rowLimit ? rect.top < clip.bottom : rect.bottom <= clip.bottom + 1);
          if (!inViewport) { previous = rect; stable = 0; if (placements < 6) { placements += 1; await placeInVisibleArea(card, rect, clip); } else await pause(Math.min(stabilityIntervalMs, 250)); continue; }
          if (rect.x === previous.x && rect.y === previous.y && rect.width === previous.width && rect.height === previous.height) stable += 1; else stable = 0;
          previous = rect; if (stable >= 1) {
            const ranking = rankingRows(card);
            if (target.rowLimit && (!ranking || ranking.rows.length === 0)) return fail("BUSINESS_REVIEW_ROWS_NOT_FOUND", `The ${target.sectionKey} table did not expose usable visible rows.`);
            const lastRow = ranking?.rows[ranking.rows.length - 1] ? rankingRowBounds(ranking.rows[ranking.rows.length - 1]!) : undefined;
            const firstRow = ranking?.rows[0] ? rankingRowBounds(ranking.rows[0]!) : undefined;
            if (firstRow && (firstRow.left < rect.left || firstRow.right > rect.right || firstRow.top < rect.top || firstRow.top < 0)) return fail("TARGET_NOT_VISIBLE", `The ${target.sectionKey} first qualifying row is not fully visible.`);
            if (lastRow && (lastRow.left < rect.left || lastRow.right > rect.right || lastRow.bottom > rect.bottom || lastRow.bottom > window.innerHeight)) return fail("TARGET_NOT_VISIBLE", `The ${target.sectionKey} qualifying rows are not fully visible.`);
            const targetRect: BusinessReviewTargetBounds = lastRow
              ? { x: rect.x, y: rect.y, width: rect.width, height: lastRow.bottom - rect.top, viewportWidth: window.innerWidth, viewportHeight: window.innerHeight, availableRowCount: ranking!.available, includedRowCount: ranking!.included }
              : { x: rect.x, y: rect.y, width: rect.width, height: rect.height, viewportWidth: window.innerWidth, viewportHeight: window.innerHeight };
            targetRect.visibleControls = Array.from(card.querySelectorAll(targetControlSelector)).filter(isRenderedControl).slice(0, 40).map((element) => ({ text: visible(element).replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, "[redacted-email]").slice(0, 180), tag: element.tagName.toLowerCase(), role: element.getAttribute("role"), ariaSelected: element.getAttribute("aria-selected"), ariaPressed: element.getAttribute("aria-pressed"), visible: true }));
            // The crop is final before overlays are handled, so UI that sits only below it is left alone.
            if (lastRowProof) {
              targetRect.lastRowProof = lastRowProof;
              if (typeof lastRowProof.cropBottom === "number" && lastRowProof.cropBottom < targetRect.y + targetRect.height) targetRect.height = lastRowProof.cropBottom - targetRect.y;
            }
            // Floating page chrome (Klaviyo's Composer/assistant prompt, toasts) painted over the crop is hidden as
            // temporary UI state: first every positioned layer that geometrically intersects the crop, then whatever a
            // dense hit-test (about every 16 px down and 48 px across) still finds on top. The crop must then hit only the
            // card. Nothing inside the card is touched.
            const liveCard = card;
            const floating = obstructions(liveCard, targetRect.y + targetRect.height);
            for (const { layer } of floating) layer.style.setProperty("visibility", "hidden", "important");
            if (floating.length) await nextFrame();
            const occluders = () => {
              if (typeof document.elementFromPoint !== "function") return [];
              const found = new Set<HTMLElement>();
              const columns = Math.max(8, Math.ceil(targetRect.width / 48)); const rows = Math.max(6, Math.ceil(targetRect.height / 16));
              for (let column = 0; column <= columns; column += 1) for (let row = 0; row <= rows; row += 1) {
                const x = Math.min(window.innerWidth - 1, targetRect.x + 4 + (targetRect.width - 8) * column / columns);
                const y = Math.min(window.innerHeight - 1, targetRect.y + 4 + (targetRect.height - 8) * row / rows);
                const hit = document.elementFromPoint(x, y);
                if (!hit || liveCard.contains(hit) || hit.contains(liveCard)) continue;
                let root: Element = hit; let positioned = false;
                for (let node: Element | null = hit; node && !node.contains(liveCard); node = node.parentElement) { root = node; if (/^(?:fixed|sticky|absolute)$/.test(getComputedStyle(node).position)) positioned = true; }
                if (positioned) found.add(root as HTMLElement);
              }
              return [...found];
            };
            const overlays = occluders();
            for (const overlay of overlays) overlay.style.setProperty("visibility", "hidden", "important");
            if (overlays.length) { await nextFrame(); if (occluders().length) return fail("BUSINESS_REVIEW_TARGET_OCCLUDED", `Floating page content still covered the ${target.sectionKey} card after it was hidden.`); }
            targetRect.hiddenOverlayCount = floating.length + overlays.length;
            // The screenshot itself must say which card it is: Campaign and Flow Metrics are otherwise identical tables.
            // The card's own title must lie inside the crop and the visible area, with nothing outside the card on top.
            const titleNode = headings().find((element) => liveCard.contains(element) && matches(visible(element), target.cardAliases));
            const titleBox = titleNode?.getBoundingClientRect(); const titleClip = clipBoundsOf(liveCard);
            const titleHit = titleBox && typeof document.elementFromPoint === "function" ? document.elementFromPoint(titleBox.left + Math.min(titleBox.width / 2, 12), titleBox.top + Math.min(titleBox.height / 2, 10)) : null;
            const titleVisible = Boolean(titleNode && titleBox && titleBox.width > 0 && titleBox.height > 0
              && titleBox.top >= Math.max(targetRect.y, titleClip.top) - 1 && titleBox.top < Math.min(targetRect.y + targetRect.height, titleClip.bottom)
              && (!titleHit || liveCard.contains(titleHit) || titleHit.contains(liveCard)));
            if (!titleVisible) return fail("BUSINESS_REVIEW_TARGET_OCCLUDED", `The ${target.cardAliases[0]} title is not visible in the ${target.sectionKey} crop, so the screenshot would not show which card it is.`);
            targetRect.cardTitle = visible(titleNode!).replace(/\s+/g, " ").trim().slice(0, 80);
            if (navigatedAway()) return unexpectedNavigation();
            enterStage("CAPTURE");
            targetRect.stageTimingsMs = { ...stageTimingsMs, [failureStage]: Math.max(0, Math.round(performance.now() - activeStageStartedAt)) };
            return { ok: true, sourceUrl: window.location.href, targetRect, observedPeriod: target.requiresComparisonProof ? { startDate: expected.startDate, endDate: expected.endDate, comparisonStartDate: expected.previousStartDate, comparisonEndDate: expected.previousEndDate } : { startDate: expected.startDate, endDate: expected.endDate } };
          }
        }
        const finalRect = previous;
        if (finalRect.width <= 0 || finalRect.height <= 0 || finalRect.left < 0 || finalRect.top < 0 || finalRect.right > window.innerWidth || finalRect.bottom > window.innerHeight) return fail("TARGET_NOT_VISIBLE", `The ${target.sectionKey} target is not fully visible.`);
        return fail("TARGET_LAYOUT_NOT_STABLE", `The ${target.sectionKey} target layout did not stabilize.`);
      } catch (error) {
        return fail("KLAVIYO_PAGE_ADAPTER_ERROR", error instanceof Error && error.message ? error.message : "The Business Review page helper failed.");
      }
    })();
    return JSON.parse(JSON.stringify(result)) as BusinessReviewAdapterResult;
  } catch (error) {
    return { ok: false, code: "KLAVIYO_PAGE_ADAPTER_ERROR", message: `The Klaviyo page helper failed: ${error instanceof Error ? error.message : String(error)}`.slice(0, 500), diagnostics: { failureStage: "UNCAUGHT_EXCEPTION", errorName: error instanceof Error ? error.name : typeof error, stack: (error instanceof Error && error.stack ? error.stack : "").split("\n").slice(0, 8).join("\n").slice(0, 2_000), currentUrl: `${location.origin}${location.pathname}` } };
  }
}
