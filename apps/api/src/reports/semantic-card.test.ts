import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser } from "playwright";
import { reacquireSemanticCardAfterViewChange, resolveSemanticCard, scrollSemanticCardIntoView, waitForRequiredCardContent, type SemanticCardTarget } from "./semantic-card.js";

const target: SemanticCardTarget = { key: "top_campaigns", headings: ["Campaign performance summary"], tab: "Top performing messages", requiredText: ["Campaign message"], minimumRows: 3 };
let browser: Browser;

beforeAll(async () => { browser = await chromium.launch({ headless: true }); });
afterAll(async () => { await browser?.close(); });

describe("semantic card rebinding", () => {
  it("reacquires the replacement card after a tab action triggers a React-style DOM replacement", async () => {
    const page = await browser.newPage();
    try {
      await page.setContent(`<main><section id="card" style="width:600px;height:300px"><h2>Campaign performance summary</h2><button id="rank">Top performing messages</button><div>Overview content</div></section></main>`);
      expect((await resolveSemanticCard(page, target)).ok).toBe(true);
      await page.locator("#rank").click();
      await page.locator("#card").evaluate((node) => { const replacement = document.createElement("section"); replacement.id = "card"; replacement.style.cssText = "width:600px;height:300px"; replacement.innerHTML = `<h2>Campaign performance summary</h2><button id="rank" aria-pressed="true">Top performing messages</button><table><tbody><tr><td>Campaign message</td></tr><tr><td>Campaign message two</td></tr><tr><td>Campaign message three</td></tr></tbody></table>`; node.replaceWith(replacement); });
      expect((await reacquireSemanticCardAfterViewChange(page, target)).ok).toBe(true);
      expect(await page.locator('[data-tention-local-capture="top_campaigns"] tbody tr').count()).toBe(3);
    } finally { await page.close(); }
  });

  it("waits for Klaviyo's data-asc Spinner to leave a card before accepting its view", async () => {
    const page = await browser.newPage();
    try {
      await page.setContent(`<main><section style="width:600px;height:300px"><h2>Campaign performance summary</h2><button>Overview</button><span data-asc="Spinner"><div class="Spinner-module__spinner__SZoUP"></div></span></section></main>`);
      setTimeout(() => { void page.evaluate(() => document.querySelector('[data-asc="Spinner"]')?.remove()); }, 250);
      expect(await waitForRequiredCardContent(page, { key: "campaign_performance", headings: ["Campaign performance summary"], tab: "Overview" })).toBe(true);
    } finally { await page.close(); }
  });

  it("re-resolves a visible card when Klaviyo dropped the temporary marker before scrolling", async () => {
    const page = await browser.newPage();
    try {
      await page.setContent(`<main style="height:1800px"><section style="width:600px;height:300px;margin-top:900px"><h2>Campaign performance summary</h2><button>Overview</button><div>Verified campaign performance</div></section></main>`);
      expect(await page.locator('[data-tention-local-capture="campaign_performance"]').count()).toBe(0);
      expect((await scrollSemanticCardIntoView(page, { key: "campaign_performance", headings: ["Campaign performance summary"], tab: "Overview" })).ok).toBe(true);
      expect(await page.locator('[data-tention-local-capture="campaign_performance"]').count()).toBe(1);
    } finally { await page.close(); }
  });

  it("resolves the evidenced Business Review Deliverability card and its Email metrics tab", async () => {
    const page = await browser.newPage();
    try {
      await page.setContent(`<main><section id="deliverability" style="width:1000px;height:620px"><h3>Deliverability</h3><div role="tablist"><button role="tab" aria-selected="true">Email</button><button role="tab" aria-selected="false">Text message</button></div><div>Open Rate 55.8% Click Rate 0.3% Bounce Rate 0.229% Spam Complaint Rate 0.019% Unsubscribe Rate 0.133%</div><div style="height:400px"><h3>Deliverability</h3>categorical line chart</div></section></main>`);
      const deliverability: SemanticCardTarget = { key: "deliverability", headings: ["Deliverability"], tab: "Email", requiredText: ["Open Rate", "Click Rate", "Bounce Rate", "Spam Complaint Rate", "Unsubscribe Rate"] };
      expect((await resolveSemanticCard(page, deliverability)).ok).toBe(true);
      expect(await page.locator('#deliverability[data-tention-local-capture="deliverability"]').count()).toBe(1);
    } finally { await page.close(); }
  });
});
