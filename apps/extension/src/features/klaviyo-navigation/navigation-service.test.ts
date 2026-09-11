import { describe, expect, it, vi } from "vitest";
import { ChromeKlaviyoNavigationService, klaviyoNavigationTargets } from "./navigation-service.js";

const period = { startDate: "2026-08-01", endDate: "2026-08-31", previousStartDate: "2026-07-01", previousEndDate: "2026-07-31" };

describe("Klaviyo navigation service", () => {
  it("keeps centralized guidance and falls back when account context is absent", async () => {
    const service = new ChromeKlaviyoNavigationService();
    await expect(service.openSection("top_campaigns", null, period)).resolves.toMatchObject({ kind: "account_context_required", target: klaviyoNavigationTargets.top_campaigns });
    expect(service.preparePeriod(period)).toEqual({ kind: "manual_period_required" });
  });
  it("opens only a user-provided Klaviyo workspace URL", async () => {
    const create = vi.fn().mockResolvedValue({});
    const service = new ChromeKlaviyoNavigationService({ tabs: { create } });
    await expect(service.openSection("overview", "https://www.klaviyo.com/company/example", period)).resolves.toMatchObject({ kind: "opened_workspace" });
    expect(create).toHaveBeenCalledWith({ url: "https://www.klaviyo.com/company/example", active: true });
  });
  it("returns a typed manual fallback when opening the workspace fails", async () => {
    const service = new ChromeKlaviyoNavigationService({ tabs: { create: vi.fn().mockRejectedValue(new Error("blocked")) } });
    await expect(service.openSection("top_flows", "https://www.klaviyo.com/company/example", period)).resolves.toMatchObject({ kind: "open_failed" });
  });
  it("reuses a verified Klaviyo tab and centralizes DOM preparation through scripting", async () => {
    const executeScript = vi.fn().mockResolvedValue([{ result: { kind: "ready", detectedPeriod: "Aug 1, 2026 – Aug 31, 2026", target: { x: 10, y: 20, width: 300, height: 200, viewportWidth: 1200, viewportHeight: 800 } } }]);
    const update = vi.fn().mockResolvedValue({ id: 7 });
    const service = new ChromeKlaviyoNavigationService({
      tabs: { create: vi.fn(), query: vi.fn().mockResolvedValue([{ id: 7, url: "https://www.klaviyo.com/analytics/dashboards" }]), update },
      scripting: { executeScript },
    });
    await expect(service.prepareExecutiveSummary(null, period)).resolves.toMatchObject({ kind: "ready", detectedPeriod: "Aug 1, 2026 – Aug 31, 2026" });
    expect(update).toHaveBeenCalledWith(7, { active: true });
    expect(executeScript).toHaveBeenCalledTimes(2);
    expect(executeScript).toHaveBeenCalledWith(expect.objectContaining({ target: { tabId: 7 }, args: ["Aug 1, 2026 – Aug 31, 2026"] }));
  });
  it("returns a typed failure without capturing when no supported Klaviyo page can be prepared", async () => {
    const service = new ChromeKlaviyoNavigationService({
      tabs: { create: vi.fn(), query: vi.fn().mockResolvedValue([{ id: 7, url: "https://www.klaviyo.com/campaigns" }]), update: vi.fn() },
      scripting: { executeScript: vi.fn().mockResolvedValue([{ result: { kind: "failed", code: "TARGET_NOT_FOUND" } }]) },
    });
    await expect(service.prepareExecutiveSummary(null, period)).resolves.toEqual({ kind: "failed", code: "TARGET_NOT_FOUND" });
  });
});
