/**
 * Chromium can composite an element screenshot while a React table is still
 * repainting, leaving small stale raster rectangles over individual glyphs
 * (for example "2.61K" captured as "2.□1K"). A single screenshot cannot prove
 * that the frame was fully painted, so a capture is accepted only when
 * consecutive screenshots, separated by a settle step, are byte-identical.
 */
export interface StableScreenshotOptions { requiredIdenticalCaptures: number; maxAttempts: number }
export type StableScreenshotResult =
  | { ok: true; bytes: Buffer; attempts: number; identicalCaptures: number }
  | { ok: false; attempts: number; identicalCaptures: number; error: string };

export async function captureStableScreenshot(
  take: () => Promise<Buffer>,
  settle: () => Promise<void>,
  options: StableScreenshotOptions = { requiredIdenticalCaptures: 3, maxAttempts: 8 },
): Promise<StableScreenshotResult> {
  let previous: Buffer | null = null;
  let identicalCaptures = 0;
  for (let attempt = 1; attempt <= options.maxAttempts; attempt += 1) {
    await settle();
    const current = await take();
    identicalCaptures = previous !== null && previous.equals(current) ? identicalCaptures + 1 : 1;
    previous = current;
    if (identicalCaptures >= options.requiredIdenticalCaptures) return { ok: true, bytes: current, attempts: attempt, identicalCaptures };
  }
  return { ok: false, attempts: options.maxAttempts, identicalCaptures, error: `The card did not render identically across ${options.requiredIdenticalCaptures} consecutive screenshots; Klaviyo was still repainting.` };
}
