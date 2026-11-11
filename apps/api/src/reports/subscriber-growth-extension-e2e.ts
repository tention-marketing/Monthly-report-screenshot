/**
 * Section 10 extension E2E: the real built MV3 extension in Playwright's Chromium, its real service worker, side panel,
 * chrome.storage.session and toolbar handler, against a simulated Klaviyo Subscriber growth page and an in-process test
 * API (in-memory stores in a temporary root). The developer's local API, database and Klaviyo are never touched.
 *
 * Scenario: an August report whose nine sections are already captured gains Section 10; the session is pre-filled with
 * screenshot-bearing capture states as older builds left it; the toolbar is clicked on Subscriber growth (Overview ·
 * Last 7 days); the source must be saved automatically; Resume must run only Section 10; the report must end 10/10
 * with the nine original hashes intact; the development review PDF must open and download.
 *
 * Test-only scaffolding, stated in the results: Chrome grants activeTab only to a real toolbar gesture, so this run
 * loads a temporary copy of the built extension whose manifest adds "<all_urls>" for captureVisibleTab. The shipped
 * manifest is unchanged; the toolbar handler itself is driven through Chrome's own chrome.action.onClicked event.
 */
import { createHash, randomUUID } from "node:crypto";
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { deflateSync } from "node:zlib";
import { chromium, type BrowserContext, type Worker } from "playwright";
import { createReportDraft, deriveClientId, enableEmailSubscriberGrowth, InMemoryClientReportTargetsRepository, InMemoryReportDraftRepository } from "@tention/report-domain";
import { getReportPeriod } from "@tention/report-core";
import { createScreenshotSourceProof, REPORT_CAPTURE_SPEC_V1, screenshotSectionMapping, type ScreenshotType } from "@tention/report-schema";
import { buildApp } from "../app.js";
import { InMemoryScreenshotStorage } from "../storage/screenshot-storage.js";
import { importCompletedAutomaticCaptureRun, AUTOMATIC_RUN_CAPTURE_TYPES } from "./import-automatic-capture-run.js";
import { extensionE2eIgnoreDefaultArgs, extensionE2eLaunchArgs } from "./extension-e2e-browser.js";
import { subscriberGrowthE2ePage } from "./subscriber-growth-e2e-page.js";

/** The extension APIs exist only inside the browser contexts these callbacks run in. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
declare const chrome: any;
declare namespace chrome { namespace tabs { type Tab = unknown } }

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
const CLIENT = "Northwind Goods";
const CLIENT_ID = deriveClientId(CLIENT);
/** `--month 2026-09` runs the same scenario for another completed month; nothing below is month-specific. */
const monthArgument = process.argv[process.argv.indexOf("--month") + 1];
const MONTH = /^\d{4}-\d{2}$/.test(monthArgument ?? "") ? { year: Number(monthArgument!.slice(0, 4)), month: Number(monthArgument!.slice(5, 7)) } : { year: 2026, month: 8 };
const PERIOD = getReportPeriod(MONTH);
const results: Array<{ step: string; status: "PASS" | "FAIL"; detail?: unknown }> = [];
const record = (step: string, ok: boolean, detail?: unknown) => { results.push({ step, status: ok ? "PASS" : "FAIL", ...(detail === undefined ? {} : { detail }) }); console.log(`${ok ? "PASS" : "FAIL"}  ${step}${detail === undefined ? "" : `  ${JSON.stringify(detail).slice(0, 400)}`}`); };

/** A real, distinct PNG (solid colour) for each seeded capture. */
function png(seed: number, width = 320, height = 200): Buffer {
  const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = (bytes: Buffer) => { let c = 0xffffffff; for (const byte of bytes) c = crcTable[(c ^ byte) & 0xff]! ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type: string, data: Buffer) => { const out = Buffer.alloc(12 + data.length); out.writeUInt32BE(data.length, 0); out.write(type, 4, "ascii"); data.copy(out, 8); out.writeUInt32BE(crc(out.subarray(4, 8 + data.length)), 8 + data.length); return out; };
  const header = Buffer.alloc(13); header.writeUInt32BE(width, 0); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 2;
  const row = Buffer.concat([Buffer.from([0]), Buffer.from(Array.from({ length: width }, () => [seed * 23 % 256, seed * 71 % 256, 180]).flat())]);
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", header), chunk("IDAT", deflateSync(Buffer.concat(Array.from({ length: height }, () => row)))), chunk("IEND", Buffer.alloc(0))]);
}

/** Seeds sections 1–9 exactly as an earlier automatic run would have imported them. */
async function seedNineCapturedSections(root: string, repository: InMemoryReportDraftRepository, screenshotStorage: InMemoryScreenshotStorage, reportId: string) {
  const runId = randomUUID(); const directory = join(root, "output/extension-automatic-acceptance", runId);
  await mkdir(join(directory, "sections"), { recursive: true });
  const period = getReportPeriod(MONTH);
  const sections = [];
  for (const [index, type] of AUTOMATIC_RUN_CAPTURE_TYPES.entries()) {
    const bytes = png(index + 1); const sha256 = createHash("sha256").update(bytes).digest("hex"); const file = `sections/${type}-attempt-1-capture.png`;
    await writeFile(join(directory, file), bytes);
    const spec = REPORT_CAPTURE_SPEC_V1.find((entry) => entry.screenshotType === type)!;
    const observedUrl = type === "top_campaigns" ? "https://www.klaviyo.com/omnicampaigns" : spec.sourceUrlKey === "overviewUrl" ? "https://www.klaviyo.com/dashboard" : type === "deliverability" ? "https://www.klaviyo.com/analytics/deliverability/email/score" : "https://www.klaviyo.com/analytics/dashboards/E2EBUSINESSREVIEW";
    const sourceProof = createScreenshotSourceProof(type, period, undefined, type === "top_campaigns" ? { accountIdentity: CLIENT, clientTimezone: "America/New_York", visibleMetricLabel: "Placed Order", rankingMethod: "complete-result-set", eligibleRowCount: 1, includedRowCount: 1, rows: [{ name: "Campaign", type: "Email", status: "Sent", sendDate: "2026-08-03", openRate: "10%", clickRate: "1%", placedOrderValue: 10 }] } : null);
    sections.push({ section: type, status: "pass", attemptNumber: 1, startedAt: "2026-10-28T08:00:00.000Z", finishedAt: "2026-10-28T08:00:01.000Z", durationMs: 1000, expectedUrl: observedUrl, observedUrl, expectedSourceIdentity: spec.sourceIdentity, observedSourceIdentity: spec.sourceIdentity,
      expectedPeriod: type === "deliverability" ? null : type === "month_comparison" ? { startDate: period.startDate, endDate: period.endDate, comparisonStartDate: period.previousStartDate, comparisonEndDate: period.previousEndDate } : { startDate: period.startDate, endDate: period.endDate },
      usableRowCount: type === "top_campaigns" ? 1 : type === "top_flows" ? 5 : null, screenshotResult: "fresh_semantic_crop_saved", sourceProofResult: "PASS", sha256,
      diagnostics: { sourceProof, targetBounds: { includedRowCount: type === "top_campaigns" ? 1 : type === "top_flows" ? 5 : undefined }, observedPeriodProof: type === "deliverability" ? null : { startDate: period.startDate, endDate: period.endDate, ...(type === "month_comparison" ? { comparisonStartDate: period.previousStartDate, comparisonEndDate: period.previousEndDate } : {}) } },
      evidenceByAttempt: [{ attemptNumber: 1, kind: "capture", file, byteSize: bytes.length, width: 320, height: 200, sha256 }] });
  }
  await writeFile(join(directory, "results.json"), JSON.stringify({ kind: "tention_local_automatic_capture", runId, reportId, clientId: CLIENT_ID, clientName: CLIENT, timezone: "America/New_York", reportMonth: MONTH, period, status: "completed", sections }));
  await importCompletedAutomaticCaptureRun({ repository, screenshotStorage, repositoryRoot: root, runId, now: () => new Date() });
}

async function main(): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "tention-sg-e2e-"));
  const outputDirectory = join(repositoryRoot, "output/subscriber-growth-e2e", new Date().toISOString().replace(/[:.]/g, "-"));
  await mkdir(outputDirectory, { recursive: true });
  const repository = new InMemoryReportDraftRepository(); const targets = new InMemoryClientReportTargetsRepository(); const screenshotStorage = new InMemoryScreenshotStorage();
  await targets.save(CLIENT_ID, { profile: { name: CLIENT, timezone: "America/New_York", currency: null, conversionMetric: { label: "Placed Order", providerMetricId: null }, sections: null }, businessReview: { dashboardUrl: "https://www.klaviyo.com/analytics/dashboards/E2EBUSINESSREVIEW", displayName: "Business Review", accountLabel: CLIENT } } as never, new Date());
  const nineSections = Object.fromEntries(REPORT_CAPTURE_SPEC_V1.filter(({ reportOptIn, automationStatus }) => !reportOptIn && automationStatus === "auto").map(({ screenshotType }) => [screenshotSectionMapping[screenshotType], "required" as const]));
  let report = createReportDraft({ client: { id: CLIENT_ID, name: CLIENT, timezone: "America/New_York", currency: null }, reportMonth: MONTH, sections: nineSections }, { now: new Date() });
  await repository.create(report);
  await seedNineCapturedSections(root, repository, screenshotStorage, report.id);
  report = (await repository.getById(report.id))!;
  const nineHashes = Object.fromEntries(report.screenshots.map((shot) => [shot.type, { id: shot.id, sha256: shot.sha256 }]));
  record("Seeded August report with sections 1–9 captured", report.screenshots.length === 9, { screenshots: report.screenshots.length });
  report = await repository.save(enableEmailSubscriberGrowth(report, { now: new Date() }), report.version);
  record("Section 10 enabled on the existing report", report.sections.email_subscriber_growth === "required");

  const app = buildApp({ requireClientSetupReady: false, repository, clientReportTargetsRepository: targets, screenshotStorage, enableLocalDevelopmentImports: true, localImportRequiresPersistentStorage: true, repositoryRoot: root });
  const apiAddress = await app.listen({ host: "127.0.0.1", port: 0 });

  // Test-only manifest copy: "<all_urls>" lets captureVisibleTab run without a real toolbar gesture.
  const extensionDirectory = join(root, "extension");
  cpSync(resolve(repositoryRoot, "apps/extension/dist"), extensionDirectory, { recursive: true });
  const manifest = JSON.parse(readFileSync(join(extensionDirectory, "manifest.json"), "utf8"));
  manifest.host_permissions = [...manifest.host_permissions, "<all_urls>"];
  writeFileSync(join(extensionDirectory, "manifest.json"), JSON.stringify(manifest));

  const errors: string[] = [];
  let context: BrowserContext | undefined;
  try {
    context = await chromium.launchPersistentContext(join(root, "profile"), { headless: false, viewport: { width: 1280, height: 1000 }, acceptDownloads: true, ignoreDefaultArgs: [...extensionE2eIgnoreDefaultArgs], args: extensionE2eLaunchArgs(extensionDirectory) });
    await context.route("https://www.klaviyo.com/**", (route) => new URL(route.request().url()).pathname === "/people/subscribers"
      ? route.fulfill({ contentType: "text/html", body: subscriberGrowthE2ePage(CLIENT) })
      : route.fulfill({ contentType: "text/html", body: "<html><body><h1>Klaviyo</h1></body></html>" }));
    await context.route("http://127.0.0.1:4000/**", async (route) => { const target = route.request().url().replace("http://127.0.0.1:4000", apiAddress); route.fulfill({ response: await route.fetch({ url: target }) }); });
    const worker: Worker = context.serviceWorkers().find((item) => item.url().startsWith("chrome-extension://")) ?? await context.waitForEvent("serviceworker");
    // tsx/esbuild wraps named functions in a `__name` helper that browser contexts do not have.
    await worker.evaluate("globalThis.__name = (fn) => fn");
    worker.on("console", (message) => { if (message.type() === "error") errors.push(`worker console: ${message.text()}`.slice(0, 300)); });
    await worker.evaluate(() => {
      const box = globalThis as typeof globalThis & { __tentionErrors?: string[] };
      box.__tentionErrors = [];
      self.addEventListener("unhandledrejection", (event) => box.__tentionErrors!.push(`unhandledrejection: ${String((event as PromiseRejectionEvent).reason)}`.slice(0, 300)));
      self.addEventListener("error", (event) => box.__tentionErrors!.push(`error: ${(event as ErrorEvent).message}`.slice(0, 300)));
    });
    const extensionId = new URL(worker.url()).host;

    // The session as older builds left it: three screenshot-bearing capture states (~9 MB of the 10 MB quota).
    await worker.evaluate(async () => {
      const big = (megabytes: number) => `data:image/png;base64,${"A".repeat(megabytes * 1024 * 1024)}`;
      for (const [section, size] of [["overview", 3], ["top_flows", 3], ["campaign_performance", 3]] as const) {
        await chrome.storage.session.set({ [`tention.business-review-auto-capture.old-run.${section}`]: { stage: "review_ready", captured: { dataUrl: big(size) } } });
      }
      // Then fill to within a few hundred bytes of the quota, as the live session was when the toolbar click failed.
      let room = chrome.storage.session.QUOTA_BYTES - await chrome.storage.session.getBytesInUse(null) - 300;
      while (room > 0) { try { await chrome.storage.session.set({ "tention.business-review-auto-capture.old-run.flow_metrics": { stage: "failed", viewportScreenshot: { dataUrl: `data:image/png;base64,${"B".repeat(room)}` } } }); break; } catch { room -= 512; } }
    });
    const before = await worker.evaluate(async () => chrome.storage.session.getBytesInUse(null));
    const quota = await worker.evaluate(() => chrome.storage.session.QUOTA_BYTES);
    record("Session pre-filled like the live failure (within 1 KB of the quota)", quota - before < 1_024, { bytesInUse: before, quota });

    const klaviyo = await context.newPage();
    await klaviyo.goto("https://www.klaviyo.com/people/subscribers?range=last_7_days");
    const panel = await context.newPage();
    panel.on("pageerror", (error) => errors.push(`panel: ${error.message}`.slice(0, 300)));
    await panel.goto(`chrome-extension://${extensionId}/index.html`);
    await panel.getByRole("button", { name: "Open Report" }).first().click();
    await panel.getByText("Not yet saved", { exact: false }).waitFor({ timeout: 20_000 });
    record("Panel opened the August report; Subscriber Growth source not yet saved", true);

    // One toolbar click on Subscriber growth (Overview · Last 7 days), through Chrome's own action event.
    await klaviyo.bringToFront();
    await worker.evaluate(async () => { const [tab] = await chrome.tabs.query({ url: "https://www.klaviyo.com/people/subscribers*" }); chrome.action.onClicked.dispatch(tab as chrome.tabs.Tab); });
    const saved = await panel.getByText("Verified Subscriber growth source saved for this client", { exact: false }).waitFor({ timeout: 60_000 }).then(() => true, () => false);
    const pageState = await klaviyo.evaluate(() => ({ channel: document.querySelector("#channels [aria-selected=true]")?.textContent ?? null, view: document.querySelector("#views [aria-selected=true]")?.textContent ?? null, period: document.querySelector("#date")?.textContent ?? null }));
    const sourceDiagnostics = await worker.evaluate(async () => (await chrome.storage.session.get("tention.subscriber-growth-source:last"))["tention.subscriber-growth-source:last"]);
    console.log("SOURCE DIAGNOSTICS", JSON.stringify(sourceDiagnostics));
    record("Toolbar click selected Overview → Email → Growth automatically (date untouched)", pageState.channel === "Email" && pageState.view === "Growth" && pageState.period === "Last 7 days", pageState);
    const savedTargets = await targets.get(CLIENT_ID);
    record("Subscriber Growth source auto-saved and confirmed by reload", saved && savedTargets.sourceUrls?.subscriberGrowthUrl === "https://www.klaviyo.com/people/subscribers", { saved, subscriberGrowthUrl: savedTargets.sourceUrls?.subscriberGrowthUrl ?? null, diagnostics: sourceDiagnostics });
    record("Business Review binding preserved", savedTargets.businessReview?.dashboardUrl === "https://www.klaviyo.com/analytics/dashboards/E2EBUSINESSREVIEW");
    const afterSetup = await worker.evaluate(async () => { const all = await chrome.storage.session.get(null); return { bytesInUse: await chrome.storage.session.getBytesInUse(null), keys: Object.keys(all), hasImage: JSON.stringify(all).includes("data:image") }; });
    record("Obsolete screenshot state released; no image left in session", !afterSetup.hasImage && afterSetup.bytesInUse < 64 * 1024, afterSetup);

    // Resume: only Section 10 runs, from the saved source, starting again in Overview · Last 7 days.
    await panel.bringToFront();
    await panel.getByRole("button", { name: /Resume Automatic Capture · Subscriber Growth/ }).click();
    const finished = await panel.getByRole("heading", { name: /Automatic capture (finished|paused)/ }).waitFor({ timeout: 180_000 }).then(() => true, () => false);
    const runText = await panel.locator("main").innerText();
    await panel.screenshot({ path: join(outputDirectory, "panel-after-resume.png"), fullPage: true });
    record("Resume ran only 10/10 Subscriber Growth", finished && runText.includes("10/10 Subscriber Growth") && !runText.includes("1/10 Executive Summary"), { excerpt: runText.slice(0, 600) });
    record("Panel confirmed canonical persistence 10/10", runText.includes("All 10 captures are saved to this report") && runText.includes("10 / 10 captured"), { excerpt: runText.slice(0, 600) });
    const finalReport = (await repository.getById(report.id))!;
    const growth = finalReport.screenshots.find(({ type }) => type === "email_subscriber_growth");
    record("Canonical report has 10/10 captures", finalReport.screenshots.length === 10 && Boolean(growth), { screenshots: finalReport.screenshots.length });
    record("Sections 1–9 ids and hashes unchanged", Object.entries(nineHashes).every(([type, before]) => { const after = finalReport.screenshots.find((shot) => shot.type === type); return after?.id === before.id && after.sha256 === before.sha256; }));
    record(`Section 10 proof: ${PERIOD.startDate} → ${PERIOD.endDate}, Email → Growth, exact counts, both charts`, Boolean(growth?.sourceProof?.subscriberGrowth && growth.sourceProof.expectedPeriod?.startDate === PERIOD.startDate && growth.sourceProof.expectedPeriod.endDate === PERIOD.endDate && growth.sourceProof.subscriberGrowth.charts.subscriberGrowthLine && growth.sourceProof.subscriberGrowth.charts.newSubscribersExclusionsBar), growth?.sourceProof?.subscriberGrowth ?? null);
    if (growth?.storageKey) { const asset = await screenshotStorage.get(growth.storageKey); if (asset) await writeFile(join(outputDirectory, "section-10-capture.png"), asset.bytes); }

    // Development review PDF: generate, preview, open, download.
    const generated = await fetch(`${apiAddress}/api/v1/dev/report-drafts/${report.id}/partial-review`, { method: "POST" });
    const generatedBody = await generated.json().catch(() => null) as Record<string, unknown> | null;
    record("Development review PDF generated", generated.ok, generated.ok ? { pages: (generatedBody?.pdf as { physicalPageCount?: number } | undefined)?.physicalPageCount ?? null } : generatedBody);
    const pdf = await fetch(`${apiAddress}/api/v1/dev/report-drafts/${report.id}/partial-review/pdf`);
    const pdfBytes = Buffer.from(await pdf.arrayBuffer());
    if (pdf.ok) await writeFile(join(outputDirectory, "review.pdf"), pdfBytes);
    record("PDF open/preview returns a PDF", pdf.ok && pdfBytes.subarray(0, 4).toString() === "%PDF");
    const reviewHtml = await import("node:fs/promises").then((fs) => fs.readFile(join(root, "output/live-review", CLIENT_ID, `${MONTH.year}-${String(MONTH.month).padStart(2, "0")}`, "review-render.html"), "utf8")).catch(() => "");
    record("PDF contains the Subscriber Growth page after the nine core sections", /data-layout-slot="email_subscriber_growth"/.test(reviewHtml) && reviewHtml.indexOf('data-layout-slot="email_subscriber_growth"') > reviewHtml.indexOf('data-layout-slot="flow_metrics"') && reviewHtml.includes("Email subscribers 17,698"), { found: reviewHtml.includes("Subscriber Growth") });
    const download = await fetch(`${apiAddress}/api/v1/dev/report-drafts/${report.id}/partial-review/pdf?download=1`);
    record("PDF download returns an attachment", download.ok && /attachment/i.test(download.headers.get("content-disposition") ?? ""));

    errors.push(...await worker.evaluate(() => (globalThis as typeof globalThis & { __tentionErrors?: string[] }).__tentionErrors ?? []));
    const quotaErrors = errors.filter((message) => /quota/i.test(message));
    record("No uncaught errors, unhandled rejections, or quota errors in the extension", errors.length === 0, { errors, quotaErrors: quotaErrors.length });
  } catch (error) {
    record("E2E aborted", false, error instanceof Error ? error.message : String(error));
  } finally {
    await context?.close().catch(() => undefined);
    await app.close().catch(() => undefined);
  }
  const passed = results.every(({ status }) => status === "PASS");
  await writeFile(join(outputDirectory, "results.json"), `${JSON.stringify({ status: passed ? "PASS" : "FAIL", scaffolding: "test-only manifest copy adds <all_urls> for captureVisibleTab; toolbar handler driven through chrome.action.onClicked", results }, null, 2)}\n`);
  console.log(JSON.stringify({ status: passed ? "PASS" : "FAIL", outputDirectory }));
  // Explicit exit: the PDF renderer's browser and bounded timers must not keep the harness alive.
  process.exit(passed ? 0 : 1);
}

void main();
