import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { LocalFilesystemScreenshotStorage, type ScreenshotStorage } from "./screenshot-storage.js";

export interface ScreenshotStorageEnvironment { SCREENSHOT_STORAGE_DIR?: string }

/** Default storage is stable whether npm starts in the repository or apps/api. */
const repositoryScreenshotDirectory = resolve(dirname(fileURLToPath(import.meta.url)), "../../../../data/screenshots");
const legacyWorkspaceScreenshotDirectory = resolve(dirname(fileURLToPath(import.meta.url)), "../../data/screenshots");

/** Read-only bridge for artifacts written by the earlier cwd-dependent default.
 * New writes always go to the repository-stable store. */
class LegacyScreenshotReadFallback implements ScreenshotStorage {
  constructor(private readonly primary: ScreenshotStorage, private readonly legacy: ScreenshotStorage) {}
  put(storageKey: string, bytes: Buffer) { return this.primary.put(storageKey, bytes); }
  async get(storageKey: string) { return await this.primary.get(storageKey) ?? this.legacy.get(storageKey); }
  delete(storageKey: string) { return this.primary.delete(storageKey); }
}

export function resolveConfiguredScreenshotStorageDirectory(environment: ScreenshotStorageEnvironment, currentDirectory = process.cwd()) {
  return environment.SCREENSHOT_STORAGE_DIR
    ? resolve(currentDirectory, environment.SCREENSHOT_STORAGE_DIR)
    : repositoryScreenshotDirectory;
}

export function createConfiguredScreenshotStorage(environment: ScreenshotStorageEnvironment) {
  const primary = new LocalFilesystemScreenshotStorage(resolveConfiguredScreenshotStorageDirectory(environment));
  return environment.SCREENSHOT_STORAGE_DIR
    ? primary
    : new LegacyScreenshotReadFallback(primary, new LocalFilesystemScreenshotStorage(legacyWorkspaceScreenshotDirectory));
}
