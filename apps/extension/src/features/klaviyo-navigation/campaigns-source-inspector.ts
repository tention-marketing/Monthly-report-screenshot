import {
  ChromeSessionKlaviyoActiveTabGrantStore,
  activeTabGrantFailureMessage,
  type ActiveTabGrantFailureCode,
  type KlaviyoActiveTabGrantStore,
  verifyKlaviyoActiveTabGrant,
} from "./active-tab-grant.js";

export interface CampaignsSourceInspection {
  ok: true;
  sourceTabId: number;
  sourceUrl: string;
  accountCandidates: string[];
  pageRendered: boolean;
  pageHeading: string | null;
  dateControls: string[];
  conversionMetricControls: string[];
  sortControls: string[];
  tableHeaders: string[];
  visibleRows: string[][];
  pagination: string[];
  rowCount: number;
}

export type CampaignsSourceInspectionResult = CampaignsSourceInspection | {
  ok: false;
  code: ActiveTabGrantFailureCode | "CAMPAIGNS_ROUTE_REQUIRED" | "SCRIPT_INJECTION_FAILED" | "SCRIPT_RESULT_INVALID";
  message: string;
};

interface ChromeTab { id?: number; windowId?: number; url?: string; active?: boolean; }
interface ChromeTabsApi { get(tabId: number): Promise<ChromeTab>; query(query: { active: boolean; windowId: number }): Promise<ChromeTab[]>; }
interface ChromeScriptingApi {
  executeScript<Result>(details: { target: { tabId: number; frameIds: [number] }; func: () => Result; args: [] }): Promise<Array<{ frameId?: number; result?: Result }>>;
}
interface ChromeApi { tabs?: ChromeTabsApi; scripting?: ChromeScriptingApi; }

/**
 * A deliberately read-only diagnostic for the Campaigns listing. It runs only
 * in the exact tab explicitly authorized by the toolbar action. It does not
 * click controls, navigate, or persist anything.
 */
export class ChromeCampaignsSourceInspector {
  constructor(
    private readonly chromeApi: ChromeApi | undefined = (globalThis as typeof globalThis & { chrome?: ChromeApi }).chrome,
    private readonly grantStore: KlaviyoActiveTabGrantStore = new ChromeSessionKlaviyoActiveTabGrantStore(),
  ) {}

  async inspect(): Promise<CampaignsSourceInspectionResult> {
    const tabs = this.chromeApi?.tabs;
    const scripting = this.chromeApi?.scripting;
    if (!tabs || !scripting) return { ok: false, code: "SCRIPT_INJECTION_FAILED", message: "Campaigns inspection is unavailable in this extension context." };
    const grant = await verifyKlaviyoActiveTabGrant(tabs, this.grantStore);
    if (!grant.ok) return { ok: false, code: grant.code, message: activeTabGrantFailureMessage(grant.code) };
    if (!isCampaignsUrl(grant.tab.url)) return { ok: false, code: "CAMPAIGNS_ROUTE_REQUIRED", message: "Open the Klaviyo Campaigns list and click the Tention Reports toolbar icon before inspecting it." };
    try {
      const results = await scripting.executeScript<Omit<CampaignsSourceInspection, "sourceTabId">>({
        target: { tabId: grant.grant.grantedTabId, frameIds: [0] }, func: inspectCampaignsDocument, args: [],
      });
      const result = results.find(({ frameId }) => frameId === 0)?.result ?? results[0]?.result;
      return isInspection(result)
        ? { ...result, sourceTabId: grant.grant.grantedTabId }
        : { ok: false, code: "SCRIPT_RESULT_INVALID", message: "The authorized Campaigns page returned an invalid inspection result." };
    } catch {
      return { ok: false, code: "SCRIPT_INJECTION_FAILED", message: "The extension could not read the authorized Campaigns page." };
    }
  }
}

function isCampaignsUrl(value: string | undefined): boolean {
  try {
    const url = new URL(value ?? "");
    return url.protocol === "https:" && (url.hostname === "www.klaviyo.com" || url.hostname === "klaviyo.com") && url.pathname.replace(/\/$/, "") === "/omnicampaigns";
  } catch { return false; }
}

function isInspection(value: unknown): value is Omit<CampaignsSourceInspection, "sourceTabId"> {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<CampaignsSourceInspection>;
  return candidate.ok === true && typeof candidate.sourceUrl === "string" && Array.isArray(candidate.accountCandidates)
    && typeof candidate.pageRendered === "boolean" && (typeof candidate.pageHeading === "string" || candidate.pageHeading === null)
    && Array.isArray(candidate.dateControls) && Array.isArray(candidate.conversionMetricControls) && Array.isArray(candidate.sortControls)
    && Array.isArray(candidate.tableHeaders) && Array.isArray(candidate.visibleRows) && Array.isArray(candidate.pagination)
    && typeof candidate.rowCount === "number";
}

/** Serialized into the provider page; it must not capture module closures. */
export function inspectCampaignsDocument(): Omit<CampaignsSourceInspection, "sourceTabId"> {
  const normalize = (value: string | null | undefined) => (value ?? "").replace(/\s+/g, " ").trim();
  const visible = (node: Element) => {
    const style = getComputedStyle(node); const rect = node.getBoundingClientRect();
    return rect.width > 1 && rect.height > 1 && style.display !== "none" && style.visibility !== "hidden" && !node.closest("[hidden],[aria-hidden=true]");
  };
  const text = (node: Element) => normalize((node as HTMLElement).innerText || node.textContent || "");
  const label = (node: Element) => normalize([
    node.getAttribute("aria-label"), node.getAttribute("title"), node.getAttribute("data-testid"), text(node),
  ].filter(Boolean).join(" "));
  const unique = (values: string[], limit: number) => [...new Set(values.map(normalize).filter(Boolean))].slice(0, limit);
  const controls = Array.from(document.querySelectorAll("button,[role=button],[role=combobox],select,input"))
    .filter(visible).map(label).filter(Boolean);
  const headings = Array.from(document.querySelectorAll("h1,h2,h3,[role=heading]")).filter(visible).map(text);
  const matchingControls = (expression: RegExp) => unique(controls.filter((value) => expression.test(value)), 30);
  const tableCandidates = Array.from(document.querySelectorAll("table,[role=grid],[role=table]")).filter(visible);
  const table = tableCandidates.map((candidate) => {
    const headers = Array.from(candidate.querySelectorAll("thead th,[role=columnheader]")).filter(visible).map(text);
    const score = headers.reduce((total, header) => total + (/campaign|status|placed order|open rate|click rate|send/i.test(header) ? 1 : 0), 0);
    return { candidate, headers, score };
  }).sort((a, b) => b.score - a.score || b.headers.length - a.headers.length)[0] ?? null;
  const rows = table ? Array.from(table.candidate.querySelectorAll("tbody tr,[role=row]"))
    .filter(visible)
    .map((row) => Array.from(row.querySelectorAll("td,[role=gridcell],[role=cell]")).filter(visible).map(text).filter(Boolean))
    .filter((row) => row.length > 0)
    .slice(0, 50) : [];
  const pageText = text(document.body);
  const accountControls = Array.from(document.querySelectorAll("button,[role=button],[role=combobox],a"))
    .filter(visible).map((node) => ({ value: label(node), aria: normalize(node.getAttribute("aria-label")) }))
    .filter(({ value, aria }) => /account|organization|workspace|profile/i.test(`${aria} ${value}`))
    .flatMap(({ value }) => value.split(/\s*[|·]\s*/)).filter((value) => value.length >= 3 && value.length <= 100);
  const accountFromPage = [...pageText.matchAll(/(?:account|organization|workspace)\s*[:\-]?\s*([A-Z][^\n]{2,80})/gi)].map((match) => match[1] ?? "");
  const paginationNodes = Array.from(document.querySelectorAll("[role=navigation],button,[role=button]"))
    .filter(visible).map(label).filter((value) => /page\s*\d|next|previous|of\s+\d+/i.test(value));
  return {
    ok: true,
    sourceUrl: `${location.origin}${location.pathname}`,
    accountCandidates: unique([...accountControls, ...accountFromPage], 20),
    pageRendered: Boolean(table && (table.headers.length > 0 || rows.length > 0)),
    pageHeading: headings.find((heading) => /^campaigns?$/i.test(heading)) ?? headings[0] ?? null,
    dateControls: matchingControls(/date|time period|reporting period|august|custom range/i),
    conversionMetricControls: matchingControls(/conversion metric|placed order/i),
    sortControls: matchingControls(/sort|order|ascending|descending|placed order|revenue/i),
    tableHeaders: unique(table?.headers ?? [], 30),
    visibleRows: rows,
    pagination: unique(paginationNodes, 20),
    rowCount: rows.length,
  };
}
