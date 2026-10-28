import { afterEach, describe, expect, it, vi } from "vitest";
import { prepareDeliverabilityScoreDocument } from "./deliverability-score-capture.js";

const fast = { sampleIntervalMs: 1, requiredStableSamples: 2, timeoutMs: 400 };
function rect(left = 20, top = 30, width = 640, height = 460): DOMRect { return { x: left, y: top, width, height, left, top, right: left + width, bottom: top + height, toJSON: () => ({}) } as DOMRect; }
function page(content = "Open rate Click rate Bounce rate Unsubscribe rate Spam complaint rate", extras = "<section id=\"action\">Action Center Create segment Start cleaning</section>", scoreRect = rect()): void {
  window.history.replaceState({}, "", "/analytics/deliverability/email/score");
  document.body.innerHTML = `<main id="app-shell-main"><h1>Deliverability</h1><nav>Email · Score</nav><section id="score"><h2>Deliverability score</h2><p>Based on last 30 days of data</p><div class="gauge"><span id="value">65</span> Your score is Fair</div><table><tbody><tr><td>${content}</td></tr></tbody></table></section>${extras}</main>`;
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) { return this.id === "action" ? rect(700, 30, 400, 500) : this.id === "app-shell-main" ? rect(0, 0, 1200, 800) : this.closest("#score") ? scoreRect : rect(0, 0, 10, 10); });
}
afterEach(() => { vi.restoreAllMocks(); document.body.innerHTML = ""; window.history.replaceState({}, "", "/"); });

describe("standalone Deliverability Score adapter", () => {
  it("accepts the real Score-card semantic structure and crops the score plus metrics", async () => {
    page();
    await expect(prepareDeliverabilityScoreDocument(fast)).resolves.toMatchObject({ ok: true, sourceUrl: "https://www.klaviyo.com/analytics/deliverability/email/score", targetRect: { width: 640, height: 460 }, diagnostics: { observedScoreText: "65" } });
    expect(document.querySelector("[data-tention-deliverability-score='capture']")?.id).toBe("score");
  });
  it("accepts delayed SPA content once the scoped score card is rendered", async () => {
    window.history.replaceState({}, "", "/analytics/deliverability/email/score");
    document.body.innerHTML = "<main id='app-shell-main'>Loading</main>";
    await expect(prepareDeliverabilityScoreDocument(fast)).resolves.toMatchObject({ ok: false, code: "DELIVERABILITY_SCORE_CONTENT_NOT_RENDERED" });
    page("Open rate Click rate Bounce rate", "");
    await expect(prepareDeliverabilityScoreDocument(fast)).resolves.toMatchObject({ ok: true });
  });
  it("waits for the gauge count-up to settle instead of capturing an intermediate score", async () => {
    page();
    const value = document.getElementById("value")!;
    const frames = ["0", "6", "50", "53", "58"];
    let index = 0; value.textContent = frames[0]!;
    const timer = setInterval(() => { if (index < frames.length - 1) value.textContent = frames[++index]!; }, 2);
    const result = await prepareDeliverabilityScoreDocument({ sampleIntervalMs: 5, requiredStableSamples: 3, timeoutMs: 1_000 });
    clearInterval(timer);
    expect(result).toMatchObject({ ok: true, diagnostics: { observedScoreText: "58" } });
  });
  it("fails closed when the gauge never settles", async () => {
    page();
    const value = document.getElementById("value")!;
    let tick = 0;
    const timer = setInterval(() => { value.textContent = String(tick++ % 100); }, 1);
    const result = await prepareDeliverabilityScoreDocument({ sampleIntervalMs: 3, requiredStableSamples: 3, timeoutMs: 60 });
    clearInterval(timer);
    expect(result).toMatchObject({ ok: false, code: "DELIVERABILITY_SCORE_NOT_STABLE" });
    expect(document.querySelector("[data-tention-deliverability-score]")).toBeNull();
  });
  it("rejects a card clipped by the viewport rather than cropping off rate rows", async () => {
    page(undefined, undefined, rect(20, 410, 480, window.innerHeight));
    await expect(prepareDeliverabilityScoreDocument(fast)).resolves.toMatchObject({ ok: false, code: "TARGET_BOUNDS_INVALID" });
  });
  it("rejects incomplete metrics and never requires Action Center or Alerts", async () => {
    page("Open rate Click rate");
    await expect(prepareDeliverabilityScoreDocument(fast)).resolves.toMatchObject({ ok: false, code: "DELIVERABILITY_SCORE_CONTENT_NOT_RENDERED" });
    page("Open rate Click rate Bounce rate", "");
    await expect(prepareDeliverabilityScoreDocument(fast)).resolves.toMatchObject({ ok: true });
  });
  it("rejects the Business Review route even if it contains the same words", async () => {
    page(); window.history.replaceState({}, "", "/analytics/dashboards/business-review");
    await expect(prepareDeliverabilityScoreDocument(fast)).resolves.toMatchObject({ ok: false, code: "DELIVERABILITY_SCORE_NOT_FOUND" });
  });
  it("rejects unrelated Deliverability views", async () => {
    page(); window.history.replaceState({}, "", "/analytics/deliverability/email/reports");
    await expect(prepareDeliverabilityScoreDocument(fast)).resolves.toMatchObject({ ok: false, code: "DELIVERABILITY_SCORE_NOT_FOUND" });
  });
});
