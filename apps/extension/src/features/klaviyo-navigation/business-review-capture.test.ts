import { afterEach, describe, expect, it, vi } from "vitest";
import { installRangeCalendar } from "./test-support/range-calendar.js";
import { getReportPeriod } from "@tention/report-core";
import { automaticBusinessReviewScreenshotTypes, BUSINESS_REVIEW_TARGETS, businessReviewScreenshotTypes, isAutomaticBusinessReviewScreenshotType, isBusinessReviewScreenshotType, prepareBusinessReviewCaptureDocument } from "./business-review-capture.js";

const period = { startDate: "2026-07-01", endDate: "2026-07-31", previousStartDate: "2026-06-01", previousEndDate: "2026-06-30" };
const augustPeriod = { startDate: "2026-08-01", endDate: "2026-08-31", previousStartDate: "2026-07-01", previousEndDate: "2026-07-31" };

function rect(left = 10, top = 20, width = 400, height = 250): DOMRect {
  return { x: left, y: top, width, height, left, top, right: left + width, bottom: top + height, toJSON: () => ({}) } as DOMRect;
}
/** A plotted chart: axis and grid lines plus real series marks. */
const CHART = `<svg class="chart"><g class="axis"><line></line></g><g class="grid"><path d="M0 0 L10 0"></path></g><g class="series"><rect></rect><rect></rect><path d="M0 10 L20 5 L40 8"></path></g></svg>`;
/** The same chart before Klaviyo plots it: the container and axes exist, no series marks. */
const EMPTY_CHART = `<svg class="chart"><g class="axis"><line></line></g></svg>`;
const OVERVIEW = (value: string, recipients: string) => `<p>${value} Conversion Value vs previous period</p><p>${recipients} Total Recipients vs previous period</p><div id="overview-chart">${CHART}</div>`;
const METRICS = `<table><tr><td>Metric</td><td>Email</td></tr><tr><td>Total Recipients</td><td>354K</td></tr><tr><td>Open Rate</td><td>56.9%</td></tr><tr><td>Click Rate</td><td>0.47%</td></tr><tr><td>Revenue Per Recipient</td><td>$0.14</td></tr></table>`;
const CONVERSION_SUMMARY = "<p>Total revenue $100.00 vs previous period</p><p>Attributed revenue $20.00</p><p>Unattributed revenue $80.00</p><p>Total recipients 1,000</p>";
const MESSAGE_TYPE_BREAKDOWN = `<p>Attributed revenue $20.00 +5.0% vs previous period</p><p>Campaigns $12.00 60% +3.0%</p><p>Flows $8.00 40% +8.0%</p><figure aria-label=\"Campaigns / Flows chart\">${CHART}</figure>`;
function page(control = "Jul 1, 2026 – Jul 31, 2026 compared to previous period Jun 1, 2026 – Jun 30, 2026"): void {
  window.history.replaceState({}, "", "/analytics/dashboards/01HWZSHD83RW7CYWQ6EVVQD2BK");
  document.body.innerHTML = `<main><nav aria-label="Breadcrumb">Dashboards / Business Review</nav><button aria-label="Time period">${control}</button>
    <section id="growth" role="region"><h2>Growth Overview</h2><div role="tablist"><button role="tab" aria-selected="true">Conversion summary</button><button role="tab" aria-selected="false">Message type breakdown</button><button role="tab" aria-selected="false">Channel breakdown</button></div><div id="growth-panel">${CONVERSION_SUMMARY}</div></section>
    <section id="campaign" role="region"><h2>Campaign Performance Summary</h2><div role="tablist"><button role="tab" aria-selected="true">Overview</button><button role="tab" aria-selected="false">Metrics</button><button role="tab" aria-selected="false">Top Performing</button></div><div id="campaign-panel">${OVERVIEW("$55,899.41", "357,495")}</div></section>
    <section id="flow" role="region"><h2>Flow Performance Summary</h2><div role="tablist"><button role="tab" aria-selected="true">Overview</button><button role="tab" aria-selected="false">Metrics</button><button role="tab" aria-selected="false">Top Performing</button></div><div id="flow-panel">${OVERVIEW("$109,925.66", "14,601")}</div></section>
    <section id="deliverability" role="region"><h2>Deliverability</h2><div role="tablist"><button role="tab" aria-selected="true">Email</button><button role="tab" aria-selected="false">Text message</button></div><p>Open Rate Click Rate Bounce Rate Spam Complaint Rate Unsubscribe Rate</p></section></main>`;
  for (const group of ["growth", "campaign", "flow"]) for (const tab of Array.from(document.querySelectorAll(`#${group} [role=tab]`))) {
    tab.addEventListener("click", () => Array.from(document.querySelectorAll(`#${group} [role=tab]`)).forEach((item) => item.setAttribute("aria-selected", item === tab ? "true" : "false")));
  }
  // Like Klaviyo, Overview and Metrics render different panels in the same card.
  for (const group of ["campaign", "flow"]) for (const tab of Array.from(document.querySelectorAll(`#${group} [role=tab]`))) tab.addEventListener("click", () => {
    const panel = document.querySelector(`#${group}-panel`);
    if (panel) panel.innerHTML = tab.textContent === "Metrics" ? METRICS : tab.textContent === "Overview" ? OVERVIEW(group === "campaign" ? "$55,899.41" : "$109,925.66", group === "campaign" ? "357,495" : "14,601") : "<p>Top performing</p>";
  });
  // Like Klaviyo, Growth overview renders a different panel for each of its views.
  for (const tab of Array.from(document.querySelectorAll("#growth [role=tab]"))) tab.addEventListener("click", () => {
    const panel = document.querySelector("#growth-panel");
    if (panel) panel.innerHTML = tab.textContent === "Message type breakdown" ? MESSAGE_TYPE_BREAKDOWN : tab.textContent === "Conversion summary" ? CONVERSION_SUMMARY : "<p>Email $15.00 SMS $5.00</p>";
  });
  if (!("scrollIntoView" in HTMLElement.prototype)) Object.defineProperty(HTMLElement.prototype, "scrollIntoView", { configurable: true, value: () => undefined });
  vi.spyOn(HTMLElement.prototype, "scrollIntoView").mockImplementation(() => undefined);
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) { return this.closest("section")?.id ? rect() : rect(0, 0, 8, 8); });
  // SVG marks have geometry only once plotted; jsdom gives SVG elements none of their own.
  vi.spyOn(SVGElement.prototype, "getBoundingClientRect").mockImplementation(function (this: SVGElement) { return this.closest("section")?.id ? rect(20, 40, 200, 120) : rect(0, 0, 0, 0); });
}
/** Klaviyo's Time period dialog: current Start/End fields, then a Comparison period select whose Custom fields appear on demand. */
function periodDialog(onApply: (current: [string, string], comparison: [string, string] | null) => void): HTMLElement {
  const dialog = document.createElement("div"); dialog.setAttribute("role", "dialog"); dialog.setAttribute("aria-label", "Time period");
  dialog.innerHTML = `<label>Start<input aria-label="Start date" value="Jun 1, 2026" /></label><label>End<input aria-label="End date" value="Jun 30, 2026" /></label>
    <span>Comparison period</span><select aria-label="Comparison"><option>Previous period</option><option>Custom</option></select>
    <div id="comparison-fields" hidden><label>Start<input aria-label="Comparison start date" value="May 1, 2026" /></label><label>End<input aria-label="Comparison end date" value="May 31, 2026" /></label></div><button>Apply</button>`;
  const select = dialog.querySelector("select")!;
  select.addEventListener("change", () => { (dialog.querySelector("#comparison-fields") as HTMLElement).hidden = select.value !== "Custom"; });
  dialog.querySelector("button")!.addEventListener("click", () => {
    const inputs = Array.from(dialog.querySelectorAll("input")).map((input) => input.value);
    onApply([inputs[0]!, inputs[1]!], select.value === "Custom" ? [inputs[2]!, inputs[3]!] : null);
    dialog.remove();
  });
  return dialog;
}
function siblingRangePage(range: string): void {
  page("");
  const control = document.querySelector("[aria-label='Time period']")!;
  const region = document.createElement("header"); region.id = "date-region";
  region.innerHTML = `<span>Conversion metric</span><button aria-label="Placed Order">Placed Order</button><button aria-label="Time period">Time period</button><p>${range}</p>`;
  control.replaceWith(region);
}

afterEach(() => { vi.restoreAllMocks(); document.body.innerHTML = ""; window.history.replaceState({}, "", "/"); });

describe("Business Review semantic capture adapter", () => {
  it("owns exactly the canonical Business Review sections", () => {
    expect(businessReviewScreenshotTypes).toEqual(["month_comparison", "campaign_performance", "campaign_metrics", "flow_performance", "flow_metrics"]);
    expect(automaticBusinessReviewScreenshotTypes).toEqual(businessReviewScreenshotTypes);
  });

  it("no longer routes Top Campaigns, whose canonical source is Klaviyo Campaigns", () => {
    expect(isBusinessReviewScreenshotType("top_campaigns")).toBe(false);
    expect(isAutomaticBusinessReviewScreenshotType("top_campaigns")).toBe(false);
  });

  it("no longer accepts Top 5 Flows, whose canonical source is Klaviyo Home", () => {
    expect(isBusinessReviewScreenshotType("top_flows")).toBe(false);
    expect(isAutomaticBusinessReviewScreenshotType("top_flows")).toBe(false);
    expect(Object.keys(BUSINESS_REVIEW_TARGETS)).not.toContain("top_flows");
  });

  it("returns redacted failure diagnostics when Chrome runs the helper as a self-contained serialized function", async () => {
    window.history.replaceState({}, "", "/not-a-klaviyo-report");
    const serialized = new Function("target", "expected", `return (${prepareBusinessReviewCaptureDocument.toString()})(target, expected);`) as typeof prepareBusinessReviewCaptureDocument;
    await expect(serialized(BUSINESS_REVIEW_TARGETS.top_campaigns, period)).resolves.toMatchObject({ ok: false, code: "KLAVIYO_PAGE_NOT_SUPPORTED", diagnostics: { expectedSourceIdentity: "business-review|campaign-performance|top-performing", currentUrl: expect.stringContaining("/not-a-klaviyo-report"), headings: expect.any(Array), visibleControls: expect.any(Array), pageHtml: expect.any(String) } });
  });
  it.each([
    ["month_comparison", "month_comparison"], ["campaign_performance", "campaign_performance"], ["campaign_metrics", "campaign_metrics"], ["flow_performance", "flow_performance"], ["flow_metrics", "flow_metrics"],
  ] as const)("proves %s against its canonical %s target", async (type, sectionKey) => {
    page();
    await expect(prepareBusinessReviewCaptureDocument(BUSINESS_REVIEW_TARGETS[type], period)).resolves.toMatchObject({ ok: true, sourceUrl: window.location.href, targetRect: { width: 400, height: 250 } });
    expect(BUSINESS_REVIEW_TARGETS[type].sectionKey).toBe(sectionKey);
  });

  it("hides only floating page overlays painted over the crop (e.g. an assistant prompt), never the card's own content", async () => {
    page();
    document.body.insertAdjacentHTML("beforeend", `<div id="assistant-root" style="position: fixed"><div id="assistant">Which segments am I over-sending to?</div></div><div id="toast" style="position: fixed">Saved</div>`);
    const assistant = document.getElementById("assistant")!; const card = document.getElementById("campaign")!;
    // What is on top at each point: the assistant prompt over the card's lower-right corner, the card elsewhere.
    Object.defineProperty(document, "elementFromPoint", { configurable: true, value: (x: number, y: number) => x > 300 && y > 230 && assistant.closest<HTMLElement>("#assistant-root")!.style.visibility !== "hidden" ? assistant : card.querySelector("#campaign-panel") });
    try {
      const result = await prepareBusinessReviewCaptureDocument(BUSINESS_REVIEW_TARGETS.campaign_metrics, period);
      expect(result).toMatchObject({ ok: true, targetRect: { hiddenOverlayCount: 1 } });
      expect(document.getElementById("assistant-root")!.style.visibility).toBe("hidden");
      expect(document.getElementById("toast")!.style.visibility).toBe("");
      expect(card.querySelector<HTMLElement>("#campaign-panel")!.style.visibility).toBe("");
    } finally { delete (document as { elementFromPoint?: unknown }).elementFromPoint; }
  });

  // Regression (Club Furniture Sep 2026, captured 2026-11-03): Klaviyo's AI prompt pill covered the bottom of the Flow
  // Performance chart (x-axis dates, $0 baseline). Sampled every ~40 px, the hit-test grid fell above and below the
  // 30 px pill, so it was never hidden. The geometric pass finds it wherever it is.
  it.each(["flow_performance", "campaign_performance", "month_comparison"] as const)("%s hides an AI prompt pill that sits between sparse hit-test rows, so the chart bottom stays visible", async (type) => {
    page();
    document.body.insertAdjacentHTML("beforeend", `<div id="composer-root" style="position: fixed"><div id="composer">Which campaigns drove the most unsubscribes?</div></div>`);
    const composer = document.getElementById("composer-root")!;
    const card = document.getElementById(type === "month_comparison" ? "growth" : type === "flow_performance" ? "flow" : "campaign")!;
    const original = HTMLElement.prototype.getBoundingClientRect;
    // The card is 10..410 × 20..270; the pill covers 230..260, between the old grid rows at y≈226 and y≈266.
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) { return this.closest("#composer-root") ? (composer.style.visibility === "hidden" ? rect(0, 0, 0, 0) : rect(200, 230, 300, 30)) : original.call(this); });
    Object.defineProperty(document, "elementFromPoint", { configurable: true, value: (x: number, y: number) => composer.style.visibility !== "hidden" && x >= 200 && x <= 500 && y >= 230 && y <= 260 ? composer.firstElementChild : card.querySelector("svg") ?? card });
    try {
      const result = await prepareBusinessReviewCaptureDocument(BUSINESS_REVIEW_TARGETS[type], period);
      expect(result.ok ? "ok" : `${result.code}: ${result.message}`).toBe("ok");
      expect(result).toMatchObject({ targetRect: { hiddenOverlayCount: 1, height: 250 } });
      expect(composer.style.visibility).toBe("hidden");
    } finally { delete (document as { elementFromPoint?: unknown }).elementFromPoint; }
  });

  // Regression (run 08be2f58, 2026-11-04): 1648×1188 viewport, a sticky "Dashboards / Business review" header plus a
  // feedback banner, and the dashboard scrolling inside its own container. Cards above finished loading after the
  // one-off scroll and pushed the target below the fold; the stability loop only waited, so all five attempts failed
  // TARGET_NOT_VISIBLE. The card must be moved back into the visible area by scrolling the real container.
  it.each([["campaign_performance", "campaign"], ["flow_performance", "flow"]] as const)("%s re-positions a card that relayout pushed below the fold of an internal scroll container", async (type, kind) => {
    page();
    const main = document.querySelector("main")!;
    const scroller = document.createElement("div"); scroller.id = "scroller"; scroller.style.overflowY = "auto";
    main.replaceWith(scroller); scroller.append(main);
    const header = document.createElement("header"); header.id = "page-header"; header.textContent = "Your total revenue increased! Dashboards / Business review";
    scroller.before(header);
    const headerBottom = 150; let scrollTop = 0; const cardTop = 900; const cardHeight = 460;
    Object.defineProperty(scroller, "scrollTop", { configurable: true, get: () => scrollTop, set: (value: number) => { scrollTop = Math.max(0, Math.min(value, 3_000)); } });
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      if (this.id === "scroller") return rect(0, headerBottom, window.innerWidth, window.innerHeight - headerBottom);
      if (this.id === "page-header") return rect(0, 0, window.innerWidth, headerBottom);
      const section = this.closest("section");
      if (section?.id === kind) {
        const row = this.closest("tbody tr");
        if (row) return rect(20, cardTop - scrollTop + 100 + Array.from(row.parentElement!.children).indexOf(row) * 30, 880, 30);
        return rect(10, cardTop - scrollTop, 900, cardHeight);
      }
      return section ? rect(10, 3_000, 900, 300) : rect(0, 0, 8, 8);
    });
    vi.spyOn(SVGElement.prototype, "getBoundingClientRect").mockImplementation(function (this: SVGElement) { return this.closest("section")?.id === kind ? rect(20, cardTop - scrollTop + 60, 200, 120) : rect(0, 0, 0, 0); });
    const result = await prepareBusinessReviewCaptureDocument(BUSINESS_REVIEW_TARGETS[type], period);
    expect(result.ok ? "ok" : `${result.code}: ${result.message} ${JSON.stringify((result as { diagnostics?: Record<string, unknown> }).diagnostics?.positioning)}`).toBe("ok");
    if (!result.ok) return;
    // Wholly inside the container's visible area, below the sticky header, never at a fixed coordinate.
    expect(scrollTop).toBeGreaterThan(0);
    expect(result.targetRect.y).toBeGreaterThanOrEqual(headerBottom);
    expect(result.targetRect.y + result.targetRect.height).toBeLessThanOrEqual(window.innerHeight);
  }, 20_000);

  it("records the scroller and geometry when a card taller than the visible area cannot be shown whole", async () => {
    page();
    const main = document.querySelector("main")!;
    const scroller = document.createElement("div"); scroller.id = "scroller"; scroller.style.overflowY = "auto";
    main.replaceWith(scroller); scroller.append(main);
    let scrollTop = 0;
    Object.defineProperty(scroller, "scrollTop", { configurable: true, get: () => scrollTop, set: (value: number) => { scrollTop = Math.max(0, Math.min(value, 3_000)); } });
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      if (this.id === "scroller") return rect(0, 150, window.innerWidth, window.innerHeight - 150);
      const section = this.closest("section");
      if (section?.id === "campaign") return rect(10, 900 - scrollTop, 900, window.innerHeight);
      return section ? rect(10, 3_000, 900, 300) : rect(0, 0, 8, 8);
    });
    vi.spyOn(SVGElement.prototype, "getBoundingClientRect").mockImplementation(function (this: SVGElement) { return this.closest("section")?.id === "campaign" ? rect(20, 960 - scrollTop, 200, 120) : rect(0, 0, 0, 0); });
    const result = await prepareBusinessReviewCaptureDocument(BUSINESS_REVIEW_TARGETS.campaign_performance, period);
    expect(result).toMatchObject({ ok: false, code: "TARGET_NOT_VISIBLE", diagnostics: { positioning: expect.arrayContaining([expect.objectContaining({ scroller: "div#scroller", fits: false, visibleArea: { top: 150, bottom: window.innerHeight } })]) } });
  }, 20_000);

  it("does not capture Month Comparison while its metrics are rendered but the Campaigns/Flows chart is still empty", async () => {
    page("Jul 1, 2026 – Jul 31, 2026 compared to previous period Jun 1, 2026 – Jun 30, 2026");
    let chartPlottedAt = Number.POSITIVE_INFINITY;
    const breakdown = Array.from(document.querySelectorAll("#growth [role=tab]")).find((tab) => tab.textContent === "Message type breakdown")!;
    breakdown.addEventListener("click", () => {
      const figure = document.querySelector("#growth-panel figure")!; figure.innerHTML = EMPTY_CHART;
      window.setTimeout(() => { figure.innerHTML = CHART; chartPlottedAt = Date.now(); }, 2_500);
    });
    const result = await prepareBusinessReviewCaptureDocument(BUSINESS_REVIEW_TARGETS.month_comparison, period);
    expect(result).toMatchObject({ ok: true });
    expect(Date.now()).toBeGreaterThanOrEqual(chartPlottedAt + 1_000); // three agreeing reads after the chart plotted
  }, 15_000);

  it("fails Month Comparison with a typed transient error when the chart never plots", async () => {
    page("Jul 1, 2026 – Jul 31, 2026 compared to previous period Jun 1, 2026 – Jun 30, 2026");
    const breakdown = Array.from(document.querySelectorAll("#growth [role=tab]")).find((tab) => tab.textContent === "Message type breakdown")!;
    breakdown.addEventListener("click", () => { document.querySelector("#growth-panel figure")!.innerHTML = EMPTY_CHART; });
    await expect(prepareBusinessReviewCaptureDocument(BUSINESS_REVIEW_TARGETS.month_comparison, period, 6_000, 1_000, 100)).resolves.toMatchObject({ ok: false, code: "BUSINESS_REVIEW_CHART_NOT_RENDERED" });
  });

  it.each(["campaign_performance", "flow_performance"] as const)("waits for the %s chart that renders after its summary metrics", async (type) => {
    page();
    const chart = document.querySelector(`#${type === "campaign_performance" ? "campaign" : "flow"}-panel #overview-chart`)!;
    chart.innerHTML = EMPTY_CHART;
    let chartPlottedAt = Number.POSITIVE_INFINITY;
    window.setTimeout(() => { chart.innerHTML = CHART; chartPlottedAt = Date.now(); }, 3_000);
    await expect(prepareBusinessReviewCaptureDocument(BUSINESS_REVIEW_TARGETS[type], period)).resolves.toMatchObject({ ok: true });
    expect(Date.now()).toBeGreaterThanOrEqual(chartPlottedAt + 1_000);
  }, 15_000);

  it("re-queries the live card when React replaces it on a view switch and never captures the stale Metrics panel as Overview", async () => {
    page();
    // The card opens on Metrics; choosing Overview replaces the whole card, first still holding stale Metrics content.
    const metricsCard = document.getElementById("campaign")!;
    metricsCard.querySelector("#campaign-panel")!.innerHTML = METRICS;
    metricsCard.querySelectorAll("[role=tab]").forEach((tab) => tab.setAttribute("aria-selected", tab.textContent === "Metrics" ? "true" : "false"));
    metricsCard.querySelector("[role=tab]")!.addEventListener("click", () => {
      const replacement = metricsCard.cloneNode(true) as HTMLElement; replacement.id = "campaign-overview";
      replacement.querySelector("#campaign-panel")!.innerHTML = METRICS;
      replacement.querySelectorAll("[role=tab]").forEach((tab) => tab.setAttribute("aria-selected", tab.textContent === "Overview" ? "true" : "false"));
      metricsCard.replaceWith(replacement);
      window.setTimeout(() => { replacement.querySelector("#campaign-panel")!.innerHTML = OVERVIEW("$55,899.41", "357,495"); overviewRenderedAt = Date.now(); }, 1_500);
    });
    let overviewRenderedAt = Number.POSITIVE_INFINITY;
    const result = await prepareBusinessReviewCaptureDocument(BUSINESS_REVIEW_TARGETS.campaign_performance, period);
    expect(result).toMatchObject({ ok: true });
    expect(Date.now()).toBeGreaterThanOrEqual(overviewRenderedAt + 1_000);
    expect(metricsCard.isConnected).toBe(false);
    expect(document.getElementById("campaign-overview")!.textContent).toContain("Conversion Value");
    expect(document.getElementById("campaign-overview")!.textContent).not.toContain("Open Rate");
  }, 15_000);

  describe("view tabs are card-local, never Klaviyo's global Analytics navigation (run c890faec)", () => {
    const DASHBOARD = "/analytics/dashboards/01H2XYS7EKZT3VVQYBQ19GTVW1";
    const clicks: string[] = [];
    /**
     * Live-like layout: the sidebar (Analytics → Overview / Metrics) and the dashboard share one app container with no
     * <main> boundary, both cards sit in one grid, and the card under test mounts its tabs only after a fresh load.
     */
    function dashboardWithSidebar(lateCard: "campaign" | "flow", startView: "Overview" | "Metrics" = "Overview"): void {
      clicks.length = 0;
      window.history.replaceState({}, "", DASHBOARD);
      const card = (kind: "campaign" | "flow") => `<div id="${kind}-card"><h2>${kind === "campaign" ? "Campaign Performance Summary" : "Flow Performance Summary"}</h2><div class="tabs" id="${kind}-tabs"></div><div class="panel">${startView === "Metrics" ? METRICS : OVERVIEW("$1.00", "10")}</div></div>`;
      document.body.innerHTML = `<div id="app"><nav id="sidebar"><div>Analytics</div><a href="/analytics/overview" id="global-overview">Overview</a><a href="/analytics/metrics" id="global-metrics">Metrics</a></nav>
        <div id="content"><nav aria-label="Breadcrumb">Dashboards / Business Review</nav><button aria-label="Time period">Jul 1, 2026 – Jul 31, 2026 compared to previous period Jun 1, 2026 – Jun 30, 2026</button>
        <div id="grid">${card("campaign")}${card("flow")}</div></div></div>`;
      for (const link of Array.from(document.querySelectorAll("#sidebar a"))) link.addEventListener("click", (event) => { event.preventDefault(); clicks.push(`global:${link.textContent}`); window.history.pushState({}, "", link.getAttribute("href")!); });
      const mountTabs = (kind: "campaign" | "flow") => {
        const tabs = document.getElementById(`${kind}-tabs`)!;
        tabs.innerHTML = ["Overview", "Metrics", "Top performing"].map((label) => `<button role="tab" aria-selected="${label === startView}">${label}</button>`).join("");
        for (const tab of Array.from(tabs.children)) tab.addEventListener("click", () => {
          clicks.push(`${kind}:${tab.textContent}`);
          Array.from(tabs.children).forEach((item) => item.setAttribute("aria-selected", item === tab ? "true" : "false"));
          document.querySelector(`#${kind}-card .panel`)!.innerHTML = tab.textContent === "Metrics" ? METRICS : tab.textContent === "Overview" ? OVERVIEW("$1.00", "10") : "";
        });
      };
      mountTabs(lateCard === "campaign" ? "flow" : "campaign");
      window.setTimeout(() => mountTabs(lateCard), 800);
      if (!("scrollIntoView" in HTMLElement.prototype)) Object.defineProperty(HTMLElement.prototype, "scrollIntoView", { configurable: true, value: () => undefined });
      vi.spyOn(HTMLElement.prototype, "scrollIntoView").mockImplementation(() => undefined);
      vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(() => rect());
      vi.spyOn(SVGElement.prototype, "getBoundingClientRect").mockImplementation(() => rect(20, 40, 200, 120));
    }

    it.each([["campaign_metrics", "campaign"], ["flow_metrics", "flow"]] as const)("%s clicks only its own card's Metrics tab and stays on the Business Review URL", async (type, kind) => {
      dashboardWithSidebar(kind);
      const result = await prepareBusinessReviewCaptureDocument(BUSINESS_REVIEW_TARGETS[type], period);
      expect(result).toMatchObject({ ok: true });
      expect(clicks).toEqual([`${kind}:Metrics`]);
      expect(window.location.pathname).toBe(DASHBOARD);
      expect(document.querySelector(`#${kind}-card .panel`)!.textContent).toContain("Open Rate");
    });

    it.each([["campaign_performance", "campaign"], ["flow_performance", "flow"]] as const)("%s returns to its own card's Overview, never the global Analytics Overview", async (type, kind) => {
      dashboardWithSidebar(kind, "Metrics");
      const result = await prepareBusinessReviewCaptureDocument(BUSINESS_REVIEW_TARGETS[type], period);
      expect(result).toMatchObject({ ok: true });
      expect(clicks).toEqual([`${kind}:Overview`]);
      expect(window.location.pathname).toBe(DASHBOARD);
    });

    it("fails with BUSINESS_REVIEW_UNEXPECTED_NAVIGATION and captures nothing when a click leaves the dashboard", async () => {
      dashboardWithSidebar("campaign");
      // An accidental route change during the view switch (as when the global Metrics link was clicked live).
      window.setTimeout(() => document.querySelector("#campaign-tabs button:nth-child(2)")!.addEventListener("click", () => window.history.pushState({}, "", "/analytics/metrics")), 800);
      const result = await prepareBusinessReviewCaptureDocument(BUSINESS_REVIEW_TARGETS.campaign_metrics, period);
      expect(result).toMatchObject({ ok: false, code: "BUSINESS_REVIEW_UNEXPECTED_NAVIGATION" });
      expect(window.location.pathname).toBe("/analytics/metrics");
    });
  });

  describe("Metrics capture waits until the final row is clear of Klaviyo's floating Composer bar", () => {
    const TEN_METRICS = `<table><thead><tr><th>Metric</th><th>Email</th></tr></thead><tbody>${["Total Recipients", "Unique Opens", "Open Rate", "Unique Clicks", "Click Rate", "Unique Conversions", "Conversion Rate", "Conversion Value", "Revenue Per Recipient", "Average Order Value"].map((metric) => `<tr><td>${metric}</td><td>1</td></tr>`).join("")}</tbody></table>`;
    /**
     * The card scrolls inside an overflow container; a fixed Composer bar covers the viewport's bottom (top at 690 px).
     * Unscrolled, the card starts at `cardTop` and its 10th row ends at cardTop + 400, under the bar.
     */
    /**
     * `scrollerTop` models Klaviyo's live layout: a page header ("Dashboards / Business review") that does not scroll,
     * with the dashboard's scroll container starting below it. `initialScroll` starts the container already scrolled.
     */
    function metricsUnderComposer(kind: "campaign" | "flow", cardTop: number, options: { reasserts?: boolean; contentsRows?: boolean; scrollerTop?: number; initialScroll?: number } = {}) {
      page();
      const main = document.querySelector("main")!;
      const scroller = document.createElement("div"); scroller.id = "scroller"; scroller.style.overflowY = "auto";
      main.replaceWith(scroller); scroller.append(main);
      const header = document.createElement("header"); header.id = "page-header"; header.textContent = "Dashboards / Business review";
      scroller.before(header);
      const scrollerTop = options.scrollerTop ?? 0;
      let scrollTop = options.initialScroll ?? 0;
      Object.defineProperty(scroller, "scrollTop", { configurable: true, get: () => scrollTop, set: (value: number) => { scrollTop = Math.max(0, Math.min(value, 400)); } });
      document.body.insertAdjacentHTML("beforeend", `<div id="composer-root" style="position: fixed"><div id="composer">Which segments am I over-sending to?</div></div>`);
      const composer = document.getElementById("composer-root")!;
      if (options.reasserts) new MutationObserver(() => { if (composer.style.visibility === "hidden") composer.style.visibility = ""; }).observe(composer, { attributes: true });
      document.querySelector(`#${kind} [role=tab]:nth-child(2)`)!.addEventListener("click", () => { document.querySelector(`#${kind}-panel`)!.innerHTML = TEN_METRICS; });
      const cardY = () => cardTop - scrollTop;
      vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
        if (this.closest("#composer-root")) return rect(400, 690, 400, 48);
        if (this.id === "scroller") return rect(0, scrollerTop, window.innerWidth, window.innerHeight - scrollerTop);
        if (this.id === "page-header") return rect(0, 0, window.innerWidth, scrollerTop);
        const section = this.closest("section");
        if (section?.id === kind) {
          const row = this.closest("tbody tr");
          // Live Klaviyo rows are `display: contents`: the <tr> has no box, only its cells do (run 4ab3c8e7).
          if (row && options.contentsRows && this === row) return rect(0, 0, 0, 0);
          if (row) return rect(20, cardY() + 100 + Array.from(row.parentElement!.children).indexOf(row) * 30, 880, 30);
          return rect(10, cardY(), 900, 460);
        }
        return section ? rect(10, 1_200, 900, 300) : rect(0, 0, 8, 8);
      });
      return { scrolled: () => scrollTop, composer, header };
    }

    // Regression (Club Furniture Sep 2026, captured 2026-11-03): scrolling the last row clear of the Composer pushed the
    // card title above the dashboard's scroll container, and the crop showed the page header in its place, so the
    // Campaign and Flow Metrics screenshots could not be told apart.
    it.each([["campaign_metrics", "campaign", "Campaign Performance Summary"], ["flow_metrics", "flow", "Flow Performance Summary"]] as const)("%s never scrolls its title under a non-scrolling page header; it hides the Composer instead", async (type, kind, title) => {
      const live = metricsUnderComposer(kind, 300, { scrollerTop: 290 });
      const result = await prepareBusinessReviewCaptureDocument(BUSINESS_REVIEW_TARGETS[type], period);
      expect(result.ok ? "ok" : `${result.code}: ${result.message}`).toBe("ok");
      if (!result.ok) return;
      // Scrolling the 18 px the row needed would have put the card top at 282, under the header ending at 290.
      expect(live.scrolled()).toBe(0);
      expect(result.targetRect.y).toBeGreaterThanOrEqual(290);
      expect(result.targetRect.cardTitle).toBe(title);
      expect(result.targetRect.lastRowProof).toMatchObject({ lastMetric: "average order value", visible: true, hiddenOverlays: 1, visibleTop: 290 });
      expect(live.composer.style.visibility).toBe("hidden");
      expect(live.header.style.visibility).toBe("");
    });

    it.each([["campaign_metrics", "campaign"], ["flow_metrics", "flow"]] as const)("%s scrolls a card already partly under the page header back down until its title shows", async (type, kind) => {
      const live = metricsUnderComposer(kind, 300, { scrollerTop: 290, initialScroll: 30 });
      const result = await prepareBusinessReviewCaptureDocument(BUSINESS_REVIEW_TARGETS[type], period);
      expect(result.ok ? "ok" : `${result.code}: ${result.message}`).toBe("ok");
      if (!result.ok) return;
      // The card started at 270 (20 px under the header); it is scrolled back to start inside the visible area.
      expect(live.scrolled()).toBeLessThan(30);
      expect(result.targetRect.y).toBeGreaterThanOrEqual(290);
      expect(result.targetRect.y + result.targetRect.height).toBeGreaterThanOrEqual(Number(result.targetRect.lastRowProof!.lastRowBottom));
    });

    it.each([["campaign_metrics", "campaign"], ["flow_metrics", "flow"]] as const)("%s refuses a crop whose title is painted over by page chrome outside the card", async (type, kind) => {
      const live = metricsUnderComposer(kind, 300);
      const card = document.getElementById(kind)!;
      // The header paints over the top 24 px of the card, which is where its title is.
      Object.defineProperty(document, "elementFromPoint", { configurable: true, value: (_x: number, y: number) => y < 324 ? live.header : card.querySelector("table") });
      try {
        await expect(prepareBusinessReviewCaptureDocument(BUSINESS_REVIEW_TARGETS[type], period)).resolves.toMatchObject({ ok: false, code: "BUSINESS_REVIEW_TARGET_OCCLUDED", message: expect.stringContaining("title is not visible") });
      } finally { delete (document as { elementFromPoint?: unknown }).elementFromPoint; }
    });

    it.each([["campaign_metrics", "campaign"], ["flow_metrics", "flow"]] as const)("%s scrolls the obstructed Average Order Value row above the bar, then crops above it", async (type, kind) => {
      const live = metricsUnderComposer(kind, 300);
      const result = await prepareBusinessReviewCaptureDocument(BUSINESS_REVIEW_TARGETS[type], period);
      expect(result).toMatchObject({ ok: true, targetRect: { lastRowProof: { lastMetric: "average order value", visible: true, overlap: "none", hiddenOverlays: 0 } } });
      if (!result.ok) return;
      expect(live.scrolled()).toBeGreaterThanOrEqual(18);
      const proof = result.targetRect.lastRowProof!;
      expect(Number(proof.lastRowBottom)).toBeLessThanOrEqual(690);
      // The crop holds the heading, tabs, and the whole table through Average Order Value, and stops above the bar.
      expect(result.targetRect.y).toBe(300 - live.scrolled());
      expect(result.targetRect.y + result.targetRect.height).toBeGreaterThanOrEqual(Number(proof.lastRowBottom));
      expect(result.targetRect.y + result.targetRect.height).toBeLessThanOrEqual(690);
      expect(live.composer.style.visibility).toBe("");
    });

    it.each([["campaign_metrics", "campaign"], ["flow_metrics", "flow"]] as const)("%s reads the final row from its cells when Klaviyo's rows have no box of their own", async (type, kind) => {
      metricsUnderComposer(kind, 300, { contentsRows: true });
      const result = await prepareBusinessReviewCaptureDocument(BUSINESS_REVIEW_TARGETS[type], period);
      expect(result.ok ? "ok" : `${result.code}: ${result.message}`).toBe("ok");
      expect(result).toMatchObject({ targetRect: { lastRowProof: { lastMetric: "average order value", visible: true, overlap: "none" } } });
    });

    it.each([["campaign_metrics", "campaign"], ["flow_metrics", "flow"]] as const)("%s hides the bar as temporary UI when scrolling cannot clear the row without losing the heading", async (type, kind) => {
      const live = metricsUnderComposer(kind, 0);
      // The card is already at the top of the viewport (its last row ends at 400 px); the bar sits at 380 px over it.
      const original = HTMLElement.prototype.getBoundingClientRect;
      vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) { return this.closest("#composer-root") ? rect(400, 380, 400, 48) : original.call(this); });
      const result = await prepareBusinessReviewCaptureDocument(BUSINESS_REVIEW_TARGETS[type], period);
      expect(result).toMatchObject({ ok: true, targetRect: { lastRowProof: { visible: true, overlap: "none", hiddenOverlays: 1 } } });
      expect(live.scrolled()).toBe(0);
      expect(live.composer.style.visibility).toBe("hidden");
    });

    it.each([["campaign_metrics", "campaign"], ["flow_metrics", "flow"]] as const)("%s never accepts an Average Order Value row that stays covered", async (type, kind) => {
      metricsUnderComposer(kind, 0, { reasserts: true });
      const original = HTMLElement.prototype.getBoundingClientRect;
      vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) { return this.closest("#composer-root") ? rect(400, 380, 400, 48) : original.call(this); });
      await expect(prepareBusinessReviewCaptureDocument(BUSINESS_REVIEW_TARGETS[type], period)).resolves.toMatchObject({ ok: false, code: "BUSINESS_REVIEW_TARGET_OCCLUDED" });
    });
  });

  describe("Metrics view verification re-queries the live card and accepts an already-selected view", () => {
    it.each([["campaign_metrics", "campaign"], ["flow_metrics", "flow"]] as const)("%s accepts Metrics that is already selected with its table rendered, without clicking", async (type, kind) => {
      page();
      const card = document.getElementById(kind)!;
      card.querySelectorAll("[role=tab]").forEach((tab) => tab.setAttribute("aria-selected", tab.textContent === "Metrics" ? "true" : "false"));
      card.querySelector(`#${kind}-panel`)!.innerHTML = METRICS;
      const clicks = vi.fn(); card.querySelectorAll("[role=tab]").forEach((tab) => tab.addEventListener("click", clicks));
      await expect(prepareBusinessReviewCaptureDocument(BUSINESS_REVIEW_TARGETS[type], period)).resolves.toMatchObject({ ok: true });
      expect(clicks).not.toHaveBeenCalled();
    });

    it.each([["campaign_metrics", "campaign"], ["flow_metrics", "flow"]] as const)("%s re-queries the card React replaces after the Metrics click and proves the late Metrics table", async (type, kind) => {
      page();
      const original = document.getElementById(kind)!;
      const staleMetricsTab = original.querySelector("[role=tab]:nth-child(2)")!;
      staleMetricsTab.addEventListener("click", () => {
        const replacement = original.cloneNode(true) as HTMLElement; replacement.id = `${kind}-replaced`;
        replacement.querySelectorAll("[role=tab]").forEach((tab) => tab.setAttribute("aria-selected", tab.textContent === "Metrics" ? "true" : "false"));
        replacement.querySelector(`#${kind}-panel`)!.innerHTML = "";
        original.replaceWith(replacement);
        window.setTimeout(() => { replacement.querySelector(`#${kind}-panel`)!.innerHTML = METRICS; }, 1_200);
      });
      await expect(prepareBusinessReviewCaptureDocument(BUSINESS_REVIEW_TARGETS[type], period)).resolves.toMatchObject({ ok: true });
      expect(original.isConnected).toBe(false);
      expect(staleMetricsTab.isConnected).toBe(false);
      expect(document.getElementById(`${kind}-replaced`)!.textContent).toContain("Revenue Per Recipient");
    });
  });

  describe("the injected adapter always returns plain JSON, never an exception Chrome turns into null", () => {
    const asChromeInjects = () => new Function("target", "expected", "dialog", "ready", `return (${prepareBusinessReviewCaptureDocument.toString()})(target, expected, dialog, ready);`) as typeof prepareBusinessReviewCaptureDocument;

    it("turns an exception whose diagnostics also crash into a typed, serializable failure (the escape path that returned null)", async () => {
      page();
      // A null target makes both the adapter and its diagnostics builder throw — exactly the double failure that escaped before.
      const result = await asChromeInjects()(null as never, period);
      expect(result).toMatchObject({ ok: false, code: "KLAVIYO_PAGE_ADAPTER_ERROR", message: expect.stringContaining("Cannot read properties of null"), diagnostics: { snapshotError: expect.stringContaining("Cannot read properties of null") } });
      expect(JSON.parse(JSON.stringify(result))).toEqual(result);
    });

    it("keeps the real failure code when building its diagnostics crashes (run 8fdc5fcc returned null)", async () => {
      page(); document.getElementById("growth")!.remove();
      vi.spyOn(HTMLElement.prototype, "cloneNode").mockImplementation(() => { throw new Error("clone failed on this page"); });
      const result = await asChromeInjects()(BUSINESS_REVIEW_TARGETS.month_comparison, period, 50, 300);
      expect(result).toMatchObject({ ok: false, code: "BUSINESS_REVIEW_CARD_NOT_FOUND", diagnostics: { snapshotError: "clone failed on this page" } });
      expect(JSON.parse(JSON.stringify(result))).toEqual(result);
    });
  });

  it("does not hang when the tab runs no animation frames (a hidden or background tab)", async () => {
    page();
    const original = window.requestAnimationFrame;
    window.requestAnimationFrame = (() => 0) as typeof window.requestAnimationFrame;
    try {
      await expect(prepareBusinessReviewCaptureDocument(BUSINESS_REVIEW_TARGETS.campaign_metrics, period)).resolves.toMatchObject({ ok: true });
    } finally { window.requestAnimationFrame = original; }
  }, 20_000);

  it("waits for its own target card's spinner even when another Business Review card is already ready", async () => {
    page();
    // Growth overview is fully rendered; Campaign Performance Summary is still loading.
    document.getElementById("campaign")!.insertAdjacentHTML("beforeend", `<div id="campaign-spinner" role="progressbar" aria-busy="true"></div>`);
    let spinnerRemovedAt = Number.POSITIVE_INFINITY;
    window.setTimeout(() => { document.getElementById("campaign-spinner")!.remove(); spinnerRemovedAt = Date.now(); }, 2_500);
    await expect(prepareBusinessReviewCaptureDocument(BUSINESS_REVIEW_TARGETS.campaign_performance, period)).resolves.toMatchObject({ ok: true });
    expect(Date.now()).toBeGreaterThanOrEqual(spinnerRemovedAt);
  }, 15_000);

  it("fails closed when Growth overview offers no Message type breakdown view", async () => {
    page();
    document.querySelector("#growth")!.innerHTML = `<h2>Growth Overview</h2><button role="tab" aria-selected="true">Conversion summary</button>${CONVERSION_SUMMARY}`;
    await expect(prepareBusinessReviewCaptureDocument(BUSINESS_REVIEW_TARGETS.month_comparison, period, 6_000, 300)).resolves.toMatchObject({ ok: false, code: "BUSINESS_REVIEW_TAB_NOT_FOUND" });
  });

  describe("Month Comparison uses Growth overview → Message type breakdown", () => {
    it("targets the Growth overview card and its Message type breakdown view under the new source identity", () => {
      expect(BUSINESS_REVIEW_TARGETS.month_comparison).toMatchObject({ cardAliases: ["Growth overview"], tabAliases: ["Message type breakdown"], requiresComparisonProof: true, sourceIdentity: "business-review|growth-overview|message-type-breakdown|previous-period" });
    });

    it("switches from the default Conversion summary to Message type breakdown before capturing", async () => {
      page();
      const tabs = Array.from(document.querySelectorAll("#growth [role=tab]"));
      expect(tabs.find((tab) => tab.getAttribute("aria-selected") === "true")?.textContent).toBe("Conversion summary");
      await expect(prepareBusinessReviewCaptureDocument(BUSINESS_REVIEW_TARGETS.month_comparison, period)).resolves.toMatchObject({ ok: true });
      expect(tabs.find((tab) => tab.getAttribute("aria-selected") === "true")?.textContent).toBe("Message type breakdown");
      expect(document.querySelector("#growth-panel")!.textContent).toContain("Campaigns $12.00");
      expect(document.querySelector("#growth-panel")!.textContent).toContain("Flows $8.00");
    });

    it("rejects the Conversion summary panel even when the Message type breakdown tab claims to be selected", async () => {
      page();
      for (const tab of Array.from(document.querySelectorAll("#growth [role=tab]"))) tab.setAttribute("aria-selected", tab.textContent === "Message type breakdown" ? "true" : "false");
      // The panel did not follow the tab: total/unattributed revenue and recipients are Conversion summary content.
      for (const tab of Array.from(document.querySelectorAll("#growth [role=tab]"))) tab.replaceWith(tab.cloneNode(true));
      document.querySelector("#growth-panel")!.innerHTML = `${CONVERSION_SUMMARY}<p>Campaigns</p><p>Flows</p>`;
      await expect(prepareBusinessReviewCaptureDocument(BUSINESS_REVIEW_TARGETS.month_comparison, period, 6_000, 300)).resolves.toMatchObject({ ok: false, code: "BUSINESS_REVIEW_TAB_NOT_SELECTED" });
    });

    it.each([
      [{ startDate: "2026-08-01", endDate: "2026-08-31", previousStartDate: "2026-07-01", previousEndDate: "2026-07-31" }, "Aug 1, 2026 – Aug 31, 2026 compared to previous period Jul 1, 2026 – Jul 31, 2026"],
      [{ startDate: "2026-09-01", endDate: "2026-09-30", previousStartDate: "2026-08-01", previousEndDate: "2026-08-31" }, "Sep 1, 2026 – Sep 30, 2026 compared to previous period Aug 1, 2026 – Aug 31, 2026"],
      [{ startDate: "2027-01-01", endDate: "2027-01-31", previousStartDate: "2026-12-01", previousEndDate: "2026-12-31" }, "Jan 1, 2027 – Jan 31, 2027 compared to previous period Dec 1, 2026 – Dec 31, 2026"],
    ])("proves the exact current month against the previous calendar month (%o)", async (reportPeriod, header) => {
      page(header);
      await expect(prepareBusinessReviewCaptureDocument(BUSINESS_REVIEW_TARGETS.month_comparison, reportPeriod)).resolves.toMatchObject({ ok: true });
    });

    it("rejects a header whose comparison is not the immediately previous calendar month", async () => {
      page("Sep 1, 2026 – Sep 30, 2026 compared to previous period Sep 1, 2025 – Sep 30, 2025");
      await expect(prepareBusinessReviewCaptureDocument(BUSINESS_REVIEW_TARGETS.month_comparison, { startDate: "2026-09-01", endDate: "2026-09-30", previousStartDate: "2026-08-01", previousEndDate: "2026-08-31" }, 50, 300)).resolves.toMatchObject({ ok: false });
    });

    it("waits for the Message type breakdown panel that renders after its tab is already selected", async () => {
      page();
      const growthTab = Array.from(document.querySelectorAll("#growth [role=tab]")).find((tab) => tab.textContent === "Message type breakdown")!;
      // Replace the instant panel swap with Klaviyo's real behavior: the tab selects at once, the data arrives later.
      const delayed = growthTab.cloneNode(true) as HTMLElement; growthTab.replaceWith(delayed);
      delayed.addEventListener("click", () => {
        for (const tab of Array.from(document.querySelectorAll("#growth [role=tab]"))) tab.setAttribute("aria-selected", tab === delayed ? "true" : "false");
        window.setTimeout(() => { document.querySelector("#growth-panel")!.innerHTML = MESSAGE_TYPE_BREAKDOWN; }, 2_500);
      });
      await expect(prepareBusinessReviewCaptureDocument(BUSINESS_REVIEW_TARGETS.month_comparison, period)).resolves.toMatchObject({ ok: true });
      expect(document.querySelector("#growth-panel")!.textContent).toContain("Campaigns $12.00");
    });

    it("keeps the other Business Review targets exactly as before", () => {
      expect(Object.fromEntries(Object.entries(BUSINESS_REVIEW_TARGETS).filter(([type]) => type !== "month_comparison").map(([type, target]) => [type, [target.cardAliases, target.tabAliases, target.sourceIdentity, target.forbiddenCardText ?? null]]))).toEqual({
        top_campaigns: [["Campaign Performance Summary", "Campaign Performance"], ["Top performing messages"], "business-review|campaign-performance|top-performing", null],
        campaign_performance: [["Campaign Performance Summary", "Campaign Performance"], ["Overview"], "business-review|campaign-performance|overview", ["Open Rate", "Click Rate"]],
        campaign_metrics: [["Campaign Performance Summary", "Campaign Performance"], ["Metrics"], "business-review|campaign-performance|metrics", null],
        flow_performance: [["Flow Performance Summary", "Flow Performance"], ["Overview"], "business-review|flow-performance|overview", ["Open Rate", "Click Rate"]],
        flow_metrics: [["Flow Performance Summary", "Flow Performance"], ["Metrics"], "business-review|flow-performance|metrics", null],
      });
    });
  });

  it("waits for the requested Business Review card spinner to clear before resolving its view", async () => {
    page();
    document.querySelector("#campaign")!.innerHTML = `<h2>Campaign Performance Summary</h2><div data-asc="Spinner" aria-label="Loading"></div>`;
    window.setTimeout(() => rankingPage("campaign", 5), 80);
    await expect(prepareBusinessReviewCaptureDocument(BUSINESS_REVIEW_TARGETS.top_campaigns, period)).resolves.toMatchObject({ ok: true, targetRect: { includedRowCount: 3, availableRowCount: 5 } });
  });


  it("bounds Top Campaigns at the third visible row without including row four", async () => {
    rankingPage("campaign", 10);
    const result = await prepareBusinessReviewCaptureDocument(BUSINESS_REVIEW_TARGETS.top_campaigns, period);
    expect(result).toMatchObject({ ok: true, targetRect: { includedRowCount: 3, availableRowCount: 10 } });
    if (!result.ok) return;
    const rows = Array.from(document.querySelectorAll("#campaign tbody tr"));
    const bottom = result.targetRect.y + result.targetRect.height;
    expect(rows[2]!.getBoundingClientRect().bottom).toBe(bottom);
    expect(rows[3]!.getBoundingClientRect().top).toBeGreaterThan(bottom);
    expect(BUSINESS_REVIEW_TARGETS.top_campaigns.tabAliases).toEqual(["Top performing messages"]);
  });

  it("treats the rendered Top Campaigns table as active when no tab control can be found", async () => {
    rankingPage("campaign", 3);
    document.querySelector("#campaign [role=tablist]")!.replaceChildren();
    await expect(prepareBusinessReviewCaptureDocument(BUSINESS_REVIEW_TARGETS.top_campaigns, period)).resolves.toMatchObject({ ok: true, targetRect: { includedRowCount: 3 } });
  });

  it("accepts a rendered plain label without role or button markup when Top Campaigns content is already active", async () => {
    rankingPage("campaign", 3);
    const controls = document.querySelector("#campaign [role=tablist]")!;
    controls.replaceWith(Object.assign(document.createElement("div"), { innerHTML: "<span>Top performing</span><span> messages</span>" }));
    await expect(prepareBusinessReviewCaptureDocument(BUSINESS_REVIEW_TARGETS.top_campaigns, period)).resolves.toMatchObject({ ok: true });
  });

  it.each(["Overview", "Metrics"])("does not treat wrong Campaign %s content as Top Campaigns", async (wrongView) => {
    page();
    const card = document.getElementById("campaign")!;
    card.innerHTML = `<h2>Campaign Performance Summary</h2><div>Top performing messages</div><table><thead><tr><th>${wrongView}</th><th>Summary</th></tr></thead><tbody><tr><td>Not the ranking table</td><td>1</td></tr></tbody></table>`;
    await expect(prepareBusinessReviewCaptureDocument(BUSINESS_REVIEW_TARGETS.top_campaigns, period, 6_000, 300)).resolves.toMatchObject({ ok: false, code: "BUSINESS_REVIEW_TAB_NOT_SELECTED" });
  });

  it("does not use Flow ranking content to prove the Campaign Top Campaigns view", async () => {
    rankingPage("flow", 5);
    await expect(prepareBusinessReviewCaptureDocument(BUSINESS_REVIEW_TARGETS.top_campaigns, period, 6_000, 300)).resolves.toMatchObject({ ok: false });
  });

  it("clicks a card-local plain label, re-queries React replacement, and verifies the new Top Campaigns content", async () => {
    clickToRenderRankingPage(true);
    await expect(prepareBusinessReviewCaptureDocument(BUSINESS_REVIEW_TARGETS.top_campaigns, period)).resolves.toMatchObject({ ok: true, targetRect: { includedRowCount: 3 } });
    expect(document.querySelector("#campaign tbody tr")).not.toBeNull();
  });

  it.each(["campaign"] as const)("uses rendered ranking content after selecting the live-style %s control from Metrics", async (kind) => {
    page();
    const card = document.getElementById(kind)!;
    const isCampaign = kind === "campaign";
    const cardTitle = isCampaign ? "Campaign Performance Summary" : "Flow Performance Summary";
    const targetLabel = isCampaign ? "Top performing messages" : "Top performing";
    const headers = isCampaign
      ? ["Campaign message", "Sent date", "Type", "Total Recipients", "Unique Placed Order", "Conversion Value"]
      : ["Flow", "Status", "Type", "Deliveries", "Placed Order"];
    card.innerHTML = `<h2>${cardTitle}</h2><div>
      <button aria-pressed="false">Overview</button><button aria-pressed="true">Metrics</button>
      <button><span>${isCampaign ? "Top performing" : "Top"}</span><span>${isCampaign ? " messages" : " performing"}</span></button>
    </div>`;
    const rankingButton = card.querySelector("button:last-child")!;
    rankingButton.addEventListener("click", () => {
      const replacement = document.createElement("section"); replacement.id = kind; replacement.setAttribute("role", "region");
      const rows = Array.from({ length: isCampaign ? 3 : 5 }, (_, index) => `<tr>${headers.map((_, column) => `<td>${column === 0 ? `${kind} ${index + 1}` : `value ${index + 1}`}</td>`).join("")}</tr>`).join("");
      replacement.innerHTML = `<h2>${cardTitle}</h2><div><button aria-pressed="false">Overview</button><button aria-pressed="false">Metrics</button><button aria-pressed="true"><span>${isCampaign ? "Top performing" : "Top"}</span><span>${isCampaign ? " messages" : " performing"}</span></button></div><table><thead><tr>${headers.map((header) => `<th>${header}</th>`).join("")}</tr></thead><tbody>${rows}</tbody></table>`;
      card.replaceWith(replacement);
    });
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      if (this.tagName === "TR" && this.parentElement?.tagName === "TBODY") return rect(20, 120 + Array.from(this.parentElement.children).indexOf(this) * 32, 460, 24);
      return this.closest(`#${kind}`) ? rect(10, 20, 500, 600) : rect(0, 0, 8, 8);
    });
    const result = await prepareBusinessReviewCaptureDocument(BUSINESS_REVIEW_TARGETS.top_campaigns, period);
    expect(result).toMatchObject({ ok: true, targetRect: { includedRowCount: isCampaign ? 3 : 5 } });
    expect(document.querySelectorAll(`#${kind} tbody tr`)).toHaveLength(isCampaign ? 3 : 5);
  });

  it("waits conditionally for the Business Review SPA shell, spinner removal, and late card before resolving the first section", async () => {
    page();
    window.history.replaceState({}, "", "/analytics/dashboards/01HWZSHD83RW7CYWQ6EVVQD2BK");
    document.body.innerHTML = `<main><nav>Dashboards / Business Review</nav><button aria-label="Time period">Jul 1, 2026 - Jul 31, 2026 compared to previous period Jun 1, 2026 - Jun 30, 2026</button><div data-asc="Spinner" role="progressbar"></div></main>`;
    window.setTimeout(() => rankingPage("campaign", 5), 60);
    const result = await prepareBusinessReviewCaptureDocument(BUSINESS_REVIEW_TARGETS.top_campaigns, period);
    expect(result).toMatchObject({ ok: true, targetRect: { includedRowCount: 3, stageTimingsMs: { PAGE_READY: expect.any(Number) } } });
    if (result.ok) expect(result.targetRect.stageTimingsMs?.PAGE_READY).toBeGreaterThanOrEqual(50);
  });

  it("fails closed when Top Campaigns content is absent after clicking its plain card-local label", async () => {
    clickToRenderRankingPage(false);
    await expect(prepareBusinessReviewCaptureDocument(BUSINESS_REVIEW_TARGETS.top_campaigns, period, 6_000, 300)).resolves.toMatchObject({ ok: false, code: "BUSINESS_REVIEW_TAB_NOT_SELECTED" });
  });

  it("finds the live Campaign Top performing messages button without role=tab, including nested text", async () => {
    liveStyleRankingPage("campaign", 3);
    const result = await prepareBusinessReviewCaptureDocument(BUSINESS_REVIEW_TARGETS.top_campaigns, period);
    expect(result).toMatchObject({ ok: true, targetRect: { includedRowCount: 3 } });
    expect(document.querySelector("#campaign button:last-child")).toHaveAttribute("aria-pressed", "false");
  });

  it("uses rendered role=cell geometry when Klaviyo ranking rows have no measurable row box", async () => {
    rankingPage("campaign", 5);
    const table = document.querySelector("#campaign table")!;
    table.setAttribute("role", "table");
    for (const cell of Array.from(table.querySelectorAll("td"))) cell.setAttribute("role", "cell");
    vi.spyOn(HTMLElement.prototype, "scrollIntoView").mockImplementation(() => undefined);
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      if (this.tagName === "TR" && this.parentElement?.tagName === "TBODY") return rect(0, 0, 0, 0);
      if (this.matches("td[role=cell]")) {
        const row = this.parentElement!; const rowIndex = Array.from(row.parentElement!.children).indexOf(row);
        const cellIndex = Array.from(row.children).indexOf(this);
        return rect(20 + cellIndex * 65, 120 + rowIndex * 32, 60, 24);
      }
      if (this.closest("#campaign")) return rect(10, 20, 500, 600);
      return rect(0, 0, 8, 8);
    });

    await expect(prepareBusinessReviewCaptureDocument(BUSINESS_REVIEW_TARGETS.top_campaigns, period))
      .resolves.toMatchObject({ ok: true, targetRect: { includedRowCount: 3, availableRowCount: 5, height: 188 } });
  });

  it("waits for Klaviyo's delayed card-local tab, ignores its hidden duplicate, and switches from Metrics", async () => {
    page();
    const card = document.getElementById("campaign")!;
    card.innerHTML = `<h2>Campaign Performance Summary</h2><div role="tablist">
      <button role="tab" aria-selected="false">Overview</button>
      <button role="tab" aria-selected="true">Metrics</button>
      <button role="tab" aria-selected="false" hidden>Top performing messages</button>
    </div>`;
    window.setTimeout(() => {
      const button = document.createElement("button");
      button.setAttribute("role", "tab"); button.setAttribute("aria-selected", "false"); button.setAttribute("tabindex", "-1");
      button.innerHTML = "<span>Top performing</span><span> messages</span>";
      button.addEventListener("click", () => {
        card.querySelectorAll("[role=tab]").forEach((tab) => tab.setAttribute("aria-selected", "false"));
        button.setAttribute("aria-selected", "true");
        button.insertAdjacentHTML("afterend", `<table><thead><tr><th>Campaign message</th><th>Sent date</th><th>Type</th><th>Total recipients</th><th>Unique Placed Order</th><th>Conversion value</th></tr></thead><tbody>
          <tr><td>Campaign one</td><td>Aug 3, 2026</td><td>Email</td><td>1</td><td>1</td><td>$1</td></tr>
          <tr><td>Campaign two</td><td>Aug 4, 2026</td><td>Email</td><td>2</td><td>2</td><td>$2</td></tr>
          <tr><td>Campaign three</td><td>Aug 5, 2026</td><td>Email</td><td>3</td><td>3</td><td>$3</td></tr></tbody></table>`);
      });
      card.querySelector("[role=tablist]")!.append(button);
    }, 350);

    const result = await prepareBusinessReviewCaptureDocument(BUSINESS_REVIEW_TARGETS.top_campaigns, period);
    expect(result).toMatchObject({ ok: true, targetRect: { includedRowCount: 3 } });
    expect(card.querySelector("[role=tab]:nth-child(2)")).toHaveAttribute("aria-selected", "false");
    expect(card.querySelector("[role=tablist] button[tabindex='-1']")).toHaveAttribute("aria-selected", "true");
  });

  it("verifies a rendered ranking table below the fold, then validates visible rows after scrolling the card", async () => {
    liveStylePage();
    const card = document.getElementById("campaign")!;
    let cardScrolled = false;
    const top = card.querySelector("button:last-child")!;
    top.addEventListener("click", () => {
      card.querySelectorAll("button").forEach((button) => button.setAttribute("aria-pressed", button === top ? "true" : "false"));
      card.insertAdjacentHTML("beforeend", `<table><thead><tr><th>Campaign message</th><th>Sent date</th><th>Type</th><th>Total Recipients</th><th>Unique Placed Order</th><th>Conversion Value</th></tr></thead><tbody>
        <tr><td>Campaign one</td><td>Aug 3, 2026</td><td>Email</td><td>1</td><td>1</td><td>$1</td></tr>
        <tr><td>Campaign two</td><td>Aug 4, 2026</td><td>Email</td><td>2</td><td>2</td><td>$2</td></tr>
        <tr><td>Campaign three</td><td>Aug 5, 2026</td><td>Email</td><td>3</td><td>3</td><td>$3</td></tr></tbody></table>`);
    });
    vi.spyOn(HTMLElement.prototype, "scrollIntoView").mockImplementation(function (this: HTMLElement) {
      if (this === card) cardScrolled = true;
    });
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      if (this.tagName === "TR" && this.parentElement?.tagName === "TBODY") {
        const index = Array.from(this.parentElement.children).indexOf(this);
        return rect(20, (cardScrolled ? 120 : 1_200) + index * 32, 460, 24);
      }
      if (this.closest("#campaign")) return rect(10, 20, 500, 600);
      return rect(0, 0, 8, 8);
    });

    await expect(prepareBusinessReviewCaptureDocument(BUSINESS_REVIEW_TARGETS.top_campaigns, period)).resolves.toMatchObject({ ok: true, targetRect: { includedRowCount: 3 } });
    expect(cardScrolled).toBe(true);
  });

  it("resolves a Klaviyo-style plain div card from its semantic heading and card-local tab", async () => {
    page(); vi.restoreAllMocks();
    const replacement = document.createElement("div"); replacement.id = "campaign";
    replacement.innerHTML = `<div><h2>Campaign Performance Summary</h2></div><div role="tablist"><button role="tab" aria-selected="true">Overview</button><button role="tab" aria-selected="false">Metrics</button><button role="tab" aria-selected="false">Top performing messages</button></div><div class="panel">${OVERVIEW("$1.00", "10")}</div>`;
    document.getElementById("campaign")!.replaceWith(replacement);
    for (const tab of Array.from(replacement.querySelectorAll("[role=tab]"))) tab.addEventListener("click", () => { Array.from(replacement.querySelectorAll("[role=tab]")).forEach((item) => item.setAttribute("aria-selected", item === tab ? "true" : "false")); replacement.querySelector(".panel")!.innerHTML = tab.textContent === "Metrics" ? METRICS : ""; });
    vi.spyOn(HTMLElement.prototype, "scrollIntoView").mockImplementation(() => undefined);
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) { return this.closest("#campaign") ? rect(10, 20, 500, 600) : rect(0, 0, 8, 8); });
    await expect(prepareBusinessReviewCaptureDocument(BUSINESS_REVIEW_TARGETS.campaign_metrics, period)).resolves.toMatchObject({ ok: true, targetRect: { width: 500, height: 600 } });
    expect(replacement.querySelector("[role=tab]:nth-child(2)")).toHaveAttribute("aria-selected", "true");
  });

  it.each([
    ["campaign_performance", "#campaign button:first-child"],
    ["campaign_metrics", "#campaign button:nth-child(2)"],
  ] as const)("recognizes Campaign %s controls without native tab markup", async (type, selector) => {
    liveStylePage();
    await expect(prepareBusinessReviewCaptureDocument(BUSINESS_REVIEW_TARGETS[type], period)).resolves.toMatchObject({ ok: true });
    expect(document.querySelector(selector)).toHaveAttribute("aria-pressed", "true");
  });

  it("ignores an unrelated matching control outside the proven Campaign card", async () => {
    liveStylePage();
    document.body.insertAdjacentHTML("beforeend", `<button role="tab" aria-selected="true">Top performing messages</button>`);
    await expect(prepareBusinessReviewCaptureDocument(BUSINESS_REVIEW_TARGETS.campaign_metrics, period)).resolves.toMatchObject({ ok: true });
    expect(document.querySelector("#campaign button:nth-child(2)")).toHaveAttribute("aria-pressed", "true");
  });

  it("selects a semantic tab, re-queries a replaced card, and waits for stable bounds", async () => {
    page();
    const metrics = document.querySelector("#campaign [role=tab]:nth-child(2)")!;
    metrics.addEventListener("click", () => {
      const replacement = document.createElement("section"); replacement.id = "campaign-replaced"; replacement.setAttribute("role", "region");
      replacement.innerHTML = `<h2>Campaign Performance Summary</h2><div><button aria-pressed="false">Overview</button><button aria-pressed="true"><span>Met</span><span>rics</span></button><button aria-pressed="false">Top performing messages</button></div>${METRICS}`;
      document.getElementById("campaign")!.replaceWith(replacement);
    });
    let reads = 0;
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      if (this.closest("section")?.id === "campaign-replaced") { reads += 1; return reads < 2 ? rect(0, -5) : rect(30, 40); }
      return rect();
    });
    await expect(prepareBusinessReviewCaptureDocument(BUSINESS_REVIEW_TARGETS.campaign_metrics, period)).resolves.toMatchObject({ ok: true, targetRect: { x: 30, y: 40 } });
    expect(reads).toBeGreaterThanOrEqual(2);
  });

  it("fails closed for missing card, missing tab, non-selected tab, bad comparison, and unstable visibility", async () => {
    page(); document.getElementById("campaign")!.remove();
    await expect(prepareBusinessReviewCaptureDocument(BUSINESS_REVIEW_TARGETS.campaign_metrics, period, 6_000, 300)).resolves.toMatchObject({ ok: false, code: "BUSINESS_REVIEW_CARD_NOT_FOUND" });
    vi.restoreAllMocks(); page(); document.querySelector("#campaign [role=tab]:nth-child(2)")!.remove();
    await expect(prepareBusinessReviewCaptureDocument(BUSINESS_REVIEW_TARGETS.campaign_metrics, period, 6_000, 300)).resolves.toMatchObject({ ok: false, code: "BUSINESS_REVIEW_TAB_NOT_FOUND" });
    vi.restoreAllMocks(); page();
    document.getElementById("campaign-panel")!.id = "panel-that-never-switches";
    for (const tab of Array.from(document.querySelectorAll("#campaign [role=tab]"))) tab.addEventListener("click", () => tab.setAttribute("aria-selected", "false"));
    await expect(prepareBusinessReviewCaptureDocument(BUSINESS_REVIEW_TARGETS.campaign_metrics, period, 6_000, 300)).resolves.toMatchObject({ ok: false, code: "BUSINESS_REVIEW_TAB_NOT_SELECTED" });
    vi.restoreAllMocks(); page("Jul 1, 2026 – Jul 31, 2026 compared to previous period Jun 2, 2026 – Jun 30, 2026");
    await expect(prepareBusinessReviewCaptureDocument(BUSINESS_REVIEW_TARGETS.month_comparison, period, 6_000, 300)).resolves.toMatchObject({ ok: false, code: "COMPARISON_PERIOD_NOT_CONFIRMED" });
    vi.restoreAllMocks(); page(); vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(() => rect(0, -4));
    await expect(prepareBusinessReviewCaptureDocument(BUSINESS_REVIEW_TARGETS.flow_metrics, period, 6_000, 300)).resolves.toMatchObject({ ok: false, code: "TARGET_NOT_VISIBLE" });
  }, 15_000);

  it("sets the exact report month and its previous-month comparison through the semantic date-control shape and re-finds live cards", async () => {
    page("Jun 1, 2026 – Jun 30, 2026");
    const control = document.querySelector("[aria-label='Time period']")!;
    control.addEventListener("click", () => document.body.append(periodDialog((current, comparison) => {
      control.textContent = `${current[0]} – ${current[1]}${comparison ? ` compared to ${comparison[0]} – ${comparison[1]}` : ""}`;
      document.getElementById("growth")!.replaceWith(Object.assign(document.createElement("section"), { id: "growth-after-apply", innerHTML: "<h2>Growth Overview</h2>" }));
    })));
    await expect(prepareBusinessReviewCaptureDocument(BUSINESS_REVIEW_TARGETS.campaign_performance, period)).resolves.toMatchObject({ ok: true });
    expect(control).toHaveTextContent("Jul 1, 2026 – Jul 31, 2026 compared to Jun 1, 2026 – Jun 30, 2026");
  });

  it.each([
    "Jul 1, 2026 - Jul 31, 2026 compared to Jun 1, 2026 - Jun 30, 2026",
    "Jul 1, 2026 – Jul 31, 2026 compared to previous period Jun 1, 2026 – Jun 30, 2026",
    " Jul 1, 2026\n - Jul 31, 2026  compared to\n Jun 1, 2026 - Jun 30, 2026 ",
    "<span>Jul 1, 2026 - Jul 31, 2026</span><span> compared to</span><span> Jun 1, 2026 - Jun 30, 2026</span>",
  ])("accepts the real sibling range shape for a current-period target: %s", async (range) => {
    siblingRangePage(range);
    const result = await prepareBusinessReviewCaptureDocument(BUSINESS_REVIEW_TARGETS.campaign_metrics, period);
    expect(result).toMatchObject({ ok: true });
  });

  it.each([
    "<span>Aug 1, 2026 - Aug 31, 2026</span><span>compared to</span><span>Jul 1, 2026 - Jul 31, 2026</span>",
    "<span>Aug 1, 2026</span><span> – </span><span>Aug 31, 2026</span><span> compared to </span><span>Jul 1, 2026</span><span> – </span><span>Jul 31, 2026</span>",
    "<span>Aug 1, 2026</span><span>\n - </span><span>Aug 31, 2026</span><span> compared to previous period </span><span>Jul 1, 2026</span><span> — </span><span>Jul 31, 2026</span>",
  ])("proves both exact live comparison ranges across nested sibling fragments: %s", async (range) => {
    page("Aug 1, 2026 - Aug 31, 2026 compared to Jul 1, 2026 - Jul 31, 2026");
    const control = document.querySelector("[aria-label='Time period']")!;
    const region = document.createElement("header"); region.id = "date-region";
    region.innerHTML = `<button aria-label="Time period">Time period</button><p>${range}</p>`;
    control.replaceWith(region);
    await expect(prepareBusinessReviewCaptureDocument(BUSINESS_REVIEW_TARGETS.month_comparison, augustPeriod)).resolves.toMatchObject({ ok: true });
  });

  it.each([
    "Aug 1, 2026 - Aug 31, 2026 compared to Jun 1, 2026 - Jun 30, 2026",
    "Aug 1, 2026 - Aug 31, 2026 compared to previous period",
    "Jul 1, 2026 - Jul 31, 2026 compared to Aug 1, 2026 - Aug 31, 2026",
  ])("rejects a comparison without the exact current-then-previous month ranges: %s", async (range) => {
    page();
    const control = document.querySelector("[aria-label='Time period']")!;
    const region = document.createElement("header"); region.id = "date-region";
    region.innerHTML = `<button aria-label="Time period">Time period</button><p>${range}</p>`;
    control.replaceWith(region);
    await expect(prepareBusinessReviewCaptureDocument(BUSINESS_REVIEW_TARGETS.month_comparison, augustPeriod, 50)).resolves.toMatchObject({ ok: false });
  });

  it("re-finds the live sibling period region after Apply and fails closed for wrong, partial, or absent ranges", async () => {
    siblingRangePage("Jun 1, 2026 - Jun 30, 2026 compared to previous period");
    document.querySelector("[aria-label='Time period']")!.addEventListener("click", () => document.body.append(periodDialog((current, comparison) => {
      const region = document.createElement("header"); region.id = "date-region-after-apply";
      region.innerHTML = `<button aria-label="Time period">Time period</button><p>${current[0]} - ${current[1]} compared to ${comparison ? `${comparison[0]} - ${comparison[1]}` : "previous period"}</p>`;
      document.getElementById("date-region")!.replaceWith(region);
    })));
    await expect(prepareBusinessReviewCaptureDocument(BUSINESS_REVIEW_TARGETS.campaign_metrics, period)).resolves.toMatchObject({ ok: true });
    for (const range of ["Jun 1, 2026 - Jun 30, 2026", "Jul 1, 2026", "No selected period"]) {
      vi.restoreAllMocks(); siblingRangePage(range);
      await expect(prepareBusinessReviewCaptureDocument(BUSINESS_REVIEW_TARGETS.campaign_metrics, period, 1)).resolves.toMatchObject({ ok: false });
    }
  });

  it("returns redacted diagnostics for a failed semantic lookup", async () => {
    page("Jun 1, 2026 – Jun 30, 2026");
    document.querySelector("main")!.insertAdjacentHTML("beforeend", "<p>Contact person@example.com</p>");
    const result = await prepareBusinessReviewCaptureDocument(BUSINESS_REVIEW_TARGETS.top_campaigns, period, 1);
    expect(result).toMatchObject({ ok: false, code: "KLAVIYO_PERIOD_DIALOG_NOT_FOUND", diagnostics: { expectedPeriod: period, expectedSemanticCard: "Campaign Performance Summary", expectedView: "Top performing messages", currentUrl: expect.stringContaining("/analytics/dashboards/") } });
    if (result.ok || !result.diagnostics) throw new Error("Expected redacted failure diagnostics.");
    expect(result.diagnostics.pageHtml).toContain("[redacted-email]");
    expect(result.diagnostics.pageHtml).not.toContain("person@example.com");
    expect(result.diagnostics).toHaveProperty("visibleControls");
    expect(result.diagnostics).toHaveProperty("loading");
    expect(result.diagnostics).toHaveProperty("usableRowCount");
  });
});

function rankingPage(kind: "campaign" | "flow", count: number): void {
  page(); vi.restoreAllMocks();
  const card = document.getElementById(kind)!;
  const topTab = card.querySelector("[role=tab]:last-child")!;
  topTab.textContent = kind === "campaign" ? "Top performing messages" : "Top performing";
  const headers = kind === "campaign"
    ? ["Campaign message", "Sent date", "Type", "Total recipients", "Unique Placed Order", "Conversion value"]
    : ["Flow", "Status", "Type", "Deliveries", "Placed Order"];
  const rows = Array.from({ length: count }, (_, index) => `<tr><td>${kind} ${index + 1}</td><td>${kind === "flow" ? "Live" : "Jul 1, 2026"}</td><td>Email</td><td>${index + 1}</td><td>$${index + 1}</td><td>${index + 1}%</td></tr>`).join("");
  card.insertAdjacentHTML("beforeend", `<table><thead><tr>${headers.map((header) => `<th>${header}</th>`).join("")}</tr></thead><tbody>${rows}</tbody></table>`);
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    if (this.tagName === "TR" && this.parentElement?.tagName === "TBODY") {
      const index = Array.from(this.parentElement.children).indexOf(this);
      return rect(20, 120 + index * 32, 460, 24);
    }
    if (this.closest("section")?.id === kind) return rect(10, 20, 500, 600);
    return rect(0, 0, 8, 8);
  });
}

function liveStylePage(): void {
  page();
  for (const kind of ["campaign", "flow"] as const) {
    const card = document.getElementById(kind)!;
    const labels = kind === "campaign" ? ["Overview", "Metrics", "Top performing messages"] : ["Overview", "Metrics", "Top performing"];
    card.innerHTML = `<h2>${kind === "campaign" ? "Campaign Performance Summary" : "Flow Performance Summary"}</h2><div>${labels.map((label, index) => `<button aria-pressed="${index === 0}">${label === "Top performing messages" ? "<span>Top performing</span><span> messages</span>" : label}</button>`).join("")}</div><div class="panel">${OVERVIEW("$1.00", "10")}</div>`;
    for (const button of Array.from(card.querySelectorAll("button"))) {
      button.addEventListener("click", () => {
        Array.from(card.querySelectorAll("button")).forEach((item) => item.setAttribute("aria-pressed", item === button ? "true" : "false"));
        card.querySelector(".panel")!.innerHTML = /metrics/i.test(button.textContent ?? "") ? METRICS : /overview/i.test(button.textContent ?? "") ? OVERVIEW("$1.00", "10") : "";
      });
    }
  }
}

function liveStyleRankingPage(kind: "campaign" | "flow", count: number): void {
  rankingPage(kind, count);
  const card = document.getElementById(kind)!;
  const labels = kind === "campaign" ? ["Overview", "Metrics", "Top performing messages"] : ["Overview", "Metrics", "Top performing"];
  for (const [index, button] of Array.from(card.querySelectorAll("button")).entries()) {
    button.removeAttribute("role"); button.removeAttribute("aria-selected");
    button.setAttribute("aria-pressed", "false");
    button.innerHTML = labels[index] === "Top performing messages" ? "<span>Top performing</span><span> messages</span>" : labels[index]!;
    button.addEventListener("click", () => Array.from(card.querySelectorAll("button")).forEach((item) => item.setAttribute("aria-pressed", item === button ? "true" : "false")));
  }
}

function clickToRenderRankingPage(renderContent: boolean): void {
  rankingPage("campaign", 3);
  const current = document.getElementById("campaign")!;
  const table = current.querySelector("table")!.cloneNode(true);
  current.querySelector("table")!.remove();
  const label = document.createElement("div"); label.innerHTML = "<span>Top performing</span><span> messages</span>";
  current.querySelector("[role=tablist]")!.replaceWith(label);
  label.addEventListener("click", () => {
    const replacement = document.createElement("section"); replacement.id = "campaign"; replacement.setAttribute("role", "region");
    replacement.innerHTML = "<h2>Campaign Performance Summary</h2><div><span>Top performing</span><span> messages</span></div>";
    if (renderContent) replacement.append(table.cloneNode(true));
    current.replaceWith(replacement);
  });
}

describe("Business Review Time period picker as Klaviyo renders it live", () => {
  const display = (value: string) => value.replace(/ 0(\d),/, " $1,");
  /**
   * Klaviyo's live picker (run fd96462a): Time period select → Custom → Start/End Date fields, then a Comparison period
   * select ("Previous period" | "Custom") whose own Start/End fields stay hidden until Custom. Left on "Previous period",
   * Apply keeps the dashboard's stored comparison (`storedComparison`), exactly as live: Sep 1–30 compared to Jul 1–31.
   */
  function livePickerPage(applyWorks: boolean, options: { storedComparison?: [string, string]; comparisonIgnored?: boolean; initialRange?: string; comparisonDefault?: string; comparisonItems?: string[]; plainOptions?: boolean; selectOnMouseDown?: boolean; sidebar?: boolean } = {}): { committed: () => string[]; comparison: () => string[] } {
    siblingRangePage(options.initialRange ?? "Sep 27, 2026 - Oct 27, 2026 compared to previous period Aug 28, 2026 - Sep 26, 2026");
    // Klaviyo's Analytics sidebar is painted beside the dashboard: "Custom reports" must never be taken for the option.
    if (options.sidebar) { const nav = document.createElement("nav"); nav.innerHTML = `<ul><li>Dashboards</li><li>Metrics</li><li id="custom-reports">Custom reports</li><li>Custom</li></ul>`; document.body.prepend(nav); }
    let committed: string[] = []; let comparison: string[] = [];
    const stored = options.storedComparison ?? ["Jul 01, 2026", "Jul 31, 2026"];
    const picker = document.createElement("div"); picker.setAttribute("role", "dialog"); picker.style.display = "none";
    // Stale hidden fields deliberately hold the expected month: they must never count as proof.
    picker.innerHTML = `<label>Time period</label><button id="tp" aria-haspopup="listbox">Last 30 days</button>
      <div id="range" style="display:none"><span>Date range Aug 01, 2026 - Aug 31, 2026 compared to previous period Jul 01, 2026 - Jul 31, 2026</span><input placeholder="Start Date" value="Aug 01, 2026" /><input placeholder="End Date" value="Aug 31, 2026" /></div>
      <label>Comparison period</label><button id="cp" aria-haspopup="listbox">${options.comparisonDefault ?? "Previous period"}</button>
      <div id="cmp-range" style="display:none"><input placeholder="Start Date" value="Aug 29, 2026" /><input placeholder="End Date" value="Sep 28, 2026" /></div>
      <button id="apply">Apply</button><button>Cancel</button>`;
    document.querySelector("#date-region [aria-label='Time period']")!.after(picker);
    document.querySelector("#date-region [aria-label='Time period']")!.addEventListener("click", () => { picker.style.display = ""; });
    const menu = (button: string, items: string[], onCustom: () => void) => picker.querySelector(button)!.addEventListener("click", () => {
      document.querySelectorAll(`[data-menu-for="${button}"]`).forEach((stale) => stale.remove());
      const list = document.createElement(options.plainOptions ? "div" : "ul"); list.dataset.menuFor = button;
      if (!options.plainOptions) list.setAttribute("role", "listbox");
      list.innerHTML = items.map((item) => options.plainOptions ? `<div class="opt"><span>${item}</span></div>` : `<li role="option">${item}</li>`).join("");
      const custom = Array.from(list.children).find((child) => child.textContent === "Custom");
      custom?.addEventListener(options.selectOnMouseDown ? "mousedown" : "click", () => { onCustom(); picker.querySelector(button)!.textContent = "Custom"; list.remove(); });
      document.body.append(list);
    });
    menu("#tp", ["Last 30 days", "Custom"], () => { (picker.querySelector("#range") as HTMLElement).style.display = ""; });
    menu("#cp", options.comparisonItems ?? ["Previous period", "Custom"], () => { (picker.querySelector("#cmp-range") as HTMLElement).style.display = ""; });
    for (const input of Array.from(picker.querySelectorAll<HTMLInputElement>("#range input"))) input.addEventListener("focusout", () => { committed = Array.from(picker.querySelectorAll<HTMLInputElement>("#range input")).map((field) => field.value); });
    for (const input of Array.from(picker.querySelectorAll<HTMLInputElement>("#cmp-range input"))) input.addEventListener("focusout", () => { comparison = Array.from(picker.querySelectorAll<HTMLInputElement>("#cmp-range input")).map((field) => field.value); });
    picker.querySelector("#apply")!.addEventListener("click", () => {
      picker.style.display = "none";
      const customComparison = picker.querySelector("#cp")!.textContent === "Custom" && !options.comparisonIgnored && comparison.length === 2;
      const shownComparison = customComparison ? comparison : stored;
      if (applyWorks && committed.length === 2) window.setTimeout(() => { document.querySelector("#date-region p")!.textContent = `${display(committed[0]!)} - ${display(committed[1]!)} compared to ${display(shownComparison[0]!)} - ${display(shownComparison[1]!)}`; }, 1_000);
    });
    return { committed: () => committed, comparison: () => comparison };
  }

  it("sets the month through Klaviyo's live picker and proves it only from the painted Time period region", async () => {
    const live = livePickerPage(true);
    const outcome = await prepareBusinessReviewCaptureDocument(BUSINESS_REVIEW_TARGETS.campaign_performance, augustPeriod);
    expect(outcome.ok ? "ok" : `${outcome.code}: ${JSON.stringify((outcome as { diagnostics?: Record<string, unknown> }).diagnostics?.periodSetting)}`).toBe("ok");
    expect(live.committed()).toEqual(["Aug 01, 2026", "Aug 31, 2026"]);
    expect(live.comparison()).toEqual(["Jul 01, 2026", "Jul 31, 2026"]);
  });

  // Every month derives both ranges from its own report month; nothing is carried over from an earlier report.
  it.each([
    [{ year: 2026, month: 8 }, ["Aug 01, 2026", "Aug 31, 2026"], ["Jul 01, 2026", "Jul 31, 2026"]],
    [{ year: 2026, month: 9 }, ["Sep 01, 2026", "Sep 30, 2026"], ["Aug 01, 2026", "Aug 31, 2026"]],
    [{ year: 2026, month: 10 }, ["Oct 01, 2026", "Oct 31, 2026"], ["Sep 01, 2026", "Sep 30, 2026"]],
    [{ year: 2027, month: 1 }, ["Jan 01, 2027", "Jan 31, 2027"], ["Dec 01, 2026", "Dec 31, 2026"]],
    [{ year: 2028, month: 3 }, ["Mar 01, 2028", "Mar 31, 2028"], ["Feb 01, 2028", "Feb 29, 2028"]],
  ] as const)("for %o sets the month %o and its previous calendar month %o, even with July stored as the comparison", async (month, current, previous) => {
    const live = livePickerPage(true, { storedComparison: ["Jul 01, 2026", "Jul 31, 2026"] });
    const outcome = await prepareBusinessReviewCaptureDocument(BUSINESS_REVIEW_TARGETS.month_comparison, getReportPeriod(month));
    expect(outcome.ok ? "ok" : `${outcome.code}: ${JSON.stringify((outcome as { diagnostics?: Record<string, unknown> }).diagnostics?.periodSetting)}`).toBe("ok");
    expect(live.committed()).toEqual(current);
    expect(live.comparison()).toEqual(previous);
  }, 15_000);

  // Run c80dcbab (Steven Dann, October 2026): Time period "Last 30 days" and Comparison period already Custom on
  // Oct 1–31, so the only visible date fields were the comparison's. The page read "Oct 7 – Nov 6 compared to Oct 1 – 31".
  it("from Last 30 days with a Custom comparison, sets Time period to Oct 1–31 and the comparison to Sep 1–30, verifying both", async () => {
    const live = livePickerPage(true, { initialRange: "Oct 7, 2026 - Nov 6, 2026 compared to Oct 1, 2026 - Oct 31, 2026", comparisonDefault: "Custom" });
    const comparisonRange = document.querySelector<HTMLElement>("#cmp-range")!; comparisonRange.style.display = "";
    for (const [index, input] of Array.from(comparisonRange.querySelectorAll("input")).entries()) input.value = index === 0 ? "Oct 01, 2026" : "Oct 31, 2026";
    const outcome = await prepareBusinessReviewCaptureDocument(BUSINESS_REVIEW_TARGETS.month_comparison, getReportPeriod({ year: 2026, month: 10 }));
    expect(outcome.ok ? "ok" : `${outcome.code}: ${JSON.stringify((outcome as { diagnostics?: Record<string, unknown> }).diagnostics?.periodSetting)}`).toBe("ok");
    expect(outcome).toMatchObject({ ok: true, observedPeriod: { startDate: "2026-10-01", endDate: "2026-10-31", comparisonStartDate: "2026-09-01", comparisonEndDate: "2026-09-30" } });
    expect(live.committed()).toEqual(["Oct 01, 2026", "Oct 31, 2026"]);
    expect(live.comparison()).toEqual(["Sep 01, 2026", "Sep 30, 2026"]);
    expect(document.querySelector("#date-region p")!.textContent).toBe("Oct 1, 2026 - Oct 31, 2026 compared to Sep 1, 2026 - Sep 30, 2026");
  }, 15_000);

  it("never accepts 'Oct 7 – Nov 6 compared to Oct 1 – 31' as October, or as October compared to September", async () => {
    livePickerPage(false, { initialRange: "Oct 7, 2026 - Nov 6, 2026 compared to Oct 1, 2026 - Oct 31, 2026" });
    const outcome = await prepareBusinessReviewCaptureDocument(BUSINESS_REVIEW_TARGETS.month_comparison, getReportPeriod({ year: 2026, month: 10 }));
    expect(outcome).toMatchObject({ ok: false });
    expect((outcome as { diagnostics?: { periodSetting?: Record<string, unknown> } }).diagnostics?.periodSetting).toMatchObject({ dialogFound: true, pickerMode: "Last 30 days" });
  }, 30_000);

  /**
   * Run c3d31628: Klaviyo kept the September report's dates in its picker and its fields reverted programmatic writes.
   * Every picker field becomes a controlled field that only typing (insertText) changes; the shared period helper
   * must still replace both ranges with the report's own month and its previous calendar month.
   */
  function controlledFields(): () => void {
    const original = document.execCommand;
    const setNative = (input: HTMLInputElement, value: string) => Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
    const inputs = Array.from(document.querySelectorAll<HTMLInputElement>("[role=dialog] input"));
    const state = new Map(inputs.map((input) => [input, input.value]));
    for (const input of inputs) input.addEventListener("input", (event) => {
      if (event instanceof InputEvent && (event.inputType === "insertText" || event.inputType === "deleteContentBackward")) state.set(input, input.value); else setNative(input, state.get(input)!);
    }, true);
    document.execCommand = ((command: string, _ui?: boolean, value?: string) => {
      const input = document.activeElement as HTMLInputElement | null;
      if (!input || !state.has(input)) return false;
      const from = input.selectionStart ?? input.value.length; const to = input.selectionEnd ?? input.value.length;
      const next = command === "insertText" ? input.value.slice(0, from) + (value ?? "") + input.value.slice(to) : command === "delete" ? input.value.slice(0, from) + input.value.slice(to) : null;
      if (next === null) return false;
      setNative(input, next); input.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: command === "insertText" ? "insertText" : "deleteContentBackward", data: value ?? null }));
      return true;
    }) as typeof document.execCommand;
    return () => { document.execCommand = original; };
  }

  it.each([
    ["April 2026 from a page left on September compared to the previous year", { year: 2026, month: 4 }, ["Apr 01, 2026", "Apr 30, 2026"], ["Mar 01, 2026", "Mar 31, 2026"]],
    ["March 2026 (previous month February 1–28)", { year: 2026, month: 3 }, ["Mar 01, 2026", "Mar 31, 2026"], ["Feb 01, 2026", "Feb 28, 2026"]],
    ["January 2026 (previous month December 2025)", { year: 2026, month: 1 }, ["Jan 01, 2026", "Jan 31, 2026"], ["Dec 01, 2025", "Dec 31, 2025"]],
  ] as const)("Month Comparison: %s, with fields that revert programmatic writes", async (_case, month, current, previous) => {
    const live = livePickerPage(true, { initialRange: "Sep 1, 2026 - Sep 30, 2026 compared to previous year", comparisonDefault: "Previous year", comparisonItems: ["Previous period", "Previous year", "Custom"], storedComparison: ["Sep 01, 2025", "Sep 30, 2025"] });
    const restore = controlledFields();
    try {
      const report = getReportPeriod(month);
      const outcome = await prepareBusinessReviewCaptureDocument(BUSINESS_REVIEW_TARGETS.month_comparison, report);
      expect(outcome.ok ? "ok" : `${outcome.code}: ${JSON.stringify((outcome as { diagnostics?: Record<string, unknown> }).diagnostics?.periodSetting)}`).toBe("ok");
      // The previous calendar month comes from the report's stored period, never from the page or browser date math.
      expect(live.committed()).toEqual(current);
      expect(live.comparison()).toEqual(previous);
      expect(document.querySelector("#date-region p")!.textContent).toBe(`${display(current[0])} - ${display(current[1])} compared to ${display(previous[0])} - ${display(previous[1])}`);
    } finally { restore(); }
  }, 20_000);

  // Live run dfedae86: each range is one combined control whose values only its calendar changes.
  it.each([
    ["April 2026 vs March 2026, from September compared to the previous year", { year: 2026, month: 4 }, ["Apr 01, 2026", "Apr 30, 2026"], ["Mar 01, 2026", "Mar 31, 2026"]],
    ["January 2026 vs December 2025", { year: 2026, month: 1 }, ["Jan 01, 2026", "Jan 31, 2026"], ["Dec 01, 2025", "Dec 31, 2025"]],
    ["March 2028 vs leap-year February 2028", { year: 2028, month: 3 }, ["Mar 01, 2028", "Mar 31, 2028"], ["Feb 01, 2028", "Feb 29, 2028"]],
  ] as const)("Month Comparison through both range calendars: %s", async (_case, month, current, previous) => {
    const live = livePickerPage(true, { initialRange: "Sep 1, 2026 - Sep 30, 2026 compared to previous year", comparisonDefault: "Previous year", comparisonItems: ["Previous period", "Previous year", "Custom"], storedComparison: ["Sep 01, 2025", "Sep 30, 2025"] });
    const commitOn = (input: HTMLInputElement) => () => input.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
    const [rangeStart, rangeEnd] = Array.from(document.querySelectorAll<HTMLInputElement>("#range input"));
    const [comparisonStart, comparisonEnd] = Array.from(document.querySelectorAll<HTMLInputElement>("#cmp-range input"));
    const current_ = installRangeCalendar(rangeStart!, rangeEnd!, { startDate: "2026-09-01", endDate: "2026-09-30" }, { outsideDays: "labelled", onChange: commitOn(rangeStart!) });
    const comparison_ = installRangeCalendar(comparisonStart!, comparisonEnd!, { startDate: "2025-09-01", endDate: "2025-09-30" }, { onChange: commitOn(comparisonStart!) });
    const report = getReportPeriod(month);
    const outcome = await prepareBusinessReviewCaptureDocument(BUSINESS_REVIEW_TARGETS.month_comparison, report);
    expect(outcome.ok ? "ok" : `${outcome.code}: ${JSON.stringify((outcome as { diagnostics?: Record<string, unknown> }).diagnostics?.periodSetting).slice(0, 2500)}`).toBe("ok");
    expect(current_.clicked()).toEqual([`start:${report.startDate}`, `end:${report.endDate}`]);
    // The previous calendar month comes from the report's stored period, never from "Previous period" or browser math.
    expect(comparison_.clicked()).toEqual([`start:${report.previousStartDate}`, `end:${report.previousEndDate}`]);
    expect(live.committed()).toEqual(current); expect(live.comparison()).toEqual(previous);
    expect(document.querySelector("#date-region p")!.textContent).toBe(`${display(current[0])} - ${display(current[1])} compared to ${display(previous[0])} - ${display(previous[1])}`);
  }, 40_000);

  it("fails closed with COMPARISON_PERIOD_NOT_CONFIRMED when Klaviyo still shows Sep 1–30 compared to Jul 1–31", async () => {
    livePickerPage(true, { comparisonIgnored: true });
    const outcome = await prepareBusinessReviewCaptureDocument(BUSINESS_REVIEW_TARGETS.month_comparison, getReportPeriod({ year: 2026, month: 9 }), 6_000, 3_000);
    expect(outcome).toMatchObject({ ok: false, code: "COMPARISON_PERIOD_NOT_CONFIRMED", diagnostics: { periodSetting: { regionAfter: expect.stringContaining("Sep 1, 2026 - Sep 30, 2026 compared to Jul 1, 2026 - Jul 31, 2026") } } });
  }, 25_000);

  // Live 2026-11-04 (runs bec0e780, 95661f3d): the dashboard reset to "Oct 4 – Nov 3, 2026 compared to previous year",
  // the Comparison period menu gained "Previous year" and renders unroled options, and "Custom reports" is painted in
  // the Analytics sidebar. The old prefix match clicked the sidebar and the comparison stayed on "Previous year".
  const previousYearShape = { initialRange: "Oct 4, 2026 - Nov 3, 2026 compared to previous year", comparisonDefault: "Previous year", comparisonItems: ["Previous period", "Previous year", "Custom"], plainOptions: true, sidebar: true };

  it("switches a 'Previous year' comparison to Custom Aug 1–31 for September, never clicking the sidebar's Custom reports", async () => {
    const live = livePickerPage(true, previousYearShape);
    const sidebarClicked = vi.fn(); document.querySelector("#custom-reports")!.addEventListener("click", sidebarClicked);
    const outcome = await prepareBusinessReviewCaptureDocument(BUSINESS_REVIEW_TARGETS.month_comparison, getReportPeriod({ year: 2026, month: 9 }));
    expect(outcome.ok ? "ok" : `${outcome.code}: ${JSON.stringify((outcome as { diagnostics?: Record<string, unknown> }).diagnostics?.periodSetting)}`).toBe("ok");
    expect(live.committed()).toEqual(["Sep 01, 2026", "Sep 30, 2026"]);
    expect(live.comparison()).toEqual(["Aug 01, 2026", "Aug 31, 2026"]);
    expect(sidebarClicked).not.toHaveBeenCalled();
    expect(document.querySelector("#date-region p")!.textContent).toBe("Sep 1, 2026 - Sep 30, 2026 compared to Aug 1, 2026 - Aug 31, 2026");
  }, 15_000);

  it("selects a Custom option that only responds to a full mouse press", async () => {
    const live = livePickerPage(true, { ...previousYearShape, selectOnMouseDown: true });
    const outcome = await prepareBusinessReviewCaptureDocument(BUSINESS_REVIEW_TARGETS.month_comparison, getReportPeriod({ year: 2026, month: 9 }));
    expect(outcome.ok ? "ok" : `${outcome.code}: ${JSON.stringify((outcome as { diagnostics?: Record<string, unknown> }).diagnostics?.periodSetting)}`).toBe("ok");
    expect(live.comparison()).toEqual(["Aug 01, 2026", "Aug 31, 2026"]);
  }, 15_000);

  it("fails closed, listing the offered options, when the Comparison period menu has no Custom option", async () => {
    livePickerPage(true, { ...previousYearShape, comparisonItems: ["Previous period", "Previous year"] });
    const outcome = await prepareBusinessReviewCaptureDocument(BUSINESS_REVIEW_TARGETS.month_comparison, getReportPeriod({ year: 2026, month: 9 }));
    expect(outcome).toMatchObject({ ok: false, code: "COMPARISON_PERIOD_NOT_CONFIRMED", diagnostics: { periodSetting: { comparisonCustomChosen: false, comparisonPickerAfter: "Previous year", comparisonChoice: { attempts: [{ strategy: "click", options: ["Previous period", "Previous year"], clicked: null }, { strategy: "press", clicked: null }] } } } });
    expect(document.querySelector("#date-region p")!.textContent).toBe("Oct 4, 2026 - Nov 3, 2026 compared to previous year");
  }, 20_000);

  it("fails closed when Apply leaves the comparison on previous year", async () => {
    livePickerPage(true, { ...previousYearShape, comparisonIgnored: true, storedComparison: ["previous year", ""] as unknown as [string, string] });
    const outcome = await prepareBusinessReviewCaptureDocument(BUSINESS_REVIEW_TARGETS.month_comparison, getReportPeriod({ year: 2026, month: 9 }), 6_000, 3_000);
    expect(outcome).toMatchObject({ ok: false, code: "COMPARISON_PERIOD_NOT_CONFIRMED" });
  }, 25_000);

  it("accepts Sep 1–30 compared to Aug 1–31 as already set, without opening the picker", async () => {
    siblingRangePage("Sep 1, 2026 - Sep 30, 2026 compared to Aug 1, 2026 - Aug 31, 2026");
    const opened = vi.fn(); document.querySelector("#date-region [aria-label='Time period']")!.addEventListener("click", opened);
    await expect(prepareBusinessReviewCaptureDocument(BUSINESS_REVIEW_TARGETS.month_comparison, getReportPeriod({ year: 2026, month: 9 }))).resolves.toMatchObject({ ok: true });
    expect(opened).not.toHaveBeenCalled();
  });

  it("never treats the closed picker's hidden expected-month text as proof, and cancels the picker on failure", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date", "requestAnimationFrame"] });
    try {
      livePickerPage(false);
      const result = prepareBusinessReviewCaptureDocument(BUSINESS_REVIEW_TARGETS.campaign_performance, augustPeriod);
      await vi.advanceTimersByTimeAsync(40_000);
      await expect(result).resolves.toMatchObject({ ok: false, code: "KLAVIYO_PERIOD_VERIFY_FAILED", diagnostics: { periodSetting: { customChosen: true, applyClicked: true, regionAfter: expect.stringContaining("Sep 27, 2026 - Oct 27, 2026"), pickerDismissed: true } } });
    } finally { vi.useRealTimers(); }
  });
});
