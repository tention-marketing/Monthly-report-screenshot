import { describe, expect, it } from "vitest";
import { InMemoryReportDraftRepository } from "@tention/report-domain";
import { createConfiguredRepository } from "./configured-repository.js";

describe("storage configuration", () => {
  it("fails without PostgreSQL configuration instead of silently using memory", () => {
    expect(() => createConfiguredRepository({})).toThrowError(/DATABASE_URL is required/);
  });
  it("allows explicitly selected non-production memory mode", () => {
    expect(createConfiguredRepository({ REPORT_STORAGE_MODE: "memory" })).toBeInstanceOf(InMemoryReportDraftRepository);
  });
});
