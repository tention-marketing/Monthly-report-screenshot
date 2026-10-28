import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { resolve, join } from "node:path";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type Locator, type Page } from "playwright";
import { z } from "zod";
import { getReportPeriod, isCompletedMonthAtInstant } from "@tention/report-core";
import { isValidIanaTimeZone } from "@tention/report-schema";
import { formatRenderedRange, renderedRangesAreExact } from "./period-evidence.js";
import { verifyAccountIdentity } from "./klaviyo-account-identity.js";
import { captureStableScreenshot } from "./stable-screenshot.js";
import { reacquireSemanticCardAfterViewChange, resolveSemanticCard, scrollSemanticCardIntoView, waitForRequiredCardContent } from "./semantic-card.js";

const klaviyoUrlSchema = z.string().trim().url().superRefine((value, context) => {
  const url = new URL(value);
  if (url.protocol !== "https:" || (url.hostname !== "klaviyo.com" && !url.hostname.endsWith(".klaviyo.com")) || url.username || url.password) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Source URLs must be credential-free HTTPS Klaviyo URLs." });
  }
});
const targetSchema = z.object({ id: z.string().trim().min(1).optional(), name: z.string().trim().min(1).optional() }).strict().refine((value) => Boolean(value.id || value.name), "A configured target needs an ID or name.");
const signupFormsSchema = z.object({ mode: z.enum(["all", "configured"]), ids: z.array(z.string().trim().min(1)).default([]), names: z.array(z.string().trim().min(1)).default([]) }).strict().superRefine((value, context) => {
  if (value.mode === "configured" && value.ids.length === 0 && value.names.length === 0) context.addIssue({ code: z.ZodIssueCode.custom, message: "Configured signup forms need an ID or name." });
});
const welcomeFlowListingSchema = z.object({ mode: z.literal("email_welcome_flows"), flows: z.array(z.object({ id: z.string().trim().min(1), name: z.string().trim().min(1), channel: z.literal("email") }).strict()).length(2) }).strict();
const clientSchema = z.object({
  name: z.string().trim().min(1), timezone: z.string().trim().min(1), overviewUrl: klaviyoUrlSchema, campaignsUrl: klaviyoUrlSchema.optional(), businessReviewUrl: klaviyoUrlSchema,
  signupFormsUrl: klaviyoUrlSchema.optional(), flowsUrl: klaviyoUrlSchema.optional(), segmentsUrl: klaviyoUrlSchema.optional(), deliverabilityUrl: klaviyoUrlSchema.optional(),
  welcomeFlow: targetSchema.optional(), welcomeFlowListing: welcomeFlowListingSchema.optional(), customerSegment: targetSchema.optional(), nonCustomerSegment: targetSchema.optional(), signupForms: signupFormsSchema.optional(),
}).strict();
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
const localClientsSchema = z.object({ clients: z.array(clientSchema).min(1) }).strict();
type LocalClient = z.infer<typeof clientSchema>;
type BlockedCode = "LIVE_ACCEPTANCE_BLOCKED_ACCOUNT_MISMATCH" | "LIVE_ACCEPTANCE_BLOCKED_AUTH" | "LIVE_ACCEPTANCE_BLOCKED_CLIENT_CONFIGURATION" | "LIVE_ACCEPTANCE_BLOCKED_MONTH" | "LIVE_ACCEPTANCE_BLOCKED_PAGE_NOT_READY" | "LIVE_ACCEPTANCE_BLOCKED_DATE_CONTROL" | "LIVE_ACCEPTANCE_BLOCKED_BROWSER";
type BrowserRuntimeDiagnostics = {
  consoleMessages: Array<{ type: string; text: string }>;
  pageErrors: string[];
  failedRequests: Array<{ url: string; error: string }>;
};
/** `home` sections live on Klaviyo Home (/dashboard); `cropToRows` crops the first N ranked rows without mutating the table. */
interface AutomatedSection { key: "overview" | "month_comparison" | "top_campaigns" | "top_flows" | "campaign_performance" | "campaign_metrics" | "flow_performance" | "flow_metrics" | "deliverability"; title: string; sourceIdentity: string; page: "home" | "business-review"; headings: readonly string[]; tab?: string; requiredText?: readonly string[]; minimumRows?: number; rowLimit?: number; cropToRows?: boolean }
const automatedSections: readonly AutomatedSection[] = [
  { key: "overview", title: "Executive Summary", sourceIdentity: "klaviyo-home|business-performance-summary|default", page: "home", headings: ["Business performance summary"], requiredText: ["Total revenue", "Attributed revenue"] },
  { key: "month_comparison", title: "Month Comparison", sourceIdentity: "business-review|growth-overview|message-type-breakdown|previous-period", page: "business-review", headings: ["Growth overview"], tab: "Message type breakdown", requiredText: ["Attributed revenue", "Campaigns", "Flows"] },
  { key: "top_campaigns", title: "Top Campaigns", sourceIdentity: "business-review|campaign-performance|top-performing", page: "business-review", headings: ["Campaign performance summary", "Campaign performance"], tab: "Top performing messages", requiredText: ["Campaign message"], minimumRows: 3 },
  { key: "top_flows", title: "Top 5 Flows", sourceIdentity: "klaviyo-home|top-performing-flows|default", page: "home", headings: ["Top performing flows"], requiredText: ["Flow", "Status", "Deliveries", "Placed Order"], minimumRows: 1, rowLimit: 5, cropToRows: true },
  { key: "campaign_performance", title: "Campaign Performance", sourceIdentity: "business-review|campaign-performance|overview", page: "business-review", headings: ["Campaign performance summary", "Campaign performance"], tab: "Overview" },
  { key: "campaign_metrics", title: "Campaign Metrics", sourceIdentity: "business-review|campaign-performance|metrics", page: "business-review", headings: ["Campaign performance summary", "Campaign performance"], tab: "Metrics" },
  { key: "flow_performance", title: "Flow Performance", sourceIdentity: "business-review|flow-performance|overview", page: "business-review", headings: ["Flow performance summary", "Flow performance"], tab: "Overview" },
  { key: "flow_metrics", title: "Flow Metrics", sourceIdentity: "business-review|flow-performance|metrics", page: "business-review", headings: ["Flow performance summary", "Flow performance"], tab: "Metrics" },
];

function argument(name: string): string | null { const index = process.argv.indexOf(name); return index >= 0 ? process.argv[index + 1] ?? null : null; }
function deriveClientId(name: string): string {
  const normalized = name.trim().replace(/\.(?:com|net|org|io|co|ai)$/i, "").normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  if (!normalized) throw new Error("Configured client name cannot form a safe identifier.");
  return normalized.slice(0, 80);
}
function blocked(code: BlockedCode, message: string, diagnostics: Record<string, unknown>): never {
  console.log(JSON.stringify({ status: code, message, diagnostics }, null, 2)); process.exitCode = 2; throw new Error(code);
}
async function exists(path: string): Promise<boolean> { try { await access(path, constants.F_OK); return true; } catch { return false; } }
function expectedMonth(value: string | null): { year: number; month: number } {
  const match = /^(\d{4})-(\d{2})$/.exec(value ?? "");
  if (!match || Number(match[2]) < 1 || Number(match[2]) > 12) throw new Error("Use --month YYYY-MM.");
  return { year: Number(match[1]), month: Number(match[2]) };
}
function redactedHtml(html: string): string {
  return html.replace(/<(script|noscript|iframe|style)\b[^>]*>[\s\S]*?<\/\1>/gi, "")
    .replace(/\s(?:value|content|data-[\w-]*(?:token|secret|key)|(?:authorization|cookie|token|secret|password|api[-_]?key))[\w-]*=(['"]).*?\1/gi, "")
    .replace(/(bearer\s+)[a-z0-9._~+\/-]+/gi, "$1[REDACTED]");
}
function safeText(value: string, maximum = 800): string {
  return value.replace(/(bearer\s+)[a-z0-9._~+\/-]+/gi, "$1[REDACTED]")
    .replace(/([?&](?:token|secret|key|authorization|cookie|password|api[-_]?key)=[^&\s]+)/gi, "$1[REDACTED]")
    .replace(/\s+/g, " ").trim().slice(0, maximum);
}
function safeUrl(value: string): string {
  try { const url = new URL(value); return `${url.origin}${url.pathname}`; } catch { return safeText(value, 500); }
}
function attachBrowserRuntimeDiagnostics(page: Page): BrowserRuntimeDiagnostics {
  const diagnostics: BrowserRuntimeDiagnostics = { consoleMessages: [], pageErrors: [], failedRequests: [] };
  page.on("console", (message) => {
    if (diagnostics.consoleMessages.length < 80) diagnostics.consoleMessages.push({ type: message.type(), text: safeText(message.text()) });
  });
  page.on("pageerror", (error) => { if (diagnostics.pageErrors.length < 40) diagnostics.pageErrors.push(safeText(error.message)); });
  page.on("requestfailed", (request) => {
    if (diagnostics.failedRequests.length < 80) diagnostics.failedRequests.push({ url: safeUrl(request.url()), error: safeText(request.failure()?.errorText ?? "request failed") });
  });
  return diagnostics;
}
async function waitForRenderedPage(page: Page): Promise<{ networkIdle: boolean; meaningfulVisibleText: boolean }> {
  // Klaviyo keeps background connections alive; visible semantic content is
  // the useful readiness signal and avoids delaying every capture on idle.
  const networkIdle = false;
  const meaningfulVisibleText = await page.waitForFunction(() => {
    const body = document.body;
    if (!body || body.innerText.replace(/\s+/g, " ").trim().length < 40) return false;
    return [...document.querySelectorAll("body *")].some((node) => {
      const element = node as HTMLElement;
      const style = getComputedStyle(element);
      return style.display !== "none" && style.visibility !== "hidden" && element.getBoundingClientRect().width > 1 && element.getBoundingClientRect().height > 1;
    });
  }, undefined, { timeout: 8_000 }).then(() => true).catch(() => false);
  return { networkIdle, meaningfulVisibleText };
}

/** Prefer Klaviyo's visible sidebar route over a full deep-link reload. The
 * current SPA can render an empty shell after a direct Score-route request. */
async function navigateToDeliverabilityScore(page: Page, sourceUrl: string): Promise<boolean> {
  const expected = new URL(sourceUrl);
  const sidebarIndex = await page.locator("a[href]").evaluateAll((anchors, target) => {
    const expectedUrl = new URL(target);
    const visible = (node: Element) => { const rect = node.getBoundingClientRect(); const style = getComputedStyle(node); return rect.width > 1 && rect.height > 1 && style.display !== "none" && style.visibility !== "hidden"; };
    return anchors.findIndex((candidate) => {
      const actual = new URL((candidate as HTMLAnchorElement).href, location.href);
      const label = (candidate.textContent ?? "").replace(/\s+/g, " ").trim().toLocaleLowerCase();
      return visible(candidate) && actual.origin === expectedUrl.origin
        && (actual.pathname === expectedUrl.pathname || (label === "deliverability" && /^\/analytics\/deliverability\/?$/i.test(actual.pathname)));
    });
  }, sourceUrl).catch(() => -1);
  if (sidebarIndex >= 0) await page.locator("a[href]").nth(sidebarIndex).click({ timeout: 15_000 });
  else await page.goto(sourceUrl, { waitUntil: "domcontentloaded", timeout: 60_000 });
  return page.waitForFunction((target) => {
    const expectedUrl = new URL(target);
    return location.origin === expectedUrl.origin && location.pathname === expectedUrl.pathname;
  }, sourceUrl, { timeout: 15_000 }).then(() => true).catch(() => false);
}

/** One bounded SPA retry from the known dashboard is safer than accepting the
 * visible loading skeleton or relying on an arbitrary sleep. */
async function captureDeliverabilityWithSpaRetry(page: Page, client: LocalClient, directory: string) {
  const first = await captureDeliverabilityScore(page, directory);
  if (first.ok) return first;
  await page.goto(client.overviewUrl, { waitUntil: "domcontentloaded", timeout: 60_000 });
  await waitForRenderedPage(page);
  if (!client.deliverabilityUrl || !await navigateToDeliverabilityScore(page, client.deliverabilityUrl)) return first;
  return captureDeliverabilityScore(page, directory);
}
async function openTimePeriodControl(page: Page): Promise<boolean> {
  const control = page.getByRole("button", { name: "Time period", exact: true });
  if (await control.count() !== 1) return false;
  await control.click();
  await page.waitForFunction(() => document.querySelector("#ascent-date-picker-portal, [role=dialog]")?.textContent?.trim().length ? true : false, undefined, { timeout: 5_000 }).catch(() => undefined);
  return true;
}
function formatDateForControl(isoDate: string): string {
  return new Intl.DateTimeFormat("en-US", { timeZone: "UTC", month: "short", day: "2-digit", year: "numeric" }).format(new Date(`${isoDate}T00:00:00.000Z`));
}
function htmlEscape(value: string): string { return value.replace(/[&<>\"]/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '\"': "&quot;" })[character]!); }
function targetPreflight(client: LocalClient, period: { startDate: string; endDate: string; previousStartDate: string; previousEndDate: string }): Array<{ key: string; title: string; status: "manual_by_design" | "deferred"; required: boolean; prerequisites: string[]; reason: string }> {
  const target = (value: { id?: string | undefined; name?: string | undefined } | undefined) => Boolean(value?.id || value?.name);
  const forms = client.signupForms?.mode === "all" || Boolean(client.signupForms && (client.signupForms.ids.length || client.signupForms.names.length));
  return [
    { key: "signup_form", title: "Signup Forms", status: "deferred", required: false, prerequisites: [!client.signupFormsUrl ? "signupFormsUrl" : "", !forms ? "signupForms scope (mode all or stable form ID/name)" : ""].filter(Boolean), reason: "No C1 source adapter exists; do not infer a form route or form identity." },
    { key: "welcome_flow", title: "Welcome Flow Listing", status: "deferred", required: false, prerequisites: [!client.flowsUrl ? "flowsUrl" : "", !client.welcomeFlowListing ? "Email Welcome listing scope" : ""].filter(Boolean), reason: "Listing-only manual capture is supported in the extension; the local browser acceptance adapter does not capture this listing." },
    { key: "customer_split", title: "Customer Split", status: "deferred", required: false, prerequisites: [!client.segmentsUrl ? "segmentsUrl" : "", !target(client.customerSegment) ? "customerSegment stable ID or name" : "", !target(client.nonCustomerSegment) ? "nonCustomerSegment stable ID or name" : ""].filter(Boolean), reason: "No C1 source adapter exists; do not infer customer or non-customer segments." },
  ];
}
async function setExactDateRange(page: Page, period: { startDate: string; endDate: string }, evidencePrefix?: string, comparisonPeriod?: { startDate: string; endDate: string }): Promise<{ ok: boolean; expectedRenderedRange: string; observedStart: string | null; observedEnd: string | null; observedComparisonStart?: string | null; observedComparisonEnd?: string | null; pickerDateEvidence?: string[]; appliedDateEvidence?: string[]; applyDisabled?: boolean; error?: string }> {
  const expectedRenderedRange = formatRenderedRange(period);
  const expectedComparisonRange = comparisonPeriod ? formatRenderedRange(comparisonPeriod) : null;
  try {
    let start = page.locator("#DateRangePicker-StartDate:visible");
    let end = page.locator("#DateRangePicker-EndDate:visible");
    if ((await start.count() !== 1 || await end.count() !== 1) && !(comparisonPeriod && await start.count() === 2 && await end.count() === 2)) {
      const timeframe = page.locator('[data-testid="time-period-popover-time-period-button"]:visible');
      if (await timeframe.count() !== 1) return { ok: false, expectedRenderedRange, observedStart: null, observedEnd: null, error: "The Time period mode selector was not uniquely available." };
      await timeframe.click();
      const custom = page.getByRole("option", { name: "Custom", exact: true });
      if (await custom.count() !== 1) return { ok: false, expectedRenderedRange, observedStart: null, observedEnd: null, error: "The Time period control did not expose a unique Custom range option." };
      await custom.click();
      await page.waitForFunction(() => document.querySelectorAll("#DateRangePicker-StartDate").length > 0 && [...document.querySelectorAll("#DateRangePicker-StartDate")].some((node) => getComputedStyle(node).display !== "none" && (node as HTMLElement).offsetParent !== null), { timeout: 5_000 });
      start = page.locator("#DateRangePicker-StartDate:visible");
      end = page.locator("#DateRangePicker-EndDate:visible");
    }
    if (comparisonPeriod && await start.count() === 1 && await end.count() === 1) {
      const comparisonMode = page.locator('[data-testid="time-period-popover-comparison-period-button"]:visible');
      if (await comparisonMode.count() !== 1) return { ok: false, expectedRenderedRange, observedStart: null, observedEnd: null, error: "The comparison-period selector was not uniquely available." };
      await comparisonMode.click();
      const customComparison = page.getByRole("option", { name: "Custom", exact: true });
      if (await customComparison.count() !== 1) return { ok: false, expectedRenderedRange, observedStart: null, observedEnd: null, error: "The comparison-period selector did not expose a unique Custom range option." };
      await customComparison.click();
      await page.waitForFunction(() => document.querySelectorAll("#DateRangePicker-StartDate:visible").length === 2 && document.querySelectorAll("#DateRangePicker-EndDate:visible").length === 2, undefined, { timeout: 5_000 }).catch(() => undefined);
      start = page.locator("#DateRangePicker-StartDate:visible");
      end = page.locator("#DateRangePicker-EndDate:visible");
    }
    const startCount = await start.count(); const endCount = await end.count();
    const expectedControlCount = comparisonPeriod ? 2 : 1;
    if (startCount !== expectedControlCount || endCount !== expectedControlCount) return { ok: false, expectedRenderedRange, observedStart: null, observedEnd: null, error: `The visible custom date-range inputs were ambiguous (start=${startCount}, end=${endCount}, expected=${expectedControlCount}).` };
    const fillPair = async (index: number, range: { startDate: string; endDate: string }) => {
      await start.nth(index).fill(formatDateForControl(range.startDate)); await start.nth(index).press("Tab");
      await end.nth(index).fill(formatDateForControl(range.endDate)); await end.nth(index).press("Tab");
      return { start: await start.nth(index).inputValue(), end: await end.nth(index).inputValue() };
    };
    const observedCurrent = await fillPair(0, period);
    const observedComparison = comparisonPeriod ? await fillPair(1, comparisonPeriod) : null;
    if (observedCurrent.start !== formatDateForControl(period.startDate) || observedCurrent.end !== formatDateForControl(period.endDate) || (comparisonPeriod && (observedComparison?.start !== formatDateForControl(comparisonPeriod.startDate) || observedComparison?.end !== formatDateForControl(comparisonPeriod.endDate)))) {
      return { ok: false, expectedRenderedRange, observedStart: observedCurrent.start, observedEnd: observedCurrent.end, ...(observedComparison ? { observedComparisonStart: observedComparison.start, observedComparisonEnd: observedComparison.end } : {}), error: "Klaviyo did not retain the exact requested current and comparison dates in the visible controls." };
    }
    const apply = page.getByRole("button", { name: "Apply", exact: true });
    if (await apply.count() !== 1) return { ok: false, expectedRenderedRange, observedStart: observedCurrent.start, observedEnd: observedCurrent.end, ...(observedComparison ? { observedComparisonStart: observedComparison.start, observedComparisonEnd: observedComparison.end } : {}), error: "The visible date-range Apply button was not uniquely available." };
    const pickerDateEvidence = await page.locator("#ascent-date-picker-portal, [role=dialog]").evaluateAll((nodes) => nodes.flatMap((node) => (node.textContent ?? "").split(/\n+/).map((line) => line.replace(/\s+/g, " ").trim()).filter((line) => /\b(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\b|apply|custom/i.test(line)).slice(0, 20)));
    const applyDisabled = await apply.isDisabled();
    if (evidencePrefix) {
      await page.screenshot({ path: `${evidencePrefix}-before-apply-viewport.png`, fullPage: false });
      const pickerHtml = await page.locator("#ascent-date-picker-portal, [role=dialog]").evaluateAll((nodes) => nodes.map((node) => (node as HTMLElement).outerHTML).join("\n"));
      await writeFile(`${evidencePrefix}-before-apply.html`, redactedHtml(pickerHtml));
    }
    await apply.click();
    const rendered = await page.waitForFunction(({ current, comparison }) => {
      const text = document.body.innerText.replace(/\s+/g, " ");
      return text.includes(current) && (!comparison || text.includes(comparison));
    }, { current: expectedRenderedRange, comparison: expectedComparisonRange }, { timeout: 30_000 }).then(() => true).catch(() => false);
    const appliedDateEvidence = await page.locator("body").innerText().then((text) => text.split(/\n+/).map((line) => line.replace(/\s+/g, " ").trim()).filter((line) => /\b(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\b.*\b\d{4}\b|compared to previous period/i.test(line)).slice(0, 20)).catch(() => [] as string[]);
    const exactRenderedEvidence = rendered && renderedRangesAreExact(appliedDateEvidence, period, comparisonPeriod);
    return { ok: exactRenderedEvidence, expectedRenderedRange, observedStart: observedCurrent.start, observedEnd: observedCurrent.end, ...(observedComparison ? { observedComparisonStart: observedComparison.start, observedComparisonEnd: observedComparison.end } : {}), pickerDateEvidence, appliedDateEvidence, applyDisabled, ...(exactRenderedEvidence ? {} : { error: `Klaviyo did not render the exact requested current${comparisonPeriod ? " and comparison" : ""} calendar-month ranges together after Apply.` }) };
  } catch (error) {
    return { ok: false, expectedRenderedRange, observedStart: null, observedEnd: null, error: safeText(error instanceof Error ? error.message : "Unknown date-control error") };
  }
}
type RankedRow = { cells: string[]; trend: "negative" | "positive" | "neutral" | null };
/** Reads the first ranked table rows, including the visible direction of any trend badge (e.g. a red downward change). */
async function readRankedRows(card: Locator, limit: number): Promise<RankedRow[]> {
  return card.evaluate((node, rowLimit) => [...node.querySelectorAll("tbody tr")]
    .filter((row) => (row.textContent ?? "").replace(/\s+/g, " ").trim().length > 0).slice(0, rowLimit)
    .map((row) => {
      const badge = row.querySelector("[class*='TrendBadge-module__trendBadge']");
      const badgeClass = badge?.getAttribute("class") ?? "";
      const arrow = badge?.querySelector("svg")?.getAttribute("data-asc") ?? "";
      const trend = !badge ? null : /negative/i.test(badgeClass) || /South/.test(arrow) ? "negative" : /positive/i.test(badgeClass) || /North/.test(arrow) ? "positive" : "neutral";
      return { cells: [...row.querySelectorAll("td,[role=cell]")].map((cell) => ((cell as HTMLElement).innerText || cell.textContent || "").replace(/\s+/g, " ").trim()), trend };
    }), limit);
}
/** Viewport clip from the card's top edge to just below the last included row; null when any part is off-screen. */
async function rankedRowsClip(card: Locator, limit: number): Promise<{ x: number; y: number; width: number; height: number } | null> {
  return card.evaluate((node, rowLimit) => {
    const rows = [...node.querySelectorAll("tbody tr")].filter((row) => (row.textContent ?? "").replace(/\s+/g, " ").trim().length > 0);
    const last = rows[rowLimit - 1]; if (!last) return null;
    const cells = [...last.querySelectorAll("td,[role=cell]")].map((cell) => cell.getBoundingClientRect()).filter((rect) => rect.height > 0);
    const rowBottom = Math.max(last.getBoundingClientRect().bottom, ...cells.map((rect) => rect.bottom));
    const nextTop = rows[rowLimit] ? Math.min(...[...rows[rowLimit]!.querySelectorAll("td,[role=cell]")].map((cell) => cell.getBoundingClientRect().top)) : Number.POSITIVE_INFINITY;
    const cardRect = node.getBoundingClientRect();
    const bottom = Math.min(rowBottom + 8, nextTop, cardRect.bottom);
    const clip = { x: Math.max(0, Math.floor(cardRect.left)), y: Math.max(0, Math.floor(cardRect.top)), width: Math.ceil(cardRect.width), height: Math.ceil(bottom - cardRect.top) };
    if (cardRect.top < 0 || cardRect.left < 0 || cardRect.right > window.innerWidth || bottom > window.innerHeight || clip.height < 120) return null;
    return clip;
  }, limit);
}
/** Writes the card only after consecutive screenshots are byte-identical, so a mid-repaint frame is never persisted. */
async function screenshotStableCard(page: Page, card: Locator, path: string): Promise<{ attempts: number; identicalCaptures: number }> {
  const result = await captureStableScreenshot(
    () => card.screenshot({ timeout: 15_000, animations: "disabled" }),
    async () => {
      await page.evaluate(() => (document.fonts?.ready ?? Promise.resolve()).then(() => new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done())))));
      await page.waitForTimeout(250);
    },
  );
  if (!result.ok) throw new Error(result.error);
  await writeFile(path, result.bytes);
  return { attempts: result.attempts, identicalCaptures: result.identicalCaptures };
}
async function captureAutomatedSection(page: Page, directory: string, section: AutomatedSection, expectedPeriod: Record<string, string>): Promise<{ ok: boolean; sha256?: string; byteSize?: number; usableRowCount?: number; includedRowCount?: number; error?: string }> {
  if (!await waitForRequiredCardContent(page, section)) return { ok: false, error: "The semantic card did not finish rendering its required content." };
  const resolved = await resolveSemanticCard(page, section);
  if (!resolved.ok) return resolved;
  const card = page.locator(`[data-tention-local-capture="${section.key}"]`);
  if (await card.count() !== 1) return { ok: false, error: "The semantic card was replaced before it could be captured." };
  if (section.tab) {
    let tab = card.getByRole("tab", { name: section.tab, exact: true });
    if (await tab.count() !== 1) tab = card.getByRole("button", { name: section.tab, exact: true });
    if (await tab.count() !== 1) return { ok: false, error: `The card-local ${section.tab} control was not uniquely available.` };
    await tab.click();
    const rebound = await reacquireSemanticCardAfterViewChange(page, section);
    if (!rebound.ok) {
      const snapshot = await page.evaluate((headingLabel) => {
        const heading = [...document.querySelectorAll("h1,h2,h3,h4,h5,h6,[role=heading]")].find((node) => (node.textContent ?? "").replace(/\s+/g, " ").trim().toLowerCase() === headingLabel.toLowerCase());
        let card = heading?.parentElement ?? null;
        while (card && card !== document.body && card !== document.documentElement && card.tagName !== "MAIN") card = card.parentElement;
        return { html: document.documentElement.outerHTML, cardHtml: card?.outerHTML ?? "<!-- matching semantic card not found -->", viewHtml: [...document.querySelectorAll("table,[role=grid],[role=table]")].map((node) => (node as HTMLElement).outerHTML).join("\n"), headings: [...document.querySelectorAll("h1,h2,h3,h4,h5,h6,[role=heading]")].map((node) => (node.textContent ?? "").replace(/\s+/g, " ").trim()).filter(Boolean).slice(0, 80), tableHeaders: [...document.querySelectorAll("th,[role=columnheader]")].map((node) => (node.textContent ?? "").replace(/\s+/g, " ").trim()).filter(Boolean).slice(0, 80), usableRowCount: [...document.querySelectorAll("tbody tr,[role=rowgroup] [role=row]")].filter((node) => (node.textContent ?? "").replace(/\s+/g, " ").trim().length > 0).length };
      }, section.headings[0]!);
      await page.screenshot({ path: join(directory, `${section.key}-failure-viewport.png`), fullPage: false });
      await page.screenshot({ path: join(directory, `${section.key}-failure-full-page.png`), fullPage: true });
      await writeFile(join(directory, `${section.key}-page.html`), redactedHtml(snapshot.html));
      await writeFile(join(directory, `${section.key}-card.html`), redactedHtml(snapshot.cardHtml));
      await writeFile(join(directory, `${section.key}-view-region.html`), redactedHtml(snapshot.viewHtml));
      await writeFile(join(directory, `${section.key}-diagnostics.json`), `${JSON.stringify({ title: section.title, errorCode: "SEMANTIC_CARD_REBIND_FAILED", error: rebound.error, canonicalSourceIdentity: section.sourceIdentity, expectedPeriod, sourceUrl: safeUrl(page.url()), headings: snapshot.headings, tableHeaders: snapshot.tableHeaders, usableRowCount: snapshot.usableRowCount }, null, 2)}\n`);
      return { ok: false, usableRowCount: snapshot.usableRowCount, error: rebound.error ?? "The semantic card could not be rebound after Klaviyo updated its view." };
    }
    const selected = await page.waitForFunction(({ key, label }) => {
      const card = document.querySelector(`[data-tention-local-capture="${key}"]`);
      if (!card) return false;
      return [...card.querySelectorAll("[role=tab],button,[role=button],[aria-pressed],[aria-selected]")].some((node) => ((node.getAttribute("aria-label") ?? node.textContent ?? "").replace(/\s+/g, " ").trim().toLowerCase() === label.toLowerCase()) && (node.getAttribute("aria-selected") === "true" || node.getAttribute("aria-pressed") === "true"));
    }, { key: section.key, label: section.tab }, { timeout: 12_000 }).then(() => true).catch(() => false);
    if (!selected && !section.minimumRows) return { ok: false, error: `Klaviyo did not confirm ${section.tab} as the selected card-local view.` };
    if (section.requiredText) {
      const rendered = await page.waitForFunction(({ key, required }) => {
        const card = document.querySelector(`[data-tention-local-capture="${key}"]`);
        const text = (card?.textContent ?? "").replace(/\s+/g, " ").trim().toLowerCase();
        return required.every((value) => text.includes(value.toLowerCase())) && !card?.querySelector('[data-testid*="spinner"],[data-asc="Spinner"]');
      }, { key: section.key, required: section.requiredText }, { timeout: 8_000 }).then(() => true).catch(() => false);
      if (!rendered) {
        const html = await card.evaluate((node) => node.outerHTML).catch(() => "<!-- Card was replaced before evidence could be saved. -->");
        await writeFile(join(directory, `${section.key}-card.html`), redactedHtml(html));
        await page.screenshot({ path: join(directory, `${section.key}-failure-viewport.png`), fullPage: false });
        await page.screenshot({ path: join(directory, `${section.key}-failure-full-page.png`), fullPage: true });
        return { ok: false, error: "The selected card did not render its required semantic content before the bounded wait elapsed." };
      }
    }
  }
  let rowEvidence = await card.evaluate((node, requiredText) => {
    const text = (node.textContent ?? "").replace(/\s+/g, " ").trim().toLowerCase();
    const rowCount = [...node.querySelectorAll("tbody tr,[role=rowgroup] [role=row]")].filter((row) => (row.textContent ?? "").replace(/\s+/g, " ").trim().length > 0).length;
    return { text, rowCount, html: node.outerHTML };
  }, section.requiredText);
  if (section.requiredText && !section.requiredText.every((value) => rowEvidence.text.includes(value.toLowerCase()))) return { ok: false, usableRowCount: rowEvidence.rowCount, error: "The selected card did not render its required semantic content." };
  if (section.cropToRows && rowEvidence.rowCount === 0) return { ok: false, usableRowCount: 0, error: "TOP_FLOWS_NO_DATA: the ranking table rendered no usable rows for the selected month." };
  if (section.minimumRows && rowEvidence.rowCount < section.minimumRows) return { ok: false, usableRowCount: rowEvidence.rowCount, error: `The selected ranking table exposed ${rowEvidence.rowCount} usable rows; ${section.minimumRows} are required.` };
  let includedRowCount: number | undefined;
  let renderStability: { attempts: number; identicalCaptures: number } | undefined;
  let rankedRows: RankedRow[] | undefined;
  try {
    const scrolled = await scrollSemanticCardIntoView(page, section);
    if (!scrolled.ok || await card.count() !== 1) {
      const snapshot = await page.evaluate((headingLabel) => {
        const heading = [...document.querySelectorAll("h1,h2,h3,h4,h5,h6,[role=heading]")].find((node) => (node.textContent ?? "").replace(/\s+/g, " ").trim().toLowerCase() === headingLabel.toLowerCase());
        let card = heading?.parentElement ?? null;
        while (card && card !== document.body && card !== document.documentElement && card.tagName !== "MAIN") card = card.parentElement;
        return { html: document.documentElement.outerHTML, cardHtml: card?.outerHTML ?? "<!-- matching semantic card not found -->", viewHtml: [...document.querySelectorAll("table,[role=grid],[role=table]")].map((node) => (node as HTMLElement).outerHTML).join("\n"), headings: [...document.querySelectorAll("h1,h2,h3,h4,h5,h6,[role=heading]")].map((node) => (node.textContent ?? "").replace(/\s+/g, " ").trim()).filter(Boolean).slice(0, 80), tableHeaders: [...document.querySelectorAll("th,[role=columnheader]")].map((node) => (node.textContent ?? "").replace(/\s+/g, " ").trim()).filter(Boolean).slice(0, 80), usableRowCount: [...document.querySelectorAll("tbody tr,[role=rowgroup] [role=row]")].filter((node) => (node.textContent ?? "").replace(/\s+/g, " ").trim().length > 0).length };
      }, section.headings[0]!);
      await page.screenshot({ path: join(directory, `${section.key}-failure-viewport.png`), fullPage: false });
      await page.screenshot({ path: join(directory, `${section.key}-failure-full-page.png`), fullPage: true });
      await writeFile(join(directory, `${section.key}-page.html`), redactedHtml(snapshot.html));
      await writeFile(join(directory, `${section.key}-card.html`), redactedHtml(snapshot.cardHtml));
      await writeFile(join(directory, `${section.key}-view-region.html`), redactedHtml(snapshot.viewHtml));
      await writeFile(join(directory, `${section.key}-diagnostics.json`), `${JSON.stringify({ title: section.title, errorCode: "SEMANTIC_CARD_SCROLL_FAILED", error: scrolled.error ?? "The semantic capture marker was lost before scrolling.", canonicalSourceIdentity: section.sourceIdentity, expectedPeriod, sourceUrl: safeUrl(page.url()), headings: snapshot.headings, tableHeaders: snapshot.tableHeaders, usableRowCount: snapshot.usableRowCount }, null, 2)}\n`);
      return { ok: false, usableRowCount: snapshot.usableRowCount, error: scrolled.error ?? "The semantic card could not be scrolled into capture position." };
    }
    rowEvidence = await card.evaluate((node) => {
      const text = (node.textContent ?? "").replace(/\s+/g, " ").trim().toLowerCase();
      const rowCount = [...node.querySelectorAll("tbody tr,[role=rowgroup] [role=row]")].filter((row) => (row.textContent ?? "").replace(/\s+/g, " ").trim().length > 0).length;
      return { text, rowCount, html: node.outerHTML };
    });
    if (section.requiredText && !section.requiredText.every((value) => rowEvidence.text.includes(value.toLowerCase()))) return { ok: false, usableRowCount: rowEvidence.rowCount, error: "The selected card lost its required semantic content before the crop." };
    if (section.minimumRows && rowEvidence.rowCount < section.minimumRows) return { ok: false, usableRowCount: rowEvidence.rowCount, error: `The ranking table exposed ${rowEvidence.rowCount} usable rows before the crop; ${section.minimumRows} are required.` };
    if (section.cropToRows && rowEvidence.rowCount === 0) return { ok: false, usableRowCount: 0, error: "TOP_FLOWS_NO_DATA: the ranking table rendered no usable rows before the crop." };
    if (section.cropToRows && section.minimumRows) {
      // Crop the first `rowLimit` rows, or every real row when fewer exist; never pad.
      const rowLimit = Math.min(section.rowLimit ?? section.minimumRows, rowEvidence.rowCount);
      const before = await readRankedRows(card, rowLimit);
      const stable = await captureStableScreenshot(
        async () => {
          const clip = await rankedRowsClip(card, rowLimit);
          if (!clip) throw new Error(`The first ${rowLimit} ranked rows do not fit fully inside the visible viewport.`);
          return page.screenshot({ clip, timeout: 15_000, animations: "disabled" });
        },
        async () => { await page.evaluate(() => (document.fonts?.ready ?? Promise.resolve()).then(() => new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done()))))); await page.waitForTimeout(250); },
      );
      if (!stable.ok) throw new Error(stable.error);
      rankedRows = await readRankedRows(card, rowLimit);
      // The rows read before and after the stable frames must be identical, or the table changed during capture.
      if (JSON.stringify(before) !== JSON.stringify(rankedRows) || rankedRows.length !== rowLimit) throw new Error("The ranked rows changed while the screenshot was being captured.");
      await writeFile(join(directory, `${section.key}.png`), stable.bytes);
      renderStability = { attempts: stable.attempts, identicalCaptures: stable.identicalCaptures };
      includedRowCount = rowLimit;
    } else if (section.minimumRows) {
      const masked = await card.evaluate((node, rowLimit) => {
        const rows = [...node.querySelectorAll("tbody tr,[role=rowgroup] [role=row]")].filter((row) => (row.textContent ?? "").replace(/\s+/g, " ").trim().length > 0) as HTMLElement[];
        rows.slice(rowLimit).forEach((row) => { row.dataset.tentionLocalDisplay = row.style.display; row.style.display = "none"; });
        return { availableRowCount: rows.length, includedRowCount: Math.min(rowLimit, rows.length) };
      }, section.minimumRows);
      if (masked.includedRowCount < section.minimumRows) return { ok: false, usableRowCount: rowEvidence.rowCount, error: "The ranking table did not expose the required number of rows for its crop." };
      includedRowCount = masked.includedRowCount;
      try { renderStability = await screenshotStableCard(page, card, join(directory, `${section.key}.png`)); }
      finally { await page.evaluate((key) => [...document.querySelectorAll<HTMLElement>(`[data-tention-local-capture="${key}"] [data-tention-local-display]`)].forEach((row) => { row.style.display = row.dataset.tentionLocalDisplay ?? ""; delete row.dataset.tentionLocalDisplay; }), section.key); }
    } else {
      renderStability = await screenshotStableCard(page, card, join(directory, `${section.key}.png`));
    }
  } catch (error) {
    const failure = safeText(error instanceof Error ? error.message : "The semantic card screenshot failed.");
    const snapshot = await page.evaluate((headingLabel) => {
      const heading = [...document.querySelectorAll("h1,h2,h3,h4,h5,h6,[role=heading]")].find((node) => (node.textContent ?? "").replace(/\s+/g, " ").trim().toLowerCase() === headingLabel.toLowerCase());
      let card = heading?.parentElement ?? null;
      while (card && card !== document.body && card !== document.documentElement && card.tagName !== "MAIN") card = card.parentElement;
      return { html: document.documentElement.outerHTML, cardHtml: card?.outerHTML ?? "<!-- matching semantic card not found -->", viewHtml: [...document.querySelectorAll("table,[role=grid],[role=table]")].map((node) => (node as HTMLElement).outerHTML).join("\n"), headings: [...document.querySelectorAll("h1,h2,h3,h4,h5,h6,[role=heading]")].map((node) => (node.textContent ?? "").replace(/\s+/g, " ").trim()).filter(Boolean).slice(0, 80), tableHeaders: [...document.querySelectorAll("th,[role=columnheader]")].map((node) => (node.textContent ?? "").replace(/\s+/g, " ").trim()).filter(Boolean).slice(0, 80), usableRowCount: [...document.querySelectorAll("tbody tr,[role=rowgroup] [role=row]")].filter((node) => (node.textContent ?? "").replace(/\s+/g, " ").trim().length > 0).length };
    }, section.headings[0]!);
    await page.screenshot({ path: join(directory, `${section.key}-failure-viewport.png`), fullPage: false }).catch(() => undefined);
    await page.screenshot({ path: join(directory, `${section.key}-failure-full-page.png`), fullPage: true }).catch(() => undefined);
    await writeFile(join(directory, `${section.key}-page.html`), redactedHtml(snapshot.html));
    await writeFile(join(directory, `${section.key}-card.html`), redactedHtml(snapshot.cardHtml));
    await writeFile(join(directory, `${section.key}-view-region.html`), redactedHtml(snapshot.viewHtml));
    await writeFile(join(directory, `${section.key}-diagnostics.json`), `${JSON.stringify({ title: section.title, errorCode: "SEMANTIC_CARD_SCREENSHOT_FAILED", error: failure, canonicalSourceIdentity: section.sourceIdentity, expectedPeriod, sourceUrl: safeUrl(page.url()), headings: snapshot.headings, tableHeaders: snapshot.tableHeaders, usableRowCount: snapshot.usableRowCount }, null, 2)}\n`);
    return { ok: false, usableRowCount: snapshot.usableRowCount, error: failure };
  }
  await writeFile(join(directory, `${section.key}-card.html`), redactedHtml(rowEvidence.html));
  const image = await readFile(join(directory, `${section.key}.png`));
  const sha256 = createHash("sha256").update(image).digest("hex");
  await writeFile(join(directory, `${section.key}-diagnostics.json`), `${JSON.stringify({ title: section.title, canonicalSourceIdentity: section.sourceIdentity, expectedPeriod, sourceUrl: safeUrl(page.url()), usableRowCount: rowEvidence.rowCount, includedRowCount: includedRowCount ?? rowEvidence.rowCount, renderStability, ...(rankedRows ? { rankedRows } : {}), screenshot: { file: `${section.key}.png`, byteSize: image.byteLength, sha256 } }, null, 2)}\n`);
  return { ok: true, sha256, byteSize: image.byteLength, usableRowCount: rowEvidence.rowCount, ...(includedRowCount === undefined ? {} : { includedRowCount }) };
}
/** Read-only direct capture of Klaviyo's rolling Deliverability Score card. */
async function waitForDeliverabilityScoreSemantics(page: Page, metricLabels: readonly string[]): Promise<boolean> {
  const deadline = Date.now() + 15_000;
  const serializedLabels = JSON.stringify(metricLabels.map((value) => value.toLocaleLowerCase()));
  while (Date.now() < deadline) {
    const ready = await page.evaluate(`(() => {
      const labels = ${serializedLabels};
      const main = document.querySelector('#app-shell-main') || document.querySelector('main');
      const text = (main?.textContent || '').replace(/\\s+/g, ' ').toLocaleLowerCase();
      return Boolean(main && text.includes('deliverability') && text.includes('score')
        && text.includes('deliverability score') && text.includes('based on last 30 days of data')
        && text.includes('your score is') && labels.filter((value) => text.includes(value)).length >= 3);
    })()` ).catch(() => false);
    if (ready) {
      await page.waitForTimeout(350).catch(() => undefined);
      return true;
    }
    await page.waitForTimeout(250).catch(() => undefined);
  }
  return false;
}

/** Short visible labels from Klaviyo's navigation chrome, where the account switcher lives. */
async function visibleAccountLabels(page: Page): Promise<string[]> {
  await page.locator("nav, aside, [role=navigation]").first().waitFor({ state: "visible", timeout: 20_000 }).catch(() => undefined);
  return await page.evaluate(`(() => {
    const roots = Array.from(document.querySelectorAll('nav, aside, [role=navigation], [data-testid*="account" i], [aria-label*="account" i]'));
    const labels = [];
    for (const root of roots) for (const node of [root, ...root.querySelectorAll('button, a, [role=button], [aria-haspopup]')]) {
      const rect = node.getBoundingClientRect(); const style = getComputedStyle(node);
      if (rect.width < 1 || rect.height < 1 || style.display === 'none' || style.visibility === 'hidden') continue;
      const text = (node.innerText || node.textContent || '').replace(/\\s+/g, ' ').trim();
      if (text && text.length <= 60) labels.push(text);
    }
    return labels;
  })()`).catch(() => []) as string[];
}

interface DeliverabilityCardSignature { signature: string; html: string; scoreText: string | null; animating: boolean }
async function readDeliverabilityCardSignature(page: Page): Promise<DeliverabilityCardSignature | null> {
  return await page.evaluate(`(() => {
    const card = document.querySelector('[data-tention-local-capture="deliverability"]');
    if (!card) return null;
    const normalize = (value) => (value || '').replace(/\\s+/g, ' ').trim().toLocaleLowerCase();
    const rect = card.getBoundingClientRect();
    const gauge = Array.from(card.querySelectorAll('svg path, svg circle')).map((node) => ['d', 'stroke-dashoffset', 'stroke-dasharray', 'transform', 'style'].map((name) => node.getAttribute(name) || '').join('|')).join(';');
    const text = normalize(card.innerText || card.textContent);
    const animating = typeof document.getAnimations === 'function' && document.getAnimations().some((animation) => animation.playState === 'running' && animation.effect && animation.effect.target instanceof Node && card.contains(animation.effect.target));
    const score = text.match(/(\\d{1,3})\\s*your score is/);
    return { signature: text + '#' + gauge + '#' + [rect.x, rect.y, rect.width, rect.height].map(Math.round).join(','), html: card.outerHTML, scoreText: score ? score[1] : null, animating };
  })()`).catch(() => null) as DeliverabilityCardSignature | null;
}
async function waitForStableDeliverabilityCard(page: Page, requiredStableSamples = 4, sampleIntervalMs = 300, timeoutMs = 12_000): Promise<(DeliverabilityCardSignature & { stableSamples: number }) | null> {
  const deadline = Date.now() + timeoutMs;
  let previous: string | null = null; let stableSamples = 0;
  while (Date.now() < deadline) {
    const current = await readDeliverabilityCardSignature(page);
    if (!current) return null;
    stableSamples = current.signature === previous && !current.animating ? stableSamples + 1 : 0;
    previous = current.signature;
    if (stableSamples >= requiredStableSamples) return { ...current, stableSamples };
    await page.waitForTimeout(sampleIntervalMs).catch(() => undefined);
  }
  return null;
}

async function captureDeliverabilityScore(page: Page, directory: string): Promise<{ ok: boolean; sha256?: string; byteSize?: number; error?: string }> {
  const metricLabels = ["Open rate", "Click rate", "Bounce rate", "Unsubscribe rate", "Spam complaint rate"];
  const ready = await waitForDeliverabilityScoreSemantics(page, metricLabels);
  if (!ready) {
    const mainText = await page.locator("#app-shell-main, main").first().innerText().catch(() => "");
    await writeFile(join(directory, "deliverability-readiness-failure.json"), `${JSON.stringify({ sourceUrl: safeUrl(page.url()), mainText: safeText(mainText, 6_000), requiredMetricCount: metricLabels.filter((label) => mainText.toLocaleLowerCase().includes(label.toLocaleLowerCase())).length }, null, 2)}\n`);
    return { ok: false, error: "The standalone Deliverability Score page did not render its score gauge and complete rate table." };
  }
  const candidate = await page.evaluate(`(() => {
    const labels = ${JSON.stringify(metricLabels.map((value) => value.toLocaleLowerCase()))};
    const normalize = (value) => (value || '').replace(/\\s+/g, ' ').trim().toLocaleLowerCase();
    const visible = (node) => { const style = getComputedStyle(node); const rect = node.getBoundingClientRect(); return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 100 && rect.height > 80; };
    const main = document.querySelector('#app-shell-main') || document.querySelector('main');
    const candidates = Array.from(main ? main.querySelectorAll('article,section,[role=region],div') : [])
      .filter(visible)
      .map((node) => ({ node, text: normalize(node.innerText || node.textContent), rect: node.getBoundingClientRect() }))
      .filter(({ text }) => text.includes('deliverability score') && text.includes('based on last 30 days of data')
        && text.includes('your score is') && labels.filter((value) => text.includes(value)).length >= 3
        && !text.includes('action center'))
      .sort((left, right) => (left.rect.width * left.rect.height) - (right.rect.width * right.rect.height));
    const selected = candidates[0];
    if (!selected) return null;
    selected.node.dataset.tentionLocalCapture = 'deliverability';
    return { text: selected.text, html: selected.node.outerHTML, width: selected.rect.width, height: selected.rect.height };
  })()`) as { text: string; html: string; width: number; height: number } | null;
  if (!candidate) {
    const mainText = await page.locator("#app-shell-main, main").first().innerText().catch(() => "");
    await writeFile(join(directory, "deliverability-card-selection-failure.json"), `${JSON.stringify({ sourceUrl: safeUrl(page.url()), mainText: safeText(mainText, 6_000) }, null, 2)}\n`);
    return { ok: false, error: "No clean Deliverability Score card containing the gauge and rate table was found outside Action Center." };
  }
  const card = page.locator('[data-tention-local-capture="deliverability"]');
  if (await card.count() !== 1) return { ok: false, error: "The Deliverability Score card was ambiguous before screenshot capture." };
  await card.scrollIntoViewIfNeeded().catch(() => undefined);
  // Klaviyo counts the gauge number up after render; `animations: "disabled"`
  // does not stop that JS count-up, so wait for a settled card and prove it
  // did not change while the screenshot was taken.
  const settled = await waitForStableDeliverabilityCard(page);
  if (!settled) return { ok: false, error: "The Deliverability Score gauge did not settle before capture." };
  try { await card.screenshot({ path: join(directory, "deliverability.png"), timeout: 15_000, animations: "disabled" }); }
  catch (error) { return { ok: false, error: safeText(error instanceof Error ? error.message : "The Deliverability Score screenshot failed.") }; }
  const afterCapture = await readDeliverabilityCardSignature(page);
  if (afterCapture?.signature !== settled.signature) return { ok: false, error: "The Deliverability Score card changed while the screenshot was taken." };
  candidate.html = settled.html;
  const image = await readFile(join(directory, "deliverability.png"));
  const sha256 = createHash("sha256").update(image).digest("hex");
  await writeFile(join(directory, "deliverability-card.html"), redactedHtml(candidate.html));
  await writeFile(join(directory, "deliverability-diagnostics.json"), `${JSON.stringify({
    title: "Deliverability Score", canonicalSourceIdentity: "klaviyo-deliverability|deliverability-score|email", expectedPeriod: null,
    sourceUrl: safeUrl(page.url()), captureTimestamp: new Date().toISOString(), observedScoreText: settled.scoreText, stableSamples: settled.stableSamples, semanticEvidence: { rollingThirtyDays: true, scoreGauge: /deliverability score/.test(candidate.text) && /your score is/.test(candidate.text), rateTable: metricLabels.filter((value) => candidate.text.includes(value.toLocaleLowerCase())).length >= 3, actionCenterExcluded: !candidate.text.includes("action center") },
    screenshot: { file: "deliverability.png", byteSize: image.byteLength, sha256 },
  }, null, 2)}\n`);
  return { ok: true, sha256, byteSize: image.byteLength };
}

async function captureEvidence(page: Page, directory: string, stage: string, sourceIdentity: string, expectedPeriod: Record<string, string>, runtime: BrowserRuntimeDiagnostics, readiness: { networkIdle: boolean; meaningfulVisibleText: boolean }): Promise<Record<string, unknown>> {
  await page.screenshot({ path: join(directory, `${stage}-viewport.png`), fullPage: false });
  await page.screenshot({ path: join(directory, `${stage}-full-page.png`), fullPage: true });
  const snapshot = await page.evaluate(() => {
    return {
      url: location.href,
      title: document.title,
      headings: [...document.querySelectorAll("h1,h2,h3,[role=heading]")].map((node) => (node.textContent ?? "").replace(/\s+/g, " ").trim()).filter(Boolean).slice(0, 80),
      controls: [...document.querySelectorAll("button,[role=button],[role=tab]")].map((node) => (node.textContent ?? "").replace(/\s+/g, " ").trim()).filter(Boolean).slice(0, 120),
      tableHeaders: [...document.querySelectorAll("th,[role=columnheader]")].map((node) => (node.textContent ?? "").replace(/\s+/g, " ").trim()).filter(Boolean).slice(0, 80),
      usableRowCount: [...document.querySelectorAll("tbody tr,[role=row]")].filter((node) => (node.textContent ?? "").replace(/\s+/g, " ").trim().length > 0).length,
      bodyTextCharacters: document.body.innerText.replace(/\s+/g, " ").trim().length,
      rootHtmlCharacters: (document.querySelector("#root")?.innerHTML ?? "").length,
      observedDateStrings: (document.body.innerText.match(/\b(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\s+\d{1,2},?\s+\d{4}\b/g) ?? []).slice(0, 40),
      candidateCards: [...document.querySelectorAll("article,[role=region],[role=tabpanel],section")].map((node) => ({ text: (node.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 500), html: (node as HTMLElement).outerHTML })).filter((candidate) => candidate.text.length > 20).slice(0, 12),
      candidateViews: [...document.querySelectorAll("table,[role=grid],[role=table]")].map((node) => ({ text: (node.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 500), html: (node as HTMLElement).outerHTML })).filter((candidate) => candidate.text.length > 20).slice(0, 12),
      html: document.documentElement.outerHTML,
    };
  });
  await writeFile(join(directory, `${stage}-page.html`), redactedHtml(snapshot.html));
  const cardHtml = snapshot.candidateCards[0]?.html ?? "<!-- No rendered card region was detected. -->";
  const viewHtml = snapshot.candidateViews[0]?.html ?? "<!-- No rendered table or view region was detected. -->";
  await writeFile(join(directory, `${stage}-card.html`), redactedHtml(cardHtml));
  await writeFile(join(directory, `${stage}-view-region.html`), redactedHtml(viewHtml));
  const { html: _html, candidateCards, candidateViews, ...summary } = snapshot;
  const evidence = {
    stage,
    canonicalSourceIdentity: sourceIdentity,
    expectedPeriod,
    readiness,
    runtime,
    relevantCardCandidates: candidateCards.map((candidate) => safeText(candidate.text, 500)),
    relevantViewCandidates: candidateViews.map((candidate) => safeText(candidate.text, 500)),
    ...summary,
  };
  await writeFile(join(directory, `${stage}-diagnostics.json`), `${JSON.stringify(evidence, null, 2)}\n`);
  return evidence;
}
async function loadClient(selector: string, file: string): Promise<LocalClient> {
  if (!await exists(file)) blocked("LIVE_ACCEPTANCE_BLOCKED_CLIENT_CONFIGURATION", `Missing local client configuration: ${file}`, { example: "data/local-clients.example.json", selector });
  const parsed = localClientsSchema.parse(JSON.parse(await readFile(file, "utf8")));
  const client = parsed.clients.find((candidate) => candidate.name.toLocaleLowerCase() === selector.toLocaleLowerCase() || deriveClientId(candidate.name) === selector);
  if (!client) blocked("LIVE_ACCEPTANCE_BLOCKED_CLIENT_CONFIGURATION", "No matching client was found in the local configuration.", { selector, configuredClientCount: parsed.clients.length });
  if (!isValidIanaTimeZone(client.timezone)) blocked("LIVE_ACCEPTANCE_BLOCKED_CLIENT_CONFIGURATION", "Configured client timezone is not a valid IANA timezone.", { selector, timezone: client.timezone });
  return client;
}

async function main(): Promise<void> {
  const selector = argument("--client"); if (!selector) throw new Error("Use --client <client-name-or-derived-id>.");
  const requestedSection = argument("--section");
  if (requestedSection !== null && requestedSection !== "deliverability" && !automatedSections.some(({ key }) => key === requestedSection)) throw new Error(`--section must be deliverability or one of: ${automatedSections.map(({ key }) => key).join(", ")}.`);
  // A single automated section still applies and proves the exact period on both pages, but captures only that card.
  const wants = (key: string) => requestedSection === null || requestedSection === key;
  const month = expectedMonth(argument("--month"));
  const clientsFile = resolve(repositoryRoot, process.env.TENTION_LOCAL_CLIENTS_FILE ?? "data/local-clients.json");
  const profileDirectory = resolve(repositoryRoot, process.env.TENTION_KLAVIYO_PROFILE_DIR ?? "data/klaviyo-test-browser-profile");
  const authMarker = join(profileDirectory, ".tention-auth-initialized");
  const outputDirectory = resolve(repositoryRoot, process.env.TENTION_LIVE_ACCEPTANCE_OUTPUT_DIR ?? `output/local-acceptance/${new Date().toISOString().replace(/[:.]/g, "-")}`);
  const client = await loadClient(selector, clientsFile);
  if (!isCompletedMonthAtInstant(month, new Date(), client.timezone)) blocked("LIVE_ACCEPTANCE_BLOCKED_MONTH", "The requested report month is not complete in the configured client timezone.", { month, timezone: client.timezone });
  if (!await exists(profileDirectory)) blocked("LIVE_ACCEPTANCE_BLOCKED_AUTH", "The isolated Klaviyo test profile does not exist. Run npm run klaviyo:test-login.", { profileDirectory });
  await mkdir(outputDirectory, { recursive: true });
  let context;
  try {
    context = await chromium.launchPersistentContext(profileDirectory, { headless: process.env.TENTION_LIVE_HEADED !== "true", viewport: { width: 1440, height: 1000 } });
    const page = context.pages()[0] ?? await context.newPage();
    const runtime = attachBrowserRuntimeDiagnostics(page);
    await page.goto(client.overviewUrl, { waitUntil: "domcontentloaded", timeout: 60_000 });
    const period = getReportPeriod(month);
    const overviewReadiness = await waitForRenderedPage(page);
    const loginLike = /login|sign-in|authenticate/i.test(page.url()) || await page.getByRole("button", { name: /log in|sign in/i }).count() > 0;
    if (loginLike) blocked("LIVE_ACCEPTANCE_BLOCKED_AUTH", "The saved profile is not authenticated for Klaviyo.", { outputDirectory, url: page.url(), authMarkerPresent: await exists(authMarker) });
    // Never capture one client's evidence from another client's active Klaviyo account.
    const accountIdentity = verifyAccountIdentity(await visibleAccountLabels(page), client.name);
    if (!accountIdentity.ok) blocked("LIVE_ACCEPTANCE_BLOCKED_ACCOUNT_MISMATCH", "The active Klaviyo account in the isolated profile is not the configured client. Switch accounts in the profile and rerun.", { outputDirectory, client: deriveClientId(client.name), code: accountIdentity.code, observedLabels: accountIdentity.observedLabels });
    if (requestedSection === "deliverability") {
      if (!client.deliverabilityUrl) blocked("LIVE_ACCEPTANCE_BLOCKED_CLIENT_CONFIGURATION", "The current product requires a configured standalone Deliverability Score URL.", { outputDirectory, client: deriveClientId(client.name) });
      if (!await navigateToDeliverabilityScore(page, client.deliverabilityUrl)) blocked("LIVE_ACCEPTANCE_BLOCKED_PAGE_NOT_READY", "Klaviyo did not navigate to the configured standalone Deliverability Score route.", { outputDirectory, sourceUrl: safeUrl(client.deliverabilityUrl) });
      const deliverabilityCapture = await captureDeliverabilityScore(page, outputDirectory);
      const deliverabilityReadiness = await waitForRenderedPage(page);
      await captureEvidence(page, outputDirectory, "deliverability-score", "klaviyo-deliverability|deliverability-score|email", {}, runtime, deliverabilityReadiness);
      await writeFile(join(outputDirectory, "results.json"), `${JSON.stringify({ status: deliverabilityCapture.ok ? "DELIVERABILITY_SCORE_PASS" : "FAIL", client: { id: deriveClientId(client.name), name: client.name, timezone: client.timezone }, month, period, automatedSections: [{ key: "deliverability", ...deliverabilityCapture }], duplicateHashes: [] }, null, 2)}\n`);
      if (!deliverabilityCapture.ok) blocked("LIVE_ACCEPTANCE_BLOCKED_PAGE_NOT_READY", "The standalone Deliverability Score could not be captured with complete evidence.", { outputDirectory, deliverabilityCapture });
      console.log(JSON.stringify({ status: "DELIVERABILITY_SCORE_PASS", diagnostics: { outputDirectory, client: deriveClientId(client.name), month, capture: deliverabilityCapture } }, null, 2));
      return;
    }
    const overviewTimePeriodReady = await page.getByRole("button", { name: "Time period", exact: true }).waitFor({ state: "visible", timeout: 20_000 }).then(() => true).catch(() => false);
    if (!overviewTimePeriodReady) {
      await captureEvidence(page, outputDirectory, "overview-not-ready", "klaviyo-dashboard", { startDate: period.startDate, endDate: period.endDate }, runtime, overviewReadiness);
      blocked("LIVE_ACCEPTANCE_BLOCKED_PAGE_NOT_READY", "Klaviyo Overview did not expose its Time period control after the bounded render wait.", { outputDirectory, overviewReadiness });
    }
    const overviewCardReady = await waitForRequiredCardContent(page, automatedSections[0]!);
    if (!overviewCardReady) {
      await captureEvidence(page, outputDirectory, "overview-data-not-ready", "klaviyo-dashboard|business-performance-summary", { startDate: period.startDate, endDate: period.endDate }, runtime, overviewReadiness);
      blocked("LIVE_ACCEPTANCE_BLOCKED_PAGE_NOT_READY", "Klaviyo Overview showed a shell or loading state but did not render its business-performance data card; date changes are unsafe until the card is ready.", { outputDirectory, overviewReadiness });
    }
    if (!await openTimePeriodControl(page)) blocked("LIVE_ACCEPTANCE_BLOCKED_DATE_CONTROL", "The Klaviyo Overview Time period control was not uniquely available.", { outputDirectory });
    const overviewDateResult = await setExactDateRange(page, period, join(outputDirectory, "overview-date-picker"));
    const overviewDateReadiness = await waitForRenderedPage(page);
    await captureEvidence(page, outputDirectory, "overview-date-applied", "klaviyo-dashboard|time-period-control", { startDate: period.startDate, endDate: period.endDate }, runtime, overviewDateReadiness);
    if (!overviewDateResult.ok) blocked("LIVE_ACCEPTANCE_BLOCKED_DATE_CONTROL", "Klaviyo Overview did not verify the requested exact calendar-month range.", { outputDirectory, overviewDateResult });
    const overviewCapture = wants("overview") ? await captureAutomatedSection(page, outputDirectory, automatedSections[0]!, { startDate: period.startDate, endDate: period.endDate }) : null;
    // Other Home cards (Top performing flows) share the Home Time period just proven above.
    const homeResults = [];
    for (const section of automatedSections.filter(({ page, key }) => page === "home" && key !== "overview" && wants(key))) {
      homeResults.push({ key: section.key, ...await captureAutomatedSection(page, outputDirectory, section, { startDate: period.startDate, endDate: period.endDate }) });
    }
    if (overviewCapture && !overviewCapture.ok) blocked("LIVE_ACCEPTANCE_BLOCKED_DATE_CONTROL", "Executive Summary could not be captured from the exact verified month.", { outputDirectory, overviewCapture });
    await page.goto(client.businessReviewUrl, { waitUntil: "domcontentloaded", timeout: 60_000 });
    const businessReviewReadiness = await waitForRenderedPage(page);
    const businessTimePeriodReady = await page.getByRole("button", { name: "Time period", exact: true }).waitFor({ state: "visible", timeout: 20_000 }).then(() => true).catch(() => false);
    if (!businessTimePeriodReady) {
      await captureEvidence(page, outputDirectory, "business-review-not-ready", "klaviyo-business-review", { startDate: period.startDate, endDate: period.endDate }, runtime, businessReviewReadiness);
      blocked("LIVE_ACCEPTANCE_BLOCKED_PAGE_NOT_READY", "Klaviyo Business Review did not expose its Time period control after the bounded render wait.", { outputDirectory, businessReviewReadiness });
    }
    if (!overviewReadiness.meaningfulVisibleText || !businessReviewReadiness.meaningfulVisibleText) {
      blocked("LIVE_ACCEPTANCE_BLOCKED_PAGE_NOT_READY", "Klaviyo did not render meaningful visible dashboard content in the isolated acceptance browser. The saved diagnostics include runtime errors, request failures, HTML, screenshots, and region evidence.", { outputDirectory, overviewReadiness, businessReviewReadiness });
    }
    const businessReviewCardReady = await waitForRequiredCardContent(page, automatedSections[1]!);
    if (!businessReviewCardReady) {
      await captureEvidence(page, outputDirectory, "business-review-data-not-ready", "klaviyo-business-review|campaign-performance-summary", { startDate: period.startDate, endDate: period.endDate }, runtime, businessReviewReadiness);
      blocked("LIVE_ACCEPTANCE_BLOCKED_PAGE_NOT_READY", "Klaviyo Business Review showed a shell or loading state but did not render its campaign-performance card; period changes are unsafe until report data is ready.", { outputDirectory, businessReviewReadiness });
    }
    const openedTimePeriod = await openTimePeriodControl(page);
    if (!openedTimePeriod) {
      const dateControlReadiness = await waitForRenderedPage(page);
      const dateControl = await captureEvidence(page, outputDirectory, "business-review-date-control", "klaviyo-business-review|time-period-control", { startDate: period.startDate, endDate: period.endDate }, runtime, dateControlReadiness);
      blocked("LIVE_ACCEPTANCE_BLOCKED_DATE_CONTROL", "The verified Time period control was not uniquely available in Klaviyo. Evidence was saved; the runner will not capture an unverified period.", { outputDirectory, client: { id: deriveClientId(client.name), name: client.name, timezone: client.timezone }, month, period, detectedControls: dateControl.controls });
    }
    const dateResult = await setExactDateRange(page, period, join(outputDirectory, "business-review-date-picker"), { startDate: period.previousStartDate, endDate: period.previousEndDate });
    const postDateReadiness = await waitForRenderedPage(page);
    await captureEvidence(page, outputDirectory, "business-review-date-applied", "klaviyo-business-review|time-period-control", { startDate: period.startDate, endDate: period.endDate }, runtime, postDateReadiness);
    if (!dateResult.ok) blocked("LIVE_ACCEPTANCE_BLOCKED_DATE_CONTROL", "Klaviyo did not verify the requested exact calendar-month range. Evidence was saved; the runner will not capture an unverified period.", { outputDirectory, client: { id: deriveClientId(client.name), name: client.name, timezone: client.timezone }, month, period, dateResult });
    const sectionResults: Array<{ key: string; ok: boolean; sha256?: string; byteSize?: number; usableRowCount?: number; includedRowCount?: number; error?: string }> = [...(overviewCapture ? [{ key: "overview", ...overviewCapture }] : []), ...homeResults];
    for (const section of automatedSections.filter(({ page, key }) => page === "business-review" && wants(key))) {
      const expectedCapturePeriod = section.key === "month_comparison"
        ? { startDate: period.startDate, endDate: period.endDate, comparisonStartDate: period.previousStartDate, comparisonEndDate: period.previousEndDate }
        : { startDate: period.startDate, endDate: period.endDate };
      sectionResults.push({ key: section.key, ...await captureAutomatedSection(page, outputDirectory, section, expectedCapturePeriod) });
    }
    if (requestedSection === null) {
      if (!client.deliverabilityUrl) blocked("LIVE_ACCEPTANCE_BLOCKED_CLIENT_CONFIGURATION", "The current product requires a configured standalone Deliverability Score URL.", { outputDirectory, client: deriveClientId(client.name) });
      if (!await navigateToDeliverabilityScore(page, client.deliverabilityUrl)) blocked("LIVE_ACCEPTANCE_BLOCKED_PAGE_NOT_READY", "Klaviyo did not navigate to the configured standalone Deliverability Score route.", { outputDirectory, sourceUrl: safeUrl(client.deliverabilityUrl) });
      await waitForRenderedPage(page);
      const deliverabilityCapture = await captureDeliverabilityScore(page, outputDirectory);
      sectionResults.push({ key: "deliverability", ...deliverabilityCapture });
    }
    const failures = sectionResults.filter((result) => !result.ok);
    const hashes = sectionResults.filter((result): result is typeof result & { sha256: string } => result.ok && typeof result.sha256 === "string").map((result) => result.sha256);
    const duplicateHashes = hashes.filter((hash, index) => hashes.indexOf(hash) !== index);
    const pendingSections = targetPreflight(client, period);
    await writeFile(join(outputDirectory, "results.json"), `${JSON.stringify({ status: failures.length || duplicateHashes.length ? "FAIL" : requestedSection ? "SINGLE_SECTION_PASS" : "PARTIAL_PASS_MANUAL_EVIDENCE_REQUIRED", requestedSection, client: { id: deriveClientId(client.name), name: client.name, timezone: client.timezone }, month, period, automatedSections: sectionResults, pendingSections, duplicateHashes }, null, 2)}\n`);
    if (failures.length || duplicateHashes.length) blocked("LIVE_ACCEPTANCE_BLOCKED_DATE_CONTROL", "One or more supported live captures did not pass semantic verification. Failure diagnostics were saved.", { outputDirectory, failures, duplicateHashes });
    const pendingHtml = pendingSections.map((section) => `<li><strong>${htmlEscape(section.title)}</strong> — ${htmlEscape(section.status)}${section.prerequisites.length ? `; missing: ${htmlEscape(section.prerequisites.join(", "))}` : ""}. ${htmlEscape(section.reason)}</li>`).join("");
    await writeFile(join(outputDirectory, "acceptance-report.html"), `<!doctype html><meta charset="utf-8"><title>Tention local acceptance</title><h1>PARTIAL PASS: supported automatic captures</h1><p>${htmlEscape(client.name)} — ${htmlEscape(formatRenderedRange(period))}</p><h2>Automated sections</h2><ul>${sectionResults.map((result) => `<li>${htmlEscape(result.key)}: PASS</li>`).join("")}</ul><h2>Evidence still required</h2><ul>${pendingHtml}</ul><p>PDF generation is intentionally blocked until required manual/deferred evidence is approved; no client-facing PDF was fabricated.</p><p>See <a href="results.json">results.json</a> and the section diagnostics in this directory.</p>`);
    console.log(JSON.stringify({ status: "LIVE_ACCEPTANCE_PARTIAL_PASS_MANUAL_EVIDENCE_REQUIRED", message: "All supported automatic captures passed. PDF generation remains correctly blocked until required manual/deferred evidence is approved.", diagnostics: { outputDirectory, client: { id: deriveClientId(client.name), name: client.name, timezone: client.timezone }, month, period, sectionResults } }, null, 2));
    return;
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("LIVE_ACCEPTANCE_BLOCKED_")) return;
    blocked("LIVE_ACCEPTANCE_BLOCKED_BROWSER", "The isolated browser could not complete the configured navigation. See any diagnostics already written.", { outputDirectory, error: error instanceof Error ? error.message : "unknown" });
  } finally { await context?.close(); }
}

void main().catch((error: unknown) => { if (process.exitCode !== 2) { console.error(error); process.exitCode = 1; } });
