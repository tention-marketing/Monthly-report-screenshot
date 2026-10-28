import { chromium, type Browser } from "playwright";
export interface PdfRenderer { render(html: string): Promise<Buffer>; close(): Promise<void> }
export class PdfRendererError extends Error { constructor(message: string) { super(message); this.name = "PdfRendererError"; } }
export class PlaywrightPdfRenderer implements PdfRenderer {
  private browser: Promise<Browser> | null = null;
  constructor(private readonly options: { executablePath?: string; timeoutMs?: number } = {}) {}
  private launch(): Promise<Browser> { return this.browser ??= chromium.launch({ headless: true, ...(this.options.executablePath ? { executablePath: this.options.executablePath } : {}) }); }
  async render(html: string): Promise<Buffer> {
    const browser = await this.launch(); const page = await browser.newPage(); const timeout = this.options.timeoutMs ?? 30_000;
    try { await page.setContent(html, { waitUntil: "load", timeout }); return Buffer.from(await page.pdf({ format: "A4", landscape: true, printBackground: true, margin: { top: "11mm", right: "11mm", bottom: "11mm", left: "11mm" } })); }
    catch { throw new PdfRendererError("PDF rendering failed. Verify the configured Chromium runtime is available."); }
    finally { await page.close(); }
  }
  async close(): Promise<void> { if (this.browser) { const browser = await this.browser; this.browser = null; await browser.close(); } }
}
