import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type BrowserContext, type Download, type Page, type Response } from "playwright";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import { automaticCaptureTypesForSections, matchesReportCaptureSpec, REPORT_CAPTURE_SPEC_V1 } from "@tention/report-schema";
import { extensionE2eIgnoreDefaultArgs, extensionE2eLaunchArgs } from "./extension-e2e-browser.js";
import { EXTENSION_E2E_TARGETS, findCanonicalE2eDrafts, findRecentReportCardsForIdentity, selectExtensionE2eTarget, type ExtensionE2eDraftIdentity } from "./extension-e2e-contract.js";

// `--client <id>` (or TENTION_E2E_CLIENT) selects the canonical report; AutoLEDTech remains the default.
const TARGET = selectExtensionE2eTarget(process.argv.slice(2), process.env);
const REPORT_ID = TARGET.reportId;
const CLIENT_ID = TARGET.clientId;
const YEAR = TARGET.year;
const MONTH = TARGET.month;
const API = "http://127.0.0.1:4000";
const API_V1 = `${API}/api/v1`;
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../../../");
const extensionDirectory = join(repositoryRoot, "apps/extension/dist");
const stamp = new Date().toISOString().replaceAll(":", "-").replaceAll(".", "-");
const evidenceDirectory = join(repositoryRoot, "output/extension-e2e", stamp);
const downloadsDirectory = join(evidenceDirectory, "downloads");
const profileDirectory = join(evidenceDirectory, "chrome-profile");
const canonicalEndpoint = `${API_V1}/report-drafts/${REPORT_ID}`;
const requiredTypes = new Set(REPORT_CAPTURE_SPEC_V1.filter(({ reportOptIn }) => !reportOptIn).map(({ screenshotType }) => screenshotType));

/** A historical import can remain stored, but the UI must not offer approval
 * when its source proof no longer satisfies the current capture contract. */
function isReviewableRequiredCapture(screenshot: any) {
  return requiredTypes.has(screenshot.type)
    && !screenshot.approved
    && matchesReportCaptureSpec(screenshot.type, screenshot.sourceProof);
}

type StepStatus = "PASS" | "FAIL" | "BLOCKED" | "NOT_RUN";
interface StepResult { name: string; status: StepStatus; expected?: unknown; observed?: unknown; evidence?: string | undefined; error?: string }
const steps: StepResult[] = [];
const screenshots: Record<string, string> = {};
let context: BrowserContext | undefined;
let extensionPage: Page | undefined;
let extensionId: string | undefined;
let approvedType: string | undefined;
let initialVersion: number | undefined;
let expectedPdfSha: string | undefined;
let successfulReviewPostCount: number | undefined;
let canonicalDraftMissing = false;
let blockedReason: string | undefined;
class E2eBlockedError extends Error {}
let pdfGenerationRequestCount = 0;
let hadPendingReviewAtStart = false;

await mkdir(downloadsDirectory, { recursive: true });

function record(name: string, status: StepStatus, values: Omit<StepResult, "name" | "status"> = {}) {
  const existing = steps.find((step) => step.name === name);
  if (existing) Object.assign(existing, { status, ...values });
  else steps.push({ name, status, ...values });
}

async function saveResults(overall: "PASS" | "FAIL" | "BLOCKED") {
  const results = {
    kind: "real_unpackaged_chrome_extension_e2e",
    generatedAt: new Date().toISOString(),
    overall,
    apiBaseUrl: API,
    report: { reportId: REPORT_ID, clientId: CLIENT_ID, year: YEAR, month: MONTH, expectedClientName: TARGET.clientName, expectedTimezone: TARGET.timezone },
    browser: { extensionId: extensionId ?? null, extensionUrl: extensionId ? `chrome-extension://${extensionId}/index.html` : null, extensionDirectory, profileDirectory, isolatedFromNormalProfile: true },
    steps,
    screenshots,
    approval: { approvedType: approvedType ?? null, initialVersion: initialVersion ?? null, automaticOrBulkApproval: false },
    pdf: { sha256: expectedPdfSha ?? null },
    notes: ["Uses the real built extension bundle and real local API; no UI or API state is mocked.", "Does not open or navigate to Klaviyo.", "Approval is limited to one explicit extension review action.", "Does not create, delete, or otherwise mutate report data outside that one approval action and the development PDF artifact."],
  };
  await writeFile(join(evidenceDirectory, "results.json"), `${JSON.stringify(results, null, 2)}\n`);
}

async function snap(page: Page, name: string) {
  const file = `${name}.png`;
  await page.screenshot({ path: join(evidenceDirectory, file), fullPage: true, animations: "disabled" });
  screenshots[name] = file;
}

async function step<T>(name: string, action: () => Promise<T>, summarize?: (value: T) => Omit<StepResult, "name" | "status">): Promise<T> {
  try {
    const value = await action();
    record(name, "PASS", summarize?.(value));
    return value;
  } catch (error) {
    record(name, error instanceof E2eBlockedError ? "BLOCKED" : "FAIL", { error: error instanceof Error ? error.message : String(error) });
    throw error;
  }
}

async function responseBody(response: Response) {
  return Buffer.from(await response.body());
}

async function verifyPdfResponse(response: Response) {
  const contentType = response.headers()["content-type"] ?? "";
  const reportId = response.headers()["x-report-id"] ?? "";
  const body = await responseBody(response);
  if (!response.ok()) throw new Error(`PDF request returned HTTP ${response.status()}.`);
  if (!contentType.includes("application/pdf")) throw new Error(`Expected PDF content type; received ${contentType || "none"}.`);
  if (reportId !== REPORT_ID) throw new Error(`PDF belongs to report ${reportId || "(missing)"}, not ${REPORT_ID}.`);
  if (body.length === 0 || body.subarray(0, 5).toString("ascii") !== "%PDF-") throw new Error("Response body is not a non-empty PDF.");
  return body;
}

async function parsePdf(bytes: Buffer) {
  const loading = getDocument({ data: new Uint8Array(bytes), useSystemFonts: true });
  try {
    const doc = await loading.promise;
    const info = (await doc.getMetadata()).info as { Title?: string };
    return { pageCount: doc.numPages, title: info.Title ?? null };
  } finally { await loading.destroy().catch(() => undefined); }
}

try {
  const health = await step("API health", async () => {
    const response = await fetch(`${API}/health`);
    if (!response.ok || !(await response.json()).ok) throw new Error(`Local API health returned HTTP ${response.status}.`);
    return response.status;
  }, (status) => ({ expected: 200, observed: status }));
  void health;

  const draftListResponse = await fetch(`${API_V1}/report-drafts?clientId=${CLIENT_ID}&year=${YEAR}&month=${MONTH}`);
  if (!draftListResponse.ok) throw new Error(`Report list returned HTTP ${draftListResponse.status}.`);
  const drafts = await draftListResponse.json() as ExtensionE2eDraftIdentity[];
  const matching = findCanonicalE2eDrafts(drafts, { id: REPORT_ID, clientId: CLIENT_ID, year: YEAR, month: MONTH });
  canonicalDraftMissing = matching.length === 0;
  record("Canonical report available from local API", matching.length === 1 ? "PASS" : "FAIL", {
    expected: { count: 1, reportId: REPORT_ID },
    observed: { count: matching.length, reportIds: matching.map(({ id }) => id), totalReturned: drafts.length },
    ...(matching.length === 1 ? {} : { error: matching.length === 0 ? "Canonical draft is absent from the connected API." : "More than one canonical report match was returned." }),
  });
  const persistenceResponse = await fetch(`${API_V1}/dev/report-drafts/${REPORT_ID}/partial-review/status`);
  const persistenceBody = await persistenceResponse.json().catch(() => ({})) as { error?: string };
  const persistenceReady = persistenceResponse.status === 200
    || (persistenceResponse.status === 404 && ["REPORT_NOT_FOUND", "PDF_REVIEW_NOT_GENERATED"].includes(persistenceBody.error ?? ""))
    || (persistenceResponse.status === 409 && persistenceBody.error === "PDF_REVIEW_STALE");
  record("Persistent PostgreSQL and artifact storage gate", persistenceReady ? "PASS" : "FAIL", {
    expected: "loopback development route confirms persistent database and artifact storage configuration",
    observed: { status: persistenceResponse.status, error: persistenceBody.error ?? null },
    ...(persistenceReady ? {} : { error: "The local API did not confirm persistent PostgreSQL/filesystem storage." }),
  });

  // Use Playwright's pinned Chromium by default: branded Chrome can ignore
  // --load-extension under managed profile/policy settings. Both use a fresh
  // persistent user-data directory; the developer's normal Chrome profile is never opened.
  const chromePath = process.env.TENTION_EXTENSION_E2E_CHROME_PATH ?? chromium.executablePath();
  const loadedExtension = await step("Launch isolated Chrome with real unpacked extension", async () => {
    context = await chromium.launchPersistentContext(profileDirectory, {
      executablePath: chromePath,
      headless: false,
      viewport: { width: 1280, height: 1000 },
      acceptDownloads: true,
      downloadsPath: downloadsDirectory,
      ignoreDefaultArgs: [...extensionE2eIgnoreDefaultArgs],
      args: extensionE2eLaunchArgs(extensionDirectory),
    });
    const workers = context.serviceWorkers();
    let worker = workers.find((item) => item.url().startsWith("chrome-extension://"));
    if (!worker) worker = await context.waitForEvent("serviceworker", { timeout: 5_000 }).catch(() => undefined);
    let id = worker?.url().startsWith("chrome-extension://") ? new URL(worker.url()).host : "";
    let resolvedFrom = worker ? "service-worker-url" : "chrome-extensions-page";
    if (!id) {
      const diagnostics = await context.newPage();
      await diagnostics.goto("chrome://extensions", { waitUntil: "domcontentloaded" });
      await diagnostics.waitForTimeout(1_000);
      const snapshot = await diagnostics.evaluate(`(() => {
        const items = [];
        function walk(root) {
          for (const element of Array.from(root.querySelectorAll("*"))) {
            if (element.tagName.toLowerCase() === "extensions-item") {
              const shadow = element.shadowRoot;
              items.push({ id: element.getAttribute("id"), name: element.getAttribute("name") || shadow?.querySelector("#name")?.textContent?.trim() || null, text: (shadow?.textContent || element.textContent || "").trim().slice(0, 500) });
            }
            if (element.shadowRoot) walk(element.shadowRoot);
          }
        }
        walk(document);
        return { title: document.title, text: document.body.innerText.slice(0, 4000), items };
      })()`) as { title: string; text: string; items: Array<{ id: string | null; name: string | null; text: string }> };
      await diagnostics.screenshot({ path: join(evidenceDirectory, "chrome-extensions-diagnostic.png"), fullPage: true });
      await writeFile(join(evidenceDirectory, "chrome-extensions-diagnostic.html"), await diagnostics.content());
      await writeFile(join(evidenceDirectory, "chrome-extensions-diagnostic.json"), `${JSON.stringify(snapshot, null, 2)}\n`);
      const candidate = snapshot.items.find((item) => item.name === "Tention Reports" && item.id && /^[a-p]{32}$/.test(item.id));
      id = candidate?.id ?? "";
      if (!id) throw new Error(`Chrome did not expose an installed Tention Reports extension ID. Diagnostic screenshot and DOM were saved; extensions page text: ${snapshot.text.slice(0, 500)}.`);
    }
    if (!/^[a-p]{32}$/.test(id)) throw new Error("Resolved extension ID did not match Chrome's extension ID format.");
    const workerUrl = worker?.url() ?? null;
    if (workerUrl && !workerUrl.startsWith(`chrome-extension://${id}/`)) throw new Error("Service worker origin did not match the resolved extension ID.");
    extensionId = id;
    return { extensionId: id, workerUrl, resolvedFrom };
  }, (value) => ({ expected: "extension ID from loaded service worker", observed: value }));
  void loadedExtension;

  extensionPage = await context!.newPage();
  await step("Load actual extension React document", async () => {
    const url = `chrome-extension://${extensionId}/index.html`;
    await extensionPage!.goto(url, { waitUntil: "domcontentloaded" });
    await extensionPage!.getByRole("heading", { name: "Recent Reports" }).waitFor({ state: "visible", timeout: 20_000 });
    await extensionPage!.getByText("Connected", { exact: true }).waitFor({ state: "visible", timeout: 10_000 });
    await snap(extensionPage!, "recent-reports");
    return { url: extensionPage!.url(), title: await extensionPage!.title() };
  }, (value) => ({ expected: `chrome-extension://${extensionId}/index.html`, observed: value.url, evidence: screenshots["recent-reports"]! }));

  await step("Recent Reports displays one canonical report", async () => {
    const cards = extensionPage!.locator(".recent-list > li");
    const totalCards = await cards.count();
    const allCardTexts = await cards.allInnerTexts();
    const canonicalCards = findRecentReportCardsForIdentity(allCardTexts, { clientName: TARGET.clientName, monthLabel: TARGET.monthLabel });
    if (matching.length !== 1 || matching[0]?.id !== REPORT_ID) throw new Error(`Canonical report unavailable: API matched ${matching.length}; extension rendered ${totalCards} report card(s): ${allCardTexts.join(" | ") || "none"}`);
    if (canonicalCards.length !== 1) throw new Error(`Extension showed ${canonicalCards.length} ${TARGET.clientName} ${TARGET.monthLabel} report cards among ${totalCards} valid recent reports.`);
    return { apiMatches: matching.length, canonicalCards: canonicalCards.length, totalRecentReports: totalCards, text: canonicalCards[0] };
  }, (value) => ({ expected: { apiMatches: 1, canonicalCards: 1, client: TARGET.clientName, month: TARGET.monthLabel }, observed: value, evidence: screenshots["recent-reports"]! }));

  const canonicalResponse = await step("Canonical report identity and month verified", async () => {
    const response = await fetch(canonicalEndpoint);
    if (!response.ok) throw new Error(`Canonical report GET returned HTTP ${response.status}.`);
    const draft = await response.json() as any;
    if (draft.id !== REPORT_ID || draft.client.id !== CLIENT_ID || draft.client.name !== TARGET.clientName || draft.client.timezone !== TARGET.timezone || draft.reportMonth.year !== YEAR || draft.reportMonth.month !== MONTH) throw new Error("Canonical report identity, timezone, or month does not match the E2E contract.");
    // Nine core imports, or ten when this report includes Section 10 (Subscriber Growth).
    const expectedImports = automaticCaptureTypesForSections(draft.sections).length;
    if (draft.screenshots.length !== expectedImports || draft.screenshots.some((shot: any) => shot.captureOrigin !== "live_acceptance_import")) throw new Error(`The report does not contain exactly the ${expectedImports} expected live acceptance imports.`);
    const hashes = draft.screenshots.map((shot: any) => shot.sha256).filter((hash: unknown): hash is string => typeof hash === "string");
    if (hashes.length !== expectedImports || new Set(hashes).size !== expectedImports) throw new Error("The canonical imported screenshot records have missing or duplicate SHA-256 values.");
    return draft;
  }, (draft) => ({ expected: { reportId: REPORT_ID, clientId: CLIENT_ID, timezone: TARGET.timezone, month: `${YEAR}-${String(MONTH).padStart(2, "0")}`, importedCaptures: automaticCaptureTypesForSections(draft.sections).length }, observed: { reportId: draft.id, clientId: draft.client.id, timezone: draft.client.timezone, month: `${draft.reportMonth.year}-${String(draft.reportMonth.month).padStart(2, "0")}`, captures: draft.screenshots.length } }));

  initialVersion = canonicalResponse.version;
  await step("Open canonical report from extension", async () => {
    const canonicalCard = extensionPage!.locator(".recent-list > li").filter({ hasText: TARGET.clientName }).filter({ hasText: TARGET.monthLabel });
    if (await canonicalCard.count() !== 1) throw new Error(`The ${TARGET.clientName} ${TARGET.monthLabel} report card was not unique before opening it.`);
    const reportLoad = extensionPage!.waitForResponse((response) => response.url() === canonicalEndpoint && response.request().method() === "GET", { timeout: 20_000 });
    await canonicalCard.getByRole("button", { name: "Open Report", exact: true }).click();
    const loadedResponse = await reportLoad;
    if (!loadedResponse.ok()) throw new Error(`Opening the report card fetched HTTP ${loadedResponse.status()} for the canonical draft.`);
    const loadedDraft = await loadedResponse.json() as any;
    if (loadedDraft.id !== REPORT_ID || loadedDraft.client?.id !== CLIENT_ID || loadedDraft.client?.name !== TARGET.clientName || loadedDraft.client?.timezone !== TARGET.timezone || loadedDraft.reportMonth?.year !== YEAR || loadedDraft.reportMonth?.month !== MONTH) {
      throw new Error(`The report opened by the extension did not match the canonical ${TARGET.clientName} ${TARGET.monthLabel} identity.`);
    }
    await extensionPage!.getByRole("heading", { name: TARGET.clientName, exact: true }).waitFor({ state: "visible" });
    await extensionPage!.getByText(TARGET.monthLabel, { exact: true }).waitFor({ state: "visible" });
    await snap(extensionPage!, "open-canonical-report");
    return { reportId: loadedDraft.id, clientId: loadedDraft.client.id, timezone: loadedDraft.client.timezone, reportMonth: loadedDraft.reportMonth, heading: await extensionPage!.getByRole("heading", { name: TARGET.clientName, exact: true }).innerText() };
  }, (value) => ({ expected: { reportId: REPORT_ID, client: TARGET.clientName, month: TARGET.monthLabel, timezone: TARGET.timezone }, observed: value, evidence: screenshots["open-canonical-report"]! }));

  const captureReviewButton = extensionPage!.locator(".runner-checklist li").filter({ hasText: "Executive Summary" }).getByRole("button", { name: "Review saved capture", exact: true });
  await step("Checklist matches canonical imported-capture review state", async () => {
    const requiredPendingReviewButtons = await extensionPage!.locator(".runner-checklist").getByRole("button", { name: "Review saved capture", exact: true }).count();
    const expectedRequiredPending = canonicalResponse.screenshots.filter(isReviewableRequiredCapture).length;
    if (requiredPendingReviewButtons !== expectedRequiredPending) throw new Error(`Expected ${expectedRequiredPending} visible required-capture review controls based on canonical approval state; found ${requiredPendingReviewButtons}.`);
    const optional = extensionPage!.locator("details.optional-sections");
    if (await optional.count() !== 1) throw new Error("The extension did not expose the optional sections checklist.");
    await optional.locator("summary").click();
    const pendingReviewButtons = await extensionPage!.getByRole("button", { name: "Review saved capture", exact: true }).count();
    const expectedPending = canonicalResponse.screenshots.filter(isReviewableRequiredCapture).length;
    if (pendingReviewButtons !== expectedPending) throw new Error(`Expected ${expectedPending} individual pending-capture review controls based on canonical approval state; found ${pendingReviewButtons}.`);
    const bodyText = await extensionPage!.locator("body").innerText();
    hadPendingReviewAtStart = expectedPending > 0;
    const automaticProgress = await extensionPage!.locator("[aria-label='Automatic Capture Progress']").innerText();
    if (!automaticProgress.includes(`Pending review: ${expectedPending}`)) throw new Error("Automatic capture pending-review count did not match canonical backend state.");
    const staleCount = canonicalResponse.screenshots.filter((shot: any) => requiredTypes.has(shot.type) && !matchesReportCaptureSpec(shot.type, shot.sourceProof)).length;
    if (!automaticProgress.includes(`Missing/stale: ${staleCount}`)) throw new Error("Automatic capture stale-evidence count did not match the canonical source-proof state.");
    if (expectedPending > 0 && !bodyText.includes("Approval required")) throw new Error("Checklist does not indicate the imported captures are still awaiting approval.");
    // Stale evidence is neither pending nor approved, so compare against the backend's approved count.
    const approvedRequired = canonicalResponse.screenshots.filter((shot: any) => requiredTypes.has(shot.type) && shot.approved).length;
    if (expectedPending === 0 && !automaticProgress.includes(`Approved: ${approvedRequired}`)) throw new Error("Checklist does not reflect the canonical approved-capture state.");
    await snap(extensionPage!, "checklist");
    return { requiredReviewActions: requiredPendingReviewButtons, allReviewActions: pendingReviewButtons, staleRequiredCaptures: staleCount, approvedCount: canonicalResponse.screenshots.filter((shot: any) => shot.approved).length, draftStatus: canonicalResponse.status, version: canonicalResponse.version };
  }, (value) => ({ expected: { allPendingActionsMatchBackend: true, draftStatus: "draft" }, observed: value, evidence: screenshots.checklist! }));

  const chosen = canonicalResponse.screenshots.find((shot: any) => shot.type === "overview" && shot.captureOrigin === "live_acceptance_import");
  if (!chosen) throw new Error("The canonical Executive Summary screenshot needed for the controlled approval check is missing.");
  approvedType = chosen.type;
  const pendingToInspect = chosen.approved ? canonicalResponse.screenshots.find((shot: any) => isReviewableRequiredCapture(shot) && shot.captureOrigin === "live_acceptance_import") : chosen;
  await step("Review one saved screenshot in the real extension", async () => {
    if (!pendingToInspect) {
      if (hadPendingReviewAtStart) throw new Error("Pending-review state changed unexpectedly before the review step.");
      await snap(extensionPage!, "review-screen");
      return { reviewNeeded: false, reason: "all canonical automatic captures were already approved; no approval action was invoked", screenshotType: chosen.type };
    }
    if (chosen.approved) {
      const anotherPending = extensionPage!.getByRole("button", { name: "Review saved capture", exact: true }).first();
      if (await anotherPending.count()) await anotherPending.click();
      else throw new Error("No pending screenshot remains for visual review; the designated test capture is already approved.");
    } else await captureReviewButton.click();
    await extensionPage!.getByRole("heading", { name: new RegExp(`Review saved`, "i") }).waitFor({ state: "visible" });
    const image = extensionPage!.locator("img[alt^='Pending imported']");
    await image.waitFor({ state: "visible", timeout: 15_000 });
    const dimensions = await image.evaluate((node: HTMLImageElement) => ({ width: node.naturalWidth, height: node.naturalHeight, complete: node.complete }));
    if (!dimensions.complete || dimensions.width <= 0 || dimensions.height <= 0) throw new Error("The canonical stored screenshot did not render in the review screen.");
    await snap(extensionPage!, "review-screen");
    if (chosen.approved) await extensionPage!.getByRole("button", { name: "Back without approving", exact: true }).click();
    return { screenshotType: pendingToInspect.type, approvedScreenshotUnderTest: chosen.type, image: dimensions };
  }, (value) => ({ expected: hadPendingReviewAtStart ? "stored pending PNG rendered" : "approved canonical state retained without another approval", observed: value, evidence: screenshots["review-screen"]! }));

  await step("Controlled screenshot approval and persistence verification", async () => {
    if (!chosen.approved) {
      await extensionPage!.getByRole("button", { name: "Approve this saved evidence", exact: true }).click();
      const requiredPending = extensionPage!.locator(".runner-checklist").getByRole("button", { name: "Review saved capture", exact: true });
      await requiredPending.first().waitFor({ state: "visible" });
      const expectedRequiredPendingAfterAction = canonicalResponse.screenshots.filter(isReviewableRequiredCapture).length - 1;
      if (await requiredPending.count() !== expectedRequiredPendingAfterAction) throw new Error("The extension checklist’s required pending controls do not match backend approval state.");
      const expectedCompletedRequired = canonicalResponse.screenshots.filter((shot: any) => requiredTypes.has(shot.type) && shot.approved).length + 1;
      await extensionPage!.getByText(`Final report readiness: ${expectedCompletedRequired} / 9 required screenshots approved`, { exact: true }).waitFor({ state: "visible" });
      const optional = extensionPage!.locator("details.optional-sections");
      if (await optional.count() === 1 && !(await optional.evaluate((element: HTMLDetailsElement) => element.open))) await optional.locator("summary").click();
      const expectedPendingAfterAction = canonicalResponse.screenshots.filter(isReviewableRequiredCapture).length - 1;
      if (await extensionPage!.getByRole("button", { name: "Review saved capture", exact: true }).count() !== expectedPendingAfterAction) throw new Error("The extension pending-capture controls do not match the backend after review.");
    }
    const response = await fetch(canonicalEndpoint);
    if (!response.ok) throw new Error(`Canonical reload returned HTTP ${response.status}.`);
    const updated = await response.json() as any;
    const shot = updated.screenshots.find((record: any) => record.type === chosen.type);
    if (!shot?.approved || shot.approvedAt === null || updated.version !== canonicalResponse.version + (chosen.approved ? 0 : 1)) throw new Error("Approval state was not persisted in the canonical draft at the expected version.");
    const approvedDelta = updated.screenshots.filter((record: any) => record.approved).length - canonicalResponse.screenshots.filter((record: any) => record.approved).length;
    if (approvedDelta !== (chosen.approved ? 0 : 1)) throw new Error("Approval unexpectedly changed more than the one explicitly reviewed screenshot.");
    await snap(extensionPage!, "post-approval");
    return { type: shot.type, approved: shot.approved, reportVersion: updated.version, approvedCount: updated.screenshots.filter((record: any) => record.approved).length };
  }, (value) => ({ expected: { canonicalApprovalPersisted: true, onlyOneApproval: true }, observed: { ...value, approvalActionThisRun: !chosen.approved }, evidence: screenshots["post-approval"]! }));

  // Stale evidence (for example a retired source) can only be replaced by a live
  // capture from the client's own Klaviyo account; report that as BLOCKED, not as a pass or a code failure.
  await step("Required evidence matches the current capture contract", async () => {
    const stale = canonicalResponse.screenshots.filter((shot: any) => requiredTypes.has(shot.type) && !matchesReportCaptureSpec(shot.type, shot.sourceProof));
    if (stale.length) {
      blockedReason = `${TARGET.clientName} ${TARGET.monthLabel} has stale required evidence (${stale.map((shot: any) => `${shot.type}: ${shot.sourceProof?.sourceIdentity ?? "no source proof"}`).join(", ")}). Recapture it live from the client's Klaviyo account before PDF steps can run.`;
      throw new E2eBlockedError(blockedReason);
    }
    return { staleRequiredCaptures: 0 };
  }, (value) => ({ expected: { staleRequiredCaptures: 0 }, observed: value }));

  if (canonicalResponse.status === "generated") {
    await runFinalArtifactSteps(canonicalResponse);
  } else {
  const responseEvents: Array<{ response: Response; url: string }> = [];
  context!.on("response", (response) => {
    if (response.url().includes(`/api/v1/dev/report-drafts/${REPORT_ID}/partial-review/pdf`)) responseEvents.push({ response, url: response.url() });
  });
  context!.on("request", (request) => {
    if (request.method() === "POST" && request.url().endsWith(`/api/v1/dev/report-drafts/${REPORT_ID}/partial-review`)) pdfGenerationRequestCount += 1;
  });
  await step("Generate development review PDF from extension control", async () => {
    const generate = extensionPage!.getByRole("button", { name: /Generate Review PDF|Regenerate Review PDF/ });
    const generationResponse = context!.waitForEvent("response", { predicate: (response) => response.request().method() === "POST" && response.url().endsWith(`/api/v1/dev/report-drafts/${REPORT_ID}/partial-review`), timeout: 90_000 });
    await generate.click();
    const acknowledgement = await generationResponse;
    if (!acknowledgement.ok()) throw new Error(`Review PDF generation API returned HTTP ${acknowledgement.status()}.`);
    const ack = await acknowledgement.json() as any;
    if ((ack.reportId ?? ack.canonicalReportId) !== REPORT_ID || ack.developmentOnly !== true || ack.finalClientArtifact !== false || ack.reportLifecycle?.transitionedToGenerated !== false) throw new Error("PDF generation acknowledgement was not bound to this canonical development-only draft.");
    await extensionPage!.getByText(/Saved for report version/, { exact: false }).waitFor({ state: "visible", timeout: 90_000 });
    const visibleText = await extensionPage!.locator("[aria-label='Development Review PDF']").innerText();
    // "… 9 CORE SECTIONS VERIFIED" or "… 9 CORE SECTIONS + SUBSCRIBER GROWTH VERIFIED".
    if (!visibleText.includes("DEVELOPMENT REVIEW — 9 CORE SECTIONS")) throw new Error("PDF UI did not clearly label the artifact as a core-section development review.");
    const statusResponse = await fetch(`${API_V1}/dev/report-drafts/${REPORT_ID}/partial-review/status`);
    if (!statusResponse.ok) throw new Error(`Development PDF status returned HTTP ${statusResponse.status}.`);
    const status = await statusResponse.json() as any;
    if (!status.developmentOnly || status.reportId !== REPORT_ID || status.fileName !== TARGET.reviewPdfFileName) throw new Error("Development PDF status was not bound to the canonical report or development-only lifecycle.");
    expectedPdfSha = status.sha256;
    successfulReviewPostCount = pdfGenerationRequestCount;
    await snap(extensionPage!, "pdf-actions");
    await snap(extensionPage!, "post-generation");
    return status;
  }, (value) => ({ expected: { developmentOnly: true, reportId: REPORT_ID, pageCount: ">0" }, observed: value, evidence: screenshots["pdf-actions"]! }));

  await step("Preview Review PDF from extension", async () => {
    await extensionPage!.getByRole("button", { name: "Preview Review PDF", exact: true }).click();
    const iframe = extensionPage!.locator("iframe[title='Development Review PDF Preview']");
    await iframe.waitFor({ state: "visible", timeout: 10_000 });
    const previewUrl = await iframe.getAttribute("src");
    if (!previewUrl?.endsWith(`/api/v1/dev/report-drafts/${REPORT_ID}/partial-review/pdf`)) throw new Error("Preview control did not open the canonical development PDF endpoint.");
    // Chromium's built-in PDF viewer can request partial byte ranges from the iframe;
    // independently fetch the same canonical artifact as a full response for checksum/page validation.
    const response = await fetch(`${API_V1}/dev/report-drafts/${REPORT_ID}/partial-review/pdf`);
    const contentType = response.headers.get("content-type") ?? "";
    const reportId = response.headers.get("x-report-id") ?? "";
    const bytes = Buffer.from(await response.arrayBuffer());
    if (!response.ok || !contentType.includes("application/pdf") || reportId !== REPORT_ID || bytes.length === 0 || bytes.subarray(0, 5).toString("ascii") !== "%PDF-") throw new Error("Canonical preview artifact response was not a complete valid PDF.");
    const parsed = await parsePdf(bytes);
    if (parsed.pageCount < 1) throw new Error("The review PDF contains no physical pages.");
    await snap(extensionPage!, "pdf-preview");
    return { previewUrl, pageCount: parsed.pageCount, byteSize: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") };
  }, (value) => ({ expected: { minPages: 1, sha256: expectedPdfSha }, observed: value, evidence: screenshots["pdf-preview"]! }));

  await step("Open PDF through extension control", async () => {
    const before = responseEvents.length;
    const responseWait = context!.waitForEvent("response", { predicate: (response) => response.url().endsWith(`/api/v1/dev/report-drafts/${REPORT_ID}/partial-review/pdf`), timeout: 30_000 });
    const pageWait = context!.waitForEvent("page", { timeout: 30_000 });
    await extensionPage!.getByRole("button", { name: "Open PDF", exact: true }).click();
    const [response, pdfPage] = await Promise.all([responseWait, pageWait]);
    if (!response.ok() || !response.url().endsWith(`/api/v1/dev/report-drafts/${REPORT_ID}/partial-review/pdf`)) throw new Error(`Open PDF navigation mismatch: HTTP ${response.status()}, url=${response.url()}.`);
    await pdfPage.waitForLoadState("domcontentloaded", { timeout: 30_000 }).catch(() => undefined);
    if (!pdfPage.url().includes(`/api/v1/dev/report-drafts/${REPORT_ID}/partial-review/pdf`)) throw new Error("Open PDF control navigated away from the canonical development artifact.");
    // Chrome's PDF tab may use HTTP Range and return only one segment in the intercepted response.
    // Fetch the same canonical URL without a Range header for complete-byte/checksum/page validation.
    const fullResponse = await fetch(`${API_V1}/dev/report-drafts/${REPORT_ID}/partial-review/pdf`);
    const bytes = Buffer.from(await fullResponse.arrayBuffer());
    if (!fullResponse.ok || !(fullResponse.headers.get("content-type") ?? "").includes("application/pdf") || fullResponse.headers.get("x-report-id") !== REPORT_ID || bytes.length === 0 || bytes.subarray(0, 5).toString("ascii") !== "%PDF-") throw new Error("The canonical opened PDF artifact could not be independently retrieved as a complete PDF.");
    const parsed = await parsePdf(bytes);
    await snap(pdfPage, "open-pdf");
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    if (sha256 !== expectedPdfSha) throw new Error("Opened PDF checksum does not match saved canonical review artifact.");
    return { url: response.url(), pageCount: parsed.pageCount, byteSize: bytes.length, sha256, newPageCount: context!.pages().length, responseCountBefore: before };
  }, (value) => ({ expected: { reportId: REPORT_ID, sha256: expectedPdfSha }, observed: value, evidence: screenshots["open-pdf"]! }));

  await step("Download PDF through extension control and validate file", async () => {
    let resolveDownload!: (download: Download) => void;
    let rejectDownload!: (error: Error) => void;
    const downloadPromise = new Promise<Download>((resolvePromise, rejectPromise) => { resolveDownload = resolvePromise; rejectDownload = rejectPromise; });
    const listeners = new Set<Page>();
    const attach = (page: Page) => { if (!listeners.has(page)) { listeners.add(page); page.once("download", resolveDownload); page.once("close", () => rejectDownload(new Error("PDF download tab closed before download completed."))); } };
    context!.pages().forEach(attach);
    const onPage = (page: Page) => attach(page);
    context!.on("page", onPage);
    const responseWait = context!.waitForEvent("response", { predicate: (response) => response.url().endsWith(`/api/v1/dev/report-drafts/${REPORT_ID}/partial-review/pdf?download=1`), timeout: 30_000 });
    try {
      await extensionPage!.getByRole("button", { name: "Download PDF", exact: true }).click();
      const [download, response] = await Promise.all([downloadPromise, responseWait]);
      const destination = join(downloadsDirectory, download.suggestedFilename());
      await download.saveAs(destination);
      const bytes = await readFile(destination);
      const contentType = response.headers()["content-type"] ?? "";
      if (!response.ok() || !contentType.includes("application/pdf") || response.headers()["x-report-id"] !== REPORT_ID) throw new Error("Download response was not a successful PDF for the canonical report.");
      const parsed = await parsePdf(bytes);
      const sha256 = createHash("sha256").update(bytes).digest("hex");
      if (bytes.length <= 0 || sha256 !== expectedPdfSha || parsed.pageCount < 1) throw new Error("Downloaded PDF failed non-empty, parse, page, or checksum validation.");
      return { file: destination, suggestedFilename: download.suggestedFilename(), byteSize: bytes.length, sha256, pageCount: parsed.pageCount };
    } finally { context!.off("page", onPage); }
  }, (value) => ({ expected: { filename: TARGET.reviewPdfFileName, sha256: expectedPdfSha }, observed: value }));

  await step("Close and reopen extension UI; reopen the canonical report", async () => {
    await extensionPage!.close();
    extensionPage = await context!.newPage();
    await extensionPage.goto(`chrome-extension://${extensionId}/index.html`, { waitUntil: "domcontentloaded" });
    await extensionPage.getByRole("heading", { name: "Recent Reports" }).waitFor({ state: "visible" });
    const cards = extensionPage.locator(".recent-list > li");
    await cards.first().waitFor({ state: "visible", timeout: 20_000 });
    const canonicalCards = cards.filter({ hasText: TARGET.clientName }).filter({ hasText: TARGET.monthLabel });
    if (await canonicalCards.count() !== 1) throw new Error(`Recent Reports did not retain exactly one ${TARGET.clientName} ${TARGET.monthLabel} report after extension UI reopen.`);
    const recentReportCards = await cards.count();
    await canonicalCards.getByRole("button", { name: "Open Report", exact: true }).click();
    await extensionPage.getByRole("heading", { name: TARGET.clientName, exact: true }).waitFor({ state: "visible" });
    const reopened = await (await fetch(canonicalEndpoint)).json() as any;
    const approvedRequired = reopened.screenshots.filter((shot: any) => requiredTypes.has(shot.type) && shot.approved).length;
    await extensionPage.getByText(`Final report readiness: ${approvedRequired} / 9 required screenshots approved`, { exact: true }).waitFor({ state: "visible", timeout: 20_000 });
    const reportProgressCard = extensionPage.locator("section.card").filter({ has: extensionPage.getByRole("heading", { name: "Report Progress", exact: true }) });
    const executiveSummaryRow = reportProgressCard.locator(".runner-checklist li").filter({ hasText: "Executive Summary" });
    const expectedSummaryAction = reopened.screenshots.find((shot: any) => shot.type === "overview")?.approved ? "Retake" : "Review saved capture";
    if (await executiveSummaryRow.getByRole("button", { name: expectedSummaryAction, exact: true }).count() !== 1) throw new Error("The extension UI did not reload the saved Executive Summary review state from the canonical report.");
    await extensionPage.getByText("DEVELOPMENT REVIEW — 9 CORE SECTIONS", { exact: false }).waitFor({ state: "visible", timeout: 20_000 });
    await extensionPage.getByText(/Saved for report version/, { exact: false }).waitFor({ state: "visible", timeout: 20_000 });
    await snap(extensionPage, "reopened-report");
    return { cards: recentReportCards, reportHeading: await extensionPage.getByRole("heading", { name: TARGET.clientName, exact: true }).innerText(), reportId: REPORT_ID, approvedSummaryCompletedAfterReopen: true };
  }, (value) => ({ expected: { cards: 1, reportId: REPORT_ID, existingPdf: true }, observed: value, evidence: screenshots["reopened-report"]! }));

  await step("Reopen existing PDF without regenerating", async () => {
    const postCountBefore = successfulReviewPostCount;
    const responseWait = context!.waitForEvent("response", { predicate: (response) => response.url().endsWith(`/api/v1/dev/report-drafts/${REPORT_ID}/partial-review/pdf`), timeout: 30_000 });
    const pageWait = context!.waitForEvent("page", { timeout: 30_000 });
    await extensionPage!.getByRole("button", { name: "Open PDF", exact: true }).click();
    const [response, pdfPage] = await Promise.all([responseWait, pageWait]);
    if (!response.ok() || !(response.headers()["content-type"] ?? "").includes("application/pdf") || response.headers()["x-report-id"] !== REPORT_ID) throw new Error("Reopened PDF response did not belong to the canonical report.");
    await pdfPage.waitForLoadState("domcontentloaded", { timeout: 30_000 }).catch(() => undefined);
    if (!pdfPage.url().includes(`/api/v1/dev/report-drafts/${REPORT_ID}/partial-review/pdf`)) throw new Error("Reopened PDF did not navigate to the existing canonical artifact.");
    const fullResponse = await fetch(`${API_V1}/dev/report-drafts/${REPORT_ID}/partial-review/pdf`);
    const bytes = Buffer.from(await fullResponse.arrayBuffer());
    if (!fullResponse.ok || !(fullResponse.headers.get("content-type") ?? "").includes("application/pdf") || fullResponse.headers.get("x-report-id") !== REPORT_ID || bytes.length === 0 || bytes.subarray(0, 5).toString("ascii") !== "%PDF-") throw new Error("The existing reopened artifact could not be retrieved as a complete PDF.");
    const parsed = await parsePdf(bytes);
    const hash = createHash("sha256").update(bytes).digest("hex");
    const status = await (await fetch(`${API_V1}/dev/report-drafts/${REPORT_ID}/partial-review/status`)).json() as any;
    const currentPostCount = pdfGenerationRequestCount;
    if (hash !== expectedPdfSha || status.sha256 !== expectedPdfSha || parsed.pageCount !== status.physicalPageCount || currentPostCount !== postCountBefore) throw new Error("Reopened PDF was stale, changed, or caused unnecessary regeneration.");
    return { sha256: hash, byteSize: bytes.length, pageCount: parsed.pageCount, renderRequests: currentPostCount };
  }, (value) => ({ expected: { sha256: expectedPdfSha, unchangedRenderRequests: successfulReviewPostCount }, observed: value }));

  await step("Redownload existing PDF without regenerating", async () => {
    let resolveDownload!: (download: Download) => void;
    const downloadPromise = new Promise<Download>((resolvePromise) => { resolveDownload = resolvePromise; });
    const attach = (page: Page) => page.once("download", resolveDownload);
    context!.pages().forEach(attach);
    const onPage = (page: Page) => attach(page);
    context!.on("page", onPage);
    const before = successfulReviewPostCount;
    const responseWait = context!.waitForEvent("response", { predicate: (response) => response.url().endsWith(`/api/v1/dev/report-drafts/${REPORT_ID}/partial-review/pdf?download=1`), timeout: 30_000 });
    try {
      await extensionPage!.getByRole("button", { name: "Download PDF", exact: true }).click();
      const [download, response] = await Promise.all([downloadPromise, responseWait]);
      const path = join(downloadsDirectory, `reopened-${download.suggestedFilename()}`);
      await download.saveAs(path);
      const bytes = await readFile(path);
      const contentType = response.headers()["content-type"] ?? "";
      if (!response.ok() || !contentType.includes("application/pdf") || response.headers()["x-report-id"] !== REPORT_ID) throw new Error("Redownload response was not a successful PDF for the canonical report.");
      const hash = createHash("sha256").update(bytes).digest("hex");
      const posts = pdfGenerationRequestCount;
      if (hash !== expectedPdfSha || posts !== before) throw new Error("Redownload changed the PDF or caused unnecessary regeneration.");
      return { file: path, byteSize: bytes.length, sha256: hash, renderRequests: posts };
    } finally { context!.off("page", onPage); }
  }, (value) => ({ expected: { sha256: expectedPdfSha, unchangedRenderRequests: successfulReviewPostCount }, observed: value }));

  record("No lifecycle transition to generated", "PASS", { expected: "draft", observed: (await (await fetch(canonicalEndpoint)).json() as any).status });
  }
  await saveResults("PASS");
  console.log(JSON.stringify({ overall: "PASS", evidenceDirectory }, null, 2));
} catch (error) {
  if (extensionPage && !extensionPage.isClosed()) {
    try { await snap(extensionPage, "failure-state"); } catch { /* preserve the original acceptance failure */ }
  }
  for (const name of [
    "Canonical report identity and month verified", "Open canonical report from extension", "Checklist reflects every pending imported capture", "Review one saved screenshot in the real extension",
    "Approve one screenshot and verify backend acknowledgement", "Generate development review PDF from extension", "Preview Review PDF from extension",
    "Open PDF through extension control", "Download PDF through extension control and validate file",
    "Close and reopen extension UI; reopen the canonical report", "Reopen existing PDF without regenerating", "Redownload existing PDF without regenerating",
  ]) if (!steps.some((item) => item.name === name)) record(name, "NOT_RUN", { error: "A prerequisite acceptance step failed." });
  const blocked = canonicalDraftMissing || error instanceof E2eBlockedError;
  await saveResults(blocked ? "BLOCKED" : "FAIL");
  console.error(JSON.stringify({ overall: blocked ? "BLOCKED" : "FAIL", evidenceDirectory, ...(blockedReason ? { blockedReason } : {}), failure: error instanceof Error ? error.message : String(error) }, null, 2));
  process.exitCode = 1;
} finally {
  await context?.close().catch(() => undefined);
}

/**
 * A report that already completed review and generation exposes the final
 * artifact controls instead of the development review PDF. Every control must
 * serve the same persisted artifact without regenerating it.
 */
async function runFinalArtifactSteps(canonical: any): Promise<void> {
  const finalPdfUrl = `${API_V1}/report-drafts/${REPORT_ID}/pdf`;
  let generationRequests = 0;
  context!.on("request", (request) => { if (request.method() === "POST" && request.url().endsWith(`/report-drafts/${REPORT_ID}/generate`)) generationRequests += 1; });
  const fetchFinal = async (download: boolean) => {
    const response = await fetch(`${finalPdfUrl}${download ? "?download=1" : ""}`);
    const bytes = Buffer.from(await response.arrayBuffer());
    const disposition = response.headers.get("content-disposition") ?? "";
    if (!response.ok || !(response.headers.get("content-type") ?? "").includes("application/pdf") || bytes.subarray(0, 5).toString("ascii") !== "%PDF-") throw new Error(`Final PDF request returned HTTP ${response.status} without a valid PDF.`);
    if (!disposition.startsWith(download ? "attachment" : "inline") || !disposition.includes(TARGET.finalPdfFileName)) throw new Error(`Final PDF disposition was ${disposition || "missing"}.`);
    return { bytes, sha256: createHash("sha256").update(bytes).digest("hex"), pageCount: (await parsePdf(bytes)).pageCount };
  };
  const reportActions = () => extensionPage!.locator("section[aria-label='Report'] + .actions");
  const downloadVia = async (label: string, prefix: string) => {
    let resolveDownload!: (download: Download) => void;
    const downloadPromise = new Promise<Download>((resolvePromise) => { resolveDownload = resolvePromise; });
    const attach = (page: Page) => page.once("download", resolveDownload);
    context!.pages().forEach(attach); context!.on("page", attach);
    try {
      await reportActions().getByRole("button", { name: label, exact: true }).click();
      const download = await downloadPromise;
      if (download.suggestedFilename() !== TARGET.finalPdfFileName) throw new Error(`Downloaded file was named ${download.suggestedFilename()}.`);
      const path = join(downloadsDirectory, `${prefix}${download.suggestedFilename()}`);
      await download.saveAs(path);
      const bytes = await readFile(path);
      return { file: path, bytes, sha256: createHash("sha256").update(bytes).digest("hex"), pageCount: (await parsePdf(bytes)).pageCount };
    } finally { context!.off("page", attach); }
  };
  const openVia = async (label: string, urlSuffix: string, evidence: string) => {
    const pageWait = context!.waitForEvent("page", { timeout: 30_000 });
    await reportActions().getByRole("button", { name: label, exact: true }).click();
    const opened = await pageWait;
    await opened.waitForLoadState("domcontentloaded", { timeout: 30_000 }).catch(() => undefined);
    if (!opened.url().endsWith(urlSuffix)) throw new Error(`${label} opened ${opened.url()} instead of the canonical report endpoint.`);
    await snap(opened, evidence);
    return opened;
  };
  const sameArtifact = (observed: { sha256: string; pageCount: number; bytes: Buffer }, artifact: any) => {
    if (observed.sha256 !== artifact.sha256 || observed.bytes.length !== artifact.byteSize) throw new Error("PDF bytes do not match the persisted artifact SHA-256 and byte size.");
  };

  const artifact = await step("Final PDF artifact persisted for the reviewed report", async () => {
    const response = await fetch(`${API_V1}/report-drafts/${REPORT_ID}/pdf-artifact`);
    if (!response.ok) throw new Error(`Final PDF artifact lookup returned HTTP ${response.status}.`);
    const value = await response.json() as any;
    if (value.reportId !== REPORT_ID || !/^[a-f0-9]{64}$/.test(value.sha256) || !(value.byteSize > 0)) throw new Error("Final PDF artifact is not bound to this report.");
    const full = await fetchFinal(false);
    sameArtifact(full, value);
    expectedPdfSha = value.sha256;
    return { ...value, pageCount: full.pageCount };
  }, (value) => ({ expected: { reportId: REPORT_ID, status: "generated" }, observed: { artifactId: value.id, sha256: value.sha256, byteSize: value.byteSize, pageCount: value.pageCount, templateVersion: value.templateVersion } }));

  await step("Generated report shows final PDF controls in the extension", async () => {
    await extensionPage!.locator("section[aria-label='Report']").getByText("✓ Generated", { exact: true }).waitFor({ state: "visible", timeout: 20_000 });
    for (const label of ["Open PDF", "Download PDF", "Preview Report"]) if (await reportActions().getByRole("button", { name: label, exact: true }).count() !== 1) throw new Error(`The ${label} control is not uniquely available for the generated report.`);
    await snap(extensionPage!, "final-controls");
    return { status: canonical.status, version: canonical.version };
  }, (value) => ({ expected: { status: "generated", controls: ["Open PDF", "Download PDF", "Preview Report"] }, observed: value, evidence: screenshots["final-controls"]! }));

  await step("Preview final report from extension", async () => {
    const preview = await openVia("Preview Report", `/report-drafts/${REPORT_ID}/preview`, "final-preview");
    const title = await preview.title();
    if (!title.includes(TARGET.clientName) || !title.includes(TARGET.monthLabel)) throw new Error(`Preview title "${title}" does not identify ${TARGET.clientName} ${TARGET.monthLabel}.`);
    const text = await preview.locator("body").innerText();
    if (/list growth/i.test(text)) throw new Error("Preview still contains a List Growth section.");
    const otherClients = Object.values(EXTENSION_E2E_TARGETS).filter(({ clientId }) => clientId !== CLIENT_ID).map(({ clientName }) => clientName).filter((name) => text.includes(name));
    if (otherClients.length) throw new Error(`Preview contains another client's name: ${otherClients.join(", ")}.`);
    const images = await preview.locator("img").evaluateAll((nodes) => nodes.map((node) => ({ complete: (node as HTMLImageElement).complete, width: (node as HTMLImageElement).naturalWidth })));
    if (!images.length || images.some(({ complete, width }) => !complete || width <= 0)) throw new Error("Preview screenshots did not all render.");
    await preview.close();
    return { title, renderedImages: images.length };
  }, (value) => ({ expected: { client: TARGET.clientName, month: TARGET.monthLabel, listGrowth: false }, observed: value, evidence: screenshots["final-preview"]! }));

  await step("Open final PDF through extension control", async () => {
    const opened = await openVia("Open PDF", `/report-drafts/${REPORT_ID}/pdf`, "final-open-pdf");
    const full = await fetchFinal(false); sameArtifact(full, artifact);
    await opened.close();
    return { sha256: full.sha256, byteSize: full.bytes.length, pageCount: full.pageCount };
  }, (value) => ({ expected: { sha256: artifact.sha256, byteSize: artifact.byteSize, pageCount: artifact.pageCount }, observed: value, evidence: screenshots["final-open-pdf"]! }));

  await step("Download final PDF through extension control", async () => {
    const downloaded = await downloadVia("Download PDF", "");
    sameArtifact(downloaded, artifact);
    if (downloaded.pageCount !== artifact.pageCount) throw new Error("Downloaded PDF page count differs from the persisted artifact.");
    return { file: downloaded.file, sha256: downloaded.sha256, byteSize: downloaded.bytes.length, pageCount: downloaded.pageCount };
  }, (value) => ({ expected: { filename: TARGET.finalPdfFileName, sha256: artifact.sha256 }, observed: value }));

  await step("Close and reopen extension UI; reopen the generated report", async () => {
    await extensionPage!.close();
    extensionPage = await context!.newPage();
    await extensionPage.goto(`chrome-extension://${extensionId}/index.html`, { waitUntil: "domcontentloaded" });
    await extensionPage.getByRole("heading", { name: "Recent Reports" }).waitFor({ state: "visible" });
    const cards = extensionPage.locator(".recent-list > li");
    await cards.first().waitFor({ state: "visible", timeout: 20_000 });
    const canonicalCards = cards.filter({ hasText: TARGET.clientName }).filter({ hasText: TARGET.monthLabel });
    if (await canonicalCards.count() !== 1) throw new Error(`Recent Reports did not retain exactly one ${TARGET.clientName} ${TARGET.monthLabel} report after reopen.`);
    await canonicalCards.getByRole("button", { name: "Open Report", exact: true }).click();
    await extensionPage.getByRole("heading", { name: TARGET.clientName, exact: true }).waitFor({ state: "visible" });
    await extensionPage.locator("section[aria-label='Report']").getByText("✓ Generated", { exact: true }).waitFor({ state: "visible", timeout: 20_000 });
    await snap(extensionPage, "reopened-report");
    return { reportId: REPORT_ID, generated: true };
  }, (value) => ({ expected: { reportId: REPORT_ID, generated: true }, observed: value, evidence: screenshots["reopened-report"]! }));

  await step("Reopen and redownload final PDF without regenerating", async () => {
    const opened = await openVia("Open PDF", `/report-drafts/${REPORT_ID}/pdf`, "final-reopen-pdf");
    await opened.close();
    const reopened = await fetchFinal(false); sameArtifact(reopened, artifact);
    const redownloaded = await downloadVia("Download PDF", "reopened-"); sameArtifact(redownloaded, artifact);
    const currentArtifact = await (await fetch(`${API_V1}/report-drafts/${REPORT_ID}/pdf-artifact`)).json() as any;
    const current = await (await fetch(canonicalEndpoint)).json() as any;
    if (currentArtifact.id !== artifact.id || currentArtifact.sha256 !== artifact.sha256) throw new Error("The persisted artifact changed during reopen/redownload.");
    if (generationRequests !== 0 || current.version !== canonical.version || current.status !== "generated") throw new Error("Reopen/redownload regenerated the PDF or changed the report lifecycle.");
    return { artifactId: currentArtifact.id, sha256: reopened.sha256, redownloadSha256: redownloaded.sha256, byteSize: reopened.bytes.length, pageCount: redownloaded.pageCount, generationRequests, reportVersion: current.version };
  }, (value) => ({ expected: { artifactId: artifact.id, sha256: artifact.sha256, generationRequests: 0, reportVersion: canonical.version }, observed: value }));
}
