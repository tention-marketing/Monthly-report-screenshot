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
    expect(await runMigrations(pool)).toEqual(["001_report_drafts.sql", "002_report_lifecycle_events.sql", "003_report_pdf_artifacts.sql", "004_client_report_targets.sql"]);
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
