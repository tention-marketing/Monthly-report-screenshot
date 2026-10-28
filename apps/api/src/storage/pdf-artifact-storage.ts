import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, relative, resolve, sep } from "node:path";

export interface StoredPdfArtifact { storageKey: string; bytes: Buffer; byteSize: number; sha256: string }
export interface PdfArtifactStorage {
  put(storageKey: string, bytes: Buffer): Promise<StoredPdfArtifact>;
  get(storageKey: string): Promise<StoredPdfArtifact | null>;
  delete(storageKey: string): Promise<void>;
}
export class PdfArtifactStorageError extends Error {
  constructor(public readonly code: "PDF_ARTIFACT_NOT_FOUND" | "PDF_ARTIFACT_INVALID" | "PDF_ARTIFACT_STORAGE_ERROR", message: string) {
    super(message); this.name = "PdfArtifactStorageError";
  }
}
const validKey = /^reports\/[0-9a-f-]+\/artifacts\/[0-9a-f-]+\.pdf$/;
function validate(storageKey: string, bytes?: Buffer): void {
  if (!validKey.test(storageKey) || storageKey.includes("..")) throw new PdfArtifactStorageError("PDF_ARTIFACT_INVALID", "PDF artifact storage key is invalid.");
  if (bytes && (bytes.length < 5 || bytes.subarray(0, 5).toString("ascii") !== "%PDF-")) {
    throw new PdfArtifactStorageError("PDF_ARTIFACT_INVALID", "Renderer did not produce a valid PDF artifact.");
  }
}
function asAsset(storageKey: string, bytes: Buffer): StoredPdfArtifact {
  return { storageKey, bytes: Buffer.from(bytes), byteSize: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") };
}

export class LocalFilesystemPdfArtifactStorage implements PdfArtifactStorage {
  private readonly root: string;
  constructor(rootDirectory: string) { this.root = resolve(rootDirectory); }
  async put(storageKey: string, bytes: Buffer): Promise<StoredPdfArtifact> {
    validate(storageKey, bytes); const destination = this.path(storageKey); const temporary = `${destination}.${randomUUID()}.tmp`;
    try { await mkdir(dirname(destination), { recursive: true }); await writeFile(temporary, bytes, { flag: "wx" }); await rename(temporary, destination); return asAsset(storageKey, bytes); }
    catch { await rm(temporary, { force: true }).catch(() => undefined); throw new PdfArtifactStorageError("PDF_ARTIFACT_STORAGE_ERROR", "PDF artifact storage could not save the generated file."); }
  }
  async get(storageKey: string): Promise<StoredPdfArtifact | null> {
    try { const bytes = await readFile(this.path(storageKey)); return asAsset(storageKey, bytes); }
    catch (error) { if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return null; throw new PdfArtifactStorageError("PDF_ARTIFACT_STORAGE_ERROR", "PDF artifact storage could not read the generated file."); }
  }
  async delete(storageKey: string): Promise<void> { try { await rm(this.path(storageKey), { force: true }); } catch { throw new PdfArtifactStorageError("PDF_ARTIFACT_STORAGE_ERROR", "PDF artifact storage could not remove the generated file."); } }
  private path(storageKey: string): string {
    validate(storageKey); const path = resolve(this.root, storageKey); const rel = relative(this.root, path);
    if (!rel || rel === ".." || rel.startsWith(`..${sep}`)) throw new PdfArtifactStorageError("PDF_ARTIFACT_INVALID", "PDF artifact storage key is outside its configured directory.");
    return path;
  }
}
export class InMemoryPdfArtifactStorage implements PdfArtifactStorage {
  private readonly assets = new Map<string, Buffer>();
  async put(storageKey: string, bytes: Buffer): Promise<StoredPdfArtifact> { validate(storageKey, bytes); this.assets.set(storageKey, Buffer.from(bytes)); return asAsset(storageKey, bytes); }
  async get(storageKey: string): Promise<StoredPdfArtifact | null> { validate(storageKey); const bytes = this.assets.get(storageKey); return bytes ? asAsset(storageKey, bytes) : null; }
  async delete(storageKey: string): Promise<void> { validate(storageKey); this.assets.delete(storageKey); }
}
