import { afterEach, describe, expect, it, vi } from "vitest";

// Status filtering, re-render polling, and three agreeing table reads take a few seconds of real time.
vi.setConfig({ testTimeout: 30_000 });
import { createScreenshotSourceProof, screenshotSourceProofSchema } from "@tention/report-schema";
import { prepareCampaignsCaptureDocument, TOP_CAMPAIGN_ROW_COUNT, type CampaignsAdapterResult, type CampaignsCaptureRequest } from "./campaigns-capture.js";

const request: CampaignsCaptureRequest = { clientName: "Acme Home", clientTimezone: "America/New_York", conversionMetric: "Placed Order", desiredCount: 3, period: { startDate: "2026-08-01", endDate: "2026-08-31" } };
const reportPeriod = { ...request.period, previousStartDate: "2026-07-01", previousEndDate: "2026-07-31" };

function rect(left = 10, top = 20, width = 400, height = 40): DOMRect {
  return { x: left, y: top, width, height, left, top, right: left + width, bottom: top + height, toJSON: () => ({}) } as DOMRect;
}

/** A generic Campaigns listing as Klaviyo renders it: dates are display text, not ISO. */
function campaignsPage(given: Array<[name: string, status: string, type: string, sendDate: string, revenue: string]>): void {
  // The header is marked descending, so — like a real sorted Klaviyo view — the rows are rendered in that order.
  const amount = (value: string) => Number(value.replace(/[^0-9.]/g, "")) || -1;
  const rows = [...given].sort((a, b) => amount(b[4]) - amount(a[4]));
  window.history.replaceState({}, "", "/omnicampaigns?appBarNav=true");
  document.body.innerHTML = `<header><button aria-label="Account Menu">Acme Home</button></header><main><h1>Campaigns</h1>
    <button id="period" aria-label="Date range">Last 30 days</button>
    <div id="dialog" hidden><button>Custom</button><input name="startDate" aria-label="Start date" value="" placeholder="MM/DD/YYYY" /><input name="endDate" aria-label="End date" value="" placeholder="MM/DD/YYYY" /><button id="apply">Apply</button></div>
    <button aria-label="Conversion metric">Placed Order</button><p id="range"></p>
    <table><thead><tr><th>Campaign</th><th>Status</th><th>Type</th><th>Send date</th><th>Open rate</th><th>Click rate</th><th aria-sort="descending">Placed Order</th></tr></thead>
    <tbody>${rows.map((cells) => `<tr>${cells.map((cell, index) => index === 3 ? `<td>${cell}</td><td>40%</td><td>2%</td>` : `<td>${cell}</td>`).join("")}</tr>`).join("")}</tbody></table></main>`;
  installStatusFilter();
  document.getElementById("period")!.addEventListener("click", () => document.getElementById("dialog")!.removeAttribute("hidden"));
  document.getElementById("apply")!.addEventListener("click", () => {
    window.history.replaceState({}, "", `/omnicampaigns?appBarNav=true&startDate=${request.period.startDate}&endDate=${request.period.endDate}`);
    document.getElementById("range")!.textContent = "Aug 1, 2026 – Aug 31, 2026";
    document.getElementById("period")!.textContent = "Aug 1, 2026 – Aug 31, 2026";
    document.getElementById("dialog")!.setAttribute("hidden", "");
  });
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) { return this.closest("[hidden]") ? rect(0, 0, 0, 0) : rect(); });
}

/**
 * Klaviyo's Status filter: a "Status" chip opens a listbox of statuses; choosing options and closing it (Escape)
 * re-renders the table asynchronously with only the chosen statuses, and the chip then names the selection.
 */
/** Document-level fixture listeners are removed after each test so one test's Klaviyo model never leaks into the next. */
let documentListeners = new AbortController();
function installStatusFilter(renderDelayMs = 250): void {
  const main = document.querySelector("main")!;
  main.insertAdjacentHTML("afterbegin", `<button id="status-filter">Status</button><div id="status-menu" role="listbox" hidden>${["Draft", "Scheduled", "Sent", "Canceled"].map((status) => `<div role="option" aria-selected="false">${status}</div>`).join("")}</div>`);
  const menu = document.getElementById("status-menu")!; const chip = document.getElementById("status-filter")!;
  chip.addEventListener("click", () => menu.removeAttribute("hidden"));
  for (const option of Array.from(menu.children)) option.addEventListener("click", () => option.setAttribute("aria-selected", option.getAttribute("aria-selected") === "true" ? "false" : "true"));
  document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape" || menu.hasAttribute("hidden")) return;
    menu.setAttribute("hidden", "");
    const chosen = Array.from(menu.children).filter((option) => option.getAttribute("aria-selected") === "true").map((option) => option.textContent!);
    chip.textContent = chosen.length ? `Status: ${chosen.join(", ")}` : "Status";
    window.setTimeout(() => {
      const column = Array.from(document.querySelectorAll("thead th")).findIndex((header) => header.textContent!.trim() === "Status");
      for (const row of Array.from(document.querySelectorAll("tbody tr"))) if (chosen.length && !chosen.includes(row.children[column]!.textContent!.trim())) row.remove();
    }, renderDelayMs);
  }, { signal: documentListeners.signal });
}

/** Chrome's executeScript({ func }) serializes only the function source: no module scope survives. */
function asChromeInjects(): typeof prepareCampaignsCaptureDocument {
  return new Function("request", `return (${prepareCampaignsCaptureDocument.toString()})(request);`) as typeof prepareCampaignsCaptureDocument;
}

const liveLikeRows: Array<[string, string, string, string, string]> = [
  ["Labor Day — Early Access", "Sent", "Email", "Aug 28, 2026 10:00 AM", "$4,210.50"],
  ["Summer Clearance", "Sent", "Email", "Aug 14, 2026 9:00 AM", "$9,800.00"],
  ["Draft idea", "Draft", "Email", "", "$0.00"],
  ["SMS Flash", "Sent", "SMS", "Aug 5, 2026 6:00 PM", "$1,050.25"],
  ["Old blast", "Sent", "Email", "Aug 2, 2026 11:00 AM", "$300.00"],
];

afterEach(() => {
  documentListeners.abort(); documentListeners = new AbortController();
  vi.restoreAllMocks(); document.body.innerHTML = ""; window.history.replaceState({}, "", "/");
  // Tests that model Klaviyo's load-on-scroll install their own scrollIntoView; jsdom has none of its own.
  delete (HTMLElement.prototype as { scrollIntoView?: unknown }).scrollIntoView;
});

describe("Campaigns adapter as Chrome injects it", () => {
  it("runs as a self-contained serialized function", async () => {
    campaignsPage(liveLikeRows);
    const result = await asChromeInjects()(request);
    expect(result.ok ? "ok" : `${result.code}: ${result.message}`).toBe("ok");
    expect(result).toMatchObject({ ok: true, evidence: { includedRowCount: 3, eligibleRowCount: 4 } });
  });

  it("emits evidence the API source-proof contract accepts unchanged", async () => {
    campaignsPage(liveLikeRows);
    const result = await asChromeInjects()(request) as Extract<CampaignsAdapterResult, { ok: true }>;
    expect(result.ok).toBe(true);
    expect(result.evidence.rows.map(({ name, placedOrderValue }) => [name, placedOrderValue])).toEqual([["Summer Clearance", 9800], ["Labor Day — Early Access", 4210.5], ["SMS Flash", 1050.25]]);
    expect(result.evidence.rows.map(({ sendDate }) => sendDate)).toEqual(["2026-08-14", "2026-08-28", "2026-08-05"]);
    const proof = createScreenshotSourceProof("top_campaigns", reportPeriod, undefined, result.evidence);
    expect(screenshotSourceProofSchema.safeParse(JSON.parse(JSON.stringify(proof))).success).toBe(true);
  });

  // Boundary-day rows rank below the August rows (a visible July/September row between ranked rows fails the
  // crop guard); they must still be excluded from eligibility in every machine timezone.
  it.each(["Asia/Kolkata", "America/Los_Angeles", "UTC"])("ranks by the client's calendar day, not the %s machine day", async (machineZone) => {
    const originalTz = process.env.TZ; process.env.TZ = machineZone;
    try {
      campaignsPage([
        ["Late July", "Sent", "Email", "Jul 31, 2026 11:59 PM", "$2.00"],
        ["First of August", "Sent", "Email", "Aug 1, 2026 2:00 AM", "$500.00"],
        ["Last of August", "Sent", "SMS", "Aug 31, 2026 11:30 PM", "$400.00"],
        ["Early September", "Sent", "Email", "Sep 1, 2026 12:01 AM", "$1.00"],
        ["Mid August", "Sent", "Email", "Aug 10, 2026 9:00 AM", "$300.00"],
      ]);
      const outcome = await asChromeInjects()(request);
      expect(outcome.ok ? "ok" : `${outcome.code}: ${outcome.message}`).toBe("ok");
      const result = outcome as Extract<CampaignsAdapterResult, { ok: true }>;
      expect(result.evidence.eligibleRowCount).toBe(3);
      expect(result.evidence.rows.map(({ name, sendDate }) => [name, sendDate])).toEqual([["First of August", "2026-08-01"], ["Last of August", "2026-08-31"], ["Mid August", "2026-08-10"]]);
    } finally { if (originalTz === undefined) delete process.env.TZ; else process.env.TZ = originalTz; }
  });

  // Live run 7e2beafa: the adapter ran before Klaviyo's React listing had rendered and failed
  // three times within about a second. It must wait (bounded) for the page, then the table.
  it("waits for a Campaigns listing that renders several seconds after navigation", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date", "requestAnimationFrame"] });
    try {
      campaignsPage(liveLikeRows);
      const heading = document.querySelector("h1")!; const table = document.querySelector("table")!;
      heading.remove(); table.remove();
      const result = asChromeInjects()(request);
      await vi.advanceTimersByTimeAsync(4_000);
      document.querySelector("main")!.prepend(heading);
      await vi.advanceTimersByTimeAsync(3_000);
      document.querySelector("main")!.append(table);
      await vi.advanceTimersByTimeAsync(5_000);
      const outcome = await result;
      expect(outcome.ok ? "ok" : `${outcome.code}: ${outcome.message}`).toBe("ok");
      expect(outcome).toMatchObject({ evidence: { includedRowCount: 3, eligibleRowCount: 4 } });
    } finally { vi.useRealTimers(); }
  });

  it("fails as not ready, with diagnostics, only after the bounded wait expires", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date", "requestAnimationFrame"] });
    try {
      campaignsPage(liveLikeRows);
      document.querySelector("h1")!.remove();
      let settled = false;
      const result = asChromeInjects()(request).then((value) => { settled = true; return value; });
      await vi.advanceTimersByTimeAsync(20_000);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(6_000);
      await expect(result).resolves.toMatchObject({ ok: false, code: "CAMPAIGNS_PAGE_NOT_READY", diagnostics: { title: expect.any(String), headings: expect.any(Array), tables: 1 } });
    } finally { vi.useRealTimers(); }
  });

  it("waits until the ranked rows read identically before capturing", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date", "requestAnimationFrame"] });
    try {
      campaignsPage(liveLikeRows);
      const cell = document.querySelector("tbody tr td:last-child")!;
      // Data is still arriving: the first row's revenue keeps changing for ~2 seconds.
      let ticks = 0;
      const update = () => { ticks += 1; if (ticks < 5) { cell.textContent = `$${9800 + ticks}.00`; window.setTimeout(update, 450); } };
      window.setTimeout(update, 0);
      const result = asChromeInjects()(request);
      await vi.advanceTimersByTimeAsync(60_000);
      const outcome = await result;
      expect(outcome.ok ? "ok" : `${outcome.code}: ${outcome.message}`).toBe("ok");
      expect(ticks).toBe(5);
    } finally { vi.useRealTimers(); }
  });

  // Live run 51a52ed4: no control was labelled as a date range. The listing opened with the
  // report period in its startDate/endDate query is accepted once that exact range is visible.
  /** The live page from run d95d6aee: the URL already applied August, shown on a compact "Date range" chip. */
  function liveAugustListing(rows = liveLikeRows): void {
    campaignsPage(rows);
    document.getElementById("dialog")!.remove();
    window.history.replaceState({}, "", `/omnicampaigns?appBarNav=true&startDate=${request.period.startDate}&endDate=${request.period.endDate}`);
    const period = document.getElementById("period")!; period.removeAttribute("aria-label"); period.textContent = "August 1 – 31, 2026";
    period.insertAdjacentHTML("afterend", `<button aria-label="Clear Date range filter">×</button>`);
    period.parentElement!.insertAdjacentHTML("afterbegin", `<button id="suggestion">Review performance See what drove results in the last 30 days.</button>
      <section><h2>Email performance</h2><button id="card-period">Last 30 days</button></section>`);
    const wrap = document.createElement("div"); period.before(wrap); wrap.append(period, period.nextElementSibling!);
    const filters = document.createElement("div"); wrap.before(filters); filters.append(wrap);
    const listing = document.createElement("div"); filters.before(listing); listing.append(filters, document.querySelector("table")!);
  }

  it("proves the period from Klaviyo's live compact chip \"August 1 – 31, 2026\" and captures the August Top 3", async () => {
    liveAugustListing([...liveLikeRows, ["Cancelled promo", "Cancelled", "Email", "Aug 20, 2026 10:00 AM", "$99,999.00"]]);
    let clicked = false;
    for (const id of ["suggestion", "card-period", "period"]) document.getElementById(id)!.addEventListener("click", () => { clicked = true; });
    const outcome = await asChromeInjects()(request);
    expect(outcome.ok ? "ok" : `${outcome.code}: ${outcome.message} ${JSON.stringify(outcome.diagnostics)}`).toBe("ok");
    expect(clicked).toBe(false);
    expect(outcome).toMatchObject({ ok: true, observedPeriod: { startDate: "2026-08-01", endDate: "2026-08-31" }, evidence: { includedRowCount: 3, eligibleRowCount: 4 },
      targetRect: { periodProof: { expectedStart: "2026-08-01", expectedEnd: "2026-08-31", visiblePeriodText: "August 1 – 31, 2026", parsedStart: "2026-08-01", parsedEnd: "2026-08-31", periodControlRequeried: true, periodMatch: true } } });
    if (outcome.ok) expect(outcome.evidence.rows.map((row) => row.name)).toEqual(["Summer Clearance", "Labor Day — Early Access", "SMS Flash"]);
  });

  it("reads Klaviyo's `display: contents` table rows (no box of their own) by their cells, as in run 925e12a9", async () => {
    liveAugustListing([...liveLikeRows, ["Cancelled promo", "Cancelled", "Email", "Aug 20, 2026 10:00 AM", "$99,999.00"]]);
    const header = document.querySelector("thead tr")!; header.setAttribute("role", "row"); header.insertAdjacentHTML("afterbegin", "<th>Check All Rows</th>"); header.insertAdjacentHTML("beforeend", "<th>Actions</th>");
    for (const row of Array.from(document.querySelectorAll("tbody tr"))) { row.insertAdjacentHTML("afterbegin", "<td><input type=checkbox aria-label=Select></td>"); row.insertAdjacentHTML("beforeend", "<td><button>Actions</button></td>"); }
    for (const row of Array.from(document.querySelectorAll("tr"))) (row as HTMLElement).style.display = "contents";
    vi.restoreAllMocks();
    // Only cells have boxes; each row's cells sit on their own 40px line.
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      if (this.closest("[hidden]") || this.tagName === "TR") return rect(0, 0, 0, 0);
      const row = this.closest("tr"); const index = row ? Array.from(document.querySelectorAll("tr")).indexOf(row) : -1;
      return index >= 0 ? rect(0, 200 + index * 40, 1200, 40) : rect();
    });
    const outcome = await asChromeInjects()(request);
    expect(outcome.ok ? "ok" : `${outcome.code}: ${outcome.message} ${JSON.stringify(outcome.diagnostics)}`).toBe("ok");
    if (!outcome.ok) return;
    expect(outcome.evidence.rows.map((row) => [row.name, row.placedOrderValue])).toEqual([["Summer Clearance", 9800], ["Labor Day — Early Access", 4210.5], ["SMS Flash", 1050.25]]);
    expect(outcome.targetRect.height).toBeGreaterThan(40);
    expect(outcome.targetRect.width).toBeGreaterThan(20);
  });

  it("does not mistake suggestion cards that mention \"next\" for a pager (run 0c2c6035)", async () => {
    liveAugustListing();
    document.querySelector("main")!.insertAdjacentHTML("afterbegin", ["Audit my campaigns Catch issues before your next sends go out.", "Improve click rates Find what to change in your next sends.", "Plan my calendar Map out the next few weeks of campaigns."].map((value) => `<button>${value}</button>`).join(""));
    const outcome = await asChromeInjects()(request);
    expect(outcome.ok ? "ok" : `${outcome.code}: ${JSON.stringify(outcome.diagnostics)}`).toBe("ok");
  });

  it("still refuses an unproven Top 3 when a real enabled Next page control shows more results", async () => {
    liveAugustListing([["Summer Clearance", "Sent", "Email", "Aug 14, 2026 9:00 AM", "$9,800.00"], ["Old blast", "Sent", "Email", "Aug 2, 2026 11:00 AM", "$300.00"]]);
    document.querySelector("table")!.insertAdjacentHTML("afterend", `<nav aria-label="Pagination"><span>1–25 of 60</span><button aria-label="Next page">›</button></nav>`);
    const outcome = await asChromeInjects()(request);
    expect(outcome).toMatchObject({ ok: false, code: "TOP_CAMPAIGNS_INCOMPLETE_RESULT_SET", diagnostics: { pagination: { nextControls: ["Next page"], counts: ["1–25 of 60"], eligibleRowCount: 2 } } });
  });

  /** Live table shape: Placed Order has no aria-sort; a sort button inside the header re-renders the rows. */
  function unsortedLiveTable(rows: Array<[string, string, string, string, string]>): void {
    liveAugustListing(rows);
    const header = Array.from(document.querySelectorAll("th")).find((th) => th.textContent === "Placed Order")!;
    header.removeAttribute("aria-sort"); header.innerHTML = `<button>Placed Order</button>`;
    // Unsorted, as Klaviyo first renders the listing (send-date order).
    const body = document.querySelector("tbody")!;
    for (const [name] of rows) body.append(Array.from(body.children).find((row) => row.children[0]!.textContent === name)!);
    const value = (row: Element) => Number((row.children[6]?.textContent ?? "").replace(/[^0-9.]/g, "")) || -1;
    let direction = 0;
    header.querySelector("button")!.addEventListener("click", () => {
      direction = direction === 0 ? 1 : -direction; // first click ascending, then descending
      window.setTimeout(() => {
        const body = document.querySelector("tbody")!;
        Array.from(body.children).sort((a, b) => direction * (value(a) - value(b))).forEach((row) => body.append(row));
      }, 300);
    });
  }

  it("proves Klaviyo's own Placed Order sort from the re-rendered order when the header exposes no aria-sort", async () => {
    unsortedLiveTable(liveLikeRows);
    const outcome = await asChromeInjects()(request);
    expect(outcome.ok ? "ok" : `${outcome.code}: ${JSON.stringify(outcome.diagnostics)}`).toBe("ok");
    if (!outcome.ok) return;
    expect(outcome.evidence.rankingMethod).toBe("klaviyo-native-sort");
    expect(outcome.evidence.rows.map((row) => row.placedOrderValue)).toEqual([9800, 4210.5, 1050.25]);
    expect(outcome.targetRect.ranking).toMatchObject({ sort: { clicks: 2, stateAfterClick1: "ascending", stateAfterClick2: "descending", rankingMethod: "klaviyo-native-sort" } });
    // Sorted, the Top 3 are the first rows: the first three body rows carry exactly those values.
    expect(Array.from(document.querySelectorAll("tbody tr")).slice(0, 3).map((row) => row.children[6]!.textContent)).toEqual(["$9,800.00", "$4,210.50", "$1,050.25"]);
  });

  it("loads every row before ranking without a sort, and refuses a crop when the true top campaign loaded below others", async () => {
    liveAugustListing(liveLikeRows);
    Array.from(document.querySelectorAll("th")).find((th) => th.textContent === "Placed Order")!.removeAttribute("aria-sort");
    let appended = false;
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", { configurable: true, value(this: HTMLElement) {
      if (this.tagName === "TR" && !appended) { appended = true; this.parentElement!.insertAdjacentHTML("beforeend", `<tr><td>Early August Flash</td><td>Sent</td><td>Email</td><td>Aug 1, 2026 9:00 AM</td><td>40%</td><td>2%</td><td>$12,500.00</td></tr>`); }
    } });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date", "requestAnimationFrame"] });
    let outcome: Awaited<ReturnType<typeof prepareCampaignsCaptureDocument>>;
    try { const result = asChromeInjects()(request); await vi.advanceTimersByTimeAsync(60_000); outcome = await result; } finally { vi.useRealTimers(); }
    // Every row is loaded (the appended $12,500 campaign is found), but it renders below the others: a contiguous
    // crop of the table would not show the Top 3 in descending order, so nothing is captured.
    expect(outcome).toMatchObject({ ok: false, code: "TOP_CAMPAIGNS_SORT_UNPROVEN" });
    expect(document.querySelectorAll("tbody tr")).toHaveLength(5);
  });

  it("fails closed when the list keeps loading more rows and no sort proves the Top 3", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date", "requestAnimationFrame"] });
    try {
      liveAugustListing(liveLikeRows);
      Array.from(document.querySelectorAll("th")).find((th) => th.textContent === "Placed Order")!.removeAttribute("aria-sort");
      let extra = 0;
      Object.defineProperty(HTMLElement.prototype, "scrollIntoView", { configurable: true, value(this: HTMLElement) {
        if (this.tagName === "TR") { extra += 1; this.parentElement!.insertAdjacentHTML("beforeend", `<tr><td>Loaded ${extra}</td><td>Sent</td><td>Email</td><td>Aug 3, 2026 9:00 AM</td><td>40%</td><td>2%</td><td>$10.00</td></tr>`); }
      } });
      const result = asChromeInjects()(request);
      await vi.advanceTimersByTimeAsync(60_000);
      await expect(result).resolves.toMatchObject({ ok: false, code: "TOP_CAMPAIGNS_INCOMPLETE_RESULT_SET", diagnostics: { completeness: { required: true, settled: false } } });
    } finally { vi.useRealTimers(); }
  });

  it("does not trust a descending marker over unsorted rows (run 65304473) and never captures them", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date", "requestAnimationFrame"] });
    try {
      liveAugustListing();
      // Klaviyo marks the column but leaves the rows in send-date order; each click cycles none → ascending → descending → none.
      const header = Array.from(document.querySelectorAll("th")).find((th) => th.textContent === "Placed Order")!;
      header.setAttribute("aria-sort", "none"); header.innerHTML = `<button>Placed Order</button>`;
      const cycle = ["none", "ascending", "descending"];
      header.querySelector("button")!.addEventListener("click", () => header.setAttribute("aria-sort", cycle[(cycle.indexOf(header.getAttribute("aria-sort")!) + 1) % 3]!));
      const body = document.querySelector("tbody")!;
      for (const [name] of liveLikeRows) body.append(Array.from(body.children).find((row) => row.children[0]!.textContent === name)!);
      const result = asChromeInjects()(request);
      await vi.advanceTimersByTimeAsync(60_000);
      const outcome = await result;
      expect(outcome).toMatchObject({ ok: false, code: "TOP_CAMPAIGNS_SORT_UNPROVEN" });
    } finally { vi.useRealTimers(); }
  });

  it("returns a typed, serializable failure instead of throwing when the adapter hits an exception", async () => {
    campaignsPage(liveLikeRows);
    const result = await asChromeInjects()(null as never);
    expect(result).toMatchObject({ ok: false, code: "KLAVIYO_PAGE_ADAPTER_ERROR", diagnostics: { failureStage: "UNCAUGHT_EXCEPTION", errorName: "TypeError", stack: expect.any(String), currentUrl: expect.stringContaining("/omnicampaigns") } });
    expect(JSON.parse(JSON.stringify(result))).toEqual(result);
  });

  describe("Top Campaigns is Sent-only evidence", () => {
    const augustRows: Array<[string, string, string, string, string]> = [
      ["TM | SMS | Labor Day Savings Event", "Sent", "SMS", "Aug 30, 2026 6:30 PM", "$7,179.98"],
      ["TM | The Best Seat in the House: Recliners", "Canceled", "Email", "Aug 26, 2026 7:15 PM", "—"],
      ["TM | Labor day Savings Event | Handcrafted Luxury", "Sent", "Email", "Aug 28, 2026 6:45 PM", "$0.00"],
      ["TM | End of Summer Sale coming to an end", "Sent", "Email", "Aug 18, 2026 6:00 PM", "$16,599.86"],
      ["TM | End of Summer Savings Event", "Draft", "Email", "Aug 9, 2026 9:24 PM", "—"],
      ["TM | Extended Sitewide Savings Spectacular", "Sent", "Email", "Aug 5, 2026 1:30 PM", "$10,248.42"],
    ];
    /** Send-date order with an unsorted header; clicking it sorts ascending, then descending, after a re-render. */
    function sendDateOrderedListing(): void {
      campaignsPage(augustRows);
      const body = document.querySelector("tbody")!;
      for (const [name] of augustRows) body.append(Array.from(body.children).find((row) => row.children[0]!.textContent === name)!);
      const header = Array.from(document.querySelectorAll("th")).find((th) => th.textContent === "Placed Order")!;
      header.setAttribute("aria-sort", "none"); header.innerHTML = `<button>Placed Order</button>`;
      const value = (row: Element) => Number((row.children[6]?.textContent ?? "").replace(/[^0-9.]/g, "")) || -1;
      let direction = 0;
      header.querySelector("button")!.addEventListener("click", () => {
        direction = direction === 0 ? 1 : -direction;
        window.setTimeout(() => { Array.from(body.children).sort((a, b) => direction * (value(a) - value(b))).forEach((row) => body.append(row)); header.setAttribute("aria-sort", direction < 0 ? "descending" : "ascending"); }, 400);
      });
    }

    it("waits for the Sent-only filter to re-render, sorts Placed Order descending, and captures only the Top 3 Sent rows", async () => {
      sendDateOrderedListing();
      const outcome = await asChromeInjects()(request);
      expect(outcome.ok ? "ok" : `${outcome.code}: ${outcome.message}`).toBe("ok");
      if (!outcome.ok) return;
      expect(outcome.evidence.rows.map((row) => [row.name, row.placedOrderValue])).toEqual([
        ["TM | End of Summer Sale coming to an end", 16599.86], ["TM | Extended Sitewide Savings Spectacular", 10248.42], ["TM | SMS | Labor Day Savings Event", 7179.98],
      ]);
      expect(outcome.evidence.rankingMethod).toBe("klaviyo-native-sort");
      expect(document.getElementById("status-filter")).toHaveTextContent("Status: Sent");
      // What the crop shows: the first three rendered rows, all Sent, in descending Placed Order.
      const shown = Array.from(document.querySelectorAll("tbody tr")).slice(0, 3).map((row) => [row.children[0]!.textContent, row.children[1]!.textContent]);
      expect(shown).toEqual([["TM | End of Summer Sale coming to an end", "Sent"], ["TM | Extended Sitewide Savings Spectacular", "Sent"], ["TM | SMS | Labor Day Savings Event", "Sent"]]);
      expect(Array.from(document.querySelectorAll("tbody tr")).every((row) => row.children[1]!.textContent === "Sent")).toBe(true);
    });

    it("fails without capturing when a Canceled row remains in the table after the Status filter", async () => {
      sendDateOrderedListing();
      // A filter that never removes the Canceled campaign.
      document.addEventListener("keydown", () => window.setTimeout(() => {
        const body = document.querySelector("tbody")!;
        if (!Array.from(body.children).some((row) => row.children[1]!.textContent === "Canceled")) body.insertAdjacentHTML("afterbegin", `<tr><td>Canceled promo</td><td>Canceled</td><td>Email</td><td>Aug 20, 2026 10:00 AM</td><td>—</td><td>—</td><td>—</td></tr>`);
      }, 600), { signal: documentListeners.signal });
      const outcome = await asChromeInjects()(request);
      expect(outcome).toMatchObject({ ok: false, code: "TOP_CAMPAIGNS_STATUS_FILTER_NOT_APPLIED" });
    });

    /**
     * A second, deliberately different Status filter model: a non-button chip named only by aria-label that opens
     * on pointerdown (like Radix menus), a menu that renders 1.5 s late with checkbox options and an Apply button,
     * and React replacing the whole table body after Apply. The chip then reads "Sent".
     */
    function checkboxStatusFilter(options: { opens?: boolean } = {}): void {
      document.getElementById("status-filter")!.remove(); document.getElementById("status-menu")!.remove();
      const main = document.querySelector("main")!;
      main.insertAdjacentHTML("afterbegin", `<div id="status-chip" role="button" tabindex="0" aria-label="Filter by status" aria-haspopup="menu"><span>Status</span><svg></svg></div>`);
      const chip = document.getElementById("status-chip")!;
      chip.addEventListener("pointerdown", () => {
        if (options.opens === false || document.getElementById("status-popover")) return;
        window.setTimeout(() => {
          document.body.insertAdjacentHTML("beforeend", `<div id="status-popover" data-popper-placement="bottom">${["Draft", "Scheduled", "Sent", "Canceled"].map((status) => `<label><input type="checkbox" /><span>${status}</span></label>`).join("")}<button>Apply</button></div>`);
          const popover = document.getElementById("status-popover")!;
          popover.querySelector("button")!.addEventListener("click", () => {
            const chosen = Array.from(popover.querySelectorAll("label")).filter((option) => option.querySelector("input")!.checked).map((option) => option.textContent!.trim());
            popover.remove(); chip.querySelector("span")!.textContent = chosen.length === 1 ? chosen[0]! : `Status (${chosen.length})`;
            window.setTimeout(() => {
              const body = document.querySelector("tbody")!;
              const replacement = body.cloneNode(true) as HTMLElement;
              for (const row of Array.from(replacement.children)) if (!chosen.includes(row.children[1]!.textContent!.trim())) row.remove();
              body.replaceWith(replacement);
            }, 1_200);
          });
        }, 1_500);
      });
    }
    const mixedRows: Array<[string, string, string, string, string]> = [
      ["Sent A", "Sent", "Email", "Aug 18, 2026 6:00 PM", "$16,599.86"], ["Canceled B", "Canceled", "Email", "Aug 17, 2026 6:00 PM", "—"],
      ["Sent C", "Sent", "Email", "Aug 5, 2026 1:30 PM", "$10,248.42"], ["Draft D", "Draft", "Email", "", "—"],
      ["Sent E", "Sent", "SMS", "Aug 30, 2026 6:30 PM", "$7,179.98"],
    ];

    it("opens a late-rendering Status menu, selects only Sent, applies, and waits for React's replaced table", async () => {
      campaignsPage(mixedRows); checkboxStatusFilter();
      // Unrelated "Sent" text already on the page is not mistaken for an open menu.
      document.querySelector("main")!.insertAdjacentHTML("beforeend", `<aside><span>Sent</span></aside>`);
      const outcome = await asChromeInjects()(request);
      expect(outcome.ok ? "ok" : `${outcome.code}: ${JSON.stringify(outcome.diagnostics)}`).toBe("ok");
      if (!outcome.ok) return;
      const rendered = Array.from(document.querySelectorAll("tbody tr")).map((row) => row.children[1]!.textContent);
      expect(rendered).toEqual(["Sent", "Sent", "Sent"]);
      expect(document.getElementById("status-chip")).toHaveTextContent("Sent");
      expect(outcome.evidence.rows.map((row) => [row.name, row.placedOrderValue])).toEqual([["Sent A", 16599.86], ["Sent C", 10248.42], ["Sent E", 7179.98]]);
      expect(outcome.targetRect.ranking).toMatchObject({ sort: { statusFilter: { STATUS_CONTROL_FOUND: true, MENU_OPENED: true, SENT_OPTION_FOUND: true, SENT_OPTION_STATE_BEFORE: "unchecked", SENT_CLICKED: true, APPLY_REQUIRED: true, APPLY_CLICKED: true, STATUS_TEXT_AFTER: "Sent", SENT_ROWS: 3, CANCELLED_ROWS: 0, DRAFT_ROWS: 0, SCHEDULED_ROWS: 0, uiStateProof: "status-chip-names-sent" } } });
    });

    it("records every Status step and fails with an exact code when the menu never opens", async () => {
      campaignsPage(mixedRows); checkboxStatusFilter({ opens: false });
      const outcome = await asChromeInjects()(request);
      expect(outcome).toMatchObject({ ok: false, code: "TOP_CAMPAIGNS_STATUS_MENU_NOT_OPENED", diagnostics: { statusFilter: {
        STATUS_CONTROL_FOUND: true, STATUS_TEXT_BEFORE: "Status", STATUS_CLICKED: true, MENU_OPENED: false, SENT_OPTION_FOUND: false,
        SENT_ROWS: 3, CANCELLED_ROWS: 1, DRAFT_ROWS: 1, SCHEDULED_ROWS: 0, EXACT_FAILURE_CODE: "TOP_CAMPAIGNS_STATUS_MENU_NOT_OPENED",
      } } });
    });

    it("captures the Top 5 Sent campaigns by default, with all five rows inside the crop and in the structured evidence", async () => {
      const sent = [16599.86, 10248.42, 7179.98, 5913.55, 5221.54, 2289.99, 0].map((value, index) => [`Sent ${index + 1}`, "Sent", "Email", `Aug ${index + 2}, 2026 9:00 AM`, `$${value.toLocaleString("en-US", { minimumFractionDigits: 2 })}`] as [string, string, string, string, string]);
      campaignsPage([...sent, ["Canceled X", "Canceled", "Email", "Aug 20, 2026 9:00 AM", "—"], ["Draft Y", "Draft", "Email", "", "—"], ["Scheduled Z", "Scheduled", "Email", "Sep 2, 2026 9:00 AM", "—"]]);
      // Real row geometry: each data row is its own 50 px line below the filters and header.
      const original = HTMLElement.prototype.getBoundingClientRect;
      vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
        const row = this.closest("tbody tr");
        if (row) { const index = Array.from(row.parentElement!.children).indexOf(row); return rect(10, 120 + index * 50, 900, 50); }
        return original.call(this);
      });
      const outcome = await asChromeInjects()({ ...request, desiredCount: TOP_CAMPAIGN_ROW_COUNT });
      expect(outcome.ok ? "ok" : `${outcome.code}: ${outcome.message}`).toBe("ok");
      if (!outcome.ok) return;
      expect(outcome.evidence.rows.map((row) => [row.name, row.placedOrderValue])).toEqual([["Sent 1", 16599.86], ["Sent 2", 10248.42], ["Sent 3", 7179.98], ["Sent 4", 5913.55], ["Sent 5", 5221.54]]);
      expect(outcome.evidence).toMatchObject({ includedRowCount: 5, eligibleRowCount: 7 });
      expect(outcome.targetRect).toMatchObject({ includedRowCount: 5, availableRowCount: 7 });
      // The crop reaches the bottom of row five (120 + 4 × 50 + 50) and stops before row six.
      expect(outcome.targetRect.y + outcome.targetRect.height).toBe(370);
      expect(Array.from(document.querySelectorAll("tbody tr")).every((row) => row.children[1]!.textContent === "Sent")).toBe(true);
    });

    it("captures the actual one or two Sent campaigns, and reports typed NO_DATA when none are Sent", async () => {
      campaignsPage([["Only Sent", "Sent", "Email", "Aug 3, 2026 9:00 AM", "$50.00"], ["Draft one", "Draft", "Email", "", "—"]]);
      const one = await asChromeInjects()(request);
      expect(one.ok && one.evidence.rows.map((row) => row.name)).toEqual(["Only Sent"]);
      document.body.innerHTML = ""; vi.restoreAllMocks();
      campaignsPage([["Draft one", "Draft", "Email", "", "—"], ["Canceled one", "Canceled", "Email", "Aug 3, 2026 9:00 AM", "—"]]);
      await expect(asChromeInjects()(request)).resolves.toMatchObject({ ok: false, code: "TOP_CAMPAIGNS_NO_DATA" });
    });
  });

  it("reads the campaign name from its link and an icon-only Type as Email/SMS from its accessible name, or null — never an empty string", async () => {
    campaignsPage(liveLikeRows);
    for (const row of Array.from(document.querySelectorAll("tbody tr"))) {
      const [nameCell, , typeCell] = Array.from(row.children);
      const name = nameCell!.textContent!;
      nameCell!.innerHTML = `<a href="#">${name}</a><div>TM | Potential Purchasers |, TM | Engaged 360 days</div><button hidden>Add to Composer</button>`;
      typeCell!.innerHTML = name === "SMS Flash" ? `<svg><title>Text message</title></svg>` : name === "Summer Clearance" ? `<span aria-label="Email"></span>` : `<svg></svg>`;
    }
    const outcome = await asChromeInjects()(request);
    expect(outcome.ok ? "ok" : outcome.code).toBe("ok");
    const result = outcome as Extract<CampaignsAdapterResult, { ok: true }>;
    expect(result.evidence.rows.map(({ name, type }) => [name, type])).toEqual([["Summer Clearance", "Email"], ["Labor Day — Early Access", null], ["SMS Flash", "SMS"]]);
    expect(result.evidence.rows.some(({ type }) => type === "")).toBe(false);
    const proof = createScreenshotSourceProof("top_campaigns", reportPeriod, undefined, result.evidence);
    expect(screenshotSourceProofSchema.safeParse(JSON.parse(JSON.stringify(proof))).success).toBe(true);
  });

  it("re-queries the chip after React replaces it, and fails with the observed and parsed period when it shows another range", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date", "requestAnimationFrame"] });
    try {
      liveAugustListing();
      const stale = document.getElementById("period")!;
      const replacement = stale.cloneNode(true) as HTMLElement; replacement.textContent = "August 1 – 30, 2026"; stale.replaceWith(replacement);
      const result = asChromeInjects()(request);
      await vi.advanceTimersByTimeAsync(60_000);
      const outcome = await result;
      expect(outcome).toMatchObject({ ok: false, diagnostics: { periodProof: { expectedStart: "2026-08-01", expectedEnd: "2026-08-31", visiblePeriodText: "August 1 – 30, 2026", parsedStart: "2026-08-01", parsedEnd: "2026-08-30", periodControlRequeried: true, periodMatch: false } } });
    } finally { vi.useRealTimers(); }
  });

  it("does not trust URL dates the page does not visibly show, and records the controls it saw", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date", "requestAnimationFrame"] });
    try {
      campaignsPage(liveLikeRows);
      document.getElementById("period")!.remove(); document.getElementById("dialog")!.remove();
      window.history.replaceState({}, "", `/omnicampaigns?appBarNav=true&startDate=${request.period.startDate}&endDate=${request.period.endDate}`);
      document.getElementById("range")!.textContent = "Last 30 days";
      const result = asChromeInjects()(request);
      await vi.advanceTimersByTimeAsync(30_000);
      await expect(result).resolves.toMatchObject({ ok: false, code: "CAMPAIGNS_DATE_CONTROL_NOT_FOUND", diagnostics: { controls: expect.arrayContaining(["Conversion metric Placed Order"]) } });
    } finally { vi.useRealTimers(); }
  });

  /** Klaviyo's live control: a "Last 30 days" button whose picker offers presets, Custom, and a calendar or fields. */
  function liveDatePicker(kind: "inputs" | "calendar", applyWorks = true): void {
    campaignsPage(liveLikeRows);
    const period = document.getElementById("period")!; period.removeAttribute("aria-label"); period.textContent = "Last 30 days";
    const dialog = document.getElementById("dialog")!;
    let shown = new Date(Date.UTC(2026, 9, 1));
    const monthName = () => new Intl.DateTimeFormat("en-US", { timeZone: "UTC", month: "long", year: "numeric" }).format(shown);
    const renderCalendar = () => {
      const days = new Date(Date.UTC(shown.getUTCFullYear(), shown.getUTCMonth() + 1, 0)).getUTCDate();
      const cells = Array.from({ length: days }, (_, index) => { const day = new Date(Date.UTC(shown.getUTCFullYear(), shown.getUTCMonth(), index + 1)); return `<button aria-label="${new Intl.DateTimeFormat("en-US", { timeZone: "UTC", month: "long", day: "numeric", year: "numeric" }).format(day)}">${index + 1}</button>`; }).join("");
      dialog.querySelector("#calendar")!.innerHTML = `<button aria-label="Previous month">‹</button><span>${monthName()}</span><button aria-label="Next month">›</button><div role="grid">${cells}</div>`;
      dialog.querySelector("[aria-label='Previous month']")!.addEventListener("click", () => { shown = new Date(Date.UTC(shown.getUTCFullYear(), shown.getUTCMonth() - 1, 1)); renderCalendar(); });
      dialog.querySelector("[aria-label='Next month']")!.addEventListener("click", () => { shown = new Date(Date.UTC(shown.getUTCFullYear(), shown.getUTCMonth() + 1, 1)); renderCalendar(); });
    };
    dialog.setAttribute("role", "dialog");
    dialog.innerHTML = `<ul><li>Last 7 days</li><li>Last 30 days</li><li id="custom">Custom</li></ul><div id="custom-panel" hidden>${kind === "inputs" ? '<input aria-label="Start date" placeholder="MM/DD/YYYY" /><input aria-label="End date" placeholder="MM/DD/YYYY" />' : '<div id="calendar"></div>'}</div><button id="apply">Apply</button>`;
    dialog.querySelector("#custom")!.addEventListener("click", () => { dialog.querySelector("#custom-panel")!.removeAttribute("hidden"); if (kind === "calendar") renderCalendar(); });
    dialog.querySelector("#apply")!.addEventListener("click", () => {
      if (!applyWorks) return;
      // React re-renders the filter and the table some time after Apply.
      window.setTimeout(() => { period.textContent = "Aug 1, 2026 – Aug 31, 2026"; document.getElementById("range")!.textContent = "Aug 1, 2026 – Aug 31, 2026"; dialog.setAttribute("hidden", ""); }, 1_500);
    });
  }

  it.each(["inputs", "calendar"] as const)("sets Aug 1–31 through a %s picker opened from \"Last 30 days\" and waits for Klaviyo to confirm it", async (kind) => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date", "requestAnimationFrame"] });
    try {
      liveDatePicker(kind);
      const result = asChromeInjects()(request);
      await vi.advanceTimersByTimeAsync(15_000);
      const outcome = await result;
      expect(outcome.ok ? "ok" : `${outcome.code}: ${outcome.message} ${JSON.stringify((outcome as { diagnostics?: unknown }).diagnostics)}`).toBe("ok");
      expect(document.getElementById("period")!.textContent).toBe("Aug 1, 2026 – Aug 31, 2026");
      expect(outcome).toMatchObject({ evidence: { includedRowCount: 3 } });
    } finally { vi.useRealTimers(); }
  });

  it("fails closed with full date diagnostics when Apply does not change the period", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date", "requestAnimationFrame"] });
    try {
      liveDatePicker("inputs", false);
      const result = asChromeInjects()(request);
      await vi.advanceTimersByTimeAsync(40_000);
      await expect(result).resolves.toMatchObject({ ok: false, code: "REPORT_PERIOD_NOT_CONFIRMED", diagnostics: { date: {
        dateControlFound: true, dateControlTextBefore: "Last 30 days", dateDialogOpened: true, datePickerStructure: { kind: "inputs" },
        startValueAttempted: "2026-08-01", endValueAttempted: "2026-08-31", applyFound: true, applyClicked: true, dateControlTextAfter: "Last 30 days", observedPeriodAfter: "Last 30 days",
      }, periodProof: { expectedStart: "2026-08-01", expectedEnd: "2026-08-31", visiblePeriodText: "Last 30 days", parsedStart: null, parsedEnd: null, periodControlRequeried: true, periodMatch: false } } });
    } finally { vi.useRealTimers(); }
  });
});
