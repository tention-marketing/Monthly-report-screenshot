import { TOP_CAMPAIGNS_LIMIT, type ReportPeriod } from "@tention/report-schema";

export const TOP_CAMPAIGN_ROW_COUNT = TOP_CAMPAIGNS_LIMIT;
export type CampaignsFailureCode =
  | "CAMPAIGNS_ROUTE_REQUIRED" | "CAMPAIGNS_PAGE_NOT_READY" | "CAMPAIGNS_ACCOUNT_UNPROVEN"
  | "CAMPAIGNS_DATE_CONTROL_NOT_FOUND" | "REPORT_PERIOD_NOT_CONFIRMED" | "CAMPAIGNS_METRIC_UNPROVEN"
  | "TOP_CAMPAIGNS_NO_DATA" | "TOP_CAMPAIGNS_INCOMPLETE_RESULT_SET" | "TOP_CAMPAIGNS_UNSTABLE"
  | "TOP_CAMPAIGNS_ROWS_NOT_VISIBLE" | "TARGET_NOT_VISIBLE" | "TARGET_LAYOUT_NOT_STABLE" | "KLAVIYO_PAGE_ADAPTER_ERROR"
  | "TOP_CAMPAIGNS_STATUS_FILTER_NOT_FOUND" | "TOP_CAMPAIGNS_STATUS_MENU_NOT_OPENED" | "TOP_CAMPAIGNS_STATUS_FILTER_NOT_APPLIED" | "TOP_CAMPAIGNS_SORT_UNPROVEN" | "TOP_CAMPAIGNS_NON_SENT_ROW_IN_VIEW";

export interface CampaignRow {
  name: string; type: string | null; status: "Sent" | string; sendDate: string | null;
  openRate: string | null; clickRate: string | null; placedOrderValue: number | null; domOrder: number;
}
export interface CampaignTargetBounds { x: number; y: number; width: number; height: number; viewportWidth: number; viewportHeight: number; availableRowCount: number; includedRowCount: number; periodProof?: Record<string, unknown>; ranking?: Record<string, unknown>; visibleControls?: Array<Record<string, string | boolean | null>>; stageTimingsMs?: Record<string, number> }
export interface CampaignsCaptureRequest { clientName: string; clientTimezone: string; conversionMetric: string; desiredCount: number; period: Pick<ReportPeriod, "startDate" | "endDate">; }
export interface CampaignsEvidence { accountIdentity: string; clientTimezone: string; visibleMetricLabel: string; rankingMethod: "klaviyo-native-sort" | "complete-result-set"; eligibleRowCount: number; includedRowCount: number; rows: Array<Omit<CampaignRow, "domOrder" | "placedOrderValue"> & { status: "Sent"; placedOrderValue: number }>; }
export type CampaignsAdapterResult =
  | { ok: true; sourceUrl: string; targetRect: CampaignTargetBounds; observedPeriod: { startDate: string; endDate: string }; evidence: CampaignsEvidence }
  | { ok: false; code: CampaignsFailureCode; message: string; diagnostics?: Record<string, unknown> };

/** Pure, locale-tolerant numeric parser used by both DOM adapter and tests. */
export function parseCampaignRevenue(value: string | null | undefined): number | null {
  const text = (value ?? "").replace(/\s+/g, " ").trim();
  if (!text || /^(?:—|-|n\/?a|null)$/i.test(text)) return null;
  const token = text.match(/(?:[A-Z]{3}\s*)?[$€£]?\s*\(?-?[\d,.]+\)?/);
  if (!token) return null;
  const normalized = token[0].replace(/[A-Z$€£\s,]/gi, "").replace(/[()]/g, "");
  const amount = Number(normalized);
  return Number.isFinite(amount) ? amount : null;
}

/**
 * Resolves a campaign's channel from the Type cell's visible text and semantic metadata (aria-label, title,
 * SVG title, test id, alt). Exactly one proven channel yields "Email" or "SMS"; none or a conflict yields null.
 */
export function campaignChannel(labels: ReadonlyArray<string | null | undefined>): "Email" | "SMS" | null {
  const channels = new Set(labels.map((label) => (label ?? "").replace(/\s+/g, " ").trim()).filter(Boolean)
    .flatMap((label) => [...(/\b(?:sms|mms)|\btext[\s_-]?message/i.test(label) ? ["SMS" as const] : []), ...(/\be-?mail|\benvelope/i.test(label) ? ["Email" as const] : [])]));
  return channels.size === 1 ? [...channels][0]! : null;
}

export function rankEligibleCampaigns(rows: readonly CampaignRow[], desiredCount = TOP_CAMPAIGN_ROW_COUNT): CampaignRow[] {
  return rows.filter((row) => row.status.toLocaleLowerCase() === "sent" && row.placedOrderValue !== null)
    .sort((a, b) => b.placedOrderValue! - a.placedOrderValue! || compareDescDate(a.sendDate, b.sendDate) || a.domOrder - b.domOrder)
    .slice(0, Math.max(1, desiredCount));
}

/** Formats a calendar date for the date picker variant currently on screen. */
export function formatCampaignDateInput(iso: string, input: Pick<HTMLInputElement, "type" | "value" | "placeholder">): string {
  const [year, month, day] = iso.split("-");
  if (!year || !month || !day) return iso;
  const sample = `${input.value} ${input.placeholder}`;
  if (input.type === "date" || /\d{4}-\d{2}-\d{2}/.test(sample)) return iso;
  if (/\d{1,2}\/\d{1,2}\/\d{2,4}|mm\/dd\/yyyy/i.test(sample)) return `${month}/${day}/${year}`;
  return new Intl.DateTimeFormat("en-US", { timeZone: "UTC", month: "short", day: "numeric", year: "numeric" }).format(new Date(`${iso}T00:00:00.000Z`));
}

/** The Campaigns URL is an independently observable, exact month proof. */
export function campaignPeriodMatchesUrl(value: string, period: Pick<ReportPeriod, "startDate" | "endDate">): boolean {
  try {
    const url = new URL(value);
    return url.searchParams.get("startDate") === period.startDate && url.searchParams.get("endDate") === period.endDate;
  } catch { return false; }
}

export function parseCampaignPeriodText(value: string | null | undefined): { startDate: string; endDate: string } | null {
  // One contiguous range only, with month and year inherited from whichever side shows them:
  // "August 1 – 31, 2026", "Aug 1 – Aug 31, 2026", "Aug 1, 2026 – Aug 31, 2026", "08/01/2026 – 08/31/2026".
  const text = (value ?? "").replace(/\s+/g, " ").trim().toLocaleLowerCase();
  const months = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
  const monthName = "(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\\.?";
  const day = "(\\d{1,2})(?:st|nd|rd|th)?";
  const dash = "\\s*(?:[–—-]|to)\\s*";
  const iso = (year: number, month: number, dayOfMonth: number) => {
    const date = new Date(Date.UTC(year, month - 1, dayOfMonth));
    return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === dayOfMonth ? date.toISOString().slice(0, 10) : null;
  };
  const month = (name: string) => months.indexOf(name.slice(0, 3)) + 1;
  const range = (start: string | null, end: string | null) => start && end && start <= end ? { startDate: start, endDate: end } : null;
  const match = (pattern: string) => text.match(new RegExp(`(?:^|[^\\w/])${pattern}(?![\\w/])`));
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
}
export function visibleCampaignPeriodText(values: readonly string[], period: Pick<ReportPeriod, "startDate" | "endDate">): boolean {
  return values.some((value) => { const parsed = parseCampaignPeriodText(value); return parsed !== null && parsed.startDate === period.startDate && parsed.endDate === period.endDate; });
}
function compareDescDate(left: string | null, right: string | null): number {
  const l = left ? Date.parse(left) : Number.NEGATIVE_INFINITY; const r = right ? Date.parse(right) : Number.NEGATIVE_INFINITY;
  return r - l;
}

/**
 * Injected only into the toolbar-authorized Campaigns listing. It uses no
 * account names, campaign names, IDs, or client-specific DOM selectors.
 * Filter/sort clicks are temporary UI state only; it never opens row links.
 */
export async function prepareCampaignsCaptureDocument(request: CampaignsCaptureRequest): Promise<CampaignsAdapterResult> {
  // Chrome's executeScript({ func }) serializes only this function's source, so
  // nothing at module scope exists in the page. These are verbatim copies of the
  // exported, unit-tested helpers; campaigns-capture.dom.test.ts runs this
  // function serialized to keep both in step.
  function parseCampaignRevenue(value: string | null | undefined): number | null {
    const text = (value ?? "").replace(/\s+/g, " ").trim();
    if (!text || /^(?:—|-|n\/?a|null)$/i.test(text)) return null;
    const token = text.match(/(?:[A-Z]{3}\s*)?[$€£]?\s*\(?-?[\d,.]+\)?/);
    if (!token) return null;
    const normalized = token[0].replace(/[A-Z$€£\s,]/gi, "").replace(/[()]/g, "");
    const amount = Number(normalized);
    return Number.isFinite(amount) ? amount : null;
  }
  function campaignChannel(labels: ReadonlyArray<string | null | undefined>): "Email" | "SMS" | null {
    const channels = new Set(labels.map((label) => (label ?? "").replace(/\s+/g, " ").trim()).filter(Boolean)
      .flatMap((label) => [...(/\b(?:sms|mms)|\btext[\s_-]?message/i.test(label) ? ["SMS" as const] : []), ...(/\be-?mail|\benvelope/i.test(label) ? ["Email" as const] : [])]));
    return channels.size === 1 ? [...channels][0]! : null;
  }
  function rankEligibleCampaigns(rows: readonly CampaignRow[], desiredCount: number): CampaignRow[] {
    return rows.filter((row) => row.status.toLocaleLowerCase() === "sent" && row.placedOrderValue !== null)
      .sort((a, b) => b.placedOrderValue! - a.placedOrderValue! || compareDescDate(a.sendDate, b.sendDate) || a.domOrder - b.domOrder)
      .slice(0, Math.max(1, desiredCount));
  }
  function formatCampaignDateInput(iso: string, input: Pick<HTMLInputElement, "type" | "value" | "placeholder">): string {
    const [year, month, day] = iso.split("-");
    if (!year || !month || !day) return iso;
    const sample = `${input.value} ${input.placeholder}`;
    if (input.type === "date" || /\d{4}-\d{2}-\d{2}/.test(sample)) return iso;
    if (/\d{1,2}\/\d{1,2}\/\d{2,4}|mm\/dd\/yyyy/i.test(sample)) return `${month}/${day}/${year}`;
    return new Intl.DateTimeFormat("en-US", { timeZone: "UTC", month: "short", day: "numeric", year: "numeric" }).format(new Date(`${iso}T00:00:00.000Z`));
  }
  function campaignPeriodMatchesUrl(value: string, period: Pick<ReportPeriod, "startDate" | "endDate">): boolean {
    try {
      const url = new URL(value);
      return url.searchParams.get("startDate") === period.startDate && url.searchParams.get("endDate") === period.endDate;
    } catch { return false; }
  }
  function parseCampaignPeriodText(value: string | null | undefined): { startDate: string; endDate: string } | null {
    // One contiguous range only, with month and year inherited from whichever side shows them:
    // "August 1 – 31, 2026", "Aug 1 – Aug 31, 2026", "Aug 1, 2026 – Aug 31, 2026", "08/01/2026 – 08/31/2026".
    const text = (value ?? "").replace(/\s+/g, " ").trim().toLocaleLowerCase();
    const months = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
    const monthName = "(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\\.?";
    const day = "(\\d{1,2})(?:st|nd|rd|th)?";
    const dash = "\\s*(?:[–—-]|to)\\s*";
    const iso = (year: number, month: number, dayOfMonth: number) => {
      const date = new Date(Date.UTC(year, month - 1, dayOfMonth));
      return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === dayOfMonth ? date.toISOString().slice(0, 10) : null;
    };
    const month = (name: string) => months.indexOf(name.slice(0, 3)) + 1;
    const range = (start: string | null, end: string | null) => start && end && start <= end ? { startDate: start, endDate: end } : null;
    const match = (pattern: string) => text.match(new RegExp(`(?:^|[^\\w/])${pattern}(?![\\w/])`));
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
  }
  function visibleCampaignPeriodText(values: readonly string[], period: Pick<ReportPeriod, "startDate" | "endDate">): boolean {
    return values.some((value) => { const parsed = parseCampaignPeriodText(value); return parsed !== null && parsed.startDate === period.startDate && parsed.endDate === period.endDate; });
  }
  function compareDescDate(left: string | null, right: string | null): number {
    const l = left ? Date.parse(left) : Number.NEGATIVE_INFINITY; const r = right ? Date.parse(right) : Number.NEGATIVE_INFINITY;
    return r - l;
  }
  function scoreHeaders(headers: readonly string[]): number { return headers.reduce((score, header) => score + (/campaign|status|type|send|open rate|click rate|placed order/i.test(header) ? 1 : 0), 0); }
  function rowFingerprint(row: CampaignRow): string { return `${row.name}\u0000${row.type}\u0000${row.status}\u0000${row.sendDate}\u0000${row.placedOrderValue}`; }
  function nextFrames(): Promise<void> { return new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))); }
  function campaignSendDay(value: string | null, timeZone: string): string | null {
    const text = (value ?? "").replace(/\s+/g, " ").trim();
    if (!text) return null;
    const calendarDay = (year: number, month: number, day: number): string | null => {
      const date = new Date(Date.UTC(year, month - 1, day));
      return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day ? date.toISOString().slice(0, 10) : null;
    };
    if (/\dZ\b|\b(?:UTC|GMT|[ECMP][SD]T)\b|[+-]\d{2}:?\d{2}$/.test(text)) {
      const instant = Date.parse(text);
      if (!Number.isFinite(instant)) return null;
      try {
        const parts = new Intl.DateTimeFormat("en-US", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date(instant));
        const part = (type: string) => Number(parts.find((item) => item.type === type)?.value);
        return calendarDay(part("year"), part("month"), part("day"));
      } catch { return null; }
    }
    const iso = text.match(/\b(\d{4})-(\d{2})-(\d{2})\b/);
    if (iso) return calendarDay(Number(iso[1]), Number(iso[2]), Number(iso[3]));
    const months = "jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec";
    const monthFirst = text.match(new RegExp(`\\b(${months})[a-z]*\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?,?\\s+(\\d{4})\\b`, "i"));
    const dayFirst = text.match(new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(${months})[a-z]*\\.?,?\\s+(\\d{4})\\b`, "i"));
    const named = monthFirst ? { month: monthFirst[1]!, day: monthFirst[2]!, year: monthFirst[3]! } : dayFirst ? { month: dayFirst[2]!, day: dayFirst[1]!, year: dayFirst[3]! } : null;
    if (named) return calendarDay(Number(named.year), months.split("|").indexOf(named.month.toLowerCase()) + 1, Number(named.day));
    const numeric = text.match(/\b(\d{1,2})\/(\d{1,2})\/(\d{4})\b/);
    return numeric ? calendarDay(Number(numeric[3]), Number(numeric[1]), Number(numeric[2])) : null;
  }
  function isDateInRange(value: string | null, period: Pick<ReportPeriod, "startDate" | "endDate">, timeZone: string): boolean { const day = campaignSendDay(value, timeZone); return day !== null && day >= period.startDate && day <= period.endDate; }
  const normalize = (value: string | null | undefined) => (value ?? "").replace(/\s+/g, " ").trim();
  const key = (value: string | null | undefined) => normalize(value).toLocaleLowerCase();
  // Klaviyo renders table rows as `display: contents`; such an element has no box of its own, so it is
  // measured as the union of its children's boxes (for visibility and for crop geometry alike).
  const boxOf = (element: Element): { left: number; top: number; right: number; bottom: number; width: number; height: number } => {
    const rect = element.getBoundingClientRect();
    if ((rect.width > 0 && rect.height > 0) || getComputedStyle(element).display !== "contents") return { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom, width: rect.width, height: rect.height };
    const boxes = Array.from(element.children).map(boxOf).filter((box) => box.width > 0 && box.height > 0);
    if (!boxes.length) return { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom, width: 0, height: 0 };
    const left = Math.min(...boxes.map((box) => box.left)); const top = Math.min(...boxes.map((box) => box.top));
    const right = Math.max(...boxes.map((box) => box.right)); const bottom = Math.max(...boxes.map((box) => box.bottom));
    return { left, top, right, bottom, width: right - left, height: bottom - top };
  };
  const visible = (node: Element) => { const rect = boxOf(node); const style = getComputedStyle(node); return rect.width > 1 && rect.height > 1 && style.display !== "none" && style.visibility !== "hidden" && !node.closest("[hidden],[aria-hidden=true]"); };
  const text = (node: Element) => normalize((node as HTMLElement).innerText || node.textContent || "");
  const label = (node: Element) => normalize([node.getAttribute("aria-label"), node.getAttribute("title"), node.getAttribute("data-testid"), text(node)].filter(Boolean).join(" "));
  // Once the period stage starts, every failure carries what was observed on the date filter and how it parsed.
  let periodEvidence: Record<string, unknown> | null = null;
  const failure = (code: CampaignsFailureCode, message: string, diagnostics: Record<string, unknown> = {}): CampaignsAdapterResult => ({ ok: false, code, message, diagnostics: { sourceUrl: `${location.origin}${location.pathname}`, ...(periodEvidence ? { periodProof: { ...periodEvidence } } : {}), ...diagnostics } });
  const path = location.pathname.replace(/\/$/, "");
  if (path !== "/omnicampaigns") return failure("CAMPAIGNS_ROUTE_REQUIRED", "Top Campaigns must be captured from the Klaviyo Campaigns listing.");
  const controls = () => Array.from(document.querySelectorAll("button,[role=button],[role=combobox],input,select")).filter(visible);
  const controlBy = (matcher: RegExp) => controls().filter((node) => matcher.test(label(node)));
  // Klaviyo is a React app: every readiness condition below is polled until it
  // holds or its bounded deadline passes, never assumed from a single read.
  const overallDeadline = Date.now() + 55_000;
  const pause = (ms: number) => new Promise((resolve) => window.setTimeout(resolve, ms));
  const loading = () => Array.from(document.querySelectorAll("[aria-busy=true],[role=progressbar],[data-loading=true]")).some(visible);
  async function waitUntil<T>(probe: () => T | null | undefined | false, timeoutMs: number): Promise<T | null> {
    const deadline = Math.min(Date.now() + timeoutMs, overallDeadline);
    for (;;) {
      const value = probe();
      if (value) return value;
      if (Date.now() >= deadline) return null;
      await pause(300);
    }
  }
  const headings = () => Array.from(document.querySelectorAll("h1,h2,h3,[role=heading]")).filter(visible).map(text);
  const readinessDiagnostics = () => ({ title: document.title, headings: headings().slice(0, 8).map((value) => value.slice(0, 60)), tables: document.querySelectorAll("table,[role=grid],[role=table]").length, loading: loading() });
  const pageHeading = await waitUntil(() => headings().some((value) => /^campaigns?$/i.test(value)), 25_000);
  if (!pageHeading) return failure("CAMPAIGNS_PAGE_NOT_READY", "The authorized page did not render the Campaigns listing within 25 seconds.", readinessDiagnostics());

  // Account context must be explicit and must match the selected report client.
  const expectedAccount = key(request.clientName);
  const accountLabels = () => Array.from(document.querySelectorAll("header button,header [role=button],nav button,nav [role=button],[aria-label*=account i],[aria-label*=workspace i],[aria-label*=organization i]")).filter(visible).map(label);
  const accountIdentity = await waitUntil(() => accountLabels().find((value) => key(value).includes(expectedAccount)), 10_000);
  if (!accountIdentity) return failure("CAMPAIGNS_ACCOUNT_UNPROVEN", "Klaviyo account identity could not be proven for the selected report client.", { expectedClient: request.clientName, accountCandidates: accountLabels().slice(0, 10) });

  // Klaviyo's Campaigns picker has used both labelled inputs and two compact
  // date fields in a dialog. Resolve the controls from visible semantics rather
  // than from a provider-specific id or a report/client-specific selector.
  // The period is proven only by the table's own date filter: the short control whose visible text is a
  // date value (a range or a rolling preset such as "Last 30 days") nearest the campaigns table. Prose
  // controls that merely mention a period (suggestion cards) and other cards' pickers never qualify.
  const rollingRange = /^(?:last \d+ (?:days?|weeks?|months?)|(?:this|last) (?:week|month|quarter|year)|all time|today|yesterday|custom(?: range)?)$/i;
  const campaignsTable = () => Array.from(document.querySelectorAll("table,[role=grid],[role=table]")).find(visible) ?? null;
  const depth = (node: Element | null) => { let count = 0; for (let current = node; current; current = current.parentElement) count += 1; return count; };
  const sharedDepth = (node: Element, other: Element) => { const chain = new Set<Element>(); for (let current: Element | null = node; current; current = current.parentElement) chain.add(current); for (let current: Element | null = other; current; current = current.parentElement) if (chain.has(current)) return depth(current); return 0; };
  // A filter labelled "Date range" itself, or by a sibling control within its own small container (e.g. "Clear Date range filter").
  const labelledDateRange = (node: Element) => { let scope: Element | null = node; for (let level = 0; level < 3 && scope; level += 1, scope = scope.parentElement) { if (Array.from(scope.querySelectorAll("button,[role=button]")).length > 4) break; if (/date\s*range/i.test(label(scope)) || Array.from(scope.querySelectorAll("button,[role=button]")).some((other) => /date\s*range/i.test(label(other)))) return true; } return false; };
  const dateFilterCandidates = () => { const table = campaignsTable(); return controls().map((node) => ({ node, value: text(node) })).filter(({ value }) => value.length <= 48 && (rollingRange.test(value) || parseCampaignPeriodText(value) !== null)).map((candidate) => ({ ...candidate, proximity: (table ? sharedDepth(candidate.node, table) : 0) + (labelledDateRange(candidate.node) ? 0.5 : 0) })).sort((a, b) => b.proximity - a.proximity); };
  const dateFilter = () => { const [first, second] = dateFilterCandidates(); return first && (!second || second.proximity < first.proximity) ? first.node : null; };
  // Every check re-queries the live filter: React replaces the control after Apply, so no Element is reused.
  const periodProof = { expectedStart: request.period.startDate, expectedEnd: request.period.endDate, visiblePeriodText: null as string | null, parsedStart: null as string | null, parsedEnd: null as string | null, periodControlRequeried: false, periodMatch: false };
  const provenPeriod = () => {
    const filter = dateFilter();
    const visiblePeriodText = filter ? text(filter).slice(0, 120) : null;
    const parsed = parseCampaignPeriodText(visiblePeriodText);
    Object.assign(periodProof, { visiblePeriodText, parsedStart: parsed?.startDate ?? null, parsedEnd: parsed?.endDate ?? null, periodControlRequeried: true, periodMatch: parsed?.startDate === request.period.startDate && parsed?.endDate === request.period.endDate });
    return periodProof.periodMatch && !loading() ? visiblePeriodText : null;
  };
  periodEvidence = periodProof;
  let periodControl: Element | null = null;
  // Opening the listing with the report period in its startDate/endDate query usually suffices; Klaviyo must still render it on the filter.
  const urlCarriesPeriod = campaignPeriodMatchesUrl(location.href, request.period);
  const periodFromUrl = await waitUntil(provenPeriod, urlCarriesPeriod ? 15_000 : 3_000);
  if (!periodFromUrl) {
    const visibleControlLabels = () => controls().map(label).filter(Boolean).slice(0, 40).map((value) => value.slice(0, 60));
    const rowSignature = () => { const table = document.querySelector("table,[role=grid],[role=table]"); return table ? Array.from(table.querySelectorAll("tbody tr,[role=row]")).slice(0, 6).map(text).join("|").slice(0, 600) : ""; };
    const popovers = () => Array.from(document.querySelectorAll("[role=dialog],[role=listbox],[role=menu],[role=tooltip],[data-popper-placement],[aria-modal=true]")).filter(visible);
    const longDate = (iso: string) => new Intl.DateTimeFormat("en-US", { timeZone: "UTC", month: "long", day: "numeric", year: "numeric" }).format(new Date(`${iso}T00:00:00.000Z`));
    const monthYear = (iso: string) => new Intl.DateTimeFormat("en-US", { timeZone: "UTC", month: "long", year: "numeric" }).format(new Date(`${iso}T00:00:00.000Z`));
    const date: Record<string, unknown> = { urlCarriesPeriod, dateFilterCandidates: dateFilterCandidates().slice(0, 4).map(({ value, proximity }) => ({ value: value.slice(0, 60), proximity })), dateControlFound: false, dateControlTextBefore: null, dateDialogOpened: false, datePickerStructure: null, startValueAttempted: request.period.startDate, endValueAttempted: request.period.endDate, applyFound: false, applyClicked: false, dateControlTextAfter: null, observedPeriodAfter: null, tableReloaded: false };
    const dateFailure = (code: CampaignsFailureCode, message: string) => {
      const control = dateFilter() ?? periodControl;
      provenPeriod();
      return failure(code, message, { ...readinessDiagnostics(), controls: visibleControlLabels(), date: { ...date, dateControlTextAfter: control ? text(control).slice(0, 120) : null, observedUrl: location.href, popovers: popovers().map((node) => label(node).slice(0, 300)).slice(0, 3) } });
    };
    periodControl = await waitUntil(dateFilter, 10_000);
    if (!periodControl) return dateFailure("CAMPAIGNS_DATE_CONTROL_NOT_FOUND", "The Campaigns date-range control was not uniquely available.");
    date.dateControlFound = true; date.dateControlTextBefore = text(periodControl).slice(0, 120);
    const rowsBefore = rowSignature();
    (periodControl as HTMLElement).click();
    const opened = await waitUntil(() => popovers().length > 0 || Boolean(Array.from(document.querySelectorAll("[role=option],[role=menuitem],[role=menuitemradio],[role=radio],button,li")).filter(visible).find((node) => /^custom\b/i.test(text(node)))), 5_000);
    date.dateDialogOpened = Boolean(opened);
    if (!opened) return dateFailure("CAMPAIGNS_DATE_CONTROL_NOT_FOUND", "Clicking the Campaigns date-range control did not open its picker.");
    const custom = await waitUntil(() => Array.from(document.querySelectorAll("[role=option],[role=menuitem],[role=menuitemradio],[role=radio],button,[role=button],li,label")).filter(visible).find((node) => /^custom\b/i.test(text(node))) as HTMLElement | undefined, 3_000);
    if (custom) { custom.click(); await nextFrames(); }
    const dateInputLabel = (input: HTMLInputElement) => [input.name, input.id, input.getAttribute("aria-label"), input.placeholder, label(input)].filter(Boolean).join(" ");
    const resolveDateInputs = () => {
      const dateInputs = Array.from(document.querySelectorAll("input")).filter(visible).filter((node): node is HTMLInputElement => node instanceof HTMLInputElement)
        .filter((input) => !["hidden", "checkbox", "radio", "search", "file"].includes(input.type))
        .filter((input) => /date|start|end|from|to|\b(?:m{1,2}\/d{1,2}\/y{2,4}|\d{1,2}\/\d{1,2}\/\d{2,4}|\d{4}-\d{2}-\d{2})\b/i.test([input.name, input.id, input.getAttribute("aria-label"), input.placeholder, input.value, label(input)].filter(Boolean).join(" ")) || input.type === "date");
      const startInputs = dateInputs.filter((input) => /start|from/i.test(dateInputLabel(input)));
      const endInputs = dateInputs.filter((input) => /end|to\b/i.test(dateInputLabel(input)));
      const starts = startInputs.length === 1 ? startInputs : dateInputs.length === 2 ? [dateInputs[0]!] : [];
      const ends = endInputs.length === 1 ? endInputs : dateInputs.length === 2 ? [dateInputs[1]!] : [];
      return { dateInputs, start: starts.length === 1 && ends.length === 1 && starts[0] !== ends[0] ? starts[0]! : null, end: starts.length === 1 && ends.length === 1 && starts[0] !== ends[0] ? ends[0]! : null };
    };
    // A calendar day is identified by its accessible date label, never by CSS classes.
    const dayCell = (iso: string) => {
      const wanted = [longDate(iso), formatCampaignDateInput(iso, { type: "text", value: "", placeholder: "" }), iso].map((value) => value.toLocaleLowerCase());
      return Array.from(document.querySelectorAll("button,[role=gridcell],[role=button],td")).filter(visible)
        .find((node) => { const name = key([node.getAttribute("aria-label"), node.getAttribute("title"), node.getAttribute("data-date")].filter(Boolean).join(" ")); return Boolean(name) && wanted.some((value) => name.includes(value)) && node.getAttribute("aria-disabled") !== "true"; }) as HTMLElement | undefined;
    };
    const calendarStructure = () => ({ grids: Array.from(document.querySelectorAll("[role=grid],table")).filter(visible).length, dayLabels: Array.from(document.querySelectorAll("[role=gridcell][aria-label],button[aria-label],td[aria-label]")).filter(visible).slice(0, 3).map((node) => node.getAttribute("aria-label")!.slice(0, 60)), monthHeadings: Array.from(document.querySelectorAll("[role=dialog] *,[data-popper-placement] *")).filter(visible).map(text).filter((value) => /^[A-Z][a-z]+ \d{4}$/.test(value)).slice(0, 4) });
    const pickCalendarDay = async (iso: string) => {
      for (let step = 0; step < 36; step += 1) {
        const cell = dayCell(iso);
        if (cell) { cell.click(); await nextFrames(); return true; }
        const headings = calendarStructure().monthHeadings.map((value) => new Date(`${value} 1 UTC`).getTime()).filter(Number.isFinite);
        const target = new Date(`${monthYear(iso)} 1 UTC`).getTime();
        const direction = headings.length && Math.min(...headings) > target ? /prev|previous|back/i : /next|forward/i;
        const navigate = controls().find((node) => direction.test(label(node)) && /month|prev|next/i.test(label(node))) as HTMLElement | undefined;
        if (!navigate) return false;
        navigate.click(); await pause(150);
      }
      return false;
    };
    const picker = await waitUntil(() => { const inputs = resolveDateInputs(); return inputs.start && inputs.end ? { kind: "inputs" as const, inputs } : dayCell(request.period.startDate) || calendarStructure().monthHeadings.length ? { kind: "calendar" as const, inputs } : null; }, 8_000);
    const structure = resolveDateInputs();
    date.datePickerStructure = { kind: picker?.kind ?? "unrecognized", inputs: structure.dateInputs.map((input) => ({ type: input.type, label: dateInputLabel(input).slice(0, 80), value: input.value.slice(0, 40) })), calendar: calendarStructure(), presets: popovers().flatMap((node) => Array.from(node.querySelectorAll("[role=option],[role=menuitem],[role=menuitemradio],button,li")).filter(visible).map(text)).filter(Boolean).slice(0, 15) };
    if (!picker) return dateFailure("CAMPAIGNS_DATE_CONTROL_NOT_FOUND", "The Campaigns date picker exposed neither start/end inputs nor a calendar.");
    if (picker.kind === "inputs") {
      // React tracks the native value setter: set through it, then dispatch the events React listens for.
      const setValue = (input: HTMLInputElement, value: string) => { input.focus(); const descriptor = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set; descriptor?.call(input, value); input.dispatchEvent(new Event("input", { bubbles: true })); input.dispatchEvent(new Event("change", { bubbles: true })); input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })); input.dispatchEvent(new Event("blur", { bubbles: true })); };
      setValue(picker.inputs.start!, formatCampaignDateInput(request.period.startDate, picker.inputs.start!)); await nextFrames();
      setValue(picker.inputs.end!, formatCampaignDateInput(request.period.endDate, picker.inputs.end!)); await nextFrames();
      date.valuesAfterSet = [picker.inputs.start!.value, picker.inputs.end!.value];
    } else {
      const startPicked = await pickCalendarDay(request.period.startDate);
      const endPicked = startPicked && await pickCalendarDay(request.period.endDate);
      date.calendarPicked = { start: startPicked, end: Boolean(endPicked) };
      if (!startPicked || !endPicked) return dateFailure("CAMPAIGNS_DATE_CONTROL_NOT_FOUND", "The Campaigns calendar did not expose the report's start and end days.");
    }
    const apply = await waitUntil(() => controlBy(/^(?:apply|done|update|save)(?:\s+(?:range|dates?|filter))?$/i).find((node) => !(node as HTMLButtonElement).disabled && node.getAttribute("aria-disabled") !== "true") as HTMLElement | undefined, 5_000);
    date.applyFound = Boolean(apply);
    if (!apply) return dateFailure("CAMPAIGNS_DATE_CONTROL_NOT_FOUND", "The Campaigns date range could not be applied safely.");
    apply.click(); date.applyClicked = true;
    // Only Klaviyo's own rendering proves the period: the control must leave its rolling preset and
    // the page must show the exact range. A click alone is never evidence.
    const dateProof = await waitUntil(provenPeriod, 20_000);
    date.tableReloaded = rowSignature() !== rowsBefore;
    date.observedPeriodAfter = dateFilter() ? text(dateFilter()!).slice(0, 80) : null;
    if (!dateProof) return dateFailure("REPORT_PERIOD_NOT_CONFIRMED", "Klaviyo did not visibly confirm the requested report month after Apply.");
  }

  const metricLabel = () => controlBy(/conversion metric|placed order/i).map(label).find((value) => /placed\s*order/i.test(value));
  const visibleMetricLabel = await waitUntil(metricLabel, 10_000);
  if (!visibleMetricLabel) return failure("CAMPAIGNS_METRIC_UNPROVEN", "The Campaigns listing did not visibly prove a Placed Order conversion metric.", { controls: controlBy(/conversion metric|placed order/i).map(label).slice(0, 10) });

  // The table is re-resolved on every read: Klaviyo replaces it after date, sort, and data updates.
  const resolveTable = () => {
    const tables = Array.from(document.querySelectorAll("table,[role=grid],[role=table]")).filter(visible);
    const selected = tables.map((table) => ({ table, headers: Array.from(table.querySelectorAll("thead th,[role=columnheader]")).filter(visible).map(text) }))
      .sort((a, b) => scoreHeaders(b.headers) - scoreHeaders(a.headers))[0];
    if (!selected || !selected.headers.some((header) => /placed\s*order/i.test(header))) return null;
    const headerIndex = (matcher: RegExp) => selected.headers.findIndex((header) => matcher.test(header));
    const indexes = { name: headerIndex(/campaign|name/i), status: headerIndex(/^status$/i), type: headerIndex(/^type$/i), date: headerIndex(/send.*date|date sent|sent/i), open: headerIndex(/open.*rate/i), click: headerIndex(/click.*rate/i), revenue: headerIndex(/placed\s*order/i) };
    const placedOrderHeader = Array.from(selected.table.querySelectorAll("thead th,[role=columnheader]")).filter(visible)[indexes.revenue] as HTMLElement | undefined;
    return { ...selected, indexes, placedOrderHeader };
  };
  const renderedRows = (table: Element) => Array.from(table.querySelectorAll("tbody tr,[role=row]")).filter(visible);
  const readyTable = await waitUntil(() => { const table = resolveTable(); return table && !loading() && renderedRows(table.table).length > 0 ? table : null; }, 25_000);
  if (!readyTable) {
    const table = resolveTable();
    const rowLayout = table ? Array.from(table.table.querySelectorAll("tbody tr,[role=row]")).slice(0, 4).map((row) => { const box = boxOf(row); return { display: getComputedStyle(row).display, width: Math.round(box.width), height: Math.round(box.height), cells: row.children.length }; }) : [];
    return failure("CAMPAIGNS_PAGE_NOT_READY", table ? "The Campaigns table showed a Placed Order column but no rendered campaign rows." : "The Campaigns table does not expose a Placed Order column.", { ...readinessDiagnostics(), headers: table?.headers ?? [], rowCount: table ? table.table.querySelectorAll("tbody tr,[role=row]").length : 0, rowLayout });
  }
  if ([readyTable.indexes.name, readyTable.indexes.status, readyTable.indexes.type, readyTable.indexes.revenue].some((index) => index < 0)) return failure("CAMPAIGNS_PAGE_NOT_READY", "The Campaigns table is missing required campaign, type, status, or Placed Order columns.", { headers: readyTable.headers });
  const cellsOf = (row: Element) => Array.from(row.querySelectorAll("td,[role=gridcell],[role=cell]")).filter(visible).map(text);
  const isDataRow = (row: Element) => !row.querySelector("th,[role=columnheader]") && cellsOf(row).length > 0;
  const dataRows = (table: Element) => renderedRows(table).filter(isDataRow);
  const tableSignature = () => { const table = resolveTable(); return table ? JSON.stringify(dataRows(table.table).map(cellsOf)) : ""; };
  // Status filter: Klaviyo's own Status filter is set to Sent only, so Canceled/Draft/Scheduled campaigns are
  // removed from the table itself — never merely skipped while they stay visible between ranked rows. Nothing
  // about the menu's markup is assumed: the chip is found by its visible text or accessible name, a menu counts
  // as open only when status options become visible outside the table, and both the filter's own state and the
  // re-rendered rows must prove Sent-only. Every step is recorded so a failure says exactly where it stopped.
  const STATUS_NAMES = /^(?:sent|draft|scheduled|cancell?ed|sending|paused|adding recipients|smart sending|preparing to send)$/i;
  const outsideTable = (node: Element) => !node.closest("table,thead,tbody,[role=grid],[role=table],[role=row],[role=columnheader],[role=gridcell],[role=cell]");
  const statuses = () => { const table = resolveTable(); return table ? dataRows(table.table).map((row) => cellsOf(row)[table.indexes.status] ?? "") : []; };
  const onlySent = () => { const values = statuses(); return values.length > 0 && values.every((value) => /^sent$/i.test(value)); };
  const clickable = (node: Element) => (node.closest("button,[role=button],[role=combobox],[aria-haspopup],a,[tabindex]") ?? node) as HTMLElement;
  const statusControl = (): HTMLElement | undefined => {
    const candidates = Array.from(document.querySelectorAll("button,[role=button],[role=combobox],[aria-haspopup],[tabindex],div,span,label"))
      // Cheap textContent screen first: innerText and layout are read only for the few plausible nodes.
      .filter((node) => { const raw = node.textContent ?? ""; return (raw.length <= 60 && /^\s*status\b/i.test(raw)) || /\bstatus\b/i.test(node.getAttribute("aria-label") ?? ""); })
      .filter((node) => visible(node) && outsideTable(node) && !node.closest("[role=dialog],[role=listbox],[role=menu],[data-popper-placement]"))
      .filter((node) => { const shown = text(node); return (shown.length <= 30 && /^status\b/i.test(shown)) || /\bstatus\b/i.test(node.getAttribute("aria-label") ?? ""); })
      .map(clickable);
    return [...new Set(candidates)].sort((left, right) => { const a = boxOf(left); const b = boxOf(right); return a.width * a.height - b.width * b.height; })[0];
  };
  // Options are leaf-most visible elements whose own text is exactly a status name, outside the table and chip,
  // that were not already on the page before the menu was opened.
  let menuBaseline = new Set<Element>();
  const statusOptions = () => {
    const chip = statusControl();
    const leaves = Array.from(document.querySelectorAll("body *")).filter((node) => { const raw = node.textContent ?? ""; return raw.length <= 40 && STATUS_NAMES.test(normalize(raw)); }).filter((node) => outsideTable(node) && !(chip && chip.contains(node)) && STATUS_NAMES.test(text(node)) && visible(node) && !Array.from(node.children).some((child) => STATUS_NAMES.test(text(child))));
    return leaves.map((node) => (node.closest("[role=option],[role=menuitemcheckbox],[role=menuitemradio],[role=menuitem],[role=checkbox],label,li,button,[role=button]") ?? node) as HTMLElement)
      .filter((node, index, all) => all.indexOf(node) === index && !menuBaseline.has(node));
  };
  const optionState = (option: Element): "checked" | "unchecked" | "unknown" => {
    const box = option.matches("input") ? option as HTMLInputElement : option.querySelector<HTMLInputElement>("input[type=checkbox],input[type=radio]") ?? (option.closest("label")?.querySelector<HTMLInputElement>("input[type=checkbox],input[type=radio]") ?? null);
    if (box) return box.checked ? "checked" : "unchecked";
    const marked = [option, ...Array.from(option.querySelectorAll("[aria-checked],[aria-selected],[data-state]"))].map((node) => node.getAttribute("aria-checked") ?? node.getAttribute("aria-selected") ?? node.getAttribute("data-state")).find((value) => value !== null);
    return marked === undefined || marked === null ? "unknown" : /^(?:true|mixed|checked|on)$/i.test(marked) ? "checked" : "unchecked";
  };
  const describe = (node: Element) => ({ tag: node.tagName.toLowerCase(), role: node.getAttribute("role"), ariaLabel: (node.getAttribute("aria-label") ?? "").slice(0, 40) || null, haspopup: node.getAttribute("aria-haspopup"), expanded: node.getAttribute("aria-expanded"), text: text(node).slice(0, 40) });
  const pointer = (node: HTMLElement, types: readonly string[]) => {
    const box = boxOf(node); const init = { bubbles: true, cancelable: true, composed: true, button: 0, clientX: box.left + box.width / 2, clientY: box.top + box.height / 2 };
    const Pointer = typeof PointerEvent === "function" ? PointerEvent : MouseEvent;
    for (const type of types) node.dispatchEvent(type.startsWith("pointer") ? new Pointer(type, { ...init, pointerId: 1, pointerType: "mouse", isPrimary: true } as PointerEventInit) : new MouseEvent(type, init));
  };
  const statusCounts = () => { const all = statuses(); const count = (matcher: RegExp) => all.filter((value) => matcher.test(value)).length; return { SENT_ROWS: count(/^sent$/i), CANCELLED_ROWS: count(/^cancell?ed$/i), DRAFT_ROWS: count(/^draft$/i), SCHEDULED_ROWS: count(/^scheduled$/i) }; };
  const statusFilter: Record<string, unknown> = { initiallySentOnly: onlySent(), statusesBefore: [...new Set(statuses())] };
  const statusFailure = (code: CampaignsFailureCode, message: string) => {
    const chip = statusControl();
    Object.assign(statusFilter, { STATUS_TEXT_AFTER: chip ? text(chip) : null, VISIBLE_ROW_STATUSES_AFTER: [...new Set(statuses())], ...statusCounts(), EXACT_FAILURE_CODE: code,
      filterBar: Array.from(document.querySelectorAll("button,[role=button],[role=combobox],[aria-haspopup]")).filter((node) => visible(node) && outsideTable(node) && text(node).length <= 30).slice(0, 25).map(describe) });
    return failure(code, message, { statusFilter });
  };
  let menuProvedSentOnly = false;
  if (!onlySent()) {
    const control = await waitUntil(statusControl, 10_000);
    statusFilter.STATUS_CONTROL_FOUND = Boolean(control);
    if (!control) return statusFailure("TOP_CAMPAIGNS_STATUS_FILTER_NOT_FOUND", "The Campaigns Status filter was not found, so the table could not be limited to Sent campaigns.");
    statusFilter.STATUS_TEXT_BEFORE = text(control); statusFilter.statusControl = describe(control);
    menuBaseline = new Set(statusOptions());
    const sentOption = () => statusOptions().find((option) => /^sent$/i.test(text(option)));
    // Open like a user would, confirming each way actually opened the menu before trying the next.
    const openMenu = async (): Promise<boolean> => {
      if (sentOption()) return true;
      const ways: Array<[string, () => void]> = [
        ["click", () => statusControl()?.click()],
        ["pointer", () => { const chip = statusControl(); if (chip) pointer(chip, ["pointerdown", "mousedown", "pointerup", "mouseup"]); }],
        ["keyboard", () => { const chip = statusControl(); chip?.focus(); for (const key of ["Enter", "ArrowDown"]) chip?.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true })); }],
      ];
      for (const [way, act] of ways) {
        act(); statusFilter.STATUS_CLICKED = true; statusFilter.openedBy = way;
        if (await waitUntil(() => Boolean(sentOption()), 4_000)) return true;
      }
      return false;
    };
    const opened = await openMenu();
    statusFilter.MENU_OPENED = opened;
    statusFilter.MENU_OPTIONS = statusOptions().map((option) => ({ ...describe(option), state: optionState(option) })).slice(0, 15);
    statusFilter.SENT_OPTION_FOUND = Boolean(sentOption());
    if (!opened) return statusFailure("TOP_CAMPAIGNS_STATUS_MENU_NOT_OPENED", "Clicking the Campaigns Status filter did not show its status options.");
    statusFilter.SENT_OPTION_STATE_BEFORE = optionState(sentOption()!);
    // Select only Sent: deselect any other checked status, then select Sent. A single-select menu may close
    // after a choice, so it is re-opened before each further change.
    const toggle = async (matcher: RegExp, wanted: boolean): Promise<boolean> => {
      if (!await openMenu()) return false;
      const option = statusOptions().find((candidate) => matcher.test(text(candidate)));
      if (!option) return !wanted;
      const state = optionState(option);
      if ((state === "checked") === wanted && state !== "unknown") return true;
      if (state === "unknown" && !wanted) return true;
      const target = (option.matches("input") ? option : option.querySelector<HTMLElement>("input[type=checkbox],input[type=radio]") ?? option) as HTMLElement;
      target.click();
      const settled = await waitUntil(() => { const live = statusOptions().find((candidate) => matcher.test(text(candidate))); return !live || optionState(live) === (wanted ? "checked" : "unchecked") || optionState(live) === "unknown"; }, 3_000);
      if (!settled) { pointer(target, ["pointerdown", "mousedown", "pointerup", "mouseup"]); await pause(300); }
      return true;
    };
    for (const option of statusOptions()) if (!/^sent$/i.test(text(option)) && optionState(option) === "checked") await toggle(new RegExp(`^${text(option)}$`, "i"), false);
    statusFilter.SENT_CLICKED = await toggle(/^sent$/i, true);
    const menuStates = statusOptions().map((option) => [text(option), optionState(option)] as const);
    statusFilter.menuStateAfterSelection = menuStates;
    menuProvedSentOnly = menuStates.some(([name, state]) => /^sent$/i.test(name) && state === "checked") && menuStates.every(([name, state]) => /^sent$/i.test(name) || state !== "checked");
    const apply = Array.from(document.querySelectorAll("button,[role=button]")).filter((node) => visible(node) && outsideTable(node)).find((node) => /^(?:apply|done|save|update|apply filters?)$/i.test(text(node))) as HTMLElement | undefined;
    statusFilter.APPLY_REQUIRED = Boolean(apply);
    if (apply) { apply.click(); statusFilter.APPLY_CLICKED = true; }
    else if (sentOption()) {
      // Close the menu the way a user would; a menu that applies on selection is already applied.
      const active = (document.activeElement ?? document.body) as HTMLElement;
      for (const target of [active, document.body]) target.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", code: "Escape", bubbles: true, cancelable: true }));
      statusFilter.APPLY_CLICKED = false;
    }
  }
  // Both the filter's own state and the re-rendered rows must prove Sent-only, the rows reading identically
  // three times in a row with nothing loading.
  let statusStable = 0; let lastTable = "";
  const sentOnly = await waitUntil(() => { if (loading() || !onlySent()) { statusStable = 0; return false; } const signature = tableSignature(); statusStable = signature === lastTable ? statusStable + 1 : 1; lastTable = signature; return statusStable >= 3; }, 20_000);
  const chipAfter = statusControl();
  Object.assign(statusFilter, { STATUS_TEXT_AFTER: chipAfter ? text(chipAfter) : null, VISIBLE_ROW_STATUSES_AFTER: [...new Set(statuses())], ...statusCounts() });
  if (!sentOnly) {
    if (statuses().length === 0) return statusFailure("TOP_CAMPAIGNS_NO_DATA", "No Sent campaigns exist for the selected report month.");
    return statusFailure("TOP_CAMPAIGNS_STATUS_FILTER_NOT_APPLIED", "The Campaigns table did not settle to Sent campaigns only after the Status filter was applied.");
  }
  const chipShowsSent = Boolean(chipAfter && /\bsent\b/i.test(text(chipAfter)) && !/\b(?:draft|scheduled|cancell?ed)\b/i.test(text(chipAfter)));
  statusFilter.uiStateProof = chipShowsSent ? "status-chip-names-sent" : menuProvedSentOnly ? "menu-sent-only-checked" : statusFilter.initiallySentOnly ? "table-already-sent-only" : null;
  if (!statusFilter.uiStateProof) return statusFailure("TOP_CAMPAIGNS_STATUS_FILTER_NOT_APPLIED", "The rows read Sent-only, but the Status filter itself did not show a Sent-only selection.");
  // Sort proof is the rendered Placed Order values themselves, read in table order: Klaviyo's sort arrow and
  // aria-sort have both disagreed with the rendered order in live runs (65304473, 92cc9fbc).
  let rankingMethod: CampaignsEvidence["rankingMethod"] = "complete-result-set";
  const columnValues = () => { const table = resolveTable(); return table ? renderedRows(table.table).map((row) => parseCampaignRevenue(cellsOf(row)[table.indexes.revenue])).filter((value): value is number => value !== null) : []; };
  const ariaSortOf = () => { const header = resolveTable()?.placedOrderHeader; if (!header) return null; const marked = header.closest("[aria-sort]") ?? header.querySelector("[aria-sort]"); return (marked?.getAttribute("aria-sort") ?? (/\bdescending\b/i.test(label(header)) ? "descending" : /\bascending\b/i.test(label(header)) ? "ascending" : null)); };
  const ordered = (values: number[], direction: 1 | -1) => values.every((value, index) => index === 0 || direction * (value - values[index - 1]!) <= 0);
  const valuesBefore = columnValues();
  const sortDiagnostics: Record<string, unknown> = { headerFound: Boolean(readyTable.placedOrderHeader), ariaSortBefore: ariaSortOf(), valuesBefore: valuesBefore.slice(0, 6), clicks: 0, statusFilter };
  const sortState = () => {
    const values = columnValues();
    if (values.length >= 1 && ordered(values, 1) && (values.length === 1 || values[0]! > values[values.length - 1]! || values.every((value) => value === values[0]))) return "descending";
    return values.length >= 2 && ordered(values, -1) ? "ascending" : null;
  };
  // Proven when Klaviyo marks the column descending over descending values, or when our header click
  // re-renders the values into descending order. Rows that merely happen to be in order are not a sort:
  // more rows may still load below them, so those go through the complete-result-set path instead.
  if (sortState() === "descending" && ariaSortOf() === "descending") rankingMethod = "klaviyo-native-sort";
  else if (readyTable.placedOrderHeader) {
    for (let click = 0; click < 3 && rankingMethod !== "klaviyo-native-sort"; click += 1) {
      const header = resolveTable()?.placedOrderHeader; if (!header) break;
      const before = JSON.stringify(columnValues());
      ((header.querySelector("button,[role=button]") ?? header) as HTMLElement).click(); sortDiagnostics.clicks = click + 1;
      // Wait for this click's re-render (the values change), then classify the new rendered order.
      const rerendered = await waitUntil(() => !loading() && JSON.stringify(columnValues()) !== before, 6_000);
      const state = rerendered ? sortState() : null;
      sortDiagnostics[`stateAfterClick${click + 1}`] = state ?? "unordered";
      if (state === "descending") rankingMethod = "klaviyo-native-sort";
    }
  }
  Object.assign(sortDiagnostics, { ariaSortAfter: ariaSortOf(), valuesAfter: columnValues().slice(0, 6), rankingMethod });
  const readRows = () => {
    const table = resolveTable();
    if (!table) return null;
    const rowElements = Array.from(table.table.querySelectorAll("tbody tr,[role=row]")).filter(visible);
    const { indexes } = table;
    // The name is the campaign link (the cell also lists audiences and hidden actions); an icon-only Type cell is
    // read from its visible text or its icons' semantic metadata, and stays null when nothing proves the channel.
    const nameOf = (cell: Element | undefined) => { if (!cell) return ""; const link = cell.querySelector("a,[role=link]"); return link && text(link) ? text(link) : (((cell as HTMLElement).innerText || cell.textContent || "").split("\n").map(normalize).find(Boolean) ?? ""); };
    const typeOf = (cell: Element | undefined) => { if (!cell) return null; const nodes = [cell, ...Array.from(cell.querySelectorAll("[aria-label],[title],[data-testid],[data-icon],svg title,img[alt]"))]; return campaignChannel([text(cell), ...nodes.flatMap((node) => node.tagName.toLowerCase() === "title" ? [node.textContent] : [node.getAttribute("aria-label"), node.getAttribute("title"), node.getAttribute("data-testid"), node.getAttribute("data-icon"), node.getAttribute("alt")])]); };
    const parsedRows: CampaignRow[] = rowElements.map((row, domOrder) => {
      const cellNodes = Array.from(row.querySelectorAll("td,[role=gridcell],[role=cell]")).filter(visible);
      const cells = cellNodes.map(text);
      return { name: nameOf(cellNodes[indexes.name]), status: cells[indexes.status] ?? "", type: typeOf(cellNodes[indexes.type]), sendDate: indexes.date >= 0 ? cells[indexes.date] ?? null : null, openRate: indexes.open >= 0 ? cells[indexes.open] ?? null : null, clickRate: indexes.click >= 0 ? cells[indexes.click] ?? null : null, placedOrderValue: parseCampaignRevenue(cells[indexes.revenue]), domOrder };
    }).filter((row) => Boolean(row.name));
    const visibleEligible = parsedRows.filter((row) => row.status.toLocaleLowerCase() === "sent" && row.placedOrderValue !== null && isDateInRange(row.sendDate, request.period, request.clientTimezone));
    const ranked = rankEligibleCampaigns(visibleEligible, request.desiredCount);
    return { table, rowElements, visibleEligible, ranked, fingerprint: JSON.stringify([visibleEligible.length, ranked.map(rowFingerprint)]) };
  };
  // Without Klaviyo's sort, every row must be loaded: scroll to the last row until the count stops growing
  // (Klaviyo may load more rows on scroll), then restore the original scroll positions exactly.
  const scrollers = (() => { const list: Array<{ node: Element | null; top: number }> = [{ node: null, top: window.scrollY }]; for (let node = readyTable.table.parentElement; node; node = node.parentElement) if (node.scrollHeight > node.clientHeight + 1) list.push({ node, top: node.scrollTop }); return list; })();
  const restoreScroll = async () => { for (const { node, top } of scrollers) { try { if (node) node.scrollTop = top; else window.scrollTo(window.scrollX, top); } catch { /* a view without scrolling support stays as it is */ } } await nextFrames(); };
  const completeness: Record<string, unknown> = { required: rankingMethod === "complete-result-set", rowsBefore: renderedRows(readyTable.table).length, scrolls: 0 };
  if (rankingMethod === "complete-result-set") {
    let count = renderedRows(readyTable.table).length; let settled = false;
    for (let scroll = 0; scroll < 6; scroll += 1) {
      const table = resolveTable(); const rows = table ? renderedRows(table.table) : [];
      (rows[rows.length - 1] as HTMLElement | undefined)?.scrollIntoView?.({ block: "end", inline: "nearest", behavior: "auto" });
      completeness.scrolls = scroll + 1;
      await pause(800); await waitUntil(() => !loading(), 5_000);
      const next = resolveTable(); const after = next ? renderedRows(next.table).length : 0;
      if (after === count) { settled = true; break; }
      count = after;
    }
    Object.assign(completeness, { rowsAfter: count, settled, loadingAtEnd: loading() });
    await restoreScroll();
    if (!settled) return failure("TOP_CAMPAIGNS_INCOMPLETE_RESULT_SET", "The Campaigns list kept loading more rows, so the complete August result set could not be proven.", { sort: sortDiagnostics, completeness });
  }
  // Stability: the eligible set and ranking must read identically twice in a row, 500 ms apart.
  let reading = readRows(); let stableReads = 0;
  const stabilityDeadline = Math.min(Date.now() + 20_000, overallDeadline);
  while (stableReads < 1 && Date.now() < stabilityDeadline) {
    await pause(500);
    const next = readRows();
    stableReads = next && reading && next.fingerprint === reading.fingerprint && !loading() ? stableReads + 1 : 0;
    reading = next;
  }
  if (!reading || stableReads < 1) return failure("TOP_CAMPAIGNS_UNSTABLE", "Campaign ranking did not stabilize while the Campaigns table finished loading.", readinessDiagnostics());
  const { rowElements, visibleEligible } = reading;
  const selected = reading.table;
  // Completeness is proven only for a fully rendered single page or a native sort
  // view that explicitly exposes no next/page continuation. We refuse an unseen page.
  // Only real pager evidence counts: a short control named exactly Next/Next page (or a page number), or an
  // "x–y of N" / "Page n of N" count. Prose that merely contains "next" (suggestion cards) is not a pager.
  const pagerName = (node: Element) => normalize(node.getAttribute("aria-label") || text(node));
  const pagerControls = Array.from(document.querySelectorAll("button,[role=button],a,[role=link]")).filter(visible).filter((node) => /^(?:next|next page|go to next page|›|»|page \d+|\d{1,3})$/i.test(pagerName(node)));
  const enabledNext = pagerControls.filter((node) => /^(?:next|next page|go to next page|›|»)$/i.test(pagerName(node)) && !(node as HTMLButtonElement).disabled && node.getAttribute("aria-disabled") !== "true");
  const pageNumbers = pagerControls.map(pagerName).filter((value) => /^(?:page )?\d{1,3}$/i.test(value)).map((value) => Number(value.replace(/\D/g, "")));
  const counts = Array.from(document.querySelectorAll("span,p,div,[role=status]")).filter((node) => node.children.length === 0 && visible(node)).map(text).filter((value) => value.length <= 40 && /\bof\s+\d/i.test(value));
  const countShowsMore = counts.some((value) => { const range = value.match(/(\d+)\s*[–-]\s*(\d+)\s+of\s+(\d+)/i); const pages = value.match(/page\s+\d+\s+of\s+(\d+)/i); return range ? Number(range[3]) > Number(range[2]) : pages ? Number(pages[1]) > 1 : false; });
  const pagination = { nextControls: enabledNext.map(pagerName), pageNumbers, counts: counts.slice(0, 4), rankingMethod, eligibleRowCount: visibleEligible.length, renderedRowCount: rowElements.length };
  const morePages = enabledNext.length > 0 || pageNumbers.some((value) => value > 1) || countShowsMore;
  if (morePages && !(rankingMethod === "klaviyo-native-sort" && visibleEligible.length >= request.desiredCount)) return failure("TOP_CAMPAIGNS_INCOMPLETE_RESULT_SET", "The Campaigns result set has additional pages and no proven complete Top Campaigns result set.", { pagination, sort: sortDiagnostics, completeness });
  const initial = reading.ranked;
  if (!initial.length) return failure("TOP_CAMPAIGNS_NO_DATA", "No Sent campaigns with a visible Placed Order value were found for the selected report month.");
  const targetRows = rowElements.filter((_row, index) => initial.some((candidate) => candidate.domOrder === index));
  if (targetRows.length !== initial.length) return failure("TOP_CAMPAIGNS_ROWS_NOT_VISIBLE", "The ranked Campaigns rows could not all be represented in a real Klaviyo table view.");
  const rects = targetRows.map(boxOf); const tableRect = selected.table.getBoundingClientRect();
  // The crop shows every rendered row from the table top through the last ranked row, so those rows must be
  // exactly the ranked Sent campaigns, contiguous from the top. Anything else fails before any screenshot.
  // Table rows paint in DOM order, so the crop holds every data row up to the last ranked one.
  const lastRanked = Math.max(...targetRows.map((row) => rowElements.indexOf(row)));
  const shownRows = rowElements.slice(0, lastRanked + 1).filter(isDataRow);
  const nonSent = shownRows.filter((row) => !/^sent$/i.test(cellsOf(row)[selected.indexes.status] ?? ""));
  if (nonSent.length) return failure("TOP_CAMPAIGNS_NON_SENT_ROW_IN_VIEW", "A campaign that is not Sent would be visible in the Top Campaigns crop.", { statuses: nonSent.map((row) => cellsOf(row)[selected.indexes.status] ?? "").slice(0, 5), statusFilter });
  const shownValues = shownRows.map((row) => parseCampaignRevenue(cellsOf(row)[selected.indexes.revenue]) ?? Number.NaN);
  const shownDescending = shownValues.every((value, index) => Number.isFinite(value) && (index === 0 || value <= shownValues[index - 1]!));
  if (!shownDescending || shownRows.length !== targetRows.length || shownRows.some((row, index) => row !== targetRows[index])) return failure("TOP_CAMPAIGNS_SORT_UNPROVEN", "The top-ranked Sent campaigns are not the first rows Klaviyo renders, so a contiguous crop would show other campaigns.", { sort: sortDiagnostics });
  // The rendered period is re-proven from the live filter immediately before the crop is measured.
  if (!provenPeriod()) return failure("REPORT_PERIOD_NOT_CONFIRMED", "The Campaigns date filter no longer showed the report month when the capture was prepared.");
  const metricControls = controlBy(/conversion metric|placed order/i);
  const evidenceControls = [dateFilter(), statusControl(), ...metricControls].filter((node): node is Element => Boolean(node)).map(boxOf).filter((rect) => rect.width > 1 && rect.height > 1);
  const top = Math.min(tableRect.top, ...rects.map((rect) => rect.top), ...evidenceControls.map((rect) => rect.top)); const bottom = Math.max(...rects.map((rect) => rect.bottom));
  if (!(bottom > top) || tableRect.width < 20) return failure("TARGET_LAYOUT_NOT_STABLE", "The Campaigns table crop bounds were invalid.");
  // The visible-tab capture holds only the viewport: every selected row (and the filter controls) must lie inside it.
  if (top < 0 || bottom > window.innerHeight) return failure("TOP_CAMPAIGNS_ROWS_NOT_VISIBLE", `All ${initial.length} ranked Campaigns rows and their filters must be fully visible before the capture.`, { top: Math.round(top), bottom: Math.round(bottom), viewportHeight: window.innerHeight });
  return { ok: true, sourceUrl: `${location.origin}${location.pathname}`, observedPeriod: { ...request.period }, evidence: { accountIdentity, clientTimezone: request.clientTimezone, visibleMetricLabel, rankingMethod, eligibleRowCount: visibleEligible.length, includedRowCount: initial.length, rows: initial.map(({ domOrder: _domOrder, placedOrderValue, ...row }) => ({ ...row, status: "Sent", sendDate: campaignSendDay(row.sendDate, request.clientTimezone), placedOrderValue: placedOrderValue! })) }, targetRect: { x: tableRect.left, y: top, width: tableRect.width, height: bottom - top, viewportWidth: window.innerWidth, viewportHeight: window.innerHeight, availableRowCount: visibleEligible.length, includedRowCount: initial.length, periodProof: { ...periodProof }, ranking: { sort: sortDiagnostics, completeness, pagination } } };
}

function scoreHeaders(headers: readonly string[]): number { return headers.reduce((score, header) => score + (/campaign|status|type|send|open rate|click rate|placed order/i.test(header) ? 1 : 0), 0); }
function rowFingerprint(row: CampaignRow): string { return `${row.name}\u0000${row.type}\u0000${row.status}\u0000${row.sendDate}\u0000${row.placedOrderValue}`; }
function nextFrames(): Promise<void> { return new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))); }
/**
 * Klaviyo renders campaign send times as wall-clock time in the account
 * timezone, so the displayed calendar date is the client-local day and is read
 * directly. Only text that names an explicit zone/offset is an instant, and its
 * day is resolved in the client timezone. Browser/machine timezone and the UTC
 * day are never used. Numeric dates follow Klaviyo's US MM/DD/YYYY format.
 */
export function campaignSendDay(value: string | null, timeZone: string): string | null {
  const text = (value ?? "").replace(/\s+/g, " ").trim();
  if (!text) return null;
  const calendarDay = (year: number, month: number, day: number): string | null => {
    const date = new Date(Date.UTC(year, month - 1, day));
    return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day ? date.toISOString().slice(0, 10) : null;
  };
  if (/\dZ\b|\b(?:UTC|GMT|[ECMP][SD]T)\b|[+-]\d{2}:?\d{2}$/.test(text)) {
    const instant = Date.parse(text);
    if (!Number.isFinite(instant)) return null;
    try {
      const parts = new Intl.DateTimeFormat("en-US", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date(instant));
      const part = (type: string) => Number(parts.find((item) => item.type === type)?.value);
      return calendarDay(part("year"), part("month"), part("day"));
    } catch { return null; }
  }
  const iso = text.match(/\b(\d{4})-(\d{2})-(\d{2})\b/);
  if (iso) return calendarDay(Number(iso[1]), Number(iso[2]), Number(iso[3]));
  const months = "jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec";
  const monthFirst = text.match(new RegExp(`\\b(${months})[a-z]*\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?,?\\s+(\\d{4})\\b`, "i"));
  const dayFirst = text.match(new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(${months})[a-z]*\\.?,?\\s+(\\d{4})\\b`, "i"));
  const named = monthFirst ? { month: monthFirst[1]!, day: monthFirst[2]!, year: monthFirst[3]! } : dayFirst ? { month: dayFirst[2]!, day: dayFirst[1]!, year: dayFirst[3]! } : null;
  if (named) return calendarDay(Number(named.year), months.split("|").indexOf(named.month.toLowerCase()) + 1, Number(named.day));
  const numeric = text.match(/\b(\d{1,2})\/(\d{1,2})\/(\d{4})\b/);
  return numeric ? calendarDay(Number(numeric[3]), Number(numeric[1]), Number(numeric[2])) : null;
}
export function isDateInRange(value: string | null, period: Pick<ReportPeriod, "startDate" | "endDate">, timeZone: string): boolean { const day = campaignSendDay(value, timeZone); return day !== null && day >= period.startDate && day <= period.endDate; }
