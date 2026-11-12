import { afterEach, describe, expect, it, vi } from "vitest";
import { DASHBOARD_TARGETS, prepareDashboardCaptureDocument, type DashboardAdapterResult } from "./dashboard-capture.js";

/**
 * Windows run 7417360d (Club Furniture, October 2026): Executive Summary passed, Top 5 Flows failed 5/5 with
 * TOP_FLOWS_NON_QUALIFYING_ROW_IN_VIEW (shown as VIEW_NOT_SELECTED) while the same report passed on macOS. One semantic
 * document — the recorded live Top performing flows markup: native table, status in role=status — is laid out with
 * each platform's geometry. The capture decision must not depend on that geometry.
 */
const period = { startDate: "2026-10-01", endDate: "2026-10-31", previousStartDate: "2026-09-01", previousEndDate: "2026-09-30" };
const injected = new Function("target", "expected", `return (${prepareDashboardCaptureDocument.toString()})(target, expected);`) as typeof prepareDashboardCaptureDocument;

interface Geometry {
  innerWidth: number; innerHeight: number;
  /** Width of a classic (space-taking) scrollbar on Klaviyo's app scroller; 0 for macOS overlay scrollbars. */
  scrollbar: number; devicePixelRatio: number;
  cardLeft: number; cardTop: number; tableWidth: number; headerHeight: number; rowHeight: number;
  /** Where a "Pick up where you left off" draft card is painted, if the layout puts one inside the card. */
  pickupTop?: number;
}
interface Profile extends Geometry { name: string }

// CSS-pixel geometry as Chrome reports it. Windows sizes come from the normalizer's zoom steps on a 1920 px screen with
// the Tention side panel open; macOS from the recorded passing runs (1754 px, overlay scrollbars).
const PROFILES: Profile[] = [
  { name: "macOS desktop (overlay scrollbars, Retina)", innerWidth: 1754, innerHeight: 1586, scrollbar: 0, devicePixelRatio: 2, cardLeft: 412, cardTop: 900, tableWidth: 1212, headerHeight: 40, rowHeight: 56 },
  { name: "Windows Chrome 100% (classic scrollbar, side panel open)", innerWidth: 1503, innerHeight: 937, scrollbar: 17, devicePixelRatio: 1, cardLeft: 268, cardTop: 1040, tableWidth: 1150, headerHeight: 40, rowHeight: 64 },
  { name: "Windows 125% display scaling, Chrome 80%", innerWidth: 1442, innerHeight: 1000, scrollbar: 21, devicePixelRatio: 1, cardLeft: 260, cardTop: 980, tableWidth: 1120, headerHeight: 42, rowHeight: 72 },
  { name: "Windows Chrome 90%", innerWidth: 1544, innerHeight: 960, scrollbar: 19, devicePixelRatio: 1.125, cardLeft: 280, cardTop: 1010, tableWidth: 1180, headerHeight: 40, rowHeight: 60 },
  { name: "Windows Chrome 80%", innerWidth: 1737, innerHeight: 1080, scrollbar: 21, devicePixelRatio: 1, cardLeft: 300, cardTop: 960, tableWidth: 1230, headerHeight: 38, rowHeight: 56 },
  { name: "Chrome 100% at a 1390 px layout", innerWidth: 1407, innerHeight: 900, scrollbar: 17, devicePixelRatio: 1.25, cardLeft: 248, cardTop: 1000, tableWidth: 1100, headerHeight: 40, rowHeight: 68 },
];

type Row = { name: string; trigger: string; status: "Live" | "Manual" | "Draft"; revenue: string };
const clubFurnitureRows = (count: number): Row[] => Array.from({ length: count }, (_, index) => ({
  name: `TM | Flow ${index + 1} |`, trigger: index === 3 ? "Added to Swatches List list" : "Checkout Started", status: "Live", revenue: `$${(30_000 - index * 2_000).toLocaleString("en-US")}.00`,
}));

let layout: Geometry; let scrollTop = 0; let scrollLeft = 0;

function install(profile: Geometry, rows: Row[], options: { pickupInsideCard?: boolean; pickupBesideCard?: boolean; scrollWidth?: number } = {}): void {
  layout = { ...profile }; scrollTop = 0; scrollLeft = 0;
  window.history.replaceState({}, "", "/dashboard");
  const range = "Oct 1, 2026 - Oct 31, 2026";
  const body = rows.map((row, index) => `<tr data-row="${index}"><td role="cell"><div><div><a><span><span>${row.name}</span></span></a><span><div>${row.trigger}</div></span></div></div></td><td role="cell"><div><div><div role="status"><span>${row.status}</span></div></div></div></td><td role="cell"><div><ul><li><span role="img" aria-label="Email"></span></li></ul></div></td><td role="cell"><span>${1_000 + index}</span></td><td role="cell"><span>${row.revenue}</span><span><div>$1.00 / recipient</div></span></td><td role="cell"><span>—</span></td></tr>`).join("");
  // Klaviyo's "Pick up where you left off" shows recently edited items; a draft flow there looks like a flow row.
  const pickup = `<div id="pickup"><span>Pick up where you left off</span><div role="row" data-pickup="0"><div role="cell"><a>Welcome Series Draft</a></div><div role="cell"><div role="status">Draft</div></div><div role="cell">Edited 2 days ago</div></div><div role="row" data-pickup="1"><div role="cell"><a>VIP Winback</a></div><div role="cell"><div role="status">Draft</div></div><div role="cell">Edited 5 days ago</div></div></div>`;
  document.body.innerHTML = `<div id="app-scroller" style="overflow-x: auto; overflow-y: auto"><main>
    <header><span>Conversion metric</span><button aria-label="Time period">Time period</button><p>${range} compared to previous period</p></header>
    ${options.pickupBesideCard ? pickup : ""}
    <div id="cf-card"><div><div><span><span><span><h3 id="cf-heading">Top performing flows</h3></span><span>${range}</span></span></span></div><div><button><span>View all flows</span></button></div></div>
      ${options.pickupInsideCard ? pickup : ""}
      <div id="cf-wrapper"><table id="cf-table" role="table"><thead><tr id="cf-header" role="row"><th><span>Flow</span></th><th><span>Status</span></th><th><span>Type</span></th><th><span>Deliveries</span></th><th><span>Placed Order</span></th><th><span>Percent change</span></th></tr></thead><tbody>${body}</tbody></table></div>
    </div></main></div>`;
  const scroller = document.getElementById("app-scroller")!;
  vi.spyOn(window, "innerWidth", "get").mockImplementation(() => layout.innerWidth);
  vi.spyOn(window, "innerHeight", "get").mockImplementation(() => layout.innerHeight);
  Object.defineProperty(window, "devicePixelRatio", { configurable: true, get: () => layout.devicePixelRatio });
  // Klaviyo scrolls in its own full-width app container; a classic scrollbar there narrows the layout.
  Object.defineProperty(scroller, "scrollTop", { configurable: true, get: () => scrollTop, set: (value: number) => { scrollTop = Math.max(0, Math.min(value, 4_000)); } });
  Object.defineProperty(scroller, "scrollLeft", { configurable: true, get: () => scrollLeft, set: (value: number) => { scrollLeft = Math.max(0, Math.min(value, Math.max(0, (options.scrollWidth ?? 0) - (layout.innerWidth - layout.scrollbar)))); } });
  Object.defineProperty(scroller, "offsetWidth", { configurable: true, get: () => layout.innerWidth });
  Object.defineProperty(scroller, "clientWidth", { configurable: true, get: () => layout.innerWidth - layout.scrollbar });
  Object.defineProperty(scroller, "clientHeight", { configurable: true, get: () => layout.innerHeight });
  Object.defineProperty(scroller, "scrollHeight", { configurable: true, get: () => 4_000 });
  Object.defineProperty(scroller, "scrollWidth", { configurable: true, get: () => options.scrollWidth ?? layout.innerWidth - layout.scrollbar });
  if (!("scrollIntoView" in HTMLElement.prototype)) Object.defineProperty(HTMLElement.prototype, "scrollIntoView", { configurable: true, value: () => undefined });
  vi.spyOn(HTMLElement.prototype, "scrollIntoView").mockImplementation(() => undefined);
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) { return geometryOf(this, rows.length); });
}

function box(left: number, top: number, width: number, height: number): DOMRect {
  return { x: left, y: top, width, height, left, top, right: left + width, bottom: top + height, toJSON: () => ({}) } as DOMRect;
}
const card = () => ({ left: layout.cardLeft - scrollLeft, top: layout.cardTop - scrollTop });
const tableTop = () => card().top + 90;
function rowBox(index: number) { return box(card().left + 24, tableTop() + layout.headerHeight + index * layout.rowHeight, layout.tableWidth, layout.rowHeight); }
function geometryOf(element: HTMLElement, rowCount: number): DOMRect {
  const { left, top } = card();
  if (element.id === "app-scroller") return box(0, 0, layout.innerWidth - layout.scrollbar, layout.innerHeight);
  if (element.tagName === "MAIN") return box(0, 0, layout.innerWidth - layout.scrollbar, 3_000);
  if (element.id === "cf-card") return box(left, top, layout.tableWidth + 48, 110 + layout.headerHeight + rowCount * layout.rowHeight);
  if (element.id === "cf-heading") return box(left + 24, top + 20, 300, 30);
  if (element.id === "cf-wrapper" || element.id === "cf-table") return box(left + 24, tableTop(), layout.tableWidth, layout.headerHeight + rowCount * layout.rowHeight);
  if (element.id === "cf-header" || element.tagName === "THEAD" || element.closest("thead")) return box(left + 24, tableTop(), layout.tableWidth, layout.headerHeight);
  const row = element.closest<HTMLElement>("[data-row]");
  if (row) return rowBox(Number(row.dataset.row));
  const pickup = element.closest<HTMLElement>("[data-pickup]");
  // Painted over the counted rows' band, as a responsive reflow can place it.
  if (pickup) return box(left + 24, (layout.pickupTop ?? tableTop() + layout.headerHeight + 10) - scrollTop + Number(pickup.dataset.pickup) * 40, 400, 36);
  if (element.id === "pickup") return box(left + 24, (layout.pickupTop ?? tableTop() + layout.headerHeight) - scrollTop, 420, 120);
  return box(0, 0, 0, 0);
}

function expectFiveRowCrop(result: DashboardAdapterResult, included = 5, available = 10): void {
  expect(result.ok ? "ok" : `${result.code}: ${JSON.stringify((result as { diagnostics?: Record<string, unknown> }).diagnostics?.selection ?? null).slice(0, 1_500)}`).toBe("ok");
  if (!result.ok) return;
  const cardBox = document.getElementById("cf-card")!.getBoundingClientRect();
  expect(result.targetRect).toMatchObject({ availableRowCount: available, includedRowCount: included });
  // Crop: card top through the last counted row, never into the next row, fully inside Klaviyo's layout area.
  expect(result.targetRect.y).toBe(cardBox.top);
  expect(result.targetRect.y + result.targetRect.height).toBe(rowBox(included - 1).bottom);
  if (available > included) expect(result.targetRect.y + result.targetRect.height).toBeLessThanOrEqual(rowBox(included).top);
  expect(result.targetRect.y).toBeGreaterThanOrEqual(0);
  expect(result.targetRect.y + result.targetRect.height).toBeLessThanOrEqual(layout.innerHeight);
  expect(result.targetRect.x + result.targetRect.width).toBeLessThanOrEqual(layout.innerWidth - layout.scrollbar);
  expect(result.targetRect.layoutViewportWidth).toBe(layout.innerWidth - layout.scrollbar);
  expect(result.targetRect.viewportWidth).toBe(layout.innerWidth);
}

afterEach(() => {
  vi.restoreAllMocks(); vi.useRealTimers();
  delete (window as { devicePixelRatio?: number }).devicePixelRatio;
  document.body.innerHTML = ""; window.history.replaceState({}, "", "/");
});

describe("Windows layout: classic scrollbars, zoom, side panel and reflow give the same Top Flows decision", () => {
  it.each(PROFILES.map((profile) => [profile.name, profile] as const))("1–6. %s: scrolls the card into view and captures exactly the top 5 of 10 Live flows", async (_name, profile) => {
    install(profile, clubFurnitureRows(10));
    const result = await injected(DASHBOARD_TARGETS.top_flows, period);
    expectFiveRowCrop(result);
    // Wherever the card started, it was brought fully into view: scrolled only when it did not already fit.
    if (profile.cardTop + 110 + profile.headerHeight + 5 * profile.rowHeight > profile.innerHeight) expect(scrollTop).toBeGreaterThan(0);
  }, 20_000);

  it("produces the same semantic decision (counts, ranks, statuses) on every platform geometry", async () => {
    const decisions: unknown[] = [];
    for (const profile of PROFILES) {
      install(profile, clubFurnitureRows(10));
      const result = await injected(DASHBOARD_TARGETS.top_flows, period);
      const selection = result.ok ? (result.targetRect.layoutEvidence as { selection?: { candidates?: Array<Record<string, unknown>> } }).selection : null;
      decisions.push({ ok: result.ok, included: result.ok ? result.targetRect.includedRowCount : null, rows: selection?.candidates?.map(({ rank, status, included }) => ({ rank, status, included })) });
      vi.restoreAllMocks();
    }
    expect(decisions.every((decision) => JSON.stringify(decision) === JSON.stringify(decisions[0]))).toBe(true);
    expect(decisions[0]).toMatchObject({ ok: true, included: 5 });
  }, 60_000);

  it("7 + 16. side panel opens mid-measurement: geometry from the wider layout is discarded and the target re-measured", async () => {
    install(PROFILES[0]!, clubFurnitureRows(10));
    const panelOpen = { ...PROFILES[1]! };
    // The panel opens right after the first time the table is measured at the wide macOS-like layout.
    let headerReads = 0;
    const original = vi.mocked(HTMLElement.prototype.getBoundingClientRect).getMockImplementation()!;
    vi.mocked(HTMLElement.prototype.getBoundingClientRect).mockImplementation(function (this: HTMLElement) {
      if (this.id === "cf-header" && ++headerReads === 2) layout = { ...panelOpen };
      return original.call(this);
    });
    const result = await injected(DASHBOARD_TARGETS.top_flows, period);
    expect(headerReads).toBeGreaterThan(2);
    expectFiveRowCrop(result);
    expect(layout.innerWidth).toBe(panelOpen.innerWidth);
  }, 20_000);

  it("8. horizontal-scroll layout: a page scrolled sideways is scrolled back until every flow column is visible", async () => {
    install(PROFILES[1]!, clubFurnitureRows(10), { scrollWidth: 2_200 });
    scrollLeft = 600; // the card's left columns are off-screen to the left
    const result = await injected(DASHBOARD_TARGETS.top_flows, period);
    expectFiveRowCrop(result);
    expect(scrollLeft).toBeLessThan(600);
    const header = document.getElementById("cf-header")!.getBoundingClientRect();
    expect(header.left).toBeGreaterThanOrEqual(0);
    expect(header.right).toBeLessThanOrEqual(layout.innerWidth - layout.scrollbar);
  }, 20_000);

  it("9. Top Flows initially far below the viewport is scrolled into view, never measured off-screen", async () => {
    install({ ...PROFILES[2]!, cardTop: 2_400 }, clubFurnitureRows(10));
    const result = await injected(DASHBOARD_TARGETS.top_flows, period);
    expectFiveRowCrop(result);
    expect(scrollTop).toBeGreaterThan(1_400);
  }, 20_000);

  it("10 + 15. responsive reflow after scrolling (cards above grow, rows wrap taller) is re-measured before capture", async () => {
    install(PROFILES[1]!, clubFurnitureRows(10));
    let reflowed = false;
    const original = vi.mocked(HTMLElement.prototype.getBoundingClientRect).getMockImplementation()!;
    vi.mocked(HTMLElement.prototype.getBoundingClientRect).mockImplementation(function (this: HTMLElement) {
      // The first scroll triggers lazy content above: the card moves down 180 px and flow names wrap to two lines.
      if (!reflowed && scrollTop > 0) { reflowed = true; layout = { ...layout, cardTop: layout.cardTop + 180, rowHeight: 88 }; }
      return original.call(this);
    });
    const result = await injected(DASHBOARD_TARGETS.top_flows, period);
    expect(reflowed).toBe(true);
    expectFiveRowCrop(result);
  }, 20_000);

  it("11. a draft flow card from \"Pick up where you left off\" painted inside the card band is never a Top Flows row", async () => {
    install(PROFILES[1]!, clubFurnitureRows(10), { pickupInsideCard: true });
    const result = await injected(DASHBOARD_TARGETS.top_flows, period);
    expectFiveRowCrop(result);
  }, 20_000);

  it("11b. \"Pick up where you left off\" beside the card (title not a heading element) never joins the card", async () => {
    install(PROFILES[2]!, clubFurnitureRows(10), { pickupBesideCard: true });
    const result = await injected(DASHBOARD_TARGETS.top_flows, period);
    expectFiveRowCrop(result);
  }, 20_000);

  it("12. exactly 5 qualifying rows: all 5 captured", async () => {
    install(PROFILES[1]!, clubFurnitureRows(5));
    expectFiveRowCrop(await injected(DASHBOARD_TARGETS.top_flows, period), 5, 5);
  }, 20_000);

  it.each([1, 2, 3, 4])("13. %i qualifying rows: captured as the real count, never padded", async (count) => {
    install(PROFILES[2]!, clubFurnitureRows(count));
    expectFiveRowCrop(await injected(DASHBOARD_TARGETS.top_flows, period), count, count);
  }, 20_000);

  it("14. zero flows keeps the typed no-data contract on Windows geometry", async () => {
    install(PROFILES[1]!, []);
    await expect(injected(DASHBOARD_TARGETS.top_flows, period)).resolves.toMatchObject({ ok: false, code: "TOP_FLOWS_NO_DATA" });
  }, 20_000);

  it.each(PROFILES.map((profile) => [profile.name, profile] as const))("verification is not weakened (%s): a Draft flow ranked inside the top 5 still fails closed with its exact code and the rejected row", async (_name, profile) => {
    const rows = clubFurnitureRows(10); rows[2] = { ...rows[2]!, status: "Draft" };
    install(profile, rows);
    const result = await injected(DASHBOARD_TARGETS.top_flows, period);
    expect(result).toMatchObject({ ok: false, code: "TOP_FLOWS_NON_QUALIFYING_ROW_IN_VIEW" });
    const selection = (result as { diagnostics?: { selection?: Record<string, unknown> } }).diagnostics?.selection as { decision: string; viewport: Record<string, unknown>; candidates: Array<Record<string, unknown>> };
    expect(selection.decision).toBe("non_qualifying_in_view");
    expect(selection.viewport).toMatchObject({ innerWidth: profile.innerWidth, layoutWidth: profile.innerWidth - profile.scrollbar, devicePixelRatio: profile.devicePixelRatio });
    expect(selection.candidates[2]).toMatchObject({ rank: 3, status: "Draft", statusSource: "role=status", qualifying: false, rejection: "status Draft: not ranked", text: expect.stringContaining("TM | Flow 3") });
  }, 20_000);

  it("reads status from the Status cell: a Live flow whose name contains \"Draft\" is counted; a Draft flow named \"Live …\" is not", async () => {
    const rows = clubFurnitureRows(10);
    rows[1] = { ...rows[1]!, name: "TM | Draft Recovery |" };
    rows[7] = { ...rows[7]!, name: "TM | Live Event Reminder |", status: "Draft" };
    install(PROFILES[1]!, rows);
    expectFiveRowCrop(await injected(DASHBOARD_TARGETS.top_flows, period), 5, 9);
  }, 20_000);

  it("rows overlapping for a moment (mid-animation) are a layout still moving, not a Draft in range", async () => {
    install(PROFILES[1]!, clubFurnitureRows(10));
    let settled = false; window.setTimeout(() => { settled = true; }, 400);
    const original = vi.mocked(HTMLElement.prototype.getBoundingClientRect).getMockImplementation()!;
    vi.mocked(HTMLElement.prototype.getBoundingClientRect).mockImplementation(function (this: HTMLElement) {
      const row = this.closest<HTMLElement>("[data-row]");
      // Before settling, rows 6–10 are still painted at row 2's position (the old geometric check read this as a Draft in view).
      if (!settled && row && Number(row.dataset.row) >= 5) return rowBox(1);
      return original.call(this);
    });
    expectFiveRowCrop(await injected(DASHBOARD_TARGETS.top_flows, period));
  }, 20_000);

  it("a flow table wider than Klaviyo's layout fails as KLAVIYO_VIEWPORT_TOO_NARROW with actual and required width, never VIEW_NOT_SELECTED", async () => {
    install({ ...PROFILES[1]!, innerWidth: 1100, cardLeft: 40, tableWidth: 1150 }, clubFurnitureRows(10));
    const result = await injected(DASHBOARD_TARGETS.top_flows, period);
    expect(result).toMatchObject({ ok: false, code: "KLAVIYO_VIEWPORT_TOO_NARROW" });
    const selection = (result as { diagnostics?: { selection?: { actualWidth: number; requiredWidth: number } } }).diagnostics?.selection;
    expect(selection?.actualWidth).toBe(1100 - 17);
    expect(selection?.requiredWidth).toBeGreaterThanOrEqual(1390);
    expect(result.ok ? "" : result.message).toMatch(/1083 px.*at least \d+ px/);
  }, 20_000);

  it("success evidence records the selection geometry without any flow text", async () => {
    install(PROFILES[2]!, clubFurnitureRows(10));
    const result = await injected(DASHBOARD_TARGETS.top_flows, period);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const evidence = result.targetRect.layoutEvidence as { selection: Record<string, unknown> };
    expect(evidence.selection).toMatchObject({ decision: "ok", includedRowCount: 5, availableRowCount: 10, tableIsCard: false, viewport: { layoutWidth: 1421, classicScrollbarWidth: 21 } });
    expect(JSON.stringify(evidence)).not.toContain("TM | Flow");
  }, 20_000);
});
