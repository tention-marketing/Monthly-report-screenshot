import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { deriveClientId } from "@tention/report-domain";
import {
  createScreenshotSourceProof, matchesReportCaptureSpec, reportCaptureSpecByScreenshotType,
  type ReportPeriod, type ScreenshotType,
} from "@tention/report-schema";
import { getReportPeriod } from "@tention/report-core";
import { inspectPng } from "../storage/png.js";

export const LIVE_ACCEPTANCE_IMPORT_TYPES = [
  "overview", "month_comparison", "top_campaigns", "top_flows", "campaign_performance",
  "campaign_metrics", "flow_performance", "flow_metrics", "deliverability",
] as const satisfies readonly ScreenshotType[];

export interface LocalAcceptanceClient {
  name: string;
  timezone: string;
  overviewUrl: string;
  campaignsUrl?: string;
  businessReviewUrl: string;
  signupFormsUrl?: string;
  flowsUrl?: string;
  segmentsUrl?: string;
  deliverabilityUrl?: string;
  signupForms?: { mode: "all" | "configured"; ids: string[]; names: string[] };
  welcomeFlowListing?: { mode: "email_welcome_flows"; flows: Array<{ id: string; name: string; channel: "email" }> };
  customerSegment?: { id?: string; name?: string };
  nonCustomerSegment?: { id?: string; name?: string };
}

export interface VerifiedLiveAcceptanceCapture {
  type: ScreenshotType;
  sourceUrl: string;
  sourceIdentity: string;
  sourceProof: ReturnType<typeof createScreenshotSourceProof>;
  byteSize: number;
  sha256: string;
  width: number;
  height: number;
  bytes: Buffer;
}

export interface VerifiedLiveAcceptanceRun {
  directory: string;
  client: { id: string; name: string; timezone: string };
  reportMonth: { year: number; month: number };
  period: ReportPeriod;
  captures: VerifiedLiveAcceptanceCapture[];
  missingTypes: ScreenshotType[];
}

/** Independently verifies successful local live-run files before they can enter report persistence. */
export async function verifyLatestLiveAcceptanceRun(
  root: string,
  clientId: string,
  reportMonth: { year: number; month: number },
  captureTypes: readonly ScreenshotType[] = LIVE_ACCEPTANCE_IMPORT_TYPES,
): Promise<VerifiedLiveAcceptanceRun> {
  if (!captureTypes.length || captureTypes.some((type) => !LIVE_ACCEPTANCE_IMPORT_TYPES.includes(type as typeof LIVE_ACCEPTANCE_IMPORT_TYPES[number]))) throw new Error("Requested live acceptance import types are invalid.");
  const scoreOnly = captureTypes.length === 1 && captureTypes[0] === "deliverability";
  const singleSection = captureTypes.length === 1 && !scoreOnly ? captureTypes[0]! : null;
  const expectedStatus = scoreOnly ? "DELIVERABILITY_SCORE_PASS" : singleSection ? "SINGLE_SECTION_PASS" : "PARTIAL_PASS_MANUAL_EVIDENCE_REQUIRED";
  const config = await readLocalClient(root, clientId);
  const period = getReportPeriod(reportMonth);
  const acceptanceRoot = join(root, "output/local-acceptance");
  const directories = (await readdir(acceptanceRoot, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory()).map(({ name }) => name).sort().reverse();
  let latestFailure = "No successful matching live acceptance run was found.";
  for (const name of directories) {
    const directory = join(acceptanceRoot, name);
    try {
      const results = JSON.parse(await readFile(join(directory, "results.json"), "utf8")) as Record<string, any>;
      if (results.status !== expectedStatus || (singleSection && results.requestedSection !== singleSection)) continue;
      assert(results.client?.id === clientId && results.client?.name === config.name && results.client?.timezone === config.timezone, "live run client identity does not match local client configuration");
      assert(results.month?.year === reportMonth.year && results.month?.month === reportMonth.month, "live run month does not match the requested report month");
      assert(results.period?.startDate === period.startDate && results.period?.endDate === period.endDate
        && results.period?.previousStartDate === period.previousStartDate && results.period?.previousEndDate === period.previousEndDate,
      "live run current or previous period does not match the exact calendar month");
      assert(Array.isArray(results.automatedSections) && results.automatedSections.length === captureTypes.length, "live run is missing one or more requested automatic sections");
      assert(Array.isArray(results.duplicateHashes) && results.duplicateHashes.length === 0, "live run reports duplicate screenshot hashes");
      const hashes = new Set<string>();
      const byKey = new Map<string, Record<string, any>>();
      for (const entry of results.automatedSections) {
        assert(entry && typeof entry.key === "string" && !byKey.has(entry.key), "live run contains a malformed or duplicate screenshot section");
        byKey.set(entry.key, entry);
      }
      const dateEvidence = scoreOnly ? null : await verifyRenderedPeriodEvidence(directory, period);
      const captures: VerifiedLiveAcceptanceCapture[] = [];
      for (const type of captureTypes) {
        const result = byKey.get(type);
        assert(result?.ok === true, `${type} did not pass live acceptance`);
        assert(typeof result.sha256 === "string" && /^[a-f0-9]{64}$/.test(result.sha256), `${type} acceptance hash is malformed`);
        assert(!hashes.has(result.sha256), `${type} duplicates another screenshot hash`);
        hashes.add(result.sha256);
        const diagnostic = JSON.parse(await readFile(join(directory, `${type}-diagnostics.json`), "utf8")) as Record<string, any>;
        const spec = reportCaptureSpecByScreenshotType[type];
        assert(diagnostic.canonicalSourceIdentity === spec.sourceIdentity, `${type} canonical source identity does not match the capture specification`);
        if (type === "top_campaigns") assert(Number.isInteger(diagnostic.includedRowCount) && diagnostic.includedRowCount >= 1 && diagnostic.includedRowCount <= 3 && diagnostic.usableRowCount >= diagnostic.includedRowCount, "Top Campaigns must contain every available eligible Sent campaign up to three");
        if (type === "top_flows") {
          // Top 5 Flows: the first five usable rows, or every usable row when 1-4 exist. Zero rows never passes.
          assert(Number.isInteger(diagnostic.usableRowCount) && diagnostic.usableRowCount >= 1 && diagnostic.includedRowCount === Math.min(5, diagnostic.usableRowCount), "Top Flows must contain exactly the first min(5, usable) rows and at least one usable row");
          assert(Array.isArray(diagnostic.rankedRows) && diagnostic.rankedRows.length === diagnostic.includedRowCount && diagnostic.rankedRows.every((row: any) => Array.isArray(row?.cells) && row.cells.length >= 3 && typeof row.cells[0] === "string" && row.cells[0].length > 0), "Top Flows must record the text of every captured ranked row");
          assert(diagnostic.renderStability?.identicalCaptures >= 3, "Top Flows screenshot lacks render-stability proof");
        }
        assert(JSON.stringify(diagnostic.expectedPeriod) === JSON.stringify(expectedProofPeriod(type, period)), `${type} expected period proof is malformed or stale`);
        if (type === "deliverability") {
          assert(diagnostic.semanticEvidence?.rollingThirtyDays === true && diagnostic.semanticEvidence?.scoreGauge === true && diagnostic.semanticEvidence?.rateTable === true && diagnostic.semanticEvidence?.actionCenterExcluded === true, "Deliverability Score lacks rolling-window, gauge, rate-table, or Action Center exclusion evidence");
        }
        const sourceUrl = expectedSourceUrl(config, type);
        assert(diagnostic.sourceUrl === sourceUrl, `${type} source URL does not match the configured client source`);
        assert(diagnostic.screenshot?.file === `${type}.png` && diagnostic.screenshot.sha256 === result.sha256 && diagnostic.screenshot.byteSize === result.byteSize, `${type} result metadata differs from its diagnostic proof`);
        const bytes = await readFile(join(directory, `${type}.png`));
        assert(bytes.length === result.byteSize && createHash("sha256").update(bytes).digest("hex") === result.sha256, `${type} screenshot bytes do not match the recorded SHA-256`);
        const dimensions = inspectPng(bytes);
        const sourceProof = createScreenshotSourceProof(type, period, undefined, type === "top_campaigns" ? diagnostic.campaigns ?? null : null);
        assert(matchesReportCaptureSpec(type, sourceProof), `${type} generated source proof does not match the canonical capture specification`);
        assert(JSON.stringify(sourceProof.expectedPeriod) === JSON.stringify(expectedProofPeriod(type, period)), `${type} source proof period is invalid`);
        if (type !== "deliverability") assert(dateEvidence?.hasAll(type, type === "month_comparison" ? [period.startDate, period.endDate, period.previousStartDate, period.previousEndDate] : [period.startDate, period.endDate]), `${type} lacks exact rendered date evidence`);
        captures.push({ type, sourceUrl, sourceIdentity: spec.sourceIdentity, sourceProof, byteSize: bytes.length, sha256: result.sha256, ...dimensions, bytes });
      }
      return {
        directory, client: { id: clientId, name: config.name, timezone: config.timezone }, reportMonth, period,
        captures, missingTypes: ["signup_form", "welcome_flow", "customer_split"],
      };
    } catch (error) {
      latestFailure = error instanceof Error ? error.message : "Live acceptance artifact verification failed.";
    }
  }
  throw new Error(latestFailure);
}

export async function readLocalClient(root: string, clientId: string): Promise<LocalAcceptanceClient> {
  const parsed = JSON.parse(await readFile(join(root, "data/local-clients.json"), "utf8")) as { clients?: LocalAcceptanceClient[] };
  assert(Array.isArray(parsed.clients), "local client configuration is malformed");
  const matches = parsed.clients.filter((client) => deriveClientId(client.name) === clientId);
  assert(matches.length === 1, "local client configuration must contain exactly one matching stable client ID");
  const client = matches[0]!;
  assert(client.name.trim().length > 0 && client.timezone.trim().length > 0, "local client configuration is missing a client name or timezone");
  return client;
}

function expectedProofPeriod(type: ScreenshotType, period: ReportPeriod): Record<string, string> | null {
  if (type === "deliverability") return null;
  if (type === "month_comparison") return { startDate: period.startDate, endDate: period.endDate, comparisonStartDate: period.previousStartDate, comparisonEndDate: period.previousEndDate };
  return { startDate: period.startDate, endDate: period.endDate };
}

function expectedSourceUrl(client: LocalAcceptanceClient, type: ScreenshotType): string {
  const sourceKey = reportCaptureSpecByScreenshotType[type].sourceUrlKey;
  const url = sourceKey === "overviewUrl" ? client.overviewUrl : sourceKey === "campaignsUrl" ? client.campaignsUrl : sourceKey === "deliverabilityUrl" ? client.deliverabilityUrl : client.businessReviewUrl;
  assert(typeof url === "string" && isSafeKlaviyoUrl(url), `${type} configured source URL is missing or unsafe`);
  return url;
}

async function verifyRenderedPeriodEvidence(directory: string, period: ReportPeriod) {
  const evidenceByType = new Map<ScreenshotType, Set<string>>();
  for (const [type, file] of [["overview", "overview-date-applied-diagnostics.json"], ["month_comparison", "business-review-date-applied-diagnostics.json"]] as const) {
    const evidence = JSON.parse(await readFile(join(directory, file), "utf8")) as Record<string, any>;
    assert(evidence.expectedPeriod?.startDate === period.startDate && evidence.expectedPeriod?.endDate === period.endDate, `${type} applied-date diagnostic is stale`);
    assert(Array.isArray(evidence.observedDateStrings), `${type} applied-date diagnostic has no rendered date observations`);
    const strings = new Set(evidence.observedDateStrings.filter((value: unknown): value is string => typeof value === "string"));
    evidenceByType.set(type, strings);
  }
  const overview = evidenceByType.get("overview")!;
  const businessReview = evidenceByType.get("month_comparison")!;
  assert(overview.has(formatDate(period.startDate)) && overview.has(formatDate(period.endDate)), "overview rendered period does not match the report month");
  assert(businessReview.has(formatDate(period.startDate)) && businessReview.has(formatDate(period.endDate))
    && businessReview.has(formatDate(period.previousStartDate)) && businessReview.has(formatDate(period.previousEndDate)),
  "Business Review did not render exact current and previous calendar periods");
  // Home cards (Executive Summary, Top performing flows) are proven by the Home Time period; the rest by Business Review.
  return { hasAll: (type: ScreenshotType, dates: string[]) => dates.every((date) => (reportCaptureSpecByScreenshotType[type].sourceFamily === "klaviyo-home" ? overview : businessReview).has(formatDate(date))) };
}

function formatDate(value: string): string {
  return new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" }).format(new Date(`${value}T00:00:00Z`));
}
function isSafeKlaviyoUrl(value: string): boolean {
  try { const url = new URL(value); return url.protocol === "https:" && (url.hostname === "www.klaviyo.com" || url.hostname === "klaviyo.com") && !url.username && !url.password; }
  catch { return false; }
}
function assert(condition: unknown, message: string): asserts condition { if (!condition) throw new Error(message); }
