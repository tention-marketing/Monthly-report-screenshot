import { afterEach, describe, expect, it } from "vitest";
import { prepareSubscriberGrowthDocument, type SubscriberGrowthCaptureRequest } from "./subscriber-growth-capture.js";
import { installSubscriberGrowthFixture, removeSubscriberGrowthFixture, type SubscriberGrowthFixtureOptions } from "./subscriber-growth-fixture.js";

const ACCOUNT = "Northwind Goods";
const capture = (period: { startDate: string; endDate: string }, overrides: Partial<SubscriberGrowthCaptureRequest> = {}): SubscriberGrowthCaptureRequest => ({ purpose: "capture", period, clientName: ACCOUNT, readinessTimeoutMs: 8_000, stability: { sampleIntervalMs: 5, requiredStableSamples: 3, timeoutMs: 1_500 }, ...overrides });
const source: SubscriberGrowthCaptureRequest = { purpose: "source", period: null, clientName: null, readinessTimeoutMs: 8_000, stability: { sampleIntervalMs: 5, requiredStableSamples: 3, timeoutMs: 500 } };
const september = { startDate: "2026-09-01", endDate: "2026-09-30" };
const august = { startDate: "2026-08-01", endDate: "2026-08-31" };
/** The live state of 2026-10-29: /people/subscribers, Overview selected, Last 7 days, with a working date picker. */
const live = (options: SubscriberGrowthFixtureOptions = {}) => installSubscriberGrowthFixture({ picker: "inputs", ...options });
afterEach(removeSubscriberGrowthFixture);

describe("Section 10 capture from the live starting state (Overview · Last 7 days)", () => {
  it("prepares Email → Growth and September 1–30, then captures the full card with exact counts and both charts", async () => {
    const page = live();
    const result = await prepareSubscriberGrowthDocument(capture(september));
    expect(result).toMatchObject({
      ok: true, sourceUrl: "https://www.klaviyo.com/people/subscribers", detectedPeriod: "09/01/2026 – 09/30/2026", periodEvidence: september,
      evidence: { channel: "email", view: "growth", emailSubscribers: 17_698, newSubscribers: 943, exclusions: 499, charts: { subscriberGrowthLine: true, newSubscribersExclusionsBar: true }, visiblePeriodText: "09/01/2026 – 09/30/2026" },
    });
    expect(page.clicks).toEqual(["Email", "Apply"]);
    expect(page.state).toEqual({ channel: "Email", view: "Growth", period: "09/01/2026 – 09/30/2026" });
    // The crop is the whole reporting area: date selector, Email tab, Growth view, all three metrics, both charts.
    const crop = document.querySelector("[data-tention-subscriber-growth='capture']")!;
    for (const part of ["#date", "#channels [aria-selected=true]", "#views [aria-selected=true]", "#line", "#bar"]) expect(crop.querySelector(part), part).not.toBeNull();
    expect(crop.querySelectorAll(".metric")).toHaveLength(3);
  });

  it("selects Growth when Klaviyo opens Email on another view", async () => {
    const page = live({ channel: "Email", view: "Opt-in sources" });
    await expect(prepareSubscriberGrowthDocument(capture(august))).resolves.toMatchObject({ ok: true, periodEvidence: august });
    expect(page.clicks).toEqual(["Growth", "Apply"]);
  });

  it("makes no unnecessary clicks when Email → Growth and the month are already showing", async () => {
    const page = live({ channel: "Email", view: "Growth", period: "Aug 1 – Aug 31, 2026" });
    await expect(prepareSubscriberGrowthDocument(capture(august))).resolves.toMatchObject({ ok: true, detectedPeriod: "Aug 1 – Aug 31, 2026" });
    expect(page.clicks).toEqual([]);
  });

  it("survives React replacing the DOM after every click, with metrics and charts arriving late", async () => {
    const page = live({ renderDelayMs: 300, metricsDelayMs: 400, chartsDelayMs: 900 });
    await expect(prepareSubscriberGrowthDocument(capture(september))).resolves.toMatchObject({ ok: true, evidence: { emailSubscribers: 17_698 } });
    expect(page.clicks).toEqual(["Email", "Apply"]);
  });

  it.each([
    ["June 2026", { startDate: "2026-06-01", endDate: "2026-06-30" }, "06/01/2026 – 06/30/2026"],
    ["July 2026", { startDate: "2026-07-01", endDate: "2026-07-31" }, "07/01/2026 – 07/31/2026"],
    ["August 2026", august, "08/01/2026 – 08/31/2026"],
    ["September 2026", september, "09/01/2026 – 09/30/2026"],
    ["February 2026", { startDate: "2026-02-01", endDate: "2026-02-28" }, "02/01/2026 – 02/28/2026"],
    ["February 2028", { startDate: "2028-02-01", endDate: "2028-02-29" }, "02/01/2028 – 02/29/2028"],
  ] as const)("sets and proves %s from Last 7 days", async (_label, period, shown) => {
    live();
    await expect(prepareSubscriberGrowthDocument(capture(period))).resolves.toMatchObject({ ok: true, periodEvidence: period, detectedPeriod: shown });
  });
});

describe("Section 10 capture fails closed", () => {
  const short = { readinessTimeoutMs: 1_500 };
  it("keeps another period instead of capturing it", async () => {
    live({ picker: "inert", period: "Jul 1 – Jul 31, 2026", channel: "Email" });
    await expect(prepareSubscriberGrowthDocument(capture(august, short))).resolves.toMatchObject({ ok: false, code: "REPORT_PERIOD_NOT_CONFIRMED", diagnostics: { periodProof: { parsedStart: "2026-07-01", periodMatch: false } } });
    expect(document.querySelector("[data-tention-subscriber-growth]")).toBeNull();
  });
  it("cannot set a period without a date control", async () => {
    live({ picker: "none", period: "Jul 1 – Jul 31, 2026", channel: "Email" });
    await expect(prepareSubscriberGrowthDocument(capture(august, short))).resolves.toMatchObject({ ok: false, code: "SUBSCRIBER_GROWTH_DATE_CONTROL_NOT_FOUND" });
  });
  it("reports a missing Growth view", async () => {
    live({ channel: "Email", view: "Opt-in sources", hasGrowthView: false });
    await expect(prepareSubscriberGrowthDocument(capture(august, short))).resolves.toMatchObject({ ok: false, code: "SUBSCRIBER_GROWTH_VIEW_NOT_FOUND" });
  });
  it("reports a page without an Email tab as not the Subscriber growth page", async () => {
    const page = live({ hasEmailTab: false });
    await expect(prepareSubscriberGrowthDocument(capture(august, short))).resolves.toMatchObject({ ok: false, code: "SUBSCRIBER_GROWTH_PAGE_NOT_READY" });
    expect(page.clicks).toEqual([]);
  });
  it("reports Email or Growth that Klaviyo never shows as selected", async () => {
    live({ tabsRespond: false });
    await expect(prepareSubscriberGrowthDocument(capture(august, short))).resolves.toMatchObject({ ok: false, code: "SUBSCRIBER_GROWTH_EMAIL_TAB_NOT_SELECTED" });
  });
  it("requires all three metrics, and exact whole numbers", async () => {
    live({ metrics: { Exclusions: null } });
    await expect(prepareSubscriberGrowthDocument(capture(august, short))).resolves.toMatchObject({ ok: false, code: "SUBSCRIBER_GROWTH_METRICS_NOT_RENDERED" });
    removeSubscriberGrowthFixture(); live({ metrics: { "Email subscribers": "17.7K" } });
    await expect(prepareSubscriberGrowthDocument(capture(august, short))).resolves.toMatchObject({ ok: false, code: "SUBSCRIBER_GROWTH_METRIC_NOT_EXACT" });
  });
  it.each([["the line chart is missing", { lineChart: false }], ["the bar chart is missing", { barChart: "none" as const }], ["the bar chart is still blank", { barChart: "empty" as const }]])("does not capture when %s", async (_label, options) => {
    live(options);
    await expect(prepareSubscriberGrowthDocument(capture(august, short))).resolves.toMatchObject({ ok: false, code: "SUBSCRIBER_GROWTH_CHART_NOT_RENDERED" });
  });
  it("does not capture while a spinner is showing", async () => {
    live({ spinner: true });
    await expect(prepareSubscriberGrowthDocument(capture(august, short))).resolves.toMatchObject({ ok: false, code: "SUBSCRIBER_GROWTH_NOT_STABLE", diagnostics: { loading: true } });
  });
  it("requires the report client's Klaviyo account", async () => {
    const page = live({ account: "Another Brand" });
    await expect(prepareSubscriberGrowthDocument(capture(august, short))).resolves.toMatchObject({ ok: false, code: "SUBSCRIBER_GROWTH_ACCOUNT_UNPROVEN" });
    expect(page.clicks).toEqual([]);
  });
});

describe("Section 10 stability on the live page (run a42cdfd6)", () => {
  /** Stubs document.getAnimations with one running animation on an element inside the card. */
  const animation = (iterations: number) => {
    Object.defineProperty(document, "getAnimations", { configurable: true, value: () => {
      const target = document.querySelector("#date") ?? document.body;
      return [{ playState: "running", effect: { target, getTiming: () => ({ iterations }) } }];
    } });
  };
  afterEach(() => { delete (document as { getAnimations?: unknown }).getAnimations; });

  it("captures while a looping refresh icon spins beside the date range", async () => {
    live(); animation(Infinity);
    await expect(prepareSubscriberGrowthDocument(capture(august))).resolves.toMatchObject({ ok: true, periodEvidence: august });
  });
  it("waits for an animation that never finishes and names it, instead of a bare 'not stable'", async () => {
    live(); animation(1);
    await expect(prepareSubscriberGrowthDocument(capture(august, { readinessTimeoutMs: 4_000 }))).resolves.toMatchObject({ ok: false, code: "SUBSCRIBER_GROWTH_NOT_STABLE", diagnostics: { unstableReasons: { animationRunning: expect.any(Number) }, animationTargets: ["button#date"] } });
  });
  it("names the part that keeps changing", async () => {
    live({ channel: "Email", view: "Growth", period: "Aug 1 – Aug 31, 2026" });
    await new Promise((resolve) => setTimeout(resolve, 0));
    let tick = 17_000;
    const timer = setInterval(() => { const value = document.querySelector(".metric strong"); if (value) value.textContent = String(tick++); }, 2);
    const result = await prepareSubscriberGrowthDocument(capture(august));
    clearInterval(timer);
    expect(result).toMatchObject({ ok: false, code: "SUBSCRIBER_GROWTH_NOT_STABLE", diagnostics: { unstableReasons: { "changed:metrics": expect.any(Number) } } });
  });
});

describe("Section 10 screenshot bounds", () => {
  it.each([
    ["a 1920×1080 viewport", { width: 1920, height: 1080 }],
    ["a tall viewport", { width: 1920, height: 1600 }],
    ["a narrower viewport beside the side panel", { width: 1300, height: 1000 }],
  ])("crops the whole card without clipping in %s", async (_label, viewport) => {
    live({ viewport });
    const result = await prepareSubscriberGrowthDocument(capture(september));
    expect(result).toMatchObject({ ok: true });
    if (!result.ok || !("targetRect" in result)) throw new Error("expected a capture");
    const { x, y, width, height, viewportWidth, viewportHeight } = result.targetRect;
    expect(x).toBeGreaterThanOrEqual(0); expect(y).toBeGreaterThanOrEqual(0);
    expect(x + width).toBeLessThanOrEqual(viewportWidth); expect(y + height).toBeLessThanOrEqual(viewportHeight);
  });
  it("scrolls a card that starts below the fold into view", async () => {
    live({ contentTop: 1_400 });
    await expect(prepareSubscriberGrowthDocument(capture(september))).resolves.toMatchObject({ ok: true, targetRect: { y: 10 } });
  });
  it("hides Klaviyo's floating composer over the card for the screenshot, without clicking it", async () => {
    const page = live({ composer: true, viewport: { width: 1300, height: 1000 } });
    await expect(prepareSubscriberGrowthDocument(capture(september))).resolves.toMatchObject({ ok: true, diagnostics: { hiddenOverlays: 1 } });
    expect(page.composer?.style.visibility).toBe("hidden");
    expect(page.clicks).toEqual(["Email", "Apply"]);
  });
  it("refuses a card taller than the visible tab rather than clipping it", async () => {
    live({ viewport: { width: 1920, height: 700 } });
    await expect(prepareSubscriberGrowthDocument(capture(september))).resolves.toMatchObject({ ok: false, code: "TARGET_BOUNDS_INVALID" });
  });
});

describe("one-time source setup on the page (purpose: source)", () => {
  it("reproduces the live state: from Overview · Last 7 days it selects Email → Growth and returns the stable address", async () => {
    const page = live();
    await expect(prepareSubscriberGrowthDocument(source)).resolves.toEqual({ ok: true, purpose: "source", sourceUrl: "https://www.klaviyo.com/people/subscribers", emailSelected: true, growthSelected: true, accountLabels: [`Account menu ${ACCOUNT}`], selections: ["Email"] });
    // Source setup never touches the date: "Last 7 days" is an acceptable starting state.
    expect(page.state).toEqual({ channel: "Email", view: "Growth", period: "Last 7 days" });
    expect(page.clicks).toEqual(["Email"]);
  });
  it("survives delayed React rendering during setup", async () => {
    live({ view: "Exclusion sources", renderDelayMs: 300, metricsDelayMs: 300 });
    await expect(prepareSubscriberGrowthDocument(source)).resolves.toMatchObject({ ok: true, selections: ["Email", "Growth"] });
  });
  it("needs no clicks when Email → Growth is already open", async () => {
    const page = live({ channel: "Email", view: "Growth" });
    await expect(prepareSubscriberGrowthDocument(source)).resolves.toMatchObject({ ok: true, selections: [] });
    expect(page.clicks).toEqual([]);
  });
  it("switches away from Text message", async () => {
    live({ channel: "Text message" });
    await expect(prepareSubscriberGrowthDocument(source)).resolves.toMatchObject({ ok: true, selections: ["Email"] });
  });
  it("never clicks anything on a page that is not Subscriber growth (e.g. the Profiles table)", async () => {
    const page = live({ heading: "Profiles", hasEmailTab: false, path: "/people" });
    await expect(prepareSubscriberGrowthDocument({ ...source, readinessTimeoutMs: 1_000 })).resolves.toMatchObject({ ok: false, code: "SUBSCRIBER_GROWTH_SOURCE_WRONG_PAGE" });
    expect(page.clicks).toEqual([]);
  });
  it("fails with a bounded typed error when the metrics never render", async () => {
    live({ metrics: { "New subscribers": null } });
    await expect(prepareSubscriberGrowthDocument({ ...source, readinessTimeoutMs: 1_500 })).resolves.toMatchObject({ ok: false, code: "SUBSCRIBER_GROWTH_METRICS_NOT_RENDERED", diagnostics: { missing: ["new subscribers"] } });
  });
  it("reports a missing Email tab with a typed failure", async () => {
    live({ hasEmailTab: false });
    await expect(prepareSubscriberGrowthDocument({ ...source, readinessTimeoutMs: 1_000 })).resolves.toMatchObject({ ok: false, code: "SUBSCRIBER_GROWTH_SOURCE_WRONG_PAGE" });
  });
});
