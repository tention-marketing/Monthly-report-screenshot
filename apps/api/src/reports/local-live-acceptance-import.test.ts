import { createHash } from "node:crypto";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { applyReportEvent, deriveClientId, upsertScreenshotMetadataBatch, InMemoryClientReportTargetsRepository, InMemoryReportDraftRepository } from "@tention/report-domain";
import { LIVE_ACCEPTANCE_IMPORT_TYPES } from "./live-acceptance-artifacts.js";
import { importLatestLiveAcceptance, importLatestLiveDeliverabilityScore, importLatestLiveSection } from "./local-live-acceptance-import.js";
import { InMemoryScreenshotStorage } from "../storage/screenshot-storage.js";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

describe("local live acceptance import bridge", () => {
  it("reconciles isolated verified run files into one canonical pending-review draft", async () => {
    const root = await fixture();
    const repository = new InMemoryReportDraftRepository();
    const targets = new InMemoryClientReportTargetsRepository();
    const screenshotStorage = new InMemoryScreenshotStorage();
    const options = { repository, targetsRepository: targets, screenshotStorage, repositoryRoot: root, now: () => new Date("2026-10-08T12:00:00.000Z"), clientId: "autoledtech", reportMonth: { year: 2026, month: 8 } };

    const imported = await importLatestLiveAcceptance(options);
    const repeated = await importLatestLiveAcceptance(options);
    const drafts = await repository.list();
    expect(drafts).toHaveLength(1);
    expect(imported.reportId).toBe(drafts[0]!.id);
    expect(repeated.reportId).toBe(imported.reportId);
    expect(imported).toMatchObject({ importedCaptureCount: 9, pendingReviewCount: 9, reusedCaptureCount: 0 });
    expect(repeated).toMatchObject({ importedCaptureCount: 0, pendingReviewCount: 9, reusedCaptureCount: 9 });
    expect(drafts[0]!.client).toMatchObject({ id: "autoledtech", name: "AutoLEDTech.com", timezone: "America/New_York" });
    expect(drafts[0]!.screenshots).toHaveLength(9);
    expect(drafts[0]!.screenshots.every((capture) => capture.captureOrigin === "live_acceptance_import" && !capture.approved && capture.approvedAt === null)).toBe(true);
    expect((await targets.get("autoledtech")).signupForms?.mode).toBe("all");
    expect((await targets.get("autoledtech")).welcomeFlowListing?.flows.map(({ id }) => id)).toEqual(["WN2GLE", "Rex4Pp"]);
  });

  it("creates this client's own draft and leaves another client's existing report untouched", async () => {
    const root = await fixture();
    const repository = new InMemoryReportDraftRepository();
    const { createReportDraft } = await import("@tention/report-domain");
    await repository.create(createReportDraft({
      client: { id: "someone-else", name: "Another Client", timezone: "America/New_York", currency: null },
      reportMonth: { year: 2026, month: 7 }, sections: { executive_summary: "optional" },
    }, { now: new Date("2026-10-08T12:00:00.000Z"), id: "f577d631-a1f6-4cc0-9052-68e30460876d" }));
    const options = { repository, targetsRepository: new InMemoryClientReportTargetsRepository(), screenshotStorage: new InMemoryScreenshotStorage(), repositoryRoot: root, now: () => new Date("2026-10-08T12:00:00.000Z"), clientId: "autoledtech", reportMonth: { year: 2026, month: 8 } };

    const imported = await importLatestLiveAcceptance(options);
    const drafts = await repository.list();
    expect(drafts).toHaveLength(2);
    expect(imported.reportId).not.toBe("f577d631-a1f6-4cc0-9052-68e30460876d");
    expect(drafts.find(({ id }) => id === "f577d631-a1f6-4cc0-9052-68e30460876d")).toMatchObject({ client: { id: "someone-else" }, screenshots: [] });
  });
  it("imports Club Furniture evidence through the same generic bridge without an account-specific source branch", async () => {
    const client = { name: "Club Furniture", timezone: "America/New_York", overviewUrl: "https://www.klaviyo.com/dashboard", campaignsUrl: "https://www.klaviyo.com/omnicampaigns?appBarNav=true", businessReviewUrl: "https://www.klaviyo.com/analytics/dashboards/01H2XYS7EKZT3VVQYBQ19GTVW1", deliverabilityUrl: "https://www.klaviyo.com/analytics/deliverability/email/score" };
    const root = await fixture(client);
    const repository = new InMemoryReportDraftRepository();
    const imported = await importLatestLiveAcceptance({ repository, targetsRepository: new InMemoryClientReportTargetsRepository(), screenshotStorage: new InMemoryScreenshotStorage(), repositoryRoot: root, now: () => new Date("2026-10-25T12:00:00.000Z"), clientId: "club-furniture", reportMonth: { year: 2026, month: 8 } });
    const saved = await repository.getById(imported.reportId);
    expect(saved).toMatchObject({ client: { id: "club-furniture", name: "Club Furniture", timezone: "America/New_York" }, reportMonth: { year: 2026, month: 8 } });
    expect(saved?.screenshots.find(({ type }) => type === "deliverability")).toMatchObject({ sourceUrl: client.deliverabilityUrl, sourceProof: { sourceIdentity: "klaviyo-deliverability|deliverability-score|email" } });
  });

  it("replaces only stale Deliverability evidence from a single-score run and keeps other captures untouched", async () => {
    const root = await fixture();
    const repository = new InMemoryReportDraftRepository();
    const storage = new InMemoryScreenshotStorage();
    const options = { repository, targetsRepository: new InMemoryClientReportTargetsRepository(), screenshotStorage: storage, repositoryRoot: root, now: () => new Date("2026-10-26T04:35:00.000Z"), clientId: "autoledtech", reportMonth: { year: 2026, month: 8 } };
    const initial = await importLatestLiveAcceptance(options);
    const before = await repository.getById(initial.reportId);
    const priorOverview = before!.screenshots.find(({ type }) => type === "overview")!;
    await scoreOnlyFixture(root, "AutoLEDTech.com");

    const replacement = await importLatestLiveDeliverabilityScore(options);
    const after = await repository.getById(initial.reportId);
    const score = after!.screenshots.find(({ type }) => type === "deliverability")!;
    expect(replacement).toMatchObject({ importedCaptureCount: 1, importedTypes: expect.arrayContaining(["deliverability"]) });
    expect(after!.screenshots.find(({ type }) => type === "overview")).toMatchObject({ id: priorOverview.id, sha256: priorOverview.sha256 });
    expect(score).toMatchObject({ approved: false, captureOrigin: "live_acceptance_import", sourceProof: { sourceIdentity: "klaviyo-deliverability|deliverability-score|email", expectedPeriod: null, observedPeriod: null } });
    expect(score.sha256).not.toBe(before!.screenshots.find(({ type }) => type === "deliverability")!.sha256);
  });

  it("corrects Deliverability on a report already in review and sends it back through capture review", async () => {
    const root = await fixture();
    const repository = new InMemoryReportDraftRepository();
    const options = { repository, targetsRepository: new InMemoryClientReportTargetsRepository(), screenshotStorage: new InMemoryScreenshotStorage(), repositoryRoot: root, now: () => new Date("2026-10-26T04:35:00.000Z"), clientId: "autoledtech", reportMonth: { year: 2026, month: 8 } };
    const initial = await importLatestLiveAcceptance(options);
    const pending = (await repository.getById(initial.reportId))!;
    const reviewed = await repository.save(upsertScreenshotMetadataBatch(pending, pending.screenshots.map((shot) => ({ ...shot, approved: true, approvedAt: "2026-10-26T04:35:00.000Z" })), { now: options.now() }), pending.version);
    await repository.saveWithLifecycleEvent(applyReportEvent(reviewed, "SUBMIT_FOR_REVIEW", { now: options.now() }), reviewed.version, "SUBMIT_FOR_REVIEW");
    await expect(importLatestLiveAcceptance(options)).rejects.toThrow(/state draft/);

    await scoreOnlyFixture(root, "AutoLEDTech.com");
    await importLatestLiveDeliverabilityScore(options);
    const after = (await repository.getById(initial.reportId))!;
    expect(after.status).toBe("captures_incomplete");
    expect(after.screenshots.find(({ type }) => type === "deliverability")).toMatchObject({ approved: false, sourceProof: { sourceIdentity: "klaviyo-deliverability|deliverability-score|email" } });
  });

  it("replaces only Top Flows in a generated report, keeps the other eight byte-identical, and invalidates the prior PDF", async () => {
    const root = await fixture();
    const repository = new InMemoryReportDraftRepository();
    const options = { repository, targetsRepository: new InMemoryClientReportTargetsRepository(), screenshotStorage: new InMemoryScreenshotStorage(), repositoryRoot: root, now: () => new Date("2026-10-26T04:35:00.000Z"), clientId: "autoledtech", reportMonth: { year: 2026, month: 8 } };
    const initial = await importLatestLiveAcceptance(options);
    const pending = (await repository.getById(initial.reportId))!;
    const reviewed = await repository.save(upsertScreenshotMetadataBatch(pending, pending.screenshots.map((shot) => ({ ...shot, approved: true, approvedAt: "2026-10-26T04:35:00.000Z" })), { now: options.now() }), pending.version);
    const submitted = await repository.saveWithLifecycleEvent(applyReportEvent(reviewed, "SUBMIT_FOR_REVIEW", { now: options.now() }), reviewed.version, "SUBMIT_FOR_REVIEW");
    const generating = await repository.saveWithLifecycleEvent(applyReportEvent(submitted, "START_GENERATION", { now: options.now() }), submitted.version, "START_GENERATION");
    const generated = await repository.saveWithLifecycleEvent(applyReportEvent(generating, "GENERATION_SUCCEEDED", { now: options.now() }), generating.version, "GENERATION_SUCCEEDED");
    expect(generated.status).toBe("generated");

    await singleSectionFixture(root, "AutoLEDTech.com", "top_flows", "deliverability");
    await expect(importLatestLiveSection(options, "top_flows")).rejects.toThrow();
    await singleSectionFixture(root, "AutoLEDTech.com", "top_flows");
    await expect(importLatestLiveSection(options, "top_campaigns")).rejects.toThrow();
    const result = await importLatestLiveSection(options, "top_flows");
    const after = (await repository.getById(initial.reportId))!;
    expect(result.importedCaptureCount).toBe(1);
    expect(after.status).toBe("captures_incomplete");
    expect(after.screenshots).toHaveLength(9);
    for (const prior of generated.screenshots.filter(({ type }) => type !== "top_flows")) {
      expect(after.screenshots.find(({ type }) => type === prior.type)).toEqual(prior);
    }
    const flows = after.screenshots.find(({ type }) => type === "top_flows")!;
    expect(flows).toMatchObject({ approved: false, approvedAt: null, captureOrigin: "live_acceptance_import" });
    expect(flows.sha256).not.toBe(generated.screenshots.find(({ type }) => type === "top_flows")!.sha256);
  });

  it("imports a Top Flows capture of the real 1-4 rows and rejects zero rows or a padded count", async () => {
    const root = await fixture();
    const repository = new InMemoryReportDraftRepository();
    const options = { repository, targetsRepository: new InMemoryClientReportTargetsRepository(), screenshotStorage: new InMemoryScreenshotStorage(), repositoryRoot: root, now: () => new Date("2026-10-26T04:35:00.000Z"), clientId: "autoledtech", reportMonth: { year: 2026, month: 8 } };
    await importLatestLiveAcceptance(options);
    await singleSectionFixture(root, "AutoLEDTech.com", "top_flows", "top_flows", { usable: 0, included: 0 });
    await expect(importLatestLiveSection(options, "top_flows")).rejects.toThrow(/Top Flows/);
    await singleSectionFixture(root, "AutoLEDTech.com", "top_flows", "top_flows", { usable: 3, included: 5 });
    await expect(importLatestLiveSection(options, "top_flows")).rejects.toThrow(/Top Flows/);
    await singleSectionFixture(root, "AutoLEDTech.com", "top_flows", "top_flows", { usable: 3, included: 3 });
    await expect(importLatestLiveSection(options, "top_flows")).resolves.toMatchObject({ importedCaptureCount: 1 });
  });
});

function topFlowsEvidence(count = 5) {
  const trends = (["positive", "negative", "neutral", null, "positive"] as const).slice(0, count);
  return {
    rankedRows: trends.map((trend, index) => ({ cells: [`Fixture Flow ${index + 1}`, `$${(5 - index) * 1000}.00`, `${(5 - index) * 10}%`], trend })),
    renderStability: { attempts: 3, identicalCaptures: 3 },
  };
}

async function singleSectionFixture(root: string, clientName: string, type: "top_flows", claimedSection: string = type, rows = { usable: 5, included: 5 }): Promise<void> {
  const run = join(root, "output/local-acceptance/2026-10-26T06-00-00-000Z");
  await mkdir(run, { recursive: true });
  const bytes = png(77); const sha256 = createHash("sha256").update(bytes).digest("hex");
  const period = { startDate: "2026-08-01", endDate: "2026-08-31", previousStartDate: "2026-07-01", previousEndDate: "2026-07-31" };
  const client = { id: deriveClientId(clientName), name: clientName, timezone: "America/New_York" };
  const spec = (await import("@tention/report-schema")).reportCaptureSpecByScreenshotType[type];
  const observedDateStrings = ["Aug 1, 2026", "Aug 31, 2026", "Jul 1, 2026", "Jul 31, 2026"];
  await writeFile(join(run, `${type}.png`), bytes);
  await writeFile(join(run, `${type}-diagnostics.json`), JSON.stringify({ canonicalSourceIdentity: spec.sourceIdentity, expectedPeriod: { startDate: period.startDate, endDate: period.endDate }, sourceUrl: "https://www.klaviyo.com/dashboard", usableRowCount: rows.usable, includedRowCount: rows.included, ...topFlowsEvidence(rows.included), screenshot: { file: `${type}.png`, byteSize: bytes.length, sha256 } }));
  await writeFile(join(run, "overview-date-applied-diagnostics.json"), JSON.stringify({ expectedPeriod: { startDate: period.startDate, endDate: period.endDate }, observedDateStrings }));
  await writeFile(join(run, "business-review-date-applied-diagnostics.json"), JSON.stringify({ expectedPeriod: { startDate: period.startDate, endDate: period.endDate }, observedDateStrings }));
  await writeFile(join(run, "results.json"), JSON.stringify({ status: "SINGLE_SECTION_PASS", requestedSection: claimedSection, client, month: { year: 2026, month: 8 }, period, automatedSections: [{ key: type, ok: true, sha256, byteSize: bytes.length, usableRowCount: rows.usable, includedRowCount: rows.included }], duplicateHashes: [] }));
}

async function scoreOnlyFixture(root: string, clientName: string): Promise<void> {
  const run = join(root, "output/local-acceptance/2026-10-26T04-32-00-000Z");
  await mkdir(run, { recursive: true });
  const bytes = png(99); const sha256 = createHash("sha256").update(bytes).digest("hex");
  const period = { startDate: "2026-08-01", endDate: "2026-08-31", previousStartDate: "2026-07-01", previousEndDate: "2026-07-31" };
  const client = { id: deriveClientId(clientName), name: clientName, timezone: "America/New_York" };
  await writeFile(join(run, "deliverability.png"), bytes);
  await writeFile(join(run, "deliverability-diagnostics.json"), JSON.stringify({ canonicalSourceIdentity: "klaviyo-deliverability|deliverability-score|email", expectedPeriod: null, sourceUrl: "https://www.klaviyo.com/analytics/deliverability/email/score", semanticEvidence: { rollingThirtyDays: true, scoreGauge: true, rateTable: true, actionCenterExcluded: true }, screenshot: { file: "deliverability.png", byteSize: bytes.length, sha256 } }));
  await writeFile(join(run, "results.json"), JSON.stringify({ status: "DELIVERABILITY_SCORE_PASS", client, month: { year: 2026, month: 8 }, period, automatedSections: [{ key: "deliverability", ok: true, sha256, byteSize: bytes.length }], duplicateHashes: [] }));
}

async function fixture(fixtureClient?: { name: string; timezone: string; overviewUrl: string; campaignsUrl?: string; businessReviewUrl: string; deliverabilityUrl?: string }): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "tention-live-import-")); roots.push(root);
  const client = fixtureClient ?? {
    name: "AutoLEDTech.com", timezone: "America/New_York", overviewUrl: "https://www.klaviyo.com/dashboard",
    businessReviewUrl: "https://www.klaviyo.com/analytics/dashboards/01HWZSHD83RW7CYWQ6EVVQD2BK",
    signupFormsUrl: "https://www.klaviyo.com/forms", flowsUrl: "https://www.klaviyo.com/flows",
    campaignsUrl: "https://www.klaviyo.com/omnicampaigns?appBarNav=true", segmentsUrl: "https://www.klaviyo.com/lists", deliverabilityUrl: "https://www.klaviyo.com/analytics/deliverability/email/score",
    signupForms: { mode: "all", ids: [], names: [] },
    welcomeFlowListing: { mode: "email_welcome_flows", flows: [
      { id: "WN2GLE", name: "BM | Welcome Flow [February Offer A/B Test]", channel: "email" },
      { id: "Rex4Pp", name: "(Instant Audiences) WC | Welcome Flow", channel: "email" },
    ] },
  };
  await mkdir(join(root, "data"), { recursive: true });
  await writeFile(join(root, "data/local-clients.json"), JSON.stringify({ clients: [client] }));
  const run = join(root, "output/local-acceptance/2026-10-08T11-00-00-000Z");
  await mkdir(run, { recursive: true });
  const period = { startDate: "2026-08-01", endDate: "2026-08-31", previousStartDate: "2026-07-01", previousEndDate: "2026-07-31" };
  const automatedSections = [];
  for (const [index, type] of LIVE_ACCEPTANCE_IMPORT_TYPES.entries()) {
    const bytes = png(index + 1);
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const expectedPeriod = type === "deliverability" ? null : type === "month_comparison"
      ? { startDate: period.startDate, endDate: period.endDate, comparisonStartDate: period.previousStartDate, comparisonEndDate: period.previousEndDate }
      : { startDate: period.startDate, endDate: period.endDate };
    const spec = (await import("@tention/report-schema")).reportCaptureSpecByScreenshotType[type];
    const sourceUrl = type === "top_campaigns" ? client.campaignsUrl : spec.sourceUrlKey === "overviewUrl" ? client.overviewUrl : type === "deliverability" ? client.deliverabilityUrl : client.businessReviewUrl;
    await writeFile(join(run, `${type}.png`), bytes);
    await writeFile(join(run, `${type}-diagnostics.json`), JSON.stringify({ canonicalSourceIdentity: spec.sourceIdentity, expectedPeriod, sourceUrl, ...(type === "deliverability" ? { semanticEvidence: { rollingThirtyDays: true, scoreGauge: true, rateTable: true, actionCenterExcluded: true } } : {}), ...(type === "top_campaigns" ? { campaigns: { accountIdentity: client.name, clientTimezone: client.timezone, visibleMetricLabel: "Placed Order", rankingMethod: "complete-result-set", eligibleRowCount: 5, includedRowCount: 5, rows: [1, 2, 3, 4, 5].map((value) => ({ name: `Campaign ${value}`, type: value === 3 ? "SMS" : "Email", status: "Sent", sendDate: `2026-08-0${value}`, openRate: value === 3 ? null : "10%", clickRate: "1%", placedOrderValue: 10 - value })) } } : {}), ...(type === "top_flows" ? topFlowsEvidence() : {}), usableRowCount: type === "top_campaigns" || type === "top_flows" ? 5 : 0, includedRowCount: type === "top_campaigns" ? 3 : type === "top_flows" ? 5 : 0, screenshot: { file: `${type}.png`, byteSize: bytes.length, sha256 } }));
    automatedSections.push({ key: type, ok: true, sha256, byteSize: bytes.length, usableRowCount: type === "top_campaigns" || type === "top_flows" ? 5 : 0, ...(type === "top_campaigns" ? { includedRowCount: 5 } : {}), ...(type === "top_flows" ? { includedRowCount: 5 } : {}) });
  }
  const observedDateStrings = ["Aug 1, 2026", "Aug 31, 2026", "Jul 1, 2026", "Jul 31, 2026"];
  await writeFile(join(run, "overview-date-applied-diagnostics.json"), JSON.stringify({ expectedPeriod: { startDate: period.startDate, endDate: period.endDate }, observedDateStrings }));
  await writeFile(join(run, "business-review-date-applied-diagnostics.json"), JSON.stringify({ expectedPeriod: { startDate: period.startDate, endDate: period.endDate }, observedDateStrings }));
  await writeFile(join(run, "results.json"), JSON.stringify({ status: "PARTIAL_PASS_MANUAL_EVIDENCE_REQUIRED", client: { id: deriveClientId(client.name), name: client.name, timezone: client.timezone }, month: { year: 2026, month: 8 }, period, automatedSections, duplicateHashes: [] }));
  return root;
}

function png(seed: number): Buffer {
  const bytes = Buffer.alloc(25);
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(bytes);
  bytes.writeUInt32BE(13, 8); bytes.write("IHDR", 12, "ascii");
  bytes.writeUInt32BE(1440, 16); bytes.writeUInt32BE(720, 20); bytes[24] = seed;
  return bytes;
}
