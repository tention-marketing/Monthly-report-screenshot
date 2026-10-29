import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createReportDraft, InMemoryReportDraftRepository } from "@tention/report-domain";
import { getReportPeriod } from "@tention/report-core";
import { createScreenshotSourceProof, REPORT_CAPTURE_SPEC_V1, screenshotSectionMapping, type ScreenshotType } from "@tention/report-schema";
import { InMemoryScreenshotStorage } from "../storage/screenshot-storage.js";
import { importCompletedAutomaticCaptureRun, AUTOMATIC_RUN_CAPTURE_TYPES } from "./import-automatic-capture-run.js";

/** A report from before Section 10: exactly the frozen nine-section core (Section 10 is opt-in per report). */
const CORE_NINE_SPECS = REPORT_CAPTURE_SPEC_V1.filter(({ reportOptIn }) => !reportOptIn);
const SUBSCRIBER_GROWTH_URL = "https://www.klaviyo.com/configured-subscriber-growth-source";
const subscriberGrowthEvidence = { channel: "email" as const, view: "growth" as const, emailSubscribers: 17_698, newSubscribers: 943, exclusions: 499, changes: { emailSubscribers: null, newSubscribers: null, exclusions: null }, charts: { subscriberGrowthLine: true as const, newSubscribersExclusionsBar: true as const }, visiblePeriodText: "Aug 1 – Aug 31, 2026" };
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

function png(seed: number) {
  const bytes = Buffer.alloc(25);
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(bytes);
  bytes.writeUInt32BE(13, 8); bytes.write("IHDR", 12, "ascii"); bytes.writeUInt32BE(100 + seed, 16); bytes.writeUInt32BE(80, 20); bytes[24] = seed;
  return bytes;
}

async function successfulRun(root: string, reportId: string, client = { id: "autoledtech", name: "AutoLEDTech.com", timezone: "America/New_York" }, topFlows = { usable: 5, included: 5 }, reportMonth = { year: 2026, month: 8 }, variant: { runId?: string; seed?: number; finishedAt?: string; subscriberGrowth?: boolean; resumeOnly?: ScreenshotType[] } = {}) {
  const runId = variant.runId ?? "f0e9f891-8365-455f-adc8-46d74d6c5b2f";
  const dir = join(root, "output/extension-automatic-acceptance", runId);
  await mkdir(join(dir, "sections"), { recursive: true });
  const period = getReportPeriod(reportMonth);
  const sections = [];
  const types: ScreenshotType[] = variant.resumeOnly ?? [...AUTOMATIC_RUN_CAPTURE_TYPES, ...(variant.subscriberGrowth ? ["email_subscriber_growth" as const] : [])];
  for (const [index, type] of types.entries()) {
    const bytes = png(index + 1 + (variant.seed ?? 0)); const sha256 = createHash("sha256").update(bytes).digest("hex");
    const file = `sections/${type}-attempt-1-capture.png`; await writeFile(join(dir, file), bytes);
    const sourceProof = createScreenshotSourceProof(type, period, undefined, type === "top_campaigns" ? { accountIdentity: client.name, clientTimezone: client.timezone, visibleMetricLabel: "Placed Order", rankingMethod: "complete-result-set", eligibleRowCount: 3, includedRowCount: 3, rows: [1, 2, 3].map((value) => ({ name: `Campaign ${value}`, type: value === 3 ? "SMS" : "Email", status: "Sent" as const, sendDate: `2026-08-0${value}`, openRate: value === 3 ? null : "10%", clickRate: "1%", placedOrderValue: value })) } : null, type === "email_subscriber_growth" ? subscriberGrowthEvidence : null);
    const spec = REPORT_CAPTURE_SPEC_V1.find((entry) => entry.screenshotType === type)!;
    const observedUrl = type === "email_subscriber_growth" ? SUBSCRIBER_GROWTH_URL : type === "top_campaigns" ? "https://www.klaviyo.com/omnicampaigns?appBarNav=true" : spec.sourceUrlKey === "overviewUrl" ? "https://www.klaviyo.com/dashboard" : type === "deliverability" ? "https://www.klaviyo.com/analytics/deliverability/email/score" : "https://www.klaviyo.com/analytics/dashboards/01HWZSHD83RW7CYWQ6EVVQD2BK";
    sections.push({ section: type, status: "pass", attemptNumber: 1, startedAt: "2026-10-10T06:46:04.200Z", finishedAt: variant.finishedAt ?? "2026-10-10T06:46:04.645Z", durationMs: 400,
      expectedUrl: observedUrl, observedUrl,
      expectedSourceIdentity: spec.sourceIdentity, observedSourceIdentity: spec.sourceIdentity,
      expectedPeriod: type === "deliverability" ? null : type === "month_comparison" ? { startDate: period.startDate, endDate: period.endDate, comparisonStartDate: period.previousStartDate, comparisonEndDate: period.previousEndDate } : { startDate: period.startDate, endDate: period.endDate },
      usableRowCount: type === "top_campaigns" ? 3 : type === "top_flows" ? topFlows.usable : null,
      screenshotResult: "fresh_semantic_crop_saved", sourceProofResult: "PASS", sha256,
      diagnostics: { sourceProof, targetBounds: { includedRowCount: type === "top_campaigns" ? 3 : type === "top_flows" ? topFlows.included : undefined }, observedPeriodProof: type === "deliverability" ? null : { startDate: period.startDate, endDate: period.endDate, ...(type === "month_comparison" ? { comparisonStartDate: period.previousStartDate, comparisonEndDate: period.previousEndDate } : {}) } },
      evidenceByAttempt: [{ attemptNumber: 1, kind: "capture", file, byteSize: bytes.length, width: 100 + index + 1 + (variant.seed ?? 0), height: 80, sha256 }],
    });
  }
  await writeFile(join(dir, "results.json"), JSON.stringify({ kind: "tention_local_automatic_capture", runId, ...(variant.resumeOnly ? { mode: "resume", plannedSections: variant.resumeOnly } : {}), reportId, clientId: client.id, clientName: client.name, timezone: client.timezone, reportMonth, period, status: "completed", startedAt: "2026-10-10T06:46:04.187Z", finishedAt: "2026-10-10T06:46:19.699Z", durationMs: 15512, sections }));
  return runId;
}

describe("import completed automatic capture run — Section 10", () => {
  const tenSectionReport = (id: string) => createReportDraft({ client: { id: "autoledtech", name: "AutoLEDTech.com", timezone: "America/New_York", currency: null }, reportMonth: { year: 2026, month: 8 }, sections: { ...Object.fromEntries(CORE_NINE_SPECS.map(({ screenshotType }) => [screenshotSectionMapping[screenshotType], "required"])), email_subscriber_growth: "required" } }, { id, now: new Date("2026-10-10T07:00:00Z") });

  it("imports a ten-section run into a report that includes Subscriber Growth, with its structured evidence", async () => {
    const root = await mkdtemp(join(tmpdir(), "tention-auto-run-import-")); roots.push(root);
    const repo = new InMemoryReportDraftRepository(); const storage = new InMemoryScreenshotStorage();
    const report = tenSectionReport("c3b7755e-42d9-4e00-a85a-98c02ed2aac7"); await repo.create(report);
    const runId = await successfulRun(root, report.id, undefined, undefined, undefined, { subscriberGrowth: true });
    const imported = await importCompletedAutomaticCaptureRun({ repository: repo, screenshotStorage: storage, repositoryRoot: root, runId, now: () => new Date("2026-10-10T07:01:00Z") });
    expect(imported).toMatchObject({ capturedCount: 10, pendingReviewCount: 10, missingAutomaticCount: 0 });
    const growth = (await repo.getById(report.id))!.screenshots.find(({ type }) => type === "email_subscriber_growth")!;
    expect(growth).toMatchObject({ sourceUrl: SUBSCRIBER_GROWTH_URL, periodConfirmed: true, approved: false });
    expect(growth.sourceProof).toMatchObject({ sourceIdentity: "klaviyo-subscriber-growth|email|growth", expectedPeriod: { startDate: "2026-08-01", endDate: "2026-08-31" }, subscriberGrowth: subscriberGrowthEvidence });
  });

  it("resumes only Subscriber Growth on a report whose nine sections were captured before Section 10 was enabled", async () => {
    const root = await mkdtemp(join(tmpdir(), "tention-auto-run-import-")); roots.push(root);
    const repo = new InMemoryReportDraftRepository(); const storage = new InMemoryScreenshotStorage();
    const nine = createReportDraft({ client: { id: "autoledtech", name: "AutoLEDTech.com", timezone: "America/New_York", currency: null }, reportMonth: { year: 2026, month: 8 }, sections: Object.fromEntries(CORE_NINE_SPECS.map(({ screenshotType }) => [screenshotSectionMapping[screenshotType], "required"])) }, { id: "c3b7755e-42d9-4e00-a85a-98c02ed2aac7", now: new Date("2026-10-10T07:00:00Z") });
    await repo.create(nine);
    const now = () => new Date("2026-10-10T07:01:00Z");
    await importCompletedAutomaticCaptureRun({ repository: repo, screenshotStorage: storage, repositoryRoot: root, runId: await successfulRun(root, nine.id), now });
    const before = (await repo.getById(nine.id))!;
    await repo.save({ ...before, sections: { ...before.sections, email_subscriber_growth: "required" }, version: before.version + 1 }, before.version);
    const resumeRunId = await successfulRun(root, nine.id, undefined, undefined, undefined, { runId: "a1b2c3d4-1111-4222-8333-444455556666", seed: 40, resumeOnly: ["email_subscriber_growth"] });
    const imported = await importCompletedAutomaticCaptureRun({ repository: repo, screenshotStorage: storage, repositoryRoot: root, runId: resumeRunId, now });
    expect(imported).toMatchObject({ capturedCount: 10, missingAutomaticCount: 0 });
    expect(imported.captures.map(({ type }) => type)).toEqual(["email_subscriber_growth"]);
    const after = (await repo.getById(nine.id))!;
    expect(after.screenshots).toHaveLength(10);
    for (const kept of before.screenshots) expect(after.screenshots.find(({ type }) => type === kept.type)).toEqual(kept);
  });

  it("refuses a resume run that skips a section the report does not already hold valid evidence for", async () => {
    const root = await mkdtemp(join(tmpdir(), "tention-auto-run-import-")); roots.push(root);
    const repo = new InMemoryReportDraftRepository();
    const report = tenSectionReport("c3b7755e-42d9-4e00-a85a-98c02ed2aac7"); await repo.create(report);
    const runId = await successfulRun(root, report.id, undefined, undefined, undefined, { resumeOnly: ["email_subscriber_growth"] });
    await expect(importCompletedAutomaticCaptureRun({ repository: repo, screenshotStorage: new InMemoryScreenshotStorage(), repositoryRoot: root, runId, now: () => new Date("2026-10-10T07:01:00Z") })).rejects.toThrow("may only skip overview");
  });

  it("refuses a nine-section run for a report that includes Subscriber Growth", async () => {
    const root = await mkdtemp(join(tmpdir(), "tention-auto-run-import-")); roots.push(root);
    const repo = new InMemoryReportDraftRepository();
    const report = tenSectionReport("c3b7755e-42d9-4e00-a85a-98c02ed2aac7"); await repo.create(report);
    const runId = await successfulRun(root, report.id);
    await expect(importCompletedAutomaticCaptureRun({ repository: repo, screenshotStorage: new InMemoryScreenshotStorage(), repositoryRoot: root, runId, now: () => new Date("2026-10-10T07:01:00Z") })).rejects.toThrow("exactly the 10 sections");
  });

  it("refuses a Subscriber Growth capture for an existing nine-section report", async () => {
    const root = await mkdtemp(join(tmpdir(), "tention-auto-run-import-")); roots.push(root);
    const repo = new InMemoryReportDraftRepository();
    const report = createReportDraft({ client: { id: "autoledtech", name: "AutoLEDTech.com", timezone: "America/New_York", currency: null }, reportMonth: { year: 2026, month: 8 }, sections: Object.fromEntries(CORE_NINE_SPECS.map(({ screenshotType }) => [screenshotSectionMapping[screenshotType], "required"])) }, { id: "c3b7755e-42d9-4e00-a85a-98c02ed2aac7", now: new Date("2026-10-10T07:00:00Z") });
    await repo.create(report);
    const runId = await successfulRun(root, report.id, undefined, undefined, undefined, { subscriberGrowth: true });
    await expect(importCompletedAutomaticCaptureRun({ repository: repo, screenshotStorage: new InMemoryScreenshotStorage(), repositoryRoot: root, runId, now: () => new Date("2026-10-10T07:01:00Z") })).rejects.toThrow("exactly the 9 sections");
  });

  it("refuses Subscriber Growth evidence that lacks its structured Email → Growth proof", async () => {
    const root = await mkdtemp(join(tmpdir(), "tention-auto-run-import-")); roots.push(root);
    const repo = new InMemoryReportDraftRepository();
    const report = tenSectionReport("c3b7755e-42d9-4e00-a85a-98c02ed2aac7"); await repo.create(report);
    const runId = await successfulRun(root, report.id, undefined, undefined, undefined, { subscriberGrowth: true });
    const file = join(root, "output/extension-automatic-acceptance", runId, "results.json");
    const run = JSON.parse(await readFile(file, "utf8"));
    const growth = run.sections.find(({ section }: { section: string }) => section === "email_subscriber_growth");
    delete growth.diagnostics.sourceProof.subscriberGrowth;
    await writeFile(file, JSON.stringify(run));
    await expect(importCompletedAutomaticCaptureRun({ repository: repo, screenshotStorage: new InMemoryScreenshotStorage(), repositoryRoot: root, runId, now: () => new Date("2026-10-10T07:01:00Z") })).rejects.toThrow("email_subscriber_growth did not pass");
  });
});

describe("import completed automatic capture run", () => {
  it("reconciles the exact nine verified run PNGs into one canonical pending-review report and is idempotent", async () => {
    const root = await mkdtemp(join(tmpdir(), "tention-auto-run-import-")); roots.push(root);
    const repo = new InMemoryReportDraftRepository(); const storage = new InMemoryScreenshotStorage();
    const report = createReportDraft({ client: { id: "autoledtech", name: "AutoLEDTech.com", timezone: "America/New_York", currency: null }, reportMonth: { year: 2026, month: 8 }, sections: Object.fromEntries(CORE_NINE_SPECS.map(({ screenshotType }) => [screenshotSectionMapping[screenshotType], "required"])) }, { id: "c3b7755e-42d9-4e00-a85a-98c02ed2aac7", now: new Date("2026-10-10T07:00:00Z") });
    await repo.create(report);
    const runId = await successfulRun(root, report.id);
    const now = () => new Date("2026-10-10T07:01:00Z");
    const imported = await importCompletedAutomaticCaptureRun({ repository: repo, screenshotStorage: storage, repositoryRoot: root, runId, now });
    expect(imported).toMatchObject({ reportId: report.id, capturedCount: 9, pendingReviewCount: 9, approvedCount: 0, missingAutomaticCount: 0 });
    const canonical = await repo.getById(imported.reportId);
    expect(canonical?.screenshots).toHaveLength(9);
    expect(canonical?.screenshots.every((shot) => shot.captureOrigin === "live_acceptance_import" && !shot.approved && shot.approvedAt === null)).toBe(true);
    expect(new Set(canonical?.screenshots.map((shot) => shot.sha256)).size).toBe(9);
    const again = await importCompletedAutomaticCaptureRun({ repository: repo, screenshotStorage: storage, repositoryRoot: root, runId, now });
    expect(again.reportVersion).toBe(imported.reportVersion);
    expect(again.capturedCount).toBe(9);
    expect((await repo.list()).filter((draft) => draft.client.id === "autoledtech" && draft.reportMonth.year === 2026 && draft.reportMonth.month === 8)).toHaveLength(1);
  });

  it("imports a pre-fix run whose icon-only campaign Type was recorded as an empty string as an unproven (null) type", async () => {
    const root = await mkdtemp(join(tmpdir(), "tention-auto-run-campaign-type-")); roots.push(root);
    const repo = new InMemoryReportDraftRepository(); const storage = new InMemoryScreenshotStorage();
    const report = createReportDraft({ client: { id: "autoledtech", name: "AutoLEDTech.com", timezone: "America/New_York", currency: null }, reportMonth: { year: 2026, month: 8 }, sections: Object.fromEntries(CORE_NINE_SPECS.map(({ screenshotType }) => [screenshotSectionMapping[screenshotType], "required"])) }, { id: "c3b0c2f1-1111-4c4c-9d9d-0123456789ab", now: new Date("2026-10-10T07:00:00Z") });
    await repo.create(report);
    const runId = await successfulRun(root, report.id);
    const file = join(root, "output/extension-automatic-acceptance", runId, "results.json");
    const run = JSON.parse(await readFile(file, "utf8"));
    const campaigns = run.sections.find((section: { section: string }) => section.section === "top_campaigns");
    campaigns.diagnostics.sourceProof.campaigns.rows = campaigns.diagnostics.sourceProof.campaigns.rows.map((row: object, index: number) => ({ ...row, type: index === 0 ? "Email" : "" }));
    await writeFile(file, JSON.stringify(run));
    const imported = await importCompletedAutomaticCaptureRun({ repository: repo, screenshotStorage: storage, repositoryRoot: root, runId, now: () => new Date("2026-10-10T07:01:00Z") });
    const canonical = await repo.getById(imported.reportId);
    const rows = canonical!.screenshots.find((shot) => shot.type === "top_campaigns")!.sourceProof!.campaigns!.rows;
    expect(rows.map((row) => row.type)).toEqual(["Email", null, null]);
    expect(imported.capturedCount).toBe(9);
  });

  it("lets a newer complete run supersede unapproved evidence from an earlier run (a retake), but never approved evidence", async () => {
    const root = await mkdtemp(join(tmpdir(), "tention-auto-run-retake-")); roots.push(root);
    const repo = new InMemoryReportDraftRepository(); const storage = new InMemoryScreenshotStorage();
    const report = createReportDraft({ client: { id: "autoledtech", name: "AutoLEDTech.com", timezone: "America/New_York", currency: null }, reportMonth: { year: 2026, month: 8 }, sections: Object.fromEntries(CORE_NINE_SPECS.map(({ screenshotType }) => [screenshotSectionMapping[screenshotType], "required"])) }, { id: "c3b0c2f1-3333-4c4c-9d9d-0123456789ab", now: new Date("2026-10-10T07:00:00Z") });
    await repo.create(report);
    const now = () => new Date("2026-10-11T07:01:00Z");
    const first = await importCompletedAutomaticCaptureRun({ repository: repo, screenshotStorage: storage, repositoryRoot: root, runId: await successfulRun(root, report.id), now });
    const retakeRun = await successfulRun(root, report.id, undefined, undefined, undefined, { runId: "a1e9f891-8365-455f-adc8-46d74d6c5b2f", seed: 20, finishedAt: "2026-10-11T06:00:00.000Z" });
    const retake = await importCompletedAutomaticCaptureRun({ repository: repo, screenshotStorage: storage, repositoryRoot: root, runId: retakeRun, now });
    expect(retake.captures.every((capture, index) => capture.sha256 !== first.captures[index]!.sha256)).toBe(true);
    const canonical = (await repo.getById(report.id))!;
    expect(canonical.screenshots).toHaveLength(9);
    expect(canonical.screenshots.map((shot) => shot.sha256).sort()).toEqual(retake.captures.map((capture) => capture.sha256).sort());

    const approved = { ...canonical, version: canonical.version + 1, screenshots: canonical.screenshots.map((shot) => shot.type === "top_flows" ? { ...shot, approved: true, approvedAt: "2026-10-11T06:30:00.000Z" } : shot) };
    await repo.save(approved, canonical.version);
    const later = await successfulRun(root, report.id, undefined, undefined, undefined, { runId: "b1e9f891-8365-455f-adc8-46d74d6c5b2f", seed: 40, finishedAt: "2026-10-11T06:45:00.000Z" });
    await expect(importCompletedAutomaticCaptureRun({ repository: repo, screenshotStorage: storage, repositoryRoot: root, runId: later, now })).rejects.toThrow(/Refusing to replace existing top_flows/);
  });

  it("refuses an older run's different bytes over newer unapproved evidence", async () => {
    const root = await mkdtemp(join(tmpdir(), "tention-auto-run-older-")); roots.push(root);
    const repo = new InMemoryReportDraftRepository(); const storage = new InMemoryScreenshotStorage();
    const report = createReportDraft({ client: { id: "autoledtech", name: "AutoLEDTech.com", timezone: "America/New_York", currency: null }, reportMonth: { year: 2026, month: 8 }, sections: Object.fromEntries(CORE_NINE_SPECS.map(({ screenshotType }) => [screenshotSectionMapping[screenshotType], "required"])) }, { id: "c3b0c2f1-4444-4c4c-9d9d-0123456789ab", now: new Date("2026-10-10T07:00:00Z") });
    await repo.create(report);
    const now = () => new Date("2026-10-11T07:01:00Z");
    await importCompletedAutomaticCaptureRun({ repository: repo, screenshotStorage: storage, repositoryRoot: root, runId: await successfulRun(root, report.id, undefined, undefined, undefined, { runId: "c1e9f891-8365-455f-adc8-46d74d6c5b2f", seed: 20, finishedAt: "2026-10-11T06:00:00.000Z" }), now });
    await expect(importCompletedAutomaticCaptureRun({ repository: repo, screenshotStorage: storage, repositoryRoot: root, runId: await successfulRun(root, report.id), now })).rejects.toThrow(/Refusing to replace/);
  });

  it.each([[7, 5, true], [7, 3, false], [4, 4, true], [2, 2, true]])("with %i usable Sent campaigns imports Top Campaigns only when exactly min(5, usable) rows were captured (included %i)", async (usable, included, accepted) => {
    const root = await mkdtemp(join(tmpdir(), "tention-auto-run-top-campaigns-")); roots.push(root);
    const repo = new InMemoryReportDraftRepository(); const storage = new InMemoryScreenshotStorage();
    const report = createReportDraft({ client: { id: "autoledtech", name: "AutoLEDTech.com", timezone: "America/New_York", currency: null }, reportMonth: { year: 2026, month: 8 }, sections: Object.fromEntries(CORE_NINE_SPECS.map(({ screenshotType }) => [screenshotSectionMapping[screenshotType], "required"])) }, { id: "c3b0c2f1-5555-4c4c-9d9d-0123456789ab", now: new Date("2026-10-10T07:00:00Z") });
    await repo.create(report);
    const runId = await successfulRun(root, report.id);
    const file = join(root, "output/extension-automatic-acceptance", runId, "results.json");
    const run = JSON.parse(await readFile(file, "utf8"));
    const campaigns = run.sections.find((section: { section: string }) => section.section === "top_campaigns");
    campaigns.usableRowCount = usable; campaigns.diagnostics.targetBounds.includedRowCount = included;
    const proof = campaigns.diagnostics.sourceProof.campaigns;
    proof.eligibleRowCount = usable; proof.includedRowCount = included;
    proof.rows = Array.from({ length: included }, (_, index) => ({ name: `Campaign ${index + 1}`, type: "Email", status: "Sent", sendDate: "2026-08-10", openRate: null, clickRate: null, placedOrderValue: 100 - index }));
    await writeFile(file, JSON.stringify(run));
    const imported = importCompletedAutomaticCaptureRun({ repository: repo, screenshotStorage: storage, repositoryRoot: root, runId, now: () => new Date("2026-10-10T07:01:00Z") });
    if (accepted) {
      await expect(imported).resolves.toMatchObject({ capturedCount: 9 });
      expect((await repo.getById(report.id))!.screenshots.find((shot) => shot.type === "top_campaigns")!.sourceProof!.campaigns!.rows).toHaveLength(included);
    } else await expect(imported).rejects.toThrow(/top_campaigns did not pass/);
  });

  it("still rejects campaign rows whose Type is not a string or null", async () => {
    const root = await mkdtemp(join(tmpdir(), "tention-auto-run-campaign-type-bad-")); roots.push(root);
    const repo = new InMemoryReportDraftRepository(); const storage = new InMemoryScreenshotStorage();
    const report = createReportDraft({ client: { id: "autoledtech", name: "AutoLEDTech.com", timezone: "America/New_York", currency: null }, reportMonth: { year: 2026, month: 8 }, sections: Object.fromEntries(CORE_NINE_SPECS.map(({ screenshotType }) => [screenshotSectionMapping[screenshotType], "required"])) }, { id: "c3b0c2f1-2222-4c4c-9d9d-0123456789ab", now: new Date("2026-10-10T07:00:00Z") });
    await repo.create(report);
    const runId = await successfulRun(root, report.id);
    const file = join(root, "output/extension-automatic-acceptance", runId, "results.json");
    const run = JSON.parse(await readFile(file, "utf8"));
    run.sections.find((section: { section: string }) => section.section === "top_campaigns").diagnostics.sourceProof.campaigns.rows[0].type = 7;
    await writeFile(file, JSON.stringify(run));
    await expect(importCompletedAutomaticCaptureRun({ repository: repo, screenshotStorage: storage, repositoryRoot: root, runId, now: () => new Date("2026-10-10T07:01:00Z") })).rejects.toThrow();
    expect((await repo.getById(report.id))!.screenshots).toHaveLength(0);
  });

  it.each([[7, 5], [4, 4], [1, 1]])("imports Top Flows with %i usable rows when exactly %i rows were captured", async (usable, included) => {
    const root = await mkdtemp(join(tmpdir(), "tention-auto-run-top-flows-")); roots.push(root);
    const repo = new InMemoryReportDraftRepository(); const storage = new InMemoryScreenshotStorage();
    const report = createReportDraft({ client: { id: "autoledtech", name: "AutoLEDTech.com", timezone: "America/New_York", currency: null }, reportMonth: { year: 2026, month: 8 }, sections: { executive_summary: "required" } }, { id: "c3b7755e-42d9-4e00-a85a-98c02ed2aac7", now: new Date("2026-10-10T07:00:00Z") });
    await repo.create(report);
    const runId = await successfulRun(root, report.id, undefined, { usable, included });
    await expect(importCompletedAutomaticCaptureRun({ repository: repo, screenshotStorage: storage, repositoryRoot: root, runId, now: () => new Date("2026-10-10T07:01:00Z") })).resolves.toMatchObject({ capturedCount: 9 });
  });

  it.each([[0, 0], [3, 5], [7, 4], [2, 1]])("rejects Top Flows with %i usable rows and %i included rows (no data, padded, or partial crop)", async (usable, included) => {
    const root = await mkdtemp(join(tmpdir(), "tention-auto-run-top-flows-bad-")); roots.push(root);
    const repo = new InMemoryReportDraftRepository(); const storage = new InMemoryScreenshotStorage();
    const report = createReportDraft({ client: { id: "autoledtech", name: "AutoLEDTech.com", timezone: "America/New_York", currency: null }, reportMonth: { year: 2026, month: 8 }, sections: { executive_summary: "required" } }, { id: "c3b7755e-42d9-4e00-a85a-98c02ed2aac7", now: new Date("2026-10-10T07:00:00Z") });
    await repo.create(report);
    const runId = await successfulRun(root, report.id, undefined, { usable, included });
    await expect(importCompletedAutomaticCaptureRun({ repository: repo, screenshotStorage: storage, repositoryRoot: root, runId, now: () => new Date("2026-10-10T07:01:00Z") })).rejects.toThrow(/top_flows did not pass independent source, period, ranking, and capture proof checks/);
  });

  it("imports any client's run for any completed month into that client's own draft", async () => {
    const root = await mkdtemp(join(tmpdir(), "tention-auto-run-import-")); roots.push(root);
    const repo = new InMemoryReportDraftRepository(); const storage = new InMemoryScreenshotStorage();
    const client = { id: "acme-home", name: "Acme Home", timezone: "Asia/Kolkata" };
    const reportMonth = { year: 2026, month: 9 };
    const report = createReportDraft({ client: { ...client, currency: null }, reportMonth, sections: Object.fromEntries(CORE_NINE_SPECS.map(({ screenshotType }) => [screenshotSectionMapping[screenshotType], "required"])) }, { now: new Date("2026-10-10T07:00:00Z") });
    await repo.create(report);
    const runId = await successfulRun(root, report.id, client, undefined, reportMonth);
    const imported = await importCompletedAutomaticCaptureRun({ repository: repo, screenshotStorage: storage, repositoryRoot: root, runId, now: () => new Date("2026-10-10T07:01:00Z") });
    expect(imported).toMatchObject({ reportId: report.id, clientId: "acme-home", reportMonth, capturedCount: 9 });
    expect((await repo.getById(report.id))?.period).toEqual({ startDate: "2026-09-01", endDate: "2026-09-30", previousStartDate: "2026-08-01", previousEndDate: "2026-08-31" });
  });
  it("rejects a diagnostic-run hash mismatch without attaching screenshots", async () => {
    const root = await mkdtemp(join(tmpdir(), "tention-auto-run-corrupt-")); roots.push(root);
    const repo = new InMemoryReportDraftRepository(); const storage = new InMemoryScreenshotStorage();
    const report = createReportDraft({ client: { id: "autoledtech", name: "AutoLEDTech.com", timezone: "America/New_York", currency: null }, reportMonth: { year: 2026, month: 8 }, sections: { executive_summary: "required" } }, { id: "c3b7755e-42d9-4e00-a85a-98c02ed2aac7", now: new Date("2026-10-10T07:00:00Z") });
    await repo.create(report); const runId = await successfulRun(root, report.id);
    const resultPath = join(root, "output/extension-automatic-acceptance", runId, "results.json");
    const results = JSON.parse(await (await import("node:fs/promises")).readFile(resultPath, "utf8")); results.sections[0].sha256 = "0".repeat(64); await writeFile(resultPath, JSON.stringify(results));
    await expect(importCompletedAutomaticCaptureRun({ repository: repo, screenshotStorage: storage, repositoryRoot: root, runId, now: () => new Date("2026-10-10T07:01:00Z") })).rejects.toThrow(/evidence acknowledgement is missing or inconsistent/);
    expect((await repo.getById(report.id))?.screenshots).toHaveLength(0);
  });

  it("imports a Club Furniture run using its own verified draft identity without adopting AutoLEDTech's legacy ID", async () => {
    const root = await mkdtemp(join(tmpdir(), "tention-club-furniture-auto-run-")); roots.push(root);
    const repo = new InMemoryReportDraftRepository(); const storage = new InMemoryScreenshotStorage();
    const client = { id: "club-furniture", name: "Club Furniture", timezone: "America/New_York", currency: null };
    const report = createReportDraft({ client, reportMonth: { year: 2026, month: 8 }, sections: Object.fromEntries(CORE_NINE_SPECS.map(({ screenshotType }) => [screenshotSectionMapping[screenshotType], "required"])) }, { id: "b9b1d073-b398-45dc-b26e-670b3faa3eee", now: new Date("2026-10-10T07:00:00Z") });
    await repo.create(report);
    const runId = await successfulRun(root, report.id, client);

    const imported = await importCompletedAutomaticCaptureRun({ repository: repo, screenshotStorage: storage, repositoryRoot: root, runId, now: () => new Date("2026-10-10T07:01:00Z") });

    expect(imported).toMatchObject({ reportId: report.id, clientId: "club-furniture", capturedCount: 9, pendingReviewCount: 9, approvedCount: 0, missingAutomaticCount: 0 });
    expect(await repo.getById("f577d631-a1f6-4cc0-9052-68e30460876d")).toBeNull();
    const persisted = await repo.getById(report.id);
    expect(persisted?.client).toMatchObject(client);
    expect(persisted?.screenshots).toHaveLength(9);
    expect(new Set(persisted?.screenshots.map((shot) => shot.sha256)).size).toBe(9);
  });
});
