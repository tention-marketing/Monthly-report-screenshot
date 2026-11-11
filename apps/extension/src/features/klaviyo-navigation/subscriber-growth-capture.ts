import type { ReportPeriod, ScreenshotType, SubscriberGrowthEvidence } from "@tention/report-schema";
import type { PeriodEntryApi } from "./injected/period-entry-contract.js";

export interface SubscriberGrowthTargetBounds {
  x: number; y: number; width: number; height: number; viewportWidth: number; viewportHeight: number;
  visibleControls: Array<Record<string, string | boolean | null>>;
  stageTimingsMs?: Record<string, number>;
  /** Not a row-ranked section. */
  availableRowCount?: never;
}
export type SubscriberGrowthFailureCode =
  | "SUBSCRIBER_GROWTH_PAGE_NOT_READY" | "SUBSCRIBER_GROWTH_SOURCE_WRONG_PAGE" | "SUBSCRIBER_GROWTH_ACCOUNT_UNPROVEN"
  | "SUBSCRIBER_GROWTH_EMAIL_TAB_NOT_FOUND" | "SUBSCRIBER_GROWTH_EMAIL_TAB_NOT_SELECTED" | "SUBSCRIBER_GROWTH_VIEW_NOT_FOUND" | "SUBSCRIBER_GROWTH_VIEW_NOT_SELECTED"
  | "SUBSCRIBER_GROWTH_DATE_CONTROL_NOT_FOUND" | "REPORT_PERIOD_NOT_CONFIRMED" | "SUBSCRIBER_GROWTH_METRICS_NOT_RENDERED" | "SUBSCRIBER_GROWTH_METRIC_NOT_EXACT"
  | "SUBSCRIBER_GROWTH_CHART_NOT_RENDERED" | "SUBSCRIBER_GROWTH_NOT_STABLE" | "SUBSCRIBER_GROWTH_TARGET_OCCLUDED" | "TARGET_BOUNDS_INVALID" | "KLAVIYO_PAGE_ADAPTER_ERROR";
export type SubscriberGrowthAdapterResult =
  | { ok: true; sourceUrl: string; targetRect: SubscriberGrowthTargetBounds; detectedPeriod: string; periodEvidence: { startDate: string; endDate: string }; evidence: SubscriberGrowthEvidence; diagnostics: Record<string, unknown> }
  | { ok: false; code: SubscriberGrowthFailureCode; message: string; diagnostics?: Record<string, unknown> };

export interface SubscriberGrowthCaptureRequest {
  /**
   * "capture" (Section 10): proves the client's account, prepares Email → Growth, sets the report month, and crops.
   * "source" (one-time source setup): prepares Email → Growth from whatever view is open (e.g. Overview, Last 7 days)
   * and returns the stable address; it never needs or sets a report month.
   */
  purpose?: "capture" | "source";
  period: Pick<ReportPeriod, "startDate" | "endDate"> | null;
  clientName: string | null;
  /** Bounded condition waits; nothing below is a blind fixed sleep. */
  readinessTimeoutMs: number;
  stability: { sampleIntervalMs: number; requiredStableSamples: number; timeoutMs: number };
}

/** Result of one-time source setup (`purpose: "source"`): the prepared page's stable address and visible account labels. */
export type SubscriberGrowthSourceProbe =
  | { ok: true; purpose: "source"; sourceUrl: string; emailSelected: true; growthSelected: true; accountLabels: string[]; selections: string[] }
  | { ok: false; code: SubscriberGrowthFailureCode; message: string; diagnostics?: Record<string, unknown> };

/**
 * Serialized into the toolbar-authorized tab. Read-only: it selects the Email tab and Growth view, sets the report's
 * date range, scrolls, and marks a crop. It never edits profiles, suppressions, lists, segments, or forms.
 *
 * Every readiness condition is polled until it holds or its bound passes (Klaviyo renders numbers before charts and
 * re-renders both after a date change), and the Email → Growth card is accepted only after its numbers, period, tabs,
 * chart geometry, and box stay identical across consecutive samples. Must stay self-contained: Chrome serializes this
 * function and runs it without module scope.
 */
export async function prepareSubscriberGrowthDocument(request: SubscriberGrowthCaptureRequest): Promise<SubscriberGrowthAdapterResult | SubscriberGrowthSourceProbe> {
  // An exception escaping an injected function reaches the extension as a bare `null` (run 8fdc5fcc): every exit is
  // plain JSON, and any exception becomes a typed, serializable failure.
  try {
    const result = await (async (): Promise<SubscriberGrowthAdapterResult | SubscriberGrowthSourceProbe> => {
      const forSource = request.purpose === "source";
      const started = Date.now();
      const timings: Record<string, number> = {};
      const mark = (name: string) => { timings[name] = Date.now() - started; };
      const sourceUrl = `${location.origin}${location.pathname}`;
      const normalize = (value: string | null | undefined) => (value ?? "").replace(/\s+/g, " ").trim();
      const key = (value: string | null | undefined) => normalize(value).toLocaleLowerCase();
      const text = (node: Element) => normalize((node as HTMLElement).innerText || node.textContent || "");
      const shown = (node: Element) => { const rect = node.getBoundingClientRect(); const style = getComputedStyle(node); return rect.width > 1 && rect.height > 1 && style.display !== "none" && style.visibility !== "hidden" && !node.closest("[hidden],[aria-hidden=true]"); };
      const label = (node: Element) => normalize([node.getAttribute("aria-label"), node.getAttribute("title"), text(node)].filter(Boolean).join(" "));
      const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
      const deadline = started + request.readinessTimeoutMs;
      async function waitUntil<T>(probe: () => T | null | undefined | false, timeoutMs: number): Promise<T | null> {
        const until = Math.min(Date.now() + timeoutMs, deadline);
        for (;;) { const value = probe(); if (value) return value; if (Date.now() >= until) return null; await pause(250); }
      }
      // Same contiguous-range grammar as the Campaigns adapter: "August 1 – 31, 2026", "Aug 1 – Aug 31, 2026",
      // "Aug 1, 2026 – Aug 31, 2026", "08/01/2026 – 08/31/2026", "2026-08-01 – 2026-08-31".
      const parsePeriod = (value: string | null | undefined): { startDate: string; endDate: string } | null => {
        const source = key(value);
        const months = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
        const monthName = "(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\\.?";
        const day = "(\\d{1,2})(?:st|nd|rd|th)?"; const dash = "\\s*(?:[–—-]|to)\\s*";
        const iso = (year: number, month: number, dayOfMonth: number) => { const date = new Date(Date.UTC(year, month - 1, dayOfMonth)); return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === dayOfMonth ? date.toISOString().slice(0, 10) : null; };
        const month = (name: string) => months.indexOf(name.slice(0, 3)) + 1;
        const range = (start: string | null, end: string | null) => start && end && start <= end ? { startDate: start, endDate: end } : null;
        const match = (pattern: string) => source.match(new RegExp(`(?:^|[^\\w/])${pattern}(?![\\w/])`));
        const both = match(`${monthName} ${day},? (\\d{4})${dash}${monthName} ${day},? (\\d{4})`);
        if (both) return range(iso(Number(both[3]), month(both[1]!), Number(both[2])), iso(Number(both[6]), month(both[4]!), Number(both[5])));
        const sharedYear = match(`${monthName} ${day}${dash}${monthName} ${day},? (\\d{4})`);
        if (sharedYear) return range(iso(Number(sharedYear[5]), month(sharedYear[1]!), Number(sharedYear[2])), iso(Number(sharedYear[5]), month(sharedYear[3]!), Number(sharedYear[4])));
        const sharedMonth = match(`${monthName} ${day}${dash}${day},? (\\d{4})`);
        if (sharedMonth) return range(iso(Number(sharedMonth[4]), month(sharedMonth[1]!), Number(sharedMonth[2])), iso(Number(sharedMonth[4]), month(sharedMonth[1]!), Number(sharedMonth[3])));
        const numeric = match(`(\\d{1,2})/(\\d{1,2})/(\\d{4})${dash}(\\d{1,2})/(\\d{1,2})/(\\d{4})`);
        if (numeric) return range(iso(Number(numeric[3]), Number(numeric[1]), Number(numeric[2])), iso(Number(numeric[6]), Number(numeric[4]), Number(numeric[5])));
        const isoRange = match(`(\\d{4})-(\\d{2})-(\\d{2})${dash}(\\d{4})-(\\d{2})-(\\d{2})`);
        if (isoRange) return range(iso(Number(isoRange[1]), Number(isoRange[2]), Number(isoRange[3])), iso(Number(isoRange[4]), Number(isoRange[5]), Number(isoRange[6])));
        return null;
      };
      const selected = (node: Element) => ["aria-selected", "aria-pressed", "aria-checked"].some((name) => node.getAttribute(name) === "true")
        || ["page", "true", "step", "location"].includes(node.getAttribute("aria-current") ?? "") || /^(active|on|checked|selected)$/i.test(node.getAttribute("data-state") ?? "") || node.getAttribute("data-selected") === "true";
      const isSelected = (node: Element) => selected(node) || Boolean(node.closest("[role=tab],[role=radio]") && selected(node.closest("[role=tab],[role=radio]")!)) || Array.from(node.querySelectorAll("[role=tab],[role=radio]")).some(selected);
      // Only tab-like reporting controls are ever considered (and clicked): a tab/radio role, an explicit selection
      // state, or membership of a tablist/radiogroup. Never an ordinary action button.
      const tabLike = (node: Element) => /^(tab|radio|menuitemradio|option)$/.test(node.getAttribute("role") ?? "")
        || ["aria-selected", "aria-pressed", "aria-current", "aria-checked", "data-state", "data-selected"].some((name) => node.hasAttribute(name))
        || Boolean(node.closest("[role=tablist],[role=radiogroup]"));
      const tabControls = () => Array.from(document.querySelectorAll("[role=tab],[role=radio],[role=button],button,a,[role=option],[role=menuitemradio]")).filter((node) => shown(node) && tabLike(node));
      const near = (left: Element, right: Element) => { for (let node: Element | null = left.parentElement, depth = 0; node && depth < 5; node = node.parentElement, depth += 1) if (node.contains(right)) return true; return false; };
      // Top level: Overview | Email | Text message. Inside the Email subscribers card: Growth | Opt-in sources | Exclusion sources.
      const channelPattern = /^(overview|email|text message|sms)$/i; const viewPattern = /^(growth|opt-in sources|exclusion sources)$/i;
      const channelTabs = () => { const all = tabControls(); return all.filter((node) => channelPattern.test(text(node)) && all.some((other) => other !== node && channelPattern.test(text(other)) && near(node, other))); };
      const viewTabs = () => { const all = tabControls(); return all.filter((node) => viewPattern.test(text(node)) && all.some((other) => other !== node && viewPattern.test(text(other)) && near(node, other))); };
      const tabState = () => ({ channel: channelTabs().map((node) => ({ text: text(node), selected: isSelected(node) })), view: viewTabs().map((node) => ({ text: text(node), selected: isSelected(node) })) });
      const spinnerSelector = "[aria-busy=true],[role=progressbar],[data-loading=true],[data-asc=Spinner],[class*=skeleton i],[class*=spinner i]";

      // Page identity, by visible text only. Klaviyo renders two layouts of this page: accounts with SMS get the
      // Overview | Email | Text message channel tabs (Faceables, Steven Dann); an email-only account (Purely Nutrient,
      // run 8fa3b760, 2026-11-11) gets no channel tabs at all and opens directly on the "Email subscribers" card. Requiring
      // the channel tabs made every Purely Nutrient attempt a false SUBSCRIBER_GROWTH_PAGE_NOT_READY.
      const headingNodes = () => Array.from(document.querySelectorAll("h1,h2,h3,h4,h5,h6,[role=heading]")).filter(shown);
      const headings = () => headingNodes().map(text);
      const pageIdentityFound = () => headings().some((value) => /^subscriber(s| growth| overview| trends)?$/i.test(value));
      const emailHeading = () => headingNodes().find((node) => /^email subscribers$/i.test(text(node)));
      const otherChannelHeading = () => headings().some((value) => /^(?:text message|sms) subscribers$/i.test(value));
      const emailTab = () => channelTabs().find((node) => /^email$/i.test(text(node)));
      const growthTab = () => viewTabs().find((node) => /^growth$/i.test(text(node)));
      // Email-only layout: no channel switcher exists, and the card shown is "Email subscribers" (never Text message).
      const singleChannelEmail = () => channelTabs().length === 0 && !otherChannelHeading() ? emailHeading() ?? null : null;
      const isSubscriberGrowthPage = () => pageIdentityFound() && Boolean(emailTab() || singleChannelEmail());

      // Date control nearest the Growth view.
      const controls = () => Array.from(document.querySelectorAll("button,[role=button],[role=combobox],input,select")).filter(shown);
      const rollingRange = /^(?:last \d+ (?:days?|weeks?|months?)|(?:this|last) (?:week|month|quarter|year)|all time|today|yesterday|custom(?: range)?)$/i;
      const depth = (node: Element | null) => { let count = 0; for (let current = node; current; current = current.parentElement) count += 1; return count; };
      const sharedDepth = (node: Element, other: Element) => { const chain = new Set<Element>(); for (let current: Element | null = node; current; current = current.parentElement) chain.add(current); for (let current: Element | null = other; current; current = current.parentElement) if (chain.has(current)) return depth(current); return 0; };
      const controlValue = (node: Element) => node instanceof HTMLInputElement ? normalize(node.value) : text(node);
      const dateFilter = () => { const anchor = growthTab(); return controls().map((node) => ({ node, value: controlValue(node) })).filter(({ value }) => value.length <= 60 && (rollingRange.test(value) || parsePeriod(value) !== null)).map((candidate) => ({ ...candidate, proximity: anchor ? sharedDepth(candidate.node, anchor) : 0 })).sort((a, b) => b.proximity - a.proximity)[0]?.node ?? null; };

      // Metrics: exact whole numbers beside their own labels, outside the charts.
      const metricLabels = { emailSubscribers: "email subscribers", newSubscribers: "new subscribers", exclusions: "exclusions" } as const;
      const inChart = (node: Element) => Boolean(node.closest("svg,canvas"));
      const readMetric = (wanted: string) => {
        const labels = Array.from(document.querySelectorAll("body *")).filter((node) => node.children.length === 0 || Array.from(node.children).every((child) => !text(child)))
          .filter((node) => key(text(node)) === wanted && shown(node) && !inChart(node));
        for (const labelNode of labels) {
          for (let container: Element | null = labelNode.parentElement, level = 0; container && level < 4; container = container.parentElement, level += 1) {
            if (container.querySelector("svg path,svg rect,canvas") && container.querySelector("svg")?.getBoundingClientRect().width! > 60) break;
            if (Object.values(metricLabels).some((other) => other !== wanted && key(text(container!)).includes(other))) break;
            const rest = key(text(container)).replace(wanted, " ");
            const changeText = rest.match(/[+\-−–]?\s?\d+(?:[.,]\d+)?\s?%/)?.[0]?.replace(/\s+/g, "") ?? null;
            const token = rest.replace(/[+\-−–]?\s?\d+(?:[.,]\d+)?\s?%/g, " ").match(/(?:^|\s)(\d[\d,.]*\s?[kmb]?)(?=\s|$)/)?.[1]?.trim();
            if (!token) continue;
            const exact = /^\d{1,3}(?:,\d{3})+$|^\d+$/.test(token);
            return { node: container, token, value: exact ? Number(token.replace(/,/g, "")) : null, change: changeText };
          }
        }
        return null;
      };
      const readMetrics = () => { const values = { emailSubscribers: readMetric(metricLabels.emailSubscribers), newSubscribers: readMetric(metricLabels.newSubscribers), exclusions: readMetric(metricLabels.exclusions) }; return values.emailSubscribers && values.newSubscribers && values.exclusions ? values as { [K in keyof typeof values]: NonNullable<typeof values[K]> } : null; };

      // Charts: a plotted line chart and a separate plotted bar chart, never a blank or loading surface.
      const paint = (node: Element, name: "fill" | "stroke") => key(node.getAttribute(name) ?? (getComputedStyle(node) as unknown as Record<string, string>)[name] ?? "");
      const visiblePaint = (value: string) => Boolean(value) && !/^(none|transparent)$/.test(value) && !/rgba\(.*,\s*0\)$/.test(value);
      const chartSurfaces = () => Array.from(document.querySelectorAll("svg")).filter((svg) => { const rect = svg.getBoundingClientRect(); return rect.width >= 200 && rect.height >= 80 && shown(svg) && !svg.closest("button,a"); });
      const describe = (svg: SVGSVGElement) => {
        const box = svg.getBoundingClientRect();
        const marks = Array.from(svg.querySelectorAll("path,rect,polyline,line")).filter((node) => !node.closest("defs,clipPath,mask"));
        const lines = marks.filter((node) => {
          if (node.tagName.toLowerCase() === "polyline") return (node.getAttribute("points") ?? "").trim().split(/\s+/).length >= 2;
          if (node.tagName.toLowerCase() !== "path" || !visiblePaint(paint(node, "stroke")) || visiblePaint(paint(node, "fill"))) return false;
          const rect = node.getBoundingClientRect();
          return (node.getAttribute("d") ?? "").replace(/^\s*[Mm][^A-Za-z]*/, "").match(/[LlCcHhVvSsQqTtAa]/g)?.length! >= 2 && rect.width >= box.width * 0.4;
        });
        const bars = marks.filter((node) => {
          if (!["rect", "path"].includes(node.tagName.toLowerCase()) || !visiblePaint(paint(node, "fill"))) return false;
          const rect = node.getBoundingClientRect();
          return rect.width >= 1 && rect.height >= 1 && rect.width <= box.width * 0.5;
        });
        return { svg, lines: lines.length, bars: bars.length, signature: `${Math.round(box.width)}x${Math.round(box.height)}:${marks.length}:${marks.map((node) => `${node.getAttribute("d")?.length ?? 0}/${Math.round(node.getBoundingClientRect().height)}`).join(",")}` };
      };
      const charts = () => {
        const described = chartSurfaces().map(describe);
        const line = described.find((chart) => chart.lines >= 1 && chart.bars < 2);
        const bar = described.find((chart) => chart !== line && chart.bars >= 2);
        return line && bar ? { line, bar, described } : null;
      };

      const describeNode = (node: Node) => node instanceof Element ? `${node.tagName.toLowerCase()}${node.id ? `#${node.id}` : ""}${typeof node.className === "string" && node.className ? `.${node.className.trim().split(/\s+/).slice(0, 2).join(".")}` : ""}`.slice(0, 80) : "node";
      // Loading counts only when a visible loading element lies over the required evidence itself. Spinners left hidden
      // in the DOM (display:none, visibility:hidden, aria-hidden, zero size, transparent), tooltips, and an unrelated
      // refresh icon beside the date range never hold the page back.
      const overlaps = (a: DOMRect, b: DOMRect) => a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
      const visibleLoading = (evidence: Element[]) => {
        const boxes = evidence.map((node) => node.getBoundingClientRect()).filter((box) => box.width > 0 && box.height > 0);
        return Array.from(document.querySelectorAll(spinnerSelector)).filter((node) => shown(node) && getComputedStyle(node).opacity !== "0" && !node.closest("[role=tooltip]")
          && boxes.some((box) => overlaps(node.getBoundingClientRect(), box)));
      };
      // PAGE_READY is semantic evidence only; the report month is checked separately afterwards (an initial "Last 7
      // days" is a ready page). Every field is recorded on every attempt so a failure names the condition that stayed false.
      const readiness = () => {
        const email = emailTab(); const single = singleChannelEmail(); const growth = growthTab();
        const values = { emailSubscribers: readMetric(metricLabels.emailSubscribers), newSubscribers: readMetric(metricLabels.newSubscribers), exclusions: readMetric(metricLabels.exclusions) };
        const surfaces = chartSurfaces();
        const loadingNodes = visibleLoading([growth, single, values.emailSubscribers?.node, values.newSubscribers?.node, values.exclusions?.node, ...surfaces].filter((node): node is Element => Boolean(node)));
        const date = dateFilter();
        const channelLayout = channelTabs().length ? "channel-tabs" as const : "email-only" as const;
        const record = {
          pageIdentityFound: pageIdentityFound(), emailSubscribersHeadingFound: Boolean(emailHeading()), channelLayout,
          emailTabFound: Boolean(email), emailTabSelected: email ? isSelected(email) : null,
          growthTabFound: Boolean(growth), growthTabSelected: Boolean(growth && isSelected(growth)),
          subscriberValueFound: Boolean(values.emailSubscribers), newSubscribersValueFound: Boolean(values.newSubscribers), exclusionsValueFound: Boolean(values.exclusions),
          chartBounds: surfaces.map((svg) => { const box = svg.getBoundingClientRect(); return { width: Math.round(box.width), height: Math.round(box.height) }; }),
          visibleLoadingElements: loadingNodes.slice(0, 6).map(describeNode),
          periodShown: date ? controlValue(date).slice(0, 120) : null,
        };
        const emailReady = channelLayout === "channel-tabs" ? record.emailTabSelected === true : Boolean(single);
        return { ...record, ready: record.pageIdentityFound && emailReady && record.growthTabSelected && record.subscriberValueFound && record.newSubscribersValueFound && record.exclusionsValueFound && surfaces.length > 0 && loadingNodes.length === 0 };
      };

      let periodProof: Record<string, unknown> | null = null;
      const readinessSnapshot = () => { try { return readiness(); } catch (error) { return { error: error instanceof Error ? error.message.slice(0, 200) : String(error) }; } };
      const failure = (code: SubscriberGrowthFailureCode, message: string, extra: Record<string, unknown> = {}): SubscriberGrowthAdapterResult => ({ ok: false, code, message, diagnostics: { currentUrl: sourceUrl, tabs: tabState(), readiness: readinessSnapshot(), ...(periodProof ? { periodProof: { ...periodProof } } : {}), stageTimingsMs: { ...timings }, ...extra } });

      // 1. Source page: Klaviyo's Subscriber growth reporting area, whichever view it opened on (Overview, Email, …).
      // It is identified before anything is clicked: a subscriber heading plus either the Email channel tab or, on an
      // email-only account, the Email subscribers card itself.
      if (!await waitUntil(isSubscriberGrowthPage, forSource ? 8_000 : 25_000)) {
        return forSource ? failure("SUBSCRIBER_GROWTH_SOURCE_WRONG_PAGE", "This tab is not Klaviyo's Subscriber growth page. Open Audience → Profiles → View subscriber growth, then click the Tention toolbar icon.", { headings: headings().slice(0, 8) })
          : failure("SUBSCRIBER_GROWTH_PAGE_NOT_READY", "The authorized tab did not render Klaviyo's Subscriber growth page.", { headings: headings().slice(0, 8) });
      }
      mark("pageReadyMs");

      // 2. Account: for capture, the visible Klaviyo account must be the report's client. Source setup returns the labels
      // and the panel, which knows the client, refuses to save another account's page.
      const expectedAccount = key(request.clientName);
      // The same account candidates Business Review discovery reads: everything in the header/banner, navigation
      // controls, and explicit account controls (each label already joins aria-label, title and text).
      const accountLabels = () => Array.from(document.querySelectorAll("header *,[role=banner] *,nav button,nav [role=button],nav a,aside button,aside [role=button],[aria-label*=account i],[title*=account i],[data-testid*=account i],[aria-label*=workspace i],[aria-label*=organization i]"))
        .filter(shown).map(label).filter((value) => value && value.length <= 160).filter((value, index, all) => all.indexOf(value) === index).slice(0, 60);
      const accountIdentity = forSource ? null : expectedAccount ? await waitUntil(() => accountLabels().find((value) => key(value).includes(expectedAccount)), 10_000) : null;
      if (!forSource && !accountIdentity) return failure("SUBSCRIBER_GROWTH_ACCOUNT_UNPROVEN", "The Klaviyo account shown could not be proven to be the selected report client.", { expectedClient: request.clientName, accountCandidates: accountLabels().slice(0, 10).map((value) => value.slice(0, 80)) });

      // 3. Email tab, then its Growth view. Selecting a tab is view navigation only.
      // React replaces these controls when the view changes: every check re-queries the live DOM, no element is reused.
      const selections: string[] = [];
      const select = async (find: () => Element | undefined, missingCode: "SUBSCRIBER_GROWTH_EMAIL_TAB_NOT_FOUND" | "SUBSCRIBER_GROWTH_VIEW_NOT_FOUND", code: "SUBSCRIBER_GROWTH_EMAIL_TAB_NOT_SELECTED" | "SUBSCRIBER_GROWTH_VIEW_NOT_SELECTED", name: string) => {
        const control = await waitUntil(find, 15_000);
        if (!control) return failure(missingCode, `The ${name} tab was not available on Subscriber growth.`);
        if (!isSelected(control)) { (control as HTMLElement).click(); selections.push(name); }
        if (!await waitUntil(() => { const current = find(); return current && isSelected(current); }, 10_000)) return failure(code, `Klaviyo did not show the ${name} tab as selected.`);
        return null;
      };
      // The email-only layout has no Email tab to select: its Email subscribers card is the Email channel.
      if (emailTab() || !singleChannelEmail()) {
        const emailFailure = await select(emailTab, "SUBSCRIBER_GROWTH_EMAIL_TAB_NOT_FOUND", "SUBSCRIBER_GROWTH_EMAIL_TAB_NOT_SELECTED", "Email");
        if (emailFailure) return emailFailure;
      }
      const growthFailure = await select(growthTab, "SUBSCRIBER_GROWTH_VIEW_NOT_FOUND", "SUBSCRIBER_GROWTH_VIEW_NOT_SELECTED", "Growth");
      if (growthFailure) return growthFailure;
      // Overview, Text message, Opt-in sources and Exclusion sources are never accepted alongside the canonical view.
      const canonicalTabs = () => {
        const state = tabState();
        const channelIsEmail = state.channel.length ? state.channel.filter(({ selected: on }) => on).map(({ text: value }) => value.toLocaleLowerCase()).join("|") === "email" : Boolean(singleChannelEmail());
        return channelIsEmail && state.view.filter(({ selected: on }) => on).map(({ text: value }) => value.toLocaleLowerCase()).join("|") === "growth";
      };
      if (!canonicalTabs()) return failure(tabState().channel.some(({ text: value, selected: on }) => on && !/^email$/i.test(value)) ? "SUBSCRIBER_GROWTH_EMAIL_TAB_NOT_SELECTED" : "SUBSCRIBER_GROWTH_VIEW_NOT_SELECTED", "Subscriber growth is not showing exactly Email → Growth.");
      mark("viewSwitchMs");

      // One-time source setup ends here: the Email → Growth card (all three metric labels) is proven, and its stable
      // address is returned. The report month is set by every Section 10 capture, never by source setup.
      if (forSource) {
        const mainText = () => key((document.querySelector("main") ?? document.body).textContent);
        const metricsShown = await waitUntil(() => ["email subscribers", "new subscribers", "exclusions"].every((name) => mainText().includes(name)) && canonicalTabs(), 15_000);
        if (!metricsShown) return failure("SUBSCRIBER_GROWTH_METRICS_NOT_RENDERED", "Email subscribers, New subscribers and Exclusions did not render on Subscriber growth → Email → Growth.", { missing: ["email subscribers", "new subscribers", "exclusions"].filter((name) => !mainText().includes(name)) });
        return { ok: true, purpose: "source", sourceUrl, emailSelected: true, growthSelected: true, accountLabels: accountLabels().slice(0, 20).map((value) => value.slice(0, 120)), selections };
      }
      const period = request.period;
      if (!period) return failure("REPORT_PERIOD_NOT_CONFIRMED", "Section 10 capture requires the report month.");

      // 4. PAGE_READY: identity, Email channel, Growth selected, all three metrics, a chart with real bounds, and no
      // visible loading state over that evidence. Whatever period is showing (e.g. "Last 7 days") is not part of it;
      // the moment every marker holds, the run continues to the period without further waiting.
      let lastReadiness = readiness();
      const pageReady = await waitUntil(() => { lastReadiness = readiness(); return lastReadiness.ready ? lastReadiness : null; }, 20_000);
      if (!pageReady) {
        const state = lastReadiness;
        const metricsMissing = ["subscriberValueFound", "newSubscribersValueFound", "exclusionsValueFound"].filter((name) => !state[name as keyof typeof state]);
        if (state.visibleLoadingElements.length) return failure("SUBSCRIBER_GROWTH_PAGE_NOT_READY", "A visible loading state stayed over the Subscriber growth metrics or charts.", { failedCondition: "visibleLoadingElements" });
        if (!canonicalTabs()) return failure(tabState().channel.some(({ text: value, selected: on }) => on && !/^email$/i.test(value)) ? "SUBSCRIBER_GROWTH_EMAIL_TAB_NOT_SELECTED" : "SUBSCRIBER_GROWTH_VIEW_NOT_SELECTED", "Subscriber growth stopped showing exactly Email → Growth.", { failedCondition: "tabs" });
        if (metricsMissing.length) return failure("SUBSCRIBER_GROWTH_METRICS_NOT_RENDERED", "Email subscribers, New subscribers and Exclusions were not all rendered.", { failedCondition: metricsMissing.join(",") });
        return failure("SUBSCRIBER_GROWTH_CHART_NOT_RENDERED", "No Subscriber growth chart area with visible bounds was rendered.", { failedCondition: "chartBounds" });
      }
      mark("readinessMs");
      const periodBefore = pageReady.periodShown;

      // 5. Exact report period, read from the date control nearest the Growth view.
      const proof = { expectedStart: period.startDate, expectedEnd: period.endDate, visiblePeriodText: null as string | null, parsedStart: null as string | null, parsedEnd: null as string | null, periodMatch: false };
      periodProof = proof;
      const provenPeriod = () => {
        const filter = dateFilter(); const visiblePeriodText = filter ? controlValue(filter).slice(0, 120) : null; const parsed = parsePeriod(visiblePeriodText);
        Object.assign(proof, { visiblePeriodText, parsedStart: parsed?.startDate ?? null, parsedEnd: parsed?.endDate ?? null, periodMatch: parsed?.startDate === period.startDate && parsed?.endDate === period.endDate });
        return proof.periodMatch ? visiblePeriodText : null;
      };
      // Wait only for the date control to exist; its own text then says whether the month is already showing.
      const initialControl = await waitUntil(dateFilter, 10_000);
      let periodText = initialControl ? provenPeriod() : null;
      if (!periodText) {
        const control = initialControl ?? await waitUntil(dateFilter, 1_000);
        if (!control) return failure("SUBSCRIBER_GROWTH_DATE_CONTROL_NOT_FOUND", "The Subscriber growth date-range control was not found.", { controls: controls().map(label).slice(0, 30).map((value) => value.slice(0, 60)) });
        (control as HTMLElement).click();
        const popovers = () => Array.from(document.querySelectorAll("[role=dialog],[role=listbox],[role=menu],[data-popper-placement],[aria-modal=true]")).filter(shown);
        const optionNodes = () => Array.from(document.querySelectorAll("[role=option],[role=menuitem],[role=menuitemradio],[role=radio],button,[role=button],li,label")).filter(shown);
        if (!await waitUntil(() => popovers().length > 0 || optionNodes().some((node) => /^custom\b/i.test(text(node))), 5_000)) return failure("SUBSCRIBER_GROWTH_DATE_CONTROL_NOT_FOUND", "Clicking the Subscriber growth date-range control did not open its picker.");
        const inputLabel = (input: HTMLInputElement) => [input.name, input.id, input.getAttribute("aria-label"), input.placeholder, label(input)].filter(Boolean).join(" ");
        const dateInputs = () => {
          const inputs = Array.from(document.querySelectorAll("input")).filter(shown).filter((input) => !["hidden", "checkbox", "radio", "search", "file"].includes(input.type))
            .filter((input) => input.type === "date" || /date|start|end|from|to|\b(?:m{1,2}\/d{1,2}\/y{2,4}|\d{1,2}\/\d{1,2}\/\d{2,4}|\d{4}-\d{2}-\d{2})\b/i.test([inputLabel(input), input.value].join(" ")));
          const starts = inputs.filter((input) => /start|from/i.test(inputLabel(input))); const ends = inputs.filter((input) => /end|to\b/i.test(inputLabel(input)));
          const start = starts.length === 1 ? starts[0]! : inputs.length === 2 ? inputs[0]! : null; const end = ends.length === 1 ? ends[0]! : inputs.length === 2 ? inputs[1]! : null;
          return start && end && start !== end ? { start, end } : null;
        };
        const longDate = (iso: string) => new Intl.DateTimeFormat("en-US", { timeZone: "UTC", month: "long", day: "numeric", year: "numeric" }).format(new Date(`${iso}T00:00:00.000Z`));
        const shortDate = (iso: string) => new Intl.DateTimeFormat("en-US", { timeZone: "UTC", month: "short", day: "numeric", year: "numeric" }).format(new Date(`${iso}T00:00:00.000Z`));
        const formatFor = (iso: string, input: HTMLInputElement) => { const [year, month, day] = iso.split("-"); const sample = `${input.value} ${input.placeholder}`; return input.type === "date" || /\d{4}-\d{2}-\d{2}/.test(sample) ? iso : /\d{1,2}\/\d{1,2}\/\d{2,4}|mm\/dd\/yyyy/i.test(sample) ? `${month}/${day}/${year}` : shortDate(iso); };
        const dayCell = (iso: string) => Array.from(document.querySelectorAll("button,[role=gridcell],[role=button],td")).filter(shown).find((node) => { const name = key([node.getAttribute("aria-label"), node.getAttribute("title"), node.getAttribute("data-date")].filter(Boolean).join(" ")); return Boolean(name) && [longDate(iso), shortDate(iso), iso].some((value) => name.includes(value.toLocaleLowerCase())) && node.getAttribute("aria-disabled") !== "true"; }) as HTMLElement | undefined;
        const pickDay = async (iso: string) => {
          const target = Date.parse(`${iso.slice(0, 7)}-01T00:00:00Z`);
          for (let step = 0; step < 36; step += 1) {
            const cell = dayCell(iso); if (cell) { cell.click(); await pause(50); return true; }
            const shownMonths = Array.from(document.querySelectorAll("[role=dialog] *,[data-popper-placement] *")).filter(shown).map(text).filter((value) => /^[A-Z][a-z]+ \d{4}$/.test(value)).map((value) => Date.parse(`1 ${value} UTC`)).filter(Number.isFinite);
            const direction = shownMonths.length && Math.min(...shownMonths) > target ? /prev|previous|back/i : /next|forward/i;
            const navigate = controls().find((node) => direction.test(label(node)) && /month|prev|next/i.test(label(node))) as HTMLElement | undefined;
            if (!navigate) return false;
            navigate.click(); await pause(100);
          }
          return false;
        };
        // Whichever the picker shows first: start/end inputs, a calendar, or a "Custom" preset that reveals them.
        const customOption = () => optionNodes().find((node) => /^custom\b/i.test(text(node))) as HTMLElement | undefined;
        const ready = () => dateInputs() ?? (dayCell(period.startDate) ? "calendar" as const : null);
        let picker = await waitUntil(() => ready() ?? (customOption() ? "custom" as const : null), 8_000);
        if (picker === "custom") { customOption()?.click(); picker = await waitUntil(ready, 8_000); }
        if (!picker) return failure("SUBSCRIBER_GROWTH_DATE_CONTROL_NOT_FOUND", "The Subscriber growth date picker exposed neither start/end inputs nor a calendar.");
        if (picker === "calendar") {
          if (!await pickDay(period.startDate) || !await pickDay(period.endDate)) return failure("SUBSCRIBER_GROWTH_DATE_CONTROL_NOT_FOUND", "The Subscriber growth calendar did not expose the report's first and last days.");
        } else {
          // The shared period helper replaces any range kept from another report and proves the fields hold the
          // report's exact dates; Apply is never clicked on any other values.
          const periodEntry = (globalThis as unknown as { __tentionPeriodEntry?: PeriodEntryApi }).__tentionPeriodEntry;
          if (!periodEntry) return failure("REPORT_PERIOD_NOT_CONFIRMED", "The shared period helper was not loaded, so the report month could not be set. Nothing was captured.");
          const entry = await periodEntry.enterDateRange({ fields: dateInputs, startDate: period.startDate, endDate: period.endDate, format: (input, iso) => formatFor(iso, input),
            reselectCustom: async () => { const custom = customOption(); if (!custom) return false; custom.click(); return Boolean(await waitUntil(() => dateInputs(), 3_000)); } });
          if (!entry.ok) return failure("REPORT_PERIOD_NOT_CONFIRMED", `Klaviyo's Subscriber growth date fields did not accept ${period.startDate} – ${period.endDate}; Apply was not clicked and nothing was captured.`);
        }
        // Only the open picker's own confirm button: never a page-level "Save" or any other action outside the picker.
        const pickerControls = () => { const open = popovers(); return open.length ? controls().filter((node) => open.some((popover) => popover.contains(node))) : []; };
        const apply = await waitUntil(() => pickerControls().find((node) => /^(?:apply|done|update)(?:\s+(?:range|dates?|filter))?$/i.test(label(node)) && !(node as HTMLButtonElement).disabled && node.getAttribute("aria-disabled") !== "true") as HTMLElement | undefined, 5_000);
        if (!apply) return failure("SUBSCRIBER_GROWTH_DATE_CONTROL_NOT_FOUND", "The Subscriber growth date range could not be applied.");
        apply.click();
        // Only Klaviyo's own rendering proves the period; a click alone is never evidence.
        periodText = await waitUntil(provenPeriod, 20_000);
        if (!periodText) return failure("REPORT_PERIOD_NOT_CONFIRMED", "Klaviyo did not visibly confirm the report month on Subscriber growth.");
      }
      mark("periodSetMs");

      // 6. Metrics for the report month (Klaviyo re-renders them after the date change).
      const metrics = await waitUntil(readMetrics, 20_000);
      if (!metrics) return failure("SUBSCRIBER_GROWTH_METRICS_NOT_RENDERED", "Email subscribers, New subscribers and Exclusions were not all rendered.");
      const notExact = Object.entries(metrics).filter(([, metric]) => metric.value === null).map(([name, metric]) => ({ name, token: metric.token }));
      if (notExact.length) return failure("SUBSCRIBER_GROWTH_METRIC_NOT_EXACT", "Klaviyo showed a compact or non-integer subscriber count; exact counts are required.", { notExact });

      // 7. Charts: a plotted line chart and a separate plotted bar chart, never a blank or loading surface.
      const chartPair = await waitUntil(charts, 25_000);
      if (!chartPair) return failure("SUBSCRIBER_GROWTH_CHART_NOT_RENDERED", "The Subscriber growth line chart and the New subscribers / Exclusions bar chart were not both rendered.", { surfaces: chartSurfaces().map(describe).map(({ lines, bars, signature }) => ({ lines, bars, signature: signature.slice(0, 200) })) });
      mark("contentReadyMs");

      // 7. Crop: the smallest container holding the date selector, the selected Email tab and Growth view, all three
      // metrics, and both charts — so the screenshot itself shows which view and period it is.
      const resolveCard = () => {
        const pair = charts(); const values = readMetrics(); const growth = growthTab(); const email = emailTab() ?? singleChannelEmail(); const date = dateFilter();
        if (!pair || !values || !growth || !email || !date) return null;
        const required = [email, growth, date, values.emailSubscribers.node, values.newSubscribers.node, values.exclusions.node, pair.line.svg, pair.bar.svg];
        // The Email subscribers card itself: the smallest container of its Growth view, three metrics and both charts.
        const cardParts = [growth, values.emailSubscribers.node, values.newSubscribers.node, values.exclusions.node, pair.line.svg, pair.bar.svg];
        let data: Element | null = pair.line.svg.parentElement;
        while (data && data !== document.body && !cardParts.every((item) => data!.contains(item))) data = data.parentElement;
        for (let node: Element | null = pair.line.svg.parentElement; node && node !== document.body; node = node.parentElement) if (required.every((item) => node!.contains(item))) return { card: node as HTMLElement, data: data && data !== document.body ? data : node, parts: cardParts, pair, values };
        return null;
      };
      const loading = (current: NonNullable<ReturnType<typeof resolveCard>>) => visibleLoading(current.parts).length > 0;
      // Only animations that will end hold the capture back (e.g. a chart drawing in). Looping ones — a "Last updated"
      // refresh icon, a live pulse — never end, so they cannot be waited for; loading is caught by the spinner check,
      // and the numbers, period, tabs and chart geometry must still repeat exactly.
      const endingAnimations = (card: Element) => typeof document.getAnimations !== "function" ? [] : document.getAnimations().filter((animation) => {
        const target = (animation.effect as KeyframeEffect | null)?.target;
        const iterations = (animation.effect as KeyframeEffect | null)?.getTiming?.().iterations;
        return animation.playState === "running" && target instanceof Element && card.contains(target) && shown(target) && iterations !== Infinity;
      });
      const parts = (current: NonNullable<ReturnType<typeof resolveCard>>) => {
        const rect = current.card.getBoundingClientRect();
        return { period: provenPeriod() ?? "", tabs: String(canonicalTabs()), metrics: JSON.stringify(Object.values(current.values).map(({ token, change }) => [token, change])), line: current.pair.line.signature, bar: current.pair.bar.signature, box: [rect.x, rect.y, rect.width, rect.height].map(Math.round).join(",") };
      };
      // Why each sample did not count, so a live failure names its cause instead of a bare "not stable".
      const reasons: Record<string, number> = {}; const animationTargets = new Set<string>();
      const note = (reason: string) => { reasons[reason] = (reasons[reason] ?? 0) + 1; };
      const stableUntil = Date.now() + request.stability.timeoutMs;
      let previous: ReturnType<typeof parts> | null = null; let stableSamples = 0; let resolved: ReturnType<typeof resolveCard> = null;
      let positioned = false;
      while (Date.now() <= stableUntil) {
        resolved = resolveCard();
        if (resolved && !positioned) { resolved.card.scrollIntoView?.({ block: "start", inline: "nearest", behavior: "auto" }); positioned = true; }
        let current: ReturnType<typeof parts> | null = null;
        if (!resolved) note("cardNotResolved");
        else if (loading(resolved)) note("spinnerOrSkeleton");
        else if (!provenPeriod()) note("periodNotShown");
        else if (!canonicalTabs()) note("tabsNotEmailGrowth");
        else {
          const running = endingAnimations(resolved.card);
          if (running.length) { note("animationRunning"); for (const animation of running.slice(0, 3)) animationTargets.add(describeNode((animation.effect as KeyframeEffect).target!)); }
          else current = parts(resolved);
        }
        if (current && previous) for (const [part, value] of Object.entries(current)) if (previous[part as keyof typeof current] !== value) note(`changed:${part}`);
        stableSamples = current !== null && previous !== null && JSON.stringify(current) === JSON.stringify(previous) ? stableSamples + 1 : 0;
        previous = current;
        if (stableSamples + 1 >= request.stability.requiredStableSamples) break;
        await pause(request.stability.sampleIntervalMs);
      }
      if (!resolved || stableSamples + 1 < request.stability.requiredStableSamples) return failure("SUBSCRIBER_GROWTH_NOT_STABLE", "The Subscriber growth card did not hold still with its period, tabs, numbers and charts loaded.", { stableSamples: stableSamples + 1, cardResolved: Boolean(resolved), loading: resolved ? loading(resolved) : null, visibleLoadingElements: resolved ? visibleLoading(resolved.parts).slice(0, 6).map(describeNode) : [], unstableReasons: reasons, animationTargets: [...animationTargets].slice(0, 6) });
      mark("stableMs");
      // The crop runs from the top of the reporting area (title, Email tab, date range) to the bottom of the Email
      // subscribers card. Klaviyo's reporting area can stretch to the bottom of the window, and on 2026-11-03 that left
      // ~800 px of blank page and the floating AI prompt in the Section 10 screenshot; nothing below the card is evidence.
      const area = resolved.card.getBoundingClientRect();
      const contentBottom = Math.max(resolved.data.getBoundingClientRect().bottom, ...resolved.parts.map((node) => node.getBoundingClientRect().bottom));
      const cropBottom = Math.min(area.bottom, Math.ceil(contentBottom) + 12);
      const rect = { left: area.left, top: area.top, right: area.right, bottom: cropBottom, width: area.width, height: cropBottom - area.top };
      const trimmedBelowCard = Math.max(0, Math.round(area.bottom - cropBottom));
      if (rect.width < 300 || rect.height < 200) return failure("TARGET_BOUNDS_INVALID", "No clean Subscriber growth card bounds were available.", { cardWidth: Math.round(rect.width), cardHeight: Math.round(rect.height) });
      if (rect.left < 0 || rect.top < 0 || rect.right > window.innerWidth || rect.bottom > window.innerHeight) return failure("TARGET_BOUNDS_INVALID", "The Email → Growth card does not fit inside the visible tab; enlarge the browser window so both charts and all three metrics are visible.", { cardHeight: Math.round(rect.height), viewportHeight: window.innerHeight });
      // Floating page chrome (Klaviyo's composer/assistant prompt, toasts, a sticky header) can be painted over the crop.
      // As in Business Review, what is on top is found by hit-testing across the crop; a positioned element outside the
      // card is hidden as temporary page styling only, and the crop must then hit only the card. Nothing is clicked.
      const card = resolved.card;
      const occluders = () => {
        if (typeof document.elementFromPoint !== "function") return [];
        const found = new Set<HTMLElement>();
        // Dense enough (about every 16 px down, 48 px across) that a short floating bar cannot fall between samples.
        const columns = Math.max(8, Math.ceil(rect.width / 48)); const rows = Math.max(6, Math.ceil(rect.height / 16));
        for (let column = 0; column <= columns; column += 1) for (let row = 0; row <= rows; row += 1) {
          const x = Math.min(window.innerWidth - 1, rect.left + 4 + (rect.width - 8) * column / columns);
          const y = Math.min(window.innerHeight - 1, rect.top + 4 + (rect.height - 8) * row / rows);
          const hit = document.elementFromPoint(x, y);
          if (!hit || card.contains(hit) || hit.contains(card)) continue;
          let root: Element = hit; let positioned = false;
          for (let node: Element | null = hit; node && !node.contains(card); node = node.parentElement) { root = node; if (/^(?:fixed|sticky|absolute)$/.test(getComputedStyle(node).position)) positioned = true; }
          found.add(positioned ? root as HTMLElement : hit as HTMLElement);
        }
        return [...found];
      };
      const covering = occluders();
      const hideable = covering.filter((node) => /^(?:fixed|sticky|absolute)$/.test(getComputedStyle(node).position));
      for (const overlay of hideable) overlay.style.setProperty("visibility", "hidden", "important");
      const stillCovered = covering.length ? occluders() : [];
      if (stillCovered.length) return failure("SUBSCRIBER_GROWTH_TARGET_OCCLUDED", "Something that is part of the page is covering the Subscriber growth card.", { occluders: stillCovered.slice(0, 4).map((node) => `${node.tagName.toLowerCase()} ${label(node).slice(0, 80)}`) });
      resolved.card.dataset.tentionSubscriberGrowth = "capture";
      const final = resolved.values;
      const evidence: SubscriberGrowthEvidence = {
        channel: "email", view: "growth",
        emailSubscribers: final.emailSubscribers.value!, newSubscribers: final.newSubscribers.value!, exclusions: final.exclusions.value!,
        changes: { emailSubscribers: final.emailSubscribers.change, newSubscribers: final.newSubscribers.change, exclusions: final.exclusions.change },
        charts: { subscriberGrowthLine: true, newSubscribersExclusionsBar: true }, visiblePeriodText: periodText!,
      };
      mark("totalMs");
      return {
        ok: true, sourceUrl, detectedPeriod: periodText!, periodEvidence: { startDate: period.startDate, endDate: period.endDate }, evidence,
        targetRect: { x: rect.left, y: rect.top, width: rect.width, height: rect.height, viewportWidth: window.innerWidth, viewportHeight: window.innerHeight, visibleControls: [...(tabState().channel.length ? tabState().channel : [{ text: "Email subscribers", selected: true, kind: "email-only-card" }]), ...tabState().view].map(({ text: value, selected: on, ...rest }) => ({ text: value, selected: on, ...rest })), stageTimingsMs: { ...timings } },
        diagnostics: { accountIdentity: (accountIdentity ?? "").slice(0, 80), hiddenOverlays: hideable.length, trimmedBelowCard, stableSamples: stableSamples + 1, periodProof: { ...proof }, readiness: pageReady, periodBefore, periodAfter: periodText, charts: { lineMarks: resolved.pair.line.lines, barMarks: resolved.pair.bar.bars } },
      };
    })();
    return JSON.parse(JSON.stringify(result)) as SubscriberGrowthAdapterResult;
  } catch (error) {
    return { ok: false, code: "KLAVIYO_PAGE_ADAPTER_ERROR", message: `The Klaviyo page helper failed: ${error instanceof Error ? error.message : String(error)}`.slice(0, 500), diagnostics: { failureStage: "UNCAUGHT_EXCEPTION", errorName: error instanceof Error ? error.name : typeof error, stack: (error instanceof Error && error.stack ? error.stack : "").split("\n").slice(0, 8).join("\n").slice(0, 2_000), currentUrl: `${location.origin}${location.pathname}` } };
  }
}

export function isSubscriberGrowthScreenshotType(value: ScreenshotType): value is "email_subscriber_growth" { return value === "email_subscriber_growth"; }
