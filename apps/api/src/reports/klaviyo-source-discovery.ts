import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type Page } from "playwright";
import { getReportPeriod } from "@tention/report-core";
import { classifySourceDiscovery } from "./source-discovery-status.js";

const root = resolve(fileURLToPath(new URL("../../../../", import.meta.url)));
const targets = [
  { key: "signup_forms", label: "Sign-up forms", parent: "Website" },
  { key: "welcome_flow", label: "Flows", parent: null },
  { key: "customer_split", label: "Lists & segments", parent: "Audience" },
] as const;
function safeHtml(html: string): string {
  return html.replace(/<(script|noscript|iframe|style)\b[^>]*>[\s\S]*?<\/\1>/gi, "")
    .replace(/\s(?:value|content|data-[\w-]*(?:token|secret|key)|(?:authorization|cookie|token|secret|password|api[-_]?key))[^=\s]*=(['"]).*?\1/gi, "")
    .replace(/([?&](?:token|access_token|id_token|secret|key|authorization|cookie|password|api[-_]?key)=)[^&'"#\s]*/gi, "$1[REDACTED]")
    .replace(/(bearer\s+)[a-z0-9._~+\/-]+/gi, "$1[REDACTED]");
}
function safeUrl(value: string): string {
  try { const url = new URL(value); return `${url.origin}${url.pathname}`; } catch { return "invalid-url"; }
}
function isAllowedListingOrReportingUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.origin === "https://www.klaviyo.com" && /^\/(?:forms|flows|lists|analytics\/deliverability)\/?$/.test(url.pathname);
  } catch { return false; }
}
async function waitForPage(page: Page): Promise<void> {
  await page.waitForFunction("() => { if (!document.body || document.body.innerText.replace(/\\s+/g, ' ').trim().length < 250) return false; let cards = 0; for (const node of document.querySelectorAll('h2,h3,[role=heading]')) { const rect = node.getBoundingClientRect(); if (rect.width > 0 && rect.height > 0 && getComputedStyle(node).visibility !== 'hidden') cards++; } return cards >= 2; }", undefined, { timeout: 30_000 }).catch(() => undefined);
  await page.waitForTimeout(1_000);
}
async function waitForSourceContent(page: Page): Promise<boolean> {
  return page.waitForFunction("() => { const main = document.querySelector('#app-shell-main'); if (!main || main.innerText.replace(/\\s+/g, ' ').trim().length < 100) return false; for (const node of main.querySelectorAll('h1,h2,h3,h4,[role=heading]')) { const rect = node.getBoundingClientRect(); if (rect.width > 0 && rect.height > 0 && getComputedStyle(node).visibility !== 'hidden') return true; } return false; }", undefined, { timeout: 25_000 }).then(() => true).catch(() => false);
}
async function saveBaseEvidence(page: Page, outputDir: string): Promise<void> {
  const snapshot = await page.evaluate("(() => ({ url: location.href, title: document.title, text: document.body.innerText.replace(/\\s+/g, ' ').trim().slice(0, 10000), html: document.documentElement.outerHTML }))()") as { url: string; title: string; text: string; html: string };
  await page.screenshot({ path: join(outputDir, "business-review-nav-viewport.png"), fullPage: false });
  await page.screenshot({ path: join(outputDir, "business-review-nav-full-page.png"), fullPage: true });
  await writeFile(join(outputDir, "business-review-nav-page.html"), safeHtml(snapshot.html));
  await writeFile(join(outputDir, "business-review-nav-diagnostics.json"), `${JSON.stringify({ url: safeUrl(snapshot.url), title: snapshot.title, visibleText: snapshot.text }, null, 2)}\n`);
}
function dateControlValue(iso: string): string {
  return new Intl.DateTimeFormat("en-US", { timeZone: "UTC", month: "short", day: "2-digit", year: "numeric" }).format(new Date(`${iso}T00:00:00Z`));
}
function parseRequestedMonth(): { year: number; month: number } | null {
  const index = process.argv.indexOf("--month");
  const value = index >= 0 ? process.argv[index + 1] : null;
  const match = /^(\d{4})-(\d{2})$/.exec(value ?? "");
  return match && Number(match[2]) >= 1 && Number(match[2]) <= 12 ? { year: Number(match[1]), month: Number(match[2]) } : null;
}
async function inspectComparisonPicker(page: Page, outputDir: string, applyCustomDates: boolean): Promise<Record<string, unknown>> {
  const save = async (result: Record<string, unknown>) => { await writeFile(join(outputDir, "month-comparison-picker-diagnostics.json"), `${JSON.stringify(result, null, 2)}\n`); return result; };
  const timePeriod = page.getByRole("button", { name: "Time period", exact: true });
  if (await timePeriod.count() !== 1 || !await timePeriod.isVisible()) return save({ status: "TIME_PERIOD_CONTROL_NOT_READY" });
  await timePeriod.click();
  const comparison = page.getByTestId("time-period-popover-comparison-period-button");
  if (await comparison.count() !== 1) return save({ status: "COMPARISON_CONTROL_NOT_FOUND" });
  await comparison.click();
  await page.waitForTimeout(250);
  const evidence = await page.evaluate("(() => { const root = document.querySelector('#ascent-popover-portal'); const labels = []; for (const node of (root || document).querySelectorAll('[role=option],[role=menuitem],button,[role=button]')) { const rect = node.getBoundingClientRect(); if (rect.width > 0 && rect.height > 0) { const text = (node.textContent || '').replace(/\\s+/g, ' ').trim(); if (text && labels.length < 80) labels.push({ role: node.getAttribute('role'), label: text, selected: node.getAttribute('aria-selected') }); } } return { text: (root?.innerText || '').replace(/\\s+/g, ' ').trim(), html: root?.outerHTML || '', options: labels }; })()") as { text: string; html: string; options: Array<{ role: string | null; label: string; selected: string | null }> };
  await page.screenshot({ path: join(outputDir, "month-comparison-picker-viewport.png"), fullPage: false });
  await writeFile(join(outputDir, "month-comparison-picker.html"), safeHtml(evidence.html));
  let customDateControls: { controls: Array<{ id: string; placeholder: string; value: string; ariaLabel: string | null }>; text: string } | null = null;
  const customOption = page.getByRole("option", { name: "Custom", exact: true });
  if (await customOption.count() === 1) {
    await customOption.click();
    await page.waitForTimeout(250);
    const customEvidence = await page.evaluate("(() => { const controls = []; for (const node of document.querySelectorAll('input')) { const rect = node.getBoundingClientRect(); const style = getComputedStyle(node); const id = node.id || ''; const placeholder = node.getAttribute('placeholder') || ''; if (rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && /date/i.test(id + ' ' + placeholder)) controls.push({ id, placeholder, value: node.value, ariaLabel: node.getAttribute('aria-label') }); } const portal = document.querySelector('#ascent-date-picker-portal'); return { controls, text: (portal?.innerText || '').replace(/\\s+/g, ' ').trim(), html: portal?.outerHTML || '' }; })()") as { controls: Array<{ id: string; placeholder: string; value: string; ariaLabel: string | null }>; text: string; html: string };
    await page.screenshot({ path: join(outputDir, "month-comparison-custom-period-viewport.png"), fullPage: false });
    await writeFile(join(outputDir, "month-comparison-custom-period.html"), safeHtml(customEvidence.html));
    customDateControls = { controls: customEvidence.controls, text: customEvidence.text };
    if (applyCustomDates) {
      const reportMonth = parseRequestedMonth();
      if (!reportMonth) return save({ status: "APPLY_PROBE_REQUIRES_MONTH", optionsText: evidence.text, customDateControls });
      const period = getReportPeriod(reportMonth);
      const starts = page.locator("#DateRangePicker-StartDate:visible");
      const ends = page.locator("#DateRangePicker-EndDate:visible");
      if (await starts.count() !== 2 || await ends.count() !== 2) return save({ status: "COMPARISON_DATE_CONTROLS_AMBIGUOUS", startCount: await starts.count(), endCount: await ends.count(), customDateControls });
      await starts.nth(0).fill(dateControlValue(period.startDate)); await starts.nth(0).press("Tab");
      await ends.nth(0).fill(dateControlValue(period.endDate)); await ends.nth(0).press("Tab");
      await starts.nth(1).fill(dateControlValue(period.previousStartDate)); await starts.nth(1).press("Tab");
      await ends.nth(1).fill(dateControlValue(period.previousEndDate)); await ends.nth(1).press("Tab");
      const inputValuesBeforeApply = { currentStart: await starts.nth(0).inputValue(), currentEnd: await ends.nth(0).inputValue(), previousStart: await starts.nth(1).inputValue(), previousEnd: await ends.nth(1).inputValue() };
      const apply = page.getByRole("button", { name: "Apply", exact: true });
      if (await apply.count() !== 1) return save({ status: "COMPARISON_APPLY_CONTROL_NOT_FOUND", inputValuesBeforeApply, customDateControls });
      await page.screenshot({ path: join(outputDir, "month-comparison-dates-before-apply.png"), fullPage: false });
      await apply.click();
      await page.waitForTimeout(1_000);
      const rendered = await page.evaluate("(() => { const lines = document.body.innerText.split(/\\n+/).map((line) => line.replace(/\\s+/g, ' ').trim()).filter((line) => line && /compared|previous period/i.test(line)); return { text: document.body.innerText.replace(/\\s+/g, ' ').trim().slice(0, 8000), periodLines: lines.slice(0, 30), html: document.documentElement.outerHTML }; })()") as { text: string; periodLines: string[]; html: string };
      await page.screenshot({ path: join(outputDir, "month-comparison-after-apply-viewport.png"), fullPage: false });
      await page.screenshot({ path: join(outputDir, "month-comparison-after-apply-full-page.png"), fullPage: true });
      await writeFile(join(outputDir, "month-comparison-after-apply-page.html"), safeHtml(rendered.html));
      const expectedCurrentStart = new Intl.DateTimeFormat("en-US", { timeZone: "UTC", month: "short", day: "numeric", year: "numeric" }).format(new Date(`${period.startDate}T00:00:00Z`));
      const expectedCurrentEnd = new Intl.DateTimeFormat("en-US", { timeZone: "UTC", month: "short", day: "numeric", year: "numeric" }).format(new Date(`${period.endDate}T00:00:00Z`));
      const expectedPreviousStart = new Intl.DateTimeFormat("en-US", { timeZone: "UTC", month: "short", day: "numeric", year: "numeric" }).format(new Date(`${period.previousStartDate}T00:00:00Z`));
      const expectedPreviousEnd = new Intl.DateTimeFormat("en-US", { timeZone: "UTC", month: "short", day: "numeric", year: "numeric" }).format(new Date(`${period.previousEndDate}T00:00:00Z`));
      const exactRenderedProof = rendered.periodLines.some((line) => [expectedCurrentStart, expectedCurrentEnd, expectedPreviousStart, expectedPreviousEnd].every((date) => line.includes(date)));
      const result = { status: exactRenderedProof ? "EXACT_COMPARISON_PERIOD_RENDERED" : "EXACT_COMPARISON_PERIOD_NOT_RENDERED", expected: { currentStart: period.startDate, currentEnd: period.endDate, previousStart: period.previousStartDate, previousEnd: period.previousEndDate }, inputValuesBeforeApply, renderedPeriodLines: rendered.periodLines, periodProof: exactRenderedProof };
      return save(result);
    }
  }
  const result = { status: "INSPECTED", optionsText: evidence.text, options: evidence.options, customDateControls };
  await save(result);
  await page.getByRole("button", { name: "Cancel", exact: true }).click().catch(() => undefined);
  return result;
}
async function main(): Promise<void> {
  const inspectTargets = process.argv.includes("--comparison-only") ? [] : targets;
  const configPath = resolve(root, process.env.TENTION_LOCAL_CLIENTS_FILE ?? "data/local-clients.json");
  const parsed = JSON.parse(await readFile(configPath, "utf8")) as { clients?: Array<{ name?: string; businessReviewUrl?: string; signupFormsUrl?: string; flowsUrl?: string; segmentsUrl?: string; deliverabilityUrl?: string }> };
  const client = parsed.clients?.find(({ name }) => name?.toLowerCase() === "autoledtech.com");
  if (!client?.businessReviewUrl) throw new Error("AutoLEDTech Business Review URL is not configured locally.");
  const outputDir = resolve(root, `output/source-discovery/${new Date().toISOString().replace(/[:.]/g, "-")}`);
  const profileDir = resolve(root, process.env.TENTION_KLAVIYO_PROFILE_DIR ?? "data/klaviyo-test-browser-profile");
  await mkdir(outputDir, { recursive: true });
  const context = await chromium.launchPersistentContext(profileDir, { headless: process.env.TENTION_LIVE_HEADED !== "true", viewport: { width: 1440, height: 1000 } });
  const findings: Array<Record<string, unknown>> = [];
  const createRuntime = () => ({ pageErrors: [] as string[], failedRequests: [] as Array<{ url: string; error: string }>, failedResponses: [] as Array<{ url: string; status: number }> });
  let runtime = createRuntime();
  try {
    const page = context.pages()[0] ?? await context.newPage();
    page.on("pageerror", (error) => { if (runtime.pageErrors.length < 40) runtime.pageErrors.push(error.message.replace(/\s+/g, " ").slice(0, 500)); });
    page.on("requestfailed", (request) => { if (runtime.failedRequests.length < 60) runtime.failedRequests.push({ url: safeUrl(request.url()), error: request.failure()?.errorText ?? "request failed" }); });
    page.on("response", (response) => { if (response.status() >= 400 && runtime.failedResponses.length < 60) runtime.failedResponses.push({ url: safeUrl(response.url()), status: response.status() }); });
    await page.goto(client.businessReviewUrl, { waitUntil: "domcontentloaded", timeout: 60_000 });
    await waitForPage(page);
    await page.getByRole("button", { name: "Time period", exact: true }).waitFor({ state: "visible", timeout: 20_000 }).catch(() => undefined);
    await saveBaseEvidence(page, outputDir);
    const monthComparisonPicker = await inspectComparisonPicker(page, outputDir, process.argv.includes("--apply-comparison"));
    const configuredSources: Record<string, string | undefined> = {
      signup_forms: client.signupFormsUrl,
      welcome_flow: client.flowsUrl,
      customer_split: client.segmentsUrl,
    };
    for (const target of inspectTargets) {
      const sourceUrl = configuredSources[target.key];
      if (!sourceUrl) {
        findings.push({ key: target.key, status: "SOURCE_URL_NOT_CONFIGURED" });
        continue;
      }
      if (!isAllowedListingOrReportingUrl(sourceUrl)) {
        findings.push({ key: target.key, status: "SOURCE_NOT_ALLOWED_FOR_READ_ONLY_DISCOVERY", sourceUrl: safeUrl(sourceUrl) });
        continue;
      }
      const expectedPath = new URL(sourceUrl).pathname;
      runtime = createRuntime();
      await page.goto(sourceUrl, { waitUntil: "domcontentloaded", timeout: 60_000 });
      await page.waitForFunction("(path) => location.pathname === path", expectedPath, { timeout: 30_000 }).catch(() => undefined);
      await waitForPage(page);
      let sourceContentReady = await waitForSourceContent(page);
      let sourceRetryCount = 0;
      const initialVisibleText = await page.locator("body").innerText().catch(() => "");
      if (target.key !== "signup_forms" && (initialVisibleText.trim().length < 250 || /no data available[\s\S]*refresh the page/i.test(initialVisibleText))) {
        runtime = createRuntime();
        sourceRetryCount = 1;
        await page.reload({ waitUntil: "domcontentloaded", timeout: 60_000 });
        await waitForPage(page);
        sourceContentReady = await waitForSourceContent(page);
      }
      const evidence = await page.evaluate("(() => { function isVisible(element) { const rect = element.getBoundingClientRect(); const style = getComputedStyle(element); return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden'; } const headings = []; for (const node of document.querySelectorAll('h1,h2,h3,h4,h5,h6,[role=heading]')) if (isVisible(node)) { const text = (node.textContent || '').replace(/\\s+/g, ' ').trim(); if (text && headings.length < 100) headings.push(text); } const controls = []; for (const node of document.querySelectorAll('button,[role=button],[role=tab],input,select')) if (isVisible(node)) { const label = ((node.getAttribute('aria-label') || node.textContent || node.placeholder || '').replace(/\\s+/g, ' ').trim()).slice(0, 120); if (label && controls.length < 160) controls.push({ role: node.getAttribute('role'), label, testId: node.getAttribute('data-testid') }); } const tableHeaders = []; for (const node of document.querySelectorAll('th,[role=columnheader]')) if (isVisible(node)) { const text = (node.textContent || '').replace(/\\s+/g, ' ').trim(); if (text && tableHeaders.length < 100) tableHeaders.push(text); } let rowCount = 0; for (const node of document.querySelectorAll('tbody tr,[role=row]')) if (isVisible(node) && (node.textContent || '').trim().length > 0) rowCount++; const entityLinks = []; for (const node of document.querySelectorAll('a[href]')) if (isVisible(node)) { const anchor = node; const url = new URL(anchor.href); const label = (node.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 140); const href = url.origin + url.pathname; if ((label || /\\/flows|\\/forms|\\/lists|\\/segments/.test(href)) && entityLinks.length < 200) entityLinks.push({ label, href }); } const dateEvidence = []; for (const line of document.body.innerText.split(/\\n+/)) { const text = line.replace(/\\s+/g, ' ').trim(); if (/\\b(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\\s+\\d{1,2},?\\s+\\d{4}\\b|time period|previous period/i.test(text) && dateEvidence.length < 40) dateEvidence.push(text); } const main = document.querySelector('#app-shell-main'); const mainText = (main?.innerText || '').replace(/\\s+/g, ' ').trim().slice(0, 12000); const mainHeadings = []; if (main) for (const node of main.querySelectorAll('h1,h2,h3,h4,[role=heading]')) if (isVisible(node)) { const text = (node.textContent || '').replace(/\\s+/g, ' ').trim(); if (text) mainHeadings.push(text); } return { url: location.href, title: document.title, headings, mainHeadings, mainText, controls, tableHeaders, rowCount, entityLinks, dateEvidence, bodyText: document.body.innerText.replace(/\\s+/g, ' ').trim().slice(0, 12000), html: document.documentElement.outerHTML }; })()") as { url: string; title: string; headings: string[]; mainHeadings: string[]; mainText: string; controls: Array<{ role: string | null; label: string; testId: string | null }>; tableHeaders: string[]; rowCount: number; entityLinks: Array<{ label: string; href: string }>; dateEvidence: string[]; bodyText: string; html: string };
      const stage = join(outputDir, target.key);
      await page.screenshot({ path: `${stage}-viewport.png`, fullPage: false });
      await page.screenshot({ path: `${stage}-full-page.png`, fullPage: true });
      await writeFile(`${stage}-page.html`, safeHtml(evidence.html));
      const { html, ...summary } = evidence;
      const loginRequired = /log in|sign in|authenticate/i.test(`${evidence.title} ${evidence.bodyText}`);
      const classification = classifySourceDiscovery({
        source: target.key,
        authenticationRequired: loginRequired,
        mainText: evidence.mainText,
        tableHeaders: evidence.tableHeaders,
        rowCount: evidence.rowCount,
      });
      const finding = {
        key: target.key,
        status: classification.status,
        reason: classification.reason,
        sourceRetryCount,
        sourceContentReady,
        sourceUrl: safeUrl(sourceUrl),
        ...summary,
        runtime: { ...runtime, pageErrors: [...runtime.pageErrors], failedRequests: [...runtime.failedRequests], failedResponses: [...runtime.failedResponses] },
      };
      await writeFile(`${stage}-diagnostics.json`, `${JSON.stringify(finding, null, 2)}\n`);
      findings.push(finding);
    }
  } finally { await context.close(); }
  const monthComparisonPicker = JSON.parse(await readFile(join(outputDir, "month-comparison-picker-diagnostics.json"), "utf8")) as Record<string, unknown>;
  const result = { client: client.name, inspectedAt: new Date().toISOString(), outputDir, monthComparisonPicker, sources: findings };
  await writeFile(join(outputDir, "source-discovery.json"), `${JSON.stringify(result, null, 2)}\n`);
  console.log(JSON.stringify(result, null, 2));
}
main().catch((error: unknown) => { console.error(error instanceof Error ? error.message : "Source discovery failed."); process.exitCode = 1; });
