import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { countVisibleInkSamples, pruneStalePdfPageRasters } from "./pdf-page-qa.js";

describe("countVisibleInkSamples", () => {
  it("does not report a white raster page as having visible content", () => {
    expect(countVisibleInkSamples(new Uint8ClampedArray([255, 255, 255, 255, 255, 255, 255, 255]))).toBe(0);
  });

  it("detects visible content without treating transparent pixels as ink", () => {
    expect(countVisibleInkSamples(new Uint8ClampedArray([10, 10, 10, 255, 0, 0, 0, 0]))).toBe(1);
  });
});

describe("pruneStalePdfPageRasters", () => {
  it("removes only numbered page PNGs beyond the physical page count", async () => {
    const directory = await mkdtemp(join(tmpdir(), "tention-pdf-page-qa-"));
    try {
      await Promise.all(["page-01.png", "page-07.png", "page-08.png", "cover.png", "page-old.png"].map((name) => writeFile(join(directory, name), "fixture")));
      await pruneStalePdfPageRasters(directory, 7);
      expect((await readdir(directory)).sort()).toEqual(["cover.png", "page-01.png", "page-07.png", "page-old.png"]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
