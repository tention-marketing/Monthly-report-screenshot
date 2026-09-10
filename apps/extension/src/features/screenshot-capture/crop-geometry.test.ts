import { describe, expect, it } from "vitest";
import { mapDisplayedCropToImage, selectionFromDrag } from "./crop-geometry.js";

describe("crop geometry", () => {
  it("maps displayed CSS selection coordinates to natural PNG pixels", () => {
    expect(mapDisplayedCropToImage({ x: 100, y: 50, width: 300, height: 200 }, 720, 450, 1440, 900))
      .toEqual({ x: 200, y: 100, width: 600, height: 400 });
  });
  it("clamps reversed drags to image bounds and rejects too-small selections", () => {
    expect(selectionFromDrag(500, 400, -10, -20, 480, 360)).toEqual({ x: 0, y: 0, width: 480, height: 360 });
    expect(selectionFromDrag(10, 10, 20, 20, 480, 360)).toBeNull();
  });
});
