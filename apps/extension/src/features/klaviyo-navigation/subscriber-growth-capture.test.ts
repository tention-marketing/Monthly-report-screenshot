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
  it("does not capture while a spinner is showing over the metrics (a real loading state is PAGE_NOT_READY)", async () => {
    live({ spinner: true });
    await expect(prepareSubscriberGrowthDocument(capture(august, short))).resolves.toMatchObject({ ok: false, code: "SUBSCRIBER_GROWTH_PAGE_NOT_READY", diagnostics: { failedCondition: "visibleLoadingElements", readiness: { visibleLoadingElements: ["div"] } } });
    expect(document.querySelector("[data-tention-subscriber-growth]")).toBeNull();
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
  // Regression (Club Furniture Sep 2026, captured 2026-11-03): the reporting area stretched to the bottom of a tall window,
  // so the crop carried ~800 px of blank page plus Klaviyo's floating AI prompt below the Email subscribers card.
  it("crops at the bottom of the Email subscribers card, leaving out blank page and the AI prompt below it", async () => {
    const page = live({ viewport: { width: 1440, height: 1600 }, contentHeight: 1_550, composer: true });
    const result = await prepareSubscriberGrowthDocument(capture(september));
    expect(result.ok ? "ok" : `${result.code}: ${result.message}`).toBe("ok");
    if (!result.ok || !("targetRect" in result)) return;
    const { y, height } = result.targetRect;
    const bottom = y + height;
    // Everything the section proves is inside: title, Email tab and date range at the top, both charts at the bottom.
    expect(y).toBeLessThanOrEqual(document.getElementById("date")!.getBoundingClientRect().top);
    expect(bottom).toBeGreaterThanOrEqual(document.getElementById("bar")!.getBoundingClientRect().bottom);
    expect(bottom).toBeGreaterThanOrEqual(document.getElementById("content")!.getBoundingClientRect().bottom);
    // ...and nothing far below the card: the old crop ran to the reporting area's 1,550 px bottom.
    expect(bottom - document.getElementById("content")!.getBoundingClientRect().bottom).toBeLessThanOrEqual(12);
    expect(height).toBeLessThan(900);
    expect(result.diagnostics).toMatchObject({ trimmedBelowCard: expect.any(Number), hiddenOverlays: 0 });
    expect(Number(result.diagnostics.trimmedBelowCard)).toBeGreaterThan(700);
    // The AI prompt sits in the trimmed blank space, so it is neither in the crop nor touched.
    expect(page.composer!.getBoundingClientRect().top).toBeGreaterThan(bottom);
    expect(page.composer!.style.visibility).toBe("");
  });
  it("refuses a card taller than the visible tab rather than clipping it", async () => {
    live({ viewport: { width: 1920, height: 700 } });
    await expect(prepareSubscriberGrowthDocument(capture(september))).resolves.toMatchObject({ ok: false, code: "TARGET_BOUNDS_INVALID" });
  });
});

describe("account candidates", () => {
  it("reads the account name wherever the header shows it, not only from header buttons (Steven Dann live layout)", async () => {
    live();
    // Klaviyo renders the switcher as avatar initials plus the name in plain header elements.
    document.querySelector("header")!.innerHTML = `<div class="account-switcher"><span>ST</span><span>Steven Dann</span></div>`;
    for (const element of document.querySelectorAll("header *")) (element as HTMLElement).getBoundingClientRect = () => ({ x: 0, y: 0, top: 0, left: 0, right: 120, bottom: 20, width: 120, height: 20, toJSON: () => ({}) });
    const result = await prepareSubscriberGrowthDocument(source);
    expect(result).toMatchObject({ ok: true, purpose: "source" });
    expect("accountLabels" in result ? result.accountLabels.join(" | ") : "").toMatch(/steven dann/i);
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

/**
 * Regression: Purely Nutrient, October 2026, run 8fa3b760 (2026-11-11). Sections 1–9 passed; Section 10 failed 5 attempts
 * with SUBSCRIBER_GROWTH_PAGE_NOT_READY although the page was visibly ready. Diagnostics showed headings
 * ["Subscriber growth", "Email subscribers", "34,487", "Subscriber growth", "882", "44", "Changes to subscribers"] and
 * tabs.channel = []: this email-only account has no Overview | Email | Text message tabs, and the old readiness predicate
 * required them.
 */
describe("Section 10 readiness on the email-only layout (Purely Nutrient, run 8fa3b760)", () => {
  const october = { startDate: "2026-10-01", endDate: "2026-10-31" };
  const PURELY = "Purely Nutrient";
  const purely = (options: SubscriberGrowthFixtureOptions = {}) => installSubscriberGrowthFixture({ picker: "inputs", layout: "email-only", account: PURELY, periodFormat: "long", ...options });
  const run = (overrides: Partial<SubscriberGrowthCaptureRequest> = {}) => prepareSubscriberGrowthDocument(capture(october, { clientName: PURELY, ...overrides }));
  const short = { readinessTimeoutMs: 1_500 };
  const visibleHeadings = () => Array.from(document.querySelectorAll("h1,h2,h3")).map((node) => node.textContent);

  it("1. reproduces the live structure: same headings, no channel tabs, Growth selected, Last 7 days", () => {
    purely();
    expect(visibleHeadings()).toEqual(["Subscriber growth", "Email subscribers", "34,487", "Subscriber growth", "882", "44", "Changes to subscribers"]);
    expect(document.querySelector("#channels")).toBeNull();
    expect(document.querySelector("#views [aria-selected=true]")?.textContent).toBe("Growth");
    expect(document.getElementById("date")?.textContent).toBe("Last 7 days");
  });

  it("2 + 12. is PAGE READY with Last 7 days, sets Oct 1–31, verifies it, and captures the exact counts", async () => {
    const page = purely();
    const result = await run();
    expect(result).toMatchObject({
      ok: true, detectedPeriod: "October 1 – 31, 2026", periodEvidence: october,
      evidence: { channel: "email", view: "growth", emailSubscribers: 34_487, newSubscribers: 882, exclusions: 44, visiblePeriodText: "October 1 – 31, 2026" },
      diagnostics: {
        periodBefore: "Last 7 days", periodAfter: "October 1 – 31, 2026", periodProof: { periodMatch: true },
        readiness: { ready: true, pageIdentityFound: true, emailSubscribersHeadingFound: true, channelLayout: "email-only", emailTabFound: false, growthTabFound: true, growthTabSelected: true, subscriberValueFound: true, newSubscribersValueFound: true, exclusionsValueFound: true, visibleLoadingElements: [], periodShown: "Last 7 days" },
      },
    });
    if (!result.ok || !("diagnostics" in result)) return;
    expect((result.diagnostics.readiness as { chartBounds: Array<{ width: number; height: number }> }).chartBounds.every(({ width, height }) => width > 0 && height > 0)).toBe(true);
    // Only the date range was changed; nothing that is not a tab or the picker was clicked.
    expect(page.clicks).toEqual(["Apply"]);
    expect(page.state.period).toBe("October 1 – 31, 2026");
    const crop = document.querySelector("[data-tention-subscriber-growth='capture']")!;
    for (const part of ["#date", "#views [aria-selected=true]", "#head h2", "#line", "#bar"]) expect(crop.querySelector(part), part).not.toBeNull();
    if ("targetRect" in result) expect(result.targetRect.visibleControls[0]).toEqual({ text: "Email subscribers", selected: true, kind: "email-only-card" });
  });

  it("3. ignores a hidden spinner still in the DOM (display:none, aria-hidden, zero size)", async () => {
    purely({ cardExtras: `<div class="Spinner-module" style="display:none"></div><div role="progressbar" aria-hidden="true"></div><div class="skeleton-row" data-rect="40,60,0,0"></div>` });
    await expect(run()).resolves.toMatchObject({ ok: true, diagnostics: { readiness: { visibleLoadingElements: [] } } });
  });

  it("4. ignores an unrelated refresh icon beside the date range", async () => {
    purely({ pageExtras: `<span class="LastUpdated-refresh-spinner" data-rect="1200,0,16,16"></span>` });
    await expect(run()).resolves.toMatchObject({ ok: true, periodEvidence: october });
  });

  it("5. ignores a visible tooltip over the metrics", async () => {
    purely({ cardExtras: `<div role="tooltip" data-rect="40,60,300,60">New subscribers: profiles that opted in <span class="tooltip-spinner"></span></div>` });
    await expect(run()).resolves.toMatchObject({ ok: true, evidence: { newSubscribers: 882 } });
  });

  it("6. needs no tab clicks when Growth is already selected", async () => {
    const page = purely({ view: "Growth" });
    await expect(run()).resolves.toMatchObject({ ok: true });
    expect(page.clicks.filter((click) => click !== "Apply")).toEqual([]);
  });

  it("7. selects Growth when the card opens on another view", async () => {
    const page = purely({ view: "Opt-in sources" });
    await expect(run()).resolves.toMatchObject({ ok: true, evidence: { exclusions: 44 } });
    expect(page.clicks).toEqual(["Growth", "Apply"]);
  });

  it("8. waits for metrics and charts that render after an async delay", async () => {
    purely({ renderDelayMs: 200, metricsDelayMs: 600, chartsDelayMs: 900 });
    await expect(run()).resolves.toMatchObject({ ok: true, evidence: { emailSubscribers: 34_487 } });
  });

  it("9. a real skeleton covering the card is PAGE_NOT_READY and names the loading element", async () => {
    purely({ cardExtras: `<div class="skeleton-block" data-rect="40,60,600,300"></div>` });
    await expect(run(short)).resolves.toMatchObject({ ok: false, code: "SUBSCRIBER_GROWTH_PAGE_NOT_READY", diagnostics: { failedCondition: "visibleLoadingElements", readiness: { pageIdentityFound: true, growthTabSelected: true, visibleLoadingElements: ["div.skeleton-block"] } } });
  });

  it("10. requires a chart area with non-zero visible bounds", async () => {
    purely({ lineChart: false, barChart: "none" });
    await expect(run(short)).resolves.toMatchObject({ ok: false, code: "SUBSCRIBER_GROWTH_CHART_NOT_RENDERED", diagnostics: { failedCondition: "chartBounds", readiness: { chartBounds: [], subscriberValueFound: true } } });
  });

  it("11. a ready page showing the wrong period fails as REPORT_PERIOD_NOT_CONFIRMED, never PAGE_NOT_READY", async () => {
    purely({ picker: "inert", period: "Sep 1 – Sep 30, 2026" });
    const result = await run(short);
    expect(result).toMatchObject({ ok: false, code: "REPORT_PERIOD_NOT_CONFIRMED", diagnostics: { readiness: { ready: true }, periodProof: { parsedStart: "2026-09-01", periodMatch: false } } });
    expect(document.querySelector("[data-tention-subscriber-growth]")).toBeNull();
  });

  it("still refuses a Text message card that has no channel tabs", async () => {
    purely();
    document.querySelector("#head h2")!.textContent = "Text message subscribers";
    await expect(run(short)).resolves.toMatchObject({ ok: false, code: "SUBSCRIBER_GROWTH_PAGE_NOT_READY", diagnostics: { readiness: { emailSubscribersHeadingFound: false } } });
  });

  it("source setup accepts the email-only page without clicking anything", async () => {
    const page = purely();
    await expect(prepareSubscriberGrowthDocument(source)).resolves.toMatchObject({ ok: true, purpose: "source", emailSelected: true, growthSelected: true, selections: [] });
    expect(page.clicks).toEqual([]);
  });
});

/**
 * Windows + Chrome, Steven Dann October 2026: sections 1–9 PASS, Section 10 failed 5/5 with
 * SUBSCRIBER_GROWTH_TARGET_OCCLUDED (TARGET_OBSCURED) while Klaviyo's "Ask Composer" sat over the lower card. The same
 * page passed on macOS, whose taller window keeps the card above the Composer.
 */
describe("Windows Subscriber Growth occlusion: Ask Composer handled automatically, never captured through", () => {
  type Occlusion = { viewport: Record<string, unknown>; passes: Array<Record<string, unknown>>; targetRect: { x: number; y: number; w: number; h: number }; occluders: Array<{ kind: string; action: string; element: string; text: string; rect: { x: number; y: number; w: number; h: number }; intersectionArea: number; intersectionPercentage: number }> };
  const october = { startDate: "2026-10-01", endDate: "2026-10-31" };
  const run = async (options: SubscriberGrowthFixtureOptions) => {
    const page = live(options);
    const result = await prepareSubscriberGrowthDocument(capture(october));
    return { page, result, occlusion: (result as { diagnostics?: { occlusion?: Occlusion } }).diagnostics?.occlusion };
  };
  /** The crop is inside the painted area and nothing outside the card is painted over it. */
  const expectClearCrop = (result: Awaited<ReturnType<typeof prepareSubscriberGrowthDocument>>, viewport: { width: number; height: number }, scrollbar = 0, dockTop = viewport.height) => {
    expect(result.ok ? "ok" : `${result.code}: ${JSON.stringify((result as { diagnostics?: { occlusion?: unknown } }).diagnostics?.occlusion ?? null).slice(0, 1_200)}`).toBe("ok");
    if (!result.ok || !("targetRect" in result)) return;
    const { x, y, width, height } = result.targetRect;
    expect(x).toBeGreaterThanOrEqual(0); expect(y).toBeGreaterThanOrEqual(0);
    expect(x + width).toBeLessThanOrEqual(viewport.width - scrollbar); expect(y + height).toBeLessThanOrEqual(dockTop);
    const composer = document.getElementById("composer");
    const shown = composer && composer.isConnected && composer.getBoundingClientRect().width > 0 && getComputedStyle(composer.closest("[data-tention-hidden-overlay]") ?? composer).opacity !== "0";
    if (shown) { const box = composer!.getBoundingClientRect(); expect(box.top >= y + height || box.bottom <= y || box.left >= x + width || box.right <= x).toBe(true); }
  };
  // Composer bar floating over the bottom of the card, as observed live (fixed position relative to the window).
  const overBottom = (width: number, height: number): [number, number, number, number] => [Math.round(width / 2) - 300, height - 140, 600, 64];

  it("1. no overlay: captures with nothing hidden", async () => {
    const { result, occlusion } = await run({ viewport: { width: 1503, height: 937 }, scrollbar: 17, channel: "Email" });
    expectClearCrop(result, { width: 1503, height: 937 }, 17);
    expect(result.ok && "diagnostics" in result && result.diagnostics).toMatchObject({ hiddenOverlays: 0, collapsedDocks: 0 });
    expect(occlusion?.occluders).toEqual([]);
  });

  it("2. Ask Composer (fixed bar in a static wrapper) over the bottom of the card is identified, measured and hidden — never clicked", async () => {
    const { page, result, occlusion } = await run({ viewport: { width: 1503, height: 937 }, scrollbar: 17, composer: true, composerKind: "wrapped", composerRect: overBottom, channel: "Email" });
    expectClearCrop(result, { width: 1503, height: 937 }, 17);
    const composer = occlusion!.occluders.find((item) => item.kind === "composer")!;
    expect(composer).toMatchObject({ action: "hidden", element: expect.stringContaining("composer-wrapper"), text: expect.stringContaining("Ask Composer") });
    expect(composer.intersectionArea).toBeGreaterThan(0); expect(composer.intersectionPercentage).toBeGreaterThan(0);
    expect(composer.rect).toEqual({ x: 452, y: 797, w: 600, h: 64 });
    expect(occlusion!.viewport).toMatchObject({ innerWidth: 1503, innerHeight: 937, layoutWidth: 1486, devicePixelRatio: 1 });
    expect(page.clicks).toEqual(["Apply"]);
  });

  it("2b. the pre-fix rule (hide only an out-of-card element that is itself positioned) would have refused this exact page", async () => {
    const { result } = await run({ viewport: { width: 1503, height: 937 }, scrollbar: 17, composer: true, composerKind: "wrapped", composerRect: overBottom, channel: "Email" });
    expect(result.ok).toBe(true);
    const wrapper = document.getElementById("composer-wrapper")!;
    expect(getComputedStyle(wrapper).position === "fixed" || getComputedStyle(wrapper).position === "absolute").toBe(false);
  });

  it("3. a floating Composer partially overlapping the chart is hidden and the crop re-verified", async () => {
    const { result, occlusion } = await run({ viewport: { width: 1544, height: 960 }, scrollbar: 19, composer: true, composerRect: (width) => [width - 520, 500, 340, 100], channel: "Email" });
    expectClearCrop(result, { width: 1544, height: 960 }, 19);
    expect(occlusion!.occluders).toEqual([expect.objectContaining({ action: "hidden", element: "aside#composer" })]);
    expect(occlusion!.occluders[0]!.intersectionPercentage).toBeLessThan(10);
  });

  it("4. a tooltip over the chart is hidden as non-report UI", async () => {
    const { result, occlusion } = await run({ viewport: { width: 1503, height: 937 }, scrollbar: 17, tooltip: true, channel: "Email" });
    expectClearCrop(result, { width: 1503, height: 937 }, 17);
    expect(occlusion!.occluders).toEqual([expect.objectContaining({ kind: "non-report-ui", action: "hidden", element: "div#tip" })]);
  });

  it("5. the Composer re-rendered by Klaviyo after it was hidden is found again and hidden again before capture", async () => {
    const { result, occlusion } = await run({ viewport: { width: 1503, height: 937 }, scrollbar: 17, composer: true, composerKind: "wrapped", composerRect: overBottom, composerRerenders: 1, channel: "Email" });
    expectClearCrop(result, { width: 1503, height: 937 }, 17);
    expect(occlusion!.occluders.filter((item) => item.kind === "composer" && item.action === "hidden")).toHaveLength(2);
  });

  it("6 + 8. docked Composer on a short Windows window: the scroll area ends above it, so the dock is collapsed and the card placed in the clear area", async () => {
    const viewport = { width: 1503, height: 937 };
    const { page, result, occlusion } = await run({ viewport, scrollbar: 17, composer: true, composerKind: "docked", channel: "Email" });
    expectClearCrop(result, viewport, 17);
    expect(occlusion!.occluders).toEqual([expect.objectContaining({ kind: "composer", action: "collapsed-dock", text: expect.stringContaining("Ask Composer") })]);
    expect(page.composer!.style.display).toBe("none");
    // Report content is never touched.
    expect(document.querySelector("[data-tention-hidden-overlay]")?.id).toBe("composer");
  });

  it("6b. docked Composer on a tall window: the card fits above the dock, so it is scrolled into the clear area and the dock is left alone", async () => {
    const viewport = { width: 1754, height: 1300 };
    const { page, result } = await run({ viewport, composer: true, composerKind: "docked", contentTop: 1_400, channel: "Email" });
    expectClearCrop(result, viewport, 0, viewport.height - 120);
    expect(page.composer!.style.display).toBe("");
  });

  it("7. geometry that changes after the scroll (content above grows) is re-measured before verification", async () => {
    const viewport = { width: 1442, height: 1000 };
    const { result, occlusion } = await run({ viewport, scrollbar: 21, composer: true, composerKind: "wrapped", composerRect: overBottom, contentTop: 1_400, growAfterScroll: 90, channel: "Email" });
    expectClearCrop(result, viewport, 21);
    expect(occlusion!.passes.length).toBeGreaterThanOrEqual(2);
  });

  it.each([
    ["9. Windows 125% display scaling, Chrome 80%", { width: 1442, height: 1000 }, 21, 1],
    ["10. Windows Chrome 100%", { width: 1503, height: 937 }, 17, 1],
    ["11. Windows Chrome 90%", { width: 1544, height: 960 }, 19, 1.125],
    ["12. Windows Chrome 80%", { width: 1737, height: 1080 }, 21, 1],
    ["13. side panel open (narrow window)", { width: 1180, height: 900 }, 17, 1.25],
    ["14. macOS (overlay scrollbars, Retina)", { width: 1754, height: 1586 }, 0, 2],
  ] as const)("%s: Ask Composer over the card is handled and the crop is clear", async (_name, viewport, scrollbar, dpr) => {
    const { result, occlusion } = await run({ viewport, scrollbar, devicePixelRatio: dpr, composer: true, composerKind: "wrapped", composerRect: (width, height) => [Math.round(width / 2) - 300, Math.min(height - 140, 760), 600, 64], channel: "Email" });
    expectClearCrop(result, viewport, scrollbar);
    expect(occlusion!.viewport).toMatchObject({ innerWidth: viewport.width, layoutWidth: viewport.width - scrollbar, devicePixelRatio: dpr });
  });

  it("15. real page content painted over the card blocks the capture with the element named — never hidden", async () => {
    const { result, occlusion } = await run({ viewport: { width: 1503, height: 937 }, scrollbar: 17, contentOverlay: true, channel: "Email" });
    expect(result).toMatchObject({ ok: false, code: "SUBSCRIBER_GROWTH_TARGET_OCCLUDED" });
    expect(occlusion!.occluders).toEqual([expect.objectContaining({ kind: "page-content", action: "blocked", element: "div#banner", text: expect.stringContaining("still processing") })]);
    expect(document.getElementById("banner")!.style.visibility).toBe("");
    expect(document.querySelector("[data-tention-subscriber-growth]")).toBeNull();
  });

  it("15b. a modal dialog over the page blocks the capture — never hidden", async () => {
    // Already on October, so no date picker (also a dialog) is opened.
    const { result, occlusion } = await run({ viewport: { width: 1503, height: 937 }, scrollbar: 17, modal: true, channel: "Email", period: "10/01/2026 – 10/31/2026" });
    expect(result).toMatchObject({ ok: false, code: "SUBSCRIBER_GROWTH_TARGET_OCCLUDED" });
    expect(occlusion!.occluders).toEqual([expect.objectContaining({ kind: "modal", action: "blocked", element: "div#modal" })]);
    expect(document.getElementById("modal")!.style.visibility).toBe("");
  });

  it("a card that cannot fit even after the dock is collapsed is refused, not clipped", async () => {
    const { result } = await run({ viewport: { width: 1503, height: 760 }, scrollbar: 17, composer: true, composerKind: "docked", channel: "Email" });
    expect(result).toMatchObject({ ok: false, code: "TARGET_BOUNDS_INVALID", diagnostics: { occlusion: { occluders: [expect.objectContaining({ action: "collapsed-dock" })] } } });
  });
});
