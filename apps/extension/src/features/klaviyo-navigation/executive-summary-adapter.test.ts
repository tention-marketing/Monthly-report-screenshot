import { afterEach, describe, expect, it, vi } from "vitest";
import { prepareExecutiveSummaryDocument } from "./executive-summary-adapter.js";

const july = "Jul 1, 2026 – Jul 31, 2026";

function rect(left = 20, top = 30, width = 500, height = 300): DOMRect {
  return { x: left, y: top, width, height, left, top, right: left + width, bottom: top + height, toJSON: () => ({}) } as DOMRect;
}

function businessReview(period = july): void {
  document.body.innerHTML = `<main><h1>Business review</h1><button id="period" aria-label="Time period">${period}</button><section id="growth" role="region"><h2>Growth overview</h2><p>Summary</p></section></main>`;
  if (!("scrollIntoView" in HTMLElement.prototype)) Object.defineProperty(HTMLElement.prototype, "scrollIntoView", { configurable: true, value: () => undefined });
  vi.spyOn(HTMLElement.prototype, "scrollIntoView").mockImplementation(() => undefined);
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    return this.id === "growth" ? rect() : rect(0, 0, 10, 10);
  });
}

describe("Executive Summary Klaviyo adapter", () => {
  afterEach(() => { vi.restoreAllMocks(); document.body.innerHTML = ""; });

  it("recognizes a semantic Business review page, verifies the period, and returns Growth overview bounds", async () => {
    businessReview();
    await expect(prepareExecutiveSummaryDocument(july)).resolves.toEqual({
      kind: "ready", detectedPeriod: july,
      target: { x: 20, y: 30, width: 500, height: 300, viewportWidth: window.innerWidth, viewportHeight: window.innerHeight },
    });
  });

  it("does not treat navigation text alone as a supported Business review page", async () => {
    document.body.innerHTML = `<nav>Business review</nav><button aria-label="Time period">${july}</button><section><h2>Growth overview</h2></section>`;
    await expect(prepareExecutiveSummaryDocument(july)).resolves.toEqual({ kind: "failed", code: "KLAVIYO_PAGE_NOT_SUPPORTED" });
  });

  it("safely selects an exact semantic period option and verifies it", async () => {
    businessReview("Jun 1, 2026 – Jun 30, 2026");
    const period = document.getElementById("period")!;
    const option = document.createElement("button"); option.setAttribute("role", "option"); option.textContent = july;
    option.addEventListener("click", () => { period.textContent = july; }); document.body.append(option);
    await expect(prepareExecutiveSummaryDocument(july)).resolves.toMatchObject({ kind: "ready", detectedPeriod: july });
  });

  it("fails without a date control instead of guessing a period", async () => {
    document.body.innerHTML = `<main><h1>Business review</h1><section><h2>Growth overview</h2></section></main>`;
    await expect(prepareExecutiveSummaryDocument(july)).resolves.toEqual({ kind: "failed", code: "PERIOD_NOT_FOUND" });
  });

  it("does not guess calendar clicks when the exact period option is absent", async () => {
    businessReview("Jun 1, 2026 – Jun 30, 2026");
    await expect(prepareExecutiveSummaryDocument(july)).resolves.toEqual({ kind: "failed", code: "PERIOD_SET_FAILED" });
  });

  it("fails when Growth overview is absent or not fully in the viewport", async () => {
    businessReview(); document.getElementById("growth")!.remove();
    await expect(prepareExecutiveSummaryDocument(july)).resolves.toEqual({ kind: "failed", code: "TARGET_NOT_FOUND" });
    vi.restoreAllMocks(); businessReview();
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) { return this.id === "growth" ? rect(0, -5, 500, 300) : rect(); });
    await expect(prepareExecutiveSummaryDocument(july)).resolves.toEqual({ kind: "failed", code: "TARGET_NOT_FULLY_VISIBLE" });
  });
});
