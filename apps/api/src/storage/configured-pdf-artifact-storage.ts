import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { LocalFilesystemPdfArtifactStorage, type PdfArtifactStorage } from "./pdf-artifact-storage.js";
export interface PdfArtifactStorageEnvironment { REPORT_ARTIFACT_STORAGE_DIR?: string }

/** Match screenshot storage so root-level imports and the API share artifacts. */
const repositoryArtifactDirectory = resolve(dirname(fileURLToPath(import.meta.url)), "../../../../data/report-artifacts");
const legacyWorkspaceArtifactDirectory = resolve(dirname(fileURLToPath(import.meta.url)), "../../data/report-artifacts");

/** Preserve read access to pre-fix cwd-dependent artifacts without directing
 * any new output into that legacy location. */
class LegacyPdfReadFallback implements PdfArtifactStorage {
  constructor(private readonly primary: PdfArtifactStorage, private readonly legacy: PdfArtifactStorage) {}
  put(storageKey: string, bytes: Buffer) { return this.primary.put(storageKey, bytes); }
  async get(storageKey: string) { return await this.primary.get(storageKey) ?? this.legacy.get(storageKey); }
  delete(storageKey: string) { return this.primary.delete(storageKey); }
}

export function resolveConfiguredPdfArtifactStorageDirectory(environment: PdfArtifactStorageEnvironment, currentDirectory = process.cwd()) {
  return environment.REPORT_ARTIFACT_STORAGE_DIR
    ? resolve(currentDirectory, environment.REPORT_ARTIFACT_STORAGE_DIR)
    : repositoryArtifactDirectory;
}

export function createConfiguredPdfArtifactStorage(environment: PdfArtifactStorageEnvironment) {
  const primary = new LocalFilesystemPdfArtifactStorage(resolveConfiguredPdfArtifactStorageDirectory(environment));
  return environment.REPORT_ARTIFACT_STORAGE_DIR
    ? primary
    : new LegacyPdfReadFallback(primary, new LocalFilesystemPdfArtifactStorage(legacyWorkspaceArtifactDirectory));
}
