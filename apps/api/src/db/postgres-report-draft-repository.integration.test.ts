import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { applyReportEvent, createReportDraft, emptyClientReportTargets, upsertScreenshotMetadata, type ReportEvent } from "@tention/report-domain";
import { createScreenshotSourceProof, type ReportDraft } from "@tention/report-schema";
import { runMigrations } from "./migrate.js";
import { PostgresReportDraftRepository } from "./postgres-report-draft-repository.js";
import { PostgresClientReportTargetsRepository } from "./postgres-client-report-targets-repository.js";

const testUrl = process.env.TEST_DATABASE_URL;
const isSafeTestUrl = (() => {
  if (!testUrl) return false;
  try { return new URL(testUrl).pathname.toLowerCase().includes("test"); } catch { return false; }
})();
const suite = isSafeTestUrl ? describe : describe.skip;

suite("PostgresReportDraftRepository with real PostgreSQL", () => {
  let pool: Pool;
  let repository: PostgresReportDraftRepository;
  let targetRepository: PostgresClientReportTargetsRepository;
  const now = new Date("2026-09-09T12:00:00Z");
  const draft = (): ReportDraft => createReportDraft({
    client: { id: "client-1", name: "Orion", timezone: "Asia/Kolkata", currency: null },
    reportMonth: { year: 2026, month: 8 }, sections: { executive_summary: "optional" },
  }, { now });

  beforeAll(async () => {
    pool = new Pool({ connectionString: testUrl });
    await pool.query("DROP TABLE IF EXISTS report_pdf_artifacts, report_lifecycle_events, client_report_targets, report_drafts, schema_migrations CASCADE");
    expect(await runMigrations(pool)).toEqual(["001_report_drafts.sql", "002_report_lifecycle_events.sql", "003_report_pdf_artifacts.sql", "004_client_report_targets.sql", "005_report_pdf_artifact_drive_delivery.sql", "006_report_pdf_artifact_google_doc.sql", "007_report_status_auto_validated.sql", "008_client_onboarding.sql"]);
    expect(await runMigrations(pool)).toEqual([]);
  });
  beforeEach(async () => {
    await pool.query("TRUNCATE report_pdf_artifacts, report_lifecycle_events, client_report_targets, report_drafts");
    repository = new PostgresReportDraftRepository(pool);
    targetRepository = new PostgresClientReportTargetsRepository(pool);
  });
  afterAll(async () => pool.end());

  it("persists schema-validated drafts across repository recreation", async () => {
    const initial = await repository.create(draft());
    expect(initial.version).toBe(1);
    const recreated = new PostgresReportDraftRepository(pool);
    const stored = await recreated.getById(initial.id);
    expect(stored).toEqual(initial);
    expect(stored?.period.startDate).toBe("2026-08-01");
    expect(stored?.client.timezone).toBe("Asia/Kolkata");
    expect(stored?.screenshots).toEqual([]);
    expect(stored?.validation).toEqual(initial.validation);
  });
  it("stores the report-time client snapshot once and never changes it on later saves", async () => {
    const snapshotted = createReportDraft({
      client: { id: "steven-dann", name: "Steven Dann", timezone: "America/New_York", currency: "USD", conversionMetric: { label: "Placed Order", providerMetricId: "SDmet1" }, klaviyoAccount: { accountLabel: "Steven Dann", providerAccountId: null } },
      reportMonth: { year: 2026, month: 10 }, sections: { executive_summary: "required" },
    }, { now });
    const stored = await repository.create(snapshotted);
    expect(stored.client.conversionMetric).toEqual({ label: "Placed Order", providerMetricId: "SDmet1" });
    const tampered = { ...stored, client: { ...stored.client, conversionMetric: { label: "Placed Order", providerMetricId: "OTHER1" } }, version: stored.version + 1 };
    const saved = await repository.save(tampered, stored.version);
    expect(saved.client.conversionMetric).toEqual({ label: "Placed Order", providerMetricId: "SDmet1" });
    expect((await repository.getById(stored.id))?.client.klaviyoAccount).toEqual({ accountLabel: "Steven Dann", providerAccountId: null });
    // A report created before onboarding has no snapshot keys at all.
    expect(Object.keys((await repository.create(draft())).client).sort()).toEqual(["currency", "id", "name", "timezone"]);
  });
  it("never saves one client's conversion metric ID on another client", async () => {
    const input = (name: string) => ({ businessReview: null, sourceUrls: null, primaryEmailList: null, primarySmsList: null, welcomeFlow: null, welcomeFlowListing: null, customerSegment: null, nonCustomerSegment: null, signupForms: null, profile: { name, timezone: "America/New_York", currency: "USD", conversionMetric: { label: "Placed Order", providerMetricId: "KyqTnx" }, sections: null } });
    await targetRepository.save("club-furniture", input("Club Furniture"), now);
    await expect(targetRepository.save("steven-dann", input("Steven Dann"), now)).rejects.toMatchObject({ code: "CONVERSION_METRIC_ID_ALREADY_BOUND" });
    expect((await targetRepository.get("steven-dann")).profile).toBeNull();
  });
  it("allows only a same-account presentation correction of the saved Klaviyo account label", async () => {
    const input = (accountLabel: string) => ({ profile: null, sourceUrls: null, primaryEmailList: null, primarySmsList: null, welcomeFlow: null, welcomeFlowListing: null, customerSegment: null, nonCustomerSegment: null, signupForms: null, businessReview: { dashboardUrl: "https://www.klaviyo.com/analytics/dashboards/01SD", displayName: "Business Review", accountLabel } });
    await targetRepository.save("steven-dann", input("ST Steven Dann"), now);
    await expect(targetRepository.save("steven-dann", input("Club Furniture"), now)).rejects.toMatchObject({ code: "CLIENT_ACCOUNT_BINDING_IMMUTABLE" });
    expect((await targetRepository.save("steven-dann", input("Steven Dann"), now)).businessReview?.accountLabel).toBe("Steven Dann");
    expect((await targetRepository.get("steven-dann")).businessReview?.accountLabel).toBe("Steven Dann");
  });
  it("records Drive delivery on an existing artifact without changing its canonical fields", async () => {
    const report = await repository.create(draft());
    const artifactId = crypto.randomUUID();
    await pool.query(`INSERT INTO report_pdf_artifacts (id, report_id, storage_key, mime_type, byte_size, sha256, source_fingerprint, template_version, generated_at)
      VALUES ($1, $2, $3, 'application/pdf', 10, $4, $5, 'monthly-report-v1', $6)`, [artifactId, report.id, `reports/${report.id}/artifacts/${artifactId}.pdf`, "a".repeat(64), "b".repeat(64), now.toISOString()]);
    const before = await repository.getArtifactForFingerprint(report.id, "b".repeat(64));
    expect(before?.driveDelivery).toBeUndefined();
    const delivery = { driveUploadStatus: "uploaded" as const, driveFileName: "Orion - August 2026.pdf", driveFileId: "file-1", driveFolderId: "folder-1", driveWebViewLink: "https://drive.google.com/file/d/file-1/view", driveUploadedAt: now.toISOString(), driveUploadAction: "created" as const, driveErrorCode: null, driveAttemptedAt: now.toISOString() };
    const saved = await repository.saveArtifactDriveDelivery(report.id, artifactId, delivery);
    expect(saved).toEqual({ ...before, driveDelivery: delivery });
    expect(await new PostgresReportDraftRepository(pool).listArtifacts(report.id)).toEqual([saved]);
    await expect(repository.saveArtifactDriveDelivery(report.id, crypto.randomUUID(), delivery)).rejects.toMatchObject({ code: "PERSISTENCE_DATA_INVALID" });
  });
  it("records the Google Doc copy separately from Drive PDF delivery on the same artifact", async () => {
    const report = await repository.create(draft());
    const artifactId = crypto.randomUUID();
    await pool.query(`INSERT INTO report_pdf_artifacts (id, report_id, storage_key, mime_type, byte_size, sha256, source_fingerprint, template_version, generated_at)
      VALUES ($1, $2, $3, 'application/pdf', 10, $4, $5, 'monthly-report-v1', $6)`, [artifactId, report.id, `reports/${report.id}/artifacts/${artifactId}.pdf`, "a".repeat(64), "c".repeat(64), now.toISOString()]);
    const delivery = { driveUploadStatus: "uploaded" as const, driveFileName: "Orion - August 2026.pdf", driveFileId: "file-1", driveFolderId: "folder-1", driveWebViewLink: "https://drive.google.com/file/d/file-1/view", driveUploadedAt: now.toISOString(), driveUploadAction: "created" as const, driveErrorCode: null, driveAttemptedAt: now.toISOString() };
    const googleDoc = { googleDocStatus: "synced" as const, googleDocName: "Orion - August 2026", googleDocId: "doc-1", googleDocFolderId: "folder-1", googleDocWebViewLink: "https://docs.google.com/document/d/doc-1/edit", googleDocUpdatedAt: now.toISOString(), googleDocVersion: "7", googleDocAction: "created" as const, googleDocErrorCode: null, googleDocAttemptedAt: now.toISOString() };
    await repository.saveArtifactDriveDelivery(report.id, artifactId, delivery);
    const saved = await repository.saveArtifactGoogleDoc(report.id, artifactId, googleDoc);
    expect(saved).toMatchObject({ id: artifactId, sha256: "a".repeat(64), driveDelivery: delivery, googleDoc });
    expect((await new PostgresReportDraftRepository(pool).listArtifacts(report.id))[0]).toEqual(saved);
  });
  it("rejects duplicate identity", async () => {
    await repository.create(draft());
    await expect(repository.create(draft())).rejects.toMatchObject({ code: "REPORT_DRAFT_ALREADY_EXISTS" });
  });
  it("allows another month for the same client and the same month for another client", async () => {
    await repository.create(draft());
    const otherMonth = createReportDraft({
      client: { id: "client-1", name: "Orion", timezone: "Asia/Kolkata", currency: null },
      reportMonth: { year: 2026, month: 7 }, sections: {},
    }, { now });
    const otherClient = createReportDraft({
      client: { id: "client-2", name: "Other", timezone: "Asia/Kolkata", currency: null },
      reportMonth: { year: 2026, month: 8 }, sections: {},
    }, { now });
    await expect(repository.create(otherMonth)).resolves.toMatchObject({ reportMonth: { month: 7 } });
    await expect(repository.create(otherClient)).resolves.toMatchObject({ client: { id: "client-2" } });
  });
  it("increments once under two competing updates", async () => {
    const initial = await repository.create(draft());
    const updated = upsertScreenshotMetadata(initial, {
      id: "shot-1", clientId: "client-1", reportMonth: initial.reportMonth, type: "overview",
      capturedAt: now.toISOString(), sourceUrl: "https://example.com", width: 100, height: 100,
      approved: true, storageKey: "reports/11111111-1111-4111-8111-111111111111/overview/22222222-2222-4222-8222-222222222222.png",
      mimeType: "image/png", byteSize: 100, sha256: "a".repeat(64), approvedAt: now.toISOString(), periodConfirmed: true,
      sourceProof: createScreenshotSourceProof("overview", initial.period),
    }, "overview", { now });
    const results = await Promise.allSettled([repository.save(updated, 1), repository.save(updated, 1)]);
    expect(results.filter(({ status }) => status === "fulfilled")).toHaveLength(1);
    const rejected = results.find(({ status }) => status === "rejected");
    expect(rejected).toMatchObject({ status: "rejected", reason: { code: "REPORT_VERSION_CONFLICT" } });
    const stored = await repository.getById(initial.id);
    expect(stored?.version).toBe(2);
    expect(stored?.screenshots).toEqual(updated.screenshots);
  });
  it("atomically saves a lifecycle transition and durable history", async () => {
    const initial = await repository.create(draft());
    const transitioned = applyReportEvent(initial, "START_DATA_FETCH", { now });
    await repository.saveWithLifecycleEvent(transitioned, 1, "START_DATA_FETCH");
    const recreated = new PostgresReportDraftRepository(pool);
    expect((await recreated.getById(initial.id))?.status).toBe("data_fetching");
    expect((await recreated.getHistory(initial.id)).map(({ eventType }) => eventType)).toEqual(["REPORT_CREATED", "START_DATA_FETCH"]);
  });
  it("transactionally deletes report-owned history and releases client/month identity", async () => {
    const initial = await repository.create(draft());
    const transitioned = applyReportEvent(initial, "START_DATA_FETCH", { now });
    await repository.saveWithLifecycleEvent(transitioned, 1, "START_DATA_FETCH");
    await expect(repository.delete(initial.id, 1)).rejects.toMatchObject({ code: "REPORT_VERSION_CONFLICT" });
    await expect(repository.delete(initial.id, 2)).resolves.toMatchObject({ id: initial.id });
    expect(await repository.getById(initial.id)).toBeNull();
    await expect(repository.getHistory(initial.id)).rejects.toMatchObject({ code: "REPORT_NOT_FOUND" });
    await expect(repository.create(draft())).resolves.toMatchObject({ client: { id: "client-1" }, reportMonth: { month: 8 } });
  });
  it("repairs a local report UUID atomically while retaining lifecycle history", async () => {
    const initial = await repository.create(createReportDraft({
      client: { id: "autoledtech", name: "AutoLEDTech.com", timezone: "America/New_York", currency: null },
      reportMonth: { year: 2026, month: 8 }, sections: { executive_summary: "required" },
    }, { now, id: "bd189b27-b2fe-4240-84b9-b405e2e09d31" }));
    const moved = await repository.rekeyLocalDraft(initial.id, "f577d631-a1f6-4cc0-9052-68e30460876d", initial.version);
    expect(moved).toMatchObject({ id: "f577d631-a1f6-4cc0-9052-68e30460876d", client: { id: "autoledtech" }, reportMonth: { year: 2026, month: 8 }, version: 1 });
    expect(await repository.getById(initial.id)).toBeNull();
    expect(await repository.getById(moved.id)).toEqual(moved);
    expect(await repository.getHistory(moved.id)).toMatchObject([{ eventType: "REPORT_CREATED", reportId: moved.id }]);
    await expect(repository.rekeyLocalDraft(moved.id, "11111111-1111-4111-8111-111111111111", 2)).rejects.toMatchObject({ code: "REPORT_VERSION_CONFLICT" });
  });
  it("writes nothing for an illegal lifecycle transition", async () => {
    const initial = await repository.create(draft());
    expect(() => applyReportEvent(initial, "GENERATION_SUCCEEDED", { now })).toThrow();
    expect(await repository.getById(initial.id)).toMatchObject({ status: "draft", version: 1 });
    expect(await repository.getHistory(initial.id)).toHaveLength(1);
  });
  it("rolls back the status and version if history insertion fails", async () => {
    const initial = await repository.create(draft());
    const transitioned = applyReportEvent(initial, "START_DATA_FETCH", { now });
    await expect(repository.saveWithLifecycleEvent(transitioned, 1, "INVALID_EVENT" as ReportEvent)).rejects.toMatchObject({ code: "PERSISTENCE_DATA_INVALID" });
    expect(await repository.getById(initial.id)).toMatchObject({ status: "draft", version: 1 });
    expect(await repository.getHistory(initial.id)).toHaveLength(1);
  });
  it("rejects corrupted persisted JSON at the schema boundary", async () => {
    const initial = await repository.create(draft());
    await pool.query("UPDATE report_drafts SET screenshots = $2::jsonb WHERE id = $1", [initial.id, JSON.stringify({ invalid: true })]);
    await expect(repository.getById(initial.id)).rejects.toMatchObject({ code: "PERSISTENCE_DATA_INVALID" });
  });
  it("persists client report targets across repository recreation and keeps clients isolated", async () => {
    expect(await targetRepository.get("client-1")).toEqual(emptyClientReportTargets("client-1"));
    const saved = await targetRepository.save("client-1", {
      profile: null, businessReview: null, sourceUrls: null, primaryEmailList: { id: "list-1" }, primarySmsList: null,
      welcomeFlow: { name: "Welcome", aliases: ["Welcome Series"] }, welcomeFlowListing: null, customerSegment: null, nonCustomerSegment: null,
      signupForms: { mode: "configured", ids: ["form-1"], names: [] },
    }, now);
    expect(saved).toMatchObject({ clientId: "client-1", primaryEmailList: { id: "list-1" }, createdAt: now.toISOString(), updatedAt: now.toISOString() });
    expect(await new PostgresClientReportTargetsRepository(pool).get("client-1")).toEqual(saved);
    expect(await targetRepository.get("client-2")).toEqual(emptyClientReportTargets("client-2"));
  });
});
