import { afterEach, describe, expect, it, vi } from "vitest";
import { canonicalDashboardScreenshotTypes, DASHBOARD_TARGETS, isCanonicalDashboardScreenshotType, prepareDashboardCaptureDocument } from "./dashboard-capture.js";

const period = { startDate: "2026-07-01", endDate: "2026-07-31", previousStartDate: "2026-06-01", previousEndDate: "2026-06-30" };

function rect(left = 10, top = 20, width = 900, height = 532): DOMRect {
  return { x: left, y: top, width, height, left, top, right: left + width, bottom: top + height, toJSON: () => ({}) } as DOMRect;
}

function installBounds(): void {
  if (!("scrollIntoView" in HTMLElement.prototype)) Object.defineProperty(HTMLElement.prototype, "scrollIntoView", { configurable: true, value: () => undefined });
  vi.spyOn(HTMLElement.prototype, "scrollIntoView").mockImplementation(() => undefined);
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    if (this.id === "summary-heading" || this.id === "flows-heading") return rect(10, 20, 900, 46);
    if (this.id === "summary-card") return rect(10, 20, 900, 532);
    if (this.id === "flows-card") return rect(10, 20, 900, 700);
    if (this.id === "div-flows-card") return rect(10, 20, 900, 700);
    if (this.id === "replacement-flows-card") return rect(30, 30, 900, 520);
    if (this.tagName === "THEAD" || (this.tagName === "TR" && this.parentElement?.tagName === "THEAD")) return this.closest("#replacement-flows-card") ? rect(30, 160, 900, 30) : rect(10, 150, 900, 30);
    if (this.dataset.flowRow) return this.closest("#replacement-flows-card")
      ? rect(30, 210 + Number(this.dataset.flowRow) * 50, 900, 40)
      : rect(10, 200 + Number(this.dataset.flowRow) * 50, 900, 40);
    if (this.dataset.divFlowRow) return rect(10, 200 + Number(this.dataset.divFlowRow) * 50, 900, 40);
    return rect(0, 0, 8, 8);
  });
}

function summaryCard(range: string): string {
  return `<section id="summary-card" role="region"><div><h2 id="summary-heading">Business performance summary</h2></div><p>${range}</p><div>Total revenue</div><div>Attributed revenue</div><div>Attributed revenue breakdown</div><div>Per recipient</div><div>Campaigns</div><div>Flows</div><div>Email</div><div>Text message</div></section>`;
}
function flowsCard(range: string, id = "flows-card", headingId = "flows-heading", count = 1): string {
  const rows = Array.from({ length: count }, (_, index) => `<tr data-flow-row="${index}"><td>Flow ${index + 1}</td><td>Live</td><td>${100 - index}</td></tr>`).join("");
  return `<section id="${id}" role="region"><div><h2 id="${headingId}">Top performing flows</h2></div><p>${range}</p><table><thead><tr><th><span>Flow</span></th><th><span>Status</span></th><th><span>Type</span></th><th><span>Deliveries</span></th><th><span>Placed</span> <span>Order</span></th><th><span>Percent</span> <span>change</span></th></tr></thead><tbody>${rows}</tbody></table></section>`;
}
function divFlowsCard(range: string, count: number): string {
  const rows = Array.from({ length: count }, (_, index) => `<div data-div-flow-row="${index}"><a href="#flow-${index}">Flow ${index + 1}</a><span>Live</span><span>Email</span><span>${100 - index}</span><span>${index + 1}</span><span>+${index + 1}%</span></div>`).join("");
  return `<section id="div-flows-card" role="region"><div><h2 id="flows-heading">Top performing flows</h2></div><p>${range}</p><div data-flow-header><span>Flow</span><span>Status</span><span>Type</span><span>Deliveries</span><span>Placed</span><span>Order</span><span>Percent</span><span>change</span></div>${rows}</section>`;
}
function dashboard(range = "Jul 1, 2026 – Jul 31, 2026 compared to previous period", flowRowCount = 1): void {
  window.history.replaceState({}, "", "/dashboard");
  document.body.innerHTML = `<main><header><span>Conversion metric</span><button aria-label="Time period">Time period</button><p>${range}</p></header>${summaryCard(range)}${flowsCard(range, "flows-card", "flows-heading", flowRowCount)}</main>`;
  installBounds();
}
function siblingRangeDashboard(range: string): void {
  dashboard(range);
  document.querySelector("header")!.innerHTML = `<span>Conversion metric</span><button aria-label="Time period">Time period</button><p>${range}</p>`;
}
function dashboardWithDivFlows(range = "Jul 1, 2026 – Jul 31, 2026 compared to previous period", count = 10): void {
  window.history.replaceState({}, "", "/dashboard");
  document.body.innerHTML = `<main><header><span>Conversion metric</span><button aria-label="Time period">Time period</button><p>${range}</p></header><nav><a href="#sidebar-flows">Flows</a></nav>${summaryCard(range)}${divFlowsCard(range, count)}</main>`;
  installBounds();
}

afterEach(() => { vi.restoreAllMocks(); document.body.innerHTML = ""; window.history.replaceState({}, "", "/"); });

describe("Klaviyo home dashboard semantic capture adapter", () => {
  it("selects the full Business performance summary card rather than its heading strip", async () => {
    dashboard();
    await expect(prepareDashboardCaptureDocument(DASHBOARD_TARGETS.overview, period)).resolves.toMatchObject({ ok: true, targetRect: { width: 900, height: 532, stageTimingsMs: { pageReadyMs: expect.any(Number), periodSetMs: expect.any(Number), cardResolveMs: expect.any(Number), contentReadyMs: expect.any(Number), totalMs: expect.any(Number) } }, observedPeriod: { startDate: period.startDate, endDate: period.endDate } });
  });

  it("returns redacted failure diagnostics when Chrome runs the helper as a self-contained serialized function", async () => {
    window.history.replaceState({}, "", "/not-a-klaviyo-report");
    document.body.innerHTML = `<main><h1>Loading</h1><button aria-label="Time period">Time period</button></main>`;
    const serialized = new Function("target", "expected", `return (${prepareDashboardCaptureDocument.toString()})(target, expected);`) as typeof prepareDashboardCaptureDocument;
    await expect(serialized(DASHBOARD_TARGETS.overview, period)).resolves.toMatchObject({ ok: false, code: "DASHBOARD_NOT_FOUND", diagnostics: { expectedSourceIdentity: "klaviyo-home|business-performance-summary|default", currentUrl: expect.stringContaining("/not-a-klaviyo-report"), headings: expect.any(Array), visibleControls: expect.any(Array), pageHtml: expect.any(String) } });
  });

  it("waits for the Overview SPA card data after the date controls appear", async () => {
    dashboard();
    document.querySelector("#summary-card")!.innerHTML = `<h2 id="summary-heading">Business performance summary</h2><div data-asc="Spinner" aria-label="Loading"></div>`;
    window.setTimeout(() => {
      document.querySelector("#summary-card")!.innerHTML = `<h2 id="summary-heading">Business performance summary</h2><p>Jul 1, 2026 – Jul 31, 2026</p><div>Total revenue</div><div>Attributed revenue</div><div>Attributed revenue breakdown</div><div>Per recipient</div><div>Campaigns</div><div>Flows</div><div>Email</div><div>Text message</div>`;
    }, 80);
    await expect(prepareDashboardCaptureDocument(DASHBOARD_TARGETS.overview, period)).resolves.toMatchObject({ ok: true, targetRect: { width: 900, height: 532 } });
  });

  it("captures through row five, not row six, when ten Top Flows rows are rendered", async () => {
    dashboard(undefined, 10);
    const result = await prepareDashboardCaptureDocument(DASHBOARD_TARGETS.top_flows, period);
    expect(result).toMatchObject({ ok: true, targetRect: { x: 10, y: 20, width: 900, height: 420, availableRowCount: 10, includedRowCount: 5 } });
    if (!result.ok) throw new Error("Expected a Top Flows target.");
    expect(result.targetRect.y).toBeLessThanOrEqual(document.querySelector<HTMLElement>("#flows-heading")!.getBoundingClientRect().top);
    expect(result.targetRect.y).toBeLessThanOrEqual(document.querySelector<HTMLElement>("thead")!.getBoundingClientRect().top);
    expect(result.targetRect.y + result.targetRect.height).toBeGreaterThanOrEqual(document.querySelector<HTMLElement>('[data-flow-row="4"]')!.getBoundingClientRect().bottom);
    expect(result.targetRect.y + result.targetRect.height).toBeLessThan(document.querySelector<HTMLElement>('[data-flow-row="5"]')!.getBoundingClientRect().top);
  });


  it.each([[6, 5], [5, 5], [4, 4], [3, 3], [1, 1]])("with %i usable rows, automatically captures exactly %i rows and reports the real count", async (available, included) => {
    dashboard(undefined, available);
    const result = await prepareDashboardCaptureDocument(DASHBOARD_TARGETS.top_flows, period);
    expect(result).toMatchObject({ ok: true, targetRect: { y: 20, height: 170 + 50 * included, availableRowCount: available, includedRowCount: included } });
    if (!result.ok) throw new Error("Expected a Top Flows target.");
    const bottom = result.targetRect.y + result.targetRect.height;
    expect(document.querySelector<HTMLElement>(`[data-flow-row="${included - 1}"]`)!.getBoundingClientRect().bottom).toBe(bottom);
    // Never invents rows: nothing beyond the last real row is included.
    expect(document.querySelectorAll("#flows-card tbody tr")).toHaveLength(available);
    if (available > included) expect(document.querySelector<HTMLElement>(`[data-flow-row="${included}"]`)!.getBoundingClientRect().top).toBeGreaterThan(bottom);
  });

  it("fails closed with a typed no-data result when the card header renders but zero usable rows exist", async () => {
    dashboard(undefined, 0);
    await expect(prepareDashboardCaptureDocument(DASHBOARD_TARGETS.top_flows, period)).resolves.toMatchObject({ ok: false, code: "TOP_FLOWS_NO_DATA" });
  });

  it("counts a Manual flow ranked inside the top five, so the crop never shows a sixth flow", async () => {
    dashboard(undefined, 7);
    document.querySelector('#flows-card [data-flow-row="4"]')!.children[1]!.textContent = "Manual";
    const result = await prepareDashboardCaptureDocument(DASHBOARD_TARGETS.top_flows, period);
    expect(result).toMatchObject({ ok: true, targetRect: { height: 420, availableRowCount: 7, includedRowCount: 5 } });
    if (!result.ok) throw new Error("Expected a Top Flows target.");
    expect(result.targetRect.y + result.targetRect.height).toBeLessThan(document.querySelector<HTMLElement>('[data-flow-row="5"]')!.getBoundingClientRect().top);
  });

  it("fails closed when a Draft flow sits between the counted top flows instead of painting a flow it does not count", async () => {
    dashboard(undefined, 7);
    document.querySelector('#flows-card [data-flow-row="2"]')!.children[1]!.textContent = "Draft";
    await expect(prepareDashboardCaptureDocument(DASHBOARD_TARGETS.top_flows, period)).resolves.toMatchObject({ ok: false, code: "TOP_FLOWS_NON_QUALIFYING_ROW_IN_VIEW" });
  });

  it("does not count non-Live rows as usable flows", async () => {
    dashboard(undefined, 4);
    document.querySelectorAll("#flows-card tbody tr").forEach((row) => { row.children[1]!.textContent = "Draft"; });
    await expect(prepareDashboardCaptureDocument(DASHBOARD_TARGETS.top_flows, period)).resolves.toMatchObject({ ok: false, code: "TOP_FLOWS_NO_DATA" });
  });

  it("treats Klaviyo Home Top performing flows (default view) as canonical with a five-row limit", () => {
    expect(canonicalDashboardScreenshotTypes).toEqual(["overview", "top_flows"]);
    expect(isCanonicalDashboardScreenshotType("top_flows")).toBe(true);
    expect(DASHBOARD_TARGETS.top_flows).toMatchObject({ sectionKey: "top_flows", semanticCard: "top-performing-flows", heading: "Top performing flows", sourceIdentity: "klaviyo-home|top-performing-flows|default", rowLimit: 5 });
  });

  it("rejects Top Flows from the retired Business Review route and a Business Review-style flow card on Home", async () => {
    dashboard(undefined, 10);
    window.history.replaceState({}, "", "/analytics/dashboards/01HWZSHD83RW7CYWQ6EVVQD2BK");
    await expect(prepareDashboardCaptureDocument(DASHBOARD_TARGETS.top_flows, period)).resolves.toMatchObject({ ok: false, code: "DASHBOARD_NOT_FOUND" });
    vi.restoreAllMocks(); dashboard(undefined, 10);
    document.querySelector("#flows-heading")!.textContent = "Flow Performance Summary";
    await expect(prepareDashboardCaptureDocument(DASHBOARD_TARGETS.top_flows, period)).resolves.toMatchObject({ ok: false, code: "TOP_PERFORMING_FLOWS_NOT_FOUND" });
  });

  it("requires the Top performing flows card itself to show the exact report month", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date", "requestAnimationFrame"] });
    try {
      dashboard(undefined, 10);
      document.querySelector("#flows-card p")!.textContent = "Jun 1, 2026 – Jun 30, 2026";
      const result = prepareDashboardCaptureDocument(DASHBOARD_TARGETS.top_flows, period);
      await vi.advanceTimersByTimeAsync(20_000);
      await expect(result).resolves.toMatchObject({ ok: false, code: "REPORT_PERIOD_NOT_CONFIRMED", diagnostics: { periodSetting: { cardPeriodText: expect.stringContaining("Jun 1, 2026 – Jun 30, 2026") } } });
    } finally { vi.useRealTimers(); }
  });

  it("never grows the card to the page when the control shows the month before the card re-renders (run 0c2c6035)", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date", "requestAnimationFrame"] });
    try {
      dashboard("Jul 1, 2026 – Jul 31, 2026 compared to previous period");
      document.querySelector("#summary-card p")!.textContent = "Jun 1, 2026 – Jun 30, 2026";
      const result = prepareDashboardCaptureDocument(DASHBOARD_TARGETS.overview, period);
      // Klaviyo re-renders the card 2 s later; only then may it be measured.
      window.setTimeout(() => { document.querySelector("#summary-card p")!.textContent = "Jul 1, 2026 – Jul 31, 2026"; }, 2_000);
      await vi.advanceTimersByTimeAsync(20_000);
      await expect(result).resolves.toMatchObject({ ok: true, targetRect: { width: 900, height: 532 } });
    } finally { vi.useRealTimers(); }
  });

  it("refuses a card candidate that holds the Time period control or another Home card", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date", "requestAnimationFrame"] });
    try {
      dashboard("Jul 1, 2026 – Jul 31, 2026 compared to previous period");
      // No card-level subtitle range at all: only the page-level control region shows the month.
      document.querySelector("#summary-card p")!.remove();
      const result = prepareDashboardCaptureDocument(DASHBOARD_TARGETS.overview, period);
      await vi.advanceTimersByTimeAsync(20_000);
      await expect(result).resolves.toMatchObject({ ok: false, code: "REPORT_PERIOD_NOT_CONFIRMED" });
    } finally { vi.useRealTimers(); }
  });

  it("requires the Top performing flows table header", async () => {
    dashboard(undefined, 10);
    document.querySelector("#flows-card thead")!.remove();
    document.querySelector("#flows-card p")!.insertAdjacentHTML("afterend", "<span>Flow</span><span>Status</span><span>Deliveries</span>");
    await expect(prepareDashboardCaptureDocument(DASHBOARD_TARGETS.top_flows, period)).resolves.toMatchObject({ ok: false, code: "TOP_FLOW_ROWS_NOT_FOUND" });
  });

  it("never clicks a flow name or opens Flow Builder while preparing Top Flows", async () => {
    dashboardWithDivFlows(undefined, 10);
    const clicked = vi.fn();
    document.querySelectorAll("#div-flows-card a").forEach((link) => link.addEventListener("click", (event) => { event.preventDefault(); clicked(); }));
    await expect(prepareDashboardCaptureDocument(DASHBOARD_TARGETS.top_flows, period)).resolves.toMatchObject({ ok: true, targetRect: { includedRowCount: 5 } });
    expect(clicked).not.toHaveBeenCalled();
    expect(window.location.pathname).toBe("/dashboard");
  });

  it("discovers a non-native div flow list from split semantic header labels and linked live rows", async () => {
    dashboardWithDivFlows(undefined, 10);
    const result = await prepareDashboardCaptureDocument(DASHBOARD_TARGETS.top_flows, period);
    expect(result).toMatchObject({ ok: true, targetRect: { x: 10, y: 20, width: 900, height: 420, availableRowCount: 10, includedRowCount: 5 } });
    if (!result.ok) throw new Error("Expected a div-based Top Flows target.");
    expect(result.targetRect.y + result.targetRect.height).toBeLessThan(document.querySelector<HTMLElement>('[data-div-flow-row="5"]')!.getBoundingClientRect().top);
  });

  it("never treats an unrelated sidebar Flows link as a card row", async () => {
    dashboardWithDivFlows(undefined, 0);
    await expect(prepareDashboardCaptureDocument(DASHBOARD_TARGETS.top_flows, period)).resolves.toMatchObject({ ok: false, code: "TOP_FLOWS_NO_DATA" });
  });

  it("rejects a heading-sized semantic card without creating a capture target", async () => {
    dashboard();
    vi.mocked(HTMLElement.prototype.getBoundingClientRect).mockImplementation(function (this: HTMLElement) {
      return this.id === "summary-card" || this.id === "summary-heading" ? rect(10, 20, 900, 46) : rect(10, 20, 900, 440);
    });
    await expect(prepareDashboardCaptureDocument(DASHBOARD_TARGETS.overview, period)).resolves.toMatchObject({ ok: false, code: "TARGET_BOUNDS_INVALID" });
  });

  it("rejects the dashboard root and chooses the smaller valid semantic card", async () => {
    dashboard();
    vi.mocked(HTMLElement.prototype.getBoundingClientRect).mockImplementation(function (this: HTMLElement) {
      if (this.tagName === "MAIN") return rect(0, 0, 1200, 780);
      if (this.id === "summary-heading") return rect(10, 20, 900, 46);
      if (this.id === "summary-card") return rect(10, 20, 900, 532);
      return rect(10, 20, 900, 440);
    });
    await expect(prepareDashboardCaptureDocument(DASHBOARD_TARGETS.overview, period)).resolves.toMatchObject({ ok: true, targetRect: { width: 900, height: 532 } });
  });

  it("requires the summary's complete semantic evidence, not just its heading", async () => {
    dashboard();
    document.querySelector("#summary-card")!.textContent = "Business performance summary Jul 1, 2026 - Jul 31, 2026 Total revenue";
    await expect(prepareDashboardCaptureDocument(DASHBOARD_TARGETS.overview, period)).resolves.toMatchObject({ ok: false, code: "BUSINESS_PERFORMANCE_SUMMARY_NOT_FOUND" });
  });

  it("accepts only /dashboard, never the old Business Review or another Klaviyo route", async () => {
    dashboard();
    await expect(prepareDashboardCaptureDocument(DASHBOARD_TARGETS.overview, period)).resolves.toMatchObject({ ok: true });
    window.history.replaceState({}, "", "/analytics/dashboards/business-review");
    await expect(prepareDashboardCaptureDocument(DASHBOARD_TARGETS.overview, period)).resolves.toMatchObject({ ok: false, code: "DASHBOARD_NOT_FOUND" });
    window.history.replaceState({}, "", "/campaigns");
    await expect(prepareDashboardCaptureDocument(DASHBOARD_TARGETS.top_flows, period)).resolves.toMatchObject({ ok: false, code: "DASHBOARD_NOT_FOUND" });
  });

  it.each([
    "Jul 1, 2026 - Jul 31, 2026 compared to previous period",
    "Jul 1, 2026 – Jul 31, 2026 compared to previous period",
    "Jul 1, 2026 — Jul 31, 2026 compared to previous period",
    " Jul 1, 2026\n - Jul 31, 2026 compared to previous period ",
    "<span>Jul 1, 2026 - Jul 31, 2026</span><span> compared to previous period</span>",
  ])("verifies the date range beside Time period: %s", async (range) => {
    siblingRangeDashboard(range);
    await expect(prepareDashboardCaptureDocument(DASHBOARD_TARGETS.overview, period)).resolves.toMatchObject({ ok: true });
  });

  /**
   * Klaviyo's live Home picker (runs 3cd784cd/e3ed5679): a "Time period" select ("Last 30 days") whose listbox
   * offers Custom; Start Date/End Date fields painted only for Custom; a comparison section; Apply/Cancel. The
   * closed picker stays in the DOM, hidden, with stale field values — here deliberately the expected month.
   */
  function liveHomePicker(applyWorks = true): { committed: () => string[]; cancelled: () => boolean } {
    dashboard("Jun 2, 2026 - Jul 2, 2026 compared to previous period");
    let committed: string[] = []; let cancelled = false;
    const picker = document.createElement("div"); picker.setAttribute("role", "dialog"); picker.style.display = "none";
    picker.innerHTML = `<label>Time period</label><button id="tp" aria-haspopup="listbox">Last 30 days</button>
      <div id="range" style="display:none"><span>Date range</span><input placeholder="Start Date" value="Jul 01, 2026" /><input placeholder="End Date" value="Jul 31, 2026" /></div>
      <label>Comparison period</label><button aria-haspopup="listbox">Previous period</button>
      <div style="display:none"><span>Date range</span><input placeholder="Start Date" value="May 31, 2026" /><input placeholder="End Date" value="Jun 30, 2026" /></div>
      <button id="apply">Apply</button><button id="cancel">Cancel</button>`;
    document.querySelector("header")!.append(picker);
    const close = () => { picker.style.display = "none"; document.getElementById("options")?.remove(); };
    document.querySelector("[aria-label='Time period']")!.addEventListener("click", () => { picker.style.display = ""; });
    picker.querySelector("#tp")!.addEventListener("click", () => {
      const list = document.createElement("ul"); list.id = "options"; list.setAttribute("role", "listbox");
      list.innerHTML = `<li role="option">Last 30 days</li><li role="option">Last month</li><li role="option">Custom</li>`;
      list.lastElementChild!.addEventListener("click", () => { picker.querySelector("#tp")!.textContent = "Custom"; (picker.querySelector("#range") as HTMLElement).style.display = ""; for (const input of Array.from(picker.querySelectorAll<HTMLInputElement>("#range input"))) input.value = ""; list.remove(); });
      document.body.append(list);
    });
    for (const input of Array.from(picker.querySelectorAll<HTMLInputElement>("#range input"))) input.addEventListener("focusout", () => { committed = Array.from(picker.querySelectorAll<HTMLInputElement>("#range input")).map((field) => field.value); });
    picker.querySelector("#cancel")!.addEventListener("click", () => { cancelled = true; close(); });
    picker.querySelector("#apply")!.addEventListener("click", () => {
      const applied = committed.join(" - "); close();
      // Klaviyo refetches before re-rendering the region and cards.
      if (applyWorks && applied === "Jul 01, 2026 - Jul 31, 2026") window.setTimeout(() => {
        document.querySelector("header p")!.textContent = "Jul 1, 2026 - Jul 31, 2026 compared to previous period";
        document.querySelector("#summary-card p")!.textContent = "Jul 1, 2026 - Jul 31, 2026";
      }, 1_500);
    });
    return { committed: () => committed, cancelled: () => cancelled };
  }

  it("chooses Custom in Klaviyo's Time period select, types the month in the field's format, and waits for the re-render", async () => {
    const home = liveHomePicker();
    const outcome = await prepareDashboardCaptureDocument(DASHBOARD_TARGETS.overview, period);
    expect(outcome.ok ? "ok" : `${outcome.code}: ${JSON.stringify(outcome.diagnostics?.periodSetting)}`).toBe("ok");
    expect(home.committed()).toEqual(["Jul 01, 2026", "Jul 31, 2026"]);
    expect(outcome).toMatchObject({ ok: true, observedPeriod: { startDate: "2026-07-01", endDate: "2026-07-31" } });
    expect(document.querySelector<HTMLElement>("[role=dialog]")!.style.display).toBe("none");
  });

  it("never accepts the expected month from the closed picker's hidden fields, and cancels the picker when Apply fails", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date", "requestAnimationFrame"] });
    try {
      const home = liveHomePicker(false);
      const result = prepareDashboardCaptureDocument(DASHBOARD_TARGETS.overview, period);
      await vi.advanceTimersByTimeAsync(40_000);
      await expect(result).resolves.toMatchObject({ ok: false, code: "REPORT_PERIOD_NOT_CONFIRMED", diagnostics: { periodSetting: {
        regionBefore: expect.stringContaining("Jun 2, 2026 - Jul 2, 2026"), dialogFound: true, timePeriodSelect: "Last 30 days", customChosen: true, valuesAfterSet: ["Jul 01, 2026", "Jul 31, 2026"],
        applyFound: true, applyClicked: true, dialogClosed: true, regionAfter: expect.stringContaining("Jun 2, 2026 - Jul 2, 2026"), pickerDismissed: true,
      } } });
      expect(home.cancelled()).toBe(false);
      expect(document.querySelector<HTMLElement>("[role=dialog]")!.style.display).toBe("none");
    } finally { vi.useRealTimers(); }
  });

  it("rejects the false PASS of run 3cd784cd: an open popover's text never proves the period of a rolling-range card", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date", "requestAnimationFrame"] });
    try {
      dashboard("Jun 2, 2026 - Jul 2, 2026 compared to previous period");
      // As live: the popover sits right after the Time period button and the card heading, before the painted ranges.
      const popover = `<div data-popper-placement="bottom"><span>Date range</span><span>Jul 1, 2026 - Jul 31, 2026</span></div>`;
      document.querySelector("[aria-label='Time period']")!.insertAdjacentHTML("afterend", popover);
      document.getElementById("summary-heading")!.insertAdjacentHTML("afterend", popover);
      document.querySelector("#summary-card p")!.textContent = "Jun 2, 2026 - Jul 2, 2026";
      const result = prepareDashboardCaptureDocument(DASHBOARD_TARGETS.overview, period, 50, 50);
      await vi.advanceTimersByTimeAsync(20_000);
      await expect(result).resolves.toMatchObject({ ok: false, code: "REPORT_PERIOD_NOT_CONFIRMED" });
    } finally { vi.useRealTimers(); }
  });

  it("closes a picker with Cancel when a period step fails while it is open, so no later capture is covered", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date", "requestAnimationFrame"] });
    try {
      const home = liveHomePicker();
      document.getElementById("apply")!.remove();
      const result = prepareDashboardCaptureDocument(DASHBOARD_TARGETS.overview, period);
      await vi.advanceTimersByTimeAsync(40_000);
      await expect(result).resolves.toMatchObject({ ok: false, code: "REPORT_PERIOD_NOT_CONFIRMED", diagnostics: { periodSetting: { applyFound: false, pickerDismissed: true } } });
      expect(home.cancelled()).toBe(true);
    } finally { vi.useRealTimers(); }
  });

  it("re-queries a React-replaced card after Apply and measures the replacement", async () => {
    dashboard("Jun 1, 2026 - Jun 30, 2026 compared to previous period");
    document.querySelector("[aria-label='Time period']")!.addEventListener("click", () => {
      const dialog = document.createElement("div"); dialog.setAttribute("role", "dialog"); dialog.setAttribute("aria-label", "Time period");
      dialog.innerHTML = `<input aria-label="Start date" value="Jun 1, 2026" /><input aria-label="End date" value="Jun 30, 2026" /><button>Apply</button>`;
      dialog.querySelector("button")!.addEventListener("click", () => {
        document.querySelector("header")!.innerHTML = `<span>Conversion metric</span><button aria-label="Time period">Time period</button><p>Jul 1, 2026 - Jul 31, 2026 compared to previous period</p>`;
        document.querySelector("#flows-card")!.outerHTML = flowsCard("Jul 1, 2026 - Jul 31, 2026", "replacement-flows-card", "replacement-flows-heading", 6);
        dialog.remove();
      });
      document.body.append(dialog);
    });
    await expect(prepareDashboardCaptureDocument(DASHBOARD_TARGETS.top_flows, period)).resolves.toMatchObject({ ok: true, targetRect: { x: 30, y: 30, width: 900, height: 420, availableRowCount: 6, includedRowCount: 5 } });
  });

  it("fails closed for wrong or partial dates, missing cards, invisible targets, and unstable layout", async () => {
    for (const range of ["Jun 1, 2026 - Jun 30, 2026", "Jul 1, 2026", "No selected period"]) {
      siblingRangeDashboard(range);
      await expect(prepareDashboardCaptureDocument(DASHBOARD_TARGETS.overview, period, 1, 50)).resolves.toMatchObject({ ok: false, code: "REPORT_PERIOD_NOT_CONFIRMED" });
      vi.restoreAllMocks();
    }
    dashboard(); document.getElementById("summary-card")!.remove();
    await expect(prepareDashboardCaptureDocument(DASHBOARD_TARGETS.overview, period)).resolves.toMatchObject({ ok: false, code: "BUSINESS_PERFORMANCE_SUMMARY_NOT_FOUND" });
    vi.restoreAllMocks(); dashboard(); document.getElementById("flows-card")!.remove();
    await expect(prepareDashboardCaptureDocument(DASHBOARD_TARGETS.top_flows, period)).resolves.toMatchObject({ ok: false, code: "TOP_PERFORMING_FLOWS_NOT_FOUND" });
    vi.restoreAllMocks(); dashboard(); vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(() => rect(0, -4));
    await expect(prepareDashboardCaptureDocument(DASHBOARD_TARGETS.overview, period)).resolves.toMatchObject({ ok: false, code: "TARGET_NOT_VISIBLE" });
    vi.restoreAllMocks(); dashboard(); let frames = 0;
    const requestFrame = window.requestAnimationFrame.bind(window);
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => { frames += 1; return requestFrame(callback); });
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      // The card itself moves on every rendered frame.
      return this.id === "summary-heading" ? rect(10, 20, 900, 46) : this.id === "summary-card" ? rect(frames % 2 ? 10 : 11, 20, 900, 532) : rect(0, 0, 8, 8);
    });
    await expect(prepareDashboardCaptureDocument(DASHBOARD_TARGETS.overview, period)).resolves.toMatchObject({ ok: false, code: "TARGET_LAYOUT_NOT_STABLE" });
  });

  it("returns redacted DOM, visible controls, loading, and date evidence when target proof fails", async () => {
    siblingRangeDashboard("Jun 1, 2026 – Jun 30, 2026");
    document.querySelector("main")!.insertAdjacentHTML("beforeend", "<p>Contact person@example.com</p>");
    const result = await prepareDashboardCaptureDocument(DASHBOARD_TARGETS.overview, period, 1, 50);
    expect(result).toMatchObject({ ok: false, code: "REPORT_PERIOD_NOT_CONFIRMED", diagnostics: { expectedSemanticCard: "Business performance summary", expectedPeriod: { startDate: period.startDate, endDate: period.endDate }, currentUrl: "https://www.klaviyo.com/dashboard" } });
    if (result.ok || !result.diagnostics) throw new Error("Expected redacted dashboard diagnostics.");
    expect(result.diagnostics.pageHtml).toContain("[redacted-email]");
    expect(result.diagnostics.pageHtml).not.toContain("person@example.com");
    expect(result.diagnostics).toHaveProperty("visibleControls");
    expect(result.diagnostics).toHaveProperty("loading");
    expect(result.diagnostics).toHaveProperty("usableRowCount");
  });
});

/**
 * Reproduces Klaviyo Home's current Top performing flows layout: CSS-grid rows
 * rendered as `display: contents` (no box of their own) inside a content wrapper
 * that is narrower than the table it paints. Geometry mirrors the live capture.
 */
describe("Top performing flows with display:contents grid rows", () => {
  const WRAPPER = { left: 412, width: 1198 }; const TABLE = { left: 460, width: 1212 };
  function gridDashboard(rowCount: number): void {
    window.history.replaceState({}, "", "/dashboard");
    const rows = Array.from({ length: rowCount }, (_, index) => `<div style="display: contents" data-grid-row="${index}"><div data-cell="${index}"><a href="#flow-${index}">Flow ${index + 1}</a><span>Trigger ${index + 1}</span></div><div data-cell="${index}"><span>Live</span></div><div data-cell="${index}"><span>Email</span></div><div data-cell="${index}"><span>${1000 + index}</span></div><div data-cell="${index}"><span>$${(rowCount - index) * 100}.00</span><span>$1.00 / recipient</span></div><div data-cell="${index}"><span>↓ ${index + 1}%</span></div></div>`).join("");
    document.body.innerHTML = `<main><header><span>Conversion metric</span><button aria-label="Time period">Time period</button><p>Jul 1, 2026 – Jul 31, 2026 compared to previous period</p></header>
      <section id="grid-flows-card"><div><h2 id="grid-flows-heading">Top performing flows</h2><p>Jul 1, 2026 - Jul 31, 2026</p><button>View all flows</button></div>
      <div id="grid-table" style="display: grid"><div id="grid-header"><span>Flow</span><span>Status</span><span>Type</span><span>Deliveries</span><span>Placed Order</span><span>Percent change</span></div>${rows}</div></section></main>`;
    // The live viewport the failure was captured in.
    vi.spyOn(window, "innerWidth", "get").mockReturnValue(1790); vi.spyOn(window, "innerHeight", "get").mockReturnValue(1586);
    if (!("scrollIntoView" in HTMLElement.prototype)) Object.defineProperty(HTMLElement.prototype, "scrollIntoView", { configurable: true, value: () => undefined });
    vi.spyOn(HTMLElement.prototype, "scrollIntoView").mockImplementation(() => undefined);
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      if (this.id === "grid-flows-card") return rect(WRAPPER.left, 100, WRAPPER.width, 120 + rowCount * 56);
      if (this.id === "grid-flows-heading") return rect(TABLE.left, 110, 300, 30);
      if (this.id === "grid-table") return rect(TABLE.left, 180, TABLE.width, 40 + rowCount * 56);
      if (this.id === "grid-header") return rect(TABLE.left, 180, TABLE.width, 40);
      if (this.dataset.gridRow !== undefined) return rect(0, 0, 0, 0);
      const cell = this.closest<HTMLElement>("[data-cell]");
      if (cell) return rect(TABLE.left, 220 + Number(cell.dataset.cell) * 56, TABLE.width, 56);
      return rect(0, 0, 0, 0);
    });
  }
  /** Chrome's executeScript({ func }) keeps only the function source. */
  const injected = new Function("target", "expected", `return (${prepareDashboardCaptureDocument.toString()})(target, expected);`) as typeof prepareDashboardCaptureDocument;

  it.each([[9, 5], [5, 5], [3, 3], [1, 1]])("counts %i real rows (not their shared container) and keeps the first %i", async (available, included) => {
    gridDashboard(available);
    const result = await injected(DASHBOARD_TARGETS.top_flows, period);
    expect(result).toMatchObject({ ok: true, targetRect: { availableRowCount: available, includedRowCount: included } });
    if (!result.ok) return;
    expect(result.targetRect.y + result.targetRect.height).toBe(220 + included * 56);
  });

  it("crops the painted table width, not the narrower wrapper box", async () => {
    gridDashboard(9);
    const result = await injected(DASHBOARD_TARGETS.top_flows, period);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.targetRect.x).toBe(WRAPPER.left);
    expect(result.targetRect.x + result.targetRect.width).toBe(TABLE.left + TABLE.width);
  });

  it("still fails closed with zero usable rows", async () => {
    gridDashboard(0);
    await expect(injected(DASHBOARD_TARGETS.top_flows, period)).resolves.toMatchObject({ ok: false, code: "TOP_FLOWS_NO_DATA" });
  });
});

/** Live run 7e2beafa: the only structured row was one wrapper spanning every flow row. */
describe("Top performing flows inside a single wrapper row", () => {
  function wrappedDashboard(rowCount: number): void {
    window.history.replaceState({}, "", "/dashboard");
    const rows = Array.from({ length: rowCount }, (_, index) => `<div data-wrapped-row="${index}"><a href="#flow-${index}">Flow ${index + 1}</a><span>Live</span><span>Email</span><span>${1000 + index}</span><span>$${(rowCount - index) * 100}.00</span><span>↓ ${index + 1}%</span></div>`).join("");
    document.body.innerHTML = `<main><header><span>Conversion metric</span><button aria-label="Time period">Time period</button><p>Jul 1, 2026 – Jul 31, 2026 compared to previous period</p></header>
      <section id="wrapped-flows-card"><div><h2 id="wrapped-flows-heading">Top performing flows</h2><p>Jul 1, 2026 - Jul 31, 2026</p></div>
      <table><thead><tr><th>Flow</th><th>Status</th><th>Type</th><th>Deliveries</th><th>Placed Order</th><th>Percent change</th></tr></thead><tbody><tr id="wrapper-row"><td>${rows}</td><td>Live</td></tr></tbody></table></section></main>`;
    if (!("scrollIntoView" in HTMLElement.prototype)) Object.defineProperty(HTMLElement.prototype, "scrollIntoView", { configurable: true, value: () => undefined });
    vi.spyOn(HTMLElement.prototype, "scrollIntoView").mockImplementation(() => undefined);
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      if (this.id === "wrapped-flows-card") return rect(10, 20, 900, 200 + rowCount * 56);
      if (this.id === "wrapped-flows-heading") return rect(10, 30, 300, 30);
      if (this.tagName === "THEAD" || (this.tagName === "TR" && this.parentElement?.tagName === "THEAD")) return rect(10, 150, 900, 30);
      if (this.id === "wrapper-row" || this.tagName === "TD") return rect(10, 180, 900, rowCount * 56);
      const row = this.closest<HTMLElement>("[data-wrapped-row]");
      if (row) return rect(10, 180 + Number(row.dataset.wrappedRow) * 56, 900, 56);
      return rect(0, 0, 0, 0);
    });
  }
  const injected = new Function("target", "expected", `return (${prepareDashboardCaptureDocument.toString()})(target, expected);`) as typeof prepareDashboardCaptureDocument;

  it.each([[9, 5], [4, 4], [1, 1]])("counts each of %i flows instead of the wrapper and includes %i", async (available, included) => {
    wrappedDashboard(available);
    const result = await injected(DASHBOARD_TARGETS.top_flows, period);
    expect(result).toMatchObject({ ok: true, targetRect: { availableRowCount: available, includedRowCount: included } });
    if (result.ok) expect(result.targetRect.y + result.targetRect.height).toBe(180 + included * 56);
  });

  it("records geometry-only layout evidence for diagnosis", async () => {
    wrappedDashboard(9);
    const result = await injected(DASHBOARD_TARGETS.top_flows, period);
    expect(result.ok && result.targetRect.layoutEvidence).toMatchObject({ window: { innerWidth: expect.any(Number) }, card: { tag: "section", links: 9 }, structuredRows: { count: 1 } });
    expect(JSON.stringify(result.ok ? result.targetRect.layoutEvidence : null)).not.toContain("Flow 1");
  });

  it("injects the same period parser as the unit-tested Campaigns parser", async () => {
    const { readFileSync } = await import("node:fs"); const { resolve } = await import("node:path");
    const read = (file: string) => readFileSync(resolve(process.cwd(), `src/features/klaviyo-navigation/${file}`), "utf8");
    const exported = (() => { const source = read("campaigns-capture.ts"); const start = source.indexOf("export function parseCampaignPeriodText("); return source.slice(start, source.indexOf("export function visibleCampaignPeriodText(", start)).trimEnd().replace(/^export /, ""); })();
    const injected = (() => { const source = read("dashboard-capture.ts"); const start = source.indexOf("        function parseCampaignPeriodText("); return source.slice(start, source.indexOf("        const hasExpectedPeriod = ", start)).trimEnd().replace(/^ {8}/gm, ""); })();
    expect(injected.startsWith("function parseCampaignPeriodText(")).toBe(true);
    expect(injected).toBe(exported);
  });
});
