import { describe, expect, it, vi } from "vitest";
import { captureStableScreenshot } from "./stable-screenshot.js";

const frames = (...values: string[]) => { let index = 0; return vi.fn(async () => Buffer.from(values[Math.min(index++, values.length - 1)]!)); };

describe("stable screenshot capture", () => {
  it("rejects a partially repainted frame and keeps the settled frame", async () => {
    const take = frames("2.□1K", "2.61K", "2.61K", "2.61K");
    const result = await captureStableScreenshot(take, async () => undefined, { requiredIdenticalCaptures: 3, maxAttempts: 8 });
    expect(result).toMatchObject({ ok: true, attempts: 4, identicalCaptures: 3 });
    expect(result.ok && result.bytes.toString()).toBe("2.61K");
  });
  it("settles before every screenshot", async () => {
    const settle = vi.fn(async () => undefined);
    await captureStableScreenshot(frames("a"), settle, { requiredIdenticalCaptures: 2, maxAttempts: 4 });
    expect(settle).toHaveBeenCalledTimes(2);
  });
  it("fails closed when the card never paints identically", async () => {
    let tick = 0;
    const result = await captureStableScreenshot(async () => Buffer.from(String(tick++)), async () => undefined, { requiredIdenticalCaptures: 2, maxAttempts: 5 });
    expect(result).toMatchObject({ ok: false, attempts: 5, identicalCaptures: 1 });
  });
});
