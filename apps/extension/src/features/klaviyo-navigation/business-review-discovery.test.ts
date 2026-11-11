import { afterEach, describe, expect, it, vi } from "vitest";
import { ChromeBusinessReviewDiscovery, clickVisibleViewDashboardControl, inspectBusinessReviewDiscoveryDocument } from "./business-review-discovery.js";
import type { KlaviyoActiveTabGrantStore } from "./active-tab-grant.js";
import { DeliverabilitySourceVerifier } from "./client-setup-sources.js";
import { prepareDeliverabilityScoreDocument } from "./deliverability-score-capture.js";

const reviewUrl = "https://www.klaviyo.com/analytics/dashboards/discovered-existing-id";
function makeGrantStore(): KlaviyoActiveTabGrantStore {
  return {
    get: vi.fn().mockResolvedValue({ grantedTabId: 7, grantedWindowId: 3, grantedOrigin: "https://www.klaviyo.com", grantedUrl: "https://www.klaviyo.com/dashboard", grantedAt: 1 }),
    getActionInvocation: vi.fn().mockResolvedValue({ tabId: 7, windowId: 3, origin: "https://www.klaviyo.com", pathname: "/dashboard", invokedAt: 1 }),
    set: vi.fn(), setActionInvocation: vi.fn(), clearGrant: vi.fn(), clear: vi.fn(),
  };
}

function discoveryPage(url: string, options: { account?: string; providerAccountId?: string; providerIdentityKind?: "account" | "workspace" | "organization"; clientName?: string; businessReview?: boolean; links?: Array<{ text: string; href: string }>; dashboardLinks?: Array<{ text: string; href: string }> } = {}) {
  const links = [...(options.links ?? []), ...(options.dashboardLinks ?? [])].map(({ text, href }) => "<a href=\"" + href + "\">" + text + "</a>").join("");
  const headings = options.businessReview ? "<h1>Business Review</h1><h2>Growth Overview</h2><h2>Campaign Performance Summary</h2><h2>Flow Performance Summary</h2>" : "<h1>Home</h1>";
  const evidence = { businessReviewHeading: Boolean(options.businessReview), growthOverview: Boolean(options.businessReview), campaignPerformance: Boolean(options.businessReview), flowPerformance: Boolean(options.businessReview) };
  return {
    url, accountLabel: options.account ?? null, providerAccountId: options.providerAccountId ?? null, providerIdentityKind: options.providerIdentityKind ?? (options.providerAccountId ? "account" : null), accountMatchesClient: Boolean(options.account && testAccountMatchesClient(options.account, options.clientName ?? options.account)), accountLabelCandidates: options.account ? [options.account] : [], accountContextSource: options.account ? "header_match" : "not_found", isBusinessReview: Boolean(options.businessReview), evidence,
    businessReviewLinks: options.links ?? [], dashboardNavigationLinks: options.dashboardLinks ?? [],
    visibleHeadings: options.businessReview ? ["Business Review", "Growth Overview", "Campaign Performance Summary", "Flow Performance Summary"] : ["Home"],
    visibleHeadingCount: options.businessReview ? 4 : 1, visibleLinkCount: links.length,
    viewDashboardControlCount: 0, businessReviewCandidateCount: (options.links ?? []).length, visibleControls: [],
    html: "<nav><button>" + (options.account ?? "") + "</button>" + links + "</nav><main>" + headings + "</main>",
  };
}
function testNormalize(value: string): string {
  const normalized = value.toLowerCase().replace(/[^a-z0-9]/g, "");
  return /\.com\s*$/i.test(value.trim()) ? normalized.slice(0, -3) : normalized;
}
function testAccountMatchesClient(account: string, client: string): boolean {
  return testNormalize(account) === testNormalize(client)
    || (/^[A-Z]{2,3}\s+(?=[A-Za-z])/.test(account) && testNormalize(account.replace(/^[A-Z]{2,3}\s+/, "")) === testNormalize(client));
}

function chromeFor(pages: Record<string, ReturnType<typeof discoveryPage>>, initialUrl = "https://www.klaviyo.com/dashboard") {
  let currentUrl = initialUrl;
  const tabs = {
    get: vi.fn(async () => ({ id: 7, windowId: 3, active: true, status: "complete", url: currentUrl })),
    query: vi.fn().mockResolvedValue([{ id: 7, windowId: 3, active: true }]),
    update: vi.fn(async (_id: number, properties: { url: string }) => { currentUrl = properties.url; return { id: 7, windowId: 3, active: true, status: "complete", url: currentUrl }; }),
    onUpdated: { addListener: vi.fn(), removeListener: vi.fn() },
  };
  const scripting = { executeScript: vi.fn(async () => {
    const parsed = new URL(currentUrl);
    const page = pages[currentUrl] ?? pages[parsed.origin + parsed.pathname];
    return page ? [{ frameId: 0, result: { ...page, url: currentUrl } }] : [];
  }) };
  return { chromeApi: { tabs, scripting }, tabs, scripting };
}

afterEach(() => { vi.restoreAllMocks(); });

describe("Business Review discovery", () => {
  it("discovers a visible Business Review link, verifies destination semantics and account, then returns the exact URL", async () => {
    const home = discoveryPage("https://www.klaviyo.com/dashboard", { account: "Club Furniture", links: [{ text: "Business Review", href: reviewUrl }] });
    const review = discoveryPage(reviewUrl, { account: "Club Furniture", businessReview: true });
    const fixture = chromeFor({ "https://www.klaviyo.com/dashboard": home, [reviewUrl]: review });
    const discovery = new ChromeBusinessReviewDiscovery(fixture.chromeApi as never, 100, makeGrantStore());
    await expect(discovery.discover({ clientName: "Club Furniture" })).resolves.toMatchObject({
      ok: true, dashboardUrl: reviewUrl, accountLabel: "Club Furniture",
      evidence: { businessReviewHeading: true, growthOverview: true, campaignPerformance: true, flowPerformance: true },
    });
    expect(fixture.tabs.update).toHaveBeenCalledWith(7, { url: reviewUrl });
  });

  it("waits for the dashboard SPA to replace its shell with verified Business Review content", async () => {
    const home = discoveryPage("https://www.klaviyo.com/dashboard", { account: "Club Furniture", links: [{ text: "Business Review", href: reviewUrl }] });
    const shell = discoveryPage(reviewUrl, { account: "Club Furniture" });
    const review = discoveryPage(reviewUrl, { account: "Club Furniture", businessReview: true });
    const fixture = chromeFor({ "https://www.klaviyo.com/dashboard": home, [reviewUrl]: review });
    fixture.scripting.executeScript
      .mockResolvedValueOnce([{ frameId: 0, result: home }])
      .mockResolvedValueOnce([{ frameId: 0, result: shell }])
      .mockResolvedValueOnce([{ frameId: 0, result: shell }])
      .mockResolvedValueOnce([{ frameId: 0, result: review }]);
    const discovery = new ChromeBusinessReviewDiscovery(fixture.chromeApi as never, 1_000, makeGrantStore());
    await expect(discovery.discover({ clientName: "Club Furniture" })).resolves.toMatchObject({ ok: true, dashboardUrl: reviewUrl });
    expect(fixture.scripting.executeScript).toHaveBeenCalledTimes(4);
  });

  it("traverses only a visible Dashboards navigation link and then follows the visible Business Review row", async () => {
    const listingUrl = "https://www.klaviyo.com/analytics/dashboards";
    const home = discoveryPage("https://www.klaviyo.com/dashboard", { account: "Club Furniture", dashboardLinks: [{ text: "Dashboards", href: listingUrl }] });
    const listing = discoveryPage(listingUrl, { account: "Club Furniture", links: [{ text: "Business Review", href: reviewUrl }] });
    const review = discoveryPage(reviewUrl, { account: "Club Furniture", businessReview: true });
    const fixture = chromeFor({ "https://www.klaviyo.com/dashboard": home, [listingUrl]: listing, [reviewUrl]: review });
    const discovery = new ChromeBusinessReviewDiscovery(fixture.chromeApi as never, 100, makeGrantStore());
    await expect(discovery.discover({ clientName: "Club Furniture" })).resolves.toMatchObject({ ok: true, dashboardUrl: reviewUrl });
    expect(fixture.tabs.update.mock.calls.map((call) => call[1].url)).toEqual([listingUrl, reviewUrl]);
  });

  it("rejects an arbitrary analytics dashboard even when its URL has a dashboard ID", async () => {
    const arbitrary = "https://www.klaviyo.com/analytics/dashboards/not-business-review";
    const home = discoveryPage("https://www.klaviyo.com/dashboard", { account: "Club Furniture", links: [{ text: "Revenue Dashboard", href: arbitrary }] });
    const fixture = chromeFor({ "https://www.klaviyo.com/dashboard": home, [arbitrary]: discoveryPage(arbitrary, { account: "Club Furniture" }) });
    const discovery = new ChromeBusinessReviewDiscovery(fixture.chromeApi as never, 100, makeGrantStore());
    await expect(discovery.discover({ clientName: "Club Furniture" })).resolves.toMatchObject({ ok: false, code: "BUSINESS_REVIEW_NOT_DISCOVERED" });
    expect(fixture.tabs.update).toHaveBeenCalledWith(7, { url: arbitrary });
  });

  it("fails closed when existing account binding belongs to another visible account", async () => {
    const home = discoveryPage("https://www.klaviyo.com/dashboard", { account: "Club Furniture", links: [{ text: "Business Review", href: reviewUrl }] });
    const foreign = "https://www.klaviyo.com/analytics/dashboards/foreign-existing-id";
    const fixture = chromeFor({
      "https://www.klaviyo.com/dashboard": home, [reviewUrl]: discoveryPage(reviewUrl, { account: "Club Furniture", businessReview: true }),
      [foreign]: discoveryPage(foreign, { account: "AutoLEDTech.com", businessReview: true }),
    });
    const discovery = new ChromeBusinessReviewDiscovery(fixture.chromeApi as never, 100, makeGrantStore());
    await expect(discovery.discover({ clientName: "Club Furniture", configuredUrl: foreign, configuredAccountLabel: "AutoLEDTech.com" })).resolves.toMatchObject({ ok: false, code: "ACCOUNT_CONTEXT_MISMATCH" });
    expect(fixture.tabs.update).not.toHaveBeenCalledWith(7, { url: foreign });
  });

  it("reuses an existing verified URL only when its stored account binding still matches", async () => {
    const home = discoveryPage("https://www.klaviyo.com/dashboard", { account: "Club Furniture" });
    const fixture = chromeFor({ "https://www.klaviyo.com/dashboard": home, [reviewUrl]: discoveryPage(reviewUrl, { account: "Club Furniture", businessReview: true }) });
    const discovery = new ChromeBusinessReviewDiscovery(fixture.chromeApi as never, 100, makeGrantStore());
    await expect(discovery.discover({ clientName: "Club Furniture", configuredUrl: reviewUrl, configuredAccountLabel: "Club Furniture" })).resolves.toMatchObject({ ok: true, dashboardUrl: reviewUrl });
  });

  it("verifies Use Current Page semantically and rejects a non-Business-Review current route", async () => {
    const review = discoveryPage(reviewUrl, { account: "Club Furniture", businessReview: true });
    const fixture = chromeFor({ [reviewUrl]: review }, reviewUrl);
    const discovery = new ChromeBusinessReviewDiscovery(fixture.chromeApi as never, 100, makeGrantStore());
    await expect(discovery.discover({ clientName: "Club Furniture", useCurrentPage: true })).resolves.toMatchObject({ ok: true, dashboardUrl: reviewUrl });
    fixture.scripting.executeScript.mockResolvedValue([{ frameId: 0, result: discoveryPage("https://www.klaviyo.com/analytics/dashboards/other", { account: "Club Furniture" }) }]);
    await expect(discovery.discover({ clientName: "Club Furniture", useCurrentPage: true })).resolves.toMatchObject({ ok: false, code: "BUSINESS_REVIEW_PAGE_NOT_VERIFIED" });
  });

  it("refuses to bind a dashboard when visible account context differs from selected client", async () => {
    const home = discoveryPage("https://www.klaviyo.com/dashboard", { account: "AutoLEDTech.com", clientName: "Club Furniture", links: [{ text: "Business Review", href: reviewUrl }] });
    const fixture = chromeFor({ "https://www.klaviyo.com/dashboard": home, [reviewUrl]: discoveryPage(reviewUrl, { account: "AutoLEDTech.com", clientName: "Club Furniture", businessReview: true }) });
    const discovery = new ChromeBusinessReviewDiscovery(fixture.chromeApi as never, 100, makeGrantStore());
    await expect(discovery.discover({ clientName: "Club Furniture" })).resolves.toMatchObject({ ok: false, code: "ACCOUNT_CONTEXT_MISMATCH" });
    expect(fixture.tabs.update).not.toHaveBeenCalled();
  });

  it("normalizes client punctuation and keeps the injected inspection self-contained", () => {
    document.body.innerHTML = "<header><button>Auto LED Tech</button></header><nav><a href=\"" + reviewUrl + "\">Business Review</a></nav><main><h1>Business Review</h1><h2>Growth Overview</h2><h2>Campaign Performance Summary</h2><h2>Flow Performance Summary</h2></main>";
    vi.spyOn(Element.prototype, "getBoundingClientRect").mockReturnValue({ width: 100, height: 20, top: 0, left: 0, right: 100, bottom: 20, x: 0, y: 0, toJSON() {} });
    window.history.replaceState({}, "", "/analytics/dashboards/discovered-existing-id");
    expect(inspectBusinessReviewDiscoveryDocument("AutoLEDTech.com")).toMatchObject({
      accountLabel: "Auto LED Tech", accountMatchesClient: true, isBusinessReview: true,
      businessReviewLinks: [{ text: "Business Review", href: reviewUrl }],
    });
  });

  it("returns evidence after Chrome serializes the inspector without module closures", () => {
    document.body.innerHTML = "<header><button>Club Furniture</button></header><nav><a href=\"" + reviewUrl + "\">Business Review</a></nav><main><h1>Business Review</h1><h2>Growth Overview</h2><h2>Campaign Performance Summary</h2><h2>Flow Performance Summary</h2></main>";
    vi.spyOn(Element.prototype, "getBoundingClientRect").mockReturnValue({ width: 100, height: 20, top: 0, left: 0, right: 100, bottom: 20, x: 0, y: 0, toJSON() {} });
    window.history.replaceState({}, "", "/analytics/dashboards/discovered-existing-id");
    const serializedInspector = new Function(`return (${inspectBusinessReviewDiscoveryDocument.toString()})`)() as typeof inspectBusinessReviewDiscoveryDocument;
    expect(serializedInspector("Club Furniture")).toMatchObject({ accountLabel: "Club Furniture", accountMatchesClient: true, isBusinessReview: true });
  });

  it("recognizes a Klaviyo account monogram prefix without account-specific logic", () => {
    document.body.innerHTML = "<header><button>CL Club Furniture</button><button><span>View dashboard</span></button></header><nav><a href=\"https://www.klaviyo.com/analytics/dashboards\">Dashboards</a></nav><main><h1>Home</h1></main>";
    vi.spyOn(Element.prototype, "getBoundingClientRect").mockReturnValue({ width: 100, height: 20, top: 0, left: 0, right: 100, bottom: 20, x: 0, y: 0, toJSON() {} });
    const serializedInspector = new Function(`return (${inspectBusinessReviewDiscoveryDocument.toString()})`)() as typeof inspectBusinessReviewDiscoveryDocument;
    expect(serializedInspector("Club Furniture")).toMatchObject({ accountLabel: "CL Club Furniture", accountMatchesClient: true, viewDashboardControlCount: 1, visibleHeadingCount: 1, visibleLinkCount: 1 });
    const serializedClick = new Function(`return (${clickVisibleViewDashboardControl.toString()})`)() as typeof clickVisibleViewDashboardControl;
    expect(serializedClick()).toBe(true);
  });

  it("reads a stable account identity only from an explicitly account-scoped DOM attribute", () => {
    document.body.innerHTML = "<header><button data-account-id=\"acct_fixture_123\">Club Furniture LLC</button></header><nav><button>Analytics</button></nav><main><h1>Home</h1></main>";
    vi.spyOn(Element.prototype, "getBoundingClientRect").mockReturnValue({ width: 100, height: 20, top: 0, left: 0, right: 100, bottom: 20, x: 0, y: 0, toJSON() {} });
    expect(inspectBusinessReviewDiscoveryDocument("Club Furniture")).toMatchObject({ accountLabel: "Club Furniture LLC", providerAccountId: "acct_fixture_123", providerIdentityKind: "account", accountMatchesClient: true });
  });

  it("never misreads Analytics navigation as the authenticated account when account identity is not exposed", () => {
    document.body.innerHTML = "<header><button aria-label=\"Open account menu\">Account</button></header><nav><button>Analytics</button><a href=\"https://www.klaviyo.com/analytics/dashboards\">Dashboards</a></nav><main><h1>Home</h1><p>Business performance summary</p><button>View dashboard</button></main>";
    vi.spyOn(Element.prototype, "getBoundingClientRect").mockReturnValue({ width: 100, height: 20, top: 0, left: 0, right: 100, bottom: 20, x: 0, y: 0, toJSON() {} });
    const observed = inspectBusinessReviewDiscoveryDocument("Club Furniture");
    expect(observed).toMatchObject({ accountLabel: null, accountMatchesClient: false, accountContextSource: "not_found" });
    expect(observed.accountLabelCandidates).not.toContain("Analytics");
    expect(observed.visibleControls.map(({ text }) => text)).toContain("Dashboards");
  });

  it("does not classify ordinary navigation controls as an account mismatch", () => {
    document.body.innerHTML = "<nav><button>Analytics</button><button>Dashboards</button></nav><main><h1>Home</h1></main>";
    vi.spyOn(Element.prototype, "getBoundingClientRect").mockReturnValue({ width: 100, height: 20, top: 0, left: 0, right: 100, bottom: 20, x: 0, y: 0, toJSON() {} });
    const observed = inspectBusinessReviewDiscoveryDocument("Club Furniture");
    expect(observed).toMatchObject({ accountLabel: null, accountMatchesClient: false, accountContextSource: "not_found", accountLabelCandidates: [] });
  });

  it("matches the prefixed account label to the selected client without stripping legitimate acronym names", async () => {
    const withMonogram = discoveryPage(reviewUrl, { account: "CL Club Furniture", clientName: "Club Furniture", businessReview: true });
    const fixture = chromeFor({ [reviewUrl]: withMonogram }, reviewUrl);
    const discovery = new ChromeBusinessReviewDiscovery(fixture.chromeApi as never, 100, makeGrantStore());
    await expect(discovery.discover({ clientName: "Club Furniture", useCurrentPage: true })).resolves.toMatchObject({ ok: true, accountLabel: "CL Club Furniture" });
    document.body.innerHTML = "<header><button>USA Today</button></header><main><h1>Home</h1></main>";
    vi.spyOn(Element.prototype, "getBoundingClientRect").mockReturnValue({ width: 100, height: 20, top: 0, left: 0, right: 100, bottom: 20, x: 0, y: 0, toJSON() {} });
    expect(inspectBusinessReviewDiscoveryDocument("USA Today")).toMatchObject({ accountLabel: "USA Today", accountMatchesClient: true });
  });

  it("discovers Business Review via the visible View dashboard action without guessing a dashboard URL", async () => {
    const home = discoveryPage("https://www.klaviyo.com/dashboard", { account: "CL Club Furniture" });
    home.viewDashboardControlCount = 1;
    const review = discoveryPage(reviewUrl, { account: "CL Club Furniture", businessReview: true });
    let currentUrl = "https://www.klaviyo.com/dashboard";
    const tabs = {
      get: vi.fn(async () => ({ id: 7, windowId: 3, active: true, status: "complete", url: currentUrl })),
      query: vi.fn().mockResolvedValue([{ id: 7, windowId: 3, active: true }]),
      update: vi.fn(async (_id: number, properties: { url: string }) => { currentUrl = properties.url; return { id: 7, windowId: 3, active: true, status: "complete", url: currentUrl }; }),
      onUpdated: { addListener: vi.fn(), removeListener: vi.fn() },
    };
    const scripting = { executeScript: vi.fn(async ({ func }: { func: (...args: string[]) => unknown }) => {
      if (func === clickVisibleViewDashboardControl) { currentUrl = reviewUrl; return [{ frameId: 0, result: true }]; }
      const page = currentUrl === reviewUrl ? review : home;
      return [{ frameId: 0, result: { ...page, url: currentUrl } }];
    }) };
    const discovery = new ChromeBusinessReviewDiscovery({ tabs, scripting } as never, 500, makeGrantStore());
    await expect(discovery.discover({ clientName: "Club Furniture" })).resolves.toMatchObject({ ok: true, dashboardUrl: reviewUrl, accountLabel: "CL Club Furniture" });
    expect(scripting.executeScript).toHaveBeenCalledWith(expect.objectContaining({ func: clickVisibleViewDashboardControl }));
    expect(tabs.update).not.toHaveBeenCalled();
  });

  it("returns typed safe diagnostics when Chrome rejects page inspection", async () => {
    const fixture = chromeFor({ "https://www.klaviyo.com/dashboard": discoveryPage("https://www.klaviyo.com/dashboard", { account: "Club Furniture" }) });
    fixture.scripting.executeScript.mockRejectedValueOnce(new Error("Cannot access contents of url https://www.klaviyo.com/dashboard?token=secret because of permissions"));
    const discovery = new ChromeBusinessReviewDiscovery(fixture.chromeApi as never, 100, makeGrantStore());
    const result = await discovery.discover({ clientName: "Club Furniture" });
    expect(result).toMatchObject({ ok: false, code: "SCRIPT_INJECTION_FAILED", diagnostics: { activeTabFound: true, tabId: 7, tabHostname: "www.klaviyo.com", scriptInjectionResult: "rejected", inspectionResultReturned: false, typedErrorCode: "SCRIPT_INJECTION_FAILED", safeErrorMessage: "Chrome denied page access for this tab." } });
    expect(JSON.stringify(result)).not.toContain("secret");
  });

  it("distinguishes a resolved injection with no inspectable main-frame result", async () => {
    const fixture = chromeFor({});
    const discovery = new ChromeBusinessReviewDiscovery(fixture.chromeApi as never, 100, makeGrantStore());
    await expect(discovery.discover({ clientName: "Club Furniture" })).resolves.toMatchObject({
      ok: false, code: "INSPECTOR_RESULT_EMPTY",
      diagnostics: { activeTabFound: true, scriptInjectionResult: "resolved", inspectionResultReturned: false, typedErrorCode: "INSPECTOR_RESULT_EMPTY", inspectionResultCount: 0 },
    });
  });

  it("fails closed when the toolbar-authorized tab is no longer the active tab in its window", async () => {
    const fixture = chromeFor({ "https://www.klaviyo.com/dashboard": discoveryPage("https://www.klaviyo.com/dashboard", { account: "Club Furniture" }) });
    fixture.tabs.query.mockResolvedValue([{ id: 99, windowId: 3, active: true }, { id: 7, windowId: 3, active: false }]);
    const discovery = new ChromeBusinessReviewDiscovery(fixture.chromeApi as never, 100, makeGrantStore());
    await expect(discovery.discover({ clientName: "Club Furniture" })).resolves.toMatchObject({ ok: false, code: "GRANTED_TAB_NOT_ACTIVE", diagnostics: { activeTabFound: false, activeTabResult: "GRANTED_TAB_NOT_ACTIVE", permissionResult: "toolbar active-tab authorization not verified" } });
    expect(fixture.scripting.executeScript).not.toHaveBeenCalled();
  });

  it("accepts a verified account label that omits only the client's explicit .com suffix", async () => {
    const home = discoveryPage("https://www.klaviyo.com/dashboard", { account: "Auto LED Tech", links: [{ text: "Business Review", href: reviewUrl }] });
    const dashboard = discoveryPage(reviewUrl, { account: "Auto LED Tech", businessReview: true });
    const fixture = chromeFor({ "https://www.klaviyo.com/dashboard": home, [reviewUrl]: dashboard });
    const discovery = new ChromeBusinessReviewDiscovery(fixture.chromeApi as never, 100, makeGrantStore());
    await expect(discovery.discover({ clientName: "AutoLEDTech.com" })).resolves.toMatchObject({ ok: true, dashboardUrl: reviewUrl, accountLabel: "Auto LED Tech" });
  });

  it("does not strip a client name that merely ends with the letters com", () => {
    document.body.innerHTML = "<header><button>Outcome</button></header><main><h1>Business Review</h1><h2>Growth Overview</h2><h2>Campaign Performance Summary</h2><h2>Flow Performance Summary</h2></main>";
    vi.spyOn(Element.prototype, "getBoundingClientRect").mockReturnValue({ width: 100, height: 20, top: 0, left: 0, right: 100, bottom: 20, x: 0, y: 0, toJSON() {} });
    window.history.replaceState({}, "", "/analytics/dashboards/discovered-existing-id");
    expect(inspectBusinessReviewDiscoveryDocument("Outcome")).toMatchObject({ accountLabel: "Outcome", accountMatchesClient: true });
    expect(inspectBusinessReviewDiscoveryDocument("Outcomes").accountMatchesClient).toBe(false);
  });

  it.each([
    ["Club Furniture", "ClubFurniture"],
    ["Club Furniture", "Club Furniture LLC"],
    ["Club Furniture", "Club Furniture.com"],
    ["AutoLEDTECH", "AutoLEDTech.com"],
    ["AutoLEDTech", "AUTOLEDTECH, INC."],
  ])("normalizes harmless organization display variation %s / %s", (selectedName, observedName) => {
    document.body.innerHTML = `<header><button>${observedName}</button></header><nav><button>Analytics</button></nav><main><h1>Home</h1></main>`;
    vi.spyOn(Element.prototype, "getBoundingClientRect").mockReturnValue({ width: 100, height: 20, top: 0, left: 0, right: 100, bottom: 20, x: 0, y: 0, toJSON() {} });
    expect(inspectBusinessReviewDiscoveryDocument(selectedName)).toMatchObject({ accountLabel: observedName, accountMatchesClient: true, accountContextSource: "header_match" });
  });

  it("revalidates an existing account binding before reusing or discovering a dashboard", async () => {
    const home = discoveryPage("https://www.klaviyo.com/dashboard", { account: "Club Furniture LLC" });
    const fixture = chromeFor({ "https://www.klaviyo.com/dashboard": home });
    const discovery = new ChromeBusinessReviewDiscovery(fixture.chromeApi as never, 100, makeGrantStore());
    await expect(discovery.discover({ clientName: "Club Furniture", configuredUrl: reviewUrl, configuredAccountLabel: "AutoLEDTech.com" })).resolves.toMatchObject({
      ok: false, code: "ACCOUNT_CONTEXT_MISMATCH", diagnostics: { configuredAccountLabel: "AutoLEDTech.com", observedAccountLabel: "Club Furniture LLC", comparisonResult: "stored_binding_mismatch", discoveryStage: "ACCOUNT_BINDING_VERIFICATION" },
    });
    expect(fixture.tabs.update).not.toHaveBeenCalled();
  });

  it("uses a saved stable provider identity ahead of harmless display-name variation", async () => {
    const home = discoveryPage("https://www.klaviyo.com/dashboard", { account: "Club Furniture Store", providerAccountId: "account_123", businessReview: false });
    const review = discoveryPage(reviewUrl, { account: "Club Furniture Store", providerAccountId: "account_123", businessReview: true });
    const fixture = chromeFor({ "https://www.klaviyo.com/dashboard": home, [reviewUrl]: review });
    const discovery = new ChromeBusinessReviewDiscovery(fixture.chromeApi as never, 100, makeGrantStore());
    await expect(discovery.discover({ clientName: "Club Furniture", configuredUrl: reviewUrl, configuredAccountLabel: "Legacy Marketing Brand", configuredProviderAccountId: "account_123" })).resolves.toMatchObject({ ok: true, dashboardUrl: reviewUrl });
  });

  it("allows intentional first-time binding when a verified stable account ID is exposed but workspace branding differs", async () => {
    const workspace = "Furniture Retail Operations";
    const home = discoveryPage("https://www.klaviyo.com/dashboard", { account: workspace, providerAccountId: "workspace_987", providerIdentityKind: "workspace", links: [{ text: "Business Review", href: reviewUrl }] });
    const review = discoveryPage(reviewUrl, { account: workspace, providerAccountId: "workspace_987", providerIdentityKind: "workspace", businessReview: true });
    const fixture = chromeFor({ "https://www.klaviyo.com/dashboard": home, [reviewUrl]: review });
    const discovery = new ChromeBusinessReviewDiscovery(fixture.chromeApi as never, 100, makeGrantStore());
    await expect(discovery.discover({ clientName: "Club Furniture" })).resolves.toMatchObject({
      ok: true, dashboardUrl: reviewUrl, accountLabel: workspace, providerAccountId: "workspace_987", providerIdentityKind: "workspace",
    });
  });

  it("still rejects an unbound, nonmatching display name when no stable provider identity exists", async () => {
    const home = discoveryPage("https://www.klaviyo.com/dashboard", { account: "Furniture Retail Operations", clientName: "Club Furniture" });
    const fixture = chromeFor({ "https://www.klaviyo.com/dashboard": home });
    const discovery = new ChromeBusinessReviewDiscovery(fixture.chromeApi as never, 100, makeGrantStore());
    await expect(discovery.discover({ clientName: "Club Furniture" })).resolves.toMatchObject({ ok: false, code: "ACCOUNT_CONTEXT_MISMATCH" });
  });

  it("blocks an existing stable provider binding when the authorized account ID differs", async () => {
    const home = discoveryPage("https://www.klaviyo.com/dashboard", { account: "Club Furniture", providerAccountId: "account_other" });
    const fixture = chromeFor({ "https://www.klaviyo.com/dashboard": home });
    const discovery = new ChromeBusinessReviewDiscovery(fixture.chromeApi as never, 100, makeGrantStore());
    await expect(discovery.discover({ clientName: "Club Furniture", configuredAccountLabel: "Club Furniture", configuredProviderAccountId: "account_123" })).resolves.toMatchObject({
      ok: false, code: "ACCOUNT_CONTEXT_MISMATCH", diagnostics: { comparisonResult: "stable_provider_id_mismatch", observedProviderAccountId: "account_other" },
    });
    expect(fixture.tabs.update).not.toHaveBeenCalled();
  });
});

describe("Saved Business Review target preflight (account only)", () => {
  const savedUrl = "https://www.klaviyo.com/analytics/dashboards/saved-verified-id";
  it.each([
    ["Home", "https://www.klaviyo.com/dashboard"],
    ["Campaigns", "https://www.klaviyo.com/omnicampaigns?appBarNav=true"],
    ["Deliverability", "https://www.klaviyo.com/analytics/deliverability/email/score"],
  ])("re-proves the bound account on the %s page without navigating or re-discovering", async (_page, currentUrl) => {
    const current = discoveryPage(currentUrl, { account: "AC Acme Home" });
    const fixture = chromeFor({ [new URL(currentUrl).origin + new URL(currentUrl).pathname]: current }, currentUrl);
    const discovery = new ChromeBusinessReviewDiscovery(fixture.chromeApi as never, 100, makeGrantStore());
    await expect(discovery.discover({ clientName: "Acme Home", configuredUrl: savedUrl, configuredAccountLabel: "AC Acme Home", verifySavedAccountOnly: true }))
      .resolves.toEqual({ ok: true, verification: "saved_target_account", dashboardUrl: savedUrl, accountLabel: "AC Acme Home", accountMatchesClient: true });
    expect(fixture.tabs.update).not.toHaveBeenCalled();
  });

  describe("Steven Dann: saved label vs the label Klaviyo renders", () => {
    const deliverabilityUrl = "https://www.klaviyo.com/analytics/deliverability/email/score";
    it.each([
      ["saved ST Steven Dann, page Steven Dann", "ST Steven Dann", "Steven Dann"],
      ["saved Steven Dann, page ST Steven Dann", "Steven Dann", "ST Steven Dann"],
      ["saved Steven Dann, page Steven Dann", "Steven Dann", "Steven Dann"],
    ])("accepts %s on Deliverability", async (_case, saved, shown) => {
      const fixture = chromeFor({ [deliverabilityUrl]: discoveryPage(deliverabilityUrl, { account: shown, clientName: "Steven Dann" }) }, deliverabilityUrl);
      const discovery = new ChromeBusinessReviewDiscovery(fixture.chromeApi as never, 100, makeGrantStore());
      await expect(discovery.discover({ clientName: "Steven Dann", configuredUrl: savedUrl, configuredAccountLabel: saved, verifySavedAccountOnly: true })).resolves.toMatchObject({ ok: true, verification: "saved_target_account" });
    });
    it.each([["CL Club Furniture"], ["Club Furniture"]])("rejects a page showing %s for Steven Dann", async (shown) => {
      const fixture = chromeFor({ [deliverabilityUrl]: discoveryPage(deliverabilityUrl, { account: shown }) }, deliverabilityUrl);
      const discovery = new ChromeBusinessReviewDiscovery(fixture.chromeApi as never, 100, makeGrantStore());
      await expect(discovery.discover({ clientName: "Steven Dann", configuredUrl: savedUrl, configuredAccountLabel: "Steven Dann", verifySavedAccountOnly: true })).resolves.toMatchObject({ ok: false, code: "ACCOUNT_CONTEXT_MISMATCH" });
    });
    it("the Deliverability source verifier, run on the real discovery, accepts Steven Dann's page and refuses Club Furniture's", async () => {
      const verify = async (shown: string) => {
        const fixture = chromeFor({ [deliverabilityUrl]: discoveryPage(deliverabilityUrl, { account: shown, clientName: "Steven Dann" }) }, deliverabilityUrl);
        const discoveryScript = fixture.scripting.executeScript;
        const scripting = { executeScript: vi.fn(async (details: { func: unknown }) => details.func === prepareDeliverabilityScoreDocument
          ? [{ frameId: 0, result: { ok: true, sourceUrl: deliverabilityUrl, targetRect: {}, diagnostics: {} } }]
          : discoveryScript()) };
        const discovery = new ChromeBusinessReviewDiscovery({ tabs: fixture.tabs, scripting } as never, 100, makeGrantStore());
        return new DeliverabilitySourceVerifier(fixture.tabs, scripting as never, makeGrantStore(), (input) => discovery.discover(input))
          .verify({ clientName: "Steven Dann", configuredUrl: savedUrl, configuredAccountLabel: "ST Steven Dann", configuredProviderAccountId: null });
      };
      await expect(verify("Steven Dann")).resolves.toEqual({ ok: true, deliverabilityUrl, accountLabel: "Steven Dann" });
      await expect(verify("CL Club Furniture")).resolves.toMatchObject({ ok: false, code: "ACCOUNT_CONTEXT_MISMATCH" });
    });
  });

  it("fails closed when the authorized tab shows a different account", async () => {
    const fixture = chromeFor({ "https://www.klaviyo.com/dashboard": discoveryPage("https://www.klaviyo.com/dashboard", { account: "OT Other Brand" }) });
    const discovery = new ChromeBusinessReviewDiscovery(fixture.chromeApi as never, 100, makeGrantStore());
    await expect(discovery.discover({ clientName: "Acme Home", configuredUrl: savedUrl, configuredAccountLabel: "AC Acme Home", verifySavedAccountOnly: true })).resolves.toMatchObject({ ok: false, code: "ACCOUNT_CONTEXT_MISMATCH" });
    expect(fixture.tabs.update).not.toHaveBeenCalled();
  });

  it("fails closed when a stable provider ID binding does not match", async () => {
    const fixture = chromeFor({ "https://www.klaviyo.com/dashboard": discoveryPage("https://www.klaviyo.com/dashboard", { account: "AC Acme Home", providerAccountId: "other-id" }) });
    const discovery = new ChromeBusinessReviewDiscovery(fixture.chromeApi as never, 100, makeGrantStore());
    await expect(discovery.discover({ clientName: "Acme Home", configuredUrl: savedUrl, configuredAccountLabel: "AC Acme Home", configuredProviderAccountId: "acme-id", verifySavedAccountOnly: true })).resolves.toMatchObject({ ok: false, code: "ACCOUNT_CONTEXT_MISMATCH" });
  });

  it.each([
    ["no saved URL", { configuredAccountLabel: "AC Acme Home" }],
    ["no saved account binding", { configuredUrl: savedUrl }],
    ["a saved URL that is not a Business Review dashboard", { configuredUrl: "https://www.klaviyo.com/dashboard", configuredAccountLabel: "AC Acme Home" }],
  ])("does not treat %s as a verified Business Review target", async (_case, saved) => {
    const fixture = chromeFor({ "https://www.klaviyo.com/dashboard": discoveryPage("https://www.klaviyo.com/dashboard", { account: "AC Acme Home" }) });
    const discovery = new ChromeBusinessReviewDiscovery(fixture.chromeApi as never, 100, makeGrantStore());
    await expect(discovery.discover({ clientName: "Acme Home", ...saved, verifySavedAccountOnly: true })).resolves.toMatchObject({ ok: false, code: "BUSINESS_REVIEW_NOT_DISCOVERED" });
    expect(fixture.tabs.update).not.toHaveBeenCalled();
  });
});
