import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { inspectPng } from "./png.js";
import { InMemoryScreenshotStorage, LocalFilesystemScreenshotStorage, MAX_SCREENSHOT_BYTE_SIZE } from "./screenshot-storage.js";

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9J5c0AAAAASUVORK5CYII=", "base64");
const key = "reports/11111111-1111-4111-8111-111111111111/overview/22222222-2222-4222-8222-222222222222.png";
const directories: string[] = [];
afterEach(async () => Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))));

describe("screenshot storage", () => {
  it("stores, hashes, retrieves, and deletes a local PNG asset", async () => {
    const directory = await mkdtemp(join(tmpdir(), "tention-screenshots-"));
    directories.push(directory);
    const storage = new LocalFilesystemScreenshotStorage(directory);
    const stored = await storage.put(key, PNG);
    expect(stored).toMatchObject({ storageKey: key, byteSize: PNG.length, sha256: expect.stringMatching(/^[a-f0-9]{64}$/) });
    expect(await readFile(join(directory, key))).toEqual(PNG);
    expect((await storage.get(key))?.bytes).toEqual(PNG);
    await storage.delete(key);
    expect(await storage.get(key)).toBeNull();
  });
  it("rejects traversal, oversized content, and invalid PNG structure", async () => {
    const storage = new InMemoryScreenshotStorage();
    await expect(storage.put("../outside.png", PNG)).rejects.toMatchObject({ code: "STORAGE_ERROR" });
    await expect(storage.put(key, Buffer.alloc(MAX_SCREENSHOT_BYTE_SIZE + 1))).rejects.toMatchObject({ code: "SCREENSHOT_TOO_LARGE" });
    expect(() => inspectPng(Buffer.from("not a png"))).toThrowError(/valid PNG/);
    expect(inspectPng(PNG)).toEqual({ width: 1, height: 1 });
  });
});
