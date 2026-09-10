import { createHash } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, relative, resolve, sep } from "node:path";

export const MAX_SCREENSHOT_BYTE_SIZE = 10 * 1024 * 1024;

export interface StoredScreenshotAsset {
  storageKey: string;
  bytes: Buffer;
  byteSize: number;
  sha256: string;
}

export interface ScreenshotStorage {
  put(storageKey: string, bytes: Buffer): Promise<StoredScreenshotAsset>;
  get(storageKey: string): Promise<StoredScreenshotAsset | null>;
  delete(storageKey: string): Promise<void>;
}

export class ScreenshotStorageError extends Error {
  constructor(
    public readonly code: "SCREENSHOT_TOO_LARGE" | "INVALID_SCREENSHOT_TYPE" | "INVALID_SCREENSHOT_CONTENT" | "SCREENSHOT_NOT_FOUND" | "STORAGE_ERROR",
    message: string,
  ) { super(message); this.name = "ScreenshotStorageError"; }
}

/** DEVELOPMENT / NON-PRODUCTION storage adapter. Replace with object storage in production. */
export class LocalFilesystemScreenshotStorage implements ScreenshotStorage {
  private readonly rootDirectory: string;

  constructor(rootDirectory: string) {
    this.rootDirectory = resolve(rootDirectory);
  }

  async put(storageKey: string, bytes: Buffer): Promise<StoredScreenshotAsset> {
    validateAsset(storageKey, bytes);
    const destination = this.resolveStorageKey(storageKey);
    const temporary = `${destination}.${crypto.randomUUID()}.tmp`;
    try {
      await mkdir(dirname(destination), { recursive: true });
      await writeFile(temporary, bytes, { flag: "wx" });
      await rename(temporary, destination);
      return asset(storageKey, bytes);
    } catch (error) {
      await rm(temporary, { force: true }).catch(() => undefined);
      throw new ScreenshotStorageError("STORAGE_ERROR", "Screenshot storage could not save the uploaded asset.");
    }
  }

  async get(storageKey: string): Promise<StoredScreenshotAsset | null> {
    try {
      const bytes = await readFile(this.resolveStorageKey(storageKey));
      return asset(storageKey, bytes);
    } catch (error) {
      if (isMissingFile(error)) return null;
      throw new ScreenshotStorageError("STORAGE_ERROR", "Screenshot storage could not read the requested asset.");
    }
  }

  async delete(storageKey: string): Promise<void> {
    try {
      await rm(this.resolveStorageKey(storageKey), { force: true });
    } catch (error) {
      throw new ScreenshotStorageError("STORAGE_ERROR", "Screenshot storage could not remove the obsolete asset.");
    }
  }

  private resolveStorageKey(storageKey: string): string {
    if (!/^reports\/[0-9a-f-]+\/[a-z_]+\/[0-9a-f-]+\.png$/.test(storageKey)) {
      throw new ScreenshotStorageError("STORAGE_ERROR", "Screenshot storage key is invalid.");
    }
    const resolved = resolve(this.rootDirectory, storageKey);
    const relativePath = relative(this.rootDirectory, resolved);
    if (relativePath === "" || relativePath.startsWith(`..${sep}`) || relativePath === "..") {
      throw new ScreenshotStorageError("STORAGE_ERROR", "Screenshot storage key is outside the configured directory.");
    }
    return resolved;
  }
}

/** Test-only storage with the same key and byte semantics as the filesystem adapter. */
export class InMemoryScreenshotStorage implements ScreenshotStorage {
  private readonly assets = new Map<string, Buffer>();

  async put(storageKey: string, bytes: Buffer): Promise<StoredScreenshotAsset> {
    validateAsset(storageKey, bytes);
    this.assets.set(storageKey, Buffer.from(bytes));
    return asset(storageKey, bytes);
  }

  async get(storageKey: string): Promise<StoredScreenshotAsset | null> {
    const bytes = this.assets.get(storageKey);
    return bytes ? asset(storageKey, bytes) : null;
  }

  async delete(storageKey: string): Promise<void> { this.assets.delete(storageKey); }
}

function validateAsset(storageKey: string, bytes: Buffer): void {
  if (!storageKey || storageKey.includes("..") || !Buffer.isBuffer(bytes)) {
    throw new ScreenshotStorageError("STORAGE_ERROR", "Screenshot storage input is invalid.");
  }
  if (bytes.length === 0) throw new ScreenshotStorageError("INVALID_SCREENSHOT_CONTENT", "Screenshot image is empty.");
  if (bytes.length > MAX_SCREENSHOT_BYTE_SIZE) throw new ScreenshotStorageError("SCREENSHOT_TOO_LARGE", "Screenshot image exceeds the 10 MB limit.");
}

function asset(storageKey: string, bytes: Buffer): StoredScreenshotAsset {
  return { storageKey, bytes: Buffer.from(bytes), byteSize: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") };
}

function isMissingFile(error: unknown): error is NodeJS.ErrnoException {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
