import { ScreenshotStorageError } from "./screenshot-storage.js";

const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

export interface PngDimensions { width: number; height: number }

/** Performs a bounded structural check sufficient for screenshot uploads, not image decoding. */
export function inspectPng(bytes: Buffer): PngDimensions {
  if (bytes.length < 24 || !bytes.subarray(0, 8).equals(PNG_SIGNATURE) || bytes.toString("ascii", 12, 16) !== "IHDR") {
    throw new ScreenshotStorageError("INVALID_SCREENSHOT_CONTENT", "Screenshot must be a structurally valid PNG image.");
  }
  const width = bytes.readUInt32BE(16);
  const height = bytes.readUInt32BE(20);
  if (width === 0 || height === 0) {
    throw new ScreenshotStorageError("INVALID_SCREENSHOT_CONTENT", "Screenshot PNG dimensions must be positive.");
  }
  return { width, height };
}
