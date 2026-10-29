/**
 * Test-only simulation of Klaviyo's Subscriber growth page (https://www.klaviyo.com/people/subscribers), modelled on the
 * live state of 2026-10-29: Overview selected, "Last 7 days", "Subscriber overview" and "Subscriber trends". It behaves
 * like React: a tab click removes the current content at once and renders the new view after a delay, so no element
 * reference survives a view change. Geometry is computed from the viewport and a scroll offset.
 */
import { vi } from "vitest";

type Channel = "Overview" | "Email" | "Text message";
type View = "Growth" | "Opt-in sources" | "Exclusion sources";
export interface SubscriberGrowthFixtureOptions {
  channel?: Channel; view?: View; period?: string; account?: string; path?: string; heading?: string;
  /** Delay before a view re-renders after a click (React replaces the DOM). */
  renderDelayMs?: number;
  /** Extra delay before the three metrics, and before the charts, appear in a freshly rendered Email → Growth view. */
  metricsDelayMs?: number; chartsDelayMs?: number;
  metrics?: Partial<Record<"Email subscribers" | "New subscribers" | "Exclusions", string | null>>;
  lineChart?: boolean; barChart?: "bars" | "empty" | "none"; spinner?: boolean;
  /** "inputs" sets the typed range on Apply; "inert" keeps the old range; "none" opens nothing. */
  picker?: "inputs" | "inert" | "none";
  hasEmailTab?: boolean; hasGrowthView?: boolean; tabsRespond?: boolean;
  viewport?: { width: number; height: number };
  /** Natural page top of the reporting area; > viewport height puts it below the fold. */
  contentTop?: number; contentHeight?: number;
  composer?: boolean;
}

export interface SubscriberGrowthFixture { clicks: string[]; state: Required<Pick<SubscriberGrowthFixtureOptions, "channel" | "view" | "period">>; composer: HTMLElement | null }

let activeClickHandler: ((event: Event) => void) | null = null;

export function installSubscriberGrowthFixture(options: SubscriberGrowthFixtureOptions = {}): SubscriberGrowthFixture {
  removeSubscriberGrowthFixture();
  const viewport = options.viewport ?? { width: 1920, height: 1080 };
  Object.defineProperty(window, "innerWidth", { configurable: true, value: viewport.width });
  Object.defineProperty(window, "innerHeight", { configurable: true, value: viewport.height });
  window.history.replaceState({}, "", `${options.path ?? "/people/subscribers"}?range=last_7_days#overview`);
  const fixture: SubscriberGrowthFixture = { clicks: [], state: { channel: options.channel ?? "Overview", view: options.view ?? "Growth", period: options.period ?? "Last 7 days" }, composer: null };
  const metrics = { "Email subscribers": "17,698", "New subscribers": "943", Exclusions: "499", ...options.metrics };
  const delay = options.renderDelayMs ?? 0;
  let scrollShift = 0;
  const contentTop = options.contentTop ?? 80; const contentHeight = options.contentHeight ?? 900;

  document.body.innerHTML = `<header><button aria-label="Account menu">${options.account ?? "Northwind Goods"}</button></header><main id="page"></main>`;
  const main = document.getElementById("page")!;
  const tab = (name: string, on: boolean, group: string) => `<button role="tab" data-group="${group}" aria-selected="${on}">${name}</button>`;
  const metric = (name: keyof typeof metrics, change: string) => metrics[name] === null ? "" : `<div class="metric"><span>${name}</span><strong>${metrics[name]}</strong><span>${change}</span></div>`;

  const renderGrowth = (container: HTMLElement) => {
    const showMetrics = () => { container.querySelector("#metrics")!.innerHTML = `${metric("Email subscribers", "+2.1%")}${metric("New subscribers", "-3%")}${metric("Exclusions", "")}`; };
    const bars = options.barChart === "empty" ? "" : `<rect class="mark" fill="#3355ff" width="10" height="50"></rect><rect class="mark" fill="#ff5533" width="10" height="40"></rect>`;
    const showCharts = () => {
      container.querySelector("#charts")!.innerHTML = `${options.lineChart === false ? "" : `<svg id="line"><path class="line" d="M0 0 L10 10 L20 5 L30 8" stroke="#3355ff" fill="none"></path></svg>`}${options.barChart === "none" ? "" : `<svg id="bar">${bars}</svg>`}`;
    };
    container.innerHTML = `<h2>Email subscribers</h2><div role="tablist" id="views">${(options.hasGrowthView === false ? ["Opt-in sources", "Exclusion sources"] : ["Growth", "Opt-in sources", "Exclusion sources"]).map((name) => tab(name, fixture.state.view === name, "view")).join("")}</div><div id="metrics"></div><div id="charts"></div>${options.spinner ? `<div role="progressbar">Loading</div>` : ""}`;
    if (fixture.state.view !== "Growth") { container.querySelector("#metrics")!.innerHTML = `<p>${fixture.state.view} table</p>`; return; }
    if (options.metricsDelayMs) setTimeout(showMetrics, options.metricsDelayMs); else showMetrics();
    if (options.chartsDelayMs) setTimeout(showCharts, options.chartsDelayMs); else showCharts();
  };
  const render = () => {
    const channels = (["Overview", ...(options.hasEmailTab === false ? [] : ["Email"]), "Text message"] as Channel[]).map((name) => tab(name, fixture.state.channel === name, "channel")).join("");
    main.innerHTML = `<h1>${options.heading ?? "Subscriber growth"}</h1><div role="tablist" id="channels">${channels}</div><button id="date">${fixture.state.period}</button><section id="content"></section>`;
    const content = main.querySelector<HTMLElement>("#content")!;
    if (fixture.state.channel === "Overview") content.innerHTML = `<h2>Subscriber overview</h2><p>Email 17,698 · Text message 2,104</p><h2>Subscriber trends</h2><svg id="trend"><path d="M0 0 L5 5 L9 2" stroke="#000" fill="none"></path></svg>`;
    else if (fixture.state.channel === "Text message") content.innerHTML = `<h2>Text message subscribers</h2><p>2,104</p>`;
    else renderGrowth(content);
  };
  const rerender = () => { main.innerHTML = ""; if (delay) setTimeout(render, delay); else render(); };
  render();

  // Clicks drive state like React event handlers; nothing outside the simulated page is touched.
  activeClickHandler = (event: Event) => {
    const target = event.target as HTMLElement;
    const group = target.getAttribute("data-group");
    if (group) {
      fixture.clicks.push(target.textContent ?? "");
      if (options.tabsRespond === false) return;
      if (group === "channel") fixture.state.channel = target.textContent as Channel; else fixture.state.view = target.textContent as View;
      rerender();
      return;
    }
    if (target.id === "date" && options.picker && options.picker !== "none") {
      document.body.insertAdjacentHTML("beforeend", `<div role="dialog"><input aria-label="Start date" placeholder="MM/DD/YYYY"><input aria-label="End date" placeholder="MM/DD/YYYY"><button id="apply">Apply</button></div>`);
      return;
    }
    if (target.id === "apply") {
      const [start, end] = Array.from(document.querySelectorAll<HTMLInputElement>("[role=dialog] input")).map((input) => input.value);
      document.querySelector("[role=dialog]")!.remove();
      fixture.clicks.push("Apply");
      if (options.picker === "inputs") { fixture.state.period = `${start} – ${end}`; rerender(); }
    }
  };
  document.addEventListener("click", activeClickHandler);

  if (options.composer) {
    const composer = document.createElement("aside");
    composer.id = "composer"; composer.style.position = "fixed"; composer.textContent = "Which segments am I over-sending to?";
    document.body.append(composer);
    fixture.composer = composer;
  }

  const rect = (left: number, top: number, width: number, height: number): DOMRect => ({ x: left, y: top, width, height, left, top, right: left + width, bottom: top + height, toJSON: () => ({}) } as DOMRect);
  // The reporting area reflows to the viewport width, as Klaviyo's layout does next to an open side panel.
  const pageWidth = () => Math.min(1400, window.innerWidth - 20);
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
    const top = contentTop - scrollShift; const width = pageWidth();
    if (this.id === "page") return rect(10, top, width, contentHeight);
    if (this.id === "composer") return (this as HTMLElement).style.visibility === "hidden" ? rect(0, 0, 0, 0) : rect(window.innerWidth - 360, window.innerHeight - 300, 340, 100);
    if (this.id === "line") return rect(40, top + 420, width - 60, 160);
    if (this.id === "bar") return rect(40, top + 620, width - 60, 160);
    if (this.id === "trend") return rect(40, top + 300, width - 60, 160);
    if (this.classList.contains("line")) return rect(40, top + 425, width - 80, 150);
    if (this.classList.contains("mark")) return rect(60, top + 640, 10, 50);
    if (this.closest("[role=dialog]")) return rect(400, 300, 200, 30);
    if (this.closest("header")) return rect(10, 10, 160, 30);
    return rect(40, top + 60, 100, 20);
  });
  Element.prototype.scrollIntoView = function (this: Element) { if (this.id === "page") scrollShift = Math.max(0, contentTop - 10); } as never;
  // Hit-testing: the fixed composer is on top wherever it is painted, otherwise the page itself.
  Object.defineProperty(document, "elementFromPoint", { configurable: true, value: (x: number, y: number) => {
    const composer = fixture.composer;
    if (composer && composer.style.visibility !== "hidden") { const box = composer.getBoundingClientRect(); if (x >= box.left && x <= box.right && y >= box.top && y <= box.bottom) return composer; }
    return main;
  } });
  return fixture;
}

export function removeSubscriberGrowthFixture(): void {
  if (activeClickHandler) document.removeEventListener("click", activeClickHandler);
  activeClickHandler = null;
  vi.restoreAllMocks();
  delete (document as { elementFromPoint?: unknown }).elementFromPoint;
  delete (Element.prototype as { scrollIntoView?: unknown }).scrollIntoView;
  document.body.innerHTML = "";
  window.history.replaceState({}, "", "/");
}
