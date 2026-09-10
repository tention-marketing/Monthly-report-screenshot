import { resolve } from "node:path";
import { LocalFilesystemScreenshotStorage } from "./screenshot-storage.js";

export interface ScreenshotStorageEnvironment { SCREENSHOT_STORAGE_DIR?: string }

export function createConfiguredScreenshotStorage(environment: ScreenshotStorageEnvironment) {
  return new LocalFilesystemScreenshotStorage(resolve(process.cwd(), environment.SCREENSHOT_STORAGE_DIR ?? "data/screenshots"));
}
