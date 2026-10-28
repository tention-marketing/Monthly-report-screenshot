import { describe, expect, it } from "vitest";
import { createScreenshotSourceProof, type ReportDraft } from "@tention/report-schema";
import {
  createReportDraft, InMemoryReportDraftRepository, ReportPersistenceError,
  upsertScreenshotMetadata,
} from "./index.js";

const now = new Date("2026-09-09T12:00:00Z");
const createDraft = (id = crypto.randomUUID(), clientId = "client-1", month = 8): ReportDraft => createReportDraft({
  client: { id: clientId, name: "Orion", timezone: "Asia/Kolkata", currency: null },
  reportMonth: { year: 2026, month }, sections: { executive_summary: "optional" },
}, { now, id });

const mutate = (draft: ReportDraft) => upsertScreenshotMetadata(draft, {
  id: "shot-1", clientId: draft.client.id, reportMonth: draft.reportMonth, type: "overview",
  capturedAt: now.toISOString(), sourceUrl: "https://example.com/report", width: 100, height: 100,
  approved: true, storageKey: "reports/11111111-1111-4111-8111-111111111111/overview/22222222-2222-4222-8222-222222222222.png",
  mimeType: "image/png", byteSize: 100, sha256: "a".repeat(64), approvedAt: now.toISOString(), periodConfirmed: true,
  sourceProof: createScreenshotSourceProof("overview", draft.period),
}, "overview", { now });

describe("InMemoryReportDraftRepository contract", () => {
  it("creates, gets, lists, and saves defensive copies", async () => {
    const repository = new InMemoryReportDraftRepository();
    const initial = createDraft();
    expect((await repository.create(initial)).version).toBe(1);
    initial.status = "failed";
    const stored = await repository.getById(initial.id);
    expect(stored?.status).toBe("draft");
    const saved = await repository.save(mutate(stored!), 1);
    expect(saved.version).toBe(2);
    expect(await repository.list()).toHaveLength(1);
  });
  it("rejects duplicate client/month identity", async () => {
    const repository = new InMemoryReportDraftRepository();
    await repository.create(createDraft());
    await expect(repository.create(createDraft())).rejects.toMatchObject({ code: "REPORT_DRAFT_ALREADY_EXISTS" });
  });
  it("allows the same client in another month and another client in the same month", async () => {
    const repository = new InMemoryReportDraftRepository();
    await repository.create(createDraft());
    await expect(repository.create(createDraft(crypto.randomUUID(), "client-1", 7))).resolves.toMatchObject({ reportMonth: { month: 7 } });
    await expect(repository.create(createDraft(crypto.randomUUID(), "client-2", 8))).resolves.toMatchObject({ client: { id: "client-2" } });
    expect(await repository.list()).toHaveLength(3);
  });
  it("rejects stale and competing writes", async () => {
    const repository = new InMemoryReportDraftRepository();
    const initial = await repository.create(createDraft());
    const update = mutate(initial);
    const results = await Promise.allSettled([repository.save(update, 1), repository.save(update, 1)]);
    expect(results.filter(({ status }) => status === "fulfilled")).toHaveLength(1);
    expect(results.filter(({ status }) => status === "rejected")).toHaveLength(1);
    await expect(repository.save({ ...update, version: 3 }, 1)).rejects.toMatchObject({
      code: "REPORT_VERSION_CONFLICT", details: { expectedVersion: 1, currentVersion: 2 },
    });
  });
  it("deletes only the current-version draft and its report-owned history", async () => {
    const repository = new InMemoryReportDraftRepository();
    const first = await repository.create(createDraft());
    const second = await repository.create(createDraft(crypto.randomUUID(), "client-2"));
    await expect(repository.delete(first.id, 2)).rejects.toMatchObject({ code: "REPORT_VERSION_CONFLICT" });
    expect(await repository.getById(first.id)).not.toBeNull();
    await expect(repository.delete(first.id, 1)).resolves.toMatchObject({ id: first.id });
    expect(await repository.getById(first.id)).toBeNull();
    await expect(repository.getHistory(first.id)).rejects.toMatchObject({ code: "REPORT_NOT_FOUND" });
    expect(await repository.getById(second.id)).not.toBeNull();
  });
  it("rejects immutable identity changes and invalid persisted data", async () => {
    const repository = new InMemoryReportDraftRepository();
    const initial = await repository.create(createDraft());
    await expect(repository.save({ ...mutate(initial), client: { ...initial.client, id: "other" } }, 1)).rejects.toMatchObject({ code: "PERSISTENCE_DATA_INVALID" });
    await expect(repository.create({ ...createDraft(), version: 0 } as ReportDraft)).rejects.toBeInstanceOf(ReportPersistenceError);
  });
});
