import { afterEach, describe, expect, it, vi } from "vitest";
import { normalizeVisiblePeriod, prepareExecutiveSummaryDocument } from "./executive-summary-adapter.js";

const july = "Jul 1, 2026 – Jul 31, 2026";
const julyPeriod = { startDate: "2026-07-01", endDate: "2026-07-31" };

function rect(left = 20, top = 30, width = 500, height = 300): DOMRect {
  return { x: left, y: top, width, height, left, top, right: left + width, bottom: top + height, toJSON: () => ({}) } as DOMRect;
}

function businessReview(period = july): void {
  document.body.innerHTML = `<main><h1>Business review</h1><button id="period" aria-label="Time period">${period}</button><section id="growth" role="region"><h2>Growth overview</h2><p>Summary</p></section></main>`;
  if (!("scrollIntoView" in HTMLElement.prototype)) Object.defineProperty(HTMLElement.prototype, "scrollIntoView", { configurable: true, value: () => undefined });
  vi.spyOn(HTMLElement.prototype, "scrollIntoView").mockImplementation(() => undefined);
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    return this.id === "growth" ? rect() : rect(0, 0, 10, 10);
  });
}

function realBusinessReviewPage({ businessReview = "Business review", dashboardId = "01HWZSHD83RW7CYWQ6EVVQD2BK" }: { businessReview?: string; dashboardId?: string } = {}): void {
  window.history.replaceState({}, "", `/analytics/dashboards/${dashboardId}`);
  document.body.innerHTML = `<main>
    <nav aria-label="Breadcrumb"><span>Dashboards</span><span>${businessReview}</span></nav>
    <button id="period" aria-label="Time period">Jul 1, 2026 - Jul 31, 2026 compared to previous period</button>
    <section id="growth" role="region"><h2><span>Growth</span>\n<span>overview</span></h2><p>Conversion summary</p><p>Message type breakdown</p><p>Channel breakdown</p></section>
  </main>`;
  if (!("scrollIntoView" in HTMLElement.prototype)) Object.defineProperty(HTMLElement.prototype, "scrollIntoView", { configurable: true, value: () => undefined });
  vi.spyOn(HTMLElement.prototype, "scrollIntoView").mockImplementation(() => undefined);
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    return this.id === "growth" ? rect() : rect(0, 0, 10, 10);
  });
}

function siblingPeriodBusinessReview(rangeMarkup: string): void {
  window.history.replaceState({}, "", "/analytics/dashboards/01HWZSHD83RW7CYWQ6EVVQD2BK");
  document.body.innerHTML = `<main><nav aria-label="Breadcrumb">Dashboards / Business Review</nav>
    <header id="date-region"><span>Conversion metric</span><button aria-label="Placed Order">Placed Order</button><button aria-label="Time period">Time period</button><p id="range">${rangeMarkup}</p></header>
    <section id="growth" role="region"><h2>Growth Overview</h2><p>Conversion summary</p></section></main>`;
  if (!("scrollIntoView" in HTMLElement.prototype)) Object.defineProperty(HTMLElement.prototype, "scrollIntoView", { configurable: true, value: () => undefined });
  vi.spyOn(HTMLElement.prototype, "scrollIntoView").mockImplementation(() => undefined);
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) { return this.id === "growth" ? rect() : rect(0, 0, 10, 10); });
}

function openTimePeriodDialog(currentPeriod: string, onApply: (dialog: HTMLElement) => void, includeApply = true): HTMLElement {
  const dialog = document.createElement("div");
  dialog.setAttribute("role", "dialog"); dialog.setAttribute("aria-label", "Time period");
  dialog.innerHTML = `<p>Custom</p><label>Start date<input aria-label="Start date" value="${currentPeriod.split(/\s[-–]\s/)[0]}" /></label><label>End date<input aria-label="End date" value="${currentPeriod.split(/\s[-–]\s/)[1]}" /></label><p>Comparison period: Previous period</p>`;
  if (includeApply) {
    const apply = document.createElement("button"); apply.setAttribute("role", "button"); apply.textContent = "Apply";
    apply.addEventListener("click", () => onApply(dialog)); dialog.append(apply);
  }
  document.body.append(dialog);
  return dialog;
}

describe("Executive Summary Klaviyo adapter", () => {
  afterEach(() => {
    vi.restoreAllMocks(); document.body.innerHTML = "";
    window.history.replaceState({}, "", "/analytics/dashboards/test-dashboard");
  });

  it("recognizes the real Business review page shape, verifies the period, and returns Growth overview bounds", async () => {
    realBusinessReviewPage();
    await expect(prepareExecutiveSummaryDocument(julyPeriod)).resolves.toMatchObject({
      ok: true, pageVerified: true, periodVerified: true, sourceUrl: window.location.href,
      targetRect: { x: 20, y: 30, width: 500, height: 300, top: 30, left: 20, right: 520, bottom: 330 },
      diagnostics: {
        origin: "https://www.klaviyo.com", pathname: "/analytics/dashboards/01HWZSHD83RW7CYWQ6EVVQD2BK", pathnameMatched: true,
        businessReviewTextFound: true, growthOverviewFound: true,
      },
    });
  });

  it.each([
    ["BUSINESS REVIEW", "01HWZSHD83RW7CYWQ6EVVQD2BK"],
    [" Business\n Review ", "different-dashboard-id"],
  ])("accepts capitalization, whitespace, split breadcrumb nodes, and dashboard ID %s", async (businessReview, dashboardId) => {
    realBusinessReviewPage({ businessReview, dashboardId });
    await expect(prepareExecutiveSummaryDocument(julyPeriod)).resolves.toMatchObject({ ok: true, pageVerified: true, periodVerified: true, targetRect: expect.any(Object) });
  });

  it("remains callable after Chrome-style function-source serialization and returns plain data", async () => {
    businessReview();
    const injected = new Function(`return (${prepareExecutiveSummaryDocument.toString()});`)() as typeof prepareExecutiveSummaryDocument;
    const result = await injected(julyPeriod);
    expect(result).toMatchObject({ ok: true, pageVerified: true, periodVerified: true });
    expect(JSON.parse(JSON.stringify(result))).toEqual(result);
  });

  it("returns a typed page-side error when unexpected DOM access throws", async () => {
    businessReview();
    vi.spyOn(document, "querySelectorAll").mockImplementation(() => { throw new Error("DOM access interrupted"); });
    await expect(prepareExecutiveSummaryDocument(julyPeriod)).resolves.toEqual({
      ok: false, code: "KLAVIYO_PAGE_ADAPTER_ERROR", message: "DOM access interrupted",
    });
  });

  it.each([
    "Jul 1, 2026 - Jul 31, 2026",
    "Jul 01, 2026 - Jul 31, 2026",
    "Jul 1, 2026 – Jul 31, 2026",
    " Jul 01, 2026\n – \nJul 31, 2026 ",
  ])("normalizes equivalent visible period text: %s", (visiblePeriod) => {
    expect(normalizeVisiblePeriod(visiblePeriod)).toEqual({ startDate: "2026-07-01", endDate: "2026-07-31" });
  });

  it("skips the Time period dialog when the page already shows the expected calendar dates", async () => {
    businessReview("Jul 01, 2026 - Jul 31, 2026");
    const control = document.getElementById("period")!;
    const openDialog = vi.fn(); control.addEventListener("click", openDialog);
    await expect(prepareExecutiveSummaryDocument(julyPeriod)).resolves.toMatchObject({ ok: true, periodVerified: true });
    expect(openDialog).not.toHaveBeenCalled();
    expect(document.querySelector("[role=dialog]")).toBeNull();
  });

  it.each([
    "Jul 1, 2026 - Jul 31, 2026 compared to previous period",
    "Jul 1, 2026 – Jul 31, 2026 compared to previous period",
    "  Jul 1, 2026\n - \n Jul 31, 2026   compared to\nprevious period ",
    "<span>Jul 1, 2026 - Jul 31, 2026</span><span> compared to</span><span> previous period</span>",
  ])("verifies a live sibling Time period range without requiring it inside the control: %s", async (range) => {
    siblingPeriodBusinessReview(range);
    await expect(prepareExecutiveSummaryDocument(julyPeriod)).resolves.toMatchObject({ ok: true, periodVerified: true });
  });

  it("re-queries a React-replaced Time period region after Apply until the live July sibling range appears", async () => {
    siblingPeriodBusinessReview("Jun 1, 2026 - Jun 30, 2026 compared to previous period");
    document.querySelector("[aria-label='Time period']")!.addEventListener("click", () => openTimePeriodDialog("Jun 1, 2026 - Jun 30, 2026", (dialog) => {
      const region = document.createElement("header"); region.id = "date-region-after-apply";
      region.innerHTML = `<span>Conversion metric</span><button aria-label="Time period">Time period</button><p>Jul 1, 2026 - Jul 31, 2026 compared to previous period</p>`;
      document.getElementById("date-region")!.replaceWith(region); dialog.remove();
    }));
    await expect(prepareExecutiveSummaryDocument(julyPeriod)).resolves.toMatchObject({ ok: true, periodVerified: true });
  });

  it.each(["Jun 1, 2026 - Jun 30, 2026 compared to previous period", "Jul 1, 2026 compared to previous period", "Selected period unavailable"])("fails closed for an unconfirmed sibling range: %s", async (range) => {
    siblingPeriodBusinessReview(range);
    await expect(prepareExecutiveSummaryDocument(julyPeriod, 1)).resolves.toMatchObject({ ok: false });
  });

  it("rejects a generic Klaviyo dashboard without Growth overview", async () => {
    document.body.innerHTML = `<nav aria-label="Breadcrumb">Dashboards <span>Business review</span></nav><button aria-label="Time period">${july}</button><section><h2>Another dashboard</h2></section>`;
    await expect(prepareExecutiveSummaryDocument(julyPeriod)).resolves.toMatchObject({
      ok: false, code: "TARGET_NOT_FOUND", diagnostics: { pathnameMatched: true, businessReviewTextFound: true, growthOverviewFound: false },
    });
  });

  it.each(["/campaigns", "/flows"])("rejects the Klaviyo %s route before reading page content", async (pathname) => {
    window.history.replaceState({}, "", pathname);
    document.body.innerHTML = `<main><h1>Business review</h1><button aria-label="Time period">${july}</button><section><h2>Growth overview</h2></section></main>`;
    await expect(prepareExecutiveSummaryDocument(julyPeriod)).resolves.toMatchObject({
      ok: false, code: "KLAVIYO_PAGE_NOT_SUPPORTED", diagnostics: { pathname, pathnameMatched: false, businessReviewTextFound: false, growthOverviewFound: false },
    });
  });

  it("sets an incorrect dialog period, applies it, re-verifies the page, and continues", async () => {
    businessReview("Jun 1, 2026 - Jun 30, 2026");
    const period = document.getElementById("period")!;
    period.addEventListener("click", () => openTimePeriodDialog("Jun 1, 2026 - Jun 30, 2026", (dialog) => {
      const [start, end] = Array.from(dialog.querySelectorAll("input")) as HTMLInputElement[];
      period.textContent = `${start!.value} - ${end!.value}`; dialog.remove();
    }));
    await expect(prepareExecutiveSummaryDocument(julyPeriod)).resolves.toMatchObject({ ok: true, periodVerified: true });
    expect(period).toHaveTextContent("Jul 1, 2026 - Jul 31, 2026");
  });

  it("re-resolves Growth overview after Klaviyo replaces the dashboard card while applying a period", async () => {
    businessReview("Jun 1, 2026 - Jun 30, 2026");
    const period = document.getElementById("period")!;
    period.addEventListener("click", () => openTimePeriodDialog("Jun 1, 2026 - Jun 30, 2026", (dialog) => {
      const [start, end] = Array.from(dialog.querySelectorAll("input")) as HTMLInputElement[];
      period.textContent = `${start!.value} - ${end!.value}`;
      const replacement = document.createElement("section");
      replacement.id = "growth-after-apply";
      replacement.setAttribute("role", "region");
      replacement.innerHTML = "<h2>Growth overview</h2><p>Updated summary</p>";
      document.getElementById("growth")!.replaceWith(replacement);
      dialog.remove();
    }));
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      if (this.id === "growth") return rect(0, -20, 500, 300);
      if (this.id === "growth-after-apply") return rect(40, 50, 600, 320);
      return rect(0, 0, 10, 10);
    });

    await expect(prepareExecutiveSummaryDocument(julyPeriod)).resolves.toMatchObject({
      ok: true,
      periodVerified: true,
      targetRect: { x: 40, y: 50, width: 600, height: 320 },
    });
  });

  it("applies an already-correct dialog selection without waiting for a change event", async () => {
    businessReview("Jun 1, 2026 - Jun 30, 2026");
    const period = document.getElementById("period")!;
    let inputs: HTMLInputElement[] = [];
    period.addEventListener("click", () => openTimePeriodDialog("Jul 01, 2026 - Jul 31, 2026", (dialog) => {
      inputs = Array.from(dialog.querySelectorAll("input")); period.textContent = "Jul 01, 2026 - Jul 31, 2026"; dialog.remove();
    }));
    await expect(prepareExecutiveSummaryDocument(julyPeriod)).resolves.toMatchObject({ ok: true, periodVerified: true });
    expect(inputs.map((input) => input.value)).toEqual(["Jul 01, 2026", "Jul 31, 2026"]);
  });

  it("returns a typed failure when Apply is missing", async () => {
    businessReview("Jun 1, 2026 - Jun 30, 2026");
    document.getElementById("period")!.addEventListener("click", () => openTimePeriodDialog("Jul 01, 2026 - Jul 31, 2026", () => undefined, false));
    await expect(prepareExecutiveSummaryDocument(julyPeriod)).resolves.toMatchObject({ ok: false, code: "KLAVIYO_PERIOD_APPLY_NOT_FOUND" });
  });

  it("returns a typed timeout when Apply does not close the dialog", async () => {
    businessReview("Jun 1, 2026 - Jun 30, 2026");
    document.getElementById("period")!.addEventListener("click", () => openTimePeriodDialog("Jul 01, 2026 - Jul 31, 2026", () => undefined));
    await expect(prepareExecutiveSummaryDocument(julyPeriod, 1)).resolves.toMatchObject({ ok: false, code: "KLAVIYO_PERIOD_APPLY_TIMEOUT" });
  });

  it("returns a typed failure when Apply closes but the main page period remains incorrect", async () => {
    businessReview("Jun 1, 2026 - Jun 30, 2026");
    document.getElementById("period")!.addEventListener("click", () => openTimePeriodDialog("Jul 01, 2026 - Jul 31, 2026", (dialog) => dialog.remove()));
    await expect(prepareExecutiveSummaryDocument(julyPeriod)).resolves.toMatchObject({ ok: false, code: "KLAVIYO_PERIOD_VERIFY_FAILED" });
  });

  it("fails without a date control instead of guessing a period", async () => {
    document.body.innerHTML = `<main><h1>Business review</h1><section><h2>Growth overview</h2></section></main>`;
    await expect(prepareExecutiveSummaryDocument(julyPeriod)).resolves.toMatchObject({ ok: false, code: "PERIOD_NOT_FOUND" });
  });

  it("fails closed when a wrong period dialog has no editable dates or matching semantic option", async () => {
    businessReview("Jun 1, 2026 – Jun 30, 2026");
    document.getElementById("period")!.addEventListener("click", () => {
      const dialog = document.createElement("div"); dialog.setAttribute("role", "dialog"); dialog.setAttribute("aria-label", "Time period"); dialog.textContent = "Custom Jun 1, 2026 - Jun 30, 2026"; document.body.append(dialog);
    });
    await expect(prepareExecutiveSummaryDocument(julyPeriod)).resolves.toMatchObject({ ok: false, code: "PERIOD_SET_FAILED" });
  });

  it("fails when Growth overview is absent or not fully in the viewport", async () => {
    businessReview(); document.getElementById("growth")!.remove();
    await expect(prepareExecutiveSummaryDocument(julyPeriod)).resolves.toMatchObject({ ok: false, code: "TARGET_NOT_FOUND" });
    vi.restoreAllMocks(); businessReview();
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) { return this.id === "growth" ? rect(0, -5, 500, 300) : rect(); });
    await expect(prepareExecutiveSummaryDocument(julyPeriod)).resolves.toMatchObject({ ok: false, code: "TARGET_NOT_FULLY_VISIBLE" });
  });

  it("waits a bounded number of animation frames for the scrolled Growth overview card to become visible", async () => {
    businessReview();
    let growthRectReads = 0;
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      if (this.id !== "growth") return rect(0, 0, 10, 10);
      growthRectReads += 1;
      return growthRectReads < 3 ? rect(0, -5, 500, 300) : rect();
    });

    await expect(prepareExecutiveSummaryDocument(julyPeriod)).resolves.toMatchObject({ ok: true, targetRect: { x: 20, y: 30 } });
    expect(growthRectReads).toBeGreaterThanOrEqual(3);
  });
});
