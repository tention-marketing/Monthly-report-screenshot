import { describe, expect, it } from "vitest";
import { denormalizeCrop, normalizeCrop, validateNormalizedCrop } from "./crop-template-store.js";

describe("normalized crop templates", () => {
  it("round-trips a crop independently of Retina image dimensions", () => {
    const normalized = normalizeCrop({ x: 100, y: 50, width: 300, height: 200 }, 1000, 500);
    expect(denormalizeCrop(normalized, 2000, 1000)).toEqual({ x: 200, y: 100, width: 600, height: 400 });
  });
  it("clamps templates to image bounds and rejects an empty template", () => {
    const clamped = validateNormalizedCrop({ xPct: -.2, yPct: .8, widthPct: 2, heightPct: 2 });
    expect(clamped).toMatchObject({ xPct: 0, yPct: .8, widthPct: 1 });
    expect(clamped.heightPct).toBeCloseTo(.2);
    expect(() => validateNormalizedCrop({ xPct: 1, yPct: 0, widthPct: 1, heightPct: 1 })).toThrow(/positive size/);
  });
});
