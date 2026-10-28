export type KlaviyoAutomationFailureCode =
  | "KLAVIYO_PAGE_NOT_SUPPORTED"
  | "KLAVIYO_ACTIVE_TAB_GRANT_REQUIRED"
  | "ACTION_NOT_INVOKED"
  | "GRANTED_TAB_CLOSED"
  | "GRANTED_TAB_NOT_ACTIVE"
  | "GRANTED_TAB_CHANGED_ORIGIN"
  | "GRANTED_TAB_ROUTE_NOT_SUPPORTED"
  | "CAPTURE_PERMISSION_DENIED"
  | "TARGET_NOT_FOUND"
  | "PERIOD_NOT_FOUND"
  | "PERIOD_SET_FAILED"
  | "PERIOD_VERIFY_FAILED"
  | "TARGET_NOT_FULLY_VISIBLE"
  | "CAPTURE_FAILED"
  | "TAB_LOOKUP_FAILED"
  | "TAB_ACTIVATION_FAILED"
  | "PAGE_READY_FAILED"
  | "PAGE_READY_TIMEOUT"
  | "SCRIPT_INJECTION_FAILED"
  | "KLAVIYO_PERIOD_DIALOG_NOT_FOUND"
  | "KLAVIYO_PERIOD_APPLY_NOT_FOUND"
  | "KLAVIYO_PERIOD_APPLY_TIMEOUT"
  | "KLAVIYO_PERIOD_VERIFY_FAILED"
  | "KLAVIYO_PAGE_ADAPTER_ERROR"
  | "SCRIPT_RESULT_EMPTY"
  | "SCRIPT_RESULT_UNDEFINED"
  | "SCRIPT_RESULT_INVALID";

export interface ExecutiveSummaryTargetBounds {
  x: number;
  y: number;
  width: number;
  height: number;
  viewportWidth: number;
  viewportHeight: number;
  visibleControls?: Array<Record<string, string | boolean | null>>;
  availableRowCount?: number;
  includedRowCount?: number;
  stageTimingsMs?: Record<string, number>;
}

export interface ExecutiveSummaryInjectionPeriod { startDate: string; endDate: string }

export interface PlainViewport { width: number; height: number }
export interface PlainTargetRect { x: number; y: number; width: number; height: number; top: number; left: number; right: number; bottom: number }
export interface ExecutiveSummaryPageDiagnostics {
  origin: string;
  pathname: string;
  pathnameMatched: boolean;
  businessReviewTextFound: boolean;
  growthOverviewFound: boolean;
}

/** Structured-clone-safe contract shared by the injected page adapter and worker. */
export type ExecutiveSummaryAdapterResult =
  | { ok: true; pageVerified: true; periodVerified: true; sourceUrl: string; targetRect: PlainTargetRect; viewport: PlainViewport; diagnostics: ExecutiveSummaryPageDiagnostics }
  | { ok: false; code: Exclude<KlaviyoAutomationFailureCode, "CAPTURE_FAILED">; message: string; diagnostics?: ExecutiveSummaryPageDiagnostics };

export interface NormalizedPeriodRange { startDate: string; endDate: string }

const MONTHS: Record<string, string> = {
  jan: "01", january: "01", feb: "02", february: "02", mar: "03", march: "03", apr: "04", april: "04",
  may: "05", jun: "06", june: "06", jul: "07", july: "07", aug: "08", august: "08", sep: "09", september: "09",
  oct: "10", october: "10", nov: "11", november: "11", dec: "12", december: "12",
};

/** Converts human-visible provider date text to calendar dates without using it as report data. */
export function normalizeVisiblePeriod(value: string | null | undefined): NormalizedPeriodRange | null {
  const matches = [...(value ?? "").matchAll(/\b(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\.?\s+(\d{1,2}),?\s+(\d{4})\b/gi)];
  if (matches.length < 2) return null;
  const toDate = (match: RegExpMatchArray) => {
    const month = MONTHS[match[1]!.replace(/\.$/, "").toLowerCase()];
    const day = Number(match[2]);
    const year = match[3];
    if (!month || !year || day < 1 || day > 31) return null;
    return `${year}-${month}-${String(day).padStart(2, "0")}`;
  };
  const startDate = toDate(matches[0]!);
  const endDate = toDate(matches[1]!);
  return startDate && endDate ? { startDate, endDate } : null;
}

/**
 * This is passed directly to chrome.scripting.executeScript. Keep every runtime
 * helper inside this function: Chrome serializes its source, not this module's
 * closure. It returns only structured-clone-safe primitives and plain objects.
 */
export async function prepareExecutiveSummaryDocument(expected: ExecutiveSummaryInjectionPeriod, dialogTimeoutMs = 6_000): Promise<ExecutiveSummaryAdapterResult> {
  const fail = (code: Exclude<KlaviyoAutomationFailureCode, "CAPTURE_FAILED">, message: string, diagnostics?: ExecutiveSummaryPageDiagnostics): ExecutiveSummaryAdapterResult => ({ ok: false, code, message, ...(diagnostics ? { diagnostics } : {}) });
  try {
    const normalized = (value: string | null | undefined) => (value ?? "").replace(/\s+/g, " ").trim().toLowerCase();
    const months: Record<string, string> = {
      jan: "01", january: "01", feb: "02", february: "02", mar: "03", march: "03", apr: "04", april: "04",
      may: "05", jun: "06", june: "06", jul: "07", july: "07", aug: "08", august: "08", sep: "09", september: "09",
      oct: "10", october: "10", nov: "11", november: "11", dec: "12", december: "12",
    };
    const normalizePeriod = (value: string | null | undefined): { startDate: string; endDate: string } | null => {
      const matches = [...(value ?? "").matchAll(/\b(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\.?\s+(\d{1,2}),?\s+(\d{4})\b/gi)];
      if (matches.length < 2) return null;
      const toDate = (match: RegExpMatchArray) => {
        const month = months[match[1]!.replace(/\.$/, "").toLowerCase()];
        const day = Number(match[2]);
        const year = match[3];
        return month && year && day >= 1 && day <= 31 ? `${year}-${month}-${String(day).padStart(2, "0")}` : null;
      };
      const startDate = toDate(matches[0]!);
      const endDate = toDate(matches[1]!);
      return startDate && endDate ? { startDate, endDate } : null;
    };
    const expectedRange = /^\d{4}-\d{2}-\d{2}$/.test(expected.startDate) && /^\d{4}-\d{2}-\d{2}$/.test(expected.endDate)
      ? { startDate: expected.startDate, endDate: expected.endDate }
      : null;
    if (!expectedRange) return fail("PERIOD_VERIFY_FAILED", "The requested report period is invalid.");
    const origin = window.location.origin;
    const pathname = window.location.pathname;
    const pathnameMatched = /^\/analytics\/dashboards(?:\/|$)/.test(pathname);
    const diagnostics = (businessReviewTextFound: boolean, growthOverviewFound: boolean): ExecutiveSummaryPageDiagnostics => ({
      origin, pathname, pathnameMatched, businessReviewTextFound, growthOverviewFound,
    });
    if (!/^https:\/\/(?:[a-z0-9-]+\.)*klaviyo\.com$/i.test(origin) || !pathnameMatched) {
      return fail("KLAVIYO_PAGE_NOT_SUPPORTED", "This is not a Klaviyo Business review page.", diagnostics(false, false));
    }
    const periodsMatch = (left: { startDate: string; endDate: string } | null, right: { startDate: string; endDate: string }) => left !== null && left.startDate === right.startDate && left.endDate === right.endDate;
    const visibleText = (element: Element) => {
      const rendered = (element as HTMLElement).innerText;
      if (rendered && rendered.trim()) return rendered;
      const childText = Array.from(element.childNodes).map((node) => node.textContent ?? "").join(" ");
      return childText || element.textContent || "";
    };
    const semanticName = (element: Element) => {
      const html = element as HTMLInputElement;
      const labelledBy = element.getAttribute("aria-labelledby");
      const labelText = labelledBy ? labelledBy.split(/\s+/).map((id) => document.getElementById(id)?.textContent ?? "").join(" ") : "";
      const labels = html.labels ? Array.from(html.labels).map((label) => label.textContent ?? "").join(" ") : "";
      return [element.getAttribute("aria-label"), element.getAttribute("name"), element.getAttribute("placeholder"), labelText, labels, html.value, visibleText(element)].filter(Boolean).join(" ");
    };
    const interactive = () => Array.from(document.querySelectorAll("button, input, select, [role=button], [role=combobox], [role=option], [role=menuitem]"));
    const periodControls = () => interactive().filter((element) => /time period|date range|reporting period/i.test(semanticName(element)));
    const rangeFromElement = (element: Element) => {
      const inputText = Array.from(element.querySelectorAll("input")).map((input) => semanticName(input)).join(" ");
      for (const candidate of [semanticName(element), visibleText(element), inputText, visibleText(element.parentElement ?? element)]) {
        const range = normalizePeriod(candidate);
        if (range) return range;
      }
      return null;
    };
    // Klaviyo's selected range can be a visible sibling of the accessible
    // "Time period" control. Search only its compact semantic header region,
    // never an arbitrary page-wide date list.
    const rangeFromPeriodControlRegion = (control: Element) => {
      const candidates = [semanticName(control), visibleText(control)];
      let ancestor: Element | null = control.parentElement;
      for (let depth = 0; ancestor && depth < 3 && ancestor !== document.body && ancestor !== document.documentElement && ancestor.tagName !== "MAIN"; depth += 1, ancestor = ancestor.parentElement) {
        candidates.push(visibleText(ancestor));
      }
      for (const candidate of candidates) {
        const range = normalizePeriod(candidate);
        if (range) return range;
      }
      return null;
    };
    const displayedPeriod = () => {
      for (const control of periodControls()) {
        const range = rangeFromPeriodControlRegion(control);
        if (range) return range;
      }
      return null;
    };
    const dialog = () => Array.from(document.querySelectorAll("dialog, [role=dialog]")).find((element) => /time period|date range|reporting period/i.test(semanticName(element))) ?? null;
    const nextFrame = () => new Promise<void>((resolve) => {
      let finished = false;
      const finish = () => { if (!finished) { finished = true; resolve(); } };
      const fallback = window.setTimeout(finish, 250);
      if (typeof requestAnimationFrame === "function") requestAnimationFrame(() => { window.clearTimeout(fallback); finish(); });
      else finish();
    });
    const waitForDisplayedPeriod = async (expected: { startDate: string; endDate: string }) => {
      for (let attempt = 0; attempt < 8; attempt += 1) {
        if (periodsMatch(displayedPeriod(), expected)) return true;
        await nextFrame();
      }
      return periodsMatch(displayedPeriod(), expected);
    };
    const waitForDialogToClose = (openDialog: Element, timeoutMs: number) => new Promise<boolean>((resolve) => {
      const startedAt = Date.now();
      const check = () => {
        const nativeDialogIsClosed = openDialog.tagName === "DIALOG" && !openDialog.hasAttribute("open");
        const hiddenDialog = openDialog.hasAttribute("hidden") || (openDialog as HTMLElement).style.display === "none";
        if (!openDialog.isConnected || nativeDialogIsClosed || hiddenDialog || openDialog.getAttribute("aria-hidden") === "true") { resolve(true); return; }
        if (Date.now() - startedAt >= timeoutMs) { resolve(false); return; }
        window.setTimeout(check, 50);
      };
      check();
    });
    const setInputValue = (input: HTMLInputElement, value: string) => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
      setter?.call(input, value);
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new Event("change", { bubbles: true }));
    };
    const formatDateForInput = (input: HTMLInputElement, isoDate: string) => {
      if (input.type === "date") return isoDate;
      const [year, month, day] = isoDate.split("-").map(Number);
      const monthName = new Intl.DateTimeFormat("en-US", { month: "short", timeZone: "UTC" }).format(new Date(Date.UTC(year!, month! - 1, day!)));
      return `${monthName} ${day}, ${year}`;
    };
    const setDialogDateInputs = (openDialog: Element) => {
      const inputs = Array.from(openDialog.querySelectorAll("input")).filter((input) => !input.disabled && !input.readOnly);
      const start = inputs.find((input) => /start|from/i.test(semanticName(input))) ?? inputs[0];
      const end = inputs.find((input) => /end|to/i.test(semanticName(input))) ?? inputs[1];
      if (!start || !end || start === end) return false;
      setInputValue(start, formatDateForInput(start, expectedRange.startDate));
      setInputValue(end, formatDateForInput(end, expectedRange.endDate));
      return true;
    };

    const headings = () => Array.from(document.querySelectorAll("h1, h2, h3, h4, h5, h6, [role=heading]"));
    const businessReviewHeading = headings().find((element) => normalized(visibleText(element)) === "business review");
    const currentBusinessReview = document.querySelector('[aria-current="page"]');
    const breadcrumbBusinessReview = Array.from(document.querySelectorAll('[aria-label*="breadcrumb" i], nav, [role=navigation]'))
      .some((element) => /\bbusiness review\b/.test(normalized(visibleText(element))));
    const businessReviewTextFound = Boolean(businessReviewHeading)
      || Boolean(currentBusinessReview && normalized(semanticName(currentBusinessReview)).includes("business review"))
      || breadcrumbBusinessReview;
    const growthOverviewHeading = headings().find((element) => normalized(visibleText(element)) === "growth overview");
    const growthOverviewFound = Boolean(growthOverviewHeading);
    if (!businessReviewTextFound) {
      return fail("KLAVIYO_PAGE_NOT_SUPPORTED", "This is not a Klaviyo Business review page.", diagnostics(false, growthOverviewFound));
    }

    if (!periodsMatch(displayedPeriod(), expectedRange)) {
      const control = periodControls()[0];
      if (!control) return fail("PERIOD_NOT_FOUND", "Klaviyo's Time period control was not found.");
      (control as HTMLElement).click();
      await nextFrame();
      const openDialog = dialog();
      if (!openDialog) return fail("KLAVIYO_PERIOD_DIALOG_NOT_FOUND", "Klaviyo's Time period dialog was not found.");
      if (!periodsMatch(rangeFromElement(openDialog), expectedRange)) {
        const exactOption = Array.from(openDialog.querySelectorAll("button, [role=button], [role=option], [role=menuitem]"))
          .find((element) => periodsMatch(normalizePeriod(semanticName(element)), expectedRange));
        if (exactOption) (exactOption as HTMLElement).click();
        else if (!setDialogDateInputs(openDialog)) return fail("PERIOD_SET_FAILED", "The required report period could not be selected safely.");
        await nextFrame();
        if (!periodsMatch(rangeFromElement(openDialog), expectedRange)) return fail("PERIOD_SET_FAILED", "Klaviyo did not show the requested period in its dialog.");
      }
      const apply = Array.from(openDialog.querySelectorAll("button, [role=button]")).find((button) => normalized(semanticName(button)) === "apply");
      if (!apply) return fail("KLAVIYO_PERIOD_APPLY_NOT_FOUND", "Klaviyo's Apply button was not found.");
      (apply as HTMLElement).click();
      if (!await waitForDialogToClose(openDialog, dialogTimeoutMs)) return fail("KLAVIYO_PERIOD_APPLY_TIMEOUT", "Klaviyo did not close the Time period dialog in time.");
      if (!await waitForDisplayedPeriod(expectedRange)) return fail("KLAVIYO_PERIOD_VERIFY_FAILED", "Klaviyo did not show the requested report period after applying it.");
    }

    // Klaviyo can replace this card after Apply. Do not retain a detached
    // pre-Apply node: re-resolve the semantic target from the current DOM.
    const heading = headings().find((element) => normalized(visibleText(element)) === "growth overview");
    if (!heading) return fail("TARGET_NOT_FOUND", "Growth Overview could not be detected.", diagnostics(businessReviewTextFound, false));
    const target = heading.closest("article, section, [role=region], [role=group]") ?? heading.parentElement ?? heading;
    target.scrollIntoView?.({ block: "nearest", inline: "nearest", behavior: "auto" });
    let rect = target.getBoundingClientRect();
    let fullyVisible = rect.width > 0 && rect.height > 0 && rect.left >= 0 && rect.top >= 0 && rect.right <= window.innerWidth && rect.bottom <= window.innerHeight;
    // Smooth/provider-controlled scrolling can leave the card between frames.
    // Poll a bounded number of frames instead of racing the first layout frame.
    for (let attempt = 0; !fullyVisible && attempt < 8; attempt += 1) {
      await nextFrame();
      rect = target.getBoundingClientRect();
      fullyVisible = rect.width > 0 && rect.height > 0 && rect.left >= 0 && rect.top >= 0 && rect.right <= window.innerWidth && rect.bottom <= window.innerHeight;
    }
    if (rect.width <= 0 || rect.height <= 0) return fail("TARGET_NOT_FOUND", "Growth Overview has no visible bounds.", diagnostics(businessReviewTextFound, true));
    if (!fullyVisible) {
      return fail("TARGET_NOT_FULLY_VISIBLE", "Growth Overview is not fully visible in the viewport.", diagnostics(businessReviewTextFound, true));
    }
    return {
      ok: true,
      pageVerified: true,
      periodVerified: true,
      sourceUrl: window.location.href,
      targetRect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height, top: rect.top, left: rect.left, right: rect.right, bottom: rect.bottom },
      viewport: { width: window.innerWidth, height: window.innerHeight },
      diagnostics: diagnostics(businessReviewTextFound, true),
    };
  } catch (caught) {
    const message = caught instanceof Error && caught.message ? caught.message : "The Tention Klaviyo helper encountered an unexpected page error.";
    return fail("KLAVIYO_PAGE_ADAPTER_ERROR", message);
  }
}
